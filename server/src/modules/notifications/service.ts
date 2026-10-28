import dns from "node:dns/promises";
import net from "node:net";
import type { FastifyBaseLogger } from "fastify";
import type { PushConfig } from "../../app/config.js";
import type { AppContext } from "../../app/context.js";
import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { now } from "../../shared/utilities/util.js";
import { checkEndpoint, isPublicAddress } from "./address.js";
import { type PostOptions, postWake, type WakeError, type WakeResult, type WakeTarget } from "./transport.js";

/** An endpoint that keeps failing this long is dropped; the app registers it again the next time it starts. */
const DROP_AFTER_FAILING_MS = 7 * 86_400_000;
/** Wake-ups in flight at once, and how many more may wait for a slot (beyond that one is skipped; the next item retries). */
const MAX_CONCURRENT = 8;
const MAX_WAITING = 1000;

export interface PushDeps {
  /** All addresses of a host name (tests replace DNS). */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Sends one wake-up (tests replace the network). */
  post?: (target: WakeTarget, opts: PostOptions) => Promise<WakeResult>;
  log?: FastifyBaseLogger;
}

export interface PushRegistration {
  kind: "unifiedpush";
  host: string;
  updatedAt: number;
}

interface Deferred {
  timer: NodeJS.Timeout;
  at: number;
  /** Requested by a ring: sent even if nothing is queued any more. */
  call: boolean;
}

/** Removes only a device's UnifiedPush endpoint (the app withdrew it, or the push server reported it gone). */
export function removeUnifiedPushEndpoint(identity: Rows, deviceId: string): Promise<boolean> {
  return identity.write((w) => w.delete("push_endpoints", { device_id: deviceId }) > 0);
}

/**
 * Removes every wake-up address of a device (signed out or revoked): its UnifiedPush endpoint and its Firebase token
 * (docs/PUSH_FCM.md). Withdrawing UnifiedPush alone must not touch Firebase: the app withdraws it whenever no
 * distributor app is installed, which is exactly the case on phones that rely on Firebase.
 */
export function removePushEndpoint(identity: Rows, deviceId: string): Promise<boolean> {
  return identity.write((w) => removeWakeAddresses(w, [deviceId]) > 0);
}

/** [removePushEndpoint] for several devices, inside the caller's identity unit [w]. Returns UnifiedPush endpoints removed. */
export function removeWakeAddresses(w: RowWriter, deviceIds: readonly string[]): number {
  const ids = [...deviceIds];
  w.delete("fcm_tokens", { device_id: { in: ids } });
  return w.delete("push_endpoints", { device_id: { in: ids } });
}

/** Retention: endpoints of revoked devices (revocations by the admin CLI or older code included). */
export function purgeRevokedPushEndpoints(identity: Rows): Promise<number> {
  const revoked = identity.all<{ id: string }>("devices", { where: { revoked_at: { ne: null } } }).map((d) => d.id);
  if (!revoked.length) return Promise.resolve(0);
  return identity.write((w) => w.delete("push_endpoints", { device_id: { in: revoked } }));
}

/**
 * Payload-free push wake-ups (docs/BACKGROUND_DELIVERY.md, docs/SECURITY.md › Push wake-ups). When something is queued
 * for a device with no open socket, or a call rings it, its registered UnifiedPush endpoint gets an empty POST. The app
 * then fetches its queue over its own authenticated connection. No content, sender, conversation, call or key ever goes
 * to the push server; it learns only that this endpoint was woken, and when.
 *
 * Coalesced per device: at most one wake-up per [PushConfig.wakeIntervalMs] (a ring waits at most
 * [PushConfig.urgentWakeIntervalMs]). A request inside the window is deferred to its end, never dropped, and is skipped
 * then if the device connected or its queue emptied meanwhile.
 */
export class PushService {
  private readonly lastSent = new Map<string, number>();
  private readonly deferred = new Map<string, Deferred>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  private stopped = false;
  private readonly lookup: NonNullable<PushDeps["lookup"]>;
  private readonly post: NonNullable<PushDeps["post"]>;
  private readonly log: FastifyBaseLogger;

  constructor(
    private readonly ctx: AppContext,
    readonly config: PushConfig,
    deps: PushDeps = {},
  ) {
    this.lookup = deps.lookup ?? ((host) => dns.lookup(host, { all: true, verbatim: true }));
    this.post = deps.post ?? postWake;
    this.log = deps.log ?? ctx.log;
  }

  /** Stores (or replaces) [deviceId]'s endpoint, already checked with [checkEndpoint]. */
  async register(deviceId: string, url: URL): Promise<PushRegistration> {
    const t = now();
    await this.ctx.identity.write((w) => {
      // One endpoint per device, and one device per endpoint: the latest registration of an endpoint wins.
      w.delete("push_endpoints", { endpoint: url.href, device_id: { ne: deviceId } });
      w.upsert(
        "push_endpoints",
        { device_id: deviceId, kind: "unifiedpush", endpoint: url.href, created_at: t, updated_at: t },
        { endpoint: url.href, updated_at: t, failing_since: null },
      );
    });
    return { kind: "unifiedpush", host: url.host, updatedAt: t };
  }

  unregister(deviceId: string): Promise<boolean> {
    this.cancel(deviceId);
    return removeUnifiedPushEndpoint(this.ctx.identity, deviceId);
  }

  /** An envelope was queued for [deviceId] while it had no open socket. */
  queued(deviceId: string): void {
    this.guard({ deviceId }, () => this.request(deviceId, false));
  }

  /**
   * [deviceId]'s last socket closed. Items queued since it opened may have gone into a socket that was already dead
   * (a killed app whose connection the server hadn't noticed yet): wake the device if any is still unacknowledged.
   * Items it received in its backlog and didn't acknowledge don't count, so one it can't process never loops.
   */
  disconnected(deviceId: string, openedAt: number): void {
    this.guard({ deviceId }, async () => {
      if (this.usable() && (await this.hasQueued(deviceId, openedAt))) this.request(deviceId, false);
    });
  }

  /** A call rings [userId]: wake each of their devices that has no open socket. */
  ring(userId: string): void {
    this.guard({ userId }, () => {
      if (!this.usable()) return;
      const devices = this.ctx.identity.all<{ id: string }>("devices", { where: { user_id: userId, revoked_at: null } }).map((d) => d.id);
      const rows = devices.length ? this.ctx.identity.all<{ device_id: string }>("push_endpoints", { where: { device_id: { in: devices } } }) : [];
      for (const r of rows) this.request(r.device_id, true);
    });
  }

  /**
   * A reminder of [userId]'s went off: wake each of their devices with no open socket, as promptly as a ring (the
   * wake-up carries nothing; the app fetches its reminders and shows the one that fired from its own sealed copy).
   */
  remind(userId: string): void {
    this.ring(userId);
  }

  /** Stops sending (server shutdown). Deferred wake-ups are cancelled; requests in flight finish on their own. */
  stop(): void {
    this.stopped = true;
    for (const d of this.deferred.values()) clearTimeout(d.timer);
    this.deferred.clear();
  }

  private usable(): boolean {
    return !this.stopped && this.ctx.db.open;
  }

  /** A wake-up must never break what triggered it: sending a message, closing a socket, starting a call, a timer. */
  private guard(ids: Record<string, string>, fn: () => void | Promise<void>): void {
    try {
      const done = fn();
      if (done) void done.catch((err: unknown) => this.logInternal(ids, err));
    } catch (err) {
      this.logInternal(ids, err);
    }
  }

  /** Only the error's type is logged: a message could quote the endpoint. */
  private logInternal(ids: Record<string, string>, err: unknown): void {
    this.log.error({ ...ids, reason: "internal", errorType: err instanceof Error ? err.name : typeof err }, "push wake-up failed");
  }

  private request(deviceId: string, call: boolean): void {
    if (!this.usable() || this.ctx.hub.isDeviceOnline(deviceId) || !this.endpointOf(deviceId)) return;
    const t = Date.now();
    const window = call ? this.config.urgentWakeIntervalMs : this.config.wakeIntervalMs;
    const due = (this.lastSent.get(deviceId) ?? Number.NEGATIVE_INFINITY) + window;
    const pending = this.deferred.get(deviceId);
    if (t >= due) {
      this.cancel(deviceId);
      void this.send(deviceId);
      return;
    }
    if (pending && pending.at <= due) {
      if (call && !pending.call) this.deferred.set(deviceId, { ...pending, call: true });
      return;
    }
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => this.fire(deviceId), due - t);
    timer.unref();
    this.deferred.set(deviceId, { timer, at: due, call: call || (pending?.call ?? false) });
  }

  private fire(deviceId: string): void {
    const d = this.deferred.get(deviceId);
    this.deferred.delete(deviceId);
    if (!d) return;
    this.guard({ deviceId }, async () => {
      if (!this.usable() || this.ctx.hub.isDeviceOnline(deviceId)) return;
      if (d.call || (await this.hasQueued(deviceId, 0))) void this.send(deviceId);
    });
  }

  private cancel(deviceId: string): void {
    const d = this.deferred.get(deviceId);
    if (!d) return;
    clearTimeout(d.timer);
    this.deferred.delete(deviceId);
  }

  /** Fire and forget: never rejects (an unhandled rejection would stop the server). */
  private async send(deviceId: string): Promise<void> {
    try {
      await this.attempt(deviceId);
    } catch (err) {
      this.logInternal({ deviceId }, err);
    }
  }

  private async attempt(deviceId: string): Promise<void> {
    this.lastSent.set(deviceId, Date.now());
    const endpoint = this.endpointOf(deviceId);
    if (!endpoint) return;
    const checked = checkEndpoint(endpoint, this.config.unifiedPushHosts);
    if ("refusal" in checked) {
      await this.drop(deviceId, endpoint, "host_no_longer_allowed");
      return;
    }
    const release = await this.slot();
    if (!release) {
      this.log.warn({ deviceId }, "push wake-up skipped: too many waiting");
      return;
    }
    try {
      if (!this.usable()) return;
      const target = await this.resolve(checked.url);
      const result = "error" in target ? target : await this.post(target, { timeoutMs: this.config.timeoutMs, ttlSeconds: this.ctx.config.queueTtlSeconds });
      await this.record(deviceId, endpoint, result);
    } catch {
      await this.record(deviceId, endpoint, { error: "network" });
    } finally {
      release();
    }
  }

  /** Resolves the push host once and requires every address to be public; the request then goes to that address. */
  private async resolve(url: URL): Promise<WakeTarget | { error: WakeError }> {
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    let addrs: { address: string; family: number }[];
    if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
    else {
      try {
        addrs = await this.lookup(host);
      } catch {
        return { error: "dns" };
      }
    }
    if (addrs.length === 0) return { error: "dns" };
    if (!addrs.every((a) => isPublicAddress(a.address))) return { error: "blocked_address" };
    return { url, address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 };
  }

  /** Logs carry the device id and a reason code, never the endpoint or its host. */
  private async record(deviceId: string, endpoint: string, r: WakeResult): Promise<void> {
    // Health view (docs/OPERATIONS.md): outcome kind only, never the endpoint or the device.
    const ok = "status" in r && r.status >= 200 && r.status < 300;
    this.ctx.metrics?.recordProvider("push.unifiedpush", ok ? undefined : { code: "status" in r ? `http_${r.status}` : r.error });
    if (!this.ctx.db.open) return;
    const { identity } = this.ctx;
    const t = now();
    const where = { device_id: deviceId, endpoint };
    if ("status" in r && r.status >= 200 && r.status < 300) {
      await identity.write((w) => w.update("push_endpoints", where, { last_wake_at: t, failing_since: null }));
      return;
    }
    // Gone for good (RFC 8030). ntfy answers 507 while nobody is subscribed: that one only counts as a failure.
    if ("status" in r && (r.status === 404 || r.status === 410)) {
      await this.drop(deviceId, endpoint, `http_${r.status}`);
      return;
    }
    const reason = "status" in r ? `http_${r.status}` : r.error;
    const failingSince = await identity.write((w) => {
      const row = w.get<{ failing_since: number | null }>("push_endpoints", where);
      if (!row) return null;
      if (row.failing_since === null) w.update("push_endpoints", where, { failing_since: t });
      return row.failing_since ?? t;
    });
    if (failingSince !== null && failingSince <= t - DROP_AFTER_FAILING_MS) {
      await this.drop(deviceId, endpoint, `${reason}_for_7_days`);
      return;
    }
    this.log.warn({ deviceId, reason }, "push wake-up failed");
  }

  private async drop(deviceId: string, endpoint: string, reason: string): Promise<void> {
    // Only the endpoint the request used: the device may have registered a new one meanwhile.
    await this.ctx.identity.write((w) => w.delete("push_endpoints", { device_id: deviceId, endpoint }));
    this.log.info({ deviceId, reason }, "push endpoint removed");
  }

  /** The endpoint of an active device of an enabled account. */
  private endpointOf(deviceId: string): string | null {
    const { identity } = this.ctx;
    const device = identity.get<{ user_id: string }>("devices", { id: deviceId, revoked_at: null });
    if (!device || !identity.get("users", { id: device.user_id, disabled_at: null })) return null;
    return identity.get<{ endpoint: string }>("push_endpoints", { device_id: deviceId })?.endpoint ?? null;
  }

  private hasQueued(deviceId: string, since: number): Promise<boolean> {
    return this.ctx.relay.hasEnvelopeSince(deviceId, since, now());
  }

  /** A sending slot (at most MAX_CONCURRENT at once), or null when too many are already waiting. */
  private async slot(): Promise<(() => void) | null> {
    const release = () => {
      const next = this.waiting.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else this.active--;
    };
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return release;
    }
    if (this.waiting.length >= MAX_WAITING) return null;
    await new Promise<void>((r) => this.waiting.push(r));
    return release;
  }
}

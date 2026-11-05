import { createHmac, randomUUID } from "node:crypto";
import { ApiError, notFound } from "../../shared/errors.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";
import {
  deliverWebhook, matchesWebhookProof, webhookDestination, webhookProof, webhookSecret,
} from "./webhookTransport.js";

const table = "meldiq_private.bot_event_webhooks";
const retryDelays = [10_000, 60_000, 300_000, 900_000];
type Endpoint = {
  bot_id: string; community_id: string; endpoint: string; generation: string; binding: string;
  position: number; active: boolean; pending_event: string | null; attempts: number;
  claim: string | null; last_result: "delivered" | "exhausted" | null; last_at: number | null; updated_at: number;
};
const changed = () => new ApiError(409, "stale_revision", "The event webhook changed; load it again");
const unavailable = () => new ApiError(503, "bot_event_webhooks_unavailable", "Outbound bot event webhooks are not enabled");
const invalidProof = () => new ApiError(400, "bad_request", "The event webhook could not prove it holds the signing secret");

export class BotEventWebhooks {
  private tick?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private readonly live = new Map<string, Set<AbortController>>();
  private unsubscribe?: () => void;
  constructor(private readonly bots: BotService, private readonly deliver = deliverWebhook) {}

  supported() {
    return !!(this.bots.ctx.config.botEventWebhooks && this.bots.ctx.postgres);
  }

  private database() {
    if (!this.supported()) throw unavailable();
    return this.bots.ctx.postgres!.database;
  }

  private config() {
    if (!this.supported()) throw unavailable();
    return this.bots.ctx.config.botEventWebhooks!;
  }

  private read(id: string) {
    return this.database().query<Endpoint>(`SELECT * FROM ${table} WHERE bot_id=$1`, [id]).then((result) => result.rows[0]);
  }

  private binding(bot: Bot, community: string) {
    return createHmac("sha256", this.config().master).update(JSON.stringify([
      "meldiq.bot.webhook.binding.v1", bot.id, bot.tokenHash, this.bots.permissions.revisionKey(community, bot.id),
    ])).digest("hex");
  }

  private view(row: Endpoint | undefined) {
    return row ? {
      generation: row.generation, communityId: row.community_id, url: row.endpoint,
      active: row.active, lastResult: row.last_result, lastAt: row.last_at === null ? null : Number(row.last_at),
      updatedAt: Number(row.updated_at),
    } : null;
  }

  async get(owner: string, id: string) {
    const bot = await this.bots.owned(owner, id);
    const row = await this.read(id);
    if (row && (row.binding !== this.binding(bot, row.community_id) ||
        !this.bots.permissions.allows(bot, row.community_id, "events.read"))) row.active = false;
    return { webhook: this.view(row) };
  }

  async configure(owner: string, id: string, community: string, endpoint: string) {
    const config = this.config();
    const bot = await this.bots.owned(owner, id);
    await this.bots.requireActive(bot);
    this.bots.permissions.require(bot, community, "events.read");
    const url = webhookDestination(endpoint, config.hosts), generation = randomUUID(), now = this.bots.clock();
    // A new destination or signing key never receives the prior destination's backlog.
    const result = await this.database().query<Endpoint>(
      `INSERT INTO ${table}(bot_id,community_id,endpoint,generation,binding,position,next_run,updated_at)
       SELECT $1,$2,$3,$4,$5,last_seq,$6,$6 FROM meldiq_private.bot_event_clock WHERE singleton=1
       ON CONFLICT(bot_id) DO UPDATE SET community_id=excluded.community_id,endpoint=excluded.endpoint,
         generation=excluded.generation,binding=excluded.binding,position=excluded.position,
         next_run=excluded.next_run,updated_at=excluded.updated_at,
         active=false,claim=NULL,claim_until=0,pending_event=NULL,attempts=0,last_result=NULL,last_at=NULL RETURNING *`,
      [id, community, url.href, generation, this.binding(bot, community), now],
    );
    if (!result.rows[0]) throw unavailable();
    this.cancel(id);
    this.bots.ctx.audit({ actorId: owner, orgId: community, action: "bot.event_webhook.configure", target: id });
    return { webhook: this.view(result.rows[0]), signingSecret: webhookSecret(config.master, id, generation).toString("base64url") };
  }

  async activate(owner: string, id: string, generation: string) {
    const bot = await this.bots.owned(owner, id);
    const row = await this.read(id);
    if (!row) throw notFound("This bot has no event webhook");
    if (row.generation !== generation || row.binding !== this.binding(bot, row.community_id)) throw changed();
    await this.bots.requireActive(bot);
    this.bots.permissions.require(bot, row.community_id, "events.read");
    if (row.active) return { webhook: this.view(row) };
    const config = this.config(), nonce = randomUUID();
    const secret = webhookSecret(config.master, id, generation);
    const body = Buffer.from(JSON.stringify({ type: "endpoint.verify", nonce }));
    const url = webhookDestination(row.endpoint, config.hosts);
    const allow = () => this.authorized(row, bot, undefined);
    const result = await this.post(row, url, { id: nonce, secret, body, readProof: true }, allow).catch(() => undefined);
    if (!result || result.status < 200 || result.status >= 300 || !matchesWebhookProof(result.proof, webhookProof(secret, nonce))) throw invalidProof();
    if (!(await allow())) throw changed();
    const updated = await this.database().query<Endpoint>(
      `UPDATE ${table} w SET active=true,position=clock.last_seq,next_run=$3,updated_at=$3
       FROM meldiq_private.bot_event_clock clock
       WHERE w.bot_id=$1 AND w.generation=$2 AND NOT w.active AND clock.singleton=1 RETURNING w.*`,
      [id, generation, this.bots.clock()],
    );
    if (!updated.rows[0]) throw changed();
    this.bots.ctx.audit({ actorId: owner, orgId: row.community_id, action: "bot.event_webhook.activate", target: id });
    return { webhook: this.view(updated.rows[0]) };
  }

  async remove(owner: string, id: string) {
    await this.bots.owned(owner, id);
    this.config();
    await this.erase(id);
    this.bots.ctx.audit({ actorId: owner, action: "bot.event_webhook.remove", target: id });
    return { deleted: true as const };
  }

  async erase(id: string) {
    if (!this.supported()) return;
    await this.database().query(`DELETE FROM ${table} WHERE bot_id=$1`, [id]);
    this.cancel(id);
  }

  private cancel(id: string) {
    for (const ctrl of this.live.get(id) ?? []) ctrl.abort();
  }

  private async post(
    row: Endpoint, url: URL, input: Parameters<typeof deliverWebhook>[1], allowed: () => Promise<boolean>,
  ) {
    if (this.stopped) return undefined;
    const set = this.live.get(row.bot_id) ?? new Set<AbortController>();
    const ctrl = new AbortController();
    set.add(ctrl);
    this.live.set(row.bot_id, set);
    try {
      return await this.deliver(url, input, AbortSignal.any([ctrl.signal, AbortSignal.timeout(5_000)]), allowed);
    } finally {
      set.delete(ctrl);
      if (!set.size) this.live.delete(row.bot_id);
    }
  }

  private async authorized(row: Endpoint, bot: Bot, authority: string | undefined) {
    if (this.stopped) return false;
    try {
      await this.bots.events.fresh(bot);
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.statusCode)) return false;
      throw error;
    }
    if (!this.bots.permissions.allows(bot, row.community_id, "events.read")) return false;
    const current = await this.read(row.bot_id);
    return !!current && current.generation === row.generation && current.binding === this.binding(bot, row.community_id) &&
      (row.claim === null || (current.active && current.claim === row.claim)) &&
      (authority === undefined || this.bots.events.authorityKey(bot) === authority);
  }

  async start() {
    if (!this.supported()) return;
    // A configured rollout requires the paired migration before the listener starts.
    await this.database().query(`SELECT 1 FROM ${table} LIMIT 0`);
    this.unsubscribe = this.bots.events.onInvalidate((id) => this.cancel(id));
    this.tick = setInterval(() => {
      if (this.pending || this.stopped) return;
      this.pending = this.runOnce().catch(() => {
        this.bots.ctx.log.warn({ component: "bot_event_webhook" }, "Outbound event scheduling failed; retry scheduled");
      }).finally(() => { this.pending = undefined; });
    }, 1_000);
    this.tick.unref();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.tick);
    this.unsubscribe?.();
    for (const id of this.live.keys()) this.cancel(id);
    await this.pending;
  }

  async runOnce() {
    const db = this.database(), now = this.bots.clock();
    const claimed = await db.query<Endpoint>(
      `WITH due AS (
        SELECT w.bot_id FROM ${table} w CROSS JOIN meldiq_private.bot_event_clock clock
        WHERE w.active AND w.next_run<=$1 AND w.claim_until<=$1 AND w.position<clock.last_seq
        ORDER BY w.next_run,w.bot_id LIMIT 2 FOR UPDATE OF w SKIP LOCKED
      )
      UPDATE ${table} w SET claim=$2,claim_until=$3 FROM due WHERE w.bot_id=due.bot_id RETURNING w.*`,
      [now, randomUUID(), now + 30_000],
    );
    const outcomes = await Promise.allSettled(claimed.rows.map((row) => this.runClaim(row)));
    if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("Outbound event claim failed");
  }

  private async runClaim(row: Endpoint) {
    const db = this.database(), config = this.config();
    const bot = await this.bots.store.bot(row.bot_id);
    // Match the bot credential generation and re-evaluate the current community grant on every attempt.
    if (!bot || row.binding !== this.binding(bot, row.community_id) || !(await this.authorized(row, bot, undefined))) {
      if (!this.stopped) await db.query(
        `UPDATE ${table} SET active=false,claim=NULL,claim_until=0
         WHERE bot_id=$1 AND generation=$2 AND claim=$3`, [row.bot_id, row.generation, row.claim],
      );
      return;
    }
    const authority = this.bots.events.authorityKey(bot);
    const { event, next } = await this.bots.events.webhookPage(bot, String(row.position), row.community_id);
    if (!event) {
      await this.finish(row, next, null, 0, this.bots.clock() + 2_000, null);
      return;
    }
    const attempt = row.pending_event === event.id ? row.attempts + 1 : 1;
    // Never forward arbitrary event data. IDs already passed the normal bot replay policy.
    const { data: _data, ...projection } = event;
    const body = Buffer.from(JSON.stringify({ type: "event", event: projection }));
    const allow = () => this.authorized(row, bot, authority);
    let status: number | undefined;
    try {
      const url = webhookDestination(row.endpoint, config.hosts);
      status = (await this.post(row, url, {
        id: event.id, secret: webhookSecret(config.master, row.bot_id, row.generation), body,
      }, allow))?.status;
    } catch {
      // DNS, timeout and TLS failures are retried with the same delivery ID; no network error contains stored secrets in logs.
      status = 0;
    }
    if (this.stopped || !(await allow())) {
      await this.finish(row, String(row.position), row.pending_event, row.attempts, this.bots.clock() + 1_000, null);
      return;
    }
    const now = this.bots.clock();
    const success = status !== undefined && status >= 200 && status < 300;
    const retryable = !status || status === 408 || status === 429 || status >= 500;
    if (!success && retryable && attempt <= retryDelays.length) {
      await this.finish(row, String(row.position), event.id, attempt, now + retryDelays[attempt - 1]!, null);
    } else {
      await this.finish(row, next, null, 0, now, success ? "delivered" : "exhausted");
    }
  }

  private async finish(
    row: Endpoint, position: string, pending: string | null, attempts: number, due: number, result: Endpoint["last_result"],
  ) {
    await this.database().query(
      `UPDATE ${table} SET position=$4,pending_event=$5,attempts=$6,next_run=$7,
       last_result=COALESCE($8,last_result),last_at=CASE WHEN $8 IS NULL THEN last_at ELSE $9 END,claim=NULL,claim_until=0
       WHERE bot_id=$1 AND generation=$2 AND claim=$3`,
      [row.bot_id, row.generation, row.claim, position, pending, attempts, due, result, this.bots.clock()],
    );
  }
}

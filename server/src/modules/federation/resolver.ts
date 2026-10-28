/**
 * Resolves other servers through the core nodes (docs/GLOBAL_IDENTITIES_AND_DISCOVERY.md §4).
 *
 * - domain → server id needs `quorum` core nodes to agree (answers signed by each node's configured key).
 * - Descriptors are verified here, never trusted from a node: the id is self-certifying, the signature and key chain
 *   are checked, a lower seq or a shorter key chain than one already seen is ignored (anti-rollback).
 * - Final records (decommission, revocation) verify on their own, so one honest node is enough to learn them.
 * - Verified results are cached in SQLite. A known server keeps resolving from cache while core nodes are unreachable
 *   (until its descriptor expires); an unknown domain needs a live quorum.
 */
import type { Rows } from "../../infrastructure/database/rows/index.js";
import { ApiError, type ErrorCode } from "../../shared/errors.js";
import { chainExtends, isDomain, isServerId, type ServerDescriptor, verifyDescriptor } from "./identity.js";
import { type CoreAnswer, type FinalRecord, type LifecycleState, verifyAnswer, verifyDecommission, verifyRevocation } from "./records.js";

/** Federation failures are ordinary API errors (status, code, message), so clients get them as JSON like any other. */
export class FederationError extends ApiError {
  constructor(status: number, code: ErrorCode, message: string) {
    super(status, code, message);
  }
  get status() {
    return this.statusCode;
  }
}

export interface ResolvedServer {
  serverId: string;
  domain: string;
  descriptor: ServerDescriptor;
  currentKey: string;
  state: LifecycleState | "unknown";
  final: FinalRecord | null;
  /** How many core nodes agreed in the answer this came from (0 when served from cache). */
  agreeing: number;
  source: "quorum" | "cache";
  /** Set when a domain now resolves to a different server than the one pinned before. */
  previousServerId?: string;
}

const CACHE_FRESH_MS = 5 * 60_000;

export class Resolver {
  private trustedCoreKeys: Set<string>;

  constructor(
    /** The federation domain's rows: verified peers and domain bindings. */
    private rows: Rows,
    private cores: { url: string; publicKey: string }[],
    private quorum: number,
    private fetchFn: typeof fetch = fetch,
    private timeoutMs = 4000,
  ) {
    this.trustedCoreKeys = new Set(cores.map((c) => c.publicKey));
  }

  private async ask(query: string, path: string): Promise<{ core: string; answer: CoreAnswer }[]> {
    const results = await Promise.all(
      this.cores.map(async (c) => {
        try {
          const res = await this.fetchFn(`${c.url.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
          if (!res.ok) return null;
          const a = (await res.json()) as CoreAnswer;
          return verifyAnswer(a, c.publicKey, query) ? { core: c.publicKey, answer: a } : null;
        } catch {
          return null;
        }
      }),
    );
    return results.filter((r): r is { core: string; answer: CoreAnswer } => r !== null);
  }

  /** A final record is accepted only if it verifies on its own (a node can't invent one). */
  private validFinal(f: FinalRecord | null, serverId: string): FinalRecord | null {
    if (!f) return null;
    if (f.kind === "decommissioned" && verifyDecommission(f.record) === serverId) return f;
    // Revocations need a majority of the configured core keys.
    if (f.kind === "revoked" && f.record.serverId === serverId && verifyRevocation(f.record, this.trustedCoreKeys, Math.floor(this.cores.length / 2) + 1)) return f;
    return null;
  }

  private cached(serverId: string): { descriptor: ServerDescriptor; state: string; final: FinalRecord | null; verifiedAt: number } | null {
    const r = this.rows.get<{ descriptor: string; state: string; final: string | null; verified_at: number }>("federation_peers", { server_id: serverId });
    return r ? { descriptor: JSON.parse(r.descriptor), state: r.state, final: r.final ? JSON.parse(r.final) : null, verifiedAt: r.verified_at } : null;
  }

  private store(d: ServerDescriptor, state: string, final: FinalRecord | null, agreeing: number): Promise<void> {
    const now = Date.now();
    const known = { domain: d.domain, descriptor: JSON.stringify(d), seq: d.seq, state: final ? final.kind : state, verified_at: now, agreeing, updated_at: now };
    return this.rows.write((w) => {
      const prior = w.get<{ final: string | null }>("federation_peers", { server_id: d.serverId });
      // A final record (decommissioned, revoked) is never replaced.
      const finalText = prior?.final ?? (final ? JSON.stringify(final) : null);
      w.upsert("federation_peers", { server_id: d.serverId, ...known, final: finalText }, { ...known, final: finalText });
    });
  }

  /** Picks the newest valid descriptor that doesn't roll back what we already know. */
  private best(serverId: string, candidates: (ServerDescriptor | null | undefined)[]): ServerDescriptor | null {
    const known = this.cached(serverId)?.descriptor;
    let best: ServerDescriptor | null = null;
    for (const d of candidates) {
      if (!d || d.serverId !== serverId || !verifyDescriptor(d).ok) continue;
      if (known && (d.seq < known.seq || !chainExtends(known.keyChain, d.keyChain))) continue;
      if (!best || d.seq > best.seq) best = d;
    }
    if (!best && known && verifyDescriptor(known).ok) best = known;
    return best;
  }

  private majorityState(states: string[]): LifecycleState | "unknown" {
    const counts = new Map<string, number>();
    for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
    let top: string = "unknown";
    let n = 0;
    for (const [s, c] of counts) if (c > n) [top, n] = [s, c];
    return top as LifecycleState | "unknown";
  }

  /** Resolve a server we already have an id for (inbound requests, outbox routing). One valid descriptor suffices. */
  async server(serverId: string, opts: { fresh?: boolean } = {}): Promise<ResolvedServer> {
    if (!isServerId(serverId)) throw new FederationError(400, "bad_server_id", "Not a server id");
    const c = this.cached(serverId);
    if (c?.final) return this.result(c.descriptor, c.final.kind, c.final, 0, "cache");
    if (c && !opts.fresh && Date.now() - c.verifiedAt < CACHE_FRESH_MS && verifyDescriptor(c.descriptor).ok) {
      return this.result(c.descriptor, c.state as LifecycleState, null, 0, "cache");
    }
    const answers = await this.ask(`server:${serverId}`, `/core/v1/servers/${serverId}`);
    const final = answers.map((a) => this.validFinal(a.answer.result.final, serverId)).find((f) => f) ?? null;
    const d = this.best(serverId, answers.map((a) => a.answer.result.descriptor));
    if (!d) {
      if (c && verifyDescriptor(c.descriptor).ok) return this.result(c.descriptor, c.state as LifecycleState, c.final, 0, "cache");
      throw new FederationError(502, "server_unresolvable", "Couldn't verify that server's identity right now");
    }
    const state = final ? final.kind : this.majorityState(answers.map((a) => a.answer.result.state));
    await this.store(d, state, final, answers.length);
    return this.result(d, state, final, answers.length, answers.length ? "quorum" : "cache");
  }

  /** Resolve a domain (from a user address). Needs a quorum of core nodes to agree on the server id. */
  async domain(domain: string): Promise<ResolvedServer> {
    const dom = domain.toLowerCase();
    if (!isDomain(dom)) throw new FederationError(400, "bad_domain", "That isn't a valid server address");
    const answers = await this.ask(`domain:${dom}`, `/core/v1/domains/${encodeURIComponent(dom)}`);
    const votes = new Map<string, CoreAnswer[]>();
    for (const { answer } of answers) {
      const id = answer.result.serverId;
      const d = answer.result.descriptor;
      if (!id || !d || d.serverId !== id || d.domain !== dom) continue;
      votes.set(id, [...(votes.get(id) ?? []), answer]);
    }
    const pinned = this.rows.get<{ server_id: string; verified_at: number }>("federation_domains", { domain: dom });
    const winner = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (!winner || winner[1].length < this.quorum) {
      // No live quorum: a previously verified binding still works until its descriptor expires.
      if (pinned) {
        const c = this.cached(pinned.server_id);
        if (c && verifyDescriptor(c.descriptor).ok) return this.result(c.descriptor, (c.final?.kind ?? c.state) as LifecycleState, c.final, 0, "cache");
      }
      if (answers.length < this.quorum) throw new FederationError(503, "directory_unavailable", "Not enough directory nodes answered to verify that server");
      if (votes.size === 0) throw new FederationError(404, "unknown_domain", "No Griip server is registered at that address");
      throw new FederationError(409, "directory_conflict", "Directory nodes disagree about that server; not routing to it");
    }
    const [serverId, agreeing] = winner;
    const final = agreeing.map((a) => this.validFinal(a.result.final, serverId)).find((f) => f) ?? null;
    const d = this.best(serverId, agreeing.map((a) => a.result.descriptor));
    if (!d) throw new FederationError(502, "bad_descriptor", "The directory returned an invalid server descriptor");
    const state = final ? final.kind : this.majorityState(agreeing.map((a) => a.result.state));
    await this.store(d, state, final, agreeing.length);
    const binding = { server_id: serverId, verified_at: Date.now() };
    await this.rows.write((w) => w.upsert("federation_domains", { domain: dom, ...binding }, binding));
    const r = this.result(d, state, final, agreeing.length, "quorum");
    if (pinned && pinned.server_id !== serverId) r.previousServerId = pinned.server_id;
    return r;
  }

  private result(d: ServerDescriptor, state: LifecycleState | "unknown", final: FinalRecord | null, agreeing: number, source: "quorum" | "cache"): ResolvedServer {
    const check = verifyDescriptor(d);
    if (!check.ok) throw new FederationError(502, "bad_descriptor", check.error);
    return { serverId: d.serverId, domain: d.domain, descriptor: d, currentKey: check.currentKey, state, final, agreeing, source };
  }

  /** Called when a peer presents a newer descriptor directly (e.g. in a signed request after rotating its key). */
  async learn(d: ServerDescriptor): Promise<boolean> {
    const c = this.cached(d.serverId);
    if (!verifyDescriptor(d).ok) return false;
    if (c && (c.final || d.seq <= c.descriptor.seq || !chainExtends(c.descriptor.keyChain, d.keyChain))) return false;
    if (!c) return false; // unknown servers must come through the directory first
    await this.store(d, c.state, null, 0);
    return true;
  }
}

import type { DB } from "../../infrastructure/database/db.js";
import { ApiError } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { type QuotaEngine, refusal, scopesFor } from "../quotas/index.js";
import { complete, type Fetch, listModels, MODEL_ID, PROVIDER_LABELS, type ProviderKind, ProviderError } from "./providers.js";
import type { SecretBox } from "./secrets.js";
import { AiGateway } from "./gateway.js";
import { AiRouting } from "./routing.js";

/**
 * AI operations (docs/AI_OPERATIONS.md): provider connections, approved models and their prices, and the one gateway
 * every AI request goes through. No Meldiq product feature uses AI today; the gateway serves the console's connection
 * tests and is ready for features once they're approved. It never receives conversation content: end-to-end encrypted
 * messages can't be read by the server, and nothing here tries to.
 *
 * Gateway order: kill switch → feature → provider and model allowlist → limits on input and output → quota
 * reservations (requests, tokens, estimated cost; person, organization, platform) → the call (bounded retries, an
 * explicitly configured fallback) → settlement with the provider's token counts → one usage row (counts only).
 */

/** Features allowed to call the gateway. Product features are added here only once approved. */
export const AI_FEATURES = {
  "console.test": { label: "Console connection test", description: "A one-line generation an admin runs to check a provider and model end to end." },
} as const;
export type AiFeature = keyof typeof AI_FEATURES;

export const MAX_PROMPT_CHARS = 20_000;
export const MAX_OUTPUT_TOKENS = 4096;
/** Characters per token for estimates before the provider reports real counts (labelled "estimate" when kept). */
const CHARS_PER_TOKEN = 4;

interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  enabled: number;
  secret_ciphertext: string | null;
  secret_set_at: number | null;
  timeout_ms: number;
  max_retries: number;
  fallback_id: string | null;
  last_test_at: number | null;
  last_test_ok: number | null;
  last_test_detail: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ModelRow {
  provider_id: string;
  model: string;
  enabled: number;
  input_price_micro: number | null;
  output_price_micro: number | null;
  price_source: string;
  price_updated_at: number | null;
}

export interface ProviderView {
  id: string;
  kind: ProviderKind;
  kindLabel: string;
  name: string;
  enabled: boolean;
  /** A credential is stored (never shown). Configured isn't working: see lastTest. */
  credential: { configured: boolean; setAt: number | null };
  timeoutMs: number;
  maxRetries: number;
  fallbackId: string | null;
  lastTest: { at: number; ok: boolean; detail: string } | null;
  models: { model: string; enabled: boolean; inputPriceMicro: number | null; outputPriceMicro: number | null; priceSource: string; priceUpdatedAt: number | null }[];
  updatedAt: number;
}

export interface CompletionRequest {
  feature: AiFeature;
  userId?: string | null;
  orgId?: string | null;
  providerId: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
}

const boundTo = (providerId: string) => `ai_provider:${providerId}`;

/** Estimated cost in micro-USD from per-million-token prices; null when a price is missing (never guessed). */
export function costMicro(m: Pick<ModelRow, "input_price_micro" | "output_price_micro"> | undefined, input: number, output: number): number | null {
  if (!m || m.input_price_micro === null || m.output_price_micro === null) return null;
  return Math.round((input * m.input_price_micro + output * m.output_price_micro) / 1_000_000);
}

export class AiService {
  /** Capabilities per model and `auto` routing (routing.ts). */
  readonly routing: AiRouting;
  /** The capability gateway AI Workforce jobs call (gateway.ts). */
  readonly gateway: AiGateway;

  constructor(
    private readonly db: DB,
    private readonly quotas: QuotaEngine,
    private readonly box: SecretBox,
    private readonly opts: { fetch?: Fetch; enabled: () => boolean; clock?: () => number },
  ) {
    const clock = () => this.now();
    this.routing = new AiRouting(db, clock);
    this.gateway = new AiGateway(
      db,
      quotas,
      this.routing,
      {
        provider: (id) => {
          const r = this.db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as ProviderRow | undefined;
          return r ? { id: r.id, kind: r.kind, timeoutMs: r.timeout_ms, maxRetries: r.max_retries } : null;
        },
        openKey: (id) => this.key(this.row(id)),
      },
      { fetch: () => this.fetch, enabled: () => this.enabled, clock },
    );
  }

  private get fetch(): Fetch {
    return this.opts.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<Fetch>);
  }

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  get secretsAvailable(): boolean {
    return this.box.available;
  }

  get enabled(): boolean {
    return this.opts.enabled();
  }

  private row(id: string): ProviderRow {
    const r = this.db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as ProviderRow | undefined;
    if (!r) throw new ApiError(404, "not_found", "No such provider.");
    return r;
  }

  private models(providerId: string): ModelRow[] {
    return this.db.prepare("SELECT * FROM ai_models WHERE provider_id = ? ORDER BY model").all(providerId) as ModelRow[];
  }

  providers(): ProviderView[] {
    const rows = this.db.prepare("SELECT * FROM ai_providers ORDER BY created_at").all() as ProviderRow[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      kindLabel: PROVIDER_LABELS[r.kind],
      name: r.name,
      enabled: !!r.enabled,
      credential: { configured: r.secret_ciphertext !== null, setAt: r.secret_set_at },
      timeoutMs: r.timeout_ms,
      maxRetries: r.max_retries,
      fallbackId: r.fallback_id,
      lastTest: r.last_test_at === null ? null : { at: r.last_test_at, ok: !!r.last_test_ok, detail: r.last_test_detail ?? "" },
      models: this.models(r.id).map((m) => ({
        model: m.model,
        enabled: !!m.enabled,
        inputPriceMicro: m.input_price_micro,
        outputPriceMicro: m.output_price_micro,
        priceSource: m.price_source,
        priceUpdatedAt: m.price_updated_at,
      })),
      updatedAt: r.updated_at,
    }));
  }

  createProvider(kind: ProviderKind, name: string, actor: string): ProviderView {
    const t = this.now();
    const id = newId("aip");
    if (this.db.prepare("SELECT 1 FROM ai_providers WHERE name = ?").get(name)) throw new ApiError(409, "conflict", "A provider connection with that name exists.");
    this.db
      .prepare("INSERT INTO ai_providers (id, kind, name, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)")
      .run(id, kind, name, actor, t, t);
    return this.providers().find((p) => p.id === id)!;
  }

  updateProvider(id: string, patch: { enabled?: boolean; timeoutMs?: number; maxRetries?: number; fallbackId?: string | null; name?: string }): ProviderView {
    const r = this.row(id);
    if (patch.enabled && !r.secret_ciphertext) throw new ApiError(409, "ai_not_configured", "Add and test a credential before enabling this provider.");
    if (patch.fallbackId) {
      if (patch.fallbackId === id) throw new ApiError(400, "invalid_policy", "A provider can't be its own fallback.");
      this.row(patch.fallbackId);
    }
    this.db
      .prepare(
        `UPDATE ai_providers SET enabled = COALESCE(?, enabled), timeout_ms = COALESCE(?, timeout_ms), max_retries = COALESCE(?, max_retries),
           fallback_id = CASE WHEN ? THEN ? ELSE fallback_id END, name = COALESCE(?, name), updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
        patch.timeoutMs ?? null,
        patch.maxRetries ?? null,
        patch.fallbackId !== undefined ? 1 : 0,
        patch.fallbackId ?? null,
        patch.name ?? null,
        this.now(),
        id,
      );
    return this.providers().find((p) => p.id === id)!;
  }

  /** Stores (or rotates) the provider's key, encrypted; the previous one is gone and its models must be verified again. The key is never returned. */
  setCredential(id: string, apiKey: string): void {
    this.row(id);
    const sealed = this.box.seal(apiKey, boundTo(id));
    const t = this.now();
    this.db
      .prepare("UPDATE ai_providers SET secret_ciphertext = ?, secret_set_at = ?, last_test_at = NULL, last_test_ok = NULL, last_test_detail = NULL, updated_at = ? WHERE id = ?")
      .run(sealed, t, t, id);
    this.routing.invalidateProvider(id, "The provider's key changed: verify again.");
  }

  /** Removes the key and disables the provider (revocation at the provider is the operator's step there). */
  clearCredential(id: string): void {
    this.row(id);
    this.db.prepare("UPDATE ai_providers SET secret_ciphertext = NULL, secret_set_at = NULL, enabled = 0, updated_at = ? WHERE id = ?").run(this.now(), id);
    this.routing.invalidateProvider(id, "The provider's key was removed.");
  }

  private key(r: ProviderRow): string {
    if (!r.secret_ciphertext) throw new ApiError(409, "ai_not_configured", "This provider has no credential.");
    return this.box.open(r.secret_ciphertext, boundTo(r.id));
  }

  /**
   * The connection test: lists the models the key can use (a real, authenticated request that the providers don't
   * charge for). Records the result; returns what the provider said, reduced to counts and ids.
   */
  async testConnection(id: string): Promise<{ ok: boolean; latencyMs: number; models: string[]; detail: string }> {
    const r = this.row(id);
    const key = this.key(r);
    const t0 = this.now();
    let result: { ok: boolean; models: string[]; detail: string };
    try {
      const models = await listModels(this.fetch, r.kind, key, r.timeout_ms);
      result = { ok: true, models, detail: `authenticated; ${models.length} models available` };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("unexpected", null);
      result = { ok: false, models: [], detail: `${pe.kind}${pe.status ? ` (HTTP ${pe.status})` : ""}` };
    }
    const latencyMs = this.now() - t0;
    this.db.prepare("UPDATE ai_providers SET last_test_at = ?, last_test_ok = ?, last_test_detail = ? WHERE id = ?").run(this.now(), result.ok ? 1 : 0, result.detail, id);
    return { ...result, latencyMs };
  }

  setModel(providerId: string, model: string, m: { enabled: boolean; inputPriceMicro: number | null; outputPriceMicro: number | null; priceSource: string }): void {
    this.row(providerId);
    if (!MODEL_ID.test(model)) throw new ApiError(400, "invalid_policy", "That isn't a model id.");
    const priced = m.inputPriceMicro !== null || m.outputPriceMicro !== null;
    if (priced && m.priceSource.trim().length < 3) throw new ApiError(400, "invalid_policy", "Say where the prices come from (the provider's pricing page and the date you read it).");
    this.db
      .prepare(
        `INSERT INTO ai_models (provider_id, model, enabled, input_price_micro, output_price_micro, price_source, price_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider_id, model) DO UPDATE SET enabled = excluded.enabled, input_price_micro = excluded.input_price_micro,
           output_price_micro = excluded.output_price_micro, price_source = excluded.price_source, price_updated_at = excluded.price_updated_at`,
      )
      .run(providerId, model, m.enabled ? 1 : 0, m.inputPriceMicro, m.outputPriceMicro, m.priceSource.trim(), priced ? this.now() : null);
  }

  /** Removes an approved model with its capabilities and their verifications (approving it again starts over). */
  removeModel(providerId: string, model: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ai_model_capabilities WHERE provider_id = ? AND model = ?").run(providerId, model);
      this.db.prepare("DELETE FROM ai_models WHERE provider_id = ? AND model = ?").run(providerId, model);
    })();
  }

  private record(u: {
    providerId: string;
    model: string;
    feature: string;
    userId?: string | null;
    orgId?: string | null;
    outcome: "ok" | "error" | "blocked" | "timeout";
    status?: number | null;
    input?: number | null;
    output?: number | null;
    tokensSource: "provider" | "estimate" | "none";
    cost?: number | null;
    latencyMs?: number | null;
    errorKind?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage (at, provider_id, model, feature, user_id, org_id, outcome, status, input_tokens, output_tokens, tokens_source, cost_micro, latency_ms, error_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.now(), u.providerId, u.model, u.feature, u.userId ?? null, u.orgId ?? null, u.outcome, u.status ?? null, u.input ?? null, u.output ?? null, u.tokensSource, u.cost ?? null, u.latencyMs ?? null, u.errorKind ?? null);
  }

  /** The gateway (see the class comment). Throws an ApiError the caller can return as it is. */
  async complete(req: CompletionRequest): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null; costMicro: number | null; providerId: string; model: string; latencyMs: number }> {
    if (!Object.hasOwn(AI_FEATURES, req.feature)) throw new ApiError(400, "invalid_policy", "Unknown AI feature.");
    if (!this.enabled) {
      this.record({ providerId: req.providerId, model: req.model, feature: req.feature, userId: req.userId, orgId: req.orgId, outcome: "blocked", tokensSource: "none", errorKind: "kill_switch" });
      throw new ApiError(503, "ai_disabled", "AI is switched off on this server.");
    }
    const r = this.row(req.providerId);
    const model = this.models(r.id).find((m) => m.model === req.model && m.enabled);
    if (!r.enabled || !model) throw new ApiError(503, "ai_not_configured", "That provider or model isn't enabled.");
    if (req.prompt.length === 0 || req.prompt.length > MAX_PROMPT_CHARS) throw new ApiError(400, "invalid_policy", `A prompt is 1–${MAX_PROMPT_CHARS} characters.`);
    const maxOut = Math.min(Math.max(1, Math.floor(req.maxOutputTokens)), MAX_OUTPUT_TOKENS);

    // Reserve before calling: requests, estimated tokens, estimated cost (when prices exist).
    const scopes = scopesFor(req.userId ?? "console", req.orgId ?? null).filter((s) => req.userId || s.type !== "user");
    const estIn = Math.ceil(req.prompt.length / CHARS_PER_TOKEN);
    const estCost = costMicro(model, estIn, maxOut);
    const reservations: { key: "ai.requests" | "ai.tokens" | "ai.cost_micro"; id: string | null }[] = [];
    const reserve = (key: "ai.requests" | "ai.tokens" | "ai.cost_micro", amount: number) => {
      const d = this.quotas.check(key, scopes, amount, { reserve: true, detail: req.feature });
      if (!d.allowed) {
        for (const x of reservations) if (x.id) this.quotas.release(x.id);
        this.record({ providerId: r.id, model: req.model, feature: req.feature, userId: req.userId, orgId: req.orgId, outcome: "blocked", tokensSource: "none", errorKind: `quota:${key}` });
        throw refusal(d);
      }
      reservations.push({ key, id: d.reservationId });
    };
    reserve("ai.requests", 1);
    reserve("ai.tokens", estIn + maxOut);
    if (estCost !== null) reserve("ai.cost_micro", estCost);

    const t0 = this.now();
    const attempt = async (p: ProviderRow, m: ModelRow) => {
      let last: ProviderError | null = null;
      for (let i = 0; i <= Math.min(p.max_retries, 3); i++) {
        try {
          return { p, m, out: await complete(this.fetch, p.kind, this.key(p), m.model, req.prompt, maxOut, p.timeout_ms) };
        } catch (e) {
          last = e instanceof ProviderError ? e : new ProviderError("unexpected", null);
          if (!last.retryable) break;
        }
      }
      throw last ?? new ProviderError("unexpected", null);
    };
    let done: { p: ProviderRow; m: ModelRow; out: Awaited<ReturnType<typeof complete>> };
    try {
      try {
        done = await attempt(r, model);
      } catch (e) {
        // An explicitly configured fallback, on its own first enabled model; recorded as that provider and model.
        const fb = r.fallback_id ? (this.db.prepare("SELECT * FROM ai_providers WHERE id = ? AND enabled = 1").get(r.fallback_id) as ProviderRow | undefined) : undefined;
        const fbModel = fb ? this.models(fb.id).find((m) => m.enabled) : undefined;
        if (!(e instanceof ProviderError && e.retryable) || !fb || !fbModel) throw e;
        this.record({ providerId: r.id, model: req.model, feature: req.feature, userId: req.userId, orgId: req.orgId, outcome: e.kind === "timeout" ? "timeout" : "error", status: e.status, tokensSource: "none", latencyMs: this.now() - t0, errorKind: `${e.kind};fallback` });
        done = await attempt(fb, fbModel);
      }
    } catch (e) {
      for (const x of reservations) if (x.id) this.quotas.release(x.id);
      const pe = e instanceof ProviderError ? e : new ProviderError("unexpected", null);
      this.record({ providerId: r.id, model: req.model, feature: req.feature, userId: req.userId, orgId: req.orgId, outcome: pe.kind === "timeout" ? "timeout" : "error", status: pe.status, tokensSource: "none", latencyMs: this.now() - t0, errorKind: pe.kind });
      throw new ApiError(502, "provider_error", `The provider didn't answer (${pe.kind}).`);
    }
    const reported = done.out.inputTokens !== null && done.out.outputTokens !== null;
    const input = done.out.inputTokens ?? estIn;
    const output = done.out.outputTokens ?? Math.ceil(done.out.text.length / CHARS_PER_TOKEN);
    const cost = costMicro(done.m, input, output);
    for (const x of reservations) {
      if (!x.id) continue;
      this.quotas.commit(x.id, x.key === "ai.requests" ? 1 : x.key === "ai.tokens" ? input + output : (cost ?? 0));
    }
    const latencyMs = this.now() - t0;
    this.record({ providerId: done.p.id, model: done.m.model, feature: req.feature, userId: req.userId, orgId: req.orgId, outcome: "ok", status: 200, input, output, tokensSource: reported ? "provider" : "estimate", cost, latencyMs });
    return { text: done.out.text, inputTokens: done.out.inputTokens, outputTokens: done.out.outputTokens, costMicro: cost, providerId: done.p.id, model: done.m.model, latencyMs };
  }

  /** AI Workforce's model use since [from]: totals, by capability, by provider and model (with p50), by community. */
  workforceUsage(from: number) {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) requests, SUM(outcome IN ('error','timeout')) failed, SUM(COALESCE(input_tokens,0)) inputTokens, SUM(COALESCE(output_tokens,0)) outputTokens,
                SUM(COALESCE(cost_micro,0)) costMicro, SUM(outcome = 'ok' AND cost_micro IS NULL) unpriced FROM ai_usage WHERE feature = 'workforce' AND at >= ?`,
      )
      .get(from) as Record<string, number | null>;
    const n = (k: string) => Number(totals[k] ?? 0);
    const byCapability = this.db
      .prepare("SELECT COALESCE(capability, 'text') capability, COUNT(*) requests, SUM(outcome IN ('error','timeout')) failed, SUM(COALESCE(cost_micro,0)) costMicro FROM ai_usage WHERE feature = 'workforce' AND at >= ? GROUP BY 1 ORDER BY requests DESC")
      .all(from) as { capability: string; requests: number; failed: number; costMicro: number }[];
    const byProvider = (
      this.db
        .prepare("SELECT provider_id providerId, model, COUNT(*) requests, SUM(outcome IN ('error','timeout')) failed, SUM(COALESCE(cost_micro,0)) costMicro FROM ai_usage WHERE feature = 'workforce' AND at >= ? GROUP BY provider_id, model ORDER BY requests DESC LIMIT 50")
        .all(from) as { providerId: string; model: string; requests: number; failed: number; costMicro: number }[]
    ).map((r) => {
      const l = (this.db.prepare("SELECT latency_ms l FROM ai_usage WHERE feature = 'workforce' AND provider_id = ? AND model = ? AND outcome = 'ok' AND at >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms").all(r.providerId, r.model, from) as { l: number }[]).map((x) => x.l);
      return { ...r, p50Ms: l.length ? l[Math.floor((l.length - 1) / 2)]! : null };
    });
    const byOrg = this.db
      .prepare("SELECT org_id orgId, COUNT(*) requests, SUM(COALESCE(cost_micro,0)) costMicro FROM ai_usage WHERE feature = 'workforce' AND at >= ? AND org_id IS NOT NULL GROUP BY org_id ORDER BY requests DESC LIMIT 20")
      .all(from) as { orgId: string; requests: number; costMicro: number }[];
    return { requests: n("requests"), failed: n("failed"), inputTokens: n("inputTokens"), outputTokens: n("outputTokens"), estimatedCostMicro: n("costMicro"), unpricedRequests: n("unpriced"), byCapability, byProvider, byOrg };
  }

  /** The latest routing decisions (one usage row each): which model served which capability, and how it was chosen. */
  recentRoutes(limit: number) {
    return this.db
      .prepare("SELECT at, provider_id providerId, model, capability, route, outcome, error_kind errorKind, latency_ms latencyMs FROM ai_usage WHERE route IS NOT NULL ORDER BY id DESC LIMIT ?")
      .all(limit) as { at: number; providerId: string; model: string; capability: string | null; route: string | null; outcome: string; errorKind: string | null; latencyMs: number | null }[];
  }

  /** Requests and estimated cost per job (AI Workforce's job lists). */
  jobUsage(jobIds: string[]): Map<string, { requests: number; costMicro: number }> {
    if (!jobIds.length) return new Map();
    const rows = this.db
      .prepare(`SELECT job_id, COUNT(*) requests, SUM(COALESCE(cost_micro,0)) cost FROM ai_usage WHERE job_id IN (${jobIds.map(() => "?").join(",")}) GROUP BY job_id`)
      .all(...jobIds) as { job_id: string; requests: number; cost: number }[];
    return new Map(rows.map((r) => [r.job_id, { requests: r.requests, costMicro: r.cost }]));
  }

  /** What an agent installation's requests cost since [from] (micro-USD, estimated where the provider gave no price). */
  installCost(installId: string, from: number): number {
    const r = this.db.prepare("SELECT SUM(COALESCE(cost_micro, 0)) cost FROM ai_usage WHERE install_id = ? AND at >= ?").get(installId, from) as { cost: number | null };
    return r.cost ?? 0;
  }

  /** Requests the console's verifications sent since [from]: real provider calls, kept apart from agents' usage. */
  verificationUsage(from: number): { requests: number; failed: number } {
    const r = this.db.prepare("SELECT COUNT(*) requests, SUM(outcome IN ('error','timeout')) failed FROM ai_usage WHERE feature = 'console.verify' AND at >= ?").get(from) as {
      requests: number;
      failed: number | null;
    };
    return { requests: r.requests, failed: r.failed ?? 0 };
  }

  /** One community's AI Workforce requests and estimated cost since [from]. */
  orgUsage(orgId: string, from: number): { requests: number; costMicro: number } {
    const r = this.db.prepare("SELECT COUNT(*) requests, SUM(COALESCE(cost_micro,0)) cost FROM ai_usage WHERE feature = 'workforce' AND org_id = ? AND at >= ?").get(orgId, from) as { requests: number; cost: number | null };
    return { requests: r.requests, costMicro: r.cost ?? 0 };
  }

  /** Usage since [from] (ms): totals, by provider and model, by feature, by day, and latency percentiles. */
  usage(from: number) {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) requests, SUM(outcome = 'ok') ok, SUM(outcome IN ('error','timeout')) failed, SUM(outcome = 'blocked') blocked,
                SUM(COALESCE(input_tokens, 0)) inputTokens, SUM(COALESCE(output_tokens, 0)) outputTokens, SUM(COALESCE(cost_micro, 0)) costMicro,
                SUM(outcome = 'ok' AND cost_micro IS NULL) unpriced, SUM(tokens_source = 'estimate') estimatedTokens, SUM(error_kind = 'rate_limited') rateLimited
           FROM ai_usage WHERE at >= ?`,
      )
      .get(from) as Record<string, number | null>;
    const byModel = this.db
      .prepare(
        `SELECT provider_id providerId, model, COUNT(*) requests, SUM(outcome = 'ok') ok, SUM(COALESCE(input_tokens,0)) inputTokens, SUM(COALESCE(output_tokens,0)) outputTokens,
                SUM(COALESCE(cost_micro,0)) costMicro FROM ai_usage WHERE at >= ? GROUP BY provider_id, model ORDER BY requests DESC LIMIT 50`,
      )
      .all(from);
    const byFeature = this.db
      .prepare("SELECT feature, COUNT(*) requests, SUM(COALESCE(cost_micro,0)) costMicro FROM ai_usage WHERE at >= ? GROUP BY feature ORDER BY requests DESC")
      .all(from);
    const byDay = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') day, COUNT(*) requests, SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) tokens,
                SUM(COALESCE(cost_micro,0)) costMicro, SUM(outcome IN ('error','timeout')) failed FROM ai_usage WHERE at >= ? GROUP BY day ORDER BY day`,
      )
      .all(from);
    const latencies = (this.db.prepare("SELECT latency_ms l FROM ai_usage WHERE at >= ? AND outcome = 'ok' AND latency_ms IS NOT NULL ORDER BY latency_ms").all(from) as { l: number }[]).map((x) => x.l);
    const pct = (q: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * q) - 1)]! : null);
    const n = (k: string) => Number(totals[k] ?? 0);
    return {
      from,
      totals: {
        requests: n("requests"),
        ok: n("ok"),
        failed: n("failed"),
        blocked: n("blocked"),
        rateLimited: n("rateLimited"),
        inputTokens: n("inputTokens"),
        outputTokens: n("outputTokens"),
        estimatedCostMicro: n("costMicro"),
        unpricedRequests: n("unpriced"),
        estimatedTokenRows: n("estimatedTokens"),
      },
      latency: { p50Ms: pct(0.5), p95Ms: pct(0.95) },
      byModel,
      byFeature,
      byDay,
    };
  }
}

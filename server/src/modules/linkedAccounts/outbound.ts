import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod/v4";

/**
 * Every request to Steam, AniList, Last.fm and Trakt goes through here: a time limit, no redirects, a size limit, and
 * answers validated before use. Failures are logged with the provider, host, path and status only: never a query string
 * (API keys and codes travel there), a header or a body.
 */
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 1024 * 1024;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OutboundRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** A JSON body (sent as application/json) or form fields (sent as application/x-www-form-urlencoded). */
  json?: unknown;
  form?: Record<string, string>;
}

export class Outbound {
  constructor(
    private readonly log: Pick<FastifyBaseLogger, "warn">,
    /** Read at call time, so tests can stand in for the providers. */
    private readonly fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  /** The answer's text; throws ProviderError for a failure, a timeout, or an answer that isn't 2xx. */
  async text(provider: string, url: string, req: OutboundRequest = {}): Promise<string> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "Meldiq (+https://meldiq.app)", ...req.headers };
    let body: string | undefined;
    if (req.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    }
    const where = (() => {
      try {
        const u = new URL(url);
        return { host: u.host, path: u.pathname };
      } catch {
        return { host: "?", path: "?" };
      }
    })();
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: req.method ?? (body === undefined ? "GET" : "POST"), headers, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      this.log.warn({ provider, ...where }, "linked accounts: provider didn't answer");
      throw new ProviderError(provider, 0, `${provider} didn't answer`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok || text.length > MAX_BYTES) {
      this.log.warn({ provider, ...where, status: res.status }, "linked accounts: provider refused or answered too much");
      throw new ProviderError(provider, res.status, `${provider} answered ${res.status}`);
    }
    return text;
  }

  /** The answer as JSON matching [schema]. */
  async json<T>(provider: string, url: string, schema: z.ZodType<T>, req: OutboundRequest = {}): Promise<T> {
    const text = await this.text(provider, url, req);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn({ provider, host: new URL(url).host, path: new URL(url).pathname }, "linked accounts: provider's answer wasn't understood");
      throw new ProviderError(provider, 502, `${provider}'s answer wasn't understood`);
    }
    return parsed.data;
  }
}

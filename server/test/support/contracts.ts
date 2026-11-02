import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureName } from "../../scripts/contracts.js";
import type { ContractObserver } from "../../src/app/contractObserver.js";
import { ErrorEnvelope, ROUTE_CONTRACTS, type RouteContract } from "../../src/shared/contracts/http/index.js";
import { OAuthErrorBody } from "../../src/shared/contracts/http/oauthApps.js";
import { ServerEvent } from "../../src/shared/contracts/realtime.js";
import { ERROR_CODES, type ErrorCode } from "../../src/shared/errors.js";

/**
 * Every server the test harness starts checks itself against the contracts (docs/architecture/ARCHITECTURE_1_0_PLAN.md
 * §4.2): each answer of a documented route against its response schema, every error answer against the error
 * envelope and the catalog, and every WebSocket frame against ServerEvent. Violations fail the suite when the server
 * closes. With MELDIQ_WRITE_FIXTURES=1 the first real example of each answer and frame is written to
 * shared/contracts/fixtures (files that already exist are kept: delete one to refresh it).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "..", "..", "..", "shared", "contracts", "fixtures");

const byRoute = new Map(ROUTE_CONTRACTS.map((c) => [`${c.method} ${c.url}`, c]));
/** Fields whose values are credentials, even test ones: never written to fixtures. */
const REDACT = new Set(["setupToken", "giftToken", "token", "accessToken", "refreshToken", "sessionToken", "codes", "recoveryCode", "secret", "clientSecret", "access_token", "refresh_token"]);
/** Server-to-server routes speak their own protocol (docs/FEDERATION_PROTOCOL.md). */
const PEER_ROUTE = /^\/(fed|core)\//;

export interface ContractCheck {
  observer: ContractObserver;
  routes: Set<string>;
  violations: string[];
  /** Writes fixtures (when asked) and throws if anything broke a contract. */
  finish(): void;
}

export function contractCheck(): ContractCheck {
  const routes = new Set<string>();
  const violations: string[] = [];
  const samples = new Map<string, unknown>();
  const note = (where: string, issue: string) => {
    if (violations.length < 50) violations.push(`${where}: ${issue}`);
  };
  const sample = (name: string, value: unknown) => {
    if (!samples.has(name)) samples.set(name, value);
  };
  const observer: ContractObserver = {
    route: (method, url) => routes.add(`${method} ${url}`),
    response: (method, url, status, body, contentType) => {
      if (!url || PEER_ROUTE.test(url) || !contentType?.includes("application/json")) return;
      const where = `${method} ${url} ${status}`;
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return note(where, "not JSON");
      }
      const contract: RouteContract | undefined = byRoute.get(`${method} ${url}`);
      // The OAuth token endpoint answers errors as RFC 6749 §5.2 says, not with the error envelope.
      if (contract?.errorFormat === "health" && (status === 200 || status === 503)) {
        const result = contract.response.safeParse(json);
        if (!result.success) note(where, `health response: ${result.error.message}`);
        return;
      }
      if (status >= 400 && contract?.errorFormat === "oauth") {
        const r = OAuthErrorBody.safeParse(json);
        if (!r.success) note(where, `OAuth error body: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        return;
      }
      if (status >= 400) {
        const r = ErrorEnvelope.safeParse(json);
        if (!r.success) return note(where, `error envelope: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        const code = r.data.error.code as ErrorCode;
        if (!ERROR_CODES[code].status.includes(status)) note(where, `${code} isn't catalogued with status ${status}`);
        sample(`http/errors/${code}`, json);
        return;
      }
      if (!contract || status !== (contract.status ?? 200)) return;
      const r = contract.response.safeParse(json);
      if (!r.success) return note(where, r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
      sample(`http/${fixtureName(method, url)}`, json);
    },
    frame: (e) => {
      const r = ServerEvent.safeParse(e);
      if (!r.success) return note(`frame ${(e as { t?: string }).t}`, r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
      sample(`realtime/${e.t === "call" ? `call.${e.event}` : e.t}`, e);
    },
  };
  return {
    observer,
    routes,
    violations,
    finish() {
      if (process.env.MELDIQ_WRITE_FIXTURES === "1") writeFixtures(samples);
      if (violations.length) throw new Error(`Contract violations (src/shared/contracts):\n${violations.join("\n")}`);
    },
  };
}

function redact(v: unknown): unknown {
  if (typeof v === "string" && /#gift=[A-Za-z0-9_-]{43}/.test(v)) return v.replace(/#gift=[A-Za-z0-9_-]{43}/g, "#gift=<redacted>");
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (!REDACT.has(k)) return [k, redact(x)];
        if (typeof x === "string") return [k, "<redacted>"];
        if (Array.isArray(x) && x.every((e) => typeof e === "string")) return [k, x.map(() => "<redacted>")];
        return [k, redact(x)];
      }),
    );
  }
  return v;
}

function writeFixtures(samples: Map<string, unknown>): void {
  for (const [name, value] of samples) {
    const file = path.join(FIXTURES, `${name}.json`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, `${JSON.stringify(redact(value), null, 2)}\n`, { flag: "wx" });
    } catch {
      // Another test file wrote it first.
    }
  }
}

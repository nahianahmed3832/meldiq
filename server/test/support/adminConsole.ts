import { CLI_ACTOR, grantAdmin, PlatformAdminStore, PlatformAudit } from "../../src/modules/platformAdmin/index.js";
import { AccountClient, email, type MemoryMailer } from "./accounts.js";
import { FakePasskey } from "./fakePasskey.js";
import type { Harness } from "./harness.js";

/** The console host and origin the admin suites configure (ADMIN_CONSOLE_ORIGIN). */
export const ADMIN_HOST = "admin.example.test";
export const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;

export interface AdminAnswer {
  status: number;
  body: any;
  setCookies: string[];
  headers: Record<string, unknown>;
}

/**
 * A browser on the console: it keeps the cookies the server sets (by name, as a browser would for one host), sends the
 * console's header and Origin, and reaches the server through Fastify's inject (so Host and the client address can be
 * set per request).
 */
let browsers = 0;

export class AdminBrowser {
  readonly cookies = new Map<string, string>();
  /** Each browser on its own network, as different admins would be (the console limits attempts per network). */
  ip = `10.77.${(++browsers >> 8) & 255}.${browsers & 255}`;

  constructor(readonly h: Harness) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<AdminAnswer> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const base: Record<string, string> = { host: ADMIN_HOST, "x-meldiq-admin": "1", ...(method === "GET" ? {} : { origin: ADMIN_ORIGIN }), ...(cookie ? { cookie } : {}) };
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
    const res = await this.h.app.inject({ method: method as any, url, headers: base, remoteAddress: this.ip, ...(body === undefined ? {} : { payload: body as any }) });
    const raw = res.headers["set-cookie"];
    const setCookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
    for (const c of setCookies) {
      const [pair] = c.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (/Max-Age=0/.test(c) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const json = String(res.headers["content-type"] ?? "").includes("application/json");
    return { status: res.statusCode, body: res.body ? (json ? res.json() : res.rawPayload) : null, setCookies, headers: res.headers as Record<string, unknown> };
  }

  /** Throws unless the answer has [status]; returns its body. */
  async expect(status: number, method: string, url: string, body?: unknown, headers?: Record<string, string | undefined>): Promise<any> {
    const r = await this.req(method, url, body, headers);
    if (r.status !== status) throw new Error(`${method} ${url}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

export const consoleStore = (h: Harness) => new PlatformAdminStore(h.ctx.platform, h.ctx.ephemeral);
export const consoleAudit = (h: Harness) => new PlatformAudit(h.ctx.platform);

/** A verified account (not an admin yet). */
export async function plainAccount(h: Harness, mailer: MemoryMailer, name: string): Promise<AccountClient> {
  const c = await new AccountClient(h.baseUrl, email(name)).signUp(mailer);
  await c.signIn();
  return c;
}

export interface ConsoleAdmin {
  account: AccountClient;
  browser: AdminBrowser;
  passkey: FakePasskey;
}

/** Grants [role] as the CLI would and enrols a console passkey; the returned browser holds a fresh session. */
export async function consoleAdmin(h: Harness, mailer: MemoryMailer, role: string, name = role): Promise<ConsoleAdmin> {
  const account = await plainAccount(h, mailer, name);
  const code = (await grantAdmin(consoleStore(h), consoleAudit(h), await h.ctx.accounts.store.accountById(account.accountId), role, CLI_ACTOR, null))!;
  const browser = new AdminBrowser(h);
  const passkey = new FakePasskey(ADMIN_HOST, ADMIN_ORIGIN);
  const { options } = await browser.expect(200, "POST", "/admin/v1/auth/enrol/options", { email: account.email, password: account.password, code });
  await browser.expect(200, "POST", "/admin/v1/auth/enrol", { response: passkey.create(options), name: "Test key" });
  return { account, browser, passkey };
}

/** Signs [admin] in again from scratch in a new browser: password, then passkey. */
export async function signIn(h: Harness, admin: ConsoleAdmin): Promise<AdminBrowser> {
  const browser = new AdminBrowser(h);
  const { options } = await browser.expect(200, "POST", "/admin/v1/auth/password", { email: admin.account.email, password: admin.account.password });
  await browser.expect(200, "POST", "/admin/v1/auth/passkey", { response: admin.passkey.get(options) });
  return browser;
}

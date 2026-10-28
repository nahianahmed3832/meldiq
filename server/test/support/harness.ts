import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, type BuiltApp } from "../../src/app/server.js";
import { loadConfig } from "../../src/app/config.js";
import type { Mailer } from "../../src/infrastructure/mail/mailer.js";
import type { BillingProvider } from "../../src/modules/billing/providers/types.js";
import type { PlayConfig } from "../../src/modules/billing/config.js";
import type { PushDeps } from "../../src/modules/notifications/service.js";
import { type ContractCheck, contractCheck } from "./contracts.js";
import { GriipClient } from "./griipClient.js";
import { dropTestDatabase, testMongoEnv } from "./mongo.js";

export interface Harness extends BuiltApp {
  baseUrl: string;
  dir: string;
  close: () => Promise<void>;
  client: (username: string, displayName?: string) => Promise<GriipClient>;
  /** What this server registered and answered, checked against the contracts (test/support/contracts.ts). */
  contracts: ContractCheck;
}

let counter = 0;

/**
 * [push]: replaces DNS and the network for push wake-ups (test/push_wakeup.test.ts). [mailer]: receives account emails
 * (test/support/accounts.ts MemoryMailer); without one, MAIL_TRANSPORT decides (none by default). [billingProvider]:
 * replaces the configured billing provider (a Stripe adapter talking to a fake API, or a test store adapter). [play]:
 * Google Play's settings, with a fake Developer API.
 */
export async function startServer(
  env: Record<string, string> = {},
  opts: { push?: PushDeps; mailer?: Mailer; billingProvider?: BillingProvider; play?: PlayConfig } = {},
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griip-test-"));
  const config = loadConfig({
    DATA_DIR: dir,
    LOG_LEVEL: "silent",
    LIVEKIT_API_KEY: "devkey",
    LIVEKIT_API_SECRET: "test-secret-that-is-at-least-32-characters-long",
    LIVEKIT_PUBLIC_URL: "ws://127.0.0.1:1", // unreachable on purpose: tests don't need a media server
    RATE_LIMIT_PER_MINUTE: "100000",
    // Most suites create many users; the invite gate has its own suite (registration_quotas.test.ts).
    REGISTRATION_MODE: "open",
    // Every test user registers from 127.0.0.1: the abuse limits have their own suite (abuse_controls.test.ts).
    REGISTRATION_PER_ADDRESS_PER_HOUR: "0",
    REGISTRATION_PER_ADDRESS_PER_DAY: "0",
    REGISTRATION_OPEN_PER_DAY: "0",
    NEW_ACCOUNT_LIMIT_DAYS: "0",
    // Password hashing at the lowest cost the server accepts, so account tests stay fast (production refuses it).
    PASSWORD_SCRYPT_LOG_N: "10",
    // Account suites make many sign-ins from 127.0.0.1; the per-network limit itself is tested on its own.
    AUTH_RATE_LIMIT_PER_MINUTE: "10000",
    ACCOUNT_EMAILS_PER_NETWORK_PER_HOUR: "10000",
    // Presence changes at once in tests; the settle and grace delays have their own suite (presence_stability.test.ts).
    PRESENCE_SETTLE_MS: "0",
    PRESENCE_GRACE_MS: "0",
    // The older suites send end-to-end encrypted envelopes (POST /v1/messages); server_messages.test.ts turns that off.
    MESSAGES_ACCEPT_ENCRYPTED: "true",
    // MELDIQ_TEST_MONGO_DOMAINS=accounts,preferences runs every suite with those domains in MongoDB (docs/MONGODB.md).
    ...testMongoEnv(env),
    ...env,
  } as NodeJS.ProcessEnv);
  if (opts.billingProvider) config.billing = { ...config.billing, provider: opts.billingProvider, unavailableReason: null };
  // Google Play with a fake Developer API and test signing keys (test/play.test.ts).
  if (opts.play) config.billing = { ...config.billing, play: opts.play };
  const contracts = contractCheck();
  const built = await buildApp(config, { logger: false, push: opts.push, mailer: opts.mailer, contracts: contracts.observer });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = built.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Federated test servers advertise the address they actually listen on (timers aren't started: tests drive them).
  if (built.ctx.config.federation && !built.ctx.config.federation.publicUrl) built.ctx.config.federation.publicUrl = baseUrl;
  const clients: GriipClient[] = [];
  return {
    ...built,
    baseUrl,
    dir,
    contracts,
    client: async (username, displayName) => {
      const c = new GriipClient(baseUrl, `${username}${++counter}`.toLowerCase(), displayName ?? username);
      await c.register();
      clients.push(c);
      return c;
    },
    close: async () => {
      built.ctx.federation?.stop();
      for (const c of clients) await c.disconnect();
      // A test may leave a response unread (an aborted download, a refused upload): its connection would hold close()
      // open until the hook times out, so drop whatever is still connected once closing has started.
      const closing = built.app.close();
      built.app.server.closeAllConnections();
      await closing;
      if (built.ctx.mongo) await dropTestDatabase(built.ctx.config.mongo!);
      built.ctx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      contracts.finish();
    },
  };
}

export async function expectStatus(p: Promise<unknown>, status: number): Promise<any> {
  try {
    await p;
  } catch (e: any) {
    if (e?.status === status) return e.body;
    throw new Error(`expected HTTP ${status}, got ${e?.status ?? e}`);
  }
  throw new Error(`expected HTTP ${status}, got success`);
}

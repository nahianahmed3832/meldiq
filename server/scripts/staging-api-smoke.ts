/** Actual Fastify process against the Frankfurt staging database; synthetic identities, no external providers/jobs. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp, type BuiltApp } from "../src/app/server.js";
import { loadConfig } from "../src/app/config.js";
import { MeldiqPostgres } from "../src/infrastructure/database/postgres/client.js";
import { AccountClient, MemoryMailer } from "../test/support/accounts.js";

const project = "bkvlxbsnzqkhbifawcww";
const filename = process.argv[2] ?? path.join(os.homedir(), ".local/share/meldiq-supabase/staging-runtime.env");
const reportFile = process.argv[3];
if (!reportFile) throw new Error("Usage: tsx scripts/staging-api-smoke.ts /private/staging-runtime.env /report/path.json");
const stat = fs.lstatSync(filename);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Runtime file must be a private regular file with permissions 600");
const settings = Object.fromEntries(fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
  const at = line.indexOf("=");
  if (at < 1) throw new Error("Invalid private runtime file");
  return [line.slice(0, at), line.slice(at + 1)];
}));
if (settings.SUPABASE_ENVIRONMENT !== "staging" || settings.SUPABASE_EXPECTED_PROJECT_REF !== project) throw new Error("Staging project identity required");
const endpoint = new URL(settings.SUPABASE_DATABASE_URL);
if (endpoint.hostname !== "aws-1-eu-central-1.pooler.supabase.com" || endpoint.port !== "5432" || endpoint.pathname !== "/postgres" || endpoint.search ||
    decodeURIComponent(endpoint.username) !== `meldiq_staging_runtime.${project}`) throw new Error("Smoke requires the restricted staging runtime login");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-staging-api-"));
fs.chmodSync(directory, 0o700);
// Explicit settings deliberately exclude inherited production S3, billing, mail, push and LiveKit configuration.
const config = loadConfig({APP_ENV: "staging", DATA_DIR: directory, LOG_LEVEL: "silent", HOST: "127.0.0.1", PORT: "0",
  REGISTRATION_MODE: "open", REGISTRATION_PER_ADDRESS_PER_HOUR: "0", REGISTRATION_PER_ADDRESS_PER_DAY: "0", REGISTRATION_OPEN_PER_DAY: "0",
  NEW_ACCOUNT_LIMIT_DAYS: "0", PASSWORD_SCRYPT_LOG_N: "10", AUTH_RATE_LIMIT_PER_MINUTE: "1000", RATE_LIMIT_PER_MINUTE: "1000",
  PRESENCE_SETTLE_MS: "0", PRESENCE_GRACE_MS: "0", TELEMETRY_TICK_MS: "0", REMINDER_TICK_MS: "0", WORKFLOW_TICK_MS: "0"});
const db = new MeldiqPostgres({url: endpoint.href, environment: "staging", projectRef: project, maxConnections: 3,
  ca: fs.readFileSync(settings.SUPABASE_DB_CA_FILE, "utf8")});
const mailer = new MemoryMailer();
let built: BuiltApp | undefined;
const report: {observedAt: string; projectRef: string; synthetic: boolean; productionChanged: boolean; checks: Record<string, boolean>;
  phase: string; ok?: boolean; startupMs?: number; restartMs?: number; legacySqlAttempts?: number; errorCode?: string; httpStatus?: number} = {
  observedAt: new Date().toISOString(), projectRef: project, synthetic: true, productionChanged: false, checks: {}, phase: "startup"};
const requireCheck = (condition: unknown) => {if (!condition) throw new Error("Staging API acceptance check failed");};
async function start() {
  const started = performance.now();
  built = await buildApp(config, {postgres: db, logger: false, mailer});
  await built.app.listen({host: "127.0.0.1", port: 0});
  const address = built.app.server.address();
  if (!address || typeof address !== "object") throw new Error("Loopback listener did not start");
  return {url: `http://127.0.0.1:${address.port}`, duration: Math.round(performance.now() - started)};
}
async function stop() {
  if (!built) return;
  const current = built;
  built = undefined;
  const closing = current.app.close();
  current.app.server.closeAllConnections();
  try {await closing;} finally {current.ctx.db.close();}
}
try {
  const initial = await start();
  report.startupMs = initial.duration;
  requireCheck(!built!.ctx.mongo && built!.ctx.accounts.store.backend === "postgres" && built!.ctx.messages.backend === "postgres");
  report.checks.postgresOnlyRestrictedRuntime = true;
  requireCheck((await fetch(`${initial.url}/healthz`)).ok);
  report.checks.health = true;
  report.phase = "accounts";
  const run = crypto.randomBytes(5).toString("hex");
  const people: AccountClient[] = [];
  for (let n = 0; n < 2; n++) {
    const person = new AccountClient(initial.url, `api-${run}-${n}@example.invalid`, crypto.randomBytes(30).toString("base64url"), "Synthetic staging API");
    await person.signUp(mailer);
    await person.signIn();
    await person.setUpIdentity(`pgsmoke${run}${n}`);
    people.push(person);
  }
  report.checks.accountVerificationLoginDeviceBinding = true;
  report.phase = "messages";
  const [alice, bob] = people;
  const conversation = (await alice.req("POST", "/v1/conversations/dm", {userId: bob.userId})).conversation.id;
  const messageId = crypto.randomBytes(12).toString("base64url");
  const body = {conversationId: conversation, messageId, cls: "message", sentAt: Date.now(), payload: {type: "text", text: "Synthetic hosted API acceptance"}};
  const first = await alice.req("POST", "/v2/messages", body);
  const retry = await alice.req("POST", "/v2/messages", body);
  requireCheck(!first.duplicate && retry.duplicate);
  requireCheck((await bob.req("GET", `/v2/conversations/${conversation}/messages`)).messages.some((item: {id: string}) => item.id === messageId));
  requireCheck((await db.query("SELECT 1 FROM meldiq_private.outbox WHERE payload->>'messageId'=$1", [messageId])).rowCount);
  report.checks.messageHistoryIdempotencyAndOutbox = true;
  report.phase = "preferences";
  await alice.req("PUT", "/v1/me/preferences/personal", {baseRev: 0, prefs: {starred: [conversation]}});
  requireCheck((await bob.req("GET", "/v1/me/preferences/personal")).rev === 0);
  report.checks.preferenceOwnership = true;
  requireCheck((await fetch(`${initial.url}/v2/conversations/${conversation}/messages`)).status === 401);
  report.checks.anonymousHistoryDenied = true;
  report.legacySqlAttempts = built!.ctx.postgres!.legacySqlAttempts;
  requireCheck(report.legacySqlAttempts === 0);
  report.phase = "restart";
  await stop();
  const restarted = await start();
  report.restartMs = restarted.duration;
  for (const person of people) person.baseUrl = restarted.url;
  await alice.refresh();
  requireCheck((await alice.req("GET", "/v1/me/preferences/personal")).prefs.starred.includes(conversation));
  requireCheck((await bob.req("GET", `/v2/conversations/${conversation}/messages`)).messages.some((item: {id: string}) => item.id === messageId));
  report.checks.restartDurabilityAndRefresh = true;
  report.phase = "logout";
  for (const person of people) await person.req("POST", "/v2/auth/logout");
  requireCheck((await fetch(`${restarted.url}/v2/conversations/${conversation}/messages`, {headers: {authorization: `Bearer ${bob.token}`}})).status === 401);
  report.checks.logoutRevocation = true;
  report.legacySqlAttempts += built!.ctx.postgres!.legacySqlAttempts;
  requireCheck(report.legacySqlAttempts === 0);
  report.phase = "complete";
  report.ok = true;
} catch (error) {
  report.ok = false;
  const failure = error as {code?: string; status?: number};
  report.errorCode = /^[A-Z0-9_]{5,40}$/.test(failure.code ?? "") ? failure.code : "operation_failed";
  if (Number.isInteger(failure.status)) report.httpStatus = failure.status;
  process.exitCode = 1;
} finally {
  try {await stop();} catch {report.ok = false; report.errorCode = "shutdown_failed"; process.exitCode = 1;}
  await db.close();
  fs.rmSync(directory, {recursive: true, force: true});
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}

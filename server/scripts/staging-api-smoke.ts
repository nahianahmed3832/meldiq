/** Actual Fastify/PostgreSQL/Auth staging process; synthetic identities, other external providers/jobs disabled. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import { buildApp, type BuiltApp } from "../src/app/server.js";
import { loadConfig } from "../src/app/config.js";
import { MeldiqPostgres } from "../src/infrastructure/database/postgres/client.js";
import { AccountClient, MemoryMailer } from "../test/support/accounts.js";
import {sign} from "../test/support/griipClient.js";
import {supabaseDeviceProof} from "../src/modules/auth/supabaseIdentity.js";
import {PostgresOutbox, type OutboxEvent} from "../src/infrastructure/database/postgres/outbox.js";

const project = "bkvlxbsnzqkhbifawcww";
const filename = process.argv[2] ?? path.join(os.homedir(), ".local/share/meldiq-supabase/staging-runtime.env");
const reportFile = process.argv[3];
if (!reportFile) throw new Error("Usage: tsx scripts/staging-api-smoke.ts /private/staging-runtime.env /report/path.json");
function readSettings(file: string): Record<string, string> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Credential file must be private with permissions 600");
  return Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
    const at = line.indexOf("="); if (at < 1) throw new Error("Invalid private environment format"); return [line.slice(0, at), line.slice(at + 1)];
  }));
}
const settings = readSettings(filename);
if (settings.SUPABASE_ENVIRONMENT !== "staging" || settings.SUPABASE_EXPECTED_PROJECT_REF !== project) throw new Error("Staging project identity required");
const endpoint = new URL(settings.SUPABASE_DATABASE_URL);
if (endpoint.hostname !== "aws-1-eu-central-1.pooler.supabase.com" || endpoint.port !== "5432" || endpoint.pathname !== "/postgres" || endpoint.search ||
    decodeURIComponent(endpoint.username) !== `meldiq_staging_runtime.${project}`) throw new Error("Smoke requires the restricted staging runtime login");
const authSettings = readSettings(process.argv[4] ?? path.join(os.homedir(), ".local/share/meldiq-supabase/staging.env"));
if (authSettings.SUPABASE_ENVIRONMENT !== "staging" || authSettings.SUPABASE_EXPECTED_PROJECT_REF !== project || !authSettings.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) throw new Error("Staging-only Auth administrator key required for synthetic user creation");
const webRoot = process.env.MELDIQ_SUPABASE_WEB_ROOT ?? path.resolve(process.cwd(), "../../meldiq_web");
const {createClient} = createRequire(path.join(webRoot, "package.json"))("@supabase/supabase-js");
const providerOptions = {auth: {autoRefreshToken: false, persistSession: false, detectSessionInUrl: false}};
const providerUrl = `https://${project}.supabase.co`;
const admin = createClient(providerUrl, authSettings.SUPABASE_SECRET_KEY, providerOptions);
const providerUsers: {id: string; client: any; person: AccountClient}[] = [];
const observers: any[] = [];
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
  phase: string; ok?: boolean; startupMs?: number; restartMs?: number; legacySqlAttempts?: number; errorCode?: string; httpStatus?: number; cleanupFailures?: number;
  realtimeReceiptMs?: number; httpBaseline?: unknown; databaseBaseline?: unknown; realtimeRevocation?: unknown; productionAcceptancePassed: false} = {
  observedAt: new Date().toISOString(), projectRef: project, synthetic: true, productionChanged: false, checks: {}, phase: "startup", productionAcceptancePassed: false};
const requireCheck = (condition: unknown) => {if (!condition) throw new Error("Staging API acceptance check failed");};
function subscribed(channel: any): Promise<string> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve("HARNESS_TIMEOUT"), 20_000);
    channel.subscribe((status: string) => {
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT"].includes(status)) {clearTimeout(timeout); resolve(status);}
    });
  });
}
async function waitForReceipt(seen: Set<string>, messageId: string, milliseconds = 20_000): Promise<boolean> {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (seen.has(messageId)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return seen.has(messageId);
}
/** Claim only this run's exact event, preserving aggregate ordering. Never drain another staging run's work. */
async function publishOwned(conversationId: string, messageId: string) {
  const result = await db.query<OutboxEvent>(`UPDATE meldiq_private.outbox o SET lease_id=$3,lease_until=now()+interval '30 seconds',attempts=attempts+1
    WHERE o.aggregate_id=$1 AND o.payload->>'messageId'=$2 AND o.destination='realtime'
      AND o.delivered_at IS NULL AND o.dead_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<now())
      AND NOT EXISTS(SELECT 1 FROM meldiq_private.outbox older WHERE older.aggregate_id=o.aggregate_id AND older.destination=o.destination
        AND older.sequence<o.sequence AND older.delivered_at IS NULL)
    RETURNING o.*`, [conversationId, messageId, crypto.randomUUID()]);
  requireCheck(result.rows.length === 1);
  requireCheck(await new PostgresOutbox(db).publishRealtime(result.rows[0]));
}
function percentiles(values: number[]) {
  const sorted = values.toSorted((a,b) => a-b);
  const quantile = (p: number) => Number(sorted[Math.max(0, Math.ceil(sorted.length*p)-1)].toFixed(2));
  return {samples: sorted.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95), maxMs: quantile(1)};
}
async function start() {
  const started = performance.now();
  built = await buildApp(config, {postgres: db, supabase: {projectUrl: providerUrl}, logger: false, mailer});
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
async function jwtRequest(person: AccountClient, method: "POST" | "DELETE", route: string, body?: unknown) {
  const response = await fetch(`${person.baseUrl}${route}`, {method, headers: {authorization: `Bearer ${person.token}`, ...(body ? {"content-type": "application/json"} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  if (!response.ok) throw Object.assign(new Error("Hosted Auth/API request failed"), {status: response.status});
  return response.json();
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
    report.phase = "provider-link";
    const created = await admin.auth.admin.createUser({email: person.email, password: person.password, email_confirm: true});
    requireCheck(!created.error && created.data.user);
    const client = createClient(providerUrl, "sb_publishable_DSnteWCwZ3WumfEgQYWGyg_HhOQr5_f", providerOptions);
    providerUsers.push({id: created.data.user.id, client, person});
    const signedIn = await client.auth.signInWithPassword({email: person.email, password: person.password});
    requireCheck(!signedIn.error && signedIn.data.session);
    person.token = signedIn.data.session.access_token;
    const session = await built!.ctx.supabaseAuth!.verifier.verifySession(person.token);
    requireCheck(session);
    const {nonce} = await person.req("POST", "/v1/auth/challenge");
    await jwtRequest(person, "POST", "/v3/auth/legacy-link", {legacyAccessToken: person.accessToken, password: person.password,
      deviceId: person.deviceId, nonce, signature: sign(person.device, supabaseDeviceProof(session!, person.deviceId, nonce))});
    requireCheck((await person.req("GET", "/v3/auth/me")).userId === person.userId);
  }
  report.checks.accountVerificationLoginDeviceBinding = true;
  report.checks.realProviderJwtLegacyOwnershipAndDeviceProof = true;
  report.phase = "messages";
  const [alice, bob] = people;
  const conversation = (await alice.req("POST", "/v1/conversations/dm", {userId: bob.userId})).conversation.id;
  report.phase = "api-realtime-grants";
  const receipts = people.map(() => new Set<string>());
  for (const [i, person] of people.entries()) {
    const granted = await jwtRequest(person, "POST", "/v3/realtime/grants", {conversationId: conversation});
    requireCheck(granted.topics.includes(`conversation:${conversation}`));
    // A separate socket holds its original JWT, as an uncooperative client could after provider logout.
    const observer = createClient(providerUrl, "sb_publishable_DSnteWCwZ3WumfEgQYWGyg_HhOQr5_f", providerOptions);
    observers.push(observer);
    await observer.realtime.setAuth(person.token);
    const channel = observer.channel(`conversation:${conversation}`, {config: {private: true}})
      .on("broadcast", {event: "message.changed"}, ({payload}: {payload: Record<string, unknown>}) => {
        if (payload.conversationId === conversation && typeof payload.messageId === "string" && typeof payload.eventId === "string") receipts[i].add(payload.messageId);
      });
    requireCheck(await subscribed(channel) === "SUBSCRIBED");
    const denied = observer.channel(`user:${people[1-i].userId}`, {config: {private: true}});
    requireCheck(await subscribed(denied) === "CHANNEL_ERROR");
    await observer.removeChannel(denied);
  }
  report.checks.apiIssuedPrivateConversationGrants = true;
  report.checks.foreignPrivateUserTopicsDenied = true;
  report.phase = "messages";
  const messageId = crypto.randomBytes(12).toString("base64url");
  const body = {conversationId: conversation, messageId, cls: "message", sentAt: Date.now(), payload: {type: "text", text: "Synthetic hosted API acceptance"}};
  const first = await alice.req("POST", "/v2/messages", body);
  const retry = await alice.req("POST", "/v2/messages", body);
  requireCheck(!first.duplicate && retry.duplicate);
  requireCheck((await bob.req("GET", `/v2/conversations/${conversation}/messages`)).messages.some((item: {id: string}) => item.id === messageId));
  requireCheck((await db.query("SELECT 1 FROM meldiq_private.outbox WHERE payload->>'messageId'=$1", [messageId])).rowCount);
  report.checks.messageHistoryIdempotencyAndOutbox = true;
  const sentAt = performance.now();
  report.phase = "owned-outbox-publish";
  await publishOwned(conversation, messageId);
  report.phase = "private-broadcast-receipts";
  requireCheck((await Promise.all(receipts.map(seen => waitForReceipt(seen, messageId)))).every(Boolean));
  report.realtimeReceiptMs = Number((performance.now()-sentAt).toFixed(2));
  report.checks.apiMessageCommittedOutboxAndBothPrivateReceipts = true;
  report.phase = "preferences";
  await alice.req("PUT", "/v1/me/preferences/personal", {baseRev: 0, prefs: {starred: [conversation]}});
  requireCheck((await bob.req("GET", "/v1/me/preferences/personal")).rev === 0);
  report.checks.preferenceOwnership = true;
  requireCheck((await fetch(`${initial.url}/v2/conversations/${conversation}/messages`)).status === 401);
  report.checks.anonymousHistoryDenied = true;
  report.phase = "bounded-latency-baseline";
  const httpDurations: number[] = [];
  let httpErrors = 0, peakWaiting = 0;
  await Promise.all(people.map(async person => {
    for (let n=0;n<10;n++) {
      const started = performance.now();
      try {
        const response = await fetch(`${initial.url}/v2/conversations/${conversation}/messages`, {headers: {authorization: `Bearer ${person.token}`}, signal: AbortSignal.timeout(30_000)});
        await response.arrayBuffer();
        if (!response.ok) httpErrors++;
      } catch {httpErrors++;}
      httpDurations.push(performance.now()-started);
      peakWaiting = Math.max(peakWaiting, db.metrics().waiting);
    }
  }));
  report.httpBaseline = {...percentiles(httpDurations), errors: httpErrors, concurrency: 2, origin: "MacBook loopback API to Frankfurt hosted PostgreSQL", peakWaitingSample: peakWaiting,
    poolAfter: db.metrics(), scope: "Small warm history-read baseline, not capacity/load or VPS placement evidence"};
  requireCheck(httpErrors === 0);
  const databaseDurations: number[] = [];
  for (let n=0;n<10;n++) {const started = performance.now(); await db.query("SELECT 1"); databaseDurations.push(performance.now()-started);}
  report.databaseBaseline = {...percentiles(databaseDurations), scope: "MacBook-to-Frankfurt verified-TLS session-pooler round trip, SELECT 1; not server execution time"};
  report.checks.boundedHostedHttpReads = true;
  report.legacySqlAttempts = built!.ctx.postgres!.legacySqlAttempts;
  requireCheck(report.legacySqlAttempts === 0);
  report.phase = "restart";
  await stop();
  const restarted = await start();
  report.restartMs = restarted.duration;
  for (const person of people) person.baseUrl = restarted.url;
  const providerToken = alice.token;
  await alice.refresh();
  alice.token = providerToken;
  for (const user of providerUsers) {
    const refreshed = await user.client.auth.refreshSession();
    requireCheck(!refreshed.error && refreshed.data.session);
    user.person.token = refreshed.data.session.access_token;
    await user.person.req("GET", "/v1/queue");
  }
  report.checks.providerRefreshKeepsCertifiedBinding = true;
  requireCheck((await alice.req("GET", "/v1/me/preferences/personal")).prefs.starred.includes(conversation));
  requireCheck((await bob.req("GET", `/v2/conversations/${conversation}/messages`)).messages.some((item: {id: string}) => item.id === messageId));
  report.checks.restartDurabilityAndRefresh = true;
  report.phase = "logout";
  // Exercise application revocation and provider-only logout independently, with still-unexpired JWTs.
  const bobProvider = providerUsers.find(user => user.person === bob)!;
  requireCheck(!(await bobProvider.client.auth.signOut({scope: "global"})).error);
  requireCheck((await fetch(`${restarted.url}/v2/conversations/${conversation}/messages`, {headers: {authorization: `Bearer ${bob.token}`}})).status === 401);
  report.checks.providerOnlyLogoutRejectsUnexpiredJwt = true;
  report.phase = "already-joined-revocation-probe";
  const revokedProbeId = crypto.randomBytes(12).toString("base64url");
  await alice.req("POST", "/v2/messages", {...body, messageId: revokedProbeId, sentAt: Date.now()});
  await publishOwned(conversation, revokedProbeId);
  requireCheck(await waitForReceipt(receipts[0], revokedProbeId));
  const revokedSocketReceived = await waitForReceipt(receipts[1], revokedProbeId, 5_000);
  report.realtimeRevocation = {providerLogoutApiDenied: true, uncooperativeSocketKeptOriginalJwt: true, authorizedControlReceived: true,
    revokedSocketReceived, observationWindowMs: 5_000, immediateSocketRevocationProven: false,
    status: revokedSocketReceived ? "BLOCKED_cached_channel_receives_after_provider_logout" : "UNPROVEN_no_receipt_during_bounded_window"};
  // Even a negative bounded observation would not prove instantaneous, durable authorization eviction.
  await jwtRequest(alice, "DELETE", "/v3/auth/session");
  requireCheck((await fetch(`${restarted.url}/v1/queue`, {headers: {authorization: `Bearer ${alice.token}`}})).status === 401);
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
  let cleanupFailures = 0;
  for (const observer of observers) {
    try {await observer.removeAllChannels(); observer.realtime.disconnect();} catch {cleanupFailures++;}
  }
  for (const user of providerUsers) {
    try {
      await user.client.auth.signOut({scope: "global"});
      await user.client.removeAllChannels();
      // Retain the owned synthetic record for evidence while making it unusable. Never look up arbitrary users.
      if ((await admin.auth.admin.updateUserById(user.id, {ban_duration: "876000h"})).error) cleanupFailures++;
    } catch {cleanupFailures++;}
  }
  if (cleanupFailures) report.cleanupFailures = cleanupFailures;
  try {await stop();} catch {report.ok = false; report.errorCode = "shutdown_failed"; process.exitCode = 1;}
  await db.close();
  fs.rmSync(directory, {recursive: true, force: true});
  const historyFile = path.join(path.dirname(reportFile), "supabase-hosted-auth-realtime-api-history.json");
  const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, "utf8")) :
    fs.existsSync(reportFile) ? [JSON.parse(fs.readFileSync(reportFile, "utf8"))] : [];
  fs.writeFileSync(historyFile, JSON.stringify([...history, report].slice(-50), null, 2) + "\n");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}

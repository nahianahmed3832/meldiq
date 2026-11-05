import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, request as upstreamRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { startServer, type Harness } from "../test/support/harness.js";
import { MeldiqPostgres } from "../src/infrastructure/database/postgres/client.js";
import { BotEventCursor } from "../src/modules/bots/eventCursor.js";
import { MeldiqBot } from "../sdk/javascript/index.mjs";
import { encryptAttachmentBytes, decryptAttachmentBytes } from "../sdk/javascript/attachments.mjs";

const execute = promisify(execFile);
const [sourceText, targetText, output, predecessorDirectory] = process.argv.slice(2);
const source = new URL(sourceText), target = new URL(targetText);
if (![source, target].every(url => url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && !url.search && !url.hash) ||
    !/^\/meldiq_parity_stage_recovery_source[a-z0-9_]*$/.test(source.pathname) ||
    !/^\/meldiq_parity_stage_rollback_[a-z0-9_]+$/.test(target.pathname) || !path.isAbsolute(output))
  throw new Error("A fresh owned recovery-source stage, new local rollback target and new absolute output directory are required");
await fs.mkdir(output, { mode: 0o700 });
const sourceRuntime = path.join(output, "source-runtime"), restoredRuntime = path.join(output, "restored-runtime");
const database = (url: URL) => new MeldiqPostgres({ url: url.href, environment: "development", maxConnections: 6, deliveryMode: "legacy" });
let db = database(source), harness: Harness | undefined;
let databaseOpen = true;
async function closeDatabase() {
  if (databaseOpen) { databaseOpen = false; await db.close(); }
}
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const env = (dataDir: string, url: URL) => ({ DATA_DIR: dataDir, DATABASE_MODE: "supabase", SUPABASE_DATABASE_URL: url.href, SUPABASE_ENVIRONMENT: "development", MESSAGES_ACCEPT_ENCRYPTED: "false" });
async function files(directory: string, prefix = ""): Promise<{ file: string; bytes: number; sha256: string; mode: number }[]> {
  const result = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const relative = prefix + name, absolute = path.join(directory, name), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("Recovery runtime must not contain symlinks");
    if (stat.isDirectory()) result.push(...await files(absolute, relative + "/"));
    else if (stat.isFile()) result.push({ file: relative, bytes: stat.size, sha256: sha(await fs.readFile(absolute)), mode: stat.mode & 0o777 });
  }
  return result;
}
// An owned test proxy models the required route fence. It does not install or qualify production nginx rules.
async function fencedProxy(origin: string) {
  const destination = new URL(origin);
  assert.equal(destination.hostname, "127.0.0.1");
  let forwarded = 0;
  const blocked = (url: string) => {
    let pathname = new URL(url, origin).pathname;
    for (let attempt = 0; attempt < 4; attempt++) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    return /^\/v2\/(?:bot(?:\/|$)|developer\/bots(?:\/|$)|interactions(?:\/|$))/.test(pathname) || /^\/v1\/orgs\/[^/]+\/bots(?:\/|$)/.test(pathname);
  };
  const proxy = createServer((incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith("/")) { outgoing.writeHead(400).end(); return; }
      if (blocked(incoming.url)) { outgoing.writeHead(503, { "retry-after": "300" }).end(); return; }
      forwarded++;
      const request = upstreamRequest({ hostname: destination.hostname, port: destination.port, path: incoming.url, method: incoming.method,
        headers: { ...incoming.headers, host: destination.host } }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
      });
      request.on("error", () => { outgoing.writeHead(502).end(); }); incoming.pipe(request);
    } catch { outgoing.writeHead(400).end(); }
  });
  proxy.on("upgrade", (incoming, socket) => {
    try {
      if (blocked(incoming.url ?? "/")) socket.end("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 300\r\nConnection: close\r\n\r\n");
      else socket.destroy();
    } catch { socket.destroy(); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address(); assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, forwarded: () => forwarded, close: async () => {
    proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  } };
}
try {
  assert.equal((await db.query("SELECT count(*)::int AS count FROM meldiq.users")).rows[0].count, 0, "Source must be an empty, newly migrated fixture stage");
  harness = await startServer(env(sourceRuntime, source), { postgres: db });
  const owner = await harness.client("recoveryowner"), person = await harness.client("recoverymember");
  owner.serverMessages = person.serverMessages = true;
  const orgId = (await owner.req("POST", "/v1/orgs", { name: "Owned recovery rehearsal" })).org.id;
  const channelId = (await owner.req("GET", `/v1/orgs/${orgId}/channels`)).channels.find((channel: { name: string }) => channel.name === "general").id;
  const memberCode = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
  await person.req("POST", "/v1/invites/accept", { code: memberCode });
  const made = await owner.req("POST", "/v2/developer/bots", { name: "Recovery fixture bot", public: true });
  const botId = made.bot.id, token = made.token;
  await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
  const permissions = ["webhooks.manage", "members.invite", "messages.post", "messages.history", "files.upload", "files.read", "events.read"];
  await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, { permissions: [...permissions, "direct_messages"], rev: 0 });
  await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, { permissions, manifestRev: 1, rev: 0 });
  const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Recovery fixture delegation", permissions: ["webhooks.manage", "members.invite"] })).role.id;
  await owner.req("PUT", `/v1/roles/${role}/members/${botId}`);
  const bot = new MeldiqBot({ apiOrigin: harness.baseUrl, token });
  const hookPath = `/orgs/${orgId}/channels/${channelId}/webhooks`;
  const boundHook = await bot.request("POST", "/v2/bot" + hookPath, { body: { name: "Bot-derived recovery hook" } });
  const humanHook = await owner.req("POST", "/v1" + hookPath, { name: "Human recovery hook" });
  const boundInvite = await bot.request("POST", `/v2/bot/orgs/${orgId}/invites`, { body: { role: "MEMBER" } });
  const humanInvite = await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" });
  const postHook = async (origin: string, hook: typeof boundHook) => fetch(`${origin}/v1/webhooks/${hook.webhook.id}/${hook.token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Synthetic recovery webhook" }),
  });
  assert.equal((await postHook(harness.baseUrl, boundHook)).status, 200);
  const dmPath = `/v2/bots/${botId}/direct-messages`;
  const review = await person.req("GET", dmPath);
  const consent = await person.req("PUT", dmPath, { enabled: true, rev: review.rev, manifestRev: review.manifestRev, noticeVersion: review.noticeVersion });
  await bot.sendDirect(person.userId, "Synthetic message before consent withdrawal");
  await person.req("PUT", dmPath, { enabled: false, rev: consent.rev, manifestRev: review.manifestRev, noticeVersion: review.noticeVersion });
  const plain = Buffer.from("Owned encrypted attachment survives an actual encrypted backup and independent restore.\n".repeat(128));
  const encrypted = encryptAttachmentBytes(plain, { name: "recovery-fixture.txt", mime: "text/plain" });
  const uploaded = await bot.uploadAttachment(channelId, encrypted.bytes);
  const reference = { ...encrypted.reference, id: uploaded.id };
  await bot.send(channelId, "Synthetic recovery attachment", { attachments: [reference] });
  const fileResponse = await fetch(`${harness.baseUrl}/v1/attachments/${uploaded.id}`, { headers: { authorization: `Bearer ${owner.token}` } });
  assert.equal(fileResponse.status, 200);
  assert.deepEqual(decryptAttachmentBytes(new Uint8Array(await fileResponse.arrayBuffer()), reference), plain);
  await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, { permissions: permissions.filter(value => !["webhooks.manage", "members.invite"].includes(value)), manifestRev: 1, rev: 1 });
  assert.equal((await postHook(harness.baseUrl, boundHook)).status, 404);
  const dm = (await owner.req("POST", "/v1/conversations/dm", { userId: person.userId })).conversation.id;
  await owner.send(dm, { type: "text", text: "Synthetic human message before recovery" });
  const reportText = "Synthetic report evidence retained only in the owned recovery fixture";
  const reported = await owner.send(channelId, { type: "text", text: reportText });
  const report = await person.req("POST", "/v1/reports", { targetUserId: owner.userId, conversationId: channelId, messageId: reported.messageId,
    reason: "harassment", content: { text: reportText, sentAt: 1 } });
  const sealedReport = await harness.ctx.reports.get(report.report.id);
  assert.ok(sealedReport?.content?.startsWith("r1.") && !sealedReport.content.includes(reportText));
  const cursor = (await bot.events()).cursor;
  const cursorPosition = new BotEventCursor(sourceRuntime).open(botId, cursor, Date.now());
  await harness.close(); harness = undefined; await closeDatabase();
  const runtimeBefore = await files(sourceRuntime);
  assert.ok(runtimeBefore.some(file => file.file.includes("attachments/")), "Rehearsal must contain a real stored attachment");
  const backup = path.join(output, "database-backup");
  await execute(process.execPath, ["scripts/rehearse-parity-database.mjs", source.href, target.href, backup], { maxBuffer: 2_000_000 });
  const identity = path.join(backup, "rehearsal.agekey");
  const recipient = (await execute("age-keygen", ["-y", identity])).stdout.trim();
  // Private local fixture size is bounded; no plaintext archive is written to disk.
  const runtimeTar = await execute("tar", ["-czf", "-", "-C", sourceRuntime, "."], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  const { spawn } = await import("node:child_process");
  const archive = path.join(output, "runtime.tar.gz.age");
  await new Promise<void>((resolve, reject) => {
    const process = spawn("age", ["-r", recipient, "-o", archive], { stdio: ["pipe", "ignore", "ignore"] });
    process.once("error", reject); process.once("close", code => code === 0 ? resolve() : reject(new Error("Runtime encryption failed")));
    process.stdin.end(runtimeTar.stdout);
  });
  await fs.chmod(archive, 0o600); await fs.mkdir(restoredRuntime, { mode: 0o700 });
  const decrypted = await execute("age", ["-d", "-i", identity, archive], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    const process = spawn("tar", ["-xzf", "-", "-C", restoredRuntime], { stdio: ["pipe", "ignore", "ignore"] });
    process.once("error", reject); process.once("close", code => code === 0 ? resolve() : reject(new Error("Runtime restore failed")));
    process.stdin.end(decrypted.stdout);
  });
  assert.deepEqual(await files(restoredRuntime), runtimeBefore, "All runtime file bytes and modes must survive restore");
  db = database(target); databaseOpen = true;
  harness = await startServer(env(restoredRuntime, target), { postgres: db });
  owner.baseUrl = person.baseUrl = harness.baseUrl;
  await owner.req("GET", `/v1/orgs/${orgId}`);
  await owner.connect(); await person.connect();
  const messageId = "restored-human-live-message";
  await owner.send(dm, { type: "text", text: "Synthetic human message after recovery" }, "message", messageId);
  await person.waitFor(() => person.received.find(message => message.messageId === messageId), 10_000);
  const restoredFile = await fetch(`${harness.baseUrl}/v1/attachments/${uploaded.id}`, { headers: { authorization: `Bearer ${owner.token}` } });
  assert.equal(restoredFile.status, 200);
  assert.deepEqual(decryptAttachmentBytes(new Uint8Array(await restoredFile.arrayBuffer()), reference), plain);
  assert.equal((await fetch(`${harness.baseUrl}/v2/bot/me`, { headers: { authorization: `Bot ${token}` } })).status, 401);
  assert.equal((await postHook(harness.baseUrl, boundHook)).status, 404);
  assert.equal((await postHook(harness.baseUrl, humanHook)).status, 200);
  await person.req("POST", "/v1/invites/preview", { code: humanInvite.invite.code });
  assert.equal(new BotEventCursor(restoredRuntime).open(botId, cursor, Date.now()), cursorPosition);
  const restoredReports = await owner.req("GET", `/v1/orgs/${orgId}/reports?status=open`);
  assert.equal(restoredReports.reports.find((value: { id: string }) => value.id === report.report.id)?.content?.text, reportText);
  const privateReview = await person.req("GET", dmPath);
  assert.equal(privateReview.enabled, false);
  await owner.disconnect(); await person.disconnect();
  await harness.close(); harness = undefined; await closeDatabase();
  let predecessorSource: Record<string, unknown> | null = null;
  if (predecessorDirectory) {
    assert.ok(path.isAbsolute(predecessorDirectory));
    const identity = JSON.parse(await fs.readFile(path.join(predecessorDirectory, "SOURCE.json"), "utf8"));
    assert.match(identity.commit, /^[a-f0-9]{40}$/); assert.match(identity.archiveSha256, /^[a-f0-9]{64}$/);
    const predecessor = await import(pathToFileURL(path.join(predecessorDirectory, "server/test/support/harness.ts")).href);
    db = database(target); databaseOpen = true;
    harness = await predecessor.startServer(env(restoredRuntime, target), { postgres: db });
    assert.ok(harness); owner.baseUrl = person.baseUrl = harness.baseUrl;
    // The old source has no bot approval boundary. Quarantine must hold even without the proxy.
    await owner.login(); await person.login();
    await owner.req("GET", `/v1/orgs/${orgId}`);
    assert.equal((await fetch(`${harness.baseUrl}/v2/bot/me`, { headers: { authorization: `Bot ${token}` } })).status, 401);
    assert.equal((await postHook(harness.baseUrl, boundHook)).status, 404);
    assert.equal((await postHook(harness.baseUrl, humanHook)).status, 200);
    await person.req("POST", "/v1/invites/preview", { code: humanInvite.invite.code });
    await owner.connect(); await person.connect();
    await owner.send(dm, { type: "text", text: "Synthetic live message through predecessor source" }, "message", "predecessor-human-live");
    await person.waitFor(() => person.received.find(message => message.messageId === "predecessor-human-live"), 10_000);
    const media = await fetch(`${harness.baseUrl}/v1/attachments/${uploaded.id}`, { headers: { authorization: `Bearer ${owner.token}` } });
    assert.equal(media.status, 200); assert.deepEqual(decryptAttachmentBytes(new Uint8Array(await media.arrayBuffer()), reference), plain);
    const proxy = await fencedProxy(harness.baseUrl);
    try {
      const routes = ["/v2/bot/me", "/v2/developer/bots", "/v2/interactions", `/v1/orgs/${orgId}/bots/${botId}/permissions`, "/v2/%62ot/me", "/v2/%2562ot/me"];
      for (const route of routes) {
        const response = await fetch(proxy.origin + route, { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" }, body: "{}" });
        assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "300");
      }
      assert.equal(proxy.forwarded(), 0, "Held requests must not reach the old API");
      assert.equal((await fetch(`${proxy.origin}/v1/orgs/${orgId}`, { headers: { authorization: `Bearer ${owner.token}` } })).status, 200);
      predecessorSource = { commit: identity.commit, archiveSha256: identity.archiveSha256, sourceBootsOnAdditiveSchema: true,
        humanLoginCommunityLiveMessageAndPlaintextDownload: true, botAndDerivedWebhookDeniedWithoutProxy: true, humanIntegrationsPreserved: true,
        heldRouteFamilies: 4, heldHttpCases: routes.length, heldRequestsReachedApi: 0, ordinaryHumanRouteThroughProxy: true,
        dependencies: "current installed local dependencies; not the production container/overlay", proxy: "owned test proxy; production nginx precedence/normalization remain pending" };
    } finally { await proxy.close(); }
    await owner.disconnect(); await person.disconnect();
    await harness.close(); harness = undefined; await closeDatabase();
  }
  const receipt = { recordedAt: new Date().toISOString(), scope: "Owned loopback PostgreSQL and local file-store recovery; current source API, synthetic fixture clients", databaseReceipt: "database-backup/receipt.json", originalRuntimeFiles: runtimeBefore.length,
    runtimeBytesAndModesRestored: true, encryptedDatabaseAndRuntimeArchives: true, syntheticOriginalFileBytes: plain.length, originalFileSha256: sha(plain), originalPlaintextDownloadMatchesAfterRestore: true,
    returningHumanCredentialsAndCommunityAccess: true, liveHumanMessageDeliveredAfterRestore: true, botTokenQuarantined: true, revokedDerivedWebhookDenied: true, humanWebhookPreserved: true, humanInvitePreserved: true, withdrawnPersonalConsentPreserved: true,
    encryptedReportEvidenceReadableAfterRestore: true, opaqueCursorKeyAndContextRestored: true,
    predecessorSource,
    sourceAndRestoredDatabasesRetained: true, privateArchiveKeyNotCommitted: true, productionActions: false,
    remaining: ["exact production predecessor container/overlay with pinned dependencies", "production/provider object-store restore and keys", "role-global recovery on a fresh PostgreSQL cluster", "production proxy route holds and full rollback after writes", "hosted auth/realtime and installed native journeys"] };
  await fs.writeFile(path.join(output, "application-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  await harness?.close(); await closeDatabase();
}

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { endNewAccountLimits, hasNewAccountLimits } from "../src/app/middleware/abuse.js";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { type FakeS3, startFakeS3 } from "./support/fakeS3.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { expireUploadSessions, uploadSessionCount } from "./support/files.js";

// Storage abuse controls (docs/ABUSE_CONTROLS.md): new-account allowances, workspace quotas, history caps, parallel
// and retried uploads. Synthetic accounts and random bytes only; S3 is an in-process fake, so no AWS traffic.

const KiB = 1024;
const MiB = 1024 * KiB;
const HOUR = 3_600_000;
const blob = (n: number) => crypto.randomBytes(n);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("base64");
const upload = (c: GriipClient, conversationId: string, body: Buffer) => c.req("POST", `/v1/attachments?conversationId=${conversationId}`, undefined, body);
const dmOf = async (a: GriipClient, b: GriipClient) => (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id as string;

let tags = 0;
const historyItem = (bytes: number) => ({
  tag: `item${String(++tags).padStart(16, "0")}`,
  conv: "conversation0000tag",
  ts: Date.now(),
  body: blob(bytes).toString("base64"),
});

function advanceClock(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}
afterEach(() => vi.useRealTimers());

describe("new-account limits", () => {
  let h: Harness;
  let veteran: GriipClient, newbie: GriipClient, second: GriipClient, third: GriipClient;
  beforeAll(async () => {
    h = await startServer({
      NEW_ACCOUNT_LIMIT_DAYS: "7",
      NEW_ACCOUNT_DAILY_UPLOAD_BYTES: String(2 * MiB),
      NEW_ACCOUNT_STORED_BYTES: String(3 * MiB),
      NEW_ACCOUNTS_TOTAL_STORED_BYTES: String(4 * MiB),
      NEW_ACCOUNT_HISTORY_BYTES: String(50 * KiB),
      ATTACHMENT_MAX_BYTES: String(1 * MiB),
      ATTACHMENT_USER_DAILY_BYTES: String(10 * MiB),
      ATTACHMENT_USER_STORED_BYTES: String(20 * MiB),
      ATTACHMENT_TOTAL_BYTES: String(50 * MiB),
    });
    veteran = await h.client("veteran");
    // An account from before this change, or one whose limits an administrator ended (admin.js limits-end).
    expect(await endNewAccountLimits(h.ctx.identity, veteran.userId)).toBe(true);
    newbie = await h.client("newbie");
    second = await h.client("second");
    third = await h.client("third");
  });
  afterAll(async () => h.close());

  it("an account made by open registration gets smaller allowances; an established one doesn't", async () => {
    expect(hasNewAccountLimits(h.ctx.identity, newbie.userId)).toBe(true);
    expect(hasNewAccountLimits(h.ctx.identity, veteran.userId)).toBe(false);
    const dm = await dmOf(newbie, veteran);
    await upload(newbie, dm, blob(MiB));
    await upload(newbie, dm, blob(MiB));
    const over = await expectStatus(upload(newbie, dm, blob(MiB)), 429);
    expect(over.error.code).toBe("quota_exceeded");
    // UI-003: it says which allowance this is, what's left today and what lifts it (not just "today's limit").
    expect(over.error.message).toBe(
      "New accounts can upload 2 MB a day for their first 7 days (0 MB left today). An invitation from a member, or an administrator, lifts this limit.",
    );
    for (let i = 0; i < 3; i++) await upload(veteran, dm, blob(MiB));
  });

  it("all new accounts together share one allowance, so more accounts don't mean more storage", async () => {
    // newbie stores 2 MiB of the 4 MiB new accounts may hold together.
    const dm = await dmOf(second, veteran);
    await upload(second, dm, blob(MiB));
    await upload(second, dm, blob(MiB));
    const full = await expectStatus(upload(third, await dmOf(third, veteran), blob(MiB)), 507);
    expect(full.error.code).toBe("storage_full");
    // Established accounts still upload normally.
    await upload(veteran, dm, blob(MiB));
  });

  it("an invitation from an established member ends the limits; one from a new account doesn't", async () => {
    const theirs = (await second.req("POST", "/v1/orgs", { name: "Second's own" })).org.id;
    const selfVouch = (await second.req("POST", `/v1/orgs/${theirs}/invites`, {})).invite.code;
    await third.req("POST", "/v1/invites/accept", { code: selfVouch });
    expect(hasNewAccountLimits(h.ctx.identity, third.userId)).toBe(true);

    const company = (await veteran.req("POST", "/v1/orgs", { name: "Company" })).org.id;
    const code = (await veteran.req("POST", `/v1/orgs/${company}/invites`, {})).invite.code;
    await third.req("POST", "/v1/invites/accept", { code });
    expect(hasNewAccountLimits(h.ctx.identity, third.userId)).toBe(false);
    await upload(third, await dmOf(third, veteran), blob(MiB)); // no longer in the new-account pool
  });

  it("new accounts get a smaller share of message history, and are told so", async () => {
    const fresh = await h.client("historian");
    expect((await fresh.req("GET", "/v1/history/summary")).maxBytes).toBe(50 * KiB);
    await fresh.req("PUT", "/v1/history/items", { items: [historyItem(30 * KiB)] });
    expect((await expectStatus(fresh.req("PUT", "/v1/history/items", { items: [historyItem(30 * KiB)] }), 429)).error.code).toBe("quota_exceeded");
    await veteran.req("PUT", "/v1/history/items", { items: [historyItem(30 * KiB), historyItem(30 * KiB)] });
  });

  it("the limits end by themselves after the configured days", async () => {
    const later = await h.client("patient");
    expect(hasNewAccountLimits(h.ctx.identity, later.userId)).toBe(true);
    advanceClock(7 * 24 * HOUR + 1000);
    expect(hasNewAccountLimits(h.ctx.identity, later.userId)).toBe(false);
  });
});

describe("history storage for the whole server", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ HISTORY_TOTAL_BYTES: String(100 * KiB) });
  });
  afterAll(async () => h.close());

  it("stops growing at the server-wide cap; deleting or replacing items still works", async () => {
    const a = await h.client("hista");
    const b = await h.client("histb");
    const mine = historyItem(60 * KiB);
    await a.req("PUT", "/v1/history/items", { items: [mine] });
    const full = await expectStatus(b.req("PUT", "/v1/history/items", { items: [historyItem(60 * KiB)] }), 507);
    expect(full.error.code).toBe("history_full");
    // a shrinks its item and then deletes it: both free space, so both are accepted, and then b fits.
    await a.req("PUT", "/v1/history/items", { items: [{ ...mine, body: blob(10 * KiB).toString("base64") }] });
    await a.req("PUT", "/v1/history/items", { items: [{ ...mine, body: null }] });
    await b.req("PUT", "/v1/history/items", { items: [historyItem(60 * KiB)] });
  });
});

describe("workspace file quota", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ ATTACHMENT_ORG_STORED_BYTES: String(2 * MiB), ATTACHMENT_MAX_BYTES: String(MiB) });
  });
  afterAll(async () => h.close());

  it("limits the files in one workspace's conversations, whoever uploads them; other conversations are unaffected", async () => {
    const owner = await h.client("owner");
    const member = await h.client("member");
    const org = (await owner.req("POST", "/v1/orgs", { name: "Quota Co" })).org.id;
    const code = (await owner.req("POST", `/v1/orgs/${org}/invites`, {})).invite.code;
    await member.req("POST", "/v1/invites/accept", { code });
    const channel = (await owner.req("POST", `/v1/orgs/${org}/channels`, { name: "files", scope: "ORG", kind: "PUBLIC", memberIds: [member.userId] })).channel.id;
    await upload(owner, channel, blob(MiB));
    await upload(member, channel, blob(MiB));
    const e = await expectStatus(upload(member, channel, blob(MiB)), 429);
    expect(e.error.code).toBe("org_quota_exceeded");
    await upload(member, await dmOf(member, owner), blob(MiB)); // a DM belongs to no workspace
  });
});

describe("upload starts per hour", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ ATTACHMENT_UPLOAD_STARTS_PER_HOUR: "3" });
  });
  afterAll(async () => h.close());

  it("counts every upload started, so endless retries stop; after an hour the person can upload again", async () => {
    const a = await h.client("retrier");
    const b = await h.client("retrierb");
    const dm = await dmOf(a, b);
    await upload(a, dm, blob(1000));
    // An upload cut off half-way still counts as started.
    const cut = http.request(new URL(`/v1/attachments?conversationId=${dm}`, h.baseUrl), {
      method: "POST",
      agent: false,
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/octet-stream", "content-length": "5000" },
    });
    cut.on("error", () => {});
    cut.write(blob(1000));
    // Its spool file exists once the server has admitted it.
    await a.waitFor(() => fs.readdirSync(h.ctx.blobs.spoolDir).some((f) => f.endsWith(".part")));
    cut.destroy();
    await a.waitFor(() => !fs.readdirSync(h.ctx.blobs.spoolDir).some((f) => f.endsWith(".part")));
    await upload(a, dm, blob(1000));
    try {
      await upload(a, dm, blob(1000));
      throw new Error("expected a refusal");
    } catch (e: any) {
      expect(e.status).toBe(429);
      expect(e.body.error.code).toBe("too_many_uploads");
      expect(Number(e.retryAfter)).toBeGreaterThan(0);
    }
    // Other people aren't affected.
    await upload(b, dm, blob(1000));
    advanceClock(HOUR + 1000);
    await upload(a, dm, blob(1000));
  });
});

describe("uploads to S3: size, parallel requests, retries, cleanup and access", () => {
  const creds = { accessKeyId: "AKIDABUSETEST", secretAccessKey: "abuse-controls-test-secret" };
  let s3: FakeS3;
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, eve: GriipClient;
  let dm: string;
  beforeAll(async () => {
    s3 = await startFakeS3("orbit-abuse", "ap-southeast-1", creds);
    h = await startServer({
      STORAGE_BACKEND: "s3",
      S3_BUCKET: "orbit-abuse",
      S3_REGION: "ap-southeast-1",
      S3_ENDPOINT: s3.url,
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: creds.accessKeyId,
      S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
      S3_PART_SIZE: String(5 * MiB),
      S3_MULTIPART_THRESHOLD: String(5 * MiB),
      ATTACHMENT_MAX_BYTES: String(20 * MiB),
      ATTACHMENT_USER_STORED_BYTES: String(13 * MiB),
      DIRECT_UPLOAD_MAX_PENDING_PER_USER: "10",
    });
    alice = await h.client("alice");
    bob = await h.client("bob");
    eve = await h.client("eve");
    dm = await dmOf(alice, bob);
  });
  afterAll(async () => {
    await h.close();
    await s3.close();
  });
  const start = (c: GriipClient, size: number) => c.req("POST", "/v1/attachments/uploads", { conversationId: dm, size, sha256: sha(Buffer.from(`${size}`)) });
  const openUploads = () => uploadSessionCount(h, alice.userId);

  it("refuses files over the size limit on the server, whatever the app announces or sends", async () => {
    expect((await expectStatus(start(alice, 20 * MiB + 1), 413)).error.code).toBe("too_large");
    expect((await expectStatus(upload(alice, dm, blob(20 * MiB + 1)), 413)).error.code).toBe("too_large");
  });

  it("parallel uploads can't pass the quota together while S3 is answering", async () => {
    // 13 MiB allowed: two 6 MiB multipart uploads fit, the other four sent at the same moment must not.
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => start(alice, 6 * MiB)));
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(2);
    expect(refused.every((r) => r.reason.status === 429 && r.reason.body.error.code === "quota_exceeded")).toBe(true);
    expect(await openUploads()).toBe(2);
    expect(ok.every((r) => r.value.mode === "multipart")).toBe(true);
    // Cancelled: their share is free again, and what reached S3 is removed.
    for (const r of ok) await alice.req("DELETE", `/v1/attachments/uploads/${r.value.uploadId}`);
    expect(await openUploads()).toBe(0);
    expect([...s3.uploads.values()].some((u) => ok.some((r) => u.key.endsWith(r.value.uploadId)))).toBe(false);
  });

  it("an upload that fails at S3 holds nothing back, and a retry goes through", async () => {
    s3.failNext(4); // the SDK's own retries included
    const failed = await expectStatus(start(alice, 6 * MiB), 503);
    expect(failed.error.code).toBe("storage_unavailable");
    expect(await openUploads()).toBe(0);
    const retried = await start(alice, 6 * MiB);
    expect(retried.mode).toBe("multipart");
    await alice.req("DELETE", `/v1/attachments/uploads/${retried.uploadId}`);
  });

  it("abandoned multipart uploads are aborted and their parts removed by the retention job", async () => {
    const s = await start(alice, 6 * MiB);
    const part = blob(5 * MiB);
    const [url] = (await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/parts`, { parts: [{ n: 1, size: part.length, sha256: sha(part) }] })).parts;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(url.upload.url, { method: "PUT", headers: url.upload.headers }, (res) => (res.resume(), res.on("end", resolve)));
      req.on("error", reject);
      req.end(part);
    });
    expect([...s3.uploads.values()].some((u) => u.key.endsWith(s.uploadId))).toBe(true);
    await expireUploadSessions(h, [s.uploadId]);
    const r = await runCleanup(h.ctx);
    expect(r.uploadsExpired).toBe(1);
    expect([...s3.uploads.values()].some((u) => u.key.endsWith(s.uploadId))).toBe(false);
    expect(await openUploads()).toBe(0);
  });

  it("nobody outside the conversation can upload to it, download from it, or touch someone's upload", async () => {
    await expectStatus(upload(eve, dm, blob(1000)), 404);
    await expectStatus(eve.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 1000, sha256: sha(blob(1)) }), 404);
    const anon = await fetch(`${h.baseUrl}/v1/attachments?conversationId=${dm}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(blob(10)) });
    expect(anon.status).toBe(401);
    const mine = await start(alice, 1000);
    await expectStatus(eve.req("POST", `/v1/attachments/uploads/${mine.uploadId}/complete`, {}), 404);
    await expectStatus(eve.req("DELETE", `/v1/attachments/uploads/${mine.uploadId}`), 404);
    await alice.req("DELETE", `/v1/attachments/uploads/${mine.uploadId}`);
    const file = await upload(alice, dm, blob(2000));
    await expectStatus(eve.req("GET", `/v1/attachments/${file.id}`), 404);
  });

  it("people who may post keep sending messages and opening their files", async () => {
    await bob.connect();
    const body = blob(4000);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    const put = await fetch(s.upload.url, { method: "PUT", headers: s.upload.headers, body: new Uint8Array(body) });
    expect(put.status).toBe(200);
    const done = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {});
    await alice.send(dm, { text: "here's the file", attachmentId: done.id });
    const got = await bob.waitFor(() => bob.received.find((m) => m.payload.text === "here's the file"));
    const down = Buffer.from(await bob.req("GET", `/v1/attachments/${got.payload.attachmentId}`));
    expect(sha(down)).toBe(sha(body));
  });
});

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { readAll } from "../src/infrastructure/storage/blobstore.js";
import type { S3BlobStore } from "../src/infrastructure/storage/s3.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { mediaDeliveryConfig } from "../src/infrastructure/storage/mediaDelivery.js";
import { expireUploadSessions } from "./support/files.js";

/**
 * Live checks against a real, isolated S3 test bucket (docs/AWS_STORAGE_PLAN.md › 8). Skipped unless
 * ORBIT_LIVE_S3_BUCKET is set; credentials come from the AWS SDK's default chain (e.g. AWS_PROFILE=orbit-s3-test),
 * never from this file. Synthetic data only: random ciphertext and throwaway accounts on a local test server, under a
 * prefix unique to this run, all deleted at the end.
 *
 *   ORBIT_LIVE_S3_BUCKET=griipbuddy-orbit-media-sg-test AWS_PROFILE=orbit-s3-test npx vitest run test/s3_live.test.ts
 */
const BUCKET = process.env.ORBIT_LIVE_S3_BUCKET;
const REGION = process.env.ORBIT_LIVE_S3_REGION ?? "ap-southeast-1";
const run = crypto.randomBytes(6).toString("hex");
const PREFIX = `orbit/livetest-${run}/`;
const MiB = 1024 * 1024;
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("base64");
const hex = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

function send(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  const lib = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const put = (up: { url: string; headers: Record<string, string> }, body: Buffer, headers = up.headers) => send("PUT", up.url, headers, body);

function encrypt(plain: Buffer) {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  return { key, nonce, ct: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]) };
}
function decrypt(ct: Buffer, key: Buffer, nonce: Buffer) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

describe.skipIf(!BUCKET)("real S3 test bucket", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-live-"));
  const env = () => ({
    DATA_DIR: dataDir,
    STORAGE_BACKEND: "s3",
    S3_BUCKET: BUCKET!,
    S3_REGION: REGION,
    S3_PREFIX: PREFIX,
    S3_PART_SIZE: String(5 * MiB),
    S3_MULTIPART_THRESHOLD: String(5 * MiB),
    ATTACHMENT_MAX_BYTES: String(20 * MiB),
  });
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, eve: GriipClient;
  let dm: string;
  const kept: { id: string; ct: Buffer; key: Buffer; nonce: Buffer }[] = [];
  let photoRev = 0;

  beforeAll(async () => {
    h = await startServer(env());
    alice = await h.client("alice");
    bob = await h.client("bob");
    eve = await h.client("eve");
    dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  }, 60_000);

  afterAll(async () => {
    // Remove everything this run stored (the bucket keeps deleted versions for 30 days unless purged by an admin).
    const store = h.ctx.blobs as S3BlobStore;
    for (const kind of ["attachments", "profile-photos"] as const) {
      for await (const o of store.listIds(kind)) await store.delete(kind, o.id);
    }
    await h.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it("the server reaches the bucket with a least-privilege identity (refused outside its prefix, unlike root)", async () => {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const store = h.ctx.blobs as S3BlobStore;
    await store.client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
    const outside = await store.client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "elsewhere/" })).catch((e) => e);
    expect(outside.name).toBe("AccessDenied");
    expect((await alice.req("GET", "/v1/server-info")).features).toContain("direct-upload");
  });

  it("direct upload: ciphertext stored as is (SSE-S3), members download and decrypt, others get nothing", async () => {
    const { ct, key, nonce } = encrypt(crypto.randomBytes(300_000));
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: ct.length, sha256: sha(ct) });
    expect(s.mode).toBe("single");
    expect(s.upload.url).toMatch(new RegExp(`^https://${BUCKET}\\.s3\\.${REGION}\\.amazonaws\\.com/`));
    const r = await put(s.upload, ct);
    expect(r.status).toBe(200);
    expect(r.headers["x-amz-server-side-encryption"]).toBe("AES256");
    const done = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {});
    kept.push({ id: done.id, ct, key, nonce });
    const stored = await (h.ctx.blobs as S3BlobStore).direct.head("attachments", done.id);
    expect(stored).toEqual({ size: ct.length, sha256: sha(ct) });
    const redirect = await fetch(`${h.baseUrl}/v1/attachments/${done.id}`, { headers: { authorization: `Bearer ${bob.token}` }, redirect: "manual" });
    expect(redirect.status).toBe(302);
    const link = redirect.headers.get("location")!;
    expect(link).toContain("X-Amz-Expires=300");
    const got = Buffer.from(await (await fetch(link)).arrayBuffer());
    expect(hex(decrypt(got, key, nonce))).toBe(hex(decrypt(ct, key, nonce)));
    const ranged = await fetch(link, { headers: { range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    await expectStatus(eve.req("GET", `/v1/attachments/${done.id}`), 404);
  }, 60_000);

  it("streams an authorized Frankfurt-style range and HEAD through the private edge implementation", async () => {
    const { deliver } = await import("../../deploy/media-worker/worker.mjs");
    const item = kept[0];
    const cfg = mediaDeliveryConfig({MEDIA_PUBLIC_BASE_URL:"https://media.meldiq.app",MEDIA_GRANT_KEY:"34".repeat(32),MEDIA_EDGE_SECRET:"56".repeat(32)})!;
    const previous = h.ctx.config.storage.delivery;
    h.ctx.config.storage.delivery = cfg;
    try {
      const path = "/v1/attachments/" + item.id;
      const issue = (token: string) => fetch(h.baseUrl + path, {headers:{authorization:"Bearer "+token},redirect:"manual"});
      expect((await issue(eve.token!)).status).toBe(404);
      const member = await issue(bob.token!);
      expect(member.status).toBe(302);
      const url = member.headers.get("location")!;
      const workerEnv = {MEDIA_EDGE_SECRET:cfg.edge,S3_ORIGIN:`https://${BUCKET}.s3.${REGION}.amazonaws.com`,S3_PREFIX:PREFIX};
      const transport = (target: string, options: RequestInit) => fetch(target.startsWith("https://msg.meldiq.app/") ? h.baseUrl + new URL(target).pathname : target,options);
      const response = await deliver(new Request(url,{headers:{range:"bytes=2-7"}}),workerEnv,transport);
      expect(response.status).toBe(206);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(item.ct.subarray(2,8));
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const head = await deliver(new Request(url,{method:"HEAD"}),workerEnv,transport);
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(item.ct.length));
      const conditional = await deliver(new Request(url,{headers:{"if-none-match":head.headers.get("etag")!}}),workerEnv,transport);
      expect(conditional.status).toBe(304);
    } finally { h.ctx.config.storage.delivery=previous; }
  },60_000);

  it("S3 itself refuses other bytes, another size, a missing no-overwrite condition, and overwrites", async () => {
    const body = crypto.randomBytes(20_000);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    expect((await put(s.upload, crypto.randomBytes(20_000))).text).toMatch(/BadDigest|InvalidDigest|XAmzContentChecksumMismatch/);
    expect((await put(s.upload, body.subarray(0, 10_000), { ...s.upload.headers, "content-length": "10000" })).status).toBe(403);
    const { "if-none-match": _n, ...noCondition } = s.upload.headers;
    expect((await put(s.upload, body, noCondition)).status).toBe(403);
    expect((await put(s.upload, body)).status).toBe(200);
    const done = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {});
    // The same URL can't replace it: the same bytes again hit the no-overwrite condition (412); other bytes already
    // fail the signed checksum first (400).
    expect((await put(s.upload, body)).status).toBe(412);
    expect((await put(s.upload, crypto.randomBytes(20_000))).status).toBe(400);
    expect(hex(Buffer.from(await bob.req("GET", `/v1/attachments/${done.id}`)))).toBe(hex(body));
  }, 60_000);

  it("anonymous, plain-HTTP, expired and other-key requests are refused by AWS", async () => {
    const id = kept[0].id;
    const objectUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${PREFIX}attachments/${id}`;
    expect((await send("GET", objectUrl, {})).status).toBe(403);
    expect((await send("GET", objectUrl.replace("https:", "http:"), {})).status).toBe(403);
    const link = (await (h.ctx.blobs as S3BlobStore).presignedGet("attachments", id))!;
    expect((await send("GET", link.replace(id, kept.length > 1 ? kept[1].id : `${id}x`), {})).status).toBe(403);
    const short = await (h.ctx.blobs as S3BlobStore).direct.presignPut("attachments", `a_expired${run}`, 10, sha(Buffer.alloc(10)), 1);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await put(short, Buffer.alloc(10))).status).toBe(403);
  }, 60_000);

  it("large files in checksummed parts: resume, complete, download intact", async () => {
    const { ct, key, nonce } = encrypt(crypto.randomBytes(11 * MiB));
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: ct.length, sha256: sha(ct) });
    expect(s).toMatchObject({ mode: "multipart", partCount: 3 });
    const specs = [0, 1, 2].map((i) => {
      const b = ct.subarray(i * 5 * MiB, Math.min(ct.length, (i + 1) * 5 * MiB));
      return { n: i + 1, size: b.length, sha256: sha(b), body: b };
    });
    const urls = (await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/parts`, { parts: specs.map(({ body: _b, ...p }) => p) })).parts;
    expect((await put(urls[0].upload, specs[0].body)).status).toBe(200);
    expect((await put(urls[2].upload, specs[2].body)).status).toBe(200);
    // "Restart": ask S3 what it has, then send only the missing part.
    const have = (await alice.req("GET", `/v1/attachments/uploads/${s.uploadId}/parts`)).parts;
    expect(have.map((p: { n: number }) => p.n)).toEqual([1, 3]);
    expect((await put(urls[1].upload, specs[1].body)).status).toBe(200);
    const all = (await alice.req("GET", `/v1/attachments/uploads/${s.uploadId}/parts`)).parts;
    const done = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {
      parts: all.map((p: { n: number; etag: string; sha256: string }) => ({ n: p.n, etag: p.etag, sha256: p.sha256 })),
    });
    expect(done.size).toBe(ct.length);
    kept.push({ id: done.id, ct, key, nonce });
    const got = Buffer.from(await bob.req("GET", `/v1/attachments/${done.id}`));
    expect(hex(got)).toBe(hex(ct));
    expect(hex(decrypt(got, key, nonce))).toBe(hex(decrypt(ct, key, nonce)));
  }, 180_000);

  it("abandoned uploads are removed from S3 by the retention job", async () => {
    const body = crypto.randomBytes(5000);
    const single = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    expect((await put(single.upload, body)).status).toBe(200);
    const multi = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 6 * MiB, sha256: sha(Buffer.from("m")) });
    await expireUploadSessions(h, [single.uploadId, multi.uploadId]);
    const r = await runCleanup(h.ctx);
    expect(r.uploadsExpired).toBe(2);
    expect(r.uploadsCleaned).toBe(2);
    expect(await h.ctx.blobs.exists("attachments", single.uploadId)).toBe(false);
  }, 60_000);

  it("profile photos: stored privately in S3, replaced, served by the server only", async () => {
    const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n), Buffer.from([0xff, 0xd9])]);
    const first = await alice.req("PUT", "/v1/users/me/photo", undefined, jpeg(4000));
    const second = jpeg(6000);
    photoRev = (await alice.req("PUT", "/v1/users/me/photo", undefined, second)).photoRev;
    expect(photoRev).toBeGreaterThan(first.photoRev);
    expect(hex(Buffer.from(await bob.req("GET", `/v1/users/${alice.userId}/photo`)))).toBe(hex(second));
    expect(await h.ctx.blobs.exists("profile-photos", `${alice.userId}-${first.photoRev}`)).toBe(false);
    const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${PREFIX}profile-photos/${alice.userId}-${photoRev}`;
    expect((await send("GET", url, {})).status).toBe(403);
  }, 60_000);

  it("the original upload path works on S3 too", async () => {
    const blob = crypto.randomBytes(30_000);
    const up = await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob);
    expect(hex(Buffer.from(await bob.req("GET", `/v1/attachments/${up.id}`)))).toBe(hex(blob));
  }, 60_000);

  it("persistence: after a server restart, files, records and photos are still there", async () => {
    await h.close(); // the data folder stays (it isn't the harness's own)
    h = await startServer(env());
    for (const k of kept) {
      const r = await fetch(`${h.baseUrl}/v1/attachments/${k.id}`, { headers: { authorization: `Bearer ${bob.token}` } });
      expect(r.status).toBe(200);
      const got = Buffer.from(await r.arrayBuffer());
      expect(hex(decrypt(got, k.key, k.nonce))).toBe(hex(decrypt(k.ct, k.key, k.nonce)));
    }
    const photo = await fetch(`${h.baseUrl}/v1/users/${alice.userId}/photo`, { headers: { authorization: `Bearer ${bob.token}` } });
    expect(photo.status).toBe(200);
    const raw = await readAll((await h.ctx.blobs.get("attachments", kept[0].id))!);
    expect(raw.length).toBe(kept[0].ct.length);
  }, 120_000);
});

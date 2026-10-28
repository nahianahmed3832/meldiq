import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { LocalBlobStore, readAll } from "../src/infrastructure/storage/blobstore.js";
import { S3BlobStore } from "../src/infrastructure/storage/s3.js";
import { EMPTY_SHA256, presignUrl, sha256Hex, signHeaders } from "./support/sigv4.js";
import { type FakeS3, startFakeS3 } from "./support/fakeS3.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { attachmentCount, setAttachmentExpiry } from "./support/files.js";

/**
 * The restart test keeps its data across server restarts in DATA_DIR; the test MongoDB database is dropped when a server
 * closes, so file records stay in SQLite there whatever MELDIQ_TEST_MONGO_DOMAINS says (this suite is about the blob
 * store, not the database). Workspace and conversations stay with them (their rows are referenced by file records).
 */
const KEPT_IN_SQLITE = ["files", "workspace", "conversations"];
const filesInSqlite: Record<string, string> = process.env.MELDIQ_TEST_MONGO_DOMAINS
  ? { MONGODB_DOMAINS: process.env.MELDIQ_TEST_MONGO_DOMAINS.split(",").filter((d) => d && !KEPT_IN_SQLITE.includes(d)).join(",") }
  : {};

// AWS's published example credentials (not a real account).
const AWS_EXAMPLE = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

describe("SigV4 signing matches AWS's published S3 examples", () => {
  const date = new Date(Date.UTC(2013, 4, 24));
  it("presigned GET", () => {
    const u = presignUrl({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), region: "us-east-1", credentials: AWS_EXAMPLE, expiresSeconds: 86400, date });
    expect(new URL(u).searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
  it("GET with Range", () => {
    const h = signHeaders({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), region: "us-east-1", credentials: AWS_EXAMPLE, headers: { range: "bytes=0-9" }, payloadHash: EMPTY_SHA256, date });
    expect(h.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
    expect(h.authorization).toMatch(/Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });
  it("PUT with a signed payload", () => {
    const h = signHeaders({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      region: "us-east-1",
      credentials: AWS_EXAMPLE,
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: sha256Hex("Welcome to Amazon S3."),
      date,
    });
    expect(h.authorization).toMatch(/Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
  });
});

describe("disk blob store", () => {
  it("reads whole files and ranges, and every read stream ends after its last byte", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-store-"));
    const store = new LocalBlobStore({ attachments: path.join(dir, "a"), "profile-photos": path.join(dir, "p") });
    const bytes = crypto.randomBytes(3000);
    const f = path.join(dir, "a", "a_x.part");
    fs.writeFileSync(f, bytes);
    await store.putFile("attachments", "a_x", f);
    // Streams with an explicit end finish without an extra end-of-file read (one that occasionally never completed
    // left download responses open, 2026-10-17).
    const whole = await store.get("attachments", "a_x");
    expect((whole as fs.ReadStream).end).toBe(2999);
    expect(await readAll(whole!)).toEqual(bytes);
    expect(await readAll((await store.get("attachments", "a_x", { start: 100, end: 199 }))!)).toEqual(bytes.subarray(100, 200));
    expect(await readAll((await store.get("attachments", "a_x", { start: 2990, end: 99_999 }))!)).toEqual(bytes.subarray(2990));
    expect(await store.get("attachments", "a_missing")).toBeNull();
    const seen = [];
    for await (const o of store.listIds("attachments")) seen.push(o.id);
    expect(seen).toEqual(["a_x"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("S3 blob store (against a local fake S3, never AWS)", () => {
  const creds = { accessKeyId: "AKIDTESTONLY", secretAccessKey: "test-secret-not-real" };
  let s3: FakeS3;
  let store: S3BlobStore;
  let dir: string;
  beforeAll(async () => {
    s3 = await startFakeS3("orbit-test", "eu-central-1", creds);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-spool-"));
    store = new S3BlobStore({
      bucket: "orbit-test",
      region: "eu-central-1",
      endpoint: s3.url,
      forcePathStyle: true,
      prefix: "orbit/",
      credentials: creds,
      sse: "AES256",
      kmsKeyId: null,
      presignedDownloads: true,
      presignTtlSeconds: 300,
      multipartThreshold: 100 * 1024,
      partSize: 64 * 1024,
      spoolDir: dir,
    });
  });
  afterAll(async () => {
    await s3.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const spool = (bytes: Buffer) => {
    const f = path.join(dir, `${crypto.randomUUID()}.part`);
    fs.writeFileSync(f, bytes);
    return f;
  };

  it("stores, reads (whole and ranges), checks and deletes an object, with server-side encryption", async () => {
    const bytes = crypto.randomBytes(5000);
    const f = spool(bytes);
    await store.putFile("attachments", "a_small", f, bytes.length, sha256Hex(bytes));
    expect(fs.existsSync(f)).toBe(false); // the spool file is consumed
    expect(s3.objects.get("orbit/attachments/a_small")?.sse).toBe("AES256");
    expect(await readAll((await store.get("attachments", "a_small"))!)).toEqual(bytes);
    expect(await readAll((await store.get("attachments", "a_small", { start: 10, end: 19 }))!)).toEqual(bytes.subarray(10, 20));
    expect(await store.exists("attachments", "a_small")).toBe(true);
    await store.delete("attachments", "a_small");
    expect(await store.exists("attachments", "a_small")).toBe(false);
    expect(await store.get("attachments", "a_small")).toBeNull();
    await store.delete("attachments", "a_small"); // deleting twice is fine
  });

  it("never replaces an existing object", async () => {
    const bytes = crypto.randomBytes(500);
    await store.putFile("attachments", "a_once", spool(bytes), bytes.length);
    const err = await store.putFile("attachments", "a_once", spool(crypto.randomBytes(500)), 500).catch((e) => e);
    expect(String(err)).toContain("PreconditionFailed");
    expect(s3.objects.get("orbit/attachments/a_once")?.body).toEqual(bytes);
  });

  it("uploads large files in parts and assembles them in order", async () => {
    const bytes = crypto.randomBytes(300 * 1024 + 17);
    await store.putFile("attachments", "a_big", spool(bytes), bytes.length);
    expect(s3.requests.filter((r) => r.query.includes("partNumber")).length).toBe(5);
    expect(s3.objects.get("orbit/attachments/a_big")?.body).toEqual(bytes);
    expect(s3.objects.get("orbit/attachments/a_big")?.sse).toBe("AES256");
  });

  it("retries a temporary S3 failure", async () => {
    const bytes = crypto.randomBytes(1000);
    s3.failNext(2);
    await store.putFile("attachments", "a_retry", spool(bytes), bytes.length, sha256Hex(bytes));
    expect(s3.objects.get("orbit/attachments/a_retry")?.body).toEqual(bytes);
  });

  it("refuses bytes that don't match their declared hash, and never puts credentials in errors", async () => {
    const bytes = crypto.randomBytes(1000);
    const err = await store.putFile("attachments", "a_bad", spool(bytes), bytes.length, sha256Hex(Buffer.from("other"))).catch((e) => e);
    expect(String(err)).toContain("BadDigest");
    expect(String(err)).not.toContain(creds.secretAccessKey);
    expect(String(err)).not.toContain(creds.accessKeyId);
    expect(s3.objects.has("orbit/attachments/a_bad")).toBe(false);
  });

  it("presigned links work for a few minutes and only for that object", async () => {
    const bytes = crypto.randomBytes(2000);
    await store.putFile("attachments", "a_link", spool(bytes), bytes.length);
    const link = (await store.presignedGet("attachments", "a_link"))!;
    expect(new URL(link).searchParams.get("X-Amz-Expires")).toBe("300");
    expect(Buffer.from(await (await fetch(link)).arrayBuffer())).toEqual(bytes);
    const ranged = await fetch(link, { headers: { range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    // Another key under the same signature is refused.
    expect((await fetch(link.replace("a_link", "a_small"))).status).toBe(403);
  });

  it("only accepts plain ids as keys", async () => {
    await expect(store.get("attachments", "../secret")).rejects.toThrow();
    expect(() => store.key("attachments", "a/b")).toThrow();
  });
});

describe("the server on S3 storage", () => {
  const creds = { accessKeyId: "AKIDTESTONLY2", secretAccessKey: "another-test-secret" };
  let s3: FakeS3;
  let h: Harness;
  const env = (fakeUrl: string, presigned: boolean) => ({
    STORAGE_BACKEND: "s3",
    S3_BUCKET: "orbit-server",
    S3_REGION: "ap-southeast-1",
    S3_ENDPOINT: fakeUrl,
    S3_FORCE_PATH_STYLE: "true",
    S3_ACCESS_KEY_ID: creds.accessKeyId,
    S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
    S3_PRESIGNED_DOWNLOADS: presigned ? "true" : "false",
  });
  beforeAll(async () => {
    s3 = await startFakeS3("orbit-server", "ap-southeast-1", creds);
  });
  afterAll(async () => {
    await h?.close();
    await s3.close();
  });

  it("stores attachment ciphertext in S3 under opaque keys, streams it to members only, and deletes it when it expires", async () => {
    h = await startServer(env(s3.url, false));
    const alice = await h.client("alice");
    const bob = await h.client("bob");
    const eve = await h.client("eve");
    const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    const blob = crypto.randomBytes(40_000);
    const up = await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob);
    const key = `orbit/attachments/${up.id}`;
    expect(s3.objects.get(key)?.body).toEqual(blob);
    // Nothing about the conversation, people or file name is in the object key.
    expect([...s3.objects.keys()].join(" ")).not.toContain(dm);
    expect([...s3.objects.keys()].join(" ")).not.toContain(alice.userId);
    expect(Buffer.from(await bob.req("GET", `/v1/attachments/${up.id}`))).toEqual(blob);
    const part = await fetch(`${h.baseUrl}/v1/attachments/${up.id}`, { headers: { authorization: `Bearer ${bob.token}`, range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(blob.subarray(100, 200));
    await expectStatus(eve.req("GET", `/v1/attachments/${up.id}`), 404);
    expect(fs.readdirSync(path.join(h.dir, "upload-spool"))).toEqual([]); // nothing left on the server's disk
    await setAttachmentExpiry(h, [up.id], Date.now() - 1);
    const r = await runCleanup(h.ctx);
    expect(r.attachments).toBe(1);
    expect(r.blobsDeleted).toBe(1);
    expect(s3.objects.has(key)).toBe(false);
    await h.close();
  });

  it("with presigned downloads, a member is redirected to a short-lived link; others still get 404", async () => {
    h = await startServer(env(s3.url, true));
    const alice = await h.client("alice");
    const bob = await h.client("bob");
    const eve = await h.client("eve");
    const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    const blob = crypto.randomBytes(10_000);
    const up = await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob);
    const res = await fetch(`${h.baseUrl}/v1/attachments/${up.id}`, { headers: { authorization: `Bearer ${bob.token}` }, redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc.startsWith(s3.url)).toBe(true);
    expect(loc).not.toContain(creds.secretAccessKey);
    expect(Buffer.from(await (await fetch(loc)).arrayBuffer())).toEqual(blob);
    // Following the redirect (as the app's HTTP client does) gives the bytes too.
    expect(Buffer.from(await bob.req("GET", `/v1/attachments/${up.id}`))).toEqual(blob);
    await expectStatus(eve.req("GET", `/v1/attachments/${up.id}`), 404);
  });

  it("profile photos are stored in S3, replaced without leaving old copies, and removed", async () => {
    const alice = await h.client("alice");
    const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n), Buffer.from([0xff, 0xd9])]);
    const first = jpeg(3000);
    const r1 = await alice.req("PUT", "/v1/users/me/photo", undefined, first);
    expect(s3.objects.get(`orbit/profile-photos/${alice.userId}-${r1.photoRev}`)?.body).toEqual(first);
    expect(Buffer.from(await alice.req("GET", `/v1/users/${alice.userId}/photo`))).toEqual(first);
    const second = jpeg(4000);
    const r2 = await alice.req("PUT", "/v1/users/me/photo", undefined, second);
    expect(r2.photoRev).toBeGreaterThan(r1.photoRev);
    expect(Buffer.from(await alice.req("GET", `/v1/users/${alice.userId}/photo`))).toEqual(second);
    expect([...s3.objects.keys()].filter((k) => k.includes(alice.userId))).toEqual([`orbit/profile-photos/${alice.userId}-${r2.photoRev}`]);
    await alice.req("DELETE", "/v1/users/me/photo");
    expect([...s3.objects.keys()].filter((k) => k.includes(alice.userId))).toEqual([]);
    await expectStatus(alice.req("GET", `/v1/users/${alice.userId}/photo`), 404);
  });

  it("an S3 outage fails the upload cleanly (503) and leaves nothing behind", async () => {
    const alice = await h.client("alice");
    const bob = await h.client("bob");
    const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    s3.failNext(10);
    await expectStatus(alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, crypto.randomBytes(1000)), 503);
    s3.failNext(0);
    expect(await attachmentCount(h, alice.userId)).toBe(0);
    expect(fs.readdirSync(path.join(h.dir, "upload-spool"))).toEqual([]);
  });

  it("refuses to start on S3 without its settings", async () => {
    await expect(startServer({ STORAGE_BACKEND: "s3", S3_BUCKET: "x" })).rejects.toThrow(/S3_REGION/);
    await expect(startServer({ STORAGE_BACKEND: "s3", S3_BUCKET: "x", S3_REGION: "eu-west-1", S3_ACCESS_KEY_ID: "only-half" })).rejects.toThrow(/both S3_ACCESS_KEY_ID/);
    await expect(startServer({ STORAGE_BACKEND: "nfs" })).rejects.toThrow(/STORAGE_BACKEND/);
  });
});

describe("switching between the disk and S3 without moving files (STORAGE_READ_FALLBACK)", () => {
  const creds = { accessKeyId: "AKIDTESTONLY3", secretAccessKey: "switch-test-secret" };
  let s3: FakeS3;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-switch-"));
  const s3env = () => ({
    S3_BUCKET: "orbit-switch",
    S3_REGION: "ap-southeast-1",
    S3_ENDPOINT: s3.url,
    S3_FORCE_PATH_STYLE: "true",
    S3_ACCESS_KEY_ID: creds.accessKeyId,
    S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
  });
  beforeAll(async () => {
    s3 = await startFakeS3("orbit-switch", "ap-southeast-1", creds);
  });
  afterAll(async () => {
    await s3.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("disk files stay readable after moving to S3, and S3 files after a rollback to the disk", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000), Buffer.from([0xff, 0xd9])]);
    // 1. On the disk, as production runs today.
    let h = await startServer({ DATA_DIR: dataDir, ...filesInSqlite });
    const alice = await h.client("alice");
    const bob = await h.client("bob");
    const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    const onDisk = crypto.randomBytes(20_000);
    const diskId = (await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, onDisk)).id;
    await alice.req("PUT", "/v1/users/me/photo", undefined, jpeg);
    await h.close();
    const restart = async (env: Record<string, string>) => {
      h = await startServer({ DATA_DIR: dataDir, ...filesInSqlite, ...env });
      for (const c of [alice, bob]) c.baseUrl = h.baseUrl;
    };

    // 2. Moved to S3, still reading the disk.
    await restart({ STORAGE_BACKEND: "s3", STORAGE_READ_FALLBACK: "local", ...s3env() });
    expect((await alice.req("GET", "/v1/server-info")).features).toContain("direct-upload");
    const old = await fetch(`${h.baseUrl}/v1/attachments/${diskId}`, { headers: { authorization: `Bearer ${bob.token}` }, redirect: "manual" });
    expect(old.status).toBe(200); // streamed from the disk: S3 has no copy to link to
    expect(Buffer.from(await old.arrayBuffer())).toEqual(onDisk);
    const part = await fetch(`${h.baseUrl}/v1/attachments/${diskId}`, { headers: { authorization: `Bearer ${bob.token}`, range: "bytes=10-19" } });
    expect(Buffer.from(await part.arrayBuffer())).toEqual(onDisk.subarray(10, 20));
    expect(Buffer.from(await bob.req("GET", `/v1/users/${alice.userId}/photo`))).toEqual(jpeg);
    const inS3 = crypto.randomBytes(15_000);
    const s3Id = (await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, inS3)).id;
    expect(s3.objects.get(`orbit/attachments/${s3Id}`)?.body).toEqual(inS3);
    expect(fs.existsSync(path.join(dataDir, "attachments", s3Id))).toBe(false);
    const linked = await fetch(`${h.baseUrl}/v1/attachments/${s3Id}`, { headers: { authorization: `Bearer ${bob.token}` }, redirect: "manual" });
    expect(linked.status).toBe(302);
    // Expiry removes a disk file too.
    await setAttachmentExpiry(h, [diskId], Date.now() - 1);
    await runCleanup(h.ctx);
    expect(fs.existsSync(path.join(dataDir, "attachments", diskId))).toBe(false);
    await h.close();

    // 3. Rolled back to the disk, still reading S3.
    await restart({ STORAGE_BACKEND: "local", STORAGE_READ_FALLBACK: "s3", ...s3env() });
    expect((await alice.req("GET", "/v1/server-info")).features).not.toContain("direct-upload");
    expect(Buffer.from(await bob.req("GET", `/v1/attachments/${s3Id}`))).toEqual(inS3);
    const back = crypto.randomBytes(5_000);
    const localId = (await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, back)).id;
    expect(s3.objects.has(`orbit/attachments/${localId}`)).toBe(false);
    expect(Buffer.from(await bob.req("GET", `/v1/attachments/${localId}`))).toEqual(back);
    await expectStatus((await h.client("eve")).req("GET", `/v1/attachments/${s3Id}`), 404);
    await setAttachmentExpiry(h, [s3Id], Date.now() - 1);
    await runCleanup(h.ctx);
    expect(s3.objects.has(`orbit/attachments/${s3Id}`)).toBe(false);
    await h.close();
  });

  it("refuses a fallback that is the same store, or S3 without its settings", async () => {
    await expect(startServer({ STORAGE_READ_FALLBACK: "local" })).rejects.toThrow(/must differ/);
    await expect(startServer({ STORAGE_READ_FALLBACK: "s3" })).rejects.toThrow(/S3_BUCKET/);
    await expect(startServer({ STORAGE_READ_FALLBACK: "disk" })).rejects.toThrow(/STORAGE_READ_FALLBACK/);
  });
});

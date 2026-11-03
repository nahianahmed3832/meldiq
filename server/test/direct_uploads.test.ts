import crypto from "node:crypto";
import http from "node:http";
import { mediaDeliveryConfig } from "../src/infrastructure/storage/mediaDelivery.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import { type FakeS3, startFakeS3 } from "./support/fakeS3.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { expireUploadSessions } from "./support/files.js";

// Direct uploads from the app to S3 (presigned), against an in-process fake S3: no AWS account is used.
const creds = { accessKeyId: "AKIDDIRECTTEST", secretAccessKey: "direct-upload-test-secret" };
const MiB = 1024 * 1024;
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("base64");

/** Sends a presigned request exactly as the app does: the URL, the signed headers, the body, and nothing else. */
function put(up: { url: string; headers: Record<string, string> }, body: Buffer, headers: Record<string, string> = up.headers): Promise<{ status: number; etag?: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(up.url, { method: "PUT", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag as string | undefined, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function uploadSingle(c: GriipClient, conversationId: string, body: Buffer) {
  const s = await c.req("POST", "/v1/attachments/uploads", { conversationId, size: body.length, sha256: sha(body) });
  expect(s.mode).toBe("single");
  expect((await put(s.upload, body)).status).toBe(200);
  return { session: s, done: await c.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {}) };
}

describe("direct uploads to S3", () => {
  let s3: FakeS3;
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, eve: GriipClient;
  let dm: string, other: string;
  beforeAll(async () => {
    s3 = await startFakeS3("orbit-direct", "ap-southeast-1", creds);
    h = await startServer({
      STORAGE_BACKEND: "s3",
      S3_BUCKET: "orbit-direct",
      S3_REGION: "ap-southeast-1",
      S3_ENDPOINT: s3.url,
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: creds.accessKeyId,
      S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
      S3_PART_SIZE: String(5 * MiB),
      S3_MULTIPART_THRESHOLD: String(5 * MiB),
      ATTACHMENT_MAX_BYTES: String(20 * MiB),
      ATTACHMENT_USER_STORED_BYTES: String(40 * MiB),
      DIRECT_UPLOAD_MAX_PENDING_PER_USER: "3",
    });
    alice = await h.client("alice");
    bob = await h.client("bob");
    eve = await h.client("eve");
    dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    other = (await eve.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  });
  afterAll(async () => {
    await h.close();
    await s3.close();
  });

  it("redeems an attachment grant with fresh authorization and denies a revoked session", async () => {
    const member = await h.client("edgemember");
    const conversation = (await member.req("POST", "/v1/conversations/dm", {userId: bob.userId})).conversation.id;
    const {done} = await uploadSingle(member, conversation, Buffer.from("edge-private-ciphertext"));
    const config = mediaDeliveryConfig({MEDIA_PUBLIC_BASE_URL:"https://media.meldiq.app", MEDIA_GRANT_KEY:"11".repeat(32), MEDIA_EDGE_SECRET:"22".repeat(32)})!;
    const previous = h.ctx.config.storage.delivery;
    h.ctx.config.storage.delivery = config;
    try {
      const path = h.baseUrl + "/v1/attachments/" + done.id;
      const issue = (token: string) => fetch(path,{headers:{authorization:"Bearer "+token},redirect:"manual"});
      expect((await issue(eve.token!)).status).toBe(404);
      const grant = await issue(member.token!);
      const location = new URL(grant.headers.get("location")!);
      expect(location.origin).toBe(config.origin);
      const redeem = (edge: string) => fetch(path,{redirect:"manual", headers:{
        "x-meldiq-media-grant":location.searchParams.get("ticket")!, "x-meldiq-edge-key":edge, range:"bytes=0-3"
      }});
      expect((await redeem("00".repeat(32))).status).toBe(404);
      const signed = await redeem(config.edge);
      expect(signed.status).toBe(302);
      expect(signed.headers.get("cache-control")).toBe("private, no-store");
      const range = await fetch(signed.headers.get("location")!,{headers:{range:"bytes=0-3"}});
      expect(range.status).toBe(206);
      expect(await range.text()).toBe("edge");
      await member.req("POST","/v1/auth/logout",{});
      expect((await redeem(config.edge)).status).toBe(404);
    } finally { h.ctx.config.storage.delivery = previous; }
  });

  it("uses the versioned API relay accepted by packaged Windows for new and refreshed upload URLs", async () => {
    const old = h.ctx.config.directUploads.legacyWebProxy;
    h.ctx.config.directUploads.legacyWebProxy = true;
    const signed = "https://orbit-direct.s3.ap-southeast-1.amazonaws.com/orbit/attachments/a_example?X-Amz-Signature=test";
    const signer = vi.spyOn(h.ctx.blobs.direct!, "presignPut").mockResolvedValue({
      method: "PUT", url: signed, headers: {}, expiresAt: Date.now() + 60000,
    });
    const request = (path: string, body: unknown) => fetch(h.baseUrl+path,{method:"POST",headers:{
      authorization:"Bearer "+alice.token,"content-type":"application/json","user-agent":"Meldiq/0.2.0"
    },body:JSON.stringify(body)});
    let id: string | undefined;
    try {
      const start = await (await request("/v1/attachments/uploads",{conversationId:dm,size:7,sha256:sha(Buffer.from("Desktop"))})).json();
      id=start.uploadId;expect(id).toMatch(/^a_/);
      const expected="https://web.meldiq.app/v1/_meldiq-upload/orbit/attachments/a_example?X-Amz-Signature=test";
      expect(start.upload.url).toBe(expected);
      const fresh=await (await request("/v1/attachments/uploads/"+id+"/url",{})).json();
      expect(fresh.upload.url).toBe(expected);
    } finally {
      signer.mockRestore(); h.ctx.config.directUploads.legacyWebProxy=old;
      if(id)await alice.req("DELETE","/v1/attachments/uploads/"+id);
    }
  });

  it("preserves old desktop upload sessions and only publishes after a verified promotion", async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error("copy interrupted")).mockResolvedValue(undefined);
    const transition = {olderDesktop:true,owns:(id:string)=>id.startsWith("a_legacy_"),direct:h.ctx.blobs.direct!,publish};
    Object.defineProperty(h.ctx.blobs,"previousUploads",{value:transition,configurable:true});
    try {
      const bytes = Buffer.from("old desktop encrypted upload");
      const create = await fetch(h.baseUrl+"/v1/attachments/uploads",{method:"POST",headers:{
        authorization:"Bearer "+alice.token,"content-type":"application/json","user-agent":"Meldiq/0.2.0 Chrome/156 Electron/45.2.1"
      },body:JSON.stringify({conversationId:dm,size:bytes.length,sha256:sha(bytes)})});
      expect(create.status).toBe(200);
      const start=await create.json();
      expect(start.uploadId).toMatch(/^a_legacy_/);
      expect((await put(start.upload,bytes)).status).toBe(200);
      await expectStatus(alice.req("POST","/v1/attachments/uploads/"+start.uploadId+"/complete",{}),503);
      expect(await h.ctx.files.attachment(start.uploadId)).toBeNull();
      const attachment=await alice.req("POST","/v1/attachments/uploads/"+start.uploadId+"/complete",{});
      expect(attachment.id).toBe(start.uploadId);
      expect(publish).toHaveBeenLastCalledWith(start.uploadId,bytes.length,sha(bytes));
    } finally {Object.defineProperty(h.ctx.blobs,"previousUploads",{value:undefined,configurable:true});}
  });
  it("server-info offers direct uploads", async () => {
    expect((await alice.req("GET", "/v1/server-info")).features).toContain("direct-upload");
  });

  it("encrypted on the phone, stored as is, downloaded by members only, and decrypts (AES-256-GCM, like the app)", async () => {
    const plain = crypto.randomBytes(200_000);
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const { session, done } = await uploadSingle(alice, dm, ct);
    expect(done).toMatchObject({ id: session.uploadId, size: ct.length });
    expect(s3.objects.get(`orbit/attachments/${done.id}`)?.body).toEqual(ct); // only ciphertext reached S3
    expect(s3.objects.get(`orbit/attachments/${done.id}`)?.sse).toBe("AES256");
    // The member is redirected to a short-lived link; following it gives the same ciphertext, which decrypts.
    const r = await fetch(`${h.baseUrl}/v1/attachments/${done.id}`, { headers: { authorization: `Bearer ${bob.token}` }, redirect: "manual" });
    expect(r.status).toBe(302);
    const got = Buffer.from(await (await fetch(r.headers.get("location")!)).arrayBuffer());
    const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    d.setAuthTag(got.subarray(got.length - 16));
    expect(Buffer.concat([d.update(got.subarray(0, got.length - 16)), d.final()])).toEqual(plain);
    // Outsiders get the same 404 as for nothing at all, and no link.
    await expectStatus(eve.req("GET", `/v1/attachments/${done.id}`), 404);
    const eveRaw = await fetch(`${h.baseUrl}/v1/attachments/${done.id}`, { headers: { authorization: `Bearer ${eve.token}` }, redirect: "manual" });
    expect(eveRaw.status).toBe(404);
    expect(eveRaw.headers.get("location")).toBeNull();
    // Completing again answers the same (a retry after a lost answer).
    expect(await alice.req("POST", `/v1/attachments/uploads/${done.id}/complete`, {})).toEqual(done);
  });

  it("only members who may post get an upload; nobody else can see or finish someone's upload", async () => {
    const body = crypto.randomBytes(1000);
    await expectStatus(eve.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 1000, sha256: sha(body) }), 404);
    await expectStatus(fetch(`${h.baseUrl}/v1/attachments/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => {
      if (!r.ok) throw Object.assign(new Error(), { status: r.status });
    }), 401);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 1000, sha256: sha(body) });
    for (const c of [bob, eve]) {
      await expectStatus(c.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {}), 404);
      await expectStatus(c.req("POST", `/v1/attachments/uploads/${s.uploadId}/url`, {}), 404);
      await expectStatus(c.req("DELETE", `/v1/attachments/uploads/${s.uploadId}`), 404);
    }
    await alice.req("DELETE", `/v1/attachments/uploads/${s.uploadId}`);
  });

  it("a presigned upload accepts exactly the announced bytes, once", async () => {
    const body = crypto.randomBytes(4000);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    // Different bytes of the same size: S3 refuses the checksum. A different size: the signature no longer matches.
    expect((await put(s.upload, crypto.randomBytes(4000))).text).toContain("BadDigest");
    expect((await put(s.upload, body.subarray(0, 3000), { ...s.upload.headers, "content-length": "3000" })).text).toContain("SignatureDoesNotMatch");
    // Without the no-overwrite condition the signature fails too.
    const { "if-none-match": _drop, ...rest } = s.upload.headers;
    expect((await put(s.upload, body, rest)).text).toContain("SignatureDoesNotMatch");
    // Nothing stored yet: completing says so, and the app can still send it.
    const early = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {}).catch((e) => e);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_uploaded");
    expect((await put(s.upload, body)).status).toBe(200);
    const done = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {});
    // The same URL can't replace the stored file.
    expect((await put(s.upload, body)).status).toBe(412);
    expect(s3.objects.get(`orbit/attachments/${done.id}`)?.body).toEqual(body);
  });

  it("refuses files over the limit, over the quota, and too many open uploads", async () => {
    const big = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 21 * MiB, sha256: sha(Buffer.from("x")) }).catch((e) => e);
    expect(big.status).toBe(413);
    // Open uploads reserve their size: 3 × 15 MiB reserved is over the 40 MiB stored quota.
    const open: string[] = [];
    for (let i = 0; i < 2; i++) open.push((await bob.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 15 * MiB, sha256: sha(Buffer.from(`b${i}`)) })).uploadId);
    const quota = await bob.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 15 * MiB, sha256: sha(Buffer.from("b3")) }).catch((e) => e);
    expect(quota.status).toBe(429);
    expect(quota.body.error.code).toBe("quota_exceeded");
    open.push((await bob.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 1000, sha256: sha(Buffer.from("small")) })).uploadId);
    const many = await bob.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 1000, sha256: sha(Buffer.from("more")) }).catch((e) => e);
    expect(many.status).toBe(429);
    expect(many.body.error.code).toBe("too_many_uploads");
    for (const id of open) await bob.req("DELETE", `/v1/attachments/uploads/${id}`);
    expect(s3.uploads.size).toBe(0); // the multipart uploads were aborted
  });

  it("large files go in parts: interrupted parts are sent again, the upload resumes from what S3 has, and completes", async () => {
    const body = crypto.randomBytes(11 * MiB + 123);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    expect(s).toMatchObject({ mode: "multipart", partSize: 5 * MiB, partCount: 3 });
    const parts = [0, 1, 2].map((i) => {
      const b = body.subarray(i * 5 * MiB, Math.min(body.length, (i + 1) * 5 * MiB));
      return { n: i + 1, size: b.length, sha256: sha(b), body: b };
    });
    // A part of the wrong size can't be requested.
    await expectStatus(alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/parts`, { parts: [{ n: 1, size: 1000, sha256: parts[0].sha256 }] }), 400);
    const urls = (await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/parts`, { parts: parts.map(({ body: _b, ...p }) => p) })).parts;
    expect((await put(urls[0].upload, parts[0].body)).status).toBe(200);
    // The connection drops in the middle of part 2: the app sends it again.
    s3.dropNext(1);
    await expect(put(urls[1].upload, parts[1].body)).rejects.toThrow();
    expect((await put(urls[1].upload, parts[1].body)).status).toBe(200);
    // Completing before part 3 is there is refused (the app finds out what's missing and resumes).
    const have = (await alice.req("GET", `/v1/attachments/uploads/${s.uploadId}/parts`)).parts;
    expect(have.map((p: { n: number }) => p.n)).toEqual([1, 2]);
    const early = await alice
      .req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, { parts: [...have.map((p: { n: number; etag: string; sha256: string }) => ({ n: p.n, etag: p.etag, sha256: p.sha256 })), { n: 3, etag: '"x"', sha256: parts[2].sha256 }] })
      .catch((e) => e);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("upload_incomplete");
    const p3 = await put(urls[2].upload, parts[2].body);
    const all = (await alice.req("GET", `/v1/attachments/uploads/${s.uploadId}/parts`)).parts;
    expect(all.find((p: { n: number }) => p.n === 3).etag).toBe(p3.etag);
    const done = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, { parts: all.map((p: { n: number; etag: string; sha256: string }) => ({ n: p.n, etag: p.etag, sha256: p.sha256 })) });
    expect(done.size).toBe(body.length);
    // Compared by hash: a failing comparison of two 11 MB buffers makes the test runner run out of memory.
    expect(sha(s3.objects.get(`orbit/attachments/${done.id}`)!.body)).toBe(sha(body));
    expect(sha(Buffer.from(await bob.req("GET", `/v1/attachments/${done.id}`)))).toBe(sha(body));
  });

  it("recovers multipart completion after S3 commits but the metadata write fails", async () => {
    const body = crypto.randomBytes(6 * MiB + 21);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    const specs = [0, 1].map((i) => {
      const b = body.subarray(i * s.partSize, (i + 1) * s.partSize);
      return { n: i + 1, size: b.length, sha256: sha(b), body: b };
    });
    const { parts: signed } = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/parts`, { parts: specs.map(({ body: _, ...p }) => p) });
    for (let i = 0; i < specs.length; i++) expect((await put(signed[i].upload, specs[i].body)).status).toBe(200);
    const { parts } = await alice.req("GET", `/v1/attachments/uploads/${s.uploadId}/parts`);
    const fail = vi.spyOn(h.ctx.files, "completeUpload").mockRejectedValueOnce(new Error("synthetic metadata interruption"));
    try {
      await expectStatus(alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, { parts }), 500);
      expect(s3.objects.has(`orbit/attachments/${s.uploadId}`)).toBe(true);
      expect((await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, { parts })).id).toBe(s.uploadId);
      expect(sha(s3.objects.get(`orbit/attachments/${s.uploadId}`)!.body)).toBe(sha(body));
    } finally { fail.mockRestore(); }
  });

  it("rechecks posting permission and entitlements before renewing or completing an upload", async () => {
    const body = crypto.randomBytes(3000);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    await put(s.upload, body);
    const permission = vi.spyOn(h.ctx.authz, "canPost").mockReturnValue(false);
    try {
      await expectStatus(alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {}), 403);
      expect(await h.ctx.files.attachment(s.uploadId)).toBeNull();
    } finally { permission.mockRestore(); }
    const next = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    const entitlement = vi.spyOn(h.ctx.mojo, "uploadBytes").mockReturnValue(1000);
    try {
      await expectStatus(alice.req("POST", `/v1/attachments/uploads/${next.uploadId}/url`, {}), 413);
      expect(await h.ctx.files.upload(next.uploadId)).not.toBeNull();
      await alice.req("DELETE", `/v1/attachments/uploads/${next.uploadId}`);
    } finally { entitlement.mockRestore(); }
    await runCleanup(h.ctx);
  });

  it("abandoned uploads expire and their objects and parts are removed; nothing recorded is touched", async () => {
    const body = crypto.randomBytes(2000);
    const single = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    await put(single.upload, body); // sent, never completed
    const multi = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 6 * MiB, sha256: sha(Buffer.from("m")) });
    const kept = (await uploadSingle(alice, dm, crypto.randomBytes(1000))).done;
    await expireUploadSessions(h, [single.uploadId, multi.uploadId]);
    await expectStatus(alice.req("POST", `/v1/attachments/uploads/${single.uploadId}/complete`, {}), 410);
    const r = await runCleanup(h.ctx);
    expect(r.uploadsExpired).toBe(2);
    expect(r.uploadsCleaned).toBe(2);
    expect(s3.objects.has(`orbit/attachments/${single.uploadId}`)).toBe(false);
    expect([...s3.uploads.values()].some((u) => u.key.endsWith(multi.uploadId))).toBe(false);
    expect(s3.objects.has(`orbit/attachments/${kept.id}`)).toBe(true);
  });

  it("someone removed from the conversation while uploading can't finish; their object is removed", async () => {
    const group = (await alice.req("POST", "/v1/conversations/group", { name: "Upload test", memberIds: [bob.userId] })).conversation.id;
    const body = crypto.randomBytes(3000);
    const s = await bob.req("POST", "/v1/attachments/uploads", { conversationId: group, size: body.length, sha256: sha(body) });
    await put(s.upload, body);
    await alice.req("DELETE", `/v1/conversations/${group}/members/${bob.userId}`);
    await expectStatus(bob.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {}), 403);
    await runCleanup(h.ctx);
    expect(s3.objects.has(`orbit/attachments/${s.uploadId}`)).toBe(false);
  });

  it("when S3 is unavailable the server says so (503), keeps the upload open, and completes once S3 is back", async () => {
    const body = crypto.randomBytes(5000);
    s3.failNext(20);
    const down = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 6 * MiB, sha256: sha(body) }).catch((e) => e);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("storage_unavailable");
    s3.failNext(0);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    await put(s.upload, body);
    s3.failNext(20);
    const mid = await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {}).catch((e) => e);
    expect(mid.status).toBe(503);
    s3.failNext(0);
    expect((await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {})).id).toBe(s.uploadId);
    // The old upload path still works on S3 (apps from before direct uploads).
    const legacy = await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, crypto.randomBytes(800));
    expect(s3.objects.has(`orbit/attachments/${legacy.id}`)).toBe(true);
    // Nothing secret in what the server returned or logged: presigned URLs are only in the upload answers.
    expect(JSON.stringify(down.body)).not.toContain(creds.accessKeyId);
  });

  it("a fresh URL can be issued for a single upload that wasn't started in time", async () => {
    const body = crypto.randomBytes(1500);
    const s = await alice.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: body.length, sha256: sha(body) });
    const again = (await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/url`, {})).upload;
    expect(again.expiresAt).toBeGreaterThanOrEqual(s.upload.expiresAt);
    expect((await put(again, body)).status).toBe(200);
    expect((await alice.req("POST", `/v1/attachments/uploads/${s.uploadId}/complete`, {})).size).toBe(1500);
    void other;
  });
});

describe("direct uploads on a server that stores files on its disk", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer();
  });
  afterAll(async () => h.close());

  it("aren't offered, and the existing upload path is unchanged", async () => {
    const a = await h.client("alice");
    const b = await h.client("bob");
    const dm = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
    expect((await a.req("GET", "/v1/server-info")).features).not.toContain("direct-upload");
    const r = await a.req("POST", "/v1/attachments/uploads", { conversationId: dm, size: 10, sha256: sha(Buffer.from("x")) }).catch((e) => e);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("direct_upload_unavailable");
    const blob = crypto.randomBytes(1000);
    const up = await a.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob);
    expect(Buffer.from(await b.req("GET", `/v1/attachments/${up.id}`))).toEqual(blob);
  });
});

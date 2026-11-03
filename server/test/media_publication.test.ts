import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type Harness, expectStatus } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { KEPT_FOREVER } from "../src/modules/files/store.js";
import { runCleanup } from "../src/modules/administration/jobs.js";

function encrypted(name = "original.png") {
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), plain = crypto.randomBytes(300);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const bytes = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { bytes, ref: { name, size: plain.length, mime: "image/png", key: key.toString("base64"), nonce: nonce.toString("base64"), sha256: crypto.createHash("sha256").update(bytes).digest("base64") } };
}
describe("publishing completed attachments", () => {
  let h: Harness, alice: GriipClient, bob: GriipClient, other: GriipClient, dm: string, elsewhere: string;
  beforeAll(async () => {
    h = await startServer({ MESSAGES_ACCEPT_ENCRYPTED: "false" });
    alice = await h.client("publishalice"); bob = await h.client("publishbob"); other = await h.client("publishother");
    dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    elsewhere = (await alice.req("POST", "/v1/conversations/dm", { userId: other.userId })).conversation.id;
  });
  afterAll(async () => h.close());
  const upload = async (cid: string, name?: string) => {
    const f = encrypted(name);
    const result = await alice.req("POST", `/v1/attachments?conversationId=${cid}`, undefined, f.bytes);
    return { ...f.ref, id: result.id };
  };
  const send = (cid: string, attachments: unknown[], messageId = crypto.randomUUID(), sender = alice) => sender.req("POST", "/v2/messages", { conversationId: cid, messageId, cls: "message", sentAt: Date.now(), payload: { type: "text", text: "caption", attachments } });
  it("refuses missing, foreign, duplicate, size-mismatched and hash-mismatched attachments", async () => {
    const ref = await upload(dm);
    const foreign = await upload(elsewhere);
    for (const invalid of [[{ ...ref, id: "missing" }], [foreign], [ref, ref], [{ ...ref, size: ref.size + 1 }], [{ ...ref, sha256: crypto.randomBytes(32).toString("base64") }]]) {
      await expectStatus(send(dm, invalid), 400);
    }
    // An unpublished object belongs to its uploader, even inside a shared conversation.
    await expectStatus(send(dm, [ref], crypto.randomUUID(), bob), 400);
  });
  it("retains originals and bounded encrypted previews only after publication, with an idempotent message id", async () => {
    const original = await upload(dm), thumbnail = await upload(dm, "preview.png");
    const pending = await h.ctx.files.attachment(original.id);
    expect(pending!.expires_at).toBeLessThan(KEPT_FOREVER);
    expect(pending!.pending_message_until).toBeGreaterThan(Date.now());
    await expectStatus(bob.req("GET", `/v1/attachments/${original.id}`), 404);
    const messageId = crypto.randomUUID();
    const refs = [{ ...original, thumbnail }];
    expect((await send(dm, refs, messageId)).duplicate).toBe(false);
    expect((await send(dm, refs, messageId)).duplicate).toBe(true);
    await bob.req("GET", `/v1/attachments/${original.id}`);
    for (const id of [original.id, thumbnail.id]) expect(await h.ctx.files.attachment(id)).toMatchObject({ message_id: messageId, pending_message_until: null, expires_at: KEPT_FOREVER });
    await expectStatus(send(dm, [{ ...original, thumbnail: { ...thumbnail, mime: "image/svg+xml" } }]), 400);
  });
  it("retains completed files beyond their original window without making unsent files public", async () => {
    const old = h.ctx.config.retainCompletedUploads;
    h.ctx.config.retainCompletedUploads = true;
    try {
      const file = await upload(dm);
      const row = await h.ctx.files.attachment(file.id);
      expect(row!.expires_at).toBe(KEPT_FOREVER);
      expect(row!.pending_message_until).not.toBeNull();
      await expectStatus(bob.req("GET", `/v1/attachments/${file.id}`), 404);
      expect(await h.ctx.files.purgeExpired(Date.now() + 365 * 86400000)).not.toContain(file.id);
      await send(dm, [file]);
      await bob.req("GET", `/v1/attachments/${file.id}`);
    } finally { h.ctx.config.retainCompletedUploads = old; }
  });
  it("cleans new unsent completed objects while preserving legacy records and published media", async () => {
    const abandoned = await upload(dm);
    // A fresh unbound upload remains temporary through the regular forever-retention pass.
    await runCleanup(h.ctx);
    const row = await h.ctx.files.attachment(abandoned.id);
    expect(row!.expires_at).toBeLessThan(KEPT_FOREVER);
    const gone = await h.ctx.files.purgeExpired(row!.expires_at + 1);
    expect(gone).toContain(abandoned.id);
  });
});

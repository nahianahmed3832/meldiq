import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonical, GriipClient, sign } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { queuedRows, setQueuedPayload } from "./support/relay.js";

/**
 * T1.5 (audit probe P7): revoking a phone must not destroy the messages it sent that are still queued. The directory
 * lists recently revoked devices apart from the active ones; recipients verify envelopes the server accepted up to
 * the revocation and refuse anything later. Revoked devices are never encryption targets.
 */
let h: Harness;
let alice: GriipClient, alicePhone2: GriipClient, bob: GriipClient;
let dm: string;

/** A second device on `owner`'s account, signed in with the same identity key (as after a recovery). */
async function addDevice(owner: GriipClient): Promise<GriipClient> {
  const c = new GriipClient(h.baseUrl, owner.username);
  c.identity = owner.identity;
  const { nonce } = await c.req("POST", "/v1/auth/challenge");
  const r = await c.req("POST", "/v1/auth/add-device", {
    username: owner.username,
    device: { name: "second phone", signingKey: c.signingKeyB64, encryptionKey: c.encKeyB64, certificate: c.certificate() },
    nonce,
    signature: sign(c.device, canonical.authProof("add-device", nonce, c.signingKeyB64)),
  });
  return Object.assign(c, { userId: r.userId, deviceId: r.deviceId, token: r.sessionToken });
}

const aliceEntry = async (viewer: GriipClient) => {
  const viaConversation = (await viewer.req("GET", `/v1/conversations/${dm}/devices`)).users.find((u: any) => u.userId === alice.userId);
  const viaUser = (await viewer.req("POST", "/v1/users/devices", { userIds: [alice.userId] })).users[0];
  expect(viaUser).toEqual(viaConversation);
  return viaConversation;
};

const decryptErrors = (c: GriipClient, messageId: string) => c.events.filter((e) => e.t === "decrypt_error" && e.item.messageId === messageId);

beforeAll(async () => {
  h = await startServer();
  alice = await h.client("revalice");
  bob = await h.client("revbob");
  dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  alicePhone2 = await addDevice(alice);
});
afterAll(async () => {
  await alicePhone2.disconnect();
  await h.close();
});

describe("messages from a device revoked after sending (T1.5)", () => {
  let before: { messageId: string };
  let tampered: { messageId: string };
  let revokedAt: number;

  it("lists the revoked device for verification, never as a device to encrypt to", async () => {
    // Bob is offline: both envelopes wait in his queue while Alice removes the phone that sent them.
    before = await alicePhone2.send(dm, { type: "text", text: "sent before the phone was removed" });
    tampered = await alicePhone2.send(dm, { type: "text", text: "pretends to be later" });
    await alice.req("DELETE", `/v1/devices/${alicePhone2.deviceId}`);

    const entry = await aliceEntry(bob);
    expect(entry.devices.map((d: any) => d.id)).toEqual([alice.deviceId]);
    expect(entry.revokedDevices).toHaveLength(1);
    const revoked = entry.revokedDevices[0];
    revokedAt = revoked.revokedAt;
    expect(revoked).toMatchObject({ id: alicePhone2.deviceId, signingKey: alicePhone2.signingKeyB64, encryptionKey: alicePhone2.encKeyB64 });
    expect(revokedAt).toBe(h.ctx.identity.get<{ revoked_at: number }>("devices", { id: alicePhone2.deviceId })!.revoked_at);
  });

  it("delivers and verifies what the device sent before it was revoked", async () => {
    // The server can't accept anything from a revoked device, so a later envelope is simulated in the queue. The
    // signature doesn't cover serverTs: only the recipient's revocation check refuses this copy. (Alice's other phone
    // has its own copy of each message; only Bob's is changed.)
    const row = (await queuedRows(h)).find((r) => r.message_id === tampered.messageId && r.recipient_device_id === bob.deviceId)!;
    const payload = { ...JSON.parse(row.payload), serverTs: revokedAt + 1 };
    await setQueuedPayload(h, row.id, JSON.stringify(payload));

    await bob.connect();
    const m = await bob.waitFor(() => bob.received.find((x) => x.messageId === before.messageId));
    expect(m.senderDeviceId).toBe(alicePhone2.deviceId);
    expect(m.payload.text).toBe("sent before the phone was removed");
    expect(decryptErrors(bob, before.messageId)).toEqual([]);

    await bob.waitFor(() => decryptErrors(bob, tampered.messageId).length > 0);
    expect(String(decryptErrors(bob, tampered.messageId)[0].error)).toContain("unknown or uncertified sender device");
    expect(bob.received.find((x) => x.messageId === tampered.messageId)).toBeUndefined();
  });

  it("refuses an envelope encrypted to the revoked device, while replies reach only the active ones", async () => {
    const reply = await bob.send(dm, { type: "text", text: "got it" });
    expect(reply.recipientCount).toBe(1);

    const entry = await aliceEntry(bob);
    const withRevoked = await bob.encrypt(dm, { type: "text", text: "to every key ever seen" }, "message", [...entry.devices, ...entry.revokedDevices]);
    const err = await expectStatus(bob.req("POST", "/v1/messages", withRevoked), 409);
    expect(err.error.code).toBe("device_mismatch");
    expect(err.error.details.extra).toEqual([alicePhone2.deviceId]);
  });

  it("stops listing a revoked device once nothing it sent can still be queued", async () => {
    const ttlMs = h.ctx.config.queueTtlSeconds * 1000;
    await h.ctx.identity.write((w) => w.update("devices", { id: alicePhone2.deviceId }, { revoked_at: Date.now() - ttlMs - 1000 }));
    const entry = await aliceEntry(bob);
    expect(entry.revokedDevices).toEqual([]);
    expect(entry.devices.map((d: any) => d.id)).toEqual([alice.deviceId]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonical, GriipClient, sign } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * Self-only controls (API 0.43.0, audience "self"): an encrypted control for the sender's own other devices only, so
 * reading a channel in one browser clears it in the others without telling anyone else (or the server) what was read.
 */
let h: Harness;
let ana: GriipClient, anaTablet: GriipClient, bo: GriipClient;
let channelId: string;

async function secondDevice(c: GriipClient): Promise<GriipClient> {
  const d = new GriipClient(h.baseUrl, c.username);
  d.identity = c.identity;
  const { nonce } = await d.req("POST", "/v1/auth/challenge");
  const r = await d.req("POST", "/v1/auth/add-device", {
    username: c.username,
    device: { name: "tablet", signingKey: d.signingKeyB64, encryptionKey: d.encKeyB64, certificate: d.certificate() },
    nonce,
    signature: sign(d.device, canonical.authProof("add-device", nonce, d.signingKeyB64)),
  });
  Object.assign(d, { userId: r.userId, deviceId: r.deviceId, token: r.sessionToken });
  return d;
}

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 0;
  }
};

/** Ana's own other devices in the channel, as her browser would find them. */
async function ownDevices() {
  const users = (await ana.req("GET", `/v1/conversations/${channelId}/devices`)).users as { userId: string; devices: { id: string; encryptionKey: string }[] }[];
  return users.filter((u) => u.userId === ana.userId).flatMap((u) => u.devices).filter((d) => d.id !== ana.deviceId);
}

beforeAll(async () => {
  h = await startServer();
  [ana, bo] = await Promise.all(["soana", "sobo"].map((n) => h.client(n)));
  anaTablet = await secondDevice(ana);
  const orgId = (await ana.req("POST", "/v1/orgs", { name: "Self Only" })).org.id;
  const code = (await ana.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
  await bo.req("POST", "/v1/invites/accept", { code });
  channelId = (await ana.req("POST", `/v1/orgs/${orgId}/channels`, { name: "lobby", kind: "PUBLIC" })).channel.id;
  await Promise.all([anaTablet.connect(), bo.connect()]);
});
afterAll(async () => h.close());

describe("self-only controls", () => {
  it("reach the sender's other devices and nobody else", async () => {
    const devices = await ownDevices();
    expect(devices.map((d) => d.id)).toEqual([anaTablet.deviceId]);
    const env = await ana.encrypt(channelId, { type: "read", upTo: 123 }, "control", devices as never);
    const r = await ana.req("POST", "/v1/messages", { ...env, audience: "self" });
    expect(r.recipientCount).toBe(1);
    await anaTablet.waitFor(() => anaTablet.events.find((e) => e.t === "queue" && e.items?.some((i: { messageId?: string }) => i.messageId === env.messageId)));
    await new Promise((res) => setTimeout(res, 200));
    expect(bo.events.some((e) => e.t === "queue" && e.items?.some((i: { messageId?: string }) => i.messageId === env.messageId))).toBe(false);
  });

  it("refuse anyone else's device among the recipients, and leaving out an own device", async () => {
    const bobs = (await ana.req("GET", `/v1/conversations/${channelId}/devices`)).users.find((u: { userId: string }) => u.userId === bo.userId).devices;
    const withBo = await ana.encrypt(channelId, { type: "read", upTo: 1 }, "control", [...(await ownDevices()), ...bobs] as never);
    expect(await status(ana.req("POST", "/v1/messages", { ...withBo, audience: "self" }))).toBe(409);
    const none = await ana.encrypt(channelId, { type: "read", upTo: 1 }, "control", []);
    expect(await status(ana.req("POST", "/v1/messages", { ...none, audience: "self" }))).toBe(409);
  });

  it("are only for controls", async () => {
    const env = await ana.encrypt(channelId, { type: "text", text: "hi" }, "message", (await ownDevices()) as never);
    expect(await status(ana.req("POST", "/v1/messages", { ...env, audience: "self" }))).toBe(400);
  });
});

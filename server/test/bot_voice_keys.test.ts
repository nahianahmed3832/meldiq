import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

const publicKey = () =>
  generateKeyPairSync("x25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");

describe("bot voice public key approval", () => {
  let h: Harness,
    owner: GriipClient,
    outsider: GriipClient,
    botId: string,
    orgId: string;
  const permissions = ["voice.connect"];
  const key1 = publicKey(),
    key2 = publicKey();
  const update = (rev: number, voicePublicKey?: string | null, actor = owner) =>
    actor.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
      permissions,
      rev,
      ...(voicePublicKey === undefined ? {} : { voicePublicKey }),
    });
  const approve = async (manifestRev: number) => {
    const current = await owner.req(
      "GET",
      `/v1/orgs/${orgId}/bots/${botId}/permissions`,
    );
    return owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
      permissions,
      manifestRev,
      rev: current.rev,
    });
  };
  const approved = async () =>
    h.ctx.bots.permissions.approvedVoiceKey(
      (await h.ctx.bots.store.bot(botId))!,
      orgId,
    );
  beforeAll(async () => {
    h = await startServer();
    owner = await h.client("voicekeyowner");
    outsider = await h.client("voicekeyoutsider");
    orgId = (await owner.req("POST", "/v1/orgs", { name: "Voice key review" }))
      .org.id;
    botId = (
      await owner.req("POST", "/v2/developer/bots", { name: "Voice helper" })
    ).bot.id;
    await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("refuses malformed, noncanonical and low-order keys without changing the manifest", async () => {
    for (const key of [
      "not-a-key",
      Buffer.alloc(32).toString("base64"),
      Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString("base64"),
    ])
      await expectStatus(update(0, key), 400);
    expect((await owner.req("GET", `/v2/bots/${botId}/permissions`)).rev).toBe(
      0,
    );
    await expectStatus(update(0, key1, outsider), 404);
  });

  it("requires explicit manager review of the exact current public-key revision", async () => {
    const manifest = await update(0, key1);
    expect(manifest).toMatchObject({
      voicePublicKey: key1,
      voiceKeyFingerprint: createHash("sha256")
        .update(Buffer.from(key1, "base64"))
        .digest("hex"),
      rev: 1,
    });
    await expect(approved()).rejects.toMatchObject({ statusCode: 403 });
    await approve(1);
    expect(await approved()).toMatchObject({ publicKey: key1, revision: 1 });
  });

  it("withdraws media key authority on rotation, preserves it when omitted and requires fresh review", async () => {
    await update(1, key2);
    await expect(approved()).rejects.toMatchObject({ statusCode: 403 });
    await expectStatus(approve(1), 409);
    const preserved = await update(2);
    expect(preserved.voicePublicKey).toBe(key2);
    await approve(3);
    expect(await approved()).toMatchObject({ publicKey: key2, revision: 3 });
  });

  it("clears voice authority without creating a human device or session", async () => {
    const cleared = await update(3, null);
    expect(cleared.voicePublicKey).toBeNull();
    expect(cleared.voiceKeyFingerprint).toBeNull();
    await approve(4);
    await expect(approved()).rejects.toMatchObject({ statusCode: 403 });
    expect(
      h.ctx.identity.all("devices", { where: { user_id: botId } }),
    ).toEqual([]);
    expect(
      h.ctx.identity.all("sessions", { where: { user_id: botId } }),
    ).toEqual([]);
    expect(
      Object.keys(
        h.ctx.ws.get("bot_requested_permissions", { bot_id: botId })!,
      ),
    ).not.toContain("private_key");
  });
});

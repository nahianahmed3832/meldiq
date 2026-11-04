import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { LiveKitService } from "../src/modules/calls/livekit.js";
import {
  botVoiceAad,
  BOT_VOICE_HPKE_INFO,
} from "../src/shared/contracts/botVoice.js";
import { callAdmission } from "../src/modules/calls/routes.js";
import { BotVoice } from "../src/modules/bots/voice.js";

class ControlPlaneSfu {
  publicUrl = "wss://media.example.test";
  identities = new Map<string, Set<string>>();
  updates: unknown[][] = [];
  failRemove = false;
  signer = new LiveKitService({
    apiUrl: "http://127.0.0.1:9",
    publicUrl: this.publicUrl,
    apiKey: "key",
    apiSecret: "test-secret-at-least-thirty-two-bytes",
  });
  async token() {
    return "test-human-media";
  }
  botToken(p: Parameters<LiveKitService["botToken"]>[0]) {
    return this.signer.botToken(p);
  }
  async roomNames() {
    return [...this.identities.keys()];
  }
  async participantIdentities(room: string) {
    return [...(this.identities.get(room) ?? [])];
  }
  async participantUsers(room: string) {
    return new Set(
      (await this.participantIdentities(room)).map((id) => id.split(".")[0]),
    );
  }
  async setCanPublish(
    room: string,
    identity: string,
    publish: boolean,
    data = true,
  ) {
    this.updates.push([identity, publish, data]);
    return this.identities.get(room)?.has(identity)
      ? ("updated" as const)
      : ("absent" as const);
  }
  async removeParticipant(room: string, identity: string) {
    if (this.failRemove) return "error" as const;
    return this.identities.get(room)?.delete(identity)
      ? ("removed" as const)
      : ("absent" as const);
  }
  async deleteRoom(room: string) {
    this.identities.delete(room);
  }
  async muteAudio() {
    return "muted" as const;
  }
  add(room: string, identity: string) {
    if (!this.identities.has(room)) this.identities.set(room, new Set());
    this.identities.get(room)!.add(identity);
  }
}

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "bot media leases (SFU transport stand-in, real API and HPKE)",
  () => {
    let h: Harness,
      owner: GriipClient,
      outsider: GriipClient,
      sfu: ControlPlaneSfu,
      botId: string,
      token: string,
      orgId: string,
      channelId: string,
      callId: string,
      room: string,
      recipient: CryptoKeyPair,
      leaseId: string;
    const suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    });
    const permissions = ["voice.connect"];
    const request = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(h.baseUrl + path, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json() };
    };
    const join = () =>
      request("POST", "/v2/bot/voice", { channelId, requestId: randomUUID() });
    const seal = async (id: string, key = randomBytes(32)) => {
      const encrypted = await suite.seal(
        {
          recipientPublicKey: recipient.publicKey,
          info: Buffer.from(BOT_VOICE_HPKE_INFO),
        },
        key,
        Buffer.from(botVoiceAad(callId, channelId, botId, id, 1)),
      );
      return {
        enc: Buffer.from(encrypted.enc).toString("base64"),
        ct: Buffer.from(encrypted.ct).toString("base64"),
      };
    };
    const share = async (id: string) =>
      owner.req(
        "POST",
        `/v1/calls/${callId}/bot-voice/${id}/key`,
        await seal(id),
      );
    beforeAll(async () => {
      h = await startServer();
      sfu = new ControlPlaneSfu();
      h.ctx.livekit = sfu as unknown as LiveKitService;
      owner = await h.client("botvoiceowner");
      await owner.connect();
      outsider = await h.client("botvoiceoutsider");
      orgId = (
        await owner.req("POST", "/v1/orgs", { name: "Bot voice control" })
      ).org.id;
      channelId = (
        await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
          name: "Lounge",
          scope: "ORG",
          voice: true,
          autoJoin: true,
        })
      ).channel.id;
      const made = await owner.req("POST", "/v2/developer/bots", {
        name: "Voice helper",
        public: true,
      });
      botId = made.bot.id;
      token = made.token;
      await owner.req("POST", `/v1/orgs/${orgId}/bots`, { botId });
      recipient = await suite.kem.generateKeyPair();
      await owner.req("PUT", `/v2/developer/bots/${botId}/permissions`, {
        permissions,
        rev: 0,
        voicePublicKey: Buffer.from(
          await suite.kem.serializePublicKey(recipient.publicKey),
        ).toString("base64"),
      });
      const call = await owner.req("POST", "/v1/calls", {
        conversationId: channelId,
      });
      callId = call.call.id;
      room = call.media.room;
      sfu.add(room, `${owner.userId}.${owner.deviceId}`);
      await owner.req("POST", `/v1/calls/${callId}/connected`);
    });
    afterAll(async () => {
      if (sfu) sfu.failRemove = false;
      await h?.close();
    });
    it("requires approval and issues only a one-minute audio capability without a human device", async () => {
      expect((await join()).status).toBe(403);
      await owner.req("PUT", `/v1/orgs/${orgId}/bots/${botId}/permissions`, {
        permissions,
        manifestRev: 1,
        rev: 0,
      });
      const requestId = randomUUID(),
        made = await request("POST", "/v2/bot/voice", { channelId, requestId });
      expect(made.status, JSON.stringify(made.body.error)).toBe(200);
      leaseId = made.body.leaseId;
      const stored = (
        await h.ctx.postgres!.database.query(
          "SELECT * FROM meldiq_private.bot_media_evictions WHERE lease_id=$1",
          [leaseId],
        )
      ).rows[0];
      expect(stored).toMatchObject({
        lease_id: leaseId,
        bot_id: botId,
        call_id: callId,
        room_name: room,
      });
      expect(Object.keys(stored).sort()).toEqual([
        "bot_id",
        "call_id",
        "created_at",
        "lease_id",
        "room_name",
      ]);
      const rights = (
        await h.ctx.postgres!.database.query(
          "SELECT has_table_privilege('anon','meldiq_private.bot_media_evictions','SELECT') AS anon,has_table_privilege('authenticated','meldiq_private.bot_media_evictions','SELECT') AS authenticated,relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid='meldiq_private.bot_media_evictions'::regclass",
        )
      ).rows[0];
      expect(rights).toEqual({
        anon: false,
        authenticated: false,
        enabled: true,
        forced: true,
      });
      const claims = JSON.parse(
        Buffer.from(
          made.body.media.token.split(".")[1],
          "base64url",
        ).toString(),
      );
      expect(claims.sub).toBe(`${botId}.${leaseId}`);
      expect(claims.exp - claims.nbf).toBeGreaterThanOrEqual(59);
      expect(claims.exp - claims.nbf).toBeLessThanOrEqual(60);
      expect(claims.video).toMatchObject({
        room,
        roomJoin: true,
        canPublish: false,
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        canPublishSources: ["microphone"],
      });
      expect(
        (await request("POST", "/v2/bot/voice", { channelId, requestId })).body
          .leaseId,
      ).toBe(leaseId);
      expect((await join()).status).toBe(409);
      expect(callAdmission(h.ctx, channelId)(botId, leaseId)).toBe(false);
      expect(
        (await request("POST", `/v2/bot/voice/${leaseId}/connected`)).status,
      ).toBe(403);
      expect(
        h.ctx.identity.all("devices", { where: { user_id: botId } }),
      ).toEqual([]);
    });
    it("reserves room capacity while an admitted bot is waiting for its wrapped key", async () => {
      const second = await outsider.req("POST", "/v2/developer/bots", {
        name: "Second voice helper",
        public: true,
      });
      await owner.req("POST", `/v1/orgs/${orgId}/bots`, {
        botId: second.bot.id,
      });
      const manifest = await owner.req("GET", `/v2/bots/${botId}/permissions`);
      await outsider.req(
        "PUT",
        `/v2/developer/bots/${second.bot.id}/permissions`,
        { permissions, rev: 0, voicePublicKey: manifest.voicePublicKey },
      );
      await owner.req(
        "PUT",
        `/v1/orgs/${orgId}/bots/${second.bot.id}/permissions`,
        { permissions, manifestRev: 1, rev: 0 },
      );
      const previous = h.ctx.config.callMaxParticipants;
      h.ctx.config.callMaxParticipants = 2;
      try {
        const response = await h.app.inject({
          method: "POST",
          url: "/v2/bot/voice",
          headers: { authorization: `Bot ${second.token}` },
          payload: { channelId, requestId: randomUUID() },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("call_full");
      } finally {
        h.ctx.config.callMaxParticipants = previous;
      }
    });
    it("rejects a key sender whose device was revoked during the SFU presence read", async () => {
      const packet = await seal(leaseId);
      const read = sfu.participantIdentities.bind(sfu);
      const race = vi
        .spyOn(sfu, "participantIdentities")
        .mockImplementationOnce(async (name) => {
          const result = await read(name);
          await h.ctx.identity.write((writer) =>
            writer.update(
              "devices",
              { id: owner.deviceId },
              { revoked_at: Date.now() },
            ),
          );
          return result;
        });
      try {
        await expectStatus(
          owner.req(
            "POST",
            `/v1/calls/${callId}/bot-voice/${leaseId}/key`,
            packet,
          ),
          403,
        );
      } finally {
        race.mockRestore();
        await h.ctx.identity.write((writer) =>
          writer.update(
            "devices",
            { id: owner.deviceId },
            { revoked_at: null },
          ),
        );
      }
      expect(
        (await request("GET", `/v2/bot/voice/${leaseId}/key`)).body.key,
      ).toBeNull();
    });
    it("relays only bounded HPKE ciphertext from an actual human participant to the addressed bot", async () => {
      const key = randomBytes(32),
        packet = await seal(leaseId, key);
      await expectStatus(
        outsider.req(
          "POST",
          `/v1/calls/${callId}/bot-voice/${leaseId}/key`,
          packet,
        ),
        404,
      );
      await expectStatus(
        owner.req("POST", `/v1/calls/${callId}/bot-voice/${leaseId}/key`, {
          ...packet,
          key: key.toString("base64"),
        }),
        400,
      );
      await owner.req(
        "POST",
        `/v1/calls/${callId}/bot-voice/${leaseId}/key`,
        packet,
      );
      const result = (await request("GET", `/v2/bot/voice/${leaseId}/key`))
        .body;
      const opened = await suite.open(
        {
          recipientKey: recipient,
          enc: Buffer.from(result.key.enc, "base64"),
          info: Buffer.from(BOT_VOICE_HPKE_INFO),
        },
        Buffer.from(result.key.ct, "base64"),
        Buffer.from(botVoiceAad(callId, channelId, botId, leaseId, 1)),
      );
      expect(Buffer.from(opened)).toEqual(key);
      expect(JSON.stringify(result)).not.toContain(key.toString("base64"));
      expect(
        (await request("POST", `/v2/bot/voice/${leaseId}/connected`)).status,
      ).toBe(403);
      sfu.add(room, `${botId}.${leaseId}`);
      expect(
        (await request("POST", `/v2/bot/voice/${leaseId}/connected`)).status,
      ).toBe(200);
      expect(sfu.updates.at(-1)).toEqual([`${botId}.${leaseId}`, false, false]);
    });
    it("withdraws admission and ciphertext while retaining failed SFU removal for retry", async () => {
      sfu.failRemove = true;
      expect((await request("DELETE", `/v2/bot/voice/${leaseId}`)).status).toBe(
        503,
      );
      expect(callAdmission(h.ctx, channelId)(botId, leaseId)).toBe(false);
      expect(
        (await request("GET", `/v2/bot/voice/${leaseId}/key`)).status,
      ).toBe(404);
      expect(
        (await request("POST", `/v2/bot/voice/${leaseId}/heartbeat`)).status,
      ).toBe(404);
      expect(await sfu.participantIdentities(room)).toContain(
        `${botId}.${leaseId}`,
      );
      sfu.failRemove = false;
      await h.ctx.bots.voice.maintain();
      expect(await sfu.participantIdentities(room)).not.toContain(
        `${botId}.${leaseId}`,
      );
    });
    it("expires leases, recovers orphan peers and rejects old leases after token rotation", async () => {
      let made = await join();
      expect(made.status, JSON.stringify(made.body.error)).toBe(200);
      const expired = made.body.leaseId;
      await share(expired);
      sfu.add(room, `${botId}.${expired}`);
      const clock = h.ctx.bots.clock;
      h.ctx.bots.clock = () => Date.now() + 61_000;
      try {
        await h.ctx.bots.voice.maintain();
      } finally {
        h.ctx.bots.clock = clock;
      }
      expect(await sfu.participantIdentities(room)).not.toContain(
        `${botId}.${expired}`,
      );
      const orphan = "deleted-bot.botvoice_oldprocess";
      sfu.add(room, orphan);
      await h.ctx.postgres!.database.query(
        "INSERT INTO meldiq_private.bot_media_evictions(lease_id,bot_id,call_id,room_name,created_at) VALUES($1,$2,$3,$4,$5)",
        [
          "botvoice_oldprocess",
          "deleted-bot",
          "deleted-call",
          room,
          Date.now(),
        ],
      );
      await new BotVoice(h.ctx.bots).maintain();
      expect(await sfu.participantIdentities(room)).not.toContain(orphan);
      made = await join();
      expect(made.status, JSON.stringify(made.body.error)).toBe(200);
      const id = made.body.leaseId;
      await share(id);
      sfu.add(room, `${botId}.${id}`);
      const rotated = await owner.req(
        "POST",
        `/v2/developer/bots/${botId}/token`,
      );
      expect((await request("GET", `/v2/bot/voice/${id}/key`)).status).toBe(
        401,
      );
      token = rotated.token;
      await h.ctx.bots.voice.maintain();
      expect((await request("GET", `/v2/bot/voice/${id}/key`)).status).toBe(
        404,
      );
      expect(await sfu.participantIdentities(room)).not.toContain(
        `${botId}.${id}`,
      );
    });
    it("uses the Python HTTP voice methods without exposing the media grant or token in output", async () => {
      const program = `import os,sys,json
sys.path.insert(0,os.environ['MELDIQ_TEST_SDK_DIR'])
from meldiq_bot import MeldiqBot,MeldiqBotError
bot=MeldiqBot(os.environ['MELDIQ_TEST_API'],os.environ['MELDIQ_TEST_BOT_TOKEN'])
lease=bot.join_voice(os.environ['MELDIQ_TEST_CHANNEL'])
pending=bot.voice_key(lease['leaseId'])['key'] is None
renewed=bot.renew_voice(lease['leaseId'])['leaseId']==lease['leaseId']
denied=False
try: bot.voice_connected(lease['leaseId'])
except MeldiqBotError as error: denied=error.status==403
left=bot.leave_voice(lease['leaseId'])['left']
print(json.dumps({'pending':pending,'renewed':renewed,'unconnectedDenied':denied,'left':left}))`;
      const output = await promisify(execFile)("python3", ["-c", program], {
        env: {
          PATH: process.env.PATH ?? "",
          MELDIQ_TEST_SDK_DIR: path.resolve(
            import.meta.dirname,
            "../sdk/python",
          ),
          MELDIQ_TEST_API: h.baseUrl,
          MELDIQ_TEST_BOT_TOKEN: token,
          MELDIQ_TEST_CHANNEL: channelId,
        },
        timeout: 30_000,
      });
      expect(JSON.parse(output.stdout)).toEqual({
        pending: true,
        renewed: true,
        unconnectedDenied: true,
        left: true,
      });
      expect(output.stdout).not.toContain(token);
    });
  },
);

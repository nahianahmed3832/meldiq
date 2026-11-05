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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import type { LiveKitService } from "../src/modules/calls/livekit.js";
import { ControlPlaneSfu } from "./support/botVoiceSfu.js";
import { BotVoiceLedger } from "../src/modules/bots/voiceLedger.js";
import {
  botVoiceAad,
  BOT_VOICE_HPKE_INFO,
} from "../src/shared/contracts/botVoice.js";
import { MeldiqBot } from "../sdk/javascript/index.mjs";
const execute = promisify(execFile);

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "opt-in bot waiting for the first human voice member",
  () => {
    let h: Harness,
      owner: GriipClient,
      sfu: ControlPlaneSfu,
      org: string,
      channel: string,
      bot: string,
      token: string;
    let keys: CryptoKeyPair;
    const suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    });
    const permissions = ["voice.connect"];
    const request = async (
      method: string,
      url: string,
      body?: unknown,
      credential = token,
    ) => {
      const response = await fetch(h.baseUrl + url, {
        method,
        headers: {
          authorization: `Bot ${credential}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const waiting = async (credential = token, requestId = randomUUID()) =>
      request(
        "POST",
        "/v2/bot/voice",
        { channelId: channel, requestId, waitForMember: true },
        credential,
      );
    const key = (id: string, credential = token) =>
      request("GET", `/v2/bot/voice/${id}/key`, undefined, credential);
    const pendingRows = async () =>
      (
        await h.ctx.postgres!.database.query(
          "SELECT count(*)::int AS count FROM meldiq_private.bot_media_evictions",
        )
      ).rows[0].count;
    async function makeBot(name: string) {
      const made = await owner.req("POST", "/v2/developer/bots", {
        name,
        public: true,
      });
      await owner.req("POST", `/v1/orgs/${org}/bots`, { botId: made.bot.id });
      const pair = await suite.kem.generateKeyPair();
      await owner.req("PUT", `/v2/developer/bots/${made.bot.id}/permissions`, {
        permissions,
        rev: 0,
        voicePublicKey: Buffer.from(
          await suite.kem.serializePublicKey(pair.publicKey),
        ).toString("base64"),
      });
      await owner.req(
        "PUT",
        `/v1/orgs/${org}/bots/${made.bot.id}/permissions`,
        { permissions, manifestRev: 1, rev: 0 },
      );
      return {
        bot: made.bot.id as string,
        token: made.token as string,
        keys: pair,
      };
    }
    async function openRoom(connected = true) {
      const call = await owner.req("POST", "/v1/calls", {
        conversationId: channel,
      });
      if (connected) {
        sfu.add(call.media.room, `${owner.userId}.${owner.deviceId}`);
        await owner.req("POST", `/v1/calls/${call.call.id}/connected`);
      }
      return call;
    }
    beforeEach(async () => {
      h = await startServer({ CALL_MAX_PARTICIPANTS: "2" });
      sfu = new ControlPlaneSfu();
      h.ctx.livekit = sfu as unknown as LiveKitService;
      owner = await h.client("waitingowner");
      org = (
        await owner.req("POST", "/v1/orgs", { name: "Empty-channel voice lab" })
      ).org.id;
      channel = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "Waiting room",
          scope: "ORG",
          voice: true,
          autoJoin: true,
        })
      ).channel.id;
      const made = await makeBot("Waiting helper");
      bot = made.bot;
      token = made.token;
      keys = made.keys;
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await h?.close();
    });

    it("keeps default clients compatible and creates no call, token or media cleanup record while explicitly waiting", async () => {
      const issue = vi.spyOn(sfu, "botToken");
      expect(
        (
          await request("POST", "/v2/bot/voice", {
            channelId: channel,
            requestId: randomUUID(),
          })
        ).status,
      ).toBe(409);
      const requestId = randomUUID(),
        sdk = new MeldiqBot({ apiOrigin: h.baseUrl, token });
      const lease = await sdk.joinVoice(channel, {
        requestId,
        waitForMember: true,
      });
      expect(lease).toMatchObject({
        callId: null,
        media: null,
        state: "waiting_for_member",
        channelId: channel,
      });
      expect(
        (await sdk.joinVoice(channel, { requestId, waitForMember: true }))
          .leaseId,
      ).toBe(lease.leaseId);
      expect(await sdk.voiceKey(lease.leaseId)).toMatchObject({
        key: null,
        media: null,
        callId: null,
      });
      expect((await sdk.renewVoice(lease.leaseId)).leaseId).toBe(lease.leaseId);
      expect((await waiting()).status).toBe(409);
      expect(
        (await request("POST", `/v2/bot/voice/${lease.leaseId}/connected`))
          .status,
      ).toBe(403);
      expect(await h.ctx.calls.liveIn([channel])).toEqual([]);
      expect(await pendingRows()).toBe(0);
      expect(issue).not.toHaveBeenCalled();
      expect(await sdk.leaveVoice(lease.leaseId)).toEqual({ left: true });
      expect((await key(lease.leaseId)).status).toBe(404);
    });

    it("waits for actual human presence and the bound HPKE packet before issuing a grant, then withdraws it on approval removal", async () => {
      const issue = vi.spyOn(sfu, "botToken"),
        lease = (await waiting()).body;
      const opened = await openRoom(false),
        callId = opened.call.id;
      expect(opened.call.botVoice).toContainEqual(
        expect.objectContaining({ leaseId: lease.leaseId, botId: bot }),
      );
      expect((await key(lease.leaseId)).body).toMatchObject({
        callId: null,
        key: null,
        media: null,
        state: "waiting_for_member",
      });
      expect(issue).not.toHaveBeenCalled();
      expect(await pendingRows()).toBe(0);
      const mediaKey = randomBytes(32);
      const sealed = await suite.seal(
        {
          recipientPublicKey: keys.publicKey,
          info: Buffer.from(BOT_VOICE_HPKE_INFO),
        },
        mediaKey,
        Buffer.from(botVoiceAad(callId, channel, bot, lease.leaseId, 1)),
      );
      const packet = {
        enc: Buffer.from(sealed.enc).toString("base64"),
        ct: Buffer.from(sealed.ct).toString("base64"),
      };
      await expect(
        owner.req(
          "POST",
          `/v1/calls/${callId}/bot-voice/${lease.leaseId}/key`,
          packet,
        ),
      ).rejects.toMatchObject({ status: 403 });
      sfu.add(opened.media.room, `${owner.userId}.${owner.deviceId}`);
      await owner.req("POST", `/v1/calls/${callId}/connected`);
      await owner.req(
        "POST",
        `/v1/calls/${callId}/bot-voice/${lease.leaseId}/key`,
        packet,
      );
      const ready = (await key(lease.leaseId)).body;
      expect(ready).toMatchObject({
        state: "ready",
        callId,
        media: { room: opened.media.room },
      });
      expect(
        Buffer.from(
          await suite.open(
            {
              recipientKey: keys,
              enc: Buffer.from(ready.key.enc, "base64"),
              info: Buffer.from(BOT_VOICE_HPKE_INFO),
            },
            Buffer.from(ready.key.ct, "base64"),
            Buffer.from(botVoiceAad(callId, channel, bot, lease.leaseId, 1)),
          ),
        ),
      ).toEqual(mediaKey);
      const claims = JSON.parse(
        Buffer.from(ready.media.token.split(".")[1], "base64url").toString(),
      );
      expect(claims.sub).toBe(`${bot}.${lease.leaseId}`);
      expect(claims.video.canPublish).toBe(false);
      sfu.add(opened.media.room, `${bot}.${lease.leaseId}`);
      expect(
        (await request("POST", `/v2/bot/voice/${lease.leaseId}/connected`))
          .status,
      ).toBe(200);
      await owner.req("PUT", `/v1/orgs/${org}/bots/${bot}/permissions`, {
        permissions: [],
        manifestRev: 1,
        rev: 1,
      });
      expect((await key(lease.leaseId)).status).toBe(404);
      await h.ctx.bots.voice.maintain();
      expect(await pendingRows()).toBe(0);
      expect(
        sfu.identities.get(opened.media.room)?.has(`${bot}.${lease.leaseId}`),
      ).toBe(false);
    });

    it("serializes two pending activations against the native capacity and reuses a freed slot without issuing an early token", async () => {
      const second = await makeBot("Second waiting helper"),
        issue = vi.spyOn(sfu, "botToken");
      const firstLease = (await waiting()).body,
        secondLease = (await waiting(second.token)).body;
      const opened = await openRoom();
      const results = await Promise.all([
        key(firstLease.leaseId),
        key(secondLease.leaseId, second.token),
      ]);
      expect(results.map((value) => value.status).sort()).toEqual([200, 409]);
      expect(
        results.find((value) => value.status === 409)?.body.error.code,
      ).toBe("call_full");
      expect(await pendingRows()).toBe(1);
      expect(h.ctx.bots.voice.reserved(opened.call.id)).toHaveLength(1);
      expect(issue).not.toHaveBeenCalled();
      const winner =
        results[0].status === 200
          ? { lease: firstLease, token }
          : { lease: secondLease, token: second.token };
      const loser =
        results[0].status === 200
          ? { lease: secondLease, token: second.token }
          : { lease: firstLease, token };
      expect(
        (
          await request(
            "DELETE",
            `/v2/bot/voice/${winner.lease.leaseId}`,
            undefined,
            winner.token,
          )
        ).status,
      ).toBe(200);
      expect((await key(loser.lease.leaseId, loser.token)).status).toBe(200);
      expect(await pendingRows()).toBe(1);
    });

    it("shares the native capacity reservation between a fresh join and a pending activation", async () => {
      const second = await makeBot("New competing helper"),
        lease = (await waiting()).body;
      const opened = await openRoom();
      const fresh = h.ctx.bots.events.fresh.bind(h.ctx.bots.events);
      let entered!: () => void, release!: () => void;
      const prepared = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(h.ctx.bots.events, "fresh").mockImplementation(async (candidate) => {
        if (candidate.id === second.bot) { entered(); await barrier; }
        return fresh(candidate);
      });
      const joining = waiting(second.token);
      let activating: ReturnType<typeof key> | undefined;
      try {
        await prepared;
        activating = key(lease.leaseId);
        // Let the competing HTTP request reach admission while the fresh reservation is paused.
        await new Promise((resolve) => setTimeout(resolve, 75));
      } finally { release(); }
      const results = await Promise.all([joining, activating!]);
      expect(results.map((value) => value.status).sort()).toEqual([200, 409]);
      expect(h.ctx.bots.voice.reserved(opened.call.id)).toHaveLength(1);
      expect(await pendingRows()).toBe(1);
    });

    it("also withholds the opt-in grant when a room already has a connected member but its encrypted key has not arrived", async () => {
      const opened = await openRoom(),
        issue = vi.spyOn(sfu, "botToken"),
        requestId = randomUUID();
      const lease = (await waiting(token, requestId)).body;
      expect(lease).toMatchObject({
        callId: opened.call.id,
        media: null,
        state: "waiting_for_key",
      });

      expect((await waiting(token, requestId)).body).toMatchObject({
        leaseId: lease.leaseId,
        media: null,
      });
      expect((await request("POST", "/v2/bot/voice", {
        channelId: channel, requestId,
      })).body).toMatchObject({ leaseId: lease.leaseId, media: null });
      expect((await key(lease.leaseId)).body).toMatchObject({
        key: null,
        media: null,
      });
      expect(issue).not.toHaveBeenCalled();
      expect(await pendingRows()).toBe(1);
    });

    it("supports explicit pending admission and cleanup through the dependency-free Python client", async () => {
      const result = await execute(
        "python3",
        [
          "-c",
          `import json, os\nfrom meldiq_bot import MeldiqBot\nbot=MeldiqBot(os.environ['MELDIQ_TEST_ORIGIN'],os.environ['MELDIQ_TEST_TOKEN'])\nlease=bot.join_voice(os.environ['MELDIQ_TEST_CHANNEL'],wait_for_member=True)\nassert lease['callId'] is None and lease['media'] is None\nassert bot.voice_key(lease['leaseId'])['key'] is None\nassert bot.renew_voice(lease['leaseId'])['leaseId']==lease['leaseId']\nstrict=False\ntry:\n bot.join_voice(os.environ['MELDIQ_TEST_CHANNEL'],wait_for_member=1)\nexcept TypeError:\n strict=True\nassert strict\nassert bot.leave_voice(lease['leaseId'])['left'] is True\nprint(json.dumps({'waiting':True,'strictBoolean':strict,'left':True}))`,
        ],
        {
          env: {
            ...process.env,
            PYTHONPATH: path.resolve(import.meta.dirname, "../sdk/python"),
            MELDIQ_TEST_ORIGIN: h.baseUrl,
            MELDIQ_TEST_TOKEN: token,
            MELDIQ_TEST_CHANNEL: channel,
          },
        },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        waiting: true,
        strictBoolean: true,
        left: true,
      });
      expect(await pendingRows()).toBe(0);
    });

    it("retains a bounded pending intent without media when SFU presence cannot be confirmed", async () => {
      const lease = (await waiting()).body,
        issue = vi.spyOn(sfu, "botToken");
      await openRoom(false);
      vi.spyOn(h.ctx.livekit!, "participantIdentities").mockResolvedValueOnce(
        null,
      );
      const unavailable = await key(lease.leaseId);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error.code).toBe("media_unavailable");
      expect((await key(lease.leaseId)).body).toMatchObject({
        callId: null,
        media: null,
        state: "waiting_for_member",
      });
      expect(await pendingRows()).toBe(0);
      expect(issue).not.toHaveBeenCalled();
    });

    it("expires an unbound intent and refuses to revive a lease after approval withdrawal", async () => {
      let clock = Date.now();
      vi.spyOn(h.ctx.bots, "clock").mockImplementation(() => clock);
      const first = (await waiting()).body;
      clock += 60_001;
      expect((await key(first.leaseId)).status).toBe(404);
      await h.ctx.bots.voice.maintain();
      const second = (await waiting()).body;
      await owner.req("PUT", `/v1/orgs/${org}/bots/${bot}/permissions`, {
        permissions: [],
        manifestRev: 1,
        rev: 1,
      });
      expect((await key(second.leaseId)).status).toBe(404);
      await h.ctx.bots.voice.maintain();
      expect(await pendingRows()).toBe(0);
      expect(await h.ctx.calls.liveIn([channel])).toEqual([]);
    });

    it("never issues a concurrent key-read grant while cleanup persistence is blocked", async () => {
      const lease = (await waiting()).body,
        issue = vi.spyOn(sfu, "botToken"),
        opened = await openRoom();
      const plain = randomBytes(32);
      const sealed = await suite.seal(
        {
          recipientPublicKey: keys.publicKey,
          info: Buffer.from(BOT_VOICE_HPKE_INFO),
        },
        plain,
        Buffer.from(
          botVoiceAad(opened.call.id, channel, bot, lease.leaseId, 1),
        ),
      );
      const packet = {
        enc: Buffer.from(sealed.enc).toString("base64"),
        ct: Buffer.from(sealed.ct).toString("base64"),
      };
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
      const remember = BotVoiceLedger.prototype.remember;
      vi.spyOn(BotVoiceLedger.prototype, "remember").mockImplementationOnce(
        async function (this: BotVoiceLedger, row) {
          entered();
          await barrier;
          return remember.call(this, row);
        },
      );
      const requests: Promise<unknown>[] = [];
      try {
        requests.push(key(lease.leaseId));
        await reached;
        const sharing = owner.req(
          "POST",
          `/v1/calls/${opened.call.id}/bot-voice/${lease.leaseId}/key`,
          packet,
        );
        requests.push(sharing);
        await Promise.race([
          sharing,
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
        const concurrent = key(lease.leaseId);
        requests.push(concurrent);
        await Promise.race([
          concurrent,
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
        expect(await pendingRows()).toBe(0);
        expect(issue.mock.calls.length).toBe(0);
        release();
        await Promise.all(requests);
        const ready = await key(lease.leaseId);
        expect(ready.status).toBe(200);
        expect(Boolean(ready.body.media?.token)).toBe(true);
        expect(await pendingRows()).toBe(1);
      } finally {
        release();
        await Promise.allSettled(requests);
      }
    });

    it("withholds a grant when ledger persistence fails", async () => {
      const lease = (await waiting()).body,
        issue = vi.spyOn(sfu, "botToken");
      await openRoom();
      vi.spyOn(BotVoiceLedger.prototype, "remember").mockRejectedValueOnce(
        new Error("Synthetic ledger outage"),
      );
      expect((await key(lease.leaseId)).status).toBe(500);
      expect(issue).not.toHaveBeenCalled();
      await h.ctx.bots.voice.maintain();
      expect(await pendingRows()).toBe(0);
      expect((await key(lease.leaseId)).status).toBe(404);
    });

    it("keeps native nonvoice, membership, archive and voice-ban restrictions for pending admission", async () => {
      const issue = vi.spyOn(sfu, "botToken");
      const general = (
        await owner.req("GET", `/v1/orgs/${org}/channels`)
      ).channels.find((value: { name: string }) => value.name === "general").id;
      const join = (channelId: string) =>
        request("POST", "/v2/bot/voice", {
          channelId,
          requestId: randomUUID(),
          waitForMember: true,
        });
      expect((await join(general)).status).toBe(404);
      const outsider = await h.client("waitingoutsider");
      const other = (
        await outsider.req("POST", "/v1/orgs", {
          name: "Other recovery-independent community",
        })
      ).org.id;
      const hidden = (
        await outsider.req("POST", `/v1/orgs/${other}/channels`, {
          name: "Members only",
          scope: "ORG",
          voice: true,
          autoJoin: true,
        })
      ).channel.id;
      expect((await join(hidden)).status).toBe(404);
      await owner.req("PATCH", `/v1/conversations/${channel}`, {
        archived: true,
      });
      expect((await waiting()).status).toBe(404);
      await owner.req("PATCH", `/v1/conversations/${channel}`, {
        archived: false,
      });
      const lease = (await waiting()).body;
      await owner.req("POST", `/v1/orgs/${org}/voice-bans`, {
        userId: bot,
        reason: "Synthetic pending-admission restriction",
      });
      expect((await key(lease.leaseId)).status).toBe(404);
      await h.ctx.bots.voice.maintain();
      expect(await pendingRows()).toBe(0);
      expect(issue).not.toHaveBeenCalled();
    });

    it("cannot use an in-flight reservation after uninstall and a fresh approval of the same bot", async () => {
      const lease = (await waiting()).body,
        issue = vi.spyOn(sfu, "botToken");
      await openRoom();
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
      const remember = BotVoiceLedger.prototype.remember;
      vi.spyOn(BotVoiceLedger.prototype, "remember").mockImplementationOnce(
        async function (this: BotVoiceLedger, row) {
          entered();
          await barrier;
          return remember.call(this, row);
        },
      );
      try {
        const pending = key(lease.leaseId);
        await reached;
        await owner.req("DELETE", `/v1/orgs/${org}/bots/${bot}`);
        await owner.req("POST", `/v1/orgs/${org}/bots`, { botId: bot });
        await owner.req("PUT", `/v1/orgs/${org}/bots/${bot}/permissions`, {
          permissions,
          manifestRev: 1,
          rev: 0,
        });
        release();
        expect((await pending).status).toBe(404);
        await h.ctx.bots.voice.stop();
        expect(await pendingRows()).toBe(0);
        expect(issue).not.toHaveBeenCalled();
      } finally {
        release();
      }
    });

    it("drains an activation racing shutdown and never returns a media grant", async () => {
      const lease = (await waiting()).body,
        issue = vi.spyOn(sfu, "botToken");
      await openRoom();
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
      const remember = BotVoiceLedger.prototype.remember;
      vi.spyOn(BotVoiceLedger.prototype, "remember").mockImplementationOnce(
        async function (this: BotVoiceLedger, row) {
          entered();
          await barrier;
          return remember.call(this, row);
        },
      );
      try {
        const pending = key(lease.leaseId);
        await reached;
        let stopped = false;
        const stopping = h.ctx.bots.voice.stop().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        expect((await pending).status).toBe(404);
        await stopping;
        expect(issue).not.toHaveBeenCalled();
        expect(await pendingRows()).toBe(0);
        expect((await waiting()).status).toBe(503);
      } finally {
        release();
      }
    });
  },
);

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
import { startFakeS3, type FakeS3 } from "./support/fakeS3.js";
import { MeldiqBot } from "../sdk/javascript/index.mjs";
import {
  encryptAttachmentBytes,
  decryptAttachmentBytes,
} from "../sdk/javascript/attachments.mjs";

function encrypted(size = 512) {
  const key = randomBytes(32),
    nonce = randomBytes(12),
    plain = randomBytes(size);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const bytes = Buffer.concat([
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    bytes,
    plain,
    ref: {
      name: "controlled.bin",
      mime: "application/octet-stream",
      size,
      key: key.toString("base64"),
      nonce: nonce.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("base64"),
    },
  };
}

class BotLab {
  h!: Harness;
  owner!: GriipClient;
  member!: GriipClient;
  org = "";
  channel = "";
  bot = "";
  token = "";
  approvalRev = 0;
  async start(env: Record<string, string> = {}) {
    this.h = await startServer({ MESSAGES_ACCEPT_ENCRYPTED: "false", ...env });
    this.owner = await this.h.client("botfileowner");
    this.owner.serverMessages = true;
    this.member = await this.h.client("botfilemember");
    this.org = (
      await this.owner.req("POST", "/v1/orgs", { name: "Bot files" })
    ).org.id;
    this.channel = (
      await this.owner.req("GET", `/v1/orgs/${this.org}/channels`)
    ).channels.find((c: { name: string }) => c.name === "general").id;
    const code = (
      await this.owner.req("POST", `/v1/orgs/${this.org}/invites`, {
        role: "MEMBER",
      })
    ).invite.code;
    await this.member.req("POST", "/v1/invites/accept", { code });
    const made = await this.owner.req("POST", "/v2/developer/bots", {
      name: "File helper",
    });
    this.bot = made.bot.id;
    this.token = made.token;
    await this.owner.req("POST", `/v1/orgs/${this.org}/bots`, {
      botId: this.bot,
    });
    await this.owner.req("PUT", `/v2/developer/bots/${this.bot}/permissions`, {
      permissions: ["messages.post", "messages.history"],
      rev: 0,
    });
    await this.approve(["messages.post", "messages.history"], 1);
  }
  async approve(
    permissions = [
      "messages.post",
      "messages.history",
      "files.upload",
      "files.read",
    ],
    manifestRev = 2,
  ) {
    await this.owner.req(
      "PUT",
      `/v1/orgs/${this.org}/bots/${this.bot}/permissions`,
      { permissions, manifestRev, rev: this.approvalRev++ },
    );
  }
  async request(method: string, path: string, body?: unknown, bytes?: Buffer) {
    return fetch(this.h.baseUrl + "/v2/bot" + path, {
      method,
      redirect: "manual",
      headers: {
        authorization: `Bot ${this.token}`,
        ...(bytes
          ? { "content-type": "application/octet-stream" }
          : body === undefined
            ? {}
            : { "content-type": "application/json" }),
      },
      ...(bytes
        ? { body: new Uint8Array(bytes) }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    });
  }
  async json(
    method: string,
    path: string,
    body?: unknown,
    bytes?: Buffer,
    expected = 200,
  ) {
    const response = await this.request(method, path, body, bytes);
    const value = await response.json();
    expect(
      response.status,
      `${method} ${path}: ${JSON.stringify(value.error ?? { fields: Object.keys(value) })}`,
    ).toBe(expected);
    return value;
  }
  async upload(file = encrypted(), channel = this.channel) {
    const stored = await this.json(
      "POST",
      `/attachments?conversationId=${channel}`,
      undefined,
      file.bytes,
    );
    return { ...file, ref: { ...file.ref, id: stored.id } };
  }
  post(refs: unknown[], channel = this.channel) {
    return this.request("POST", `/channels/${channel}/messages`, {
      content: "Controlled file",
      messageId: randomUUID(),
      attachments: refs,
    });
  }
  async grantFiles() {
    await this.owner.req("PUT", `/v2/developer/bots/${this.bot}/permissions`, {
      permissions: [
        "messages.post",
        "messages.history",
        "files.upload",
        "files.read",
      ],
      rev: 1,
    });
    await this.approve();
  }
}

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "bot encrypted files through native controllers",
  () => {
    const lab = new BotLab();
    let file: Awaited<ReturnType<BotLab["upload"]>>;
    beforeAll(async () => lab.start());
    afterAll(async () => lab.h?.close());

    it("does not expand old approvals when new file scopes are requested", async () => {
      const sample = encrypted();
      await lab.json(
        "POST",
        `/attachments?conversationId=${lab.channel}`,
        undefined,
        sample.bytes,
        403,
      );
      await lab.owner.req("PUT", `/v2/developer/bots/${lab.bot}/permissions`, {
        permissions: [
          "messages.post",
          "messages.history",
          "files.upload",
          "files.read",
        ],
        rev: 1,
      });
      await lab.json(
        "POST",
        `/attachments?conversationId=${lab.channel}`,
        undefined,
        sample.bytes,
        403,
      );
      await lab.approve(["messages.post", "messages.history", "files.upload"]);
      file = await lab.upload(sample);
      await lab.json(
        "GET",
        `/attachments/${file.ref.id}`,
        undefined,
        undefined,
        403,
      );
      await lab.approve();
      const own = await lab.request("GET", `/attachments/${file.ref.id}`);
      expect(own.status).toBe(200);
      expect(Buffer.from(await own.arrayBuffer())).toEqual(file.bytes);
      const privateResponse = await fetch(
        lab.h.baseUrl + `/v1/attachments/${file.ref.id}`,
        { headers: { authorization: `Bearer ${lab.member.token}` } },
      );
      expect(privateResponse.status).toBe(404);
    });

    it("publishes native references only after validation and serves real encrypted ranges", async () => {
      const response = await lab.post([file.ref]);
      expect(response.status).toBe(200);
      const delivered = await lab.member.req(
        "GET",
        `/v1/attachments/${file.ref.id}`,
      );
      expect(delivered).toEqual(file.bytes);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(file.ref.key, "base64"),
        Buffer.from(file.ref.nonce, "base64"),
      );
      decipher.setAuthTag(delivered.subarray(-16));
      expect(
        Buffer.concat([
          decipher.update(delivered.subarray(0, -16)),
          decipher.final(),
        ]),
      ).toEqual(file.plain);
      const range = await fetch(
        lab.h.baseUrl + `/v2/bot/attachments/${file.ref.id}`,
        {
          redirect: "manual",
          headers: { authorization: `Bot ${lab.token}`, range: "bytes=0-15" },
        },
      );
      expect(range.status).toBe(206);
      expect(range.headers.get("location")).toBeNull();
      expect(Buffer.from(await range.arrayBuffer())).toEqual(
        file.bytes.subarray(0, 16),
      );
      for (const refs of [
        [file.ref, file.ref],
        [{ ...file.ref, size: file.ref.size + 1 }],
        [{ ...file.ref, sha256: randomBytes(32).toString("base64") }],
      ])
        expect((await lab.post(refs)).status).toBe(400);
      const other = (
        await lab.owner.req("POST", `/v1/orgs/${lab.org}/channels`, {
          name: "Elsewhere",
          autoJoin: true,
        })
      ).channel.id;
      const foreign = await lab.upload(encrypted(), other);
      expect((await lab.post([foreign.ref])).status).toBe(400);
      const stranger = await lab.h.client("botfilestranger");
      const outside = (
        await stranger.req("POST", "/v1/orgs", { name: "Outside" })
      ).org.id;
      const outsideChannel = (
        await stranger.req("GET", `/v1/orgs/${outside}/channels`)
      ).channels[0].id;
      await lab.json(
        "POST",
        `/attachments?conversationId=${outsideChannel}`,
        undefined,
        encrypted().bytes,
        404,
      );
    });

    it("uses the first-party JavaScript encrypted helper and streaming/range download methods", async () => {
      const client = new MeldiqBot({
        apiOrigin: lab.h.baseUrl,
        token: lab.token,
      });
      const plain = Buffer.from(
        "Private synthetic SDK file\0with native AES-GCM",
      );
      const encrypted = encryptAttachmentBytes(plain, { name: "sdk.bin" });
      const stored = await client.uploadAttachment(
        lab.channel,
        encrypted.bytes,
      );
      expect(
        (
          await client.send(lab.channel, "SDK file", {
            attachments: [{ ...encrypted.reference, id: stored.id }],
          })
        ).duplicate,
      ).toBe(false);
      const chunks = [];
      for await (const chunk of client.downloadAttachment(stored.id))
        chunks.push(chunk);
      const ciphertext = Buffer.concat(chunks);
      expect(decryptAttachmentBytes(ciphertext, encrypted.reference)).toEqual(
        plain,
      );
      const changed = Buffer.from(ciphertext);
      changed[0] ^= 1;
      expect(() =>
        decryptAttachmentBytes(changed, encrypted.reference),
      ).toThrow("did not match");
      const partial = [];
      for await (const chunk of client.downloadAttachment(stored.id, {
        range: "bytes=0-15",
      }))
        partial.push(chunk);
      expect(Buffer.concat(partial)).toEqual(ciphertext.subarray(0, 16));
      await expect(
        client.downloadAttachment(stored.id, { range: "outside" }).next(),
      ).rejects.toThrow("Invalid bot request");
    });

    it("uses Python upload, native publication and streamed/range reads without printing file keys", async () => {
      const file = encrypted();
      const program = `import os,sys,json,base64
sys.path.insert(0,os.environ['MELDIQ_TEST_SDK_DIR'])
from meldiq_bot import MeldiqBot
bot=MeldiqBot(os.environ['MELDIQ_TEST_API'],os.environ['MELDIQ_TEST_BOT_TOKEN'])
raw=base64.b64decode(os.environ['MELDIQ_TEST_CIPHERTEXT'])
stored=bot.upload_attachment(os.environ['MELDIQ_TEST_CHANNEL'],raw)
reference=json.loads(os.environ['MELDIQ_TEST_REFERENCE'])
reference['id']=stored['id']
sent=bot.send(os.environ['MELDIQ_TEST_CHANNEL'],'Python file',attachments=[reference])
whole=b''.join(bot.download_attachment(stored['id']))
part=b''.join(bot.download_attachment(stored['id'],byte_range='bytes=0-15'))
print(json.dumps({'sent':not sent['duplicate'],'same':whole==raw,'range':part==raw[:16]}))`;
      const output = await promisify(execFile)("python3", ["-c", program], {
        env: {
          PATH: process.env.PATH ?? "",
          MELDIQ_TEST_SDK_DIR: path.resolve("sdk/python"),
          MELDIQ_TEST_API: lab.h.baseUrl,
          MELDIQ_TEST_BOT_TOKEN: lab.token,
          MELDIQ_TEST_CHANNEL: lab.channel,
          MELDIQ_TEST_CIPHERTEXT: file.bytes.toString("base64"),
          MELDIQ_TEST_REFERENCE: JSON.stringify(file.ref),
        },
      });
      expect(JSON.parse(output.stdout)).toEqual({
        sent: true,
        same: true,
        range: true,
      });
      expect(output.stdout).not.toContain(lab.token);
      expect(output.stdout).not.toContain(file.ref.key);
    });

    it("applies native attachment denial to both uploading and message publication", async () => {
      await lab.owner.req(
        "PUT",
        `/v1/conversations/${lab.channel}/overwrites`,
        { subject: `user:${lab.bot}`, deny: ["messages.attach"] },
      );
      try {
        await lab.json(
          "POST",
          `/attachments?conversationId=${lab.channel}`,
          undefined,
          encrypted().bytes,
          403,
        );
        expect((await lab.post([file.ref])).status).toBe(403);
      } finally {
        await lab.owner.req(
          "PUT",
          `/v1/conversations/${lab.channel}/overwrites`,
          { subject: `user:${lab.bot}`, deny: [], allow: [] },
        );
      }
    });

    it("withdraws a stored upload before metadata acceptance when the token rotates during storage", async () => {
      const original = lab.h.ctx.blobs.putFile.bind(lab.h.ctx.blobs);
      let storedId = "";
      const put = vi
        .spyOn(lab.h.ctx.blobs, "putFile")
        .mockImplementationOnce(async (...args) => {
          storedId = args[1];
          await original(...args);
          lab.token = (
            await lab.owner.req("POST", `/v2/developer/bots/${lab.bot}/token`)
          ).token;
        });
      try {
        await lab.json(
          "POST",
          `/attachments?conversationId=${lab.channel}`,
          undefined,
          encrypted().bytes,
          401,
        );
        expect(await lab.h.ctx.files.attachment(storedId)).toBeNull();
        expect(await lab.h.ctx.blobs.get("attachments", storedId)).toBeNull();
      } finally {
        put.mockRestore();
      }
    });

    it("refuses an in-flight upload after uninstall and fresh reapproval of the same bot", async () => {
      const original = lab.h.ctx.blobs.putFile.bind(lab.h.ctx.blobs);
      let storedId = "";
      const put = vi
        .spyOn(lab.h.ctx.blobs, "putFile")
        .mockImplementationOnce(async (...args) => {
          storedId = args[1];
          await original(...args);
          await lab.owner.req("DELETE", `/v1/orgs/${lab.org}/bots/${lab.bot}`);
          await lab.owner.req("POST", `/v1/orgs/${lab.org}/bots`, {
            botId: lab.bot,
          });
          lab.approvalRev = 0;
          await lab.approve();
        });
      try {
        await lab.json(
          "POST",
          `/attachments?conversationId=${lab.channel}`,
          undefined,
          encrypted().bytes,
          403,
        );
        expect(await lab.h.ctx.files.attachment(storedId)).toBeNull();
        expect(await lab.h.ctx.blobs.get("attachments", storedId)).toBeNull();
      } finally {
        put.mockRestore();
      }
    });

    it("rechecks download approval after asynchronous storage lookup and closes the unused stream", async () => {
      const original = lab.h.ctx.blobs.get.bind(lab.h.ctx.blobs);
      let source: Readable | null = null;
      const read = vi
        .spyOn(lab.h.ctx.blobs, "get")
        .mockImplementationOnce(async (...args) => {
          source = await original(...args);
          await lab.approve([
            "messages.post",
            "messages.history",
            "files.upload",
          ]);
          return source;
        });
      try {
        await lab.json(
          "GET",
          `/attachments/${file.ref.id}`,
          undefined,
          undefined,
          403,
        );
        expect(source?.destroyed).toBe(true);
      } finally {
        read.mockRestore();
        await lab.approve();
      }
    });

    it("closes an in-flight download when approval is withdrawn between chunks", async () => {
      const large = await lab.upload(encrypted(32 * 1024));
      expect((await lab.post([large.ref])).status).toBe(200);
      let release!: () => void;
      const pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      let source: Readable | null = null;
      const read = vi
        .spyOn(lab.h.ctx.blobs, "get")
        .mockImplementationOnce(async () => {
          source = Readable.from(
            (async function* () {
              yield large.bytes.subarray(0, 16 * 1024);
              await pause;
              yield large.bytes.subarray(16 * 1024);
            })(),
          );
          return source;
        });
      try {
        const response = await lab.request(
          "GET",
          `/attachments/${large.ref.id}`,
        );
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect((await reader.read()).value!.length).toBeGreaterThan(0);
        await lab.approve([
          "messages.post",
          "messages.history",
          "files.upload",
        ]);
        release();
        await expect(
          (async () => {
            while (!(await reader.read()).done) {}
          })(),
        ).rejects.toThrow();
        expect(source?.destroyed).toBe(true);
      } finally {
        release();
        read.mockRestore();
        await lab.approve();
      }
    });
  },
);

describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "bot native direct upload sessions (loopback S3 stand-in)",
  () => {
    const lab = new BotLab();
    let s3: FakeS3;
    beforeAll(async () => {
      const credentials = {
        accessKeyId: "AKIDBOTFILESTEST",
        secretAccessKey: "synthetic-bot-file-test-secret",
      };
      s3 = await startFakeS3("bot-files", "eu-central-1", credentials);
      await lab.start({
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "bot-files",
        S3_REGION: "eu-central-1",
        S3_ENDPOINT: s3.url,
        S3_FORCE_PATH_STYLE: "true",
        S3_ACCESS_KEY_ID: credentials.accessKeyId,
        S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        S3_PART_SIZE: String(5 * 1024 * 1024),
        S3_MULTIPART_THRESHOLD: String(5 * 1024 * 1024),
      });
      await lab.grantFiles();
    });
    afterAll(async () => {
      await lab.h?.close();
      await s3?.close();
    });

    it("binds single-upload checksum/size, preserves completion retry and prevents another bot resuming it", async () => {
      const file = encrypted();
      const start = await lab.json("POST", "/attachments/uploads", {
        conversationId: lab.channel,
        size: file.bytes.length,
        sha256: file.ref.sha256,
      });
      expect(start.mode).toBe("single");
      const renewed = await lab.json(
        "POST",
        `/attachments/uploads/${start.uploadId}/url`,
      );
      expect(
        (
          await fetch(renewed.upload.url, {
            method: "PUT",
            headers: renewed.upload.headers,
            body: file.bytes,
            redirect: "error",
          })
        ).status,
      ).toBe(200);
      const done = await lab.json(
        "POST",
        `/attachments/uploads/${start.uploadId}/complete`,
        {},
      );
      expect(
        await lab.json(
          "POST",
          `/attachments/uploads/${start.uploadId}/complete`,
          {},
        ),
      ).toEqual(done);
      expect((await lab.post([{ ...file.ref, id: done.id }])).status).toBe(200);
      const received = await lab.request("GET", `/attachments/${done.id}`);
      expect(received.status).toBe(200);
      expect(Buffer.from(await received.arrayBuffer())).toEqual(file.bytes);
      const other = await lab.owner.req("POST", "/v2/developer/bots", {
        name: "Other uploader",
      });
      const response = await fetch(
        lab.h.baseUrl +
          `/v2/bot/attachments/uploads/${start.uploadId}/complete`,
        {
          method: "POST",
          headers: {
            authorization: `Bot ${other.token}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(response.status).toBe(404);
    });

    it("uploads native multipart bytes and cancels an owned unfinished session", async () => {
      const file = encrypted(6 * 1024 * 1024);
      const start = await lab.json("POST", "/attachments/uploads", {
        conversationId: lab.channel,
        size: file.bytes.length,
        sha256: file.ref.sha256,
      });
      expect(start.mode).toBe("multipart");
      const parts = Array.from({ length: start.partCount }, (_, i) => {
        const bytes = file.bytes.subarray(
          i * start.partSize,
          (i + 1) * start.partSize,
        );
        return {
          n: i + 1,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("base64"),
          bytes,
        };
      });
      const signed = await lab.json(
        "POST",
        `/attachments/uploads/${start.uploadId}/parts`,
        { parts: parts.map(({ n, size, sha256 }) => ({ n, size, sha256 })) },
      );
      const complete = [];
      for (const part of parts) {
        const upload = signed.parts.find(
          (p: { n: number }) => p.n === part.n,
        ).upload;
        const response = await fetch(upload.url, {
          method: "PUT",
          headers: upload.headers,
          body: part.bytes,
          redirect: "error",
        });
        expect(response.status).toBe(200);
        complete.push({
          n: part.n,
          etag: response.headers.get("etag"),
          sha256: part.sha256,
        });
      }
      expect(
        (await lab.json("GET", `/attachments/uploads/${start.uploadId}/parts`))
          .parts,
      ).toHaveLength(parts.length);
      const done = await lab.json(
        "POST",
        `/attachments/uploads/${start.uploadId}/complete`,
        { parts: complete },
      );
      expect(done.size).toBe(file.bytes.length);
      const pending = await lab.json("POST", "/attachments/uploads", {
        conversationId: lab.channel,
        size: 512,
        sha256: randomBytes(32).toString("base64"),
      });
      await lab.json("DELETE", `/attachments/uploads/${pending.uploadId}`);
      expect(await lab.h.ctx.files.upload(pending.uploadId)).toBeNull();
    });
  },
);

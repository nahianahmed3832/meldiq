import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const serverDir =
  process.env.MELDIQ_INTEROP_SERVER_DIR ?? path.join(repoRoot, "server");
const webDir =
  process.env.MELDIQ_WEB_DIR ?? path.resolve(repoRoot, "../meldiq_web");
const { startServer } = await import(
  pathToFileURL(path.join(serverDir, "test/support/harness.ts")).href
);
const runtimeDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-call-interop-")),
);
fs.copyFileSync(
  path.join(repoRoot, "tools/call-interop/index.html"),
  path.join(runtimeDir, "index.html"),
);
fs.writeFileSync(
  path.join(runtimeDir, "entry.js"),
  fs
    .readFileSync(path.join(repoRoot, "tools/call-interop/entry.js"), "utf8")
    .replace(
      "__WEB_MEDIA_MODULE__",
      "/@fs/" + path.join(webDir, "src/call/livekitSession.ts"),
    ),
);
const h = await startServer({
  MESSAGES_ACCEPT_ENCRYPTED: "false",
  LEGACY_REGISTRATION: "true",
  LIVEKIT_PUBLIC_URL: "ws://127.0.0.1:7898",
  LIVEKIT_API_URL: "http://127.0.0.1:7898",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "test-secret-that-is-at-least-32-characters-long",
});
const { createServer: createViteServer } = await import(
  pathToFileURL(path.join(webDir, "node_modules/vite/dist/node/index.js")).href
);
const { createRequire } = await import("node:module");
const { chromium } = createRequire(path.join(webDir, "package.json"))(
  "@playwright/test",
);
const vite = await createViteServer({
  configFile: false,
  root: runtimeDir,
  define: {
    "process.env.NODE_ENV": JSON.stringify("development"),
    "process.env.MELDIQ_APP_VERSION": JSON.stringify("interop"),
  },
  server: {
    host: "127.0.0.1",
    port: 8096,
    fs: { allow: [runtimeDir, webDir] },
  },
});
await vite.listen();
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const fixtures = new Map();
async function joinMedia(f, media) {
  f.page = await browser.newPage({ permissions: ["microphone", "camera"] });
  await f.page.goto("http://127.0.0.1:8096");
  await f.page.waitForFunction(() => typeof window.joinMedia === "function");
  await f.page.evaluate(
    async ({ media, key }) => await window.joinMedia(media, key),
    { media, key: f.key },
  );
  await f.peer.req("POST", `/v1/calls/${f.callId}/connected`);
}
const server = http.createServer(async (req, res) => {
  try {
    let body = "";
    for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    let out = {};
    if (req.url === "/prepare") {
      const peer = await h.client("webpeer");
      peer.serverMessages = true;
      let cid, code;
      if (b.voice) {
        const org = (
          await peer.req("POST", "/v1/orgs", { name: "Call interoperability" })
        ).org.id;
        code = (
          await peer.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
        ).invite.code;
        cid = (
          await peer.req("POST", `/v1/orgs/${org}/channels`, {
            name: "Meeting",
            scope: "ORG",
            voice: true,
            autoJoin: true,
          })
        ).channel.id;
      } else
        cid = (
          await peer.req("POST", "/v1/conversations/dm", { userId: b.userId })
        ).conversation.id;
      const id = crypto.randomUUID();
      fixtures.set(id, { peer, cid });
      out = { id, conversationId: cid, inviteCode: code ?? null };
    } else {
      const f = fixtures.get(b.id);
      if (!f) throw Error("unknown fixture");
      if (req.url === "/invite") {
        const call = await f.peer.req("POST", "/v1/calls", {
          conversationId: f.cid,
          video: b.media === true,
        });
        f.callId = call.call.id;
        f.key = crypto.randomBytes(32).toString("base64");
        await f.peer.send(
          f.cid,
          {
            type: "call_invite",
            callId: f.callId,
            video: b.media === true,
            e2eeKey: f.key,
          },
          "control",
        );
        if (b.media) await joinMedia(f, call.media);
        out = { callId: f.callId, key: f.key };
      } else if (req.url === "/mediaState") {
        out = await f.page.evaluate(() => window.mediaState);
      } else if (req.url === "/closeMedia") {
        await f.page?.close();
        out = { ok: true };
      } else if (req.url === "/received") {
        const q = await f.peer.req("GET", "/v1/queue?limit=100");
        out = {
          controls: q.items
            .filter((i) => i.kind === "message")
            .map((i) => i.payload.event.payload),
        };
        if (q.items.length)
          await f.peer.req("POST", "/v1/queue/ack", {
            ids: q.items.map((i) => i.id),
          });
      } else if (req.url === "/request") {
        await f.peer.send(
          f.cid,
          { type: "call_key_request", callId: b.callId },
          "control",
        );
        out = { ok: true };
      } else throw Error("unknown operation");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "fixture", message: String(e) } }));
  }
});
server.listen(8097, "127.0.0.1", () =>
  console.log(JSON.stringify({ api: h.baseUrl, fixture: 8097 })),
);
async function close() {
  server.close();
  await browser.close();
  await vite.close();
  await h.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);

import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for Discord's API and image CDN (docs/DISCORD_IMPORT.md), for tests only: OAuth2 code exchange and
 * revocation, the user's servers, and the bot's view of one server. It records every request, so tests can check that
 * Meldiq only ever reads the Discord server (and revokes the user's token).
 */
export const GUILD = "111111111111111111";
export const OTHER_GUILD = "222222222222222222";
export const CLIENT_ID = "123456789012345678";
export const CLIENT_SECRET = "test-client-secret";
export const BOT_TOKEN = "test-bot-token";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

export interface FakeDiscord {
  env: Record<string, string>;
  requests: { method: string; path: string; auth: string | undefined }[];
  revoked: string[];
  /** Codes Discord would accept: code → the user token and the server the bot was added to. */
  codes: Map<string, { token: string; guildId: string | null }>;
  /** Each user token's Discord account and servers. */
  users: Map<string, { id: string; guilds: { id: string; name: string; owner: boolean; permissions: string }[] }>;
  botIn: Set<string>;
  failEmoji: Set<string>;
  /** The next request to this path answers 429 first. */
  rateLimitOnce: Set<string>;
  close(): Promise<void>;
}

export const guildJson = {
  id: GUILD,
  name: "Pixel Club",
  icon: "a1b2c3",
  description: "We make pixel art",
  roles: [
    { id: GUILD, name: "@everyone", color: 0, position: 0, permissions: "104324673", managed: false },
    { id: "300000000000000001", name: "Moderators", color: 0x3498db, position: 3, permissions: String((1n << 1n) | (1n << 2n) | (1n << 40n)), managed: false },
    { id: "300000000000000002", name: "Admins", color: 0xe74c3c, position: 4, permissions: String(1n << 3n), managed: false },
    { id: "300000000000000003", name: "MusicBot", color: 0, position: 2, permissions: "0", managed: true },
  ],
  emojis: [
    { id: "400000000000000001", name: "party_parrot", animated: false, managed: false, available: true },
    { id: "400000000000000002", name: "Wave-Hi", animated: true, managed: false, available: true },
    { id: "400000000000000003", name: "twitch_sub", animated: false, managed: true, available: true },
  ],
};

export const channelsJson = [
  { id: "500000000000000001", type: 4, name: "Info", position: 0, parent_id: null, topic: null, permission_overwrites: [] },
  { id: "500000000000000002", type: 4, name: "Voice", position: 1, parent_id: null, topic: null, permission_overwrites: [] },
  { id: "500000000000000010", type: 5, name: "announcements", position: 0, parent_id: "500000000000000001", topic: "News", permission_overwrites: [] },
  { id: "500000000000000011", type: 0, name: "general", position: 1, parent_id: "500000000000000001", topic: "Say hi", permission_overwrites: [] },
  {
    id: "500000000000000012",
    type: 0,
    name: "staff-only",
    position: 2,
    parent_id: "500000000000000001",
    topic: null,
    permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: String(1n << 10n) }],
  },
  { id: "500000000000000013", type: 15, name: "showcase", position: 3, parent_id: "500000000000000001", topic: null, permission_overwrites: [] },
  { id: "500000000000000020", type: 2, name: "Lounge 🎧", position: 0, parent_id: "500000000000000002", topic: null, permission_overwrites: [] },
  { id: "500000000000000021", type: 13, name: "Stage", position: 1, parent_id: "500000000000000002", topic: null, permission_overwrites: [] },
  { id: "500000000000000030", type: 14, name: "directory", position: 5, parent_id: null, topic: null, permission_overwrites: [] },
];

export async function fakeDiscord(): Promise<FakeDiscord> {
  const fake = {
    requests: [],
    revoked: [],
    codes: new Map(),
    users: new Map(),
    botIn: new Set([GUILD]),
    failEmoji: new Set(),
    rateLimitOnce: new Set(),
  } as unknown as FakeDiscord;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      fake.requests.push({ method: req.method ?? "", path, auth: req.headers.authorization });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (fake.rateLimitOnce.has(path)) {
        fake.rateLimitOnce.delete(path);
        return send(429, { message: "You are being rate limited.", retry_after: 0.05, global: false });
      }
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
      const isBot = req.headers.authorization === `Bot ${BOT_TOKEN}`;
      const basicOk = req.headers.authorization === `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
      if (req.method === "POST" && path === "/api/oauth2/token") {
        const form = new URLSearchParams(raw);
        if (!basicOk || req.headers["content-type"] !== "application/x-www-form-urlencoded" || form.get("grant_type") !== "authorization_code") return send(401, { error: "invalid_client" });
        const grant = fake.codes.get(form.get("code") ?? "");
        if (!grant) return send(400, { error: "invalid_grant" });
        fake.codes.delete(form.get("code")!);
        return send(200, { access_token: grant.token, token_type: "Bearer", scope: "bot identify guilds", expires_in: 604800, ...(grant.guildId ? { guild: { id: grant.guildId, name: "x" } } : {}) });
      }
      if (req.method === "POST" && path === "/api/oauth2/token/revoke") {
        if (!basicOk) return send(401, {});
        fake.revoked.push(new URLSearchParams(raw).get("token") ?? "");
        return send(200, {});
      }
      if (path === "/api/users/@me" && bearer) {
        const u = fake.users.get(bearer);
        return u ? send(200, { id: u.id, username: "someone" }) : send(401, {});
      }
      if (path === "/api/users/@me/guilds" && bearer) {
        const u = fake.users.get(bearer);
        return u ? send(200, u.guilds) : send(401, {});
      }
      if (req.method === "DELETE" && path.startsWith("/api/users/@me/guilds/") && isBot) {
        fake.botIn.delete(path.split("/").pop()!);
        res.writeHead(204);
        return res.end();
      }
      const guildMatch = /^\/api\/guilds\/(\d+)(\/channels)?$/.exec(path);
      if (guildMatch && req.method === "GET") {
        if (!isBot) return send(401, {});
        if (!fake.botIn.has(guildMatch[1])) return send(403, { message: "Missing Access" });
        return send(200, guildMatch[2] ? channelsJson : guildJson);
      }
      if (path.startsWith("/cdn/icons/")) {
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(JPEG);
      }
      const emoji = /^\/cdn\/emojis\/(\d+)\.(png|gif)$/.exec(path);
      if (emoji) {
        if (fake.failEmoji.has(emoji[1])) return send(500, {});
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      send(404, { message: "Unknown" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.env = {
    DISCORD_CLIENT_ID: CLIENT_ID,
    DISCORD_CLIENT_SECRET: CLIENT_SECRET,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_REDIRECT_URI: "http://localhost:5181/discord/callback",
    DISCORD_API_BASE: `${base}/api`,
    DISCORD_CDN_BASE: `${base}/cdn`,
  };
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

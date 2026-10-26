import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../../app/context.js";
import {
  DiscordCallbackBody,
  DiscordDisconnectQuery,
  DiscordIdParams,
  DiscordImportBody,
  DiscordPreviewQuery,
} from "../../../shared/contracts/http/discord.js";
import { ApiError, conflict, notFound } from "../../../shared/errors.js";
import { parse } from "../../../shared/validation/index.js";
import { newId, now, sha256Hex } from "../../../shared/utilities/util.js";
import { me, requireAuth } from "../../auth/index.js";
import { DiscordClient, DiscordError } from "./client.js";
import { checkDestination, type ImportRow, isRunning, limitsFor, loadImport, loadItems, planImport, recordImport, runImport } from "./importer.js";
import { type ImportOptions, managesGuild } from "./mapping.js";

/**
 * Importing a Discord server's structure (docs/DISCORD_IMPORT.md). Off unless the server has a Discord application
 * (DISCORD_* settings): then every route but the status answers discord_not_configured, and the app says so plainly.
 * Each connection and import belongs to the account that made it; nobody else can see or use it.
 */
const STATE_TTL_MS = 10 * 60_000;
const CONNECTION_TTL_MS = 24 * 3600_000;
/** What is never imported, said in the preview so nobody expects it. */
const EXCLUDED = [
  "Messages and message history",
  "Members and their accounts: people join with a Meldiq invitation",
  "Direct messages",
  "Channels Meldiq's bot can't see, and threads",
  "Stickers, soundboard sounds, events, bots and webhooks",
  "Per-person channel permissions",
];

interface ConnectionRow {
  id: string;
  user_id: string;
  guild_id: string;
  guild_name: string;
  discord_user_id: string;
  verified_at: number;
  expires_at: number;
}

export default async function discordRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const auth = { preHandler: requireAuth(ctx) };
  const limited = (max: number) => ({ preHandler: requireAuth(ctx), config: { rateLimit: { max, timeWindow: "1 minute" } } });
  const client = ctx.config.discord ? new DiscordClient(ctx.config.discord) : null;
  const requireClient = (): DiscordClient => {
    if (!client) throw new ApiError(409, "discord_not_configured", "Importing from Discord isn't set up on this server yet.");
    return client;
  };
  // Imports cut short by a restart can be continued with Retry.
  db.prepare("UPDATE discord_imports SET status = 'interrupted', updated_at = ? WHERE status = 'running'").run(now());

  const sweep = () => {
    const t = now();
    db.prepare("DELETE FROM discord_oauth_states WHERE expires_at <= ?").run(t);
    db.prepare("DELETE FROM discord_connections WHERE expires_at <= ?").run(t);
  };
  const connectionOf = (id: string, userId: string): ConnectionRow => {
    sweep();
    const c = db.prepare("SELECT * FROM discord_connections WHERE id = ? AND user_id = ?").get(id, userId) as ConnectionRow | undefined;
    if (!c) throw notFound("That Discord connection has ended. Connect Discord again.");
    return c;
  };
  const importOf = (id: string, userId: string): ImportRow => {
    const imp = loadImport(ctx, id);
    if (!imp || imp.user_id !== userId) throw notFound("Import not found");
    return imp;
  };
  const connectionView = (c: ConnectionRow) => ({ id: c.id, guildId: c.guild_id, guildName: c.guild_name, verifiedAt: c.verified_at, expiresAt: c.expires_at });
  const importView = (imp: ImportRow) => {
    const items = loadItems(ctx, imp.id);
    const count = (s: string) => items.filter((i) => i.status === s).length;
    return {
      id: imp.id,
      guildId: imp.guild_id,
      guildName: imp.guild_name,
      orgId: imp.org_id,
      // A run that isn't in this process any more (crashed mid-way) shows as interrupted, so Retry is offered.
      status: imp.status === "running" && !isRunning(imp.id) ? ("interrupted" as const) : imp.status,
      error: imp.error,
      options: JSON.parse(imp.options) as ImportOptions,
      counts: { total: items.length, done: count("done"), failed: count("failed"), skipped: count("skipped"), pending: count("pending") },
      createdAt: imp.created_at,
      finishedAt: imp.finished_at,
    };
  };
  const discordFailure = (e: unknown): never => {
    if (e instanceof DiscordError) throw new ApiError(502, "discord_unreachable", "Discord didn't answer as expected. Try again in a minute.");
    throw e;
  };

  app.get("/v1/discord/status", auth, async (req) => {
    sweep();
    const rows = db.prepare("SELECT * FROM discord_connections WHERE user_id = ? ORDER BY verified_at DESC LIMIT 20").all(me(req).userId) as ConnectionRow[];
    return { configured: client !== null, connections: rows.map(connectionView) };
  });

  app.post("/v1/discord/connect", limited(10), async (req) => {
    const c = requireClient();
    sweep();
    const state = crypto.randomBytes(32).toString("base64url");
    const t = now();
    db.prepare("INSERT INTO discord_oauth_states (state_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256Hex(state), me(req).userId, t, t + STATE_TTL_MS);
    return { url: c.authorizeUrl(state) };
  });

  app.post("/v1/discord/callback", limited(10), async (req) => {
    const c = requireClient();
    const userId = me(req).userId;
    const body = parse(DiscordCallbackBody, req.body);
    sweep();
    // Single use, this account's own, unexpired: otherwise someone else's Discord sign-in could be attached here.
    const used = db.prepare("DELETE FROM discord_oauth_states WHERE state_hash = ? AND user_id = ? AND expires_at > ?").run(sha256Hex(body.state), userId, now());
    if (used.changes !== 1) throw new ApiError(400, "bad_request", "That Discord sign-in has expired or wasn't started here. Connect Discord again.");
    const { accessToken, guildId: tokenGuild } = await c.exchangeCode(body.code).catch(discordFailure);
    let discordUserId: string;
    let guildId: string | null;
    try {
      // Discord's token answer names the server the bot was added to; the redirect's guild_id is only a hint.
      guildId = tokenGuild ?? body.guildId ?? null;
      if (!guildId) throw new ApiError(400, "bad_request", "Choose a server when Discord asks where to add Meldiq's bot.");
      if (body.guildId && tokenGuild && body.guildId !== tokenGuild) throw new ApiError(400, "bad_request", "Discord and the address disagree about which server was chosen.");
      const [id, guilds] = await Promise.all([c.userId(accessToken), c.userGuilds(accessToken)]);
      discordUserId = id;
      const g = guilds.find((x) => x.id === guildId);
      if (!g || !managesGuild(g.owner, g.permissions)) throw new ApiError(403, "discord_not_allowed", "You need to own that Discord server or have Manage Server there to import it.");
    } catch (e) {
      return discordFailure(e);
    } finally {
      await c.revoke(accessToken);
    }
    const guild = await c.guild(guildId).catch(discordFailure);
    if (!guild) throw new ApiError(409, "discord_bot_missing", "Meldiq's bot wasn't added to that server. Connect Discord again and allow it.");
    const id = newId("dcon");
    const t = now();
    db.prepare("INSERT INTO discord_connections (id, user_id, guild_id, guild_name, discord_user_id, verified_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      userId,
      guild.id,
      guild.name,
      discordUserId,
      t,
      t + CONNECTION_TTL_MS,
    );
    ctx.audit({ actorId: userId, action: "discord.connect", target: id, detail: `guild ${guild.id}` });
    return { connection: connectionView(db.prepare("SELECT * FROM discord_connections WHERE id = ?").get(id) as ConnectionRow) };
  });

  app.delete("/v1/discord/connections/:id", limited(10), async (req) => {
    const userId = me(req).userId;
    const conn = connectionOf(parse(DiscordIdParams, req.params).id, userId);
    const { leave } = parse(DiscordDisconnectQuery, req.query);
    db.prepare("DELETE FROM discord_connections WHERE id = ?").run(conn.id);
    let botLeft = false;
    // The bot stays while anyone else still has this server connected or an import of it is running.
    const inUse =
      db.prepare("SELECT 1 FROM discord_connections WHERE guild_id = ? AND expires_at > ?").get(conn.guild_id, now()) ||
      db.prepare("SELECT 1 FROM discord_imports WHERE guild_id = ? AND status = 'running'").get(conn.guild_id);
    if (leave === "true" && client && !inUse) {
      await client.leave(conn.guild_id).catch(discordFailure);
      botLeft = true;
    }
    ctx.audit({ actorId: userId, action: "discord.disconnect", target: conn.id, detail: botLeft ? "bot left" : undefined });
    return { ok: true as const, botLeft };
  });

  app.get("/v1/discord/connections/:id/preview", limited(20), async (req) => {
    const c = requireClient();
    const userId = me(req).userId;
    const conn = connectionOf(parse(DiscordIdParams, req.params).id, userId);
    const dest = parse(DiscordPreviewQuery, req.query).orgId ?? null;
    if (dest && !ctx.authz.orgRole(dest, userId)) throw notFound("Community not found");
    const guild = await c.guild(conn.guild_id).catch(discordFailure);
    if (!guild) throw new ApiError(409, "discord_bot_missing", "Meldiq's Discord bot isn't in that server any more. Connect Discord again to add it.");
    const channels = await c.channels(conn.guild_id).catch(discordFailure);
    const all: ImportOptions = { icon: true, roles: true, rolePermissions: true, channels: true, emojis: true };
    const items = planImport(guild, channels, all, limitsFor(ctx, dest)).map((i) => ({
      key: i.sourceKey,
      kind: i.kind,
      name: i.name,
      action: i.spec ? ("create" as const) : ("skip" as const),
      note: i.note,
    }));
    return { guild: { id: guild.id, name: guild.name, description: guild.description }, items, excluded: EXCLUDED };
  });

  app.post("/v1/discord/imports", limited(5), async (req, reply) => {
    const c = requireClient();
    const userId = me(req).userId;
    const body = parse(DiscordImportBody, req.body);
    const conn = connectionOf(body.connectionId, userId);
    if (db.prepare("SELECT 1 FROM discord_imports WHERE user_id = ? AND guild_id = ? AND status = 'running'").get(userId, conn.guild_id)) {
      throw conflict("This server is already being imported: wait for it to finish");
    }
    const orgId = checkDestination(ctx, userId, body.destination, body.options);
    const guild = await c.guild(conn.guild_id).catch(discordFailure);
    if (!guild) throw new ApiError(409, "discord_bot_missing", "Meldiq's Discord bot isn't in that server any more. Connect Discord again to add it.");
    const channels = body.options.channels ? await c.channels(conn.guild_id).catch(discordFailure) : [];
    const plan = planImport(guild, channels, body.options, limitsFor(ctx, orgId));
    const imp = recordImport(ctx, userId, guild, body.destination, orgId, body.options, plan);
    void runImport(ctx, c, imp.id);
    reply.code(202);
    return { import: importView(loadImport(ctx, imp.id)!) };
  });

  app.get("/v1/discord/imports/:id", auth, async (req) => {
    const imp = importOf(parse(DiscordIdParams, req.params).id, me(req).userId);
    return {
      import: importView(imp),
      items: loadItems(ctx, imp.id).map((i) => ({ key: i.source_key, kind: i.kind, name: i.name, status: i.status, note: i.note })),
    };
  });

  app.post("/v1/discord/imports/:id/retry", limited(10), async (req, reply) => {
    const c = requireClient();
    const imp = importOf(parse(DiscordIdParams, req.params).id, me(req).userId);
    if (isRunning(imp.id)) throw conflict("This import is still running");
    if (imp.org_id && !ctx.authz.orgRole(imp.org_id, imp.user_id)) throw conflict("You're no longer in the community this import went to");
    db.prepare("UPDATE discord_imports SET status = 'running', error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?").run(now(), imp.id);
    void runImport(ctx, c, imp.id);
    reply.code(202);
    return { import: importView(loadImport(ctx, imp.id)!) };
  });
}

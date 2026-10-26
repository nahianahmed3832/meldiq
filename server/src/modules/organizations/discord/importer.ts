import crypto from "node:crypto";
import type { AppContext } from "../../../app/context.js";
import { ApiError, conflict, forbidden, notFound } from "../../../shared/errors.js";
import { newId, now } from "../../../shared/utilities/util.js";
import { MAX_PHOTO_BYTES, photoBlobId, storePhoto } from "../../accounts/index.js";
import { deleteBlobNow } from "../../files/index.js";
import { channelCounts, insertCategory, insertChannel } from "../communityStart.js";
import { EXPRESSION_LIMITS, imageKind } from "../expressionsRoutes.js";
import { CHANNEL_LIMITS, notifyConversation, notifyOrg, slugify } from "../orgsRoutes.js";
import { MAX_ACTIVE_ROLES } from "../rolesRoutes.js";
import { markSyntheticOrg } from "../syntheticScope.js";
import type { Permission } from "../permissions/catalog.js";
import { type DiscordClient, DiscordError } from "./client.js";
import { type ImportOptions, type ItemSpec, type PlanItem, planImport, type PlanLimits } from "./mapping.js";

/**
 * Carrying out an import (docs/DISCORD_IMPORT.md). The plan is written down first, one row per item; each item is then
 * made once and marked with what it became, so a retry (after a Discord hiccup, or a restart) continues where it
 * stopped and never makes a second community, role or channel. The Discord server itself is only read.
 */

export type ImportStatus = "running" | "completed" | "completed_with_errors" | "failed" | "interrupted";
export type ItemStatus = "pending" | "done" | "failed" | "skipped";

export interface ImportRow {
  id: string;
  user_id: string;
  guild_id: string;
  guild_name: string;
  org_id: string | null;
  new_name: string | null;
  options: string;
  status: ImportStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface ItemRow {
  import_id: string;
  source_key: string;
  position: number;
  kind: PlanItem["kind"];
  name: string;
  spec: string;
  status: ItemStatus;
  target_id: string | null;
  note: string | null;
}

export type Destination = { orgId: string } | { name: string };

/** What the person needs in an existing community for each part they chose (owners and admins have all of them). */
const NEEDS: readonly [keyof ImportOptions, Permission, string][] = [
  ["icon", "workspace.edit", "change the community's photo"],
  ["roles", "roles.manage", "create roles"],
  ["channels", "channels.create", "create channels"],
  ["emojis", "expressions.manage", "add emoji"],
];

/** Meldiq's limits, less what an existing community already has. */
export function limitsFor(ctx: AppContext, orgId: string | null): PlanLimits {
  if (!orgId) return { channelsPerCategory: CHANNEL_LIMITS.perCategory, channels: CHANNEL_LIMITS.perCommunity, roles: MAX_ACTIVE_ROLES, emoji: EXPRESSION_LIMITS.emoji };
  const roles = (ctx.db.prepare("SELECT COUNT(*) n FROM org_roles WHERE org_id = ? AND archived_at IS NULL").get(orgId) as { n: number }).n;
  const emoji = (ctx.db.prepare("SELECT COUNT(*) n FROM community_expressions WHERE org_id = ? AND kind = 'emoji'").get(orgId) as { n: number }).n;
  return {
    channelsPerCategory: CHANNEL_LIMITS.perCategory,
    channels: Math.max(0, CHANNEL_LIMITS.perCommunity - channelCounts(ctx, orgId, null).total),
    roles: Math.max(0, MAX_ACTIVE_ROLES - roles),
    emoji: Math.max(0, EXPRESSION_LIMITS.emoji - emoji),
  };
}

/** Refuses a destination the person can't import into; returns the existing community's id, or null for a new one. */
export function checkDestination(ctx: AppContext, userId: string, dest: Destination, options: ImportOptions): string | null {
  if ("name" in dest) {
    const sameName = ctx.db
      .prepare("SELECT o.id FROM orgs o JOIN org_members m ON m.org_id = o.id AND m.user_id = ? AND m.role = 'OWNER' WHERE lower(trim(o.name)) = lower(trim(?)) LIMIT 1")
      .get(userId, dest.name) as { id: string } | undefined;
    if (sameName) throw new ApiError(409, "org_name_taken", `You already own a community called "${dest.name.trim()}". Choose another name, or import into it.`, { orgId: sameName.id });
    return null;
  }
  const role = ctx.authz.orgRole(dest.orgId, userId);
  if (!role) throw notFound("Community not found");
  for (const [part, permission, what] of NEEDS) {
    if (options[part] && !ctx.authz.can(dest.orgId, userId, permission)) throw forbidden(`Your role here can't ${what}: leave that part out, or ask an owner`);
  }
  return dest.orgId;
}

/** Writes the import and its plan (nothing is made yet). */
export function recordImport(
  ctx: AppContext,
  userId: string,
  guild: { id: string; name: string },
  dest: Destination,
  orgId: string | null,
  options: ImportOptions,
  plan: readonly PlanItem[],
): ImportRow {
  const id = newId("dimp");
  const t = now();
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        "INSERT INTO discord_imports (id, user_id, guild_id, guild_name, org_id, new_name, options, status, error, created_at, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, NULL)",
      )
      .run(id, userId, guild.id, guild.name, orgId, "name" in dest ? dest.name.trim() : null, JSON.stringify(options), t, t);
    const insert = ctx.db.prepare(
      "INSERT INTO discord_import_items (import_id, source_key, position, kind, name, spec, status, target_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    );
    plan.forEach((item, i) => insert.run(id, item.sourceKey, i, item.kind, item.name, JSON.stringify(item.spec), item.spec ? "pending" : "skipped", item.note));
  })();
  return loadImport(ctx, id)!;
}

export const loadImport = (ctx: AppContext, id: string): ImportRow | undefined => ctx.db.prepare("SELECT * FROM discord_imports WHERE id = ?").get(id) as ImportRow | undefined;
export const loadItems = (ctx: AppContext, id: string): ItemRow[] => ctx.db.prepare("SELECT * FROM discord_import_items WHERE import_id = ? ORDER BY position").all(id) as ItemRow[];

/** Imports being carried out in this process: one run per import at a time. */
const running = new Set<string>();

export const isRunning = (id: string): boolean => running.has(id);

/** Makes every pending (or failed, on a retry) item, in order. Never throws: the outcome is written to the import. */
export async function runImport(ctx: AppContext, client: DiscordClient, importId: string): Promise<void> {
  if (running.has(importId)) return;
  running.add(importId);
  try {
    await carryOut(ctx, client, importId);
  } catch (e) {
    ctx.log.error({ err: e, importId }, "discord import stopped");
    ctx.db.prepare("UPDATE discord_imports SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(messageOf(e), now(), now(), importId);
  } finally {
    running.delete(importId);
  }
}

async function carryOut(ctx: AppContext, client: DiscordClient, importId: string): Promise<void> {
  const imp = loadImport(ctx, importId);
  if (!imp) return;
  const orgId = imp.org_id ?? createCommunity(ctx, imp);
  const made: Record<string, string> = {};
  for (const item of loadItems(ctx, importId)) {
    if (item.status === "done" && item.target_id) made[item.source_key] = item.target_id;
  }
  const createdChannels: string[] = [];
  for (const item of loadItems(ctx, importId)) {
    if (item.status !== "pending" && item.status !== "failed") continue;
    // The community may have gone (deleted mid-import): stop rather than write into nothing.
    if (!ctx.db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(orgId)) throw new Error("The community was deleted during the import");
    const spec = JSON.parse(item.spec) as ItemSpec;
    try {
      const target = await makeItem(ctx, client, imp.user_id, orgId, spec, made);
      made[item.source_key] = target;
      if (spec.kind === "channel") createdChannels.push(target);
      mark(ctx, importId, item.source_key, "done", target, item.note);
    } catch (e) {
      mark(ctx, importId, item.source_key, "failed", null, messageOf(e));
    }
  }
  for (const id of createdChannels) notifyConversation(ctx, id);
  notifyOrg(ctx, orgId);
  const items = loadItems(ctx, importId);
  const failed = items.filter((i) => i.status === "failed").length;
  const done = items.filter((i) => i.status === "done").length;
  const t = now();
  ctx.db
    .prepare("UPDATE discord_imports SET status = ?, error = NULL, updated_at = ?, finished_at = ? WHERE id = ?")
    .run(failed ? "completed_with_errors" : "completed", t, t, importId);
  ctx.audit({ actorId: imp.user_id, orgId, action: "discord.import", target: importId, detail: `${done} made, ${failed} failed` });
}

function mark(ctx: AppContext, importId: string, key: string, status: ItemStatus, targetId: string | null, note: string | null): void {
  ctx.db.prepare("UPDATE discord_import_items SET status = ?, target_id = ?, note = ? WHERE import_id = ? AND source_key = ?").run(status, targetId, note, importId, key);
  ctx.db.prepare("UPDATE discord_imports SET updated_at = ? WHERE id = ?").run(now(), importId);
}

/** The new, private, invite-only community, owned by the person importing; recorded at once so a retry reuses it. */
function createCommunity(ctx: AppContext, imp: ImportRow): string {
  const { db } = ctx;
  const id = newId("o");
  const t = now();
  const name = (imp.new_name ?? imp.guild_name).trim().slice(0, 80) || "Community";
  let slug = slugify(name);
  if (db.prepare("SELECT 1 FROM orgs WHERE slug = ?").get(slug)) slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO orgs (id, name, slug, description, created_by, created_at, updated_at, create_request_id, kind, visibility, join_policy, rules)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'community', 'private', 'invite', NULL)`,
    ).run(id, name, slug, imp.user_id, t, t, `discord:${imp.id}`);
    db.prepare("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'OWNER', ?)").run(id, imp.user_id, t);
    markSyntheticOrg(db, id, imp.user_id);
    db.prepare("UPDATE discord_imports SET org_id = ?, updated_at = ? WHERE id = ?").run(id, t, imp.id);
  })();
  ctx.audit({ actorId: imp.user_id, orgId: id, action: "org.create", target: id, detail: "visibility=private, from Discord" });
  return id;
}

async function makeItem(ctx: AppContext, client: DiscordClient, userId: string, orgId: string, spec: ItemSpec, made: Record<string, string>): Promise<string> {
  const { db } = ctx;
  switch (spec.kind) {
    case "icon": {
      const buf = await client.image("icon", spec.guildId, spec.hash);
      if (buf.length > MAX_PHOTO_BYTES || !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new Error("Discord's icon wasn't a usable JPEG");
      const previous = (db.prepare("SELECT photo_rev FROM orgs WHERE id = ?").get(orgId) as { photo_rev: number | null }).photo_rev;
      const rev = Math.max(now(), (previous ?? 0) + 1);
      await storePhoto(ctx, photoBlobId(orgId, rev), buf);
      db.prepare("UPDATE orgs SET photo_rev = ?, updated_at = ? WHERE id = ?").run(rev, now(), orgId);
      if (previous) await deleteBlobNow(ctx, "profile-photos", photoBlobId(orgId, previous));
      return `photo:${rev}`;
    }
    case "role": {
      return db.transaction(() => {
        const existing = db.prepare("SELECT id FROM org_roles WHERE org_id = ? AND lower(name) = lower(?) AND archived_at IS NULL").get(orgId, spec.name) as { id: string } | undefined;
        if (existing) throw conflict(`A role called "${spec.name}" already exists here`);
        const active = (db.prepare("SELECT COUNT(*) n FROM org_roles WHERE org_id = ? AND archived_at IS NULL").get(orgId) as { n: number }).n;
        if (active >= MAX_ACTIVE_ROLES) throw conflict(`A community can have at most ${MAX_ACTIVE_ROLES} active roles`);
        ctx.entitlements.check("roles.custom", active, orgId);
        const id = newId("rl");
        const t = now();
        const position = ((db.prepare("SELECT MAX(position) p FROM org_roles WHERE org_id = ?").get(orgId) as { p: number | null }).p ?? 0) + 1;
        db.prepare(
          `INSERT INTO org_roles (id, org_id, name, description, color, icon, permissions, denies, template, position, hoist, rev, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'From Discord', ?, NULL, ?, '[]', NULL, ?, 0, 1, ?, ?, ?)`,
        ).run(id, orgId, spec.name, spec.color, JSON.stringify(spec.permissions), position, userId, t, t);
        ctx.audit({ actorId: userId, orgId, action: "role.create", target: id, detail: `${spec.name} (from Discord)` });
        return id;
      })();
    }
    case "category":
      return db.transaction(() => insertCategory(ctx, orgId, userId, spec.name, spec.position))();
    case "channel": {
      // Under its category if that was made; otherwise at the top level.
      const categoryId = spec.parentKey ? (made[spec.parentKey] ?? null) : null;
      return db.transaction(() => {
        const counts = channelCounts(ctx, orgId, categoryId);
        if (counts.total >= CHANNEL_LIMITS.perCommunity) throw conflict(`A community has at most ${CHANNEL_LIMITS.perCommunity} channels`);
        if (categoryId && counts.inCategory >= CHANNEL_LIMITS.perCategory) throw conflict(`A category holds at most ${CHANNEL_LIMITS.perCategory} channels`);
        const kind = spec.voice && spec.channelKind === "ANNOUNCEMENT" ? "PUBLIC" : spec.channelKind;
        const id = insertChannel(ctx, orgId, userId, { name: spec.name, topic: spec.topic, kind, voice: spec.voice, format: spec.voice ? "text" : spec.format, categoryId, position: spec.position });
        ctx.audit({ actorId: userId, orgId, action: spec.voice ? "voice_room.create" : "channel.create", target: id, detail: `${kind} ${spec.name} (from Discord)` });
        return id;
      })();
    }
    case "emoji": {
      const taken = () => db.prepare("SELECT 1 FROM community_expressions WHERE org_id = ? AND kind = 'emoji' AND name = ?").get(orgId, spec.name);
      if (taken()) throw conflict(`An emoji called :${spec.name}: already exists here`);
      const buf = await client.image("emoji", spec.emojiId, null, spec.animated);
      if (buf.length > EXPRESSION_LIMITS.bytes) throw new Error("Larger than Meldiq's 256 KB for emoji");
      const kind = imageKind(buf);
      if (!kind) throw new Error("Not a PNG, GIF or WebP image");
      const id = newId("emj");
      await storePhoto(ctx, id, buf);
      try {
        db.transaction(() => {
          const count = (db.prepare("SELECT COUNT(*) n FROM community_expressions WHERE org_id = ? AND kind = 'emoji'").get(orgId) as { n: number }).n;
          if (count >= EXPRESSION_LIMITS.emoji) throw conflict(`A community has room for ${EXPRESSION_LIMITS.emoji} emoji`);
          if (taken()) throw conflict(`An emoji called :${spec.name}: already exists here`);
          db.prepare(
            "INSERT INTO community_expressions (id, org_id, kind, name, mime, animated, sha256, size, created_by, created_at) VALUES (?, ?, 'emoji', ?, ?, ?, ?, ?, ?, ?)",
          ).run(id, orgId, spec.name, kind.mime, kind.animated ? 1 : 0, crypto.createHash("sha256").update(buf).digest("hex"), buf.length, userId, now());
        })();
      } catch (e) {
        await deleteBlobNow(ctx, "profile-photos", id);
        throw e;
      }
      ctx.audit({ actorId: userId, orgId, action: "expression.add", target: id, detail: `emoji :${spec.name}: (from Discord)` });
      return id;
    }
  }
}

/** A message safe to show: Meldiq's own errors and Discord problems say what happened; anything else stays generic. */
function messageOf(e: unknown): string {
  if (e instanceof ApiError || e instanceof DiscordError) return e.message;
  if (e instanceof Error && /^(Discord|Not a|Larger|The community)/.test(e.message)) return e.message;
  return "Something went wrong making this";
}

export { planImport };

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
import type { RowReader } from "../../../infrastructure/database/rows/index.js";
import { foldAscii } from "../../../shared/utilities/sqlText.js";
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
  const roles = ctx.ws.count("org_roles", { org_id: orgId, archived_at: null });
  const emoji = ctx.ws.count("community_expressions", { org_id: orgId, kind: "emoji" });
  return {
    channelsPerCategory: CHANNEL_LIMITS.perCategory,
    channels: Math.max(0, CHANNEL_LIMITS.perCommunity - channelCounts(ctx.ws, orgId, null).total),
    roles: Math.max(0, MAX_ACTIVE_ROLES - roles),
    emoji: Math.max(0, EXPRESSION_LIMITS.emoji - emoji),
  };
}

/** Refuses a destination the person can't import into; returns the existing community's id, or null for a new one. */
export function checkDestination(ctx: AppContext, userId: string, dest: Destination, options: ImportOptions): string | null {
  if ("name" in dest) {
    const owned = ctx.ws.all<{ org_id: string }>("org_members", { where: { user_id: userId, role: "OWNER" } }).map((m) => m.org_id);
    const wanted = foldAscii(dest.name.trim());
    const sameName = ctx.ws.all<{ id: string; name: string }>("orgs", { where: { id: { in: owned } } }).find((o) => foldAscii(o.name.trim()) === wanted);
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
export async function recordImport(
  ctx: AppContext,
  userId: string,
  guild: { id: string; name: string },
  dest: Destination,
  orgId: string | null,
  options: ImportOptions,
  plan: readonly PlanItem[],
): Promise<ImportRow> {
  const id = newId("dimp");
  const t = now();
  await ctx.ws.write((w) => {
    w.insert("discord_imports", {
      id,
      user_id: userId,
      guild_id: guild.id,
      guild_name: guild.name,
      org_id: orgId,
      new_name: "name" in dest ? dest.name.trim() : null,
      options: JSON.stringify(options),
      status: "running",
      error: null,
      created_at: t,
      updated_at: t,
      finished_at: null,
    });
    plan.forEach((item, i) =>
      w.insert("discord_import_items", {
        import_id: id,
        source_key: item.sourceKey,
        position: i,
        kind: item.kind,
        name: item.name,
        spec: JSON.stringify(item.spec),
        status: item.spec ? "pending" : "skipped",
        target_id: null,
        note: item.note,
      }),
    );
  });
  return loadImport(ctx, id)!;
}

export const loadImport = (ctx: Pick<AppContext, "ws">, id: string): ImportRow | undefined => ctx.ws.get<ImportRow>("discord_imports", { id });
export const loadItems = (ctx: Pick<AppContext, "ws">, id: string): ItemRow[] =>
  ctx.ws.all<ItemRow>("discord_import_items", { where: { import_id: id }, orderBy: [["position", "asc"]] });

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
    await ctx.ws
      .write((w) => w.update("discord_imports", { id: importId }, { status: "failed", error: messageOf(e), updated_at: now(), finished_at: now() }))
      .catch((err) => ctx.log.error({ err, importId }, "discord import: recording the failure failed"));
  } finally {
    running.delete(importId);
  }
}

async function carryOut(ctx: AppContext, client: DiscordClient, importId: string): Promise<void> {
  const imp = loadImport(ctx, importId);
  if (!imp) return;
  const orgId = imp.org_id ?? (await createCommunity(ctx, imp));
  const made: Record<string, string> = {};
  for (const item of loadItems(ctx, importId)) {
    if (item.status === "done" && item.target_id) made[item.source_key] = item.target_id;
  }
  const createdChannels: string[] = [];
  for (const item of loadItems(ctx, importId)) {
    if (item.status !== "pending" && item.status !== "failed") continue;
    // The community may have gone (deleted mid-import): stop rather than write into nothing.
    if (!ctx.ws.get("orgs", { id: orgId })) throw new Error("The community was deleted during the import");
    const spec = JSON.parse(item.spec) as ItemSpec;
    try {
      const target = await makeItem(ctx, client, imp.user_id, orgId, spec, made);
      made[item.source_key] = target;
      if (spec.kind === "channel") createdChannels.push(target);
      await mark(ctx, importId, item.source_key, "done", target, item.note);
    } catch (e) {
      await mark(ctx, importId, item.source_key, "failed", null, messageOf(e));
    }
  }
  for (const id of createdChannels) notifyConversation(ctx, id);
  notifyOrg(ctx, orgId);
  const items = loadItems(ctx, importId);
  const failed = items.filter((i) => i.status === "failed").length;
  const done = items.filter((i) => i.status === "done").length;
  const t = now();
  await ctx.ws.write((w) => w.update("discord_imports", { id: importId }, { status: failed ? "completed_with_errors" : "completed", error: null, updated_at: t, finished_at: t }));
  ctx.audit({ actorId: imp.user_id, orgId, action: "discord.import", target: importId, detail: `${done} made, ${failed} failed` });
}

async function mark(ctx: AppContext, importId: string, key: string, status: ItemStatus, targetId: string | null, note: string | null): Promise<void> {
  await ctx.ws.write((w) => {
    w.update("discord_import_items", { import_id: importId, source_key: key }, { status, target_id: targetId, note });
    w.update("discord_imports", { id: importId }, { updated_at: now() });
  });
}

/** The new, private, invite-only community, owned by the person importing; recorded at once so a retry reuses it. */
async function createCommunity(ctx: AppContext, imp: ImportRow): Promise<string> {
  const { db, ws } = ctx;
  const id = newId("o");
  const t = now();
  const name = (imp.new_name ?? imp.guild_name).trim().slice(0, 80) || "Community";
  let slug = slugify(name);
  if (ws.get("orgs", { slug })) slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  await ws.write((w) => {
    w.insert("orgs", {
      id,
      name,
      slug,
      description: null,
      created_by: imp.user_id,
      created_at: t,
      updated_at: t,
      create_request_id: `discord:${imp.id}`,
      kind: "community",
      visibility: "private",
      join_policy: "invite",
      rules: null,
    });
    w.insert("org_members", { org_id: id, user_id: imp.user_id, role: "OWNER", joined_at: t });
    markSyntheticOrg(db, w, id, imp.user_id);
    w.update("discord_imports", { id: imp.id }, { org_id: id, updated_at: t });
  });
  ctx.audit({ actorId: imp.user_id, orgId: id, action: "org.create", target: id, detail: "visibility=private, from Discord" });
  return id;
}

async function makeItem(ctx: AppContext, client: DiscordClient, userId: string, orgId: string, spec: ItemSpec, made: Record<string, string>): Promise<string> {
  const { ws } = ctx;
  switch (spec.kind) {
    case "icon": {
      const buf = await client.image("icon", spec.guildId, spec.hash);
      if (buf.length > MAX_PHOTO_BYTES || !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new Error("Discord's icon wasn't a usable JPEG");
      const previous = ws.get<{ photo_rev: number | null }>("orgs", { id: orgId })!.photo_rev;
      const rev = Math.max(now(), (previous ?? 0) + 1);
      await storePhoto(ctx, photoBlobId(orgId, rev), buf);
      await ws.write((w) => w.update("orgs", { id: orgId }, { photo_rev: rev, updated_at: now() }));
      if (previous) await deleteBlobNow(ctx, "profile-photos", photoBlobId(orgId, previous));
      return `photo:${rev}`;
    }
    case "role": {
      return ws.write((w) => {
        const active = w.all<{ name: string }>("org_roles", { where: { org_id: orgId, archived_at: null } });
        if (active.some((r) => foldAscii(r.name) === foldAscii(spec.name))) throw conflict(`A role called "${spec.name}" already exists here`);
        if (active.length >= MAX_ACTIVE_ROLES) throw conflict(`A community can have at most ${MAX_ACTIVE_ROLES} active roles`);
        ctx.entitlements.check("roles.custom", active.length, orgId);
        const id = newId("rl");
        const t = now();
        const last = w.get<{ position: number }>("org_roles", { org_id: orgId }, [["position", "desc"]]);
        w.insert("org_roles", {
          id,
          org_id: orgId,
          name: spec.name,
          description: "From Discord",
          color: spec.color,
          icon: null,
          permissions: JSON.stringify(spec.permissions),
          denies: "[]",
          template: null,
          position: (last?.position ?? 0) + 1,
          hoist: 0,
          rev: 1,
          created_by: userId,
          created_at: t,
          updated_at: t,
        });
        ctx.audit({ actorId: userId, orgId, action: "role.create", target: id, detail: `${spec.name} (from Discord)` });
        return id;
      });
    }
    case "category":
      return ws.write((w) => insertCategory(w, orgId, userId, spec.name, spec.position));
    case "channel": {
      // Under its category if that was made; otherwise at the top level.
      const categoryId = spec.parentKey ? (made[spec.parentKey] ?? null) : null;
      return ws.write((w) => {
        const counts = channelCounts(w, orgId, categoryId);
        if (counts.total >= CHANNEL_LIMITS.perCommunity) throw conflict(`A community has at most ${CHANNEL_LIMITS.perCommunity} channels`);
        if (categoryId && counts.inCategory >= CHANNEL_LIMITS.perCategory) throw conflict(`A category holds at most ${CHANNEL_LIMITS.perCategory} channels`);
        const kind = spec.voice && spec.channelKind === "ANNOUNCEMENT" ? "PUBLIC" : spec.channelKind;
        const id = insertChannel(ctx, w, orgId, userId, { name: spec.name, topic: spec.topic, kind, voice: spec.voice, format: spec.voice ? "text" : spec.format, categoryId, position: spec.position });
        ctx.audit({ actorId: userId, orgId, action: spec.voice ? "voice_room.create" : "channel.create", target: id, detail: `${kind} ${spec.name} (from Discord)` });
        return id;
      });
    }
    case "emoji": {
      const taken = (rows: RowReader = ws) => !!rows.get("community_expressions", { org_id: orgId, kind: "emoji", name: spec.name });
      if (taken()) throw conflict(`An emoji called :${spec.name}: already exists here`);
      const buf = await client.image("emoji", spec.emojiId, null, spec.animated);
      if (buf.length > EXPRESSION_LIMITS.bytes) throw new Error("Larger than Meldiq's 256 KB for emoji");
      const kind = imageKind(buf);
      if (!kind) throw new Error("Not a PNG, GIF or WebP image");
      const id = newId("emj");
      await storePhoto(ctx, id, buf);
      try {
        await ws.write((w) => {
          const count = w.count("community_expressions", { org_id: orgId, kind: "emoji" });
          if (count >= EXPRESSION_LIMITS.emoji) throw conflict(`A community has room for ${EXPRESSION_LIMITS.emoji} emoji`);
          if (taken(w)) throw conflict(`An emoji called :${spec.name}: already exists here`);
          w.insert("community_expressions", {
            id,
            org_id: orgId,
            kind: "emoji",
            name: spec.name,
            mime: kind.mime,
            animated: kind.animated ? 1 : 0,
            sha256: crypto.createHash("sha256").update(buf).digest("hex"),
            size: buf.length,
            created_by: userId,
            created_at: now(),
          });
        });
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

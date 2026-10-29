import type { ErrorCode } from "../../../shared/errors.js";
import type { OrgRole } from "../authz.js";
import { type Permission, permissionDef } from "./catalog.js";

/**
 * Channel and category permissions (docs/COMMUNITY_REBUILD_2026-10-21.md §5). Pure: no database access, so the routes,
 * the tests and the app's mirror can be compared line by line.
 *
 * A community member's permissions in a channel are their community permissions (base role and custom roles), changed
 * by the overwrites on the channel's category and then on the channel itself. At each level: @everyone's deny, then
 * @everyone's allow, then the denies of every role the person holds, then their allows, then the person's own deny and
 * allow. Owners and admins skip overwrites (someone can always fix a mistake). A custom role's restrictions ("read-only
 * member") are community-wide and still win afterwards, so no channel can lift them.
 */

/**
 * What an overwrite can change. `channels.create` matters on categories: creating channels inside that category.
 * `voice.connect` and `voice.speak` matter on voice channels: joining their call, and talking in it (listen-only without).
 * `voice.mute_members` and `voice.move_members` (community parity A2): muting and disconnecting people in that call.
 */
export const CHANNEL_CAPABILITIES = [
  "channels.view",
  "messages.post",
  "messages.attach",
  "messages.announce",
  "channels.manage",
  "channels.create",
  "voice.connect",
  "voice.speak",
  // Community parity A1 (feature "community-permissions"): message powers that can differ per channel.
  "messages.react",
  "messages.embed",
  "messages.voice",
  "messages.external_emoji",
  "messages.polls",
  "messages.big_text",
  "messages.mention_all",
  "messages.manage",
  "messages.history",
  "threads.create",
  "threads.post",
  "threads.manage",
  "voice.mute_members",
  "voice.move_members",
] as const;
export type ChannelCapability = (typeof CHANNEL_CAPABILITIES)[number];

export const EVERYONE = "everyone";
/** A member overwrite's subject: "user:<userId>". */
export const USER_PREFIX = "user:";

export interface Overwrite {
  /** "everyone", a custom role id, or "user:<userId>". */
  subject: string;
  allow: readonly ChannelCapability[];
  deny: readonly ChannelCapability[];
}

export function isChannelCapability(key: string): key is ChannelCapability {
  return (CHANNEL_CAPABILITIES as readonly string[]).includes(key);
}

/** Stored capability lists come from validated routes; anything unknown (a key from a newer server) is ignored. */
export function parseCapabilities(json: string): ChannelCapability[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((k): k is ChannelCapability => typeof k === "string" && isChannelCapability(k)) : [];
  } catch {
    return [];
  }
}

export interface ChannelActor {
  base: OrgRole;
  userId: string;
  /** Community permissions (base role plus custom roles, minus their restrictions). */
  perms: ReadonlySet<Permission>;
  /** Custom role ids the person holds (active roles only). */
  roleIds: readonly string[];
  /** Restrictions from the person's custom roles: they win over any channel overwrite. */
  restricted: ReadonlySet<Permission>;
}

function applyLevel(out: Set<Permission>, level: readonly Overwrite[], actor: ChannelActor): void {
  const everyone = level.find((o) => o.subject === EVERYONE);
  const mine = level.filter((o) => actor.roleIds.includes(o.subject));
  const personal = level.find((o) => o.subject === USER_PREFIX + actor.userId);
  const steps: [readonly ChannelCapability[], boolean][] = [
    [everyone?.deny ?? [], false],
    [everyone?.allow ?? [], true],
    [mine.flatMap((o) => o.deny), false],
    [mine.flatMap((o) => o.allow), true],
    [personal?.deny ?? [], false],
    [personal?.allow ?? [], true],
  ];
  for (const [caps, grant] of steps) {
    for (const c of caps) {
      // Guests only ever hold guest-safe powers, whatever an overwrite says.
      if (grant && actor.base === "GUEST" && !permissionDef(c).guestAllowed) continue;
      if (grant) out.add(c);
      else out.delete(c);
    }
  }
}

/** Effective permissions in a channel. [levels]: the category's overwrites, then the channel's (either may be empty). */
export function channelPermissions(actor: ChannelActor, levels: readonly (readonly Overwrite[])[]): Set<Permission> {
  if (actor.base === "OWNER" || actor.base === "ADMIN") return new Set(actor.perms);
  const out = new Set(actor.perms);
  for (const level of levels) applyLevel(out, level, actor);
  for (const r of actor.restricted) out.delete(r);
  return out;
}

export interface OverwriteRefusal {
  status: 400 | 403;
  code: ErrorCode;
  message: string;
}

/**
 * May someone holding [held] (their permissions where the overwrite applies) write [next] in place of [prev]? Allow
 * and deny may not overlap, and every capability added or removed must be one the writer holds, so nobody hands out a
 * power they don't have themselves (or takes one away from people above them through a channel).
 */
export function overwriteRefusal(held: ReadonlySet<Permission>, next: Overwrite, prev?: Overwrite): OverwriteRefusal | null {
  const overlap = next.allow.filter((c) => next.deny.includes(c));
  if (overlap.length) return { status: 400, code: "allow_and_deny", message: `An overwrite can't both allow and deny "${permissionDef(overlap[0]).label}"` };
  const touched = new Set<ChannelCapability>([...next.allow, ...next.deny, ...(prev?.allow ?? []), ...(prev?.deny ?? [])]);
  const before = (c: ChannelCapability) => (prev?.allow.includes(c) ? "allow" : prev?.deny.includes(c) ? "deny" : "none");
  const after = (c: ChannelCapability) => (next.allow.includes(c) ? "allow" : next.deny.includes(c) ? "deny" : "none");
  for (const c of touched) {
    if (before(c) !== after(c) && !held.has(c)) {
      return { status: 403, code: "beyond_your_powers", message: `You can only change "${permissionDef(c).label}" if you hold it yourself` };
    }
  }
  return null;
}

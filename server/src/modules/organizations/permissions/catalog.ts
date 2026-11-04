import type { OrgRole } from "../authz.js";

/**
 * The workspace permission catalog (docs/WORKSPACE_ROLES.md): every power a workspace role can carry. Each key is
 * enforced somewhere on the server; nothing here is decorative. Platform powers (service configuration, the global app
 * registry) are deliberately absent: no workspace role can ever hold them (src/permissions/platform.ts).
 *
 * The app shows the same catalog, read from GET /v1/orgs/:id/roles, so labels live here once.
 */
export const PERMISSION_KEYS = [
  // Community
  "workspace.edit",
  "workspace.usage.view",
  "workspace.delete",
  "workspace.transfer",
  "events.manage",
  // Members
  "members.view",
  "members.invite",
  "members.invites.manage",
  "members.roles",
  "members.titles",
  "members.remove",
  "members.ban",
  "members.timeout",
  "members.approve",
  // Community parity A1 (feature "community-permissions"): nicknames.
  "members.nickname",
  "members.nicknames",
  // Roles
  "roles.view",
  "roles.manage",
  "roles.assign",
  "roles.delegate",
  // Channels and categories
  "channels.view",
  "channels.create",
  "channels.manage",
  "channels.visibility",
  // Community parity batch C: channels' webhooks
  "webhooks.manage",
  // Messaging
  "messages.post",
  "messages.attach",
  "messages.announce",
  "messages.bypass_slowmode",
  // Community parity A1 (feature "community-permissions"): what a message may carry, moderation and threads.
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
  // Expressions (batch B9)
  "expressions.manage",
  // Voice channels
  "voice.connect",
  "voice.speak",
  "voice.mute_members",
  "voice.move_members",
  // Security and administration
  "audit.view",
  "reports.view",
] as const;

export type Permission = (typeof PERMISSION_KEYS)[number];

export type PermissionCategory =
  | "workspace"
  | "members"
  | "roles"
  | "channels"
  | "messaging"
  | "voice"
  | "security";

export interface PermissionDef {
  key: Permission;
  category: PermissionCategory;
  label: string;
  description: string;
  /**
   * An administrative power (docs/WORKSPACE_ROLES.md §3): only someone holding `roles.delegate` may put it into a role
   * or hand out a role that carries it. Owners hold every power.
   */
  admin: boolean;
  /** Held by owners only; no custom role may carry it. */
  ownerOnly: boolean;
  /** May a guest receive it through a custom role? Guests only ever get low-risk powers. */
  guestAllowed: boolean;
  /** May a custom role restrict (deny) it? Restrictions win over grants and never apply to owners. */
  restrictable: boolean;
}

type Def = Omit<
  PermissionDef,
  "key" | "admin" | "ownerOnly" | "guestAllowed" | "restrictable"
> &
  Partial<PermissionDef>;

const DEFS: Record<Permission, Def> = {
  "workspace.edit": {
    category: "workspace",
    label: "Edit the community",
    description:
      "Change the community's name, description, photo, rules, visibility and who may join.",
    admin: true,
  },
  "workspace.usage.view": {
    category: "workspace",
    label: "View usage and storage",
    description: "See member, channel and file storage figures.",
    admin: true,
  },
  "workspace.delete": {
    category: "workspace",
    label: "Delete the community",
    description: "Permanently delete the community and its channels.",
    admin: true,
    ownerOnly: true,
  },
  "workspace.transfer": {
    category: "workspace",
    label: "Transfer ownership",
    description: "Hand ownership of the community to another member.",
    admin: true,
    ownerOnly: true,
  },
  "events.manage": {
    category: "workspace",
    label: "Manage events",
    description:
      "Edit and cancel other organizers' events in channels you can access.",
    admin: true,
  },
  "members.view": {
    category: "members",
    label: "View the member list",
    description: "Browse and search everyone in the community.",
    restrictable: true,
  },
  "members.invite": {
    category: "members",
    label: "Invite people",
    description: "Create invitations for members and guests.",
    admin: true,
  },
  "members.invites.manage": {
    category: "members",
    label: "Manage all invitations",
    description: "See and revoke invitations created by anyone.",
    admin: true,
  },
  "members.roles": {
    category: "members",
    label: "Change member access",
    description: "Switch people between Member and Guest.",
    admin: true,
  },
  "members.titles": {
    category: "members",
    label: "Edit titles",
    description: "Change the short title shown next to members' names.",
    admin: true,
  },
  "members.remove": {
    category: "members",
    label: "Remove people",
    description:
      "Remove members and guests from the community (they can come back with an invitation).",
    admin: true,
  },
  "members.ban": {
    category: "members",
    label: "Ban people",
    description:
      "Remove people and keep them out until the ban is lifted, and see the ban list.",
    admin: true,
  },
  "members.approve": {
    category: "members",
    label: "Approve applications",
    description: "Approve or deny people who applied to join.",
    admin: true,
  },
  "members.timeout": {
    category: "members",
    label: "Time out people",
    description:
      "Stop someone posting, sharing files and joining voice channels for up to 28 days.",
    admin: true,
  },
  "members.nickname": {
    category: "members",
    label: "Change your nickname",
    description: "Pick the name you go by in this community.",
    restrictable: true,
    guestAllowed: true,
  },
  "members.nicknames": {
    category: "members",
    label: "Manage nicknames",
    description: "Change or clear other people's nicknames in this community.",
    admin: true,
  },
  "roles.view": {
    category: "roles",
    label: "View roles",
    description: "See the community's roles and what each one allows.",
  },
  "roles.manage": {
    category: "roles",
    label: "Create and edit roles",
    description:
      "Create, edit, clone and archive custom roles (only with powers you hold).",
    admin: true,
  },
  "roles.assign": {
    category: "roles",
    label: "Assign roles",
    description:
      "Give custom roles to people and take them away (only roles within your own powers).",
    admin: true,
  },
  "roles.delegate": {
    category: "roles",
    label: "Delegate admin powers",
    description: "Put administrative powers into roles and assign such roles.",
    admin: true,
  },
  "channels.view": {
    category: "channels",
    label: "See channels",
    description:
      "See the community's public channels and be in them. Channel and category permissions can take it away.",
    restrictable: true,
  },
  "channels.create": {
    category: "channels",
    label: "Create channels and categories",
    description: "Create channels, voice channels, forums and categories.",
    admin: true,
  },
  "channels.manage": {
    category: "channels",
    label: "Manage channels",
    description:
      "Rename, reorder, move, archive and manage the members and permissions of channels and categories.",
    admin: true,
  },
  "channels.visibility": {
    category: "channels",
    label: "Change channel access",
    description: "Make any channel public, private or announcement-only.",
    admin: true,
  },
  "webhooks.manage": {
    category: "channels",
    label: "Manage webhooks",
    description:
      "Make, rename and delete channels' webhooks, give them new addresses and post through them.",
    admin: true,
  },
  "messages.post": {
    category: "messaging",
    label: "Post in channels",
    description: "Send messages in the community's channels.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.attach": {
    category: "messaging",
    label: "Share files",
    description: "Send photos, videos, voice messages and files in channels.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.announce": {
    category: "messaging",
    label: "Post announcements",
    description: "Post in announcement channels, where only managers can post.",
  },
  "messages.bypass_slowmode": {
    category: "messaging",
    label: "Skip slowmode",
    description: "Post without waiting in channels with slowmode on.",
  },
  "messages.react": {
    category: "messaging",
    label: "Add reactions",
    description:
      "React with a new emoji. Without it, people can still join reactions already on a message.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.embed": {
    category: "messaging",
    label: "Post links",
    description: "Send messages with web links and link previews.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.voice": {
    category: "messaging",
    label: "Send voice messages",
    description: "Record and send voice messages in channels.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.external_emoji": {
    category: "messaging",
    label: "Use emoji from other communities",
    description: "Use emoji and stickers that belong to other communities.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.polls": {
    category: "messaging",
    label: "Create polls",
    description: "Ask a question with answers people vote on.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.big_text": {
    category: "messaging",
    label: "Write headings",
    description: "Start a line with #, ## or ### to make it a big heading.",
    restrictable: true,
    guestAllowed: true,
  },
  "messages.mention_all": {
    category: "messaging",
    label: "Mention everyone",
    description:
      "Notify a whole channel with @everyone, and mention any role, even one that isn't open to mentions.",
    restrictable: true,
  },
  "messages.manage": {
    category: "messaging",
    label: "Manage messages",
    description:
      "Delete and pin anyone's messages in channels, and post without waiting in slowmode.",
    admin: true,
  },
  "messages.history": {
    category: "messaging",
    label: "Read earlier messages",
    description:
      "See what was said in a channel before you joined it. Without it, only messages from after joining show.",
    restrictable: true,
    guestAllowed: true,
  },
  "threads.create": {
    category: "messaging",
    label: "Start threads",
    description: "Begin a thread from a message in a channel.",
    restrictable: true,
    guestAllowed: true,
  },
  "threads.post": {
    category: "messaging",
    label: "Reply in threads",
    description:
      "Send messages in threads that already exist, and in forum posts.",
    restrictable: true,
    guestAllowed: true,
  },
  "threads.manage": {
    category: "messaging",
    label: "Manage threads",
    description: "Delete and pin anyone's messages inside threads.",
    admin: true,
  },
  "expressions.manage": {
    category: "messaging",
    label: "Manage emoji and stickers",
    description:
      "Upload, rename and remove the community's own emoji and stickers.",
  },
  "voice.connect": {
    category: "voice",
    label: "Join voice channels",
    description: "Join the calls in voice channels.",
    restrictable: true,
    guestAllowed: true,
  },
  "voice.speak": {
    category: "voice",
    label: "Speak in voice channels",
    description:
      "Talk, share video and share the screen in voice channels. Without it, people listen only.",
    restrictable: true,
    guestAllowed: true,
  },
  // Community parity A2: a server mute lasts until a moderator lifts it; disconnecting takes someone out of the call.
  "voice.mute_members": {
    category: "voice",
    label: "Mute people in voice",
    description:
      "Mute someone in voice channels until you unmute them: they can listen but not talk or share.",
    admin: true,
  },
  "voice.move_members": {
    category: "voice",
    label: "Disconnect people from voice",
    description: "Take someone out of a voice channel's call.",
    admin: true,
  },
  "audit.view": {
    category: "security",
    label: "View the audit log",
    description: "See every administrative change in the community.",
    admin: true,
  },
  "reports.view": {
    category: "security",
    label: "Handle reports",
    description:
      "See what members reported to the moderators, and close reports.",
    admin: true,
  },
};

export const PERMISSIONS: readonly PermissionDef[] = PERMISSION_KEYS.map(
  (key) => {
    const d = DEFS[key];
    return {
      key,
      category: d.category,
      label: d.label,
      description: d.description,
      admin: d.admin ?? false,
      ownerOnly: d.ownerOnly ?? false,
      guestAllowed: d.guestAllowed ?? false,
      restrictable: d.restrictable ?? false,
    };
  },
);

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function permissionDef(key: Permission): PermissionDef {
  const d = BY_KEY.get(key);
  if (!d) throw new Error(`Unknown permission ${key}`);
  return d;
}

export function isPermission(key: string): key is Permission {
  return BY_KEY.has(key as Permission);
}

/** What the protected base roles hold. Owners hold everything; admins everything but owner-only powers and delegation. */
/**
 * Everyday powers everyone had before they became permissions (community parity A1): in both base sets, so
 * nothing changes for anyone until a community or a role takes them away.
 */
export const EVERYDAY_POWERS: readonly Permission[] = [
  "messages.react",
  "messages.embed",
  "messages.voice",
  "messages.external_emoji",
  "messages.polls",
  "messages.big_text",
  "messages.history",
  "threads.create",
  "threads.post",
  "members.nickname",
];
const MEMBER_BASE: readonly Permission[] = [
  "members.view",
  "roles.view",
  "channels.view",
  "messages.post",
  "messages.attach",
  "voice.connect",
  "voice.speak",
  ...EVERYDAY_POWERS,
];
const GUEST_BASE: readonly Permission[] = [
  "messages.post",
  "messages.attach",
  "voice.connect",
  "voice.speak",
  ...EVERYDAY_POWERS,
];

export const BASE_ROLE_PERMISSIONS: Readonly<
  Record<OrgRole, ReadonlySet<Permission>>
> = {
  OWNER: new Set(PERMISSION_KEYS),
  ADMIN: new Set(
    PERMISSION_KEYS.filter(
      (k) => !permissionDef(k).ownerOnly && k !== "roles.delegate",
    ),
  ),
  MEMBER: new Set(MEMBER_BASE),
  GUEST: new Set(GUEST_BASE),
};

/**
 * What a community may put into its "@everyone" defaults (community parity A1): everyday powers only. Administrative and
 * owner-only powers always come from a role.
 */
export function memberDefaultAllowed(key: Permission): boolean {
  const d = permissionDef(key);
  return !d.admin && !d.ownerOnly;
}

/** Base roles, highest first: used to decide who may act on whom. */
export const BASE_ROLE_RANK: Readonly<Record<OrgRole, number>> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
  GUEST: 0,
};

/** Icons a custom role may show (names the app maps to its own icon set). */
export const ROLE_ICONS = [
  "shield",
  "star",
  "people",
  "briefcase",
  "support",
  "code",
  "finance",
  "eye",
  "megaphone",
  "badge",
] as const;

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  color: string;
  icon: (typeof ROLE_ICONS)[number];
  permissions: Permission[];
  denies: Permission[];
}

/**
 * Starter templates: a quick way to begin, copied into the workspace and freely editable afterwards. They are examples,
 * not a fixed hierarchy; a workspace defines its own roles.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: "moderator",
    name: "Moderator",
    description:
      "Keeps conversations healthy: manages channels and their access, posts announcements, times out, removes and bans people.",
    color: "#E39B7B",
    icon: "shield",
    permissions: [
      "channels.manage",
      "channels.visibility",
      "webhooks.manage",
      "messages.announce",
      "messages.bypass_slowmode",
      "messages.manage",
      "threads.manage",
      "members.remove",
      "members.ban",
      "members.timeout",
      "members.approve",
      "members.nicknames",
      "reports.view",
      "voice.mute_members",
      "voice.move_members",
    ],
    denies: [],
  },
  {
    key: "community_manager",
    name: "Community Manager",
    description:
      "Grows the community: invites people, sets up channels and categories, keeps titles right.",
    color: "#C9A27A",
    icon: "star",
    permissions: [
      "members.invite",
      "members.invites.manage",
      "members.approve",
      "members.titles",
      "channels.create",
      "channels.manage",
      "expressions.manage",
    ],
    denies: [],
  },
  {
    key: "announcer",
    name: "Announcer",
    description: "Posts in announcement channels.",
    color: "#7FA7D9",
    icon: "megaphone",
    permissions: ["messages.announce"],
    denies: [],
  },
  {
    key: "helper",
    name: "Helper",
    description: "A recognised helper: invites newcomers.",
    color: "#8FB59A",
    icon: "support",
    permissions: ["members.invite"],
    denies: [],
  },
  {
    key: "read_only",
    name: "Read-Only Member",
    description: "Reads channels but can't post or share files in them.",
    color: "#9A9A9A",
    icon: "eye",
    permissions: [],
    denies: ["messages.post", "messages.attach"],
  },
];

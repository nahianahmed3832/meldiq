import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Reaction roles (community parity batch C, feature "reaction-roles", docs/COMMUNITY_PARITY_API.md › Posting tools): on
 * a community message, an emoji that gives a role to whoever reacts with it and takes it back when they take the
 * reaction off. Set by holders of `roles.assign`, with roles they could assign that carry no administrative powers.
 */

export const REACTION_ROLE_LIMITS = { perMessage: 20, emoji: 64 } as const;

export const ReactionRolesParams = z.object({ orgId: z.string().min(1).max(64), channelId: z.string().min(1).max(64), messageId: z.string().min(1).max(64) });

export const ReactionRolePairInput = z.strictObject({ emoji: z.string().trim().min(1).max(REACTION_ROLE_LIMITS.emoji), roleId: z.string().min(1).max(64) });

/** The whole list at once, in the order shown; an emoji and a role each appear once. */
export const ReactionRolesBody = z.strictObject({ reactionRoles: z.array(ReactionRolePairInput).min(1).max(REACTION_ROLE_LIMITS.perMessage) });

export const ReactionRolePair = z.strictObject({ emoji: z.string(), roleId: z.string(), roleName: z.string(), roleColor: z.string().nullable() });

export const ReactionRolesView = z.strictObject({
  messageId: z.string(),
  channelId: z.string(),
  /** Empty when the message has none. */
  reactionRoles: z.array(ReactionRolePair),
  setBy: z.string().nullable(),
  setAt: zTime.nullable(),
});

const tag = "reaction-roles";
const url = "/v1/orgs/:orgId/channels/:channelId/messages/:messageId/reaction-roles";

export const reactionRoleRoutes = [
  route({ method: "GET", url, tag, summary: "A message's reaction roles (members who can see the channel).", auth: true, params: ReactionRolesParams, response: ReactionRolesView, errors: ["not_found", "feature_disabled"] }),
  route({
    method: "PUT",
    url,
    tag,
    summary: "Set a message's reaction roles (holders of roles.assign; only roles they could assign, never ones with admin powers).",
    auth: true,
    params: ReactionRolesParams,
    body: ReactionRolesBody,
    response: ReactionRolesView,
    errors: ["not_found", "forbidden", "feature_disabled", "reaction_role_not_givable"],
  }),
  route({
    method: "DELETE",
    url,
    tag,
    summary: "Remove a message's reaction roles (roles already given stay).",
    auth: true,
    params: ReactionRolesParams,
    response: z.strictObject({ deleted: z.boolean() }),
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
];

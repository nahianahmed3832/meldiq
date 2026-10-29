import { z } from "zod/v4";
import { OrgParamsNonEmpty } from "./community.js";
import { RulesSummary } from "./orgs.js";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * A community's rules channel and its rules (API 0.65.0, feature "rules-channel", docs/SETTINGS_PARITY_API.md): one
 * text or announcement channel that only people who can edit the community post in, a numbered list of rules shown
 * there and before joining, and, when the community asks for it, members agree to the rules before they post or react.
 * Plaintext configuration, like the community guide.
 */

export const RULES_LIMITS = { rules: 25, title: 100, description: 1000 } as const;

export const RuleBody = z.object({
  /** Kept when it's 1–32 of A-Z, a-z, 0-9, _ and -; a new id otherwise. */
  id: z.string().max(32).optional(),
  title: z.string().trim().min(1).max(RULES_LIMITS.title),
  description: z.string().trim().max(RULES_LIMITS.description).nullish(),
});

/** Everything at once: the channel (null: none), whether members must agree, and the rules in their order. */
export const RulesBody = z.strictObject({
  channelId: z.string().min(1).max(64).nullable(),
  required: z.boolean(),
  rules: z.array(RuleBody).max(RULES_LIMITS.rules),
});

export const Rule = z.strictObject({ id: z.string(), title: z.string(), description: z.string().nullable() });

export const RulesView = z.strictObject({
  /** The rules channel, null without one (or once it's deleted or archived). */
  channelId: z.string().nullable(),
  /** Members must agree to the rules before they post or react anywhere in the community. */
  required: z.boolean(),
  rules: z.array(Rule),
  /** When the rules were last changed; null before they ever were. */
  updatedAt: zTime.nullable(),
  /** When the viewer agreed; null before they did. */
  agreedAt: zTime.nullable(),
  /** Whether the viewer must agree before posting now (false for people who can edit the community). */
  mustAgree: z.boolean(),
});

/** What every community view carries (CommunityView.rulesChannel, kept in orgs.ts). */
export { RulesSummary };

const tag = "community-rules";

export const communityRulesRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/rules",
    tag,
    summary: "The community's rules channel and rules, and whether the viewer has agreed to them.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: RulesView,
    errors: ["not_found", "feature_disabled"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/rules",
    tag,
    summary: "Set the rules channel, the rules and whether members must agree (people who can edit the community).",
    auth: true,
    params: OrgParamsNonEmpty,
    body: RulesBody,
    response: RulesView,
    errors: ["not_found", "forbidden", "rules_channel_invalid", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/rules/agree",
    tag,
    summary: "Agree to the community's rules; agreeing again keeps the first time.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: RulesView,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
];

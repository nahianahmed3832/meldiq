import type { BotPlatformScope } from "./botPlatform.js";
import type { RouteContract } from "./route.js";

export type BotResource =
  | "self"
  | "org"
  | "conversation"
  | "role"
  | "category"
  | "expression"
  | "meeting";
export interface BotDomainAdapter {
  method: RouteContract["method"];
  source: string;
  url: string;
  scope: BotPlatformScope | null;
  resource: BotResource;
}
const routes: BotDomainAdapter[] = [];
const add = (
  methods: RouteContract["method"][],
  source: string,
  scope: BotPlatformScope | null,
  resource: BotResource,
) => {
  for (const method of methods)
    routes.push({
      method,
      source,
      url: source.replace(/^\/v[12]\//, "/v2/bot/"),
      scope,
      resource,
    });
};
// This allowlist deliberately contains no account/session, ownership, billing or platform-administrator endpoints.
add(["PATCH"], "/v1/users/me", null, "self");
add(["PUT", "DELETE"], "/v1/users/me/avatar-media", null, "self");
add(["PUT", "DELETE"], "/v1/users/me/profile-banner", null, "self");
add(["GET"], "/v1/orgs/:orgId/channels", "channels.read", "org");
add(["GET"], "/v1/orgs/:orgId", "communities.read", "org");
add(
  ["GET"],
  "/v2/conversations/:id/messages",
  "messages.history",
  "conversation",
);
add(
  ["GET"],
  "/v2/conversations/:id/message-collections",
  "messages.history",
  "conversation",
);
add(["POST"], "/v1/orgs/:orgId/channels", "channels.manage", "org");
add(["GET"], "/v1/conversations/:id", "channels.read", "conversation");
add(
  ["PATCH", "DELETE"],
  "/v1/conversations/:id",
  "channels.manage",
  "conversation",
);
add(["GET"], "/v1/orgs/:orgId/categories", "channels.read", "org");
add(["POST"], "/v1/orgs/:orgId/categories", "channels.manage", "org");
add(["PATCH", "DELETE"], "/v1/categories/:id", "channels.manage", "category");
add(["GET"], "/v1/categories/:id/overwrites", "channels.read", "category");
add(["PUT"], "/v1/categories/:id/overwrites", "channels.manage", "category");
add(["GET"], "/v1/orgs/:orgId/roles", "members.read", "org");
add(["POST"], "/v1/orgs/:orgId/roles", "roles.manage", "org");
add(["PATCH", "DELETE"], "/v1/roles/:roleId", "roles.manage", "role");
add(["PUT"], "/v1/orgs/:orgId/roles/everyone", "roles.manage", "org");
add(
  ["PUT", "DELETE"],
  "/v1/roles/:roleId/members/:userId",
  "roles.manage",
  "role",
);
add(["GET"], "/v1/orgs/:orgId/members", "members.read", "org");
add(["GET"], "/v1/orgs/:orgId/members/:userId/profile", "members.read", "org");
add(["PATCH"], "/v1/orgs/:orgId/members/:userId", "roles.manage", "org");
add(["DELETE"], "/v1/orgs/:orgId/members/:userId", "members.remove", "org");
add(
  ["PUT"],
  "/v1/orgs/:orgId/members/:userId/nickname",
  "members.nicknames",
  "org",
);
add(["GET", "POST"], "/v1/orgs/:orgId/bans", "members.ban", "org");
add(["DELETE"], "/v1/orgs/:orgId/bans/:userId", "members.ban", "org");
add(
  ["PUT"],
  "/v1/orgs/:orgId/members/:userId/timeout",
  "members.timeout",
  "org",
);
add(["GET"], "/v1/orgs/:orgId/invites", "members.invite", "org");
add(["POST"], "/v1/orgs/:orgId/invites", "members.invite", "org");
add(["GET"], "/v1/orgs/:orgId/expressions", "channels.read", "org");
add(["POST"], "/v1/orgs/:orgId/expressions", "expressions.manage", "org");
add(
  ["PATCH", "DELETE"],
  "/v1/expressions/:id",
  "expressions.manage",
  "expression",
);
add(["GET"], "/v1/orgs/:orgId/meetings", "channels.read", "org");
add(["POST"], "/v1/orgs/:orgId/meetings", "events.manage", "org");
add(["GET"], "/v1/meetings/:id", "channels.read", "meeting");
add(["PUT"], "/v1/meetings/:id", "events.manage", "meeting");
add(["POST"], "/v1/meetings/:id/cancel", "events.manage", "meeting");
add(
  ["GET", "POST"],
  "/v1/orgs/:orgId/channels/:channelId/webhooks",
  "webhooks.manage",
  "org",
);
add(
  ["PATCH", "DELETE"],
  "/v1/orgs/:orgId/channels/:channelId/webhooks/:webhookId",
  "webhooks.manage",
  "org",
);
add(
  ["POST"],
  "/v1/orgs/:orgId/channels/:channelId/webhooks/:webhookId/token",
  "webhooks.manage",
  "org",
);
add(
  ["PUT"],
  "/v1/orgs/:orgId/voice/members/:userId/mute",
  "voice.mute_members",
  "org",
);
add(
  ["POST"],
  "/v1/orgs/:orgId/voice/members/:userId/disconnect",
  "voice.move_members",
  "org",
);
export const BOT_DOMAIN_ADAPTERS: readonly BotDomainAdapter[] = routes;

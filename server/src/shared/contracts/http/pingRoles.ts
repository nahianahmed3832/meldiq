import { z } from "zod/v4";
import { OrgParamsNonEmpty } from "./community.js";
import { route } from "./route.js";

export const PING_ROLE_LIMIT = 20;
export const PingRoleId = z.string().regex(/^png_[A-Za-z0-9_-]{1,40}$/);
const PingRoleName = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]*$/u);
export const PingRole = z.strictObject({ id: PingRoleId, name: PingRoleName });
export const PingRoleSettings = z.strictObject({
  rev: z.number().int().nonnegative(),
  roles: z.array(PingRole),
  subscribed: z.array(PingRoleId),
  canManage: z.boolean(),
});
export const PingRoleUpdate = z.strictObject({
  rev: z.number().int().nonnegative(),
  roles: z
    .array(PingRole.extend({ id: PingRoleId.optional() }))
    .max(PING_ROLE_LIMIT),
});
export const PingRoleSelection = z.strictObject({
  roles: z.array(PingRoleId).max(PING_ROLE_LIMIT),
});
export const pingRoleContracts = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/ping-roles",
    tag: "community",
    summary: "List opt-in notification groups in a community.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: PingRoleSettings,
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/ping-roles",
    tag: "community",
    summary: "Save notification groups without granting community permissions.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: PingRoleUpdate,
    response: PingRoleSettings,
    errors: ["stale_revision", "bad_request", "forbidden"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/ping-roles/me",
    tag: "community",
    summary: "Choose which notification groups to join.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: PingRoleSelection,
    response: PingRoleSettings,
    errors: ["bad_request", "forbidden"],
  }),
];

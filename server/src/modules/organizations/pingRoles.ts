import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import type { RowReader } from "../../infrastructure/database/rows/index.js";
import { OrgParamsNonEmpty } from "../../shared/contracts/http/community.js";
import {
  PingRole,
  PingRoleSelection,
  PingRoleUpdate,
} from "../../shared/contracts/http/pingRoles.js";
import { ApiError, badRequest, forbidden } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { parse } from "../../shared/validation/index.js";
import { me, requireAuth } from "../auth/index.js";
import type { ConversationRow } from "./authz.js";
import { notifyOrg } from "./orgsRoutes.js";

const RoleList = z.array(PingRole);
export function readPingRoles(rows: RowReader, orgId: string) {
  const row = rows.get<{ rev: number; roles: string }>("community_ping_roles", {
    org_id: orgId,
  });
  return {
    rev: row?.rev ?? 0,
    roles: row ? RoleList.parse(JSON.parse(row.roles)) : [],
  };
}

/** These groups exist only for mentions. Their IDs never resolve as permission-bearing roles. */
export function pingRoleOpen(
  ctx: AppContext,
  orgId: string,
  id: string,
): boolean {
  return (
    id.startsWith("png_") &&
    readPingRoles(ctx.ws, orgId).roles.some((role) => role.id === id)
  );
}

export function pingRecipients(
  ctx: AppContext,
  conv: ConversationRow,
  senderId: string,
  payload: Record<string, unknown>,
): string[] {
  if (
    conv.type !== "CHANNEL" ||
    !conv.org_id ||
    !Array.isArray(payload.roleMentions) ||
    typeof payload.text !== "string"
  )
    return [];
  const orgId = conv.org_id;
  const ids = new Set(
    payload.roleMentions.filter(
      (id): id is string => typeof id === "string" && id.startsWith("png_"),
    ),
  );
  if (!ids.size) return [];
  const text = payload.text;
  const roles = readPingRoles(ctx.ws, orgId).roles.filter(
    (role) =>
      ids.has(role.id) &&
      new RegExp(
        `(?:^|[^\\p{L}\\p{M}\\p{N}_@-])@${role.name}(?![\\p{L}\\p{M}\\p{N}_-])`,
        "u",
      ).test(text),
  );
  if (!roles.length) return [];
  const subscribed = ctx.ws.all<{ user_id: string }>(
    "community_ping_subscriptions",
    {
      where: { org_id: orgId, role_id: { in: roles.map((role) => role.id) } },
    },
  );
  return [...new Set(subscribed.map(({ user_id }) => user_id))].filter(
    (id) =>
      id !== senderId &&
      ctx.authz.orgRole(orgId, id) &&
      ctx.authz.isMember(conv.id, id),
  );
}

/** Apply a revision-checked update and remove subscriptions to deleted roles in the same write. */
export async function updatePingRoles(ctx: AppContext, orgId: string, body: z.infer<typeof PingRoleUpdate>) {
  const names = body.roles.map(({ name }) =>
    name.normalize("NFKC").toLowerCase(),
  );
  if (
    names.some((name) => name === "everyone" || name === "here") ||
    new Set(names).size !== names.length
  )
    throw badRequest("Use distinct names and reserve @everyone and @here.");
  await ctx.ws.write((rows) => {
    const current = readPingRoles(rows, orgId);
    if (current.rev !== body.rev)
      throw new ApiError(
        409,
        "stale_revision",
        "Ping roles changed. Reload and try again.",
      );
    const prior = new Set(current.roles.map(({ id }) => id));
    const existing = body.roles.flatMap(({ id }) => id ?? []);
    if (
      new Set(existing).size !== existing.length ||
      existing.some((id) => !prior.has(id))
    )
      throw badRequest("Unknown or duplicate ping role");
    const roles = body.roles.map(({ id, name }) => ({
      id: id ?? newId("png"),
      name,
    }));
    rows.upsert(
      "community_ping_roles",
      { org_id: orgId, rev: current.rev + 1, roles: JSON.stringify(roles) },
      "replace",
    );
    const removed = [...prior].filter((id) => !existing.includes(id));
    if (removed.length)
      rows.delete("community_ping_subscriptions", {
        org_id: orgId,
        role_id: { in: removed },
      });
  });
}

export default async function pingRoleRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const guard = { preHandler: requireAuth(ctx) };
  const view = (orgId: string, userId: string) => ({
    ...readPingRoles(ctx.ws, orgId),
    subscribed: ctx.ws
      .all<{ role_id: string }>("community_ping_subscriptions", {
        where: { org_id: orgId, user_id: userId },
      })
      .map((entry) => entry.role_id),
    canManage: ctx.authz.can(orgId, userId, "workspace.edit"),
  });
  app.get("/v1/orgs/:orgId/ping-roles", guard, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    ctx.authz.requireOrgMember(orgId, me(req).userId);
    return view(orgId, me(req).userId);
  });
  app.put("/v1/orgs/:orgId/ping-roles", guard, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const { userId } = me(req);
    ctx.authz.requireOrgMember(orgId, userId);
    if (!ctx.authz.can(orgId, userId, "workspace.edit")) throw forbidden();
    const body = parse(PingRoleUpdate, req.body);
    await updatePingRoles(ctx, orgId, body);
    ctx.audit({
      actorId: userId,
      orgId,
      action: "community.ping_roles",
      target: orgId,
    });
    notifyOrg(ctx, orgId);
    return view(orgId, userId);
  });
  app.put("/v1/orgs/:orgId/ping-roles/me", guard, async (req) => {
    const { orgId } = parse(OrgParamsNonEmpty, req.params);
    const { userId } = me(req);
    ctx.authz.requireOrgMember(orgId, userId);
    const selection = new Set(parse(PingRoleSelection, req.body).roles);
    await ctx.ws.write((rows) => {
      if (!rows.get("org_members", { org_id: orgId, user_id: userId }))
        throw forbidden();
      const current = readPingRoles(rows, orgId);
      if (
        [...selection].some(
          (id) => !current.roles.some((role) => role.id === id),
        )
      )
        throw badRequest("Unknown ping role");
      rows.delete("community_ping_subscriptions", {
        org_id: orgId,
        user_id: userId,
      });
      for (const id of selection)
        rows.insert("community_ping_subscriptions", {
          org_id: orgId,
          user_id: userId,
          role_id: id,
        });
    });
    return view(orgId, userId);
  });
}

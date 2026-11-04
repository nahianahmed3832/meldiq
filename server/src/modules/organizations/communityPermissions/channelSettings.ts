import type { RowWriter } from "../../../infrastructure/database/rows/index.js";
import { optionsOfRow } from "../permissions/channelOptions.js";
import type { AppContext } from "../../../app/context.js";
import { badRequest, forbidden } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import type { ConversationRow } from "../authz.js";
import {
  type ChannelOptions,
  POSTER_ROLES_MAX,
} from "../permissions/channelOptions.js";

/**
 * Setting a channel's options (community parity A1, docs/COMMUNITY_PERMISSIONS.md), when it's created
 * (POST /v1/orgs/:orgId/channels) or changed (PATCH /v1/conversations/:id). People who manage the channel set them;
 * read-only and its poster roles decide who may post, so changing them later also needs `channels.visibility` (like
 * switching a channel to announcements).
 */

export interface ChannelOptionsInput {
  textOnly?: boolean;
  noGifs?: boolean;
  stage?: boolean;
  readOnly?: boolean;
  posterRoleIds?: string[];
}

/** Throws 400 for options that don't suit the channel: stages are voice channels; the rest are for text channels. */
export function checkChannelOptions(
  ctx: AppContext,
  orgId: string,
  voice: boolean,
  input: ChannelOptionsInput,
): void {
  if (input.stage && !voice)
    throw badRequest("Only voice channels can be stages");
  if (voice && (input.textOnly || input.noGifs || input.readOnly))
    throw badRequest(
      "Voice channels don't take messages, so text options don't apply to them",
    );
  const ids = input.posterRoleIds ?? [];
  if (new Set(ids).size !== ids.length)
    throw badRequest("Each role can be listed once");
  if (ids.length > POSTER_ROLES_MAX)
    throw badRequest(
      `At most ${POSTER_ROLES_MAX} roles can post in a read-only channel`,
    );
  for (const id of ids) {
    if (!ctx.ws.get("org_roles", { id, org_id: orgId, archived_at: null }))
      throw badRequest("Unknown role, or one that's archived", { roleId: id });
  }
}

const same = (a: ChannelOptions, b: ChannelOptions) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Checks and stores [input] over the channel's current options; returns whether anything changed. */
export async function updateChannelOptions(
  ctx: AppContext,
  conv: ConversationRow,
  actorId: string,
  input: ChannelOptionsInput,
  creating: boolean,
): Promise<boolean> {
  return ctx.ws.write((w) =>
    writeChannelOptions(ctx, w, conv, actorId, input, creating),
  );
}

/** The same options inside a larger atomic channel edit; failed tag/identity changes cannot partially save options. */
export function writeChannelOptions(
  ctx: AppContext,
  w: RowWriter,
  conv: ConversationRow,
  actorId: string,
  input: ChannelOptionsInput,
  creating = false,
): boolean {
  if (!Object.values(input).some((v) => v !== undefined)) return false;
  ctx.communityPermissions.requireEnabled();
  const { authz } = ctx;
  if (conv.type !== "CHANNEL" || !conv.org_id)
    throw badRequest("Only community channels have these options");
  const orgId = conv.org_id;
  checkChannelOptions(ctx, orgId, conv.voice === 1, input);
  const before = optionsOfRow(
    w.get("channel_options", { conversation_id: conv.id }),
  );
  const next: ChannelOptions = {
    textOnly: input.textOnly ?? before.textOnly,
    noGifs: input.noGifs ?? before.noGifs,
    stage: input.stage ?? before.stage,
    readOnly: input.readOnly ?? before.readOnly,
    posterRoleIds: input.posterRoleIds ?? before.posterRoleIds,
  };
  if (same(before, next)) return false;
  const whoPosts =
    next.readOnly !== before.readOnly ||
    (next.readOnly &&
      JSON.stringify(next.posterRoleIds) !==
        JSON.stringify(before.posterRoleIds));
  if (!creating && whoPosts && !authz.canManageChannelAccess(conv, actorId))
    throw forbidden(
      "Only people who can change channel access can change who posts in it",
    );
  {
    const row = {
      conversation_id: conv.id,
      org_id: orgId,
      text_only: next.textOnly ? 1 : 0,
      no_gifs: next.noGifs ? 1 : 0,
      stage: next.stage ? 1 : 0,
      read_only: next.readOnly ? 1 : 0,
      poster_role_ids: JSON.stringify(next.posterRoleIds),
      updated_by: actorId,
      updated_at: now(),
    };
    const { conversation_id: _id, ...set } = row;
    w.upsert("channel_options", row, set);
    // A stage turned off forgets who was let speak.
    if (before.stage && !next.stage)
      w.delete("stage_speakers", { conversation_id: conv.id });
  }
  const on = (Object.keys(next) as (keyof ChannelOptions)[]).filter(
    (k) => k !== "posterRoleIds" && next[k],
  );
  ctx.audit({
    actorId,
    orgId,
    action: "channel.options",
    target: conv.id,
    detail: `${on.join(",") || "none"}${next.readOnly ? ` posters ${next.posterRoleIds.join(",") || "(managers)"}` : ""}`,
  });
  return true;
}

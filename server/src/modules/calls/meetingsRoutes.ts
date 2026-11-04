import type { FastifyInstance } from "fastify";
import { type AppContext } from "../../app/context.js";
import { me, requireAuth } from "../auth/index.js";
import {
  MEETING_REPEATS,
  MeetingCancelBody,
  MeetingBody,
  MeetingListQuery,
  MeetingRespondBody,
  MeetingUpdateBody,
  OrgParams,
} from "../../shared/contracts/http/meetings.js";
import { idParams } from "../../shared/contracts/http/primitives.js";
import { parse } from "../../shared/validation/index.js";
import type { EventRepeat } from "../organizations/eventRepeat.js";
import sharp from "sharp";
import { z } from "zod/v4";
import { readCommunityImage } from "../organizations/communityImages.js";
import { storePhoto } from "../accounts/photos.js";
import { deleteBlobNow } from "../files/routes.js";
import { badRequest, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";

/** The contract's repeat values are exactly the community events' (a compile error here when they drift apart). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const repeatsMatch: Same<EventRepeat, (typeof MEETING_REPEATS)[number]> = true;
void repeatsMatch;

/**
 * Scheduled meetings in voice channels (round 7, docs/WORKSPACE_C5.md), shown as community events in the app. The
 * service checks permissions itself; these routes only parse.
 */
export default async function meetingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
) {
  const auth = { preHandler: requireAuth(ctx) };

  app.get("/v1/orgs/:orgId/meetings", auth, async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const q = parse(MeetingListQuery, req.query);
    const from = q.from ?? Date.now() - 3_600_000;
    return {
      meetings: ctx.meetings.list(
        orgId,
        me(req).userId,
        from,
        q.to ?? from + 30 * 86_400_000,
      ),
    };
  });

  app.post("/v1/orgs/:orgId/meetings", auth, async (req) => ({
    meeting: await ctx.meetings.create(
      parse(OrgParams, req.params).orgId,
      me(req).userId,
      parse(MeetingBody, req.body),
    ),
  }));

  app.get("/v1/meetings/:id", auth, async (req) => ({
    meeting: ctx.meetings.get(parse(idParams, req.params).id, me(req).userId),
  }));

  app.put("/v1/meetings/:id", auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(MeetingUpdateBody, req.body);
    return {
      meeting: await ctx.meetings.update(id, me(req).userId, body.rev, body),
    };
  });

  app.post("/v1/meetings/:id/cancel", auth, async (req) => {
    const b = parse(MeetingCancelBody, req.body ?? {});
    return {
      meeting: await ctx.meetings.cancel(
        parse(idParams, req.params).id,
        me(req).userId,
        b.scope,
        b.rev,
      ),
    };
  });

  app.post("/v1/meetings/:id/respond", auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { response, rev } = parse(MeetingRespondBody, req.body);
    return {
      meeting: await ctx.meetings.respond(id, me(req).userId, response, rev),
    };
  });

  const coverRevision = z.object({ rev: z.coerce.number().int().positive() });
  app.put("/v1/meetings/:id/cover", auth, async (req) => {
    const { id } = parse(idParams, req.params),
      { userId } = me(req);
    const { rev } = parse(coverRevision, req.query);
    ctx.meetings.coverAccess(id, userId, true);
    const source = await readCommunityImage(req, "banner", "Event covers");
    let image: Buffer;
    try {
      image = await sharp(source, { limitInputPixels: 2048 * 1024 })
        .rotate()
        .resize(1200, 480, { fit: "cover", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      throw badRequest("That event cover is not a valid supported image");
    }
    const blob = newId("eventcover");
    await storePhoto(ctx, blob, image);
    let previous: string | null;
    try {
      previous = await ctx.meetings.setCover(id, userId, rev, blob);
    } catch (e) {
      await deleteBlobNow(ctx, "profile-photos", blob);
      throw e;
    }
    if (previous) await deleteBlobNow(ctx, "profile-photos", previous);
    return { meeting: ctx.meetings.get(id, userId) };
  });
  app.delete("/v1/meetings/:id/cover", auth, async (req) => {
    const { id } = parse(idParams, req.params),
      { userId } = me(req);
    const { rev } = parse(coverRevision, req.query);
    const previous = await ctx.meetings.setCover(id, userId, rev, null);
    if (previous) await deleteBlobNow(ctx, "profile-photos", previous);
    return { meeting: ctx.meetings.get(id, userId) };
  });
  app.get("/v1/meetings/:id/cover", auth, async (req, reply) => {
    const m = ctx.meetings.coverAccess(
      parse(idParams, req.params).id,
      me(req).userId,
    );
    const stream = m.cover_id
      ? await ctx.blobs.get("profile-photos", m.cover_id)
      : null;
    if (!stream) throw notFound("No event cover");
    return reply
      .header("Content-Type", "image/jpeg")
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(stream);
  });
}

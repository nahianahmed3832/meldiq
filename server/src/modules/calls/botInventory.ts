import type { AppContext } from "../../app/context.js";

/** Visible, currently joinable community voice rooms; never returns device ids, room names, JWTs or media keys. */
export async function botVoiceInventory(
  ctx: AppContext,
  userId: string,
  orgId: string,
  after: string | undefined,
  limit: number,
) {
  const rooms = () =>
    ctx.authz
      .conversationIdsOf(orgId)
      .flatMap((id) => {
        const c = ctx.authz.conversation(id);
        return c?.voice === 1 &&
          !c.archived_at &&
          (!after || id > after) &&
          ctx.authz.canConnectVoice(c, userId)
          ? [c]
          : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  ctx.authz.requireOrgMember(orgId, userId);
  const selected = rooms().slice(0, limit);
  const calls = await ctx.calls.liveIn(selected.map((c) => c.id));
  const participants = new Map(
    await Promise.all(
      calls.map(
        async (call) => [call.id, await ctx.calls.present(call.id)] as const,
      ),
    ),
  );
  // An async store read must never widen access revoked while it was in flight.
  ctx.authz.requireOrgMember(orgId, userId);
  const current = rooms();
  const allowed = new Set(current.map((c) => c.id));
  return {
    channels: selected
      .filter((c) => allowed.has(c.id))
      .map((c) => {
        const call = calls.find((call) => call.conversation_id === c.id);
        return {
          id: c.id,
          name: c.name ?? "",
          callId: call?.id ?? null,
          participants: [
            ...new Set(
              (call ? participants.get(call.id) : [])?.map((p) => p.user_id) ??
                [],
            ),
          ],
        };
      }),
    next: current.length > limit ? selected.at(-1)!.id : null,
  };
}

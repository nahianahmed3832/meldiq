import type { AppContext } from "../../src/app/context.js";
import type { CallRow } from "../../src/modules/calls/store.js";

/**
 * Test-only access to calls wherever they live (SQLite, or MongoDB when the run puts the "calls" domain there): what the
 * store offers goes through it, and the few test set-ups it has no operation for (moving a call back in time, listing
 * every call) touch the store's own tables or collections.
 */

const inMongo = (ctx: AppContext) => ctx.calls.backend === "mongodb";

/** Moves a call [ms] into the past: when it started and was answered, and when its devices joined. */
export async function backdateCall(ctx: AppContext, callId: string, ms: number): Promise<void> {
  if (inMongo(ctx)) {
    const db = ctx.mongo!.db;
    const back = (field: string) => ({ $cond: [{ $eq: [`$${field}`, null] }, null, { $subtract: [`$${field}`, ms] }] });
    await db.collection("calls").updateOne({ _id: callId as never }, [{ $set: { created_at: { $subtract: ["$created_at", ms] }, answered_at: back("answered_at") } }]);
    await db.collection("call_participants").updateMany({ call_id: callId }, [{ $set: { joined_at: { $subtract: ["$joined_at", ms] } } }]);
    return;
  }
  ctx.db.prepare("UPDATE calls SET created_at = created_at - ?, answered_at = answered_at - ? WHERE id = ?").run(ms, ms, callId);
  ctx.db.prepare("UPDATE call_participants SET joined_at = joined_at - ? WHERE call_id = ?").run(ms, callId);
}

/** Every call's id, wherever calls live. */
export async function allCallIds(ctx: AppContext): Promise<string[]> {
  if (inMongo(ctx)) return (await ctx.mongo!.db.collection("calls").find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id));
  return (ctx.db.prepare("SELECT id FROM calls").all() as { id: string }[]).map((c) => c.id);
}

/** A call row with defaults for what a test doesn't care about. */
export function callRow(r: Pick<CallRow, "id" | "conversation_id" | "created_by" | "state" | "created_at"> & Partial<CallRow>): CallRow {
  return {
    room_name: `room-${r.id}`,
    video: 0,
    answered_at: null,
    ended_at: null,
    end_reason: null,
    alerted_at: null,
    host_server_id: null,
    room: 0,
    ...r,
  };
}

/** The devices in a call now, sorted. */
export async function presentDevices(ctx: AppContext, callId: string): Promise<string[]> {
  return (await ctx.calls.present(callId)).map((p) => p.device_id).sort();
}

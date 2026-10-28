import type { AppContext } from "../../src/app/context.js";
import type { QueueItemRow } from "../../src/modules/messaging/index.js";

/**
 * What the relay holds, read from whichever store the server uses (SQLite, or MongoDB with the "relay" domain), so
 * suites check the queue the same way under MELDIQ_TEST_MONGO_DOMAINS (docs/product/MELDIQ_MONGODB_MIGRATION.md §4).
 */
export async function queuedRows(h: { ctx: AppContext }): Promise<QueueItemRow[]> {
  if (h.ctx.relay.backend === "mongodb") {
    const docs = await h.ctx.mongo!.db.collection("delivery_queue").find({}).sort({ id: 1 }).toArray();
    return docs.map(({ _id, ...row }) => row as unknown as QueueItemRow);
  }
  return h.ctx.db.prepare("SELECT * FROM delivery_queue ORDER BY id").all() as QueueItemRow[];
}

/** Count of queued items matching [where]. */
export async function queuedCount(h: { ctx: AppContext }, where: (r: QueueItemRow) => boolean = () => true): Promise<number> {
  return (await queuedRows(h)).filter(where).length;
}

/** The ids of a user's devices (to filter queue items by person). */
export function deviceIdsOf(h: { ctx: AppContext }, userId: string): Set<string> {
  return new Set(h.ctx.identity.all<{ id: string }>("devices", { where: { user_id: userId } }).map((d) => d.id));
}

/** Replaces a queued item's payload in place (to simulate what a recipient might receive). */
export async function setQueuedPayload(h: { ctx: AppContext }, id: number, payload: string): Promise<void> {
  if (h.ctx.relay.backend === "mongodb") await h.ctx.mongo!.db.collection("delivery_queue").updateOne({ _id: id as never }, { $set: { payload } });
  else h.ctx.db.prepare("UPDATE delivery_queue SET payload = ? WHERE id = ?").run(payload, id);
}

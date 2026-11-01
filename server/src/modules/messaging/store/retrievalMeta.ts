import type { MessageEvent } from "./messageStore.js";

/** Derived query fields only. The accepted event/payload remains immutable and is the source of truth. */
export interface RetrievalMeta { v: number; valid: boolean; root: string | null; media: boolean; files: boolean; pin: boolean }
export function retrievalMeta(e: Pick<MessageEvent, "payload">): RetrievalMeta {
  const empty: RetrievalMeta = { v: 1, valid: false, root: null, media: false, files: false, pin: false };
  try {
    const p = JSON.parse(e.payload);
    if (!p || typeof p !== "object" || Array.isArray(p)) return empty;
    const attachments: unknown[] = Array.isArray(p.attachments) ? p.attachments : [];
    const kinds = attachments.map((a: any) => {
      const mime = typeof a?.mime === "string" ? a.mime.toLowerCase() : "";
      const voice = a?.voice === true;
      const visual = !voice && (mime.startsWith("video/") || /^image\/(jpeg|png|webp|gif|heic|heif|bmp|avif)$/.test(mime));
      return { visual, file: !!mime && !visual && !voice };
    });
    return { v: 1, valid: true, root: typeof p.threadRoot === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(p.threadRoot) ? p.threadRoot : null,
      media: kinds.some((a) => a.visual), files: kinds.some((a) => a.file), pin: p.pinned === true };
  } catch { return empty; }
}

/** Batches are bounded even for large histories. Existing immutable event fields are never updated. */
export async function backfillRetrieval(db: import("mongodb").Db): Promise<{ scanned: number; updated: number; remaining: number }> {
  const col = db.collection("message_events");
  const cursor = col.find({ "_retrieval.v": { $ne: 1 } }, { projection: { _id: 1, payload: 1 }, batchSize: 100 });
  let batch: any[] = [], scanned = 0, updated = 0;
  const flush = async () => { if (batch.length) { updated += (await col.bulkWrite(batch, { ordered: false })).modifiedCount; batch = []; } };
  try {
    for await (const doc of cursor) {
      scanned++;
      batch.push({ updateOne: { filter: { _id: doc._id, "_retrieval.v": { $ne: 1 } }, update: { $set: { _retrieval: retrievalMeta({ payload: doc.payload }) } } } });
      if (batch.length === 100) await flush();
    }
    await flush();
  } finally { await cursor.close(); }
  return { scanned, updated, remaining: await col.countDocuments({ "_retrieval.v": { $ne: 1 } }) };
}

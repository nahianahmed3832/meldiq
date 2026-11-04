import type { MessageEvent } from "./messageStore.js";

/** Derived query fields only. The accepted event/payload remains immutable and is the source of truth. */
export interface RetrievalMeta {
  v: number;
  valid: boolean;
  root: string | null;
  media: boolean;
  files: boolean;
  pin: boolean;
  search?: {
    text: string | null;
    mentions: string[] | null;
    has: string[];
    link: boolean;
    title?: string | null;
    tags?: string[] | null;
  };
}
export function retrievalMeta(e: Pick<MessageEvent, "payload">): RetrievalMeta {
  const empty: RetrievalMeta = {
    v: 3,
    valid: false,
    root: null,
    media: false,
    files: false,
    pin: false,
  };
  try {
    const p = JSON.parse(e.payload);
    if (!p || typeof p !== "object" || Array.isArray(p)) return empty;
    const attachments: unknown[] = Array.isArray(p.attachments)
      ? p.attachments
      : [];
    const kinds = attachments.map((a: any) => {
      const mime = typeof a?.mime === "string" ? a.mime.toLowerCase() : "";
      const voice = a?.voice === true;
      const visual =
        !voice &&
        (mime.startsWith("video/") ||
          /^image\/(jpeg|png|webp|gif|heic|heif|bmp|avif)$/.test(mime));
      return { visual, file: !!mime && !visual && !voice };
    });
    const has = new Set<string>();
    for (const a of attachments as any[])
      if (a?.voice !== true && typeof a?.mime === "string") {
        const mime = a.mime.toLowerCase();
        if (mime)
          has.add(
            mime.startsWith("image/")
              ? "image"
              : mime.startsWith("video/")
                ? "video"
                : "file",
          );
      }
    return {
      v: 3,
      valid: true,
      root:
        typeof p.threadRoot === "string" &&
        /^[A-Za-z0-9_-]{8,64}$/.test(p.threadRoot)
          ? p.threadRoot
          : null,
      media: kinds.some((a) => a.visual),
      files: kinds.some((a) => a.file),
      pin: p.pinned === true,
      search: {
        text: typeof p.text === "string" ? p.text : null,
        title: typeof p.title === "string" ? p.title : null,
        tags: Array.isArray(p.tags)
          ? p.tags
              .filter(
                (t: unknown) =>
                  typeof t === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t),
              )
              .slice(0, 5)
          : null,
        mentions: Array.isArray(p.mentions)
          ? p.mentions.filter((m: unknown) => typeof m === "string")
          : null,
        has: [...has],
        link: typeof p.text === "string" && /\bhttps?:\/\/\S/i.test(p.text),
      },
    };
  } catch {
    return empty;
  }
}

/** Batches are bounded even for large histories. Existing immutable event fields are never updated. */
export async function backfillRetrieval(
  db: import("mongodb").Db,
): Promise<{ scanned: number; updated: number; remaining: number }> {
  const col = db.collection("message_events");
  const cursor = col.find(
    { "_retrieval.v": { $ne: 3 } },
    { projection: { _id: 1, payload: 1 }, batchSize: 100 },
  );
  let batch: any[] = [],
    scanned = 0,
    updated = 0;
  const flush = async () => {
    if (batch.length) {
      updated += (await col.bulkWrite(batch, { ordered: false })).modifiedCount;
      batch = [];
    }
  };
  try {
    for await (const doc of cursor) {
      scanned++;
      batch.push({
        updateOne: {
          filter: { _id: doc._id, "_retrieval.v": { $ne: 3 } },
          update: {
            $set: { _retrieval: retrievalMeta({ payload: doc.payload }) },
          },
        },
      });
      if (batch.length === 100) await flush();
    }
    await flush();
  } finally {
    await cursor.close();
  }
  return {
    scanned,
    updated,
    remaining: await col.countDocuments({ "_retrieval.v": { $ne: 3 } }),
  };
}

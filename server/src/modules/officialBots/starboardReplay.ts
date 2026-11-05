import { StoredEvent } from "../../shared/contracts/http/serverMessages.js";
import { eventToWire, type QueueItemRow } from "../messaging/index.js";
import type { OfficialBots } from "./runtime.js";

const unavailable = "Original message unavailable.";

function replayedEvent(row: QueueItemRow): StoredEvent | null {
  try {
    const data = JSON.parse(row.payload);
    const parsed = StoredEvent.safeParse(data?.event);
    if (data?.v !== 2 || !parsed.success) return null;
    const e = parsed.data;
    return e.id === row.message_id && e.conversationId === row.conversation_id && e.senderUserId === row.sender_user_id && e.senderDeviceId === null && e.importedBy === null ? e : null;
  } catch {
    return null;
  }
}

/** Only the official Starboard sender needs this extra read; other relay frames retain their bytes and fast path. */
export function projectStarboardReplay(rt: OfficialBots, viewer: string, rows: readonly QueueItemRow[]): Promise<QueueItemRow[]> | null {
  const actors = new Map<string, boolean>();
  const copies = rows.filter((row) => {
    if (row.kind !== "message" || row.sender_device_id !== `bot-${row.sender_user_id}`) return false;
    if (!actors.has(row.sender_user_id)) actors.set(row.sender_user_id, rt.rows.byAccount(row.sender_user_id)?.bot_key === "starboard");
    return actors.get(row.sender_user_id);
  });
  if (!copies.length) return null;
  return protect(rt, viewer, rows, copies);
}

async function protect(rt: OfficialBots, viewer: string, rows: readonly QueueItemRow[], copies: QueueItemRow[]): Promise<QueueItemRow[]> {
  const parsed = new Map(copies.map((row) => [row.id, replayedEvent(row)]));
  const originals = new Map<string, StoredEvent>();
  const unresolved = new Map<string, StoredEvent>();
  for (const event of parsed.values()) {
    if (event?.cls === "message") originals.set(event.id, event);
    else if (event?.cls === "control" && typeof event.payload.target === "string") unresolved.set(event.payload.target, event);
  }
  await Promise.all([...unresolved].filter(([id]) => !originals.has(id)).map(async ([id, change]) => {
    const target = await rt.ctx.messages.get(id);
    if (target?.cls !== "message" || target.audience !== "all" || target.sender_user_id !== change.senderUserId || target.conversation_id !== change.conversationId) return;
    try {
      originals.set(id, eventToWire(target));
    } catch {
      // Invalid old payloads are never replayed as Starboard content.
    }
  }));
  const { messages } = await rt.protectStarboardHistory(viewer, [...originals.values()]);
  const visible = new Map(messages.filter((event) => event.payload.starboard !== undefined).map((event) => [event.id, event]));
  return rows.map((row) => {
    if (!parsed.has(row.id)) return row;
    const event = parsed.get(row.id);
    const target = event?.cls === "control" && typeof event.payload.target === "string" ? event.payload.target : null;
    const original = event ? visible.get(target ?? event.id) : undefined;
    if (event && original?.conversationId === event.conversationId && original.senderUserId === event.senderUserId) return row;
    // Keep the delivery item and acknowledgement id. An edit arriving in a later batch carries no historic text.
    const safe: StoredEvent = {
      id: row.message_id, conversationId: row.conversation_id, senderUserId: row.sender_user_id, senderDeviceId: null,
      cls: target ? "control" : "message", sentAt: row.created_at, serverTs: row.created_at, importedBy: null, mentionAll: false,
      payload: target ? { type: "edit", target, text: unavailable } : { type: "text", text: unavailable },
    };
    return { ...row, payload: JSON.stringify({ v: 2, event: safe }) };
  });
}

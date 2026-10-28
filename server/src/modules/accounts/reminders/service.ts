import type { RowReader, RowWriter } from "../../../infrastructure/database/rows/index.js";
import type { AppContext } from "../../../app/context.js";
import { ApiError } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { nextOccurrence, type Recurrence, type RepeatRule, retryDelayMs } from "./schedule.js";

/** Reminders a person may have waiting (scheduled or fired) at once. */
export const MAX_ACTIVE_REMINDERS = 500;
/** Failed delivery attempts of one occurrence before it is marked failed and moved on. */
const MAX_ATTEMPTS = 8;
/** Due reminders handled per tick (the rest wait for the next one). */
const BATCH = 200;
/** Fired occurrences are remembered this long (dedupe), then forgotten. */
const OCCURRENCE_KEEP_MS = 30 * 86_400_000;
/** Done and dismissed reminders are kept this long for the Done list, then removed. */
const FINISHED_KEEP_MS = 30 * 86_400_000;

export type ReminderState = "scheduled" | "fired" | "done" | "dismissed";

export interface ReminderRow {
  id: string;
  user_id: string;
  sealed: string;
  due_at: number;
  time_zone: string;
  recurrence: Recurrence | null;
  local_time: string | null;
  anchor_date: string | null;
  state: ReminderState;
  fired_at: number | null;
  delivered_at: number | null;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface ReminderView {
  id: string;
  sealed: string;
  dueAt: number;
  timeZone: string;
  repeat: { recurrence: Recurrence; localTime: string; anchorDate: string } | null;
  state: ReminderState;
  firedAt: number | null;
  deliveredAt: number | null;
  /** "failed" after every delivery attempt of the last occurrence failed; null otherwise. */
  delivery: "failed" | null;
  rev: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ReminderInput {
  id: string;
  sealed: string;
  dueAt: number;
  timeZone: string;
  repeat?: { recurrence: Recurrence; localTime: string; anchorDate: string } | null;
}

export interface ReminderPatch {
  rev: number;
  sealed?: string;
  dueAt?: number;
  timeZone?: string;
  repeat?: { recurrence: Recurrence; localTime: string; anchorDate: string } | null;
  state?: ReminderState;
}

export interface TickResult {
  fired: number;
  retried: number;
  failed: number;
}

export function view(r: ReminderRow): ReminderView {
  return {
    id: r.id,
    sealed: r.sealed,
    dueAt: r.due_at,
    timeZone: r.time_zone,
    repeat: r.recurrence && r.local_time && r.anchor_date ? { recurrence: r.recurrence, localTime: r.local_time, anchorDate: r.anchor_date } : null,
    state: r.state,
    firedAt: r.fired_at,
    deliveredAt: r.delivered_at,
    delivery: r.last_error === "failed" ? "failed" : null,
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

const ruleOf = (r: Pick<ReminderRow, "recurrence" | "local_time" | "anchor_date" | "time_zone">): RepeatRule | null =>
  r.recurrence && r.local_time && r.anchor_date ? { recurrence: r.recurrence, localTime: r.local_time, anchorDate: r.anchor_date, timeZone: r.time_zone } : null;

const notFound = () => new ApiError(404, "reminder_not_found", "Reminder not found");

/**
 * Reminders kept and fired by the server (docs/REMINDERS.md): durable (rows, not timers), idempotent (one fire per
 * occurrence, recorded before it is delivered), retried with bounded backoff, and only ever about the owner's own
 * sealed content. Delivery is a WebSocket event to the person's connected devices plus a payload-free push wake-up for
 * the others; the app then shows the reminder from its own decrypted copy.
 */
export class ReminderService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  private row(userId: string, id: string, r: RowReader = this.ctx.identity): ReminderRow {
    const row = r.get<ReminderRow>("reminders", { id, user_id: userId });
    if (!row) throw notFound();
    return row;
  }

  list(userId: string, state?: ReminderState): ReminderView[] {
    return this.ctx.identity
      .all<ReminderRow>("reminders", { where: { user_id: userId, ...(state ? { state } : {}) }, orderBy: [["due_at", "asc"], ["id", "asc"]], limit: 1000 })
      .map(view);
  }

  get(userId: string, id: string): ReminderView {
    return view(this.row(userId, id));
  }

  /** Creates [input] (or returns it unchanged when the same id was already created by this person: a retried request). */
  async create(userId: string, deviceId: string, input: ReminderInput): Promise<ReminderView> {
    const t = now();
    const rule = input.repeat ? { ...input.repeat, timeZone: input.timeZone } : null;
    // A repeating reminder's first due time comes from its rule (so it matches the local time exactly), and is never
    // an occurrence that already passed.
    const dueAt = rule ? nextOccurrence(rule, Math.max(t, input.dueAt - 1)) : input.dueAt;
    const { row, isNew } = await this.ctx.identity.write((w) => {
      const existing = w.get<ReminderRow>("reminders", { id: input.id });
      if (existing) {
        if (existing.user_id !== userId) throw new ApiError(409, "reminder_id_taken", "Choose another reminder id");
        return { row: existing, isNew: false };
      }
      if (w.count("reminders", { user_id: userId, state: { in: ["scheduled", "fired"] } }) >= MAX_ACTIVE_REMINDERS) {
        throw new ApiError(409, "too_many_reminders", `You can have up to ${MAX_ACTIVE_REMINDERS} reminders waiting. Finish or delete some first.`);
      }
      w.insert("reminders", {
        id: input.id,
        user_id: userId,
        sealed: input.sealed,
        due_at: dueAt,
        time_zone: input.timeZone,
        recurrence: rule?.recurrence ?? null,
        local_time: rule?.localTime ?? null,
        anchor_date: rule?.anchorDate ?? null,
        state: "scheduled",
        rev: 1,
        created_at: t,
        updated_at: t,
      });
      return { row: this.row(userId, input.id, w), isNew: true };
    });
    if (isNew) this.changed(userId, row, deviceId);
    return view(row);
  }

  /**
   * Edits, snoozes, reschedules, completes or dismisses. [patch.rev] must be the current one (another device may have
   * changed it meanwhile: 409 with the current copy). A new due time or rule puts the reminder back to scheduled.
   */
  async update(userId: string, deviceId: string, id: string, patch: ReminderPatch): Promise<ReminderView> {
    const t = now();
    const updated = await this.ctx.identity.write((w) => {
      const r = this.row(userId, id, w);
      if (r.rev !== patch.rev) throw new ApiError(409, "stale_reminder", "This reminder changed on another device.", { current: view(r) });
      const timeZone = patch.timeZone ?? r.time_zone;
      const repeat = patch.repeat === undefined ? (ruleOf(r) ? { recurrence: r.recurrence!, localTime: r.local_time!, anchorDate: r.anchor_date! } : null) : patch.repeat;
      const rescheduled = patch.dueAt !== undefined || patch.repeat !== undefined || patch.timeZone !== undefined;
      let dueAt = patch.dueAt ?? r.due_at;
      if (repeat && rescheduled && patch.dueAt === undefined) dueAt = nextOccurrence({ ...repeat, timeZone }, t);
      let state: ReminderState = patch.state ?? r.state;
      if (rescheduled && patch.state === undefined) state = "scheduled";
      const finished = state === "done" || state === "dismissed";
      w.update(
        "reminders",
        { id, user_id: userId, rev: patch.rev },
        {
          sealed: patch.sealed ?? r.sealed,
          due_at: dueAt,
          time_zone: timeZone,
          recurrence: repeat?.recurrence ?? null,
          local_time: repeat?.localTime ?? null,
          anchor_date: repeat?.anchorDate ?? null,
          state,
          ...(rescheduled ? { attempts: 0, next_attempt_at: null, last_error: null } : {}),
          completed_at: finished ? (r.completed_at ?? t) : null,
          rev: r.rev + 1,
          updated_at: t,
        },
      );
      return this.row(userId, id, w);
    });
    this.changed(userId, updated, deviceId);
    return view(updated);
  }

  async delete(userId: string, deviceId: string, id: string): Promise<void> {
    const r = this.row(userId, id);
    await this.ctx.identity.write((w) => w.delete("reminders", { id, user_id: userId }));
    this.ctx.hub.sendToUser(userId, { t: "reminders.changed", id: r.id, deleted: true }, deviceId);
  }

  /** A device showed the occurrence that fired at [firedAt]. */
  async ack(userId: string, id: string, firedAt: number): Promise<void> {
    const r = this.row(userId, id);
    if (r.fired_at !== firedAt) return;
    await this.ctx.identity.write((w) => w.update("reminders", { id, user_id: userId, fired_at: firedAt }, { delivered_at: now() }));
  }

  private changed(userId: string, r: ReminderRow, exceptDeviceId?: string): void {
    this.ctx.hub.sendToUser(userId, { t: "reminders.changed", id: r.id, rev: r.rev }, exceptDeviceId);
  }

  // ───────────── Firing ─────────────

  /** Fires every reminder that is due at [t]. Safe to run twice for the same time or after a crash. */
  async tick(t = now()): Promise<TickResult> {
    const result: TickResult = { fired: 0, retried: 0, failed: 0 };
    const due = this.ctx.identity
      .all<ReminderRow>("reminders", { where: { state: "scheduled", due_at: { lte: t } }, orderBy: [["due_at", "asc"]] })
      .filter((r) => r.next_attempt_at === null || r.next_attempt_at <= t)
      .slice(0, BATCH);
    for (const r of due) {
      try {
        await this.fire(r, t);
        result.fired++;
      } catch (err) {
        const attempts = r.attempts + 1;
        const gaveUp = attempts >= MAX_ATTEMPTS;
        this.ctx.log.warn({ reminderId: r.id, attempts, errorType: err instanceof Error ? err.name : typeof err }, "reminder delivery failed");
        if (gaveUp) {
          // Move on (a repeating reminder to its next occurrence) rather than retry for ever; the app shows "failed".
          await this.ctx.identity.write((w) => this.advance(w, r, t, "failed"));
          result.failed++;
        } else {
          await this.ctx.identity.write((w) => w.update("reminders", { id: r.id, rev: r.rev }, { attempts, next_attempt_at: t + retryDelayMs(attempts), last_error: "retrying" }));
          result.retried++;
        }
      }
    }
    return result;
  }

  /**
   * One occurrence: recorded first (so a crash after delivering can't deliver it again), delivered, then the reminder
   * moves on. The record and the move are one unit; delivery is to whoever is reachable right now.
   */
  private async fire(r: ReminderRow, t: number): Promise<void> {
    const firstTime = await this.ctx.identity.write((w) => {
      const inserted = w.insert("reminder_occurrences", { reminder_id: r.id, occurrence_at: r.due_at, fired_at: t }, { orIgnore: true }).inserted;
      this.advance(w, r, t, null);
      return inserted;
    });
    if (!firstTime) return;
    // Best effort from here: the fired state is stored, so a device that misses this event still finds the reminder
    // when it next syncs (GET /v1/reminders), and shows it then.
    try {
      this.ctx.hub.sendToUser(r.user_id, { t: "reminder.due", id: r.id, occurrenceAt: r.due_at, firedAt: t });
      this.ctx.push?.remind(r.user_id);
      this.ctx.fcm?.wakeUser(r.user_id);
    } catch (err) {
      this.ctx.log.warn({ reminderId: r.id, errorType: err instanceof Error ? err.name : typeof err }, "reminder event not sent");
    }
  }

  private advance(w: RowWriter, r: ReminderRow, t: number, error: "failed" | null): void {
    const rule = ruleOf(r);
    const moved = { fired_at: t, attempts: 0, next_attempt_at: null, last_error: error, rev: r.rev + 1, updated_at: t };
    if (rule) w.update("reminders", { id: r.id, rev: r.rev }, { ...moved, due_at: nextOccurrence(rule, Math.max(t, r.due_at)) });
    else w.update("reminders", { id: r.id, rev: r.rev }, { ...moved, state: "fired" });
  }

  /** Old occurrence records and long-finished reminders (run by the cleanup job). */
  purge(t = now()): Promise<number> {
    return this.ctx.identity.write(
      (w) =>
        w.delete("reminder_occurrences", { fired_at: { lte: t - OCCURRENCE_KEEP_MS } }) +
        w.delete("reminders", { state: { in: ["done", "dismissed"] }, completed_at: { lte: t - FINISHED_KEEP_MS } }),
    );
  }

  /** Starts the firing loop (every [intervalMs]); stop() ends it. A tick never overlaps the previous one. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      const t0 = performance.now();
      this.tick()
        .then((r) => {
          this.ctx.metrics?.recordJob("reminders.tick", performance.now() - t0);
          if (r.fired || r.retried || r.failed) this.ctx.log.info(r, "reminders fired");
        })
        .catch((err) => {
          this.ctx.metrics?.recordJob("reminders.tick", performance.now() - t0, err);
          this.ctx.log.error({ errorType: err instanceof Error ? err.name : typeof err }, "reminder tick failed");
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

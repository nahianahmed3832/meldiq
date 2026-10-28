import type { ConversationRow } from "../organizations/authz.js";
import type { AppContext } from "../../app/context.js";
import { errorKind } from "../administration/ops/metrics.js";
import { isValidTimeZone } from "../accounts/reminders/schedule.js";
import { MEETING_INPUT_LIMITS } from "../../shared/contracts/http/meetings.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import { currentOccurrence, type EventRepeat } from "../organizations/eventRepeat.js";

/**
 * Scheduled meetings (docs/WORKSPACE_C5.md, round 7 slice C5). A meeting belongs to a voice room, the workspace's
 * dedicated meeting channel; joining it is joining that room's call, never a call on a text channel. Everyone invited
 * must already be able to open the room. Participants hear about it as it changes, and get a "starting soon" notice
 * ten minutes before. Title and times are readable by the server, like a channel's name.
 */
interface MeetingRow {
  id: string;
  org_id: string;
  room_id: string;
  title: string;
  description: string | null;
  starts_at: number;
  ends_at: number;
  time_zone: string;
  organizer_id: string;
  cancelled_at: number | null;
  notified_at: number | null;
  rev: number;
  created_at: number;
  updated_at: number;
  repeat: EventRepeat | null;
}

export const MEETING_LIMITS = { ...MEETING_INPUT_LIMITS, maxHours: 24, soonMs: 10 * 60_000, pastGraceMs: 5 * 60_000 } as const;

export interface MeetingInput {
  roomId: string;
  title: string;
  description?: string | null;
  startsAt: number;
  endsAt: number;
  timeZone: string;
  participantIds: string[];
  groupIds: string[];
  /** Batch B8b: how it repeats; null or absent: once. */
  repeat?: EventRepeat | null;
}

export class MeetingService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  private load(id: string): MeetingRow | undefined {
    return this.ctx.ws.get<MeetingRow>("meetings", { id });
  }

  private participants(id: string): { user_id: string; response: string }[] {
    return this.ctx.ws.all<{ user_id: string; response: string }>("meeting_participants", { where: { meeting_id: id } });
  }

  /** The organizer, people invited, and anyone who can open the room see the meeting; nobody else, not even its title. */
  private canSee(m: MeetingRow, userId: string): boolean {
    const { authz } = this.ctx;
    if (!authz.orgRole(m.org_id, userId)) return false;
    if (m.organizer_id === userId || this.participants(m.id).some((p) => p.user_id === userId)) return true;
    const room = authz.conversation(m.room_id);
    return !!room && authz.canViewChannel(room, userId);
  }

  private canEdit(m: MeetingRow, userId: string): boolean {
    const room = this.ctx.authz.conversation(m.room_id);
    return m.organizer_id === userId || (!!room && this.ctx.authz.canManageConversation(room, userId));
  }

  private require(id: string, userId: string): MeetingRow {
    const m = this.load(id);
    if (!m || !this.canSee(m, userId)) throw notFound("Meeting not found");
    return m;
  }

  private name(id: string): string | null {
    return this.ctx.identity.get<{ display_name: string }>("users", { id })?.display_name ?? null;
  }

  view(m: MeetingRow, userId: string) {
    const room = this.ctx.authz.conversation(m.room_id);
    const ps = this.participants(m.id);
    return {
      id: m.id, orgId: m.org_id, title: m.title, description: m.description,
      room: room ? { id: room.id, name: room.name } : null,
      startsAt: m.starts_at, endsAt: m.ends_at, timeZone: m.time_zone,
      organizer: { id: m.organizer_id, name: this.name(m.organizer_id) },
      participants: ps.map((p) => ({ id: p.user_id, name: this.name(p.user_id), response: p.response })),
      myResponse: ps.find((p) => p.user_id === userId)?.response ?? null,
      cancelled: m.cancelled_at !== null,
      repeat: m.repeat ?? null,
      canEdit: this.canEdit(m, userId),
      rev: m.rev,
    };
  }

  /** Meetings in [from, to) the person may see, earliest first (default: from an hour ago, the next 30 days). */
  list(orgId: string, userId: string, from: number, to: number) {
    this.ctx.authz.requireOrgMember(orgId, userId);
    const rows = this.ctx.ws
      .all<MeetingRow>("meetings", { where: { org_id: orgId, ends_at: { gt: from } }, orderBy: [["starts_at", "asc"]] })
      .filter((m) => m.starts_at < to)
      .slice(0, 500);
    return rows.filter((m) => this.canSee(m, userId)).map((m) => this.view(m, userId));
  }

  get(id: string, userId: string) {
    return this.view(this.require(id, userId), userId);
  }

  /** The room must be a voice room of the workspace the organizer can open; everyone invited must be able to open it too. */
  private validate(orgId: string, organizerId: string, input: MeetingInput): { room: ConversationRow; invitees: string[] } {
    const { authz } = this.ctx;
    const room = authz.conversation(input.roomId);
    if (!room || room.type !== "CHANNEL" || room.org_id !== orgId || !room.voice) throw badRequest("Meetings happen in a voice room of this workspace");
    if (!authz.canViewChannel(room, organizerId)) throw badRequest("You can't open that voice room");
    if (room.archived_at) throw conflict("That voice room is archived");
    if (!(input.endsAt > input.startsAt)) throw badRequest("A meeting has to end after it starts");
    if (input.endsAt - input.startsAt > MEETING_LIMITS.maxHours * 3_600_000) throw badRequest(`A meeting lasts at most ${MEETING_LIMITS.maxHours} hours`);
    if (!isValidTimeZone(input.timeZone)) throw badRequest("Unknown time zone");
    const invitees = [...new Set(input.participantIds)].filter((u) => u !== organizerId);
    if (invitees.length > MEETING_LIMITS.participants) throw badRequest(`A meeting has at most ${MEETING_LIMITS.participants} people invited`);
    const cannot = invitees.filter((u) => !authz.orgRole(orgId, u) || !authz.canViewChannel(room, u));
    if (cannot.length) throw badRequest("Some people can't open that voice room: add them to it first", { userIds: cannot });
    return { room, invitees };
  }

  private notify(m: MeetingRow, kind: "meeting.updated" | "meeting.soon", extra: string[] = []): void {
    const users = new Set([m.organizer_id, ...this.participants(m.id).map((p) => p.user_id), ...extra]);
    this.ctx.hub.sendToUsers(users, { t: kind, orgId: m.org_id, meetingId: m.id, startsAt: m.starts_at });
  }

  async create(orgId: string, organizerId: string, input: MeetingInput) {
    const role = this.ctx.authz.requireOrgMember(orgId, organizerId);
    if (role === "GUEST") throw forbidden("Guests can't schedule meetings");
    if (input.startsAt < now() - MEETING_LIMITS.pastGraceMs) throw badRequest("Pick a time that hasn't passed yet");
    const { invitees } = this.validate(orgId, organizerId, input);
    const id = newId("mtg");
    const t = now();
    await this.ctx.ws.write((w) => {
      w.insert("meetings", {
        id,
        org_id: orgId,
        room_id: input.roomId,
        title: input.title,
        description: input.description ?? null,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        time_zone: input.timeZone,
        organizer_id: organizerId,
        rev: 1,
        created_at: t,
        updated_at: t,
        repeat: input.repeat ?? null,
      });
      for (const u of invitees) w.insert("meeting_participants", { meeting_id: id, user_id: u, response: "pending" });
    });
    this.ctx.audit({ actorId: organizerId, orgId, action: "meeting.create", target: id });
    const m = this.load(id) as MeetingRow;
    this.notify(m, "meeting.updated");
    return this.view(m, organizerId);
  }

  async update(id: string, userId: string, rev: number, input: MeetingInput) {
    const m = this.require(id, userId);
    if (!this.canEdit(m, userId)) throw forbidden("Only the organizer or the room's managers can change this meeting");
    if (m.cancelled_at) throw conflict("This meeting was cancelled");
    if (m.rev !== rev) throw new ApiError(409, "stale_revision", "Someone changed this meeting meanwhile. Reload it and try again.");
    const { invitees } = this.validate(m.org_id, m.organizer_id, input);
    const before = this.participants(id).map((p) => p.user_id);
    const t = now();
    const timeChanged = input.startsAt !== m.starts_at;
    await this.ctx.ws.write((w) => {
      const current = w.get<MeetingRow>("meetings", { id })!;
      w.update(
        "meetings",
        { id },
        {
          room_id: input.roomId,
          title: input.title,
          description: input.description ?? null,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          time_zone: input.timeZone,
          repeat: input.repeat === undefined ? m.repeat : input.repeat,
          rev: current.rev + 1,
          updated_at: t,
          ...(timeChanged ? { notified_at: null } : {}),
        },
      );
      w.delete("meeting_participants", { meeting_id: id, user_id: { notIn: invitees } });
      for (const u of invitees) w.insert("meeting_participants", { meeting_id: id, user_id: u, response: "pending" }, { orIgnore: true });
      // A new time asks everyone again.
      if (timeChanged) w.update("meeting_participants", { meeting_id: id }, { response: "pending" });
    });
    this.ctx.audit({ actorId: userId, orgId: m.org_id, action: "meeting.update", target: id });
    const fresh = this.load(id) as MeetingRow;
    this.notify(fresh, "meeting.updated", before);
    return this.view(fresh, userId);
  }

  async cancel(id: string, userId: string) {
    const m = this.require(id, userId);
    if (!this.canEdit(m, userId)) throw forbidden("Only the organizer or the room's managers can cancel this meeting");
    await this.ctx.ws.write((w) => {
      const current = w.get<MeetingRow>("meetings", { id, cancelled_at: null });
      if (current) w.update("meetings", { id }, { cancelled_at: now(), rev: current.rev + 1, updated_at: now() });
    });
    this.ctx.audit({ actorId: userId, orgId: m.org_id, action: "meeting.cancel", target: id });
    const fresh = this.load(id) as MeetingRow;
    this.notify(fresh, "meeting.updated");
    return this.view(fresh, userId);
  }

  async respond(id: string, userId: string, response: "accepted" | "declined" | "tentative") {
    const m = this.require(id, userId);
    const changed = await this.ctx.ws.write((w) => w.update("meeting_participants", { meeting_id: id, user_id: userId }, { response }));
    if (!changed) throw badRequest("You're not invited to this meeting");
    this.ctx.hub.sendToUser(m.organizer_id, { t: "meeting.updated", orgId: m.org_id, meetingId: m.id, startsAt: m.starts_at });
    return this.view(m, userId);
  }

  /**
   * Batch B8b: a repeating event whose occurrence has ended moves to its next one (same people and answers, a new
   * "starting soon" notice). Run with the notices; exposed for tests.
   */
  async rollRepeating(t = now()): Promise<number> {
    const ended = this.ctx.ws.all<MeetingRow>("meetings", { where: { repeat: { ne: null }, cancelled_at: null, ends_at: { lte: t } } });
    for (const m of ended) {
      const start = currentOccurrence(m.starts_at, m.ends_at - m.starts_at, m.repeat as EventRepeat, m.time_zone, t);
      await this.ctx.ws.write((w) => w.update("meetings", { id: m.id }, { starts_at: start, ends_at: start + (m.ends_at - m.starts_at), notified_at: null, rev: m.rev + 1, updated_at: t }));
      this.notify(this.load(m.id) as MeetingRow, "meeting.updated");
    }
    return ended.length;
  }

  /** Sends "starting soon" once per meeting (and again after its time changes). Exposed for tests. */
  async notifySoon(): Promise<number> {
    const t = now();
    await this.rollRepeating(t);
    const due = this.ctx.ws
      .all<MeetingRow>("meetings", { where: { cancelled_at: null, notified_at: null, starts_at: { lte: t + MEETING_LIMITS.soonMs } } })
      .filter((m) => m.ends_at > t);
    for (const m of due) {
      await this.ctx.ws.write((w) => w.update("meetings", { id: m.id }, { notified_at: t }));
      this.notify(m, "meeting.soon");
    }
    return due.length;
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (!this.ctx.db.open) return;
      this.ctx.metrics.timeJob("meetings.soon", async () => this.notifySoon()).catch((e) => this.ctx.log.error({ errorType: errorKind(e) }, "meeting notices failed"));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

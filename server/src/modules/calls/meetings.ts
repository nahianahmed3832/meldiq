import type { ConversationRow } from "../organizations/authz.js";
import type { AppContext } from "../../app/context.js";
import { errorKind } from "../administration/ops/metrics.js";
import { isValidTimeZone } from "../accounts/reminders/schedule.js";
import { MEETING_INPUT_LIMITS } from "../../shared/contracts/http/meetings.js";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import {
  currentOccurrence,
  nextEventStart,
  type EventRepeat,
} from "../organizations/eventRepeat.js";

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
  cover_id: string | null;
  external_location: string | null;
  occurrence_base: string | null;
  occurrence_cancelled: number;
}

export const MEETING_LIMITS = {
  ...MEETING_INPUT_LIMITS,
  maxHours: 24,
  soonMs: 10 * 60_000,
  pastGraceMs: 5 * 60_000,
} as const;

export interface MeetingInput {
  roomId: string;
  externalLocation?: string | null;
  scope?: "occurrence" | "series";
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
    return this.ctx.ws.all<{ user_id: string; response: string }>(
      "meeting_participants",
      { where: { meeting_id: id } },
    );
  }

  /** The organizer, people invited, and anyone who can open the room see the meeting; nobody else, not even its title. */
  private canSee(m: MeetingRow, userId: string): boolean {
    const { authz } = this.ctx;
    if (!authz.orgRole(m.org_id, userId)) return false;
    const room = authz.conversation(m.room_id);
    return !!room && authz.canViewChannel(room, userId);
  }

  private canEdit(m: MeetingRow, userId: string): boolean {
    const room = this.ctx.authz.conversation(m.room_id);
    return (
      m.organizer_id === userId ||
      this.ctx.authz.can(m.org_id, userId, "events.manage") ||
      (!!room && this.ctx.authz.canManageConversation(room, userId))
    );
  }

  private require(id: string, userId: string): MeetingRow {
    const m = this.load(id);
    if (!m || !this.canSee(m, userId)) throw notFound("Meeting not found");
    return m;
  }

  private name(id: string): string | null {
    return (
      this.ctx.identity.get<{ display_name: string }>("users", { id })
        ?.display_name ?? null
    );
  }

  view(m: MeetingRow, userId: string) {
    const room = this.ctx.authz.conversation(m.room_id);
    const ps = this.participants(m.id);
    return {
      id: m.id,
      orgId: m.org_id,
      title: m.title,
      description: m.description,
      room:
        room && !m.external_location ? { id: room.id, name: room.name } : null,
      externalLocation: m.external_location ?? null,
      visibilityChannel: { id: m.room_id, name: room?.name ?? null },
      occurrenceOverride: !!m.occurrence_base,
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      timeZone: m.time_zone,
      organizer: { id: m.organizer_id, name: this.name(m.organizer_id) },
      participants: ps.map((p) => ({
        id: p.user_id,
        name: this.name(p.user_id),
        response: p.response,
      })),
      myResponse: ps.find((p) => p.user_id === userId)?.response ?? null,
      cancelled: m.cancelled_at !== null || !!m.occurrence_cancelled,
      repeat: m.repeat ?? null,
      coverId: m.cover_id ?? null,
      canEdit: this.canEdit(m, userId),
      rev: m.rev,
    };
  }

  /** Meetings in [from, to) the person may see, earliest first (default: from an hour ago, the next 30 days). */
  list(orgId: string, userId: string, from: number, to: number) {
    this.ctx.authz.requireOrgMember(orgId, userId);
    const rows = this.ctx.ws
      .all<MeetingRow>("meetings", {
        where: { org_id: orgId, ends_at: { gt: from } },
        orderBy: [["starts_at", "asc"]],
      })
      .filter((m) => m.starts_at < to)
      .slice(0, 500);
    return rows
      .filter((m) => this.canSee(m, userId))
      .map((m) => this.view(m, userId));
  }

  get(id: string, userId: string) {
    return this.view(this.require(id, userId), userId);
  }

  coverAccess(id: string, userId: string, editing = false) {
    const m = this.require(id, userId);
    if (editing && !this.canEdit(m, userId))
      throw forbidden("Only event managers can change this cover");
    return m;
  }

  async setCover(
    id: string,
    userId: string,
    rev: number,
    coverId: string | null,
  ) {
    this.coverAccess(id, userId, true);
    const previous = await this.ctx.ws.write((w) => {
      const m = w.get<MeetingRow>("meetings", { id });
      if (!m || m.rev !== rev || m.cancelled_at)
        throw new ApiError(
          409,
          "stale_revision",
          "This event changed. Reload before changing its cover.",
        );
      w.update(
        "meetings",
        { id },
        { cover_id: coverId, rev: m.rev + 1, updated_at: now() },
      );
      return m.cover_id;
    });
    this.ctx.audit({
      actorId: userId,
      orgId: this.load(id)!.org_id,
      action: "meeting.cover",
      target: id,
    });
    this.notify(this.load(id)!, "meeting.updated");
    return previous;
  }

  /** The room must be a voice room of the workspace the organizer can open; everyone invited must be able to open it too. */
  private validate(
    orgId: string,
    organizerId: string,
    input: MeetingInput,
  ): { room: ConversationRow; invitees: string[] } {
    const { authz } = this.ctx;
    const room = authz.conversation(input.roomId);
    if (
      !room ||
      room.type !== "CHANNEL" ||
      room.org_id !== orgId ||
      (!input.externalLocation && !room.voice)
    )
      throw badRequest("Meetings happen in a voice room of this workspace");
    if (!authz.canViewChannel(room, organizerId))
      throw badRequest("You can't open that voice room");
    if (room.archived_at) throw conflict("That voice room is archived");
    if (input.externalLocation) {
      const location = input.externalLocation;
      if (/[\u0000-\u001f\u007f]/.test(location))
        throw badRequest("Use a plain location or an HTTPS address");
      if (/^[a-z][a-z0-9+.-]*:/i.test(location)) {
        let url: URL;
        try {
          url = new URL(location);
        } catch {
          throw badRequest("Invalid external location");
        }
        if (url.protocol !== "https:" || url.username || url.password)
          throw badRequest("External links must use HTTPS without credentials");
      }
    }
    if (!(input.endsAt > input.startsAt))
      throw badRequest("A meeting has to end after it starts");
    if (input.endsAt - input.startsAt > MEETING_LIMITS.maxHours * 3_600_000)
      throw badRequest(
        `A meeting lasts at most ${MEETING_LIMITS.maxHours} hours`,
      );
    if (!isValidTimeZone(input.timeZone)) throw badRequest("Unknown time zone");
    const invitees = [...new Set(input.participantIds)].filter(
      (u) => u !== organizerId,
    );
    if (invitees.length > MEETING_LIMITS.participants)
      throw badRequest(
        `A meeting has at most ${MEETING_LIMITS.participants} people invited`,
      );
    const cannot = invitees.filter(
      (u) => !authz.orgRole(orgId, u) || !authz.canViewChannel(room, u),
    );
    if (cannot.length)
      throw badRequest(
        "Some people can't open that voice room: add them to it first",
        { userIds: cannot },
      );
    return { room, invitees };
  }

  private notify(
    m: MeetingRow,
    kind: "meeting.updated" | "meeting.soon",
    extra: string[] = [],
  ): void {
    const users = new Set([
      m.organizer_id,
      ...this.participants(m.id).map((p) => p.user_id),
      ...extra,
    ]);
    this.ctx.hub.sendToUsers(
      [...users].filter((u) => this.canSee(m, u)),
      { t: kind, orgId: m.org_id, meetingId: m.id, startsAt: m.starts_at },
    );
  }

  async create(orgId: string, organizerId: string, input: MeetingInput) {
    const role = this.ctx.authz.requireOrgMember(orgId, organizerId);
    if (role === "GUEST") throw forbidden("Guests can't schedule meetings");
    if (input.startsAt < now() - MEETING_LIMITS.pastGraceMs)
      throw badRequest("Pick a time that hasn't passed yet");
    const { invitees } = this.validate(orgId, organizerId, input);
    const id = newId("mtg");
    const t = now();
    await this.ctx.ws.write((w) => {
      w.insert("meetings", {
        id,
        org_id: orgId,
        room_id: input.roomId,
        external_location: input.externalLocation ?? null,
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
      for (const u of invitees)
        w.insert("meeting_participants", {
          meeting_id: id,
          user_id: u,
          response: "pending",
        });
    });
    this.ctx.audit({
      actorId: organizerId,
      orgId,
      action: "meeting.create",
      target: id,
    });
    const m = this.load(id) as MeetingRow;
    this.notify(m, "meeting.updated");
    return this.view(m, organizerId);
  }

  async update(id: string, userId: string, rev: number, input: MeetingInput) {
    const m = this.require(id, userId);
    if (!this.canEdit(m, userId))
      throw forbidden(
        "Only the organizer or the room's managers can change this meeting",
      );
    if (m.cancelled_at) throw conflict("This meeting was cancelled");
    if (input.startsAt < now() - MEETING_LIMITS.pastGraceMs)
      throw badRequest("Pick a time that hasn't passed yet");
    if (m.rev !== rev)
      throw new ApiError(
        409,
        "stale_revision",
        "Someone changed this meeting meanwhile. Reload it and try again.",
      );
    input = {
      ...input,
      externalLocation:
        input.externalLocation === undefined
          ? m.external_location
          : input.externalLocation,
    };
    const { invitees } = this.validate(m.org_id, m.organizer_id, input);
    const before = this.participants(id).map((p) => p.user_id);
    const t = now();
    const timeChanged =
      input.startsAt !== m.starts_at || input.endsAt !== m.ends_at;
    const occurrence = input.scope === "occurrence" && !!m.repeat;
    const base = m.occurrence_base ? JSON.parse(m.occurrence_base) : null;
    if (occurrence) {
      if (input.repeat !== undefined && input.repeat !== m.repeat)
        throw badRequest("Change repeat settings for the series");
      const anchor = base?.starts_at ?? m.starts_at;
      if (
        input.endsAt >
        nextEventStart(anchor, m.repeat!, base?.time_zone ?? m.time_zone)
      )
        throw badRequest(
          "This occurrence must end before the next series occurrence",
        );
    }
    await this.ctx.ws.write((w) => {
      const current = w.get<MeetingRow>("meetings", { id })!;
      if (current.rev !== rev || current.cancelled_at)
        throw new ApiError(
          409,
          "stale_revision",
          "Someone changed this meeting meanwhile. Reload it and try again.",
        );
      w.update(
        "meetings",
        { id },
        {
          occurrence_base: occurrence
            ? (current.occurrence_base ??
              JSON.stringify({
                room_id: current.room_id,
                external_location: current.external_location,
                title: current.title,
                description: current.description,
                starts_at: current.starts_at,
                ends_at: current.ends_at,
                time_zone: current.time_zone,
                participants: w.all("meeting_participants", {
                  where: { meeting_id: id },
                }),
              }))
            : null,
          occurrence_cancelled: 0,
          room_id: input.roomId,
          external_location:
            input.externalLocation === undefined
              ? current.external_location
              : input.externalLocation,
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
      w.delete("meeting_participants", {
        meeting_id: id,
        user_id: { notIn: invitees },
      });
      for (const u of invitees)
        w.insert(
          "meeting_participants",
          { meeting_id: id, user_id: u, response: "pending" },
          { orIgnore: true },
        );
      // A new time asks everyone again.
      if (timeChanged)
        w.update(
          "meeting_participants",
          { meeting_id: id },
          { response: "pending" },
        );
    });
    this.ctx.audit({
      actorId: userId,
      orgId: m.org_id,
      action: "meeting.update",
      target: id,
    });
    const fresh = this.load(id) as MeetingRow;
    this.notify(fresh, "meeting.updated", before);
    return this.view(fresh, userId);
  }

  async cancel(
    id: string,
    userId: string,
    scope: "occurrence" | "series" = "series",
    rev?: number,
  ) {
    const m = this.require(id, userId);
    if (!this.canEdit(m, userId))
      throw forbidden(
        "Only the organizer or the room's managers can cancel this meeting",
      );
    const changed = await this.ctx.ws.write((w) => {
      const current = w.get<MeetingRow>("meetings", { id, cancelled_at: null });
      if (!current) return false;
      if (rev !== undefined && current.rev !== rev)
        throw new ApiError(
          409,
          "stale_revision",
          "This event changed. Reload before cancelling.",
        );
      if (scope === "occurrence" && current.repeat) {
        if (current.occurrence_cancelled) return false;
        w.update(
          "meetings",
          { id },
          { occurrence_cancelled: 1, rev: current.rev + 1, updated_at: now() },
        );
      } else
        w.update(
          "meetings",
          { id },
          { cancelled_at: now(), rev: current.rev + 1, updated_at: now() },
        );
      return true;
    });
    const fresh = this.load(id) as MeetingRow;
    if (changed) {
      this.ctx.audit({
        actorId: userId,
        orgId: m.org_id,
        action:
          scope === "occurrence" && m.repeat
            ? "meeting.cancel_occurrence"
            : "meeting.cancel",
        target: id,
      });
      this.notify(fresh, "meeting.updated");
    }
    return this.view(fresh, userId);
  }

  async respond(
    id: string,
    userId: string,
    response: "accepted" | "declined" | "tentative",
    rev?: number,
  ) {
    const m = this.require(id, userId);
    const changed = await this.ctx.ws.write((w) => {
      const current = w.get<MeetingRow>("meetings", { id });
      if (!current || current.cancelled_at || current.occurrence_cancelled)
        throw conflict("This occurrence was cancelled");
      if (rev !== undefined && current.rev !== rev)
        throw new ApiError(
          409,
          "stale_revision",
          "This occurrence changed. Reload before responding.",
        );
      return w.update(
        "meeting_participants",
        { meeting_id: id, user_id: userId },
        { response },
      );
    });
    if (!changed) throw badRequest("You're not invited to this meeting");
    this.ctx.hub.sendToUser(m.organizer_id, {
      t: "meeting.updated",
      orgId: m.org_id,
      meetingId: m.id,
      startsAt: m.starts_at,
    });
    return this.view(m, userId);
  }

  /**
   * Batch B8b: a repeating event whose occurrence has ended moves to its next one (same people and answers, a new
   * "starting soon" notice). Run with the notices; exposed for tests.
   */
  async rollRepeating(t = now()): Promise<number> {
    const ended = this.ctx.ws.all<MeetingRow>("meetings", {
      where: { repeat: { ne: null }, cancelled_at: null, ends_at: { lte: t } },
    });
    let changed = 0;
    for (const m of ended) {
      const updated = await this.ctx.ws.write((w) => {
        const current = w.get<MeetingRow>("meetings", {
          id: m.id,
          rev: m.rev,
          cancelled_at: null,
        });
        if (!current) return false;
        const base = current.occurrence_base
          ? JSON.parse(current.occurrence_base)
          : null;
        const anchor = base?.starts_at ?? current.starts_at,
          end = base?.ends_at ?? current.ends_at;
        if (Math.max(end, current.ends_at) > t) return false;
        const start = currentOccurrence(
          anchor,
          end - anchor,
          current.repeat!,
          base?.time_zone ?? current.time_zone,
          t,
        );
        const {
          participants,
          starts_at: _start,
          ends_at: _end,
          ...fields
        } = base ?? {};
        void _start;
        void _end;
        w.update(
          "meetings",
          { id: m.id },
          {
            ...fields,
            starts_at: start,
            ends_at: start + end - anchor,
            occurrence_base: null,
            occurrence_cancelled: 0,
            notified_at: null,
            rev: current.rev + 1,
            updated_at: t,
          },
        );
        if (participants) {
          w.delete("meeting_participants", { meeting_id: m.id });
          for (const p of participants)
            if (this.ctx.authz.orgRole(current.org_id, p.user_id))
              w.insert("meeting_participants", p);
        }
        return true;
      });
      if (updated) {
        changed++;
        this.notify(this.load(m.id)!, "meeting.updated");
      }
    }
    return changed;
  }

  /** Sends "starting soon" once per meeting (and again after its time changes). Exposed for tests. */
  async notifySoon(): Promise<number> {
    const t = now();
    await this.rollRepeating(t);
    const due = this.ctx.ws
      .all<MeetingRow>("meetings", {
        where: {
          cancelled_at: null,
          occurrence_cancelled: 0,
          notified_at: null,
          starts_at: { lte: t + MEETING_LIMITS.soonMs },
        },
      })
      .filter((m) => m.ends_at > t);
    let sent = 0;
    for (const m of due) {
      const claimed = await this.ctx.ws.write((w) =>
        w.update(
          "meetings",
          {
            id: m.id,
            notified_at: null,
            cancelled_at: null,
            occurrence_cancelled: 0,
            rev: m.rev,
          },
          { notified_at: t },
        ),
      );
      if (claimed) {
        this.notify(m, "meeting.soon");
        sent++;
      }
    }
    return sent;
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (!this.ctx.db.open) return;
      this.ctx.metrics
        .timeJob("meetings.soon", async () => this.notifySoon())
        .catch((e) =>
          this.ctx.log.error(
            { errorType: errorKind(e) },
            "meeting notices failed",
          ),
        );
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

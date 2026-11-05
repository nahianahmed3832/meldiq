import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod/v4";
import type { TicketOpenBody } from "../../../shared/contracts/http/tickets.js";
import { ApiError, conflict, forbidden, notFound } from "../../../shared/errors.js";
import { newId, now } from "../../../shared/utilities/util.js";
import type { RowWriter } from "../../../infrastructure/database/rows/index.js";
import { botsAmong, namesOf } from "../../accounts/index.js";
import { addChannelMember, archiveChannel, channelsInCategory, channelsInCommunity, insertChannel, restorePrivateChannel, retainPrivateChannelMembers } from "../../messaging/index.js";
import { CHANNEL_LIMITS, notifyConversation, notifyOrg } from "../orgsRoutes.js";
import { EVERYONE, USER_PREFIX } from "../permissions/channel.js";
import { postAs } from "./senders.js";
import type { PanelRow, SettingsRow, TicketRow, Tickets } from "./tickets.js";

/** What the opener and staff roles may do in a ticket channel (everyone else can't see it). */
const TICKET_CAPABILITIES = ["channels.view", "messages.post", "messages.attach"];
const CHANNEL_NAME_MAX = 60;

/** "ticket-12-ana": the number, then the opener's username in letters, digits and dashes. */
export function ticketChannelName(n: number, username: string): string {
  const who = username.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
  return `ticket-${n}-${who}`.slice(0, CHANNEL_NAME_MAX);
}

function overwrite(w: RowWriter, orgId: string, channelId: string, subject: string, allow: readonly string[], deny: readonly string[], by: string, at: number): void {
  const row = { target_type: "channel", target_id: channelId, org_id: orgId, subject, allow: JSON.stringify(allow), deny: JSON.stringify(deny), updated_by: by, updated_at: at };
  w.upsert("channel_overwrites", row, { allow: row.allow, deny: row.deny, updated_by: by, updated_at: at });
}

/**
 * Opening, joining and closing tickets (community parity batch C, feature "community-tickets"). A ticket is a private
 * channel in its panel's category (a "Tickets" category when it names none) that only its opener and the staff see:
 * @everyone may not see it, the opener and every role with a moderation power may (channel overwrites), and owners and
 * admins always do. The staff of the moment are its members; staff added later join from the list. The community's
 * Tickets account posts the opener's text first and logs opening and closing in the panel's log channel.
 */
export class TicketDesk {
  constructor(private readonly t: Tickets) {}

  private get ctx() {
    return this.t.ctx;
  }

  /** Posts as the Tickets account, never failing what already happened (the ticket exists either way). */
  private async say(orgId: string, channelId: string | null, payload: Record<string, unknown> & { type: string }, log: FastifyBaseLogger): Promise<void> {
    if (!channelId) return;
    try {
      await postAs(this.ctx, await this.t.poster(orgId), channelId, payload, log);
    } catch (err) {
      log.warn({ err, orgId, channelId }, "tickets: message not posted");
    }
  }

  private panelFor(orgId: string, panelId: string | undefined): PanelRow | null {
    const panels = this.t.usablePanels(orgId);
    if (!panelId) return panels[0] ?? null;
    const p = panels.find((x) => x.id === panelId);
    if (!p) throw notFound("No such panel");
    return p;
  }

  /** The members (not bots) of [roleId]: a panel's support role (Bots+) joins its tickets. */
  private roleMembers(orgId: string, roleId: string | null): string[] {
    if (!roleId) return [];
    const ids = this.ctx.ws.all<{ user_id: string }>("org_role_members", { where: { role_id: roleId, org_id: orgId } }).map((r) => r.user_id);
    const bots = new Set(botsAmong(this.ctx, ids));
    return ids.filter((id) => !bots.has(id));
  }

  async open(orgId: string, userId: string, body: z.infer<typeof TicketOpenBody>, log: FastifyBaseLogger) {
    this.t.requireEnabled();
    this.ctx.authz.requireOrgMember(orgId, userId);
    if (!body.notABugReport) throw new ApiError(400, "ticket_confirm_required", "Tick that this isn't a bug report, feedback or a suggestion to open a ticket");
    if (!this.t.takesTickets(orgId)) throw new ApiError(409, "tickets_off", "This community doesn't take tickets");
    const panel = this.panelFor(orgId, body.panelId);
    const me = namesOf(this.ctx.identity, [userId])[0];
    // Community parity batch D part 2: with Bots+, the panel's support role sees its tickets and is pinged.
    const extras = this.ctx.officialBots?.tickets.extras(orgId, panel?.id ?? null) ?? null;
    const supportRole = extras?.supportRoleId ?? null;
    const staff = [...new Set([...this.t.staffIds(orgId), ...this.roleMembers(orgId, supportRole)])].filter((id) => id !== userId);
    const staffRoles = [...new Set([...this.t.staffRoleIds(orgId), ...(supportRole ? [supportRole] : [])])];
    const maxOpen = this.t.maxOpen(orgId);
    const channelId = newId("c");
    const at = now();
    const ticket = await this.ctx.ws.write((w) => {
      const s = w.get<SettingsRow>("community_tickets", { org_id: orgId })!;
      const open = w.count("tickets", { org_id: orgId, opener_id: userId, closed_at: null });
      if (open >= maxOpen) throw new ApiError(409, "ticket_limit", `You can have ${maxOpen} open tickets here. Close one to open another.`, { max: maxOpen });
      const categoryId = panel?.category_id ?? this.t.ticketsCategory(w, orgId, userId);
      if (panel && !panel.category_id) w.update("ticket_panels", { id: panel.id }, { category_id: categoryId });
      if (channelsInCategory(w, categoryId) >= CHANNEL_LIMITS.perCategory) throw conflict(`The tickets category holds ${CHANNEL_LIMITS.perCategory} channels already. Close some tickets or pick another category.`);
      if (channelsInCommunity(w, orgId) >= CHANNEL_LIMITS.perCommunity) throw conflict(`A community has at most ${CHANNEL_LIMITS.perCommunity} channels`);
      w.update("community_tickets", { org_id: orgId }, { next_number: s.next_number + 1 });
      const name = ticketChannelName(s.next_number, me?.username ?? "member");
      insertChannel(w, { id: channelId, orgId, name, topic: body.about.slice(0, 200), kind: "PRIVATE", categoryId, createdBy: userId, at }, [userId, ...staff]);
      overwrite(w, orgId, channelId, EVERYONE, [], ["channels.view"], userId, at);
      overwrite(w, orgId, channelId, `${USER_PREFIX}${userId}`, TICKET_CAPABILITIES, [], userId, at);
      for (const roleId of staffRoles) overwrite(w, orgId, channelId, roleId, TICKET_CAPABILITIES, [], userId, at);
      const row: TicketRow = { channel_id: channelId, org_id: orgId, panel_id: panel?.id ?? null, number: s.next_number, opener_id: userId, about: body.about, opened_at: at, closed_at: null, closed_by: null, claimed_by: null, revision: 0 };
      w.insert("tickets", { ...row });
      return row;
    });
    this.ctx.audit({ actorId: userId, orgId, action: "ticket.open", target: channelId, detail: `#${ticket.number}${panel ? ` ${panel.name}` : ""}` });
    const who = me?.displayName ?? "Someone";
    const heading = `Ticket #${ticket.number}${panel ? ` · ${panel.name}` : ""}`;
    const roleName = supportRole ? this.ctx.ws.get<{ name: string }>("org_roles", { id: supportRole })?.name : undefined;
    await this.say(orgId, channelId, {
      type: "text",
      text: `${roleName ? `@${roleName} ` : ""}${heading}\n${body.about}`,
      textFromEmbeds: true,
      embeds: [{ title: heading, description: body.about, author: { name: who } }],
      buttons: [{ kind: "action", action: "close_ticket", label: "Close ticket", emoji: "🔒" }],
      ...(roleName ? { roleMentions: [supportRole] } : {}),
    }, log);
    if (extras?.welcomeMessage && me) {
      const text = extras.welcomeMessage.replaceAll("{user}", `@${me.username}`).replaceAll("{panel}", panel?.name ?? "Tickets");
      await this.say(orgId, channelId, { type: "text", text, mentions: [userId] }, log);
    }
    await this.say(orgId, panel?.log_channel_id ?? null, { type: "text", text: `🎫 ${heading} opened by ${who} (#${ticketChannelName(ticket.number, me?.username ?? "member")})` }, log);
    notifyConversation(this.ctx, channelId);
    notifyOrg(this.ctx, orgId);
    return { ticket: this.t.views([ticket], userId)[0]! };
  }

  /** A staff member who isn't in an open ticket's channel yet joins it. */
  async join(orgId: string, channelId: string, userId: string) {
    this.t.requireEnabled();
    this.ctx.authz.requireOrgMember(orgId, userId);
    const ticket = this.t.ticket(orgId, channelId);
    if (!this.t.isStaff(orgId, userId)) throw forbidden("Only moderators can join other people's tickets");
    if (ticket.closed_at) throw new ApiError(409, "ticket_closed", "This ticket is closed already");
    // Their own overwrite keeps them in when their power comes from a role made after the ticket opened.
    const added = await this.ctx.ws.write((w) => {
      if (!this.t.isStaff(orgId, userId)) throw forbidden("Only moderators can join other people's tickets");
      if (w.get<TicketRow>("tickets", { org_id: orgId, channel_id: channelId, closed_at: null }) == null) throw new ApiError(409, "ticket_closed", "This ticket is closed already");
      overwrite(w, orgId, channelId, `${USER_PREFIX}${userId}`, TICKET_CAPABILITIES, [], userId, now());
      return addChannelMember(w, channelId, userId, now());
    });
    if (added) {
      this.ctx.audit({ actorId: userId, orgId, action: "ticket.join", target: channelId });
      notifyConversation(this.ctx, channelId);
    }
    return { ticket: this.t.views([ticket], userId)[0]! };
  }

  private requireModerator(orgId: string, userId: string): void {
    this.ctx.authz.requireOrgMember(orgId, userId);
    if (!this.t.canAssign(orgId, userId)) throw forbidden("Only a moderator can manage ticket assignments or reopen a ticket");
  }

  async assign(orgId: string, channelId: string, userId: string, releaseRevision?: number) {
    this.t.requireEnabled();
    this.requireModerator(orgId, userId);
    const claim = releaseRevision === undefined;
    const changed = await this.ctx.ws.write((w) => {
      this.requireModerator(orgId, userId);
      const row = w.get<TicketRow>("tickets", { channel_id: channelId, org_id: orgId });
      if (!row) throw notFound("No such ticket");
      if (row.closed_at !== null) throw new ApiError(409, "ticket_closed", "This ticket is closed already");
      const current = row.claimed_by ?? null;
      if (!claim && (row.revision ?? 0) !== releaseRevision) throw conflict("This assignment changed. Refresh and review it again.");
      if (claim ? current === userId : current === null) return false;
      if (claim && current && this.t.canAssign(orgId, current)) throw conflict("Another moderator has already claimed this ticket");
      if (!claim && current !== userId && !this.ctx.authz.isOrgAdmin(orgId, userId)) throw forbidden("Only the assignee or a community administrator can release this ticket");
      if (!w.update("tickets", { channel_id: channelId, org_id: orgId, closed_at: null, revision: row.revision ?? null }, { claimed_by: claim ? userId : null, revision: (row.revision ?? 0) + 1 })) throw conflict("This ticket changed. Refresh and try again.");
      return true;
    });
    if (changed) {
      this.ctx.audit({ actorId: userId, orgId, action: claim ? "ticket.claim" : "ticket.release", target: channelId });
      notifyConversation(this.ctx, channelId);
      notifyOrg(this.ctx, orgId);
    }
    return { ticket: this.t.views([this.t.ticket(orgId, channelId)], userId)[0]! };
  }

  /** Restore the same history, with the original requester and today's eligible staff. */
  async reopen(orgId: string, channelId: string, userId: string, expectedRevision: number) {
    this.t.requireEnabled();
    this.requireModerator(orgId, userId);
    await this.ctx.ws.write((w) => {
      this.requireModerator(orgId, userId);
      const row = w.get<TicketRow>("tickets", { channel_id: channelId, org_id: orgId });
      if (!row) throw notFound("No such ticket");
      if (row.closed_at === null || (row.revision ?? 0) !== expectedRevision) throw conflict("This ticket changed. Review the closed ticket again.");
      if (!this.t.takesTickets(orgId)) throw new ApiError(409, "tickets_off", "This community doesn't take tickets");
      if (!this.ctx.authz.orgRole(orgId, row.opener_id)) throw conflict("The person who opened this ticket is no longer in the community");
      const max = this.t.maxOpen(orgId);
      if (w.count("tickets", { org_id: orgId, opener_id: row.opener_id, closed_at: null }) >= max) throw new ApiError(409, "ticket_limit", `The requester already has ${max} open tickets here.`, { max });
      const panel = row.panel_id ? w.get<PanelRow>("ticket_panels", { id: row.panel_id, org_id: orgId }) : undefined;
      const categoryId = panel?.category_id ?? this.t.ticketsCategory(w, orgId, userId);
      if (!w.get("channel_categories", { id: categoryId, org_id: orgId })) throw conflict("The ticket's category is no longer available");
      if (channelsInCategory(w, categoryId) >= CHANNEL_LIMITS.perCategory) throw conflict(`The tickets category holds ${CHANNEL_LIMITS.perCategory} channels already`);
      const at = now();
      if (!restorePrivateChannel(w, orgId, channelId, row.closed_at, categoryId, at)) throw conflict("The original private ticket channel changed");

      const supportRole = this.ctx.officialBots.tickets.extras(orgId, row.panel_id)?.supportRoleId ?? null;
      const staffRoles = new Set([...this.t.staffRoleIds(orgId), ...(supportRole ? [supportRole] : [])]);
      const permitted = new Set([row.opener_id, ...this.t.staffIds(orgId), ...this.roleMembers(orgId, supportRole)]);
      retainPrivateChannelMembers(w, channelId, permitted);
      for (const { subject } of w.all<{ subject: string }>("channel_overwrites", { where: { target_type: "channel", target_id: channelId } })) {
        if (subject === EVERYONE || staffRoles.has(subject) || (subject.startsWith(USER_PREFIX) && permitted.has(subject.slice(USER_PREFIX.length)))) continue;
        w.update("channel_overwrites", { target_type: "channel", target_id: channelId, subject }, { allow: "[]" });
      }
      // Preserve any existing restrictions for allowed people; restore only the requester's private membership.
      addChannelMember(w, channelId, row.opener_id, at);
      if (!w.update("tickets", { channel_id: channelId, org_id: orgId, revision: row.revision ?? null, closed_at: row.closed_at }, { closed_at: null, closed_by: null, claimed_by: null, revision: expectedRevision + 1 })) throw conflict("This ticket changed. Review the closed ticket again.");
    });
    this.ctx.audit({ actorId: userId, orgId, action: "ticket.reopen", target: channelId });
    notifyConversation(this.ctx, channelId);
    notifyOrg(this.ctx, orgId);
    return { ticket: this.t.views([this.t.ticket(orgId, channelId)], userId)[0]! };
  }

  /** Closed by its opener or staff: said in the ticket, archived (out of its category), logged. */
  async close(orgId: string, channelId: string, userId: string, log: FastifyBaseLogger) {
    this.t.requireEnabled();
    this.ctx.authz.requireOrgMember(orgId, userId);
    const ticket = this.t.ticket(orgId, channelId);
    this.t.requireCloser(ticket, userId);
    if (ticket.closed_at) throw new ApiError(409, "ticket_closed", "This ticket is closed already");
    const who = namesOf(this.ctx.identity, [userId])[0]?.displayName ?? "Someone";
    await this.say(orgId, channelId, { type: "text", text: `🔒 Ticket closed by ${who}` }, log);
    const at = now();
    const closed = await this.ctx.ws.write((w) => {
      const row = w.get<TicketRow>("tickets", { channel_id: channelId, org_id: orgId, closed_at: null });
      if (!row) return false;
      this.t.requireCloser(row, userId);
      if (w.update("tickets", { channel_id: channelId, closed_at: null }, { closed_at: at, closed_by: userId, claimed_by: null, revision: (row.revision ?? 0) + 1 }) === 0) return false;
      archiveChannel(w, channelId, at, true);
      return true;
    });
    if (!closed) throw new ApiError(409, "ticket_closed", "This ticket is closed already");
    this.ctx.audit({ actorId: userId, orgId, action: "ticket.close", target: channelId, detail: `#${ticket.number}` });
    this.ctx.audit({ actorId: userId, orgId, action: "channel.archive", target: channelId });
    const panel = ticket.panel_id ? this.t.panels(orgId).find((p) => p.id === ticket.panel_id) : undefined;
    const heading = `Ticket #${ticket.number}${panel ? ` · ${panel.name}` : ""}`;
    await this.say(orgId, panel?.log_channel_id ?? null, { type: "text", text: `🔒 ${heading} closed by ${who}` }, log);
    // Community parity batch D part 2: with Bots+ and transcripts on, the ticket's messages go to the log too.
    const tickets = this.ctx.officialBots?.tickets;
    if (panel?.log_channel_id && tickets?.extras(orgId, panel.id)?.transcripts) {
      const posts = await tickets.transcript(channelId).catch((err: unknown) => {
        log.warn({ err, orgId, channelId }, "tickets: transcript not made");
        return [] as string[];
      });
      for (const [i, text] of posts.entries()) await this.say(orgId, panel.log_channel_id, { type: "text", text: i === 0 ? `📄 Transcript of ${heading}\n${text}` : text }, log);
    }
    notifyConversation(this.ctx, channelId);
    notifyOrg(this.ctx, orgId);
    return { ticket: this.t.views([this.t.ticket(orgId, channelId)], userId)[0]! };
  }
}

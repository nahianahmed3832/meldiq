import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod/v4";
import type { TicketOpenBody } from "../../../shared/contracts/http/tickets.js";
import { ApiError, conflict, forbidden, notFound } from "../../../shared/errors.js";
import { newId, now } from "../../../shared/utilities/util.js";
import type { RowWriter } from "../../../infrastructure/database/rows/index.js";
import { namesOf } from "../../accounts/index.js";
import { addChannelMember, archiveChannel, channelsInCategory, channelsInCommunity, insertChannel } from "../../messaging/index.js";
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
    const panels = this.t.panels(orgId);
    if (!panelId) return panels[0] ?? null;
    const p = panels.find((x) => x.id === panelId);
    if (!p) throw notFound("No such panel");
    return p;
  }

  async open(orgId: string, userId: string, body: z.infer<typeof TicketOpenBody>, log: FastifyBaseLogger) {
    this.t.requireEnabled();
    this.ctx.authz.requireOrgMember(orgId, userId);
    if (!body.notABugReport) throw new ApiError(400, "ticket_confirm_required", "Tick that this isn't a bug report, feedback or a suggestion to open a ticket");
    if (!this.t.takesTickets(orgId)) throw new ApiError(409, "tickets_off", "This community doesn't take tickets");
    const panel = this.panelFor(orgId, body.panelId);
    const me = namesOf(this.ctx.identity, [userId])[0];
    const staff = this.t.staffIds(orgId).filter((id) => id !== userId);
    const staffRoles = this.t.staffRoleIds(orgId);
    const channelId = newId("c");
    const at = now();
    const ticket = await this.ctx.ws.write((w) => {
      const s = w.get<SettingsRow>("community_tickets", { org_id: orgId })!;
      const open = w.count("tickets", { org_id: orgId, opener_id: userId, closed_at: null });
      if (open >= s.max_open) throw new ApiError(409, "ticket_limit", `You can have ${s.max_open} open tickets here. Close one to open another.`, { max: s.max_open });
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
      const row: TicketRow = { channel_id: channelId, org_id: orgId, panel_id: panel?.id ?? null, number: s.next_number, opener_id: userId, about: body.about, opened_at: at, closed_at: null, closed_by: null };
      w.insert("tickets", { ...row });
      return row;
    });
    this.ctx.audit({ actorId: userId, orgId, action: "ticket.open", target: channelId, detail: `#${ticket.number}${panel ? ` ${panel.name}` : ""}` });
    const who = me?.displayName ?? "Someone";
    const heading = `Ticket #${ticket.number}${panel ? ` · ${panel.name}` : ""}`;
    await this.say(orgId, channelId, {
      type: "text",
      text: `${heading}\n${body.about}`,
      textFromEmbeds: true,
      embeds: [{ title: heading, description: body.about, author: { name: who } }],
      buttons: [{ kind: "action", action: "close_ticket", label: "Close ticket", emoji: "🔒" }],
    }, log);
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
      overwrite(w, orgId, channelId, `${USER_PREFIX}${userId}`, TICKET_CAPABILITIES, [], userId, now());
      return addChannelMember(w, channelId, userId, now());
    });
    if (added) {
      this.ctx.audit({ actorId: userId, orgId, action: "ticket.join", target: channelId });
      notifyConversation(this.ctx, channelId);
    }
    return { ticket: this.t.views([ticket], userId)[0]! };
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
      if (w.update("tickets", { channel_id: channelId, closed_at: null }, { closed_at: at, closed_by: userId }) === 0) return false;
      archiveChannel(w, channelId, at, true);
      return true;
    });
    if (!closed) throw new ApiError(409, "ticket_closed", "This ticket is closed already");
    this.ctx.audit({ actorId: userId, orgId, action: "ticket.close", target: channelId, detail: `#${ticket.number}` });
    this.ctx.audit({ actorId: userId, orgId, action: "channel.archive", target: channelId });
    const panel = ticket.panel_id ? this.t.panels(orgId).find((p) => p.id === ticket.panel_id) : undefined;
    await this.say(orgId, panel?.log_channel_id ?? null, { type: "text", text: `🔒 Ticket #${ticket.number}${panel ? ` · ${panel.name}` : ""} closed by ${who}` }, log);
    notifyConversation(this.ctx, channelId);
    notifyOrg(this.ctx, orgId);
    return { ticket: this.t.views([this.t.ticket(orgId, channelId)], userId)[0]! };
  }
}

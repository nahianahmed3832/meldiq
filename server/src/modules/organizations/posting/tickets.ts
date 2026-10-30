import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { CATEGORY_LIMIT } from "../../../shared/contracts/http/community.js";
import { TICKET_LIMITS, type Ticket, type TicketsConfig, type TicketsConfigBody, type TicketsSummary } from "../../../shared/contracts/http/tickets.js";
import { ApiError, conflict, forbidden, notFound } from "../../../shared/errors.js";
import { newId, now } from "../../../shared/utilities/util.js";
import type { RowWriter } from "../../../infrastructure/database/rows/index.js";
import { botsAmong, namesOf } from "../../accounts/index.js";
import type { ConversationRow } from "../authz.js";
import { notifyOrg } from "../orgsRoutes.js";
import type { Permission } from "../permissions/catalog.js";
import { createSenderAccount, postAs } from "./senders.js";

/** Holding any of these makes someone ticket staff (besides owners and admins): they see every ticket and close them. */
export const TICKET_STAFF_POWERS: readonly Permission[] = ["members.timeout", "members.ban", "members.remove", "reports.view"];
/** The category tickets open in when a panel names none. */
export const TICKETS_CATEGORY = "Tickets";
const POSTER_NAME = "Tickets";

export interface SettingsRow {
  org_id: string;
  enabled: number;
  max_open: number;
  next_number: number;
  poster_id: string | null;
}
export interface PanelRow {
  id: string;
  org_id: string;
  name: string;
  position: number;
  post_channel_id: string | null;
  category_id: string | null;
  log_channel_id: string | null;
  posted_message_id: string | null;
}
export interface TicketRow {
  channel_id: string;
  org_id: string;
  panel_id: string | null;
  number: number;
  opener_id: string;
  about: string;
  opened_at: number;
  closed_at: number | null;
  closed_by: string | null;
}

/** A channel a panel may post in: a live public or announcement text channel of [orgId]. */
const postable = (c: ConversationRow | undefined, orgId: string): c is ConversationRow =>
  !!c && c.type === "CHANNEL" && c.org_id === orgId && !c.archived_at && c.voice !== 1 && (c.format ?? "text") === "text" && (c.kind === "PUBLIC" || c.kind === "ANNOUNCEMENT");
/** A channel tickets may be logged in: any live text channel of [orgId] (a private one is best). */
const loggable = (c: ConversationRow | undefined, orgId: string): c is ConversationRow => !!c && c.type === "CHANNEL" && c.org_id === orgId && !c.archived_at && c.voice !== 1 && (c.format ?? "text") === "text";

const invalid = (message: string, details: Record<string, unknown>) => new ApiError(400, "ticket_channel_invalid", message, details);

/**
 * Tickets (community parity batch C, feature "community-tickets", docs/COMMUNITY_PARITY_API.md): the community's
 * settings and panels, who counts as staff, and the views. Opening, joining and closing tickets are ticketDesk.ts.
 */
export class Tickets {
  constructor(
    readonly ctx: AppContext,
    readonly enabled: boolean,
  ) {}

  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Tickets are switched off for now. Try again later.");
  }

  settings(orgId: string): SettingsRow | undefined {
    return this.ctx.ws.get<SettingsRow>("community_tickets", { org_id: orgId });
  }

  panels(orgId: string): PanelRow[] {
    return this.ctx.ws.all<PanelRow>("ticket_panels", { where: { org_id: orgId }, orderBy: [["position", "asc"]] });
  }

  /** Whether [orgId] takes tickets now (the feature and the community's own switch). */
  takesTickets(orgId: string): boolean {
    return this.enabled && this.settings(orgId)?.enabled === 1;
  }

  /** Whether [orgId] has the Tickets bot's Bots+ limits and extras (community parity batch D part 2). */
  plus(orgId: string): boolean {
    return this.ctx.officialBots?.tickets.plus(orgId) ?? false;
  }

  /** Open tickets per person that apply now: as set, but at most 3 without Bots+. */
  maxOpen(orgId: string): number {
    const set = this.settings(orgId)?.max_open ?? TICKET_LIMITS.defaultMaxOpen;
    return this.plus(orgId) ? set : Math.min(set, TICKET_LIMITS.maxOpen);
  }

  /** The panels tickets open from now: all of them, or the first 2 without Bots+ (the others are kept). */
  usablePanels(orgId: string): PanelRow[] {
    const all = this.panels(orgId);
    return this.plus(orgId) ? all : all.slice(0, TICKET_LIMITS.panels);
  }

  /** Owners, admins and holders of a moderation power. */
  isStaff(orgId: string, userId: string): boolean {
    if (this.ctx.authz.isOrgAdmin(orgId, userId)) return true;
    const perms = this.ctx.authz.permissions(orgId, userId);
    return TICKET_STAFF_POWERS.some((p) => perms.has(p));
  }

  /** The people (not bots) who are staff now. */
  staffIds(orgId: string): string[] {
    const ids = this.ctx.ws.all<{ user_id: string }>("org_members", { where: { org_id: orgId } }).map((m) => m.user_id).filter((id) => this.isStaff(orgId, id));
    const bots = new Set(botsAmong(this.ctx, ids));
    return ids.filter((id) => !bots.has(id));
  }

  /** Active roles carrying a moderation power: ticket channels let them in by overwrite. */
  staffRoleIds(orgId: string): string[] {
    return this.ctx.authz.workspaceRoleIds(orgId).filter((id) => this.ctx.authz.roleGrant(id, orgId)?.permissions.some((p) => TICKET_STAFF_POWERS.includes(p)));
  }

  configView(orgId: string): z.infer<typeof TicketsConfig> {
    const s = this.settings(orgId);
    return {
      enabled: s?.enabled === 1,
      maxOpenPerPerson: s?.max_open ?? TICKET_LIMITS.defaultMaxOpen,
      panels: this.panels(orgId).map((p) => ({ id: p.id, name: p.name, postChannelId: p.post_channel_id, categoryId: p.category_id, logChannelId: p.log_channel_id, postedMessageId: p.posted_message_id })),
      panelLimit: this.plus(orgId) ? TICKET_LIMITS.plusPanels : TICKET_LIMITS.panels,
    };
  }

  config(orgId: string, userId: string) {
    this.requireEnabled();
    this.ctx.authz.requirePermission(orgId, userId, "workspace.edit", "Your role doesn't include changing tickets");
    return this.configView(orgId);
  }

  /** What community views carry while tickets are on (members only). */
  summary(orgId: string, userId: string): { tickets?: z.infer<typeof TicketsSummary> } {
    if (!this.takesTickets(orgId)) return {};
    return {
      tickets: {
        panels: this.usablePanels(orgId).map((p) => ({ id: p.id, name: p.name })),
        maxOpenPerPerson: this.maxOpen(orgId),
        openByMe: this.ctx.ws.count("tickets", { org_id: orgId, opener_id: userId, closed_at: null }),
      },
    };
  }

  /** The "Tickets" category of [orgId], made at the end when there isn't one. */
  ticketsCategory(w: RowWriter, orgId: string, actorId: string): string {
    const found = w.all<{ id: string; name: string }>("channel_categories", { where: { org_id: orgId } }).find((c) => c.name.trim().toLowerCase() === TICKETS_CATEGORY.toLowerCase());
    if (found) return found.id;
    if (w.count("channel_categories", { org_id: orgId }) >= CATEGORY_LIMIT) throw conflict(`A community has at most ${CATEGORY_LIMIT} categories: pick one for the tickets`);
    const last = w.get<{ position: number }>("channel_categories", { org_id: orgId }, [["position", "desc"]]);
    const id = newId("cat");
    const t = now();
    w.insert("channel_categories", { id, org_id: orgId, name: TICKETS_CATEGORY, position: (last?.position ?? -1) + 1, created_by: actorId, created_at: t, updated_at: t });
    return id;
  }

  private checkPanel(orgId: string, p: z.infer<typeof TicketsConfigBody>["panels"][number], i: number): void {
    const { authz, ws } = this.ctx;
    if (!postable(authz.conversation(p.postChannelId), orgId)) throw invalid("Post the panel in a public or announcement text channel of this community", { panel: i, field: "postChannelId" });
    if (p.categoryId && !ws.get("channel_categories", { id: p.categoryId, org_id: orgId })) throw invalid("Pick a category of this community", { panel: i, field: "categoryId" });
    if (p.logChannelId && !loggable(authz.conversation(p.logChannelId), orgId)) throw invalid("Log tickets in a text channel of this community", { panel: i, field: "logChannelId" });
  }

  async setConfig(orgId: string, userId: string, body: z.infer<typeof TicketsConfigBody>) {
    this.config(orgId, userId);
    // Community parity batch D part 2: beyond 2 panels or 3 open per person is the Tickets bot's Bots+. What's already
    // stored stays allowed while Bots+ is gone (it's paused, not lost); only going higher needs Bots+.
    const storedMax = this.settings(orgId)?.max_open ?? TICKET_LIMITS.maxOpen;
    const storedPanels = this.panels(orgId).length;
    const moreOpen = body.maxOpenPerPerson > TICKET_LIMITS.maxOpen && body.maxOpenPerPerson > storedMax;
    const morePanels = body.panels.length > TICKET_LIMITS.panels && body.panels.length > storedPanels;
    const plusOnly = [...(moreOpen ? ["maxOpenPerPerson"] : []), ...(morePanels ? ["panels"] : [])];
    if (plusOnly.length && !this.plus(orgId)) throw new ApiError(403, "bots_plus_required", "More panels and open tickets per person come with Bots+.", { bot: "tickets", settings: plusOnly });
    body.panels.forEach((p, i) => this.checkPanel(orgId, p, i));
    const wasOn = this.settings(orgId)?.enabled === 1;
    const known = new Set(this.panels(orgId).map((p) => p.id));
    const t = now();
    await this.ctx.ws.write((w) => {
      const before = w.get<SettingsRow>("community_tickets", { org_id: orgId });
      w.upsert(
        "community_tickets",
        { org_id: orgId, enabled: body.enabled ? 1 : 0, max_open: body.maxOpenPerPerson, next_number: before?.next_number ?? 1, poster_id: before?.poster_id ?? null, updated_by: userId, updated_at: t },
        "replace",
      );
      const ids = body.panels.map((p) => (p.id && known.has(p.id) ? p.id : newId("tp")));
      w.delete("ticket_panels", { org_id: orgId, id: { notIn: ids } });
      body.panels.forEach((p, i) => {
        const row = { name: p.name, position: i, post_channel_id: p.postChannelId, category_id: p.categoryId ?? this.ticketsCategory(w, orgId, userId), log_channel_id: p.logChannelId, updated_at: t };
        if (known.has(ids[i]!)) w.update("ticket_panels", { id: ids[i]! }, row);
        else w.insert("ticket_panels", { id: ids[i]!, org_id: orgId, posted_message_id: null, created_by: userId, created_at: t, ...row });
      });
    });
    this.ctx.audit({ actorId: userId, orgId, action: "tickets.config", target: orgId, detail: `${body.enabled ? "on" : "off"}, ${body.panels.length} panels, ${body.maxOpenPerPerson} per person` });
    // The Tickets bot is the same switch: it joins or leaves with it.
    if (body.enabled !== wasOn) await this.ctx.officialBots?.tickets.switched(orgId, body.enabled, userId);
    notifyOrg(this.ctx, orgId);
    return this.configView(orgId);
  }

  /** The switch alone (the Tickets bot turned on or off): settings made with defaults when there are none. */
  async setSwitch(orgId: string, on: boolean, userId: string): Promise<void> {
    this.requireEnabled();
    const t = now();
    await this.ctx.ws.write((w) => {
      if (w.get("community_tickets", { org_id: orgId })) w.update("community_tickets", { org_id: orgId }, { enabled: on ? 1 : 0, updated_by: userId, updated_at: t });
      else w.insert("community_tickets", { org_id: orgId, enabled: on ? 1 : 0, max_open: TICKET_LIMITS.defaultMaxOpen, next_number: 1, poster_id: null, updated_by: userId, updated_at: t });
    });
    this.ctx.audit({ actorId: userId, orgId, action: "tickets.config", target: orgId, detail: `${on ? "on" : "off"} (Tickets bot)` });
    notifyOrg(this.ctx, orgId);
  }

  /** Open tickets per person alone (the Tickets bot's settings; Bots+ was checked there). */
  async setMaxOpen(orgId: string, userId: string, max: number): Promise<void> {
    this.config(orgId, userId);
    const t = now();
    await this.ctx.ws.write((w) => {
      if (w.get("community_tickets", { org_id: orgId })) w.update("community_tickets", { org_id: orgId }, { max_open: max, updated_by: userId, updated_at: t });
      else w.insert("community_tickets", { org_id: orgId, enabled: 0, max_open: max, next_number: 1, poster_id: null, updated_by: userId, updated_at: t });
    });
    this.ctx.audit({ actorId: userId, orgId, action: "tickets.config", target: orgId, detail: `${max} per person` });
    notifyOrg(this.ctx, orgId);
  }

  /**
   * Who posts for tickets: the Tickets bot's account once it has one (community parity batch D part 2), else the
   * community's "Tickets" sender account (senders.ts), made the first time it posts.
   */
  async poster(orgId: string): Promise<string> {
    const bot = this.ctx.officialBots?.tickets.poster(orgId);
    if (bot) return bot;
    const known = this.settings(orgId)?.poster_id;
    if (known) return known;
    const made = await createSenderAccount(this.ctx, POSTER_NAME);
    // Two first posts at once: the one stored first is kept.
    await this.ctx.ws.write((w) => w.update("community_tickets", { org_id: orgId, poster_id: null }, { poster_id: made }));
    return this.settings(orgId)?.poster_id ?? made;
  }

  /** Posts the panel's "Open a ticket" message in its channel, as the community's Tickets account. */
  async postPanel(orgId: string, panelId: string, userId: string, log: FastifyBaseLogger) {
    this.config(orgId, userId);
    if (!this.takesTickets(orgId)) throw new ApiError(409, "tickets_off", "Turn tickets on before posting a panel");
    const panel = this.usablePanels(orgId).find((p) => p.id === panelId);
    if (!panel) throw notFound("No such panel");
    if (!panel.post_channel_id || !postable(this.ctx.authz.conversation(panel.post_channel_id), orgId)) throw invalid("Pick a public or announcement text channel for this panel first", { panelId, field: "postChannelId" });
    const description = "Need the moderators' help in private? Open a ticket and only they will see it.\nNot for bug reports, feedback or suggestions.";
    const sent = await postAs(this.ctx, await this.poster(orgId), panel.post_channel_id, {
      type: "text",
      text: `${panel.name}\n${description}`,
      textFromEmbeds: true,
      embeds: [{ title: panel.name, description }],
      buttons: [{ kind: "action", action: "open_ticket", panelId: panel.id, label: "Open a ticket", emoji: "🎫" }],
    }, log);
    await this.ctx.ws.write((w) => w.update("ticket_panels", { id: panel.id }, { posted_message_id: sent.messageId, updated_at: now() }));
    this.ctx.audit({ actorId: userId, orgId, action: "tickets.panel_post", target: panel.id, detail: panel.post_channel_id });
    return { messageId: sent.messageId, channelId: panel.post_channel_id };
  }

  /** Tickets as apps show them, to [viewerId]. */
  views(rows: readonly TicketRow[], viewerId: string): z.infer<typeof Ticket>[] {
    const people = new Map(namesOf(this.ctx.identity, [...new Set(rows.flatMap((r) => [r.opener_id, ...(r.closed_by ? [r.closed_by] : [])]))]).map((n) => [n.id, n]));
    const panels = new Map(rows.length ? this.panels(rows[0]!.org_id).map((p) => [p.id, p.name]) : []);
    return rows.map((r) => ({
      channelId: r.channel_id,
      number: r.number,
      name: this.ctx.authz.conversation(r.channel_id)?.name ?? `ticket-${r.number}`,
      panelId: r.panel_id,
      panelName: (r.panel_id && panels.get(r.panel_id)) || null,
      opener: people.get(r.opener_id) ?? null,
      about: r.about,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      closedBy: (r.closed_by && people.get(r.closed_by)) || null,
      joined: this.ctx.authz.isMember(r.channel_id, viewerId),
    }));
  }

  ticket(orgId: string, channelId: string): TicketRow {
    const t = this.ctx.ws.get<TicketRow>("tickets", { channel_id: channelId, org_id: orgId });
    if (!t) throw notFound("No such ticket");
    return t;
  }

  /** Open tickets: every one for staff, the viewer's own otherwise. */
  list(orgId: string, userId: string) {
    this.requireEnabled();
    this.ctx.authz.requireOrgMember(orgId, userId);
    const where = this.isStaff(orgId, userId) ? { org_id: orgId, closed_at: null } : { org_id: orgId, opener_id: userId, closed_at: null };
    return { tickets: this.views(this.ctx.ws.all<TicketRow>("tickets", { where, orderBy: [["opened_at", "asc"]] }), userId) };
  }

  /** Throws unless [userId] may close [t]: its opener, or staff. */
  requireCloser(t: TicketRow, userId: string): void {
    if (t.opener_id !== userId && !this.isStaff(t.org_id, userId)) throw forbidden("Only the person who opened a ticket or a moderator can close it");
  }
}

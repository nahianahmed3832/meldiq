import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Tickets (community parity batch C, feature "community-tickets", docs/COMMUNITY_PARITY_API.md › Posting tools): a
 * member opens a private channel with the community's moderators about something that isn't a bug report; the opener or
 * a moderator closes it (archived). Panels say where the "Open a ticket" message is posted, which category tickets
 * open in and where they're logged.
 */

/** Free limits, and with Bots+ (community parity batch D part 2, the Tickets bot): 10 panels and 10 open per person. */
export const TICKET_LIMITS = { panels: 2, plusPanels: 10, panelName: 40, about: 300, defaultMaxOpen: 2, maxOpen: 3, plusMaxOpen: 10 } as const;

export const TicketPanelInput = z.strictObject({
  /** Kept when it's one of this community's panels; a new id otherwise. */
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(TICKET_LIMITS.panelName),
  postChannelId: z.string().min(1).max(64),
  /** null: a "Tickets" category (made when there's none). */
  categoryId: z.string().min(1).max(64).nullable(),
  logChannelId: z.string().min(1).max(64).nullable(),
});

export const TicketsConfigBody = z.strictObject({
  enabled: z.boolean(),
  /** 1–3; up to 10 with Bots+. */
  maxOpenPerPerson: z.number().int().min(1).max(TICKET_LIMITS.plusMaxOpen),
  /** Up to 2; up to 10 with Bots+. */
  panels: z.array(TicketPanelInput).max(TICKET_LIMITS.plusPanels),
});

export const TicketPanel = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** null once that channel was deleted. */
  postChannelId: z.string().nullable(),
  categoryId: z.string().nullable(),
  logChannelId: z.string().nullable(),
  /** The panel's last "Open a ticket" message, null before it was posted. */
  postedMessageId: z.string().nullable(),
});

export const TicketsConfig = z.strictObject({
  enabled: z.boolean(),
  maxOpenPerPerson: z.number().int(),
  panels: z.array(TicketPanel),
  /** Panels a community may have (2, or 10 with Bots+). */
  panelLimit: z.number().int(),
});

/** What every member's community view carries while tickets are on (CommunityView.tickets): the menu's "Open a Ticket". */
export const TicketsSummary = z.strictObject({
  panels: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  maxOpenPerPerson: z.number().int(),
  /** The viewer's open tickets. */
  openByMe: zCount,
});

export const TicketOpenBody = z.strictObject({
  /** Omitted: the first panel (or none). */
  panelId: z.string().min(1).max(64).optional(),
  about: z.string().trim().min(1).max(TICKET_LIMITS.about),
  /** The opener ticks "This isn't a bug report, feedback or a suggestion": must be true. */
  notABugReport: z.boolean(),
});

const person = z.strictObject({ id: z.string(), username: z.string(), displayName: z.string() });

export const Ticket = z.strictObject({
  channelId: z.string(),
  number: z.number().int(),
  name: z.string(),
  panelId: z.string().nullable(),
  panelName: z.string().nullable(),
  opener: person.nullable(),
  about: z.string(),
  openedAt: zTime,
  closedAt: zTime.nullable(),
  closedBy: person.nullable(),
  /** Absent in responses from servers without ticket-lifecycle. */
  claimedBy: person.nullable().optional(),
  revision: zCount.optional(),
  /** Whether the viewer is in the ticket's channel (a moderator who wasn't one yet when it opened can join). */
  joined: z.boolean(),
});

export const TicketParams = z.object({ orgId: z.string().min(1).max(64), channelId: z.string().min(1).max(64) });
export const TicketPanelParams = z.object({ orgId: z.string().min(1).max(64), panelId: z.string().min(1).max(64) });
const OrgOnly = z.object({ orgId: z.string().min(1).max(64) });
export const TicketListQuery = z.object({ state: z.enum(["open", "closed"]).default("open") });
export const TicketRevisionBody = z.strictObject({ expectedRevision: zCount });

const tag = "tickets";
const off = ["not_found", "feature_disabled"] as const;

export const ticketRoutes = [
  route({ method: "GET", url: "/v1/orgs/:orgId/tickets/config", tag, summary: "Tickets settings and panels (people who can edit the community).", auth: true, params: OrgOnly, response: TicketsConfig, errors: [...off, "forbidden"] }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/tickets/config",
    tag,
    summary: "Turn tickets on or off, set open tickets per person and the panels (people who can edit the community).",
    auth: true,
    params: OrgOnly,
    body: TicketsConfigBody,
    response: TicketsConfig,
    errors: [...off, "forbidden", "ticket_channel_invalid", "bots_plus_required", "conflict"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/tickets/panels/:panelId/post",
    tag,
    summary: 'Post the panel: a message with an "Open a ticket" button in the panel\'s channel.',
    auth: true,
    params: TicketPanelParams,
    response: z.strictObject({ messageId: z.string(), channelId: z.string() }),
    errors: [...off, "forbidden", "ticket_channel_invalid", "tickets_off"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/tickets",
    tag,
    summary: "Open a ticket: a private channel with the moderators, the text as its first message.",
    auth: true,
    params: OrgOnly,
    body: TicketOpenBody,
    response: z.strictObject({ ticket: Ticket }),
    status: 201,
    errors: [...off, "tickets_off", "ticket_confirm_required", "ticket_limit", "conflict"],
  }),
  route({ method: "GET", url: "/v1/orgs/:orgId/tickets", tag, summary: "Open or closed tickets: all for moderators, your own otherwise.", auth: true, params: OrgOnly, query: TicketListQuery, response: z.strictObject({ tickets: z.array(Ticket) }), errors: [...off] }),
  route({ method: "POST", url: "/v1/orgs/:orgId/tickets/:channelId/join", tag, summary: "A moderator joins an open ticket's channel.", auth: true, params: TicketParams, response: z.strictObject({ ticket: Ticket }), errors: [...off, "forbidden", "ticket_closed"] }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/tickets/:channelId/close",
    tag,
    summary: "Close a ticket (its opener or a moderator): the channel is archived and the close logged.",
    auth: true,
    params: TicketParams,
    response: z.strictObject({ ticket: Ticket }),
    errors: [...off, "forbidden", "ticket_closed"],
  }),
  route({ method: "POST", url: "/v1/orgs/:orgId/tickets/:channelId/claim", tag, summary: "Assign an open ticket to the acting moderator.", auth: true, params: TicketParams, response: z.strictObject({ ticket: Ticket }), errors: [...off, "forbidden", "ticket_closed", "conflict"] }),
  route({ method: "DELETE", url: "/v1/orgs/:orgId/tickets/:channelId/claim", tag, summary: "Release the reviewed ticket assignment as its assignee or a community administrator.", auth: true, params: TicketParams, body: TicketRevisionBody, response: z.strictObject({ ticket: Ticket }), errors: [...off, "forbidden", "ticket_closed", "conflict"] }),
  route({ method: "POST", url: "/v1/orgs/:orgId/tickets/:channelId/reopen", tag, summary: "Reopen a reviewed private ticket as a moderator, preserving its channel and history.", auth: true, params: TicketParams, body: TicketRevisionBody, response: z.strictObject({ ticket: Ticket }), errors: [...off, "forbidden", "tickets_off", "ticket_limit", "conflict"] }),
];

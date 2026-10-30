import { TICKET_LIMITS } from "../../shared/contracts/http/tickets.js";
import { BOT_LIMITS, type BotSettings, TicketsBotSettings } from "../../shared/contracts/http/officialBots.js";
import { ApiError, badRequest } from "../../shared/errors.js";
import { addBotMember, removeBotMember } from "../organizations/index.js";
import type { OfficialBots } from "./runtime.js";
import { plusFeatures, storedSettings } from "./settings.js";

/**
 * The Tickets bot (community parity batch D part 2): batch C's community tickets with a face and Bots+ extras. Its
 * switch is the tickets switch (`community_tickets.enabled`), its settings are the tickets config (ctx.tickets: panels,
 * open tickets per person), and its account posts the panels and everything said in tickets. It keeps only its Bots+
 * extras itself (official_bots.settings): per panel a support role that sees that panel's tickets and is pinged when
 * one opens, and a welcome line; and transcripts in the log channel when a ticket closes.
 */

type Stored = BotSettings<"tickets">;
type Panel = Stored["panels"][string];

/** What a ticket of one panel gets from Bots+ (null without it). */
export interface TicketExtras {
  supportRoleId: string | null;
  welcomeMessage: string | null;
  transcripts: boolean;
}

/** Messages a transcript reads at most, and how long each of its posts is. */
const TRANSCRIPT = { messages: 1000, page: 100, chunkChars: 3500, posts: 10 } as const;

const stored = (rt: OfficialBots, orgId: string): Stored => storedSettings("tickets", rt.rows.bot(orgId, "tickets")?.settings);

/** The seam batch C's tickets (organizations/posting) asks through ctx.officialBots.tickets. */
export class TicketsSeam {
  constructor(private readonly rt: OfficialBots) {}

  /** Whether [orgId]'s tickets get the Bots+ limits and extras now. */
  plus(orgId: string): boolean {
    return this.rt.enabled && this.rt.hasPlus(orgId);
  }

  /** The Tickets bot's account, which posts for tickets once it has one (else batch C's own "Tickets" sender). */
  poster(orgId: string): string | null {
    return this.rt.enabled ? (this.rt.rows.bot(orgId, "tickets")?.user_id ?? null) : null;
  }

  /** [panelId]'s Bots+ extras, or null without Bots+. */
  extras(orgId: string, panelId: string | null): TicketExtras | null {
    if (!this.plus(orgId)) return null;
    const s = stored(this.rt, orgId);
    const p: Panel | undefined = panelId ? s.panels[panelId] : undefined;
    const roleOk = !!p?.supportRoleId && !!this.rt.ctx.authz.roleGrant(p.supportRoleId, orgId);
    return { supportRoleId: roleOk ? p!.supportRoleId : null, welcomeMessage: p?.welcomeMessage ?? null, transcripts: s.transcripts };
  }

  /**
   * Tickets were turned on or off from Settings › Tickets: the bot follows (it joins the community with an account of
   * its own, or leaves). Never fails the switch: a ban or the member limit leaves the bot out and batch C's sender posts.
   */
  async switched(orgId: string, on: boolean, actorId: string): Promise<void> {
    if (!this.rt.enabled) return;
    const row = this.rt.rows.bot(orgId, "tickets");
    if (!on && row?.enabled !== 1) return;
    try {
      const userId = on ? await this.rt.ensureAccount(orgId, "tickets", actorId, row?.look_name ?? null) : row!.user_id!;
      if (on) await addBotMember(this.rt.ctx, orgId, userId, actorId);
      const current = this.rt.rows.bot(orgId, "tickets")!;
      await this.rt.rows.save({ ...current, enabled: on ? 1 : 0, updated_by: actorId, updated_at: this.rt.clock() });
      if (!on) await removeBotMember(this.rt.ctx, orgId, userId, actorId);
      this.rt.ctx.audit({ actorId, orgId, action: on ? "official_bot.on" : "official_bot.off", target: "tickets", detail: "tickets: switched in Settings › Tickets" });
    } catch (err) {
      this.rt.ctx.log.warn({ err, orgId }, "official bots: the Tickets bot didn't follow the tickets switch");
    }
  }

  /** A closing ticket's messages as text lines, oldest first (edits applied, deletions left out), in posts of ≤3,500. */
  async transcript(channelId: string): Promise<string[]> {
    const { messages } = this.rt.ctx;
    const events = [];
    const changes = [];
    let before: number | null = null;
    while (events.length < TRANSCRIPT.messages) {
      const page = await messages.page(channelId, "", before, TRANSCRIPT.page);
      events.push(...page.messages);
      changes.push(...page.changes);
      if (!page.more || page.messages.length === 0) break;
      before = page.messages.at(-1)!.server_ts;
    }
    const edits = new Map<string, string>();
    const deleted = new Set<string>();
    for (const c of changes.sort((a, b) => a.server_ts - b.server_ts)) {
      const p = JSON.parse(c.payload) as { text?: unknown };
      if (c.type === "edit" && c.target && typeof p.text === "string") edits.set(c.target, p.text);
      if (c.type === "delete" && c.target) deleted.add(c.target);
    }
    const kept = events.filter((m) => m.cls === "message" && !deleted.has(m.id)).sort((a, b) => a.server_ts - b.server_ts);
    const names = this.rt.people(kept.map((m) => m.sender_user_id));
    const lines = kept.map((m) => {
      const p = JSON.parse(m.payload) as { text?: unknown; attachments?: unknown };
      const text = edits.get(m.id) ?? (typeof p.text === "string" ? p.text : "");
      const files = Array.isArray(p.attachments) && p.attachments.length ? ` (${p.attachments.length} attachment${p.attachments.length === 1 ? "" : "s"})` : "";
      const when = new Date(m.server_ts).toISOString().slice(0, 16).replace("T", " ");
      return `[${when}] ${names.get(m.sender_user_id)?.displayName ?? "Someone"}: ${text}${files}`;
    });
    const posts: string[] = [];
    for (const line of lines) {
      const last = posts.at(-1);
      if (last !== undefined && last.length + line.length + 1 <= TRANSCRIPT.chunkChars) posts[posts.length - 1] = `${last}\n${line}`;
      else posts.push(line.slice(0, TRANSCRIPT.chunkChars));
    }
    return posts.length > TRANSCRIPT.posts ? [...posts.slice(0, TRANSCRIPT.posts - 1), "… (the rest was too long for the log)"] : posts;
  }
}

/** The Tickets bot's settings as editors see them: the tickets config with each panel's extras, and transcripts. */
export function ticketsSettingsView(rt: OfficialBots, orgId: string): Record<string, unknown> {
  const cfg = rt.ctx.tickets.configView(orgId);
  const s = stored(rt, orgId);
  return {
    maxOpenPerPerson: cfg.maxOpenPerPerson,
    panels: cfg.panels.map((p) => ({ ...p, supportRoleId: s.panels[p.id]?.supportRoleId ?? null, welcomeMessage: s.panels[p.id]?.welcomeMessage ?? null })),
    transcripts: s.transcripts,
  };
}

/** Plus settings stored (here or in the tickets config) that don't apply without Bots+. */
export function ticketsPlusPaused(rt: OfficialBots, orgId: string): string[] {
  const cfg = rt.ctx.tickets.configView(orgId);
  const beyond = [...(cfg.maxOpenPerPerson > TICKET_LIMITS.maxOpen ? ["maxOpenPerPerson"] : []), ...(cfg.panels.length > TICKET_LIMITS.panels ? ["panels"] : [])];
  return [...new Set([...beyond, ...plusFeatures("tickets", stored(rt, orgId))])];
}

/**
 * Saves the Tickets bot's settings an editor sent (some or all of them): the tickets config through ctx.tickets (its
 * checks and audit), the extras here. Bots+ is needed beyond 2 panels or 3 open per person and for any extra.
 * Returns the bot's own settings to store.
 */
export async function saveTicketsSettings(rt: OfficialBots, orgId: string, userId: string, sent: Record<string, unknown>): Promise<Stored> {
  const parsed = TicketsBotSettings.partial().safeParse(sent);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`Bot settings: ${issue?.path.join(".") || "settings"}: ${issue?.message ?? "not valid"}`, { field: issue?.path.join(".") ?? null });
  }
  const want = parsed.data;
  const plusOnly = [
    ...(want.maxOpenPerPerson !== undefined && want.maxOpenPerPerson > BOT_LIMITS.ticketsOpenPerPerson.free ? ["maxOpenPerPerson"] : []),
    ...(want.panels && (want.panels.length > BOT_LIMITS.ticketPanels.free || want.panels.some((p) => p.supportRoleId || p.welcomeMessage)) ? ["panels"] : []),
    ...(want.transcripts ? ["transcripts"] : []),
  ];
  if (plusOnly.length && !rt.hasPlus(orgId)) throw new ApiError(403, "bots_plus_required", "That's a Bots+ extra. This community needs Bots+ to use it.", { bot: "tickets", settings: plusOnly });
  want.panels?.forEach((p, i) => {
    if (p.supportRoleId && !rt.ctx.authz.roleGrant(p.supportRoleId, orgId)) throw badRequest("Pick a role of this community as the support role", { field: `panels.${i}.supportRoleId` });
  });
  const before = stored(rt, orgId);
  const cfg = rt.ctx.tickets.configView(orgId);
  let panels = before.panels;
  if (want.panels) {
    const saved = await rt.ctx.tickets.setConfig(orgId, userId, {
      enabled: cfg.enabled,
      maxOpenPerPerson: want.maxOpenPerPerson ?? cfg.maxOpenPerPerson,
      panels: want.panels.map((p) => ({ id: p.id, name: p.name, postChannelId: p.postChannelId, categoryId: p.categoryId, logChannelId: p.logChannelId })),
    });
    // An extra left out keeps what's stored (an app without Bots+ can't send it, and paused extras must survive a save
    // of the panels); null clears it.
    panels = Object.fromEntries(
      saved.panels.map((p, i) => {
        const sentPanel = want.panels![i]!;
        const kept = before.panels[p.id];
        const supportRoleId = sentPanel.supportRoleId !== undefined ? sentPanel.supportRoleId : (kept?.supportRoleId ?? null);
        const welcomeMessage = sentPanel.welcomeMessage !== undefined ? sentPanel.welcomeMessage : (kept?.welcomeMessage ?? null);
        return [p.id, { supportRoleId, welcomeMessage }];
      }),
    );
  } else if (want.maxOpenPerPerson !== undefined) {
    await rt.ctx.tickets.setMaxOpen(orgId, userId, want.maxOpenPerPerson);
  }
  return { panels, transcripts: want.transcripts ?? before.transcripts };
}

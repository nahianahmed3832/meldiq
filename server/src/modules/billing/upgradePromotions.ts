import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { Rows, RowWriter } from "../../infrastructure/database/rows/index.js";
import { conflict, notFound } from "../../shared/errors.js";
import { newId } from "../../shared/utilities/util.js";
import { PLUS_PRICE_MINOR } from "./pricing.js";

export const DAY = 86_400_000;
import { PromotionSettings, DEFAULT_SETTINGS, DEFAULT_CAMPAIGN, type Settings, type CampaignConfig, type ClaimBody, type EventBody, type Presentation } from "../../shared/contracts/http/promotions.js";
export * from "../../shared/contracts/http/promotions.js";
export interface Subject { accountId: string; userId: string; createdAt: number; registered: boolean; onboardingComplete: boolean; plan: string; excluded: boolean; checkout: boolean; region: string | null }
interface Activity { id: string; startedAt: number; lastAt: number; activeMs: number; completedAt: number | null; shownAt?: number }
interface Impression { id: string; campaignId: string; sessionId: string; type: z.infer<typeof Presentation>; at: number; variant: string }
export interface PromotionState { account_id: string; user_id: string; revision: number; opt_out: number; sessions: string; history: string; snoozed_until: number; dismissed_at: number | null; updated_at: number }
const parsed = <T>(s: string): T[] => JSON.parse(s) as T[];
const blank = (s: Subject, t: number): PromotionState => ({ account_id: s.accountId, user_id: s.userId, revision: 0, opt_out: 0, sessions: "[]", history: "[]", snoozed_until: 0, dismissed_at: null, updated_at: t });
export function decision(c: CampaignConfig, s: Subject, p: PromotionState, now: number, session: string): { eligible: boolean; score: number; reason: string } {
 const no = (reason: string) => ({ eligible: false, score: 0, reason });
 if (!s.registered || !s.onboardingComplete || s.excluded || s.plan !== "free" || s.checkout || p.opt_out) return no("ineligible_account");
 if (now - s.createdAt < c.minAccountDays * DAY) return no("account_age");
 const sessions = parsed<Activity>(p.sessions).filter(a => a.completedAt !== null && now - a.completedAt < 90 * DAY);
 const days = new Set(sessions.map(a => new Date(a.completedAt!).toISOString().slice(0, 10))).size;
 if (sessions.length < c.minSessions || days < c.minActiveDays) return no("usage");
 if (now < p.snoozed_until || p.dismissed_at !== null && now - p.dismissed_at < c.dismissalDays * DAY) return no("cooldown");
 if (parsed<Activity>(p.sessions).some(a => a.id === session && a.shownAt !== undefined)) return no("session_cap");
 const history = parsed<Impression>(p.history).filter(i => now - i.at < 30 * DAY);
 if (history.some(i => i.sessionId === session) || history.length >= c.maxImpressions || history.some(i => now - i.at < c.gapDays * DAY)) return no("frequency");
 if (c.presentation === "modal" && history.filter(i => i.type === "modal").length >= c.maxPopups) return no("popup_cap");
 if (!c.active || c.startsAt !== null && now < c.startsAt || c.endsAt !== null && now >= c.endsAt || c.regions.length && (!s.region || !c.regions.includes(s.region))) return no("campaign");
 return { eligible: true, score: Math.min(100, 30 + days * 5 + sessions.length * 3 + (c.trigger === "near_limit" || c.trigger === "exclusive_feature" ? 20 : 0)), reason: "eligible" };
}

/** Uses the existing billing Rows transaction and MongoDB authority. No content, device fingerprint or external tracker. */
export class Promotions {
 constructor(private readonly rows: Rows, private readonly clock: () => number = Date.now) {}
 settings() { const row = this.rows.get<{ settings: string; revision: number }>("billing_promotion_settings", { id: 1 }); return { settings: row ? PromotionSettings.parse(JSON.parse(row.settings)) : structuredClone(DEFAULT_SETTINGS), revision: row?.revision ?? 0 }; }
 async configure(settings: Settings, revision: number, actor: string) {
  const value = PromotionSettings.parse(settings);
  await this.rows.write(w => { const before = w.get<{ revision: number }>("billing_promotion_settings", { id: 1 }); if ((before?.revision ?? 0) !== revision) throw conflict("Campaign settings changed. Reload before saving."); w.upsert("billing_promotion_settings", { id: 1, revision: revision + 1, settings: JSON.stringify(value), updated_by: actor, updated_at: this.clock() }, "replace"); });
  return this.settings();
 }
 private save(w: RowWriter, p: PromotionState) { w.upsert("billing_promotion_state", { ...p, revision: p.revision + 1, updated_at: this.clock() }, "replace"); }
 private event(w: RowWriter, p: PromotionState, i: Impression, type: string) { w.insert("billing_promotion_events", { id: newId("pe"), account_id: p.account_id, campaign_id: i.campaignId, impression_id: i.id, session_id: i.sessionId, type, presentation: i.type, at: this.clock(), variant: i.variant }); }
 async activity(s: Subject, id: string, active: boolean) {
  if (!s.registered || !s.onboardingComplete || s.excluded) return { recorded: false };
  const now = this.clock();
  await this.rows.write(w => {
   const p = w.get<PromotionState>("billing_promotion_state", { account_id: s.accountId }) ?? blank(s, now);
   if (p.opt_out || s.plan !== "free") return;
   const sessions = parsed<Activity>(p.sessions).filter(a => now - a.lastAt < 90 * DAY);
   let a = sessions.find(a => a.id === id);
   if (!a) { a = { id, startedAt: now, lastAt: now, activeMs: 0, completedAt: null }; sessions.push(a); }
   const elapsed = now - a.lastAt;
   if (active && elapsed > 0 && elapsed <= 120_000) a.activeMs += Math.min(elapsed, 30_000);
   a.lastAt = now;
   const seconds = Math.max(60, ...this.settings().settings.campaigns.map(c => c.minSessionSeconds));
   if (a.completedAt === null && a.activeMs >= seconds * 1000 && !sessions.some(other => other.id !== id && other.completedAt !== null && now - other.completedAt < 30 * 60_000)) a.completedAt = now;
   p.sessions = JSON.stringify(sessions.slice(-100)); this.save(w, p);
  });
  return { recorded: true };
 }
 async claim(s: Subject, body: z.infer<typeof ClaimBody>) {
  if (!body.safe || body.screen !== "home" && body.screen !== "subscription_settings") return { promotion: null };
  const now = this.clock();
  return this.rows.write(w => {
   const cfg = this.settings(); if (!cfg.settings.enabled) return { promotion: null };
   const p = w.get<PromotionState>("billing_promotion_state", { account_id: s.accountId }) ?? blank(s, now);
   if (!parsed<Activity>(p.sessions).some(a => a.id === body.sessionId)) return { promotion: null };
   const campaign = cfg.settings.campaigns.filter(c => c.trigger === body.trigger && (c.presentation !== "modal" || cfg.settings.popupsEnabled))
    .map(c => ({ c, d: decision(c, s, p, now, body.sessionId) })).filter(v => v.d.eligible).sort((a, b) => b.d.score - a.d.score)[0]?.c;
   if (!campaign) return { promotion: null };
   const variant = campaign.experiment && createHash("sha256").update(`${campaign.experiment.id}:${s.accountId}`).digest().readUInt32BE(0) % 100 < campaign.experiment.treatmentPercent ? "treatment" : "control";
   const i: Impression = { id: newId("pi"), campaignId: campaign.id, sessionId: body.sessionId, type: campaign.presentation, at: now, variant };
   p.history = JSON.stringify([...parsed<Impression>(p.history).filter(v => now - v.at < 90 * DAY), i].slice(-100));
   p.sessions = JSON.stringify(parsed<Activity>(p.sessions).map(a => a.id === body.sessionId ? { ...a, shownAt: now } : a));
   this.save(w, p); this.event(w, p, i, "eligible"); this.event(w, p, i, "reserved");
   return { promotion: this.view(campaign, i, now) };
  });
 }
 private view(c: CampaignConfig, i: Impression, now: number) { return { id: i.id, campaignId: c.id, presentation: c.presentation, heading: i.variant === "treatment" ? c.experiment!.treatmentHeading : c.heading, description: c.description, image: c.image, cta: c.cta, destination: c.destination, amountMinor: PLUS_PRICE_MINOR, currency: "USD" as const, interval: "month" as const, expiresAt: now + 10_000 }; }
 current(s: Subject, id: string) {
  const cfg = this.settings(); const p = this.rows.get<PromotionState>("billing_promotion_state", { account_id: s.accountId });
  if (!cfg.settings.enabled || !p || p.opt_out || s.plan !== "free" || s.checkout || s.excluded || !s.registered || !s.onboardingComplete) return { active: false };
  const i = parsed<Impression>(p.history).find(i => i.id === id); const c = cfg.settings.campaigns.find(c => c.id === i?.campaignId);
  return { active: !!(i && c?.active && (c.presentation !== "modal" || cfg.settings.popupsEnabled) && (c.startsAt === null || this.clock() >= c.startsAt) && (c.endsAt === null || this.clock() < c.endsAt) && this.clock() - i.at < 120_000 && this.clock() >= p.snoozed_until && (p.dismissed_at === null || p.dismissed_at < i.at)), expiresAt: this.clock() + 10_000 };
 }
 async feedback(s: Subject, body: z.infer<typeof EventBody>) {
  await this.rows.write(w => {
   const p = w.get<PromotionState>("billing_promotion_state", { account_id: s.accountId });
   const i = p && parsed<Impression>(p.history).find(i => i.id === body.impressionId && i.sessionId === body.sessionId);
   if (!p || !i) throw notFound("Promotion not found");
   if (w.get("billing_promotion_events", { account_id: s.accountId, impression_id: i.id, type: body.event })) return;
   const c = this.settings().settings.campaigns.find(c => c.id === i.campaignId) ?? DEFAULT_CAMPAIGN;
   if (body.event === "dismiss") p.dismissed_at = this.clock();
   if (body.event === "snooze") p.snoozed_until = this.clock() + c.snoozeDays * DAY;
   this.save(w, p); this.event(w, p, i, body.event);
  }); return { ok: true };
 }
 async preference(s: Subject, optOut: boolean) {
  await this.rows.write(w => { const existing = w.get<PromotionState>("billing_promotion_state", { account_id: s.accountId }); if (existing && existing.opt_out === (optOut ? 1 : 0)) return; const p = existing ?? blank(s, this.clock()); p.opt_out = optOut ? 1 : 0; this.save(w, p); const i: Impression = { id: "preference", campaignId: "all", sessionId: "preference", type: "banner", at: this.clock(), variant: "control" }; this.event(w, p, i, optOut ? "opt_out" : "opt_in"); }); return { optOut };
 }
 async renewal(s: Subject, sessionId: string, claim = true) {
  const now = this.clock();
  if (!s.registered || !s.onboardingComplete || s.plan !== "plus" || s.checkout) return { notice: null };
  const sub = this.rows.all<{ id: string; plan_version_id: string; provider: string; current_period_end: number; cancel_at_period_end: number }>("billing_subscriptions", { where: { owner_kind: "account", account_id: s.accountId, status: { in: ["active", "past_due"] }, current_period_end: { gt: now } }, orderBy: [["current_period_end", "desc"]] }).filter(sub => sub.current_period_end <= now + 3 * DAY).find(sub => { const v = this.rows.get<{plan_id: string}>("billing_plan_versions", {id: sub.plan_version_id}); return !!v && this.rows.get<{key: string}>("billing_plans",{id:v.plan_id})?.key === "plus"; });
  const grant = !sub ? this.rows.get<{ id: string; ends_at: number }>("billing_grants", { account_id: s.accountId, plan_key: "plus", starts_at: { lte: now }, ends_at: { gt: now } }, [["ends_at", "desc"]]) : null;
  const endsAt = sub?.current_period_end ?? grant?.ends_at;
  if (!endsAt || endsAt > now + 3 * DAY) return { notice: null };
  const autoRenew = !!sub && !sub.cancel_at_period_end;
  const key = `renewal:${autoRenew ? "auto" : "end"}:${sub?.id ?? grant!.id}:${endsAt}`;
  const version = sub ? this.rows.get<{ amount_minor: number; currency: string; interval: string; billing_frequency: number }>("billing_plan_versions", { id: sub.plan_version_id }) : null;
  return this.rows.write(w => {
   const p = w.get<PromotionState>("billing_promotion_state", { account_id: s.accountId }) ?? blank(s, now);
   const history = parsed<Impression>(p.history); const existing = history.find(i => i.campaignId === key);
   if (claim && existing || !claim && !existing) return { notice: null };
   const i: Impression = existing ?? { id: newId("rn"), campaignId: key, sessionId, type: "banner", at: now, variant: "control" };
   if (claim) { p.history = JSON.stringify([...history.filter(i => now-i.at < 90*DAY), i].slice(-100)); this.save(w,p); this.event(w,p,i,"renewal_impression"); }
   const months = version ? (version.interval === "year" ? 12 : 1) * (version.billing_frequency ?? 1) : null;
   return { notice: { id: i.id, autoRenew, endsAt, amountMinor: sub?.provider === "google_play" ? null : version?.amount_minor ?? null, currency: sub?.provider === "google_play" ? null : version?.currency ?? null, months, expiresAt: now + 10_000 } };
  });
 }
 metrics() {
  const events = this.rows.all<{ type: string; presentation: string; account_id: string; campaign_id: string; variant: string }>("billing_promotion_events", { where: { at: { gt: this.clock() - 30 * DAY } } });
  const count = (type: string) => events.filter(e => e.type === type).length;
  const impressions = count("impression"), dismissals = count("dismiss"), clicks = count("click"), conversions = count("conversion");
  return { windowDays: 30, impressions, dismissals, clicks, conversions, snoozes: count("snooze"), optOuts: count("opt_out"), complaints: count("complaint"), checkoutStarts: count("checkout_start"), checkoutAbandonment: Math.max(0, count("checkout_start") - conversions), pricingVisits: count("pricing_visit"), cancellations: count("cancellation"), refunds: count("refund"),
   dismissalRate: impressions ? dismissals / impressions : 0, conversionRate: impressions ? conversions / impressions : 0,
   repeatedDismissals: [...new Set(events.filter(e => e.type === "dismiss").map(e => e.account_id))].filter(id => events.filter(e => e.account_id === id && e.type === "dismiss").length > 1).length,
   banners: events.filter(e => e.type === "impression" && e.presentation === "banner").length, cards: events.filter(e => e.type === "impression" && e.presentation === "card").length, popups: events.filter(e => e.type === "impression" && e.presentation === "modal").length,
   variants: ["control", "treatment"].map(variant => ({ variant, impressions: events.filter(e => e.type === "impression" && e.variant === variant).length, conversions: events.filter(e => e.type === "conversion" && e.variant === variant).length })) };
 }
 lifecycleIn(w: RowWriter, accountId: string, type: "checkout_start" | "conversion" | "cancellation" | "refund", reference: string) {
   const p = w.get<PromotionState>("billing_promotion_state", { account_id: accountId }); if (!p) return;
   const i = parsed<Impression>(p.history).filter(i => this.clock() - i.at < 30 * DAY && !i.campaignId.startsWith("renewal:")).at(-1); if (!i) return;
   const id = createHash("sha256").update(`${accountId}:${type}:${reference}`).digest("hex");
   if (w.get("billing_promotion_events", { id }) || type === "conversion" && w.get("billing_promotion_events", { account_id: accountId, impression_id: i.id, type })) return;
   w.insert("billing_promotion_events", { id, account_id: accountId, campaign_id: i.campaignId, impression_id: i.id, session_id: i.sessionId, type, presentation: i.type, at: this.clock(), variant: i.variant });
 }
 async lifecycle(accountId: string, type: "checkout_start" | "conversion" | "cancellation" | "refund", reference: string) { await this.rows.write(w => this.lifecycleIn(w, accountId, type, reference)); }
}

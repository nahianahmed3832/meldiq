import type { AppContext } from "../../app/context.js";
import { badRequest } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { accountStateCounts, signupsBetween, signupsPerDay, userCounts, usernames } from "../accounts/index.js";
import { orgCounts, orgsCreatedBetween, orgsWithMembers } from "../organizations/index.js";
import { analytics, utcDay } from "../telemetry/index.js";
import type { AdminPrincipal } from "./auth.js";
import type { Exclusions } from "./exclusions.js";
import { can } from "./permissions.js";
import { platformSetting } from "./settings.js";

export const RANGE_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 } as const;
export type Range = keyof typeof RANGE_MS;

const DAY_MS = 86_400_000;
/** Days a day-range request may cover. */
const MAX_DAYS = 120;
/** Organizations whose activity is computed (largest first). */
const ORGS_SHOWN = 100;
const ACTIVATION_DAYS = 7;
const GB = 1024 ** 3;

const change = (current: number | null, previous: number | null) =>
  current === null || previous === null || previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10;
const compare = (current: number | null, previous: number | null) => ({ current, previous, change: change(current, previous) });

/** A [from, to] day range: defaults to the last 30 days, at most MAX_DAYS, never in the future. */
export function dayRange(q: { from?: string; to?: string }, t = now()): { from: string; to: string } {
  const today = utcDay(t);
  const to = q.to && q.to < today ? q.to : today;
  const from = q.from ?? analytics.addDays(to, -29);
  if (from > to) throw badRequest("The range starts after it ends.");
  if (analytics.daysBetween(from, to, MAX_DAYS + 1).length > MAX_DAYS) throw badRequest(`A range is at most ${MAX_DAYS} days.`);
  return { from, to };
}

/**
 * Analytics for the console (docs/ANALYTICS_DEFINITIONS.md). Figures come from telemetry (activity, presence,
 * resources), the accounts and organizations tables, and the request metrics; anything not measured is null.
 */
export class AdminAnalytics {
  constructor(
    private readonly ctx: AppContext,
    private readonly exclusions: Exclusions,
  ) {}

  private collectingSince(): number | null {
    return this.ctx.telemetry.since("activity");
  }

  /** DAU/WAU/MAU for the last complete UTC day and the one before, or null before collection covers them. */
  private activeTrio(excluded: string, t: number) {
    const since = this.collectingSince();
    const yesterday = utcDay(t - DAY_MS);
    const before = utcDay(t - 2 * DAY_MS);
    const covered = (day: string, span: number) => since !== null && analytics.addDays(day, -(span - 1)) >= utcDay(since);
    const metric = (day: string, span: number) => (covered(day, span) || (since !== null && day >= utcDay(since) && span === 1) ? analytics.distinctActive(this.ctx.db, analytics.addDays(day, -(span - 1)), day, excluded) : null);
    const pick = (span: number) => compare(metric(yesterday, span), metric(span === 1 ? before : analytics.addDays(yesterday, -span), span));
    return { dau: pick(1), wau: pick(7), mau: pick(30) };
  }

  async overview(p: AdminPrincipal, range: Range) {
    const t = now();
    const ms = RANGE_MS[range];
    const ex = await this.exclusions.get(t);
    const db = this.ctx.db;
    const people = userCounts(db, t, 1);
    const states = accountStateCounts(db, t);
    const trio = this.activeTrio(ex.json, t);
    const since = this.collectingSince();
    const sinceOk = (from: number) => since !== null && from >= since;
    const activeNow = analytics.activeBetween(db, t - ms, t, ex.json);
    const activePrev = sinceOk(t - 2 * ms) ? analytics.activeBetween(db, t - 2 * ms, t - ms, ex.json) : null;
    const live = this.ctx.telemetry.live(t);
    const presence = analytics.presenceSeries(db, t - ms, t);
    const orgs = orgCounts(db, t, 1);
    // Organizations with at least one member active in the range (the largest ORGS_SHOWN).
    const fromDay = utcDay(t - ms);
    const activeOrgs = since === null ? null : orgsWithMembers(db, ORGS_SHOWN).filter((o) => analytics.activeAmong(db, JSON.stringify(o.members), fromDay, utcDay(t), ex.json).users > 0).length;
    const trafficDays = analytics.trafficDays(db, fromDay, utcDay(t), ex.json);
    const sum = (metric: string) => (since === null ? null : trafficDays.filter((d) => d.metric === metric).reduce((a, d) => a + d.value, 0));
    await this.ctx.usage.snapshot();
    const workspaceBytes = this.ctx.usage.totals(1).reduce((a, o) => a + (o.metrics["storage.bytes"] ?? 0), 0);
    const health = can(p.grant.role, "health.view");
    const requests = health
      ? {
          requests: analytics.seriesSum(db, "api.requests", t - ms, t),
          serverErrors: analytics.seriesSum(db, "api.errors_5xx", t - ms, t),
          errorRate: null as number | null,
          p50Ms: analytics.seriesAvg(db, "api.latency.p50_ms", t - ms, t),
          p95Ms: analytics.seriesAvg(db, "api.latency.p95_ms", t - ms, t),
          p99Ms: analytics.seriesAvg(db, "api.latency.p99_ms", t - ms, t),
          wsAuthFailures: presence.points.length ? presence.points.reduce((a, x) => a + x.authFailures, 0) : null,
          wsAbnormal: presence.points.length ? presence.points.reduce((a, x) => a + x.abnormal, 0) : null,
          wsConnects: presence.points.length ? presence.points.reduce((a, x) => a + x.connects, 0) : null,
        }
      : null;
    if (requests && requests.requests) requests.errorRate = Math.round(((requests.serverErrors ?? 0) / requests.requests) * 10000) / 100;
    const providers = health ? this.ctx.metrics.snapshot().providers.map((x) => ({ name: x.name, ok: x.ok, failed: x.failed, lastFailureAt: x.lastFailureAt })) : null;
    const incidents = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(severity = 'sev1'), 0) c FROM platform_incidents WHERE status != 'resolved'").get() as { n: number; c: number };
    const breaching = (db.prepare("SELECT COUNT(*) n FROM alert_state WHERE breaching = 1").get() as { n: number }).n;
    return {
      generatedAt: t,
      range,
      collectingSince: since,
      excluded: ex.counts,
      people: { registered: people.total, usable: states.usable, suspended: people.suspended, newAccountLimited: states.newAccountLimited, withSession: await this.ctx.accounts.store.sessionHolders(t) },
      activity: {
        ...trio,
        activeInRange: compare(since === null ? null : activeNow, activePrev),
        newSignups: compare(signupsBetween(db, t - ms, t), signupsBetween(db, t - 2 * ms, t - ms)),
        dauOverMau: trio.dau.current !== null && trio.mau.current ? Math.round((trio.dau.current / trio.mau.current) * 1000) / 10 : null,
        wauOverMau: trio.wau.current !== null && trio.mau.current ? Math.round((trio.wau.current / trio.mau.current) * 1000) / 10 : null,
      },
      live: { users: live.users, activeUsers: live.activeUsers, devices: live.devices, sockets: live.sockets, calls: live.calls.calls, callParticipants: live.calls.participants, peakUsers: presence.peakUsers, peakAt: presence.peakAt },
      organizations: { total: orgs.total, active: activeOrgs, newInRange: compare(orgsCreatedBetween(db, t - ms, t), orgsCreatedBetween(db, t - 2 * ms, t - ms)) },
      messaging: {
        messagesAccepted: sum("messages"),
        why: "Message envelopes the server accepted (UTC days covering the range), counted per sender; never their content. End-to-end encrypted: the server can't tell what they contain.",
      },
      files: { uploadedBytes: sum("files.upload"), downloadedBytes: sum("files.download"), storedWorkspaceBytes: workspaceBytes },
      requests,
      push: providers ? { providers } : null,
      incidents: { open: incidents.n, critical: incidents.c, breachingRules: breaching },
      billing: { available: !!this.ctx.billing.provider, reason: this.ctx.billing.unavailableReason },
    };
  }

  async activeUsers(q: { from?: string; to?: string }) {
    const { from, to } = dayRange(q);
    const ex = await this.exclusions.get();
    const since = this.collectingSince();
    const sinceDay = since === null ? null : utcDay(since);
    const days = analytics.activeUsers(this.ctx.db, from, to, ex.json).map((d) => ({ ...d, collected: sinceDay !== null && d.day >= sinceDay }));
    return {
      from,
      to,
      collectingSince: sinceDay,
      definition:
        "DAU: distinct people with qualifying activity (an authenticated app request that isn't background traffic) on the UTC day. WAU / MAU: over the 7 / 30 UTC days ending that day. New: the account was created that UTC day. Days before collection began aren't counted.",
      days,
    };
  }

  async retention(q: { from?: string; to?: string }) {
    const { from, to } = dayRange(q);
    const ex = await this.exclusions.get();
    const t = now();
    const since = this.collectingSince();
    const sinceDay = since === null ? null : utcDay(since);
    const signups = signupsPerDay(this.ctx.db, Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`) + DAY_MS, ex.json);
    const cohorts = analytics.retention(this.ctx.db, signups, ex.json, utcDay(t), sinceDay);
    // Activation: sign-ups since collection began that have had their full 7 days.
    const start = Math.max(Date.parse(`${from}T00:00:00Z`), since ?? Infinity);
    const end = Math.min(Date.parse(`${to}T00:00:00Z`) + DAY_MS, t - ACTIVATION_DAYS * DAY_MS);
    const eligible = start < end ? signupsPerDay(this.ctx.db, start, end, ex.json).reduce((a, d) => a + d.count, 0) : 0;
    const act = start < end ? analytics.activation(this.ctx.db, start, end, ex.json) : { activated: 0, medianMsToFirstAction: null };
    return {
      from,
      to,
      collectingSince: sinceDay,
      cohorts,
      activation: { eligible, activated: act.activated, rate: eligible ? Math.round((act.activated / eligible) * 1000) / 10 : null, medianMsToFirstAction: act.medianMsToFirstAction, windowDays: ACTIVATION_DAYS },
      definitions: {
        cohort: "People who signed up on the UTC day (load-test and excluded accounts left out; deleted accounts still count).",
        retention: "Day N: the share of the cohort with qualifying activity on the UTC day N days after signing up. Blank: that day isn't over yet, or was before collection began.",
        activation: `Eligible: sign-ups since collection began that have had ${ACTIVATION_DAYS} full days. Activated: made a meaningful action (a message, an upload, a call, joining or creating a space) within ${ACTIVATION_DAYS} days of signing up.`,
      },
    };
  }

  async clients(q: { from?: string; to?: string }) {
    const { from, to } = dayRange(q);
    const ex = await this.exclusions.get();
    const c = analytics.activeByClient(this.ctx.db, from, to, ex.json);
    return {
      from,
      to,
      platforms: c.platforms,
      versions: c.versions,
      accountAge: analytics.activeByAccountAge(this.ctx.db, from, to, ex.json),
      note: "Platform comes from each request's client (User-Agent). App versions appear only for clients that send one: today iOS builds do; the Android app and browsers don't. Location isn't collected.",
    };
  }

  async organizations(q: { from?: string; to?: string }) {
    const { from, to } = dayRange(q);
    const ex = await this.exclusions.get();
    const rows = orgsWithMembers(this.ctx.db, ORGS_SHOWN).map((o) => {
      const a = analytics.activeAmong(this.ctx.db, JSON.stringify(o.members), from, to, ex.json);
      return { id: o.id, name: o.name, kind: o.kind, members: o.members.length, activeMembers: a.users, lastActiveAt: a.lastAt };
    });
    return { from, to, organizations: rows.sort((a, b) => b.activeMembers - a.activeMembers || b.members - a.members) };
  }

  async traffic(q: { from?: string; to?: string }) {
    const { from, to } = dayRange(q);
    const ex = await this.exclusions.get();
    const db = this.ctx.db;
    const t = now();
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Math.min(Date.parse(`${to}T00:00:00Z`) + DAY_MS, t);
    const days = analytics.trafficDays(db, from, to, ex.json).filter((d) => d.metric !== "messages") as { day: string; metric: "api.in" | "api.out" | "ws.in" | "ws.out" | "files.upload" | "files.download"; value: number }[];
    const totals: Record<string, number> = {};
    for (const d of days) totals[d.metric] = (totals[d.metric] ?? 0) + d.value;
    const top = analytics.topTraffic(db, from, to, ex.json, 20).map((u) => ({ ...u, byMetric: Object.fromEntries(Object.entries(u.byMetric).filter(([k]) => k !== "messages")) }));
    const names = usernames(db, top.map((u) => u.userId));
    const services = (["api", "livekit", "ntfy", "other"] as const).map((s) => ({ service: s, txBytes: analytics.seriesTotal(db, `svc.${s}.net_tx_bps`, fromMs, toMs), rxBytes: analytics.seriesTotal(db, `svc.${s}.net_rx_bps`, fromMs, toMs) }));
    // Month to date, for the plan's transfer allowance and the storage provider's prices (operator-entered).
    const monthStart = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
    const monthEnd = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1);
    const mtdTx = analytics.seriesTotal(db, "host.net.tx_bps", monthStart, t);
    const allowance = platformSetting(db, "costs.transfer_allowance_bytes");
    const storagePrice = platformSetting(db, "costs.storage_per_gb_month");
    const egressPrice = platformSetting(db, "costs.egress_per_gb");
    const server = platformSetting(db, "costs.server_monthly");
    const stored = analytics.latestResources(db, t, 2 * 3_600_000).get("storage.files_bytes")?.value ?? null;
    const mtdDownloads = analytics.trafficDays(db, utcDay(monthStart), utcDay(t), "[]").filter((d) => d.metric === "files.download").reduce((a, d) => a + d.value, 0);
    return {
      from,
      to,
      totals,
      days,
      topUsers: top.map((u) => ({ userId: u.userId, username: names.get(u.userId) ?? null, total: u.total, byMetric: u.byMetric })),
      network: {
        hostTxBytes: analytics.seriesTotal(db, "host.net.tx_bps", fromMs, toMs),
        hostRxBytes: analytics.seriesTotal(db, "host.net.rx_bps", fromMs, toMs),
        apiTxBytes: analytics.seriesTotal(db, "api.net.tx_bps", fromMs, toMs),
        apiRxBytes: analytics.seriesTotal(db, "api.net.rx_bps", fromMs, toMs),
        services,
        source: "Host and per-service figures come from the host collector (network interface and container counters); the API's own figures from its network namespace. Each is measured once: they overlap (the API's traffic is part of the host's), so they aren't added up.",
      },
      costs: {
        transferAllowanceBytes: allowance.bytes,
        projectedMonthHostTxBytes: mtdTx === null ? null : Math.round((mtdTx / Math.max(1, t - monthStart)) * (monthEnd - monthStart)),
        storageEstimateMicro: storagePrice.amountMicro === null || stored === null ? null : Math.round((stored / GB) * storagePrice.amountMicro),
        egressEstimateMicro: egressPrice.amountMicro === null ? null : Math.round((mtdDownloads / GB) * egressPrice.amountMicro),
        serverMonthlyMicro: server.amountMicro,
        sources: { transfer: allowance.source, storage: storagePrice.source, egress: egressPrice.source, server: server.source },
        note: "Estimates from prices an operator entered (Settings), never invoices. File downloads are served by the storage provider directly (presigned links), so their transfer is billed by it, not by the server's host.",
      },
      notes: [
        "api.in / api.out: request and response bodies of authenticated app requests (headers left out).",
        "ws.in / ws.out: realtime frames received from and sent to each person's devices.",
        "files.upload / files.download: file bytes stored and asked for; most file transfer goes directly between apps and the storage provider.",
        "Per-person traffic exists only from the day collection began.",
      ],
    };
  }
}

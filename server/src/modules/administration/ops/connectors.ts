import type { AppContext } from "../../../app/context.js";
import { CONNECTOR_CHECKS } from "../../../shared/contracts/http/admin.js";
import { now } from "../../../shared/utilities/util.js";
import { storageCheck } from "./health.js";
import type { ProviderStats as ProviderMetric } from "./metrics.js";

/**
 * The infrastructure register (docs/CONNECTORS.md): the outside services Meldiq itself runs on (email, file storage,
 * push wake-ups, calls, MongoDB), in one list for platform admins, with their real state. Optional product
 * connectors were removed in the community rebuild (docs/COMMUNITY_REBUILD_2026-10-21.md). A connector is "working" only after a measured success (a call, a check or a validated
 * connection); configured but never exercised is "configured", never "working". Names of missing settings only, never
 * values; counts only, never who or what.
 */
export type ConnectorState = "working" | "configured" | "failing" | "needs_configuration" | "disabled" | "awaiting_provider" | "planned";

export interface ConnectorStatus {
  id: string;
  name: string;
  category: string;
  state: ConnectorState;
  /** Environment names still missing (names only). */
  missing: string[];
  /** One plain sentence about what it does here and now. */
  detail: string;
  /** Counts only (workspaces, connections, devices…). */
  usage: Record<string, number>;
  lastOkAt: number | null;
  lastFailureAt: number | null;
  lastErrorKind: string | null;
  /** True when [checkConnector] can test it without sending anything to a person or spending money. */
  checkable: boolean;
  /** What the owner has to do outside Meldiq, when anything. */
  ownerAction: string | null;
  docs: string;
}

interface Signal {
  lastOkAt: number | null;
  lastFailureAt: number | null;
  lastErrorKind: string | null;
}

/** A failure newer than the last success counts as "failing" for this long, then as configured-but-unverified. */
const FAILING_WINDOW_MS = 24 * 3600_000;
const NO_SIGNAL: Signal = { lastOkAt: null, lastFailureAt: null, lastErrorKind: null };
const latest = (...xs: (number | null | undefined)[]): number | null => xs.reduce<number | null>((a, x) => (typeof x === "number" && (a === null || x > a) ? x : a), null);

function metricSignal(metrics: readonly ProviderMetric[], ...names: string[]): Signal {
  return metrics
    .filter((m) => names.includes(m.name))
    .reduce<Signal>(
      (a, m) => ({
        lastOkAt: latest(a.lastOkAt, m.lastOkAt),
        lastFailureAt: latest(a.lastFailureAt, m.lastFailureAt),
        lastErrorKind: m.lastFailureAt !== null && m.lastFailureAt === latest(a.lastFailureAt, m.lastFailureAt) ? m.lastErrorKind : a.lastErrorKind,
      }),
      NO_SIGNAL,
    );
}

/** The state from configuration and measured signals (pure: unit-tested). */
export function stateFor(missing: readonly string[], signal: Signal, t: number, opts: { disabled?: boolean; awaiting?: boolean; planned?: boolean } = {}): ConnectorState {
  if (opts.planned) return "planned";
  if (opts.awaiting) return "awaiting_provider";
  if (opts.disabled) return "disabled";
  if (missing.length) return "needs_configuration";
  const failingNow = signal.lastFailureAt !== null && (signal.lastOkAt === null || signal.lastFailureAt > signal.lastOkAt);
  if (failingNow && t - (signal.lastFailureAt ?? 0) < FAILING_WINDOW_MS) return "failing";
  return signal.lastOkAt !== null ? "working" : "configured";
}

type Row = Omit<ConnectorStatus, "state" | keyof Signal> & { signal: Signal; flags?: Parameters<typeof stateFor>[3] };

const finish = (r: Row, t: number): ConnectorStatus => {
  const { signal, flags, ...rest } = r;
  return { ...rest, ...signal, state: stateFor(r.missing, signal, t, flags) };
};


/** Platform services: email, storage, push, calls, database. */
function platformRows(ctx: AppContext, metrics: readonly ProviderMetric[], storage: Signal): Row[] {
  const cfg = ctx.config;
  const mail = cfg.accounts.mail;
  const mailOn = mail.transport === "smtp" || mail.transport === "ses";
  const rows: Row[] = [
    {
      id: "email",
      name: mail.transport === "smtp" ? "Email (SMTP)" : mail.transport === "ses" ? "Email (Amazon SES)" : "Email",
      category: "email",
      missing: mailOn || mail.transport === "file" ? [] : ["MAIL_TRANSPORT"],
      detail: mailOn ? "Verification codes, invitations, recovery and notices." : mail.transport === "file" ? "Development: emails are written to files, not sent." : "No email is sent: sign-up by email and recovery are unavailable.",
      usage: {},
      checkable: mail.transport === "smtp",
      ownerAction: null,
      docs: "docs/EMAIL.md",
      signal: metricSignal(metrics, `mail.${mail.transport}`),
    },
    {
      id: "storage",
      name: cfg.storage.backend === "s3" ? "File storage (Amazon S3)" : "File storage (this server's disk)",
      category: "storage",
      missing: [],
      detail: "Encrypted attachments and photos.",
      usage: {},
      checkable: true,
      ownerAction: null,
      docs: "docs/AWS_STORAGE_PLAN.md",
      signal: storage,
    },
    {
      id: "push-unifiedpush",
      name: "UnifiedPush wake-ups",
      category: "push",
      missing: cfg.push ? [] : ["PUSH_UNIFIEDPUSH_HOSTS"],
      detail: "Wakes phones without Google services (for example through ntfy). Wake-ups carry no content.",
      usage: { devices: ctx.identity.count("push_endpoints") },
      checkable: false,
      ownerAction: null,
      docs: "docs/PUSH_SERVER.md",
      signal: metricSignal(metrics, "push.unifiedpush"),
    },
    {
      id: "push-fcm",
      name: "Firebase Cloud Messaging",
      category: "push",
      missing: cfg.fcm ? [] : ["FCM_PROJECT_ID", "FCM_SERVICE_ACCOUNT_FILE"],
      detail: "Wakes Android phones through Google. Wake-ups carry no content.",
      usage: { devices: ctx.identity.count("fcm_tokens") },
      checkable: !!cfg.fcm,
      ownerAction: cfg.fcm ? null : "Create a Firebase project for com.meldiq.android, add the app's google-services.json to the build, and give the server a service account with the Firebase Cloud Messaging API role.",
      docs: "docs/PUSH_FCM.md",
      signal: metricSignal(metrics, "push.fcm"),
    },
    {
      id: "calls",
      name: "Calls (LiveKit)",
      category: "calls",
      missing: cfg.livekit ? [] : ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_PUBLIC_URL"],
      detail: "Voice and video calls, screen sharing and voice rooms.",
      usage: {},
      checkable: false,
      ownerAction: null,
      docs: "docs/CALLING_AND_E2EE.md",
      signal: NO_SIGNAL,
    },
    {
      id: "mongodb",
      name: "MongoDB",
      category: "database",
      missing: cfg.mongo ? [] : ["MONGODB_URI"],
      detail: cfg.mongo ? "Accounts and preferences, for the domains it owns." : "Not used: everything is in the server's own database.",
      usage: {},
      checkable: !!cfg.mongo,
      ownerAction: null,
      docs: "docs/MONGODB.md",
      signal: metricSignal(metrics, "mongodb"),
    },
  ];
  return rows;
}

/** The whole register. */
export async function connectorReport(ctx: AppContext): Promise<ConnectorStatus[]> {
  const t = now();
  const metrics = ctx.metrics.snapshot().providers;
  const storage = metricSignal(metrics, "storage");
  const rows = platformRows(ctx, metrics, storage);
  return rows.map((r) => finish(r, t));
}

/** Connector ids [checkConnector] can test. */
export const CHECKS = CONNECTOR_CHECKS;

/**
 * Tests one connector without sending anything to anyone and without spending money: signs in to SMTP, lists storage,
 * gets an FCM access token, pings MongoDB. The outcome is recorded like any other call, so the register shows it.
 */
export async function checkConnector(ctx: AppContext, id: string): Promise<{ ok: boolean; errorKind: string | null }> {
  const record = (ok: boolean, e?: unknown) => {
    if (id === "storage" || id === "mongodb") ctx.metrics.recordProvider(id, ok ? undefined : e ?? new Error("unreachable"));
  };
  try {
    switch (id) {
      case "email": {
        const verify = ctx.accounts.mailer.verify;
        if (!verify) return { ok: false, errorKind: "not_checkable" };
        await verify.call(ctx.accounts.mailer);
        return { ok: true, errorKind: null };
      }
      case "storage": {
        const s = await storageCheck(ctx);
        const ok = s.available && s.reachable;
        record(ok, new Error(s.available ? s.errorKind ?? "unreachable" : "unavailable"));
        return { ok, errorKind: ok ? null : s.available ? s.errorKind ?? "unreachable" : "unavailable" };
      }
      case "push-fcm": {
        if (!ctx.fcm) return { ok: false, errorKind: "not_configured" };
        await ctx.fcm.checkCredentials();
        return { ok: true, errorKind: null };
      }
      case "mongodb": {
        if (!ctx.mongo) return { ok: false, errorKind: "not_configured" };
        const ok = await ctx.mongo.ping();
        record(ok);
        return { ok, errorKind: ok ? null : "unreachable" };
      }
      default:
        return { ok: false, errorKind: "not_checkable" };
    }
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { ok: false, errorKind: typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : "error" };
  }
}

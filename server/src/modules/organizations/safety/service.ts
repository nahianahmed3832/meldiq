import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { SafetySettings } from "../../../shared/contracts/http/orgs.js";
import { ApiError } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { signupTimes } from "../../accounts/index.js";
import { PlatformAdminStore } from "../../platformAdmin/index.js";
import type { ConversationRow } from "../authz.js";
import { admitCommunityPost, joinRefusal, noteJoinForRaid, noteMessageForRaid, type PostKind } from "./gates.js";
import { type AgeGate, type Level, LONGEST_ACCOUNT_GATE_MS, RaidDetector } from "./rules.js";
import { VoiceModeration } from "./voice.js";

/** A community_safety row (migration 070). */
export interface SafetyRow {
  org_id: string;
  verification_level: Level;
  new_account_gate: AgeGate;
  raid_protection: number;
  locked_until: number | null;
  lock_reason: "manual" | "raid" | null;
  locked_by: string | null;
  updated_at: number;
  updated_by: string | null;
}

export type SafetyView = z.infer<typeof SafetySettings>;
type SettingsPatch = { verificationLevel?: Level; newAccountGate?: AgeGate; raidProtection?: boolean };

const DEFAULTS = { verification_level: "none", new_account_gate: "off", raid_protection: 1, locked_until: null, lock_reason: null, locked_by: null } as const;
/** How long a platform-staff answer is reused (joining asks it synchronously inside the join's write unit). */
const STAFF_ANSWER_MS = 60_000;

/**
 * A community's safety (community parity A2, feature "community-safety", docs/COMMUNITY_SAFETY_API.md): its settings
 * and lock in community_safety, raid protection's counting and automatic slowmodes in memory, voice bans and mutes
 * ([voice]). Joining and posting ask it through ./gates.ts. With COMMUNITY_SAFETY=off the routes answer 503 and nothing
 * is enforced; what communities set is kept.
 */
export class CommunitySafety {
  readonly raid = new RaidDetector();
  readonly voice: VoiceModeration;
  /** The time the gates and raid protection go by; tests move it. */
  clock: () => number;
  /** Whether [userId]'s account has a verified email: the accounts module's answer; tests replace it. */
  emailVerified: (userId: string) => Promise<boolean>;
  /** Whether [userId] is Meldiq staff (an active Platform Admin Console grant), never held back by account age. */
  isStaff: (userId: string) => Promise<boolean>;
  private readonly staffAnswers = new Map<string, { staff: boolean; at: number }>();
  /** Channels slowed down by raid protection: until when. */
  private readonly autoSlowUntil = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
    clock: () => number = now,
  ) {
    this.clock = clock;
    this.voice = new VoiceModeration(ctx, enabled);
    this.emailVerified = async (userId) => !!(await ctx.accounts.store.accountByUserId(userId))?.email_verified_at;
    this.isStaff = async (userId) => {
      const account = await ctx.accounts.store.accountByUserId(userId);
      return !!account && !!new PlatformAdminStore(ctx.platform, ctx.ephemeral).activeGrant(account.id);
    };
  }

  /** Throws 503 while the feature is switched off. */
  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Community safety is switched off for now. Try again later.");
  }

  private row(orgId: string): SafetyRow | undefined {
    return this.ctx.ws.get<SafetyRow>("community_safety", { org_id: orgId });
  }

  /** The settings, with the defaults for a community that never changed them. */
  view(orgId: string): SafetyView {
    const r = this.row(orgId) ?? DEFAULTS;
    const lockedUntil = this.lockedUntil(orgId);
    return {
      verificationLevel: r.verification_level,
      newAccountGate: r.new_account_gate,
      raidProtection: !!r.raid_protection,
      lockedUntil,
      lockReason: lockedUntil === null ? null : r.lock_reason,
    };
  }

  /** The lock as the lock route answers it. */
  lockView(orgId: string): { lockedUntil: number | null; lockReason: "manual" | "raid" | null; lockedBy: string | null } {
    const until = this.lockedUntil(orgId);
    const r = this.row(orgId);
    return until === null || !r ? { lockedUntil: null, lockReason: null, lockedBy: null } : { lockedUntil: until, lockReason: r.lock_reason, lockedBy: r.locked_by };
  }

  verificationLevel(orgId: string): Level {
    return this.enabled ? (this.row(orgId)?.verification_level ?? "none") : "none";
  }

  accountGate(orgId: string): AgeGate {
    return this.enabled ? (this.row(orgId)?.new_account_gate ?? "off") : "off";
  }

  /** Until when [orgId] is locked, or null (not locked, the lock ended, or the feature is off). */
  lockedUntil(orgId: string): number | null {
    const until = this.enabled ? (this.row(orgId)?.locked_until ?? null) : null;
    return until !== null && until > this.clock() ? until : null;
  }

  /** What community views carry: the lock for members, the settings for people who can edit the community or ban. */
  summary(orgId: string, userId: string): { lockedUntil?: number | null; safety?: SafetyView } {
    if (!this.enabled || !this.ctx.authz.orgRole(orgId, userId)) return {};
    const { authz } = this.ctx;
    const moderates = authz.can(orgId, userId, "workspace.edit") || authz.can(orgId, userId, "members.ban");
    return { lockedUntil: this.lockedUntil(orgId), ...(moderates ? { safety: this.view(orgId) } : {}) };
  }

  /** Writes the changed settings (the caller checked the permission). Returns what changed, for the audit log. */
  async setSettings(orgId: string, actorId: string, patch: SettingsPatch): Promise<string[]> {
    const before = this.view(orgId);
    const next = {
      verification_level: patch.verificationLevel ?? before.verificationLevel,
      new_account_gate: patch.newAccountGate ?? before.newAccountGate,
      raid_protection: (patch.raidProtection ?? before.raidProtection) ? 1 : 0,
    };
    const changed = [
      next.verification_level !== before.verificationLevel ? `verification ${next.verification_level}` : null,
      next.new_account_gate !== before.newAccountGate ? `new accounts ${next.new_account_gate}` : null,
      !!next.raid_protection !== before.raidProtection ? `raid protection ${next.raid_protection ? "on" : "off"}` : null,
    ].filter((x): x is string => x !== null);
    if (changed.length) await this.upsert(orgId, actorId, next);
    return changed;
  }

  /** Locks until [until] (null unlocks): by [actorId], or by raid protection when [actorId] is null. */
  async setLock(orgId: string, actorId: string | null, until: number | null): Promise<void> {
    const reason: SafetyRow["lock_reason"] = actorId ? "manual" : "raid";
    const lock = until === null ? { locked_until: null, lock_reason: null, locked_by: null } : { locked_until: until, lock_reason: reason, locked_by: actorId };
    await this.upsert(orgId, actorId, lock);
  }

  private async upsert(orgId: string, actorId: string | null, fields: Partial<SafetyRow>): Promise<void> {
    const t = this.clock();
    const update = { ...fields, updated_at: t, updated_by: actorId };
    await this.ctx.ws.write((w) => w.upsert("community_safety", { org_id: orgId, ...DEFAULTS, ...update }, update));
  }

  // ───────────── Joining and posting (./gates.ts) ─────────────

  /** Why [userId] can't join [orgId] now, or null. */
  joinRefusal(orgId: string, userId: string): ApiError | null {
    return this.enabled ? joinRefusal(this.ctx, orgId, userId) : null;
  }

  /** Throws when [userId] can't join [orgId] now (synchronous: inside a join's write unit). */
  admitJoinNow(orgId: string, userId: string): void {
    const refusal = this.joinRefusal(orgId, userId);
    if (refusal) throw refusal;
  }

  /** [admitJoinNow] after looking up whether a young account is platform staff. */
  async admitJoin(orgId: string, userId: string): Promise<void> {
    if (this.enabled) await this.prepareJoin(userId);
    this.admitJoinNow(orgId, userId);
  }

  /** Throws when the lock or the verification level holds [userId] back in [conv] (a community channel). */
  admitPost(conv: ConversationRow, userId: string, kind: PostKind, bot: boolean): Promise<void> {
    return admitCommunityPost(this.ctx, conv, userId, kind, bot);
  }

  /** After someone joined [orgId] (raid protection counts joins). */
  async noteJoin(orgId: string): Promise<void> {
    if (this.enabled) await noteJoinForRaid(this.ctx, orgId);
  }

  /** After a message in [conversationId] (raid protection counts messages per channel). */
  noteMessage(conversationId: string, userId: string): void {
    if (this.enabled) noteMessageForRaid(this.ctx, conversationId, userId);
  }

  // ───────────── Raid protection ─────────────

  raidProtection(orgId: string): boolean {
    return this.enabled && !!(this.row(orgId) ?? DEFAULTS).raid_protection;
  }

  /** The seconds of slowmode raid protection puts on [conversationId] now (0: none). */
  autoSlowmodeSec(conversationId: string): number {
    const until = this.autoSlowUntil.get(conversationId);
    if (until === undefined) return 0;
    if (until > this.clock()) return this.raid.limits.slowmodeSec;
    this.autoSlowUntil.delete(conversationId);
    return 0;
  }

  /** Starts an automatic slowmode on [conversationId]; until when. */
  startAutoSlowmode(conversationId: string): number {
    const until = this.clock() + this.raid.limits.slowmodeMs;
    this.autoSlowUntil.set(conversationId, until);
    return until;
  }

  // ───────────── Platform staff ─────────────

  /**
   * Looks up, once a minute at most, whether [userId] is platform staff, so the synchronous join check can skip the
   * account-age gate for them. Only accounts young enough for a gate to matter are looked up.
   */
  async prepareJoin(userId: string): Promise<void> {
    const createdAt = this.accountCreatedAt(userId);
    if (createdAt === null || createdAt <= this.clock() - LONGEST_ACCOUNT_GATE_MS) return;
    const known = this.staffAnswers.get(userId);
    if (known && known.at > this.clock() - STAFF_ANSWER_MS) return;
    this.staffAnswers.set(userId, { staff: await this.isStaff(userId), at: this.clock() });
  }

  /** The answer [prepareJoin] found (false when nobody asked: a brand-new sign-up is never staff). */
  knownStaff(userId: string): boolean {
    const known = this.staffAnswers.get(userId);
    return !!known && known.staff && known.at > this.clock() - STAFF_ANSWER_MS;
  }

  /** When [userId]'s messaging identity was made, or null for nobody known here. */
  accountCreatedAt(userId: string): number | null {
    return signupTimes(this.ctx.identity, [userId]).get(userId) ?? null;
  }

  // ───────────── Lifecycle ─────────────

  async forgetMember(orgId: string, userId: string): Promise<void> {
    await this.voice.forgetMember(orgId, userId);
  }

  async removeOrg(orgId: string): Promise<void> {
    await this.ctx.ws.write((w) => w.delete("community_safety", { org_id: orgId }));
    await this.voice.removeOrg(orgId);
    this.raid.forget(orgId);
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.voice.deleteForUser(userId);
    this.staffAnswers.delete(userId);
  }
}

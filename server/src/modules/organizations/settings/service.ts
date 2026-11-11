import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { RowReader, RowWriter } from "../../../infrastructure/database/rows/index.js";
import { COMMUNITY_SETTINGS_LIMITS, type CommunitySettingsBody, type CommunitySettingsView, type OnboardingStatus } from "../../../shared/contracts/http/communitySettings.js";
import type { CommunityLink } from "../../../shared/contracts/http/orgs.js";
import { ApiError } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import type { ConversationRow } from "../authz.js";
import { communityClipsBlocked } from "../../platformAdmin/index.js";
import { visibleToEveryone } from "../communityRoutes.js";
import { onboardingOn, unansweredRequiredPrompt } from "../onboardingRoutes.js";
import { claimInviteSlug, inviteSlugOf, normalizeInviteSlug, releaseInviteSlug, requireSlugFree } from "./vanity.js";

/** How many members a community needs before it may claim a custom invite link. */
export const INVITE_SLUG_MIN_MEMBERS = COMMUNITY_SETTINGS_LIMITS.slugMinMembers;

type Link = z.infer<typeof CommunityLink>;
type Body = z.infer<typeof CommunitySettingsBody>;

interface SettingsRow {
  org_id: string;
  background: string | null;
  links: string;
  onboarding_required: number;
  voice_clips: number;
  onboarding_required_since: number | null;
  start_channel_id: string | null;
  updated_at: number;
  updated_by: string;
}

/** The stored links, skipping anything that isn't one (the column is JSON). */
function parseLinks(json: string): Link[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => (x && typeof x.label === "string" && typeof x.url === "string" ? [{ label: x.label, url: x.url }] : []));
  } catch {
    return [];
  }
}

/** A channel people can land in after onboarding: a live text channel of [orgId] that everyone can see. */
export function suitableStartChannel(ctx: AppContext, conv: ConversationRow | undefined, orgId: string): boolean {
  if (!conv || conv.type !== "CHANNEL" || conv.org_id !== orgId || conv.voice === 1 || (conv.format ?? "text") !== "text") return false;
  return (conv.kind === "PUBLIC" || conv.kind === "ANNOUNCEMENT") && visibleToEveryone(ctx, conv);
}

/**
 * A community's settings from the reference app's Server Profile, Theme and Onboarding pages (community parity A3,
 * feature "community-settings", docs/COMMUNITY_SETTINGS_API.md). Rows are read synchronously, so posting can ask
 * [mustFinish] directly. With COMMUNITY_SETTINGS=off the routes answer 503 and nothing here is enforced or shown.
 */
export class CommunitySettings {
  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
    private readonly clock: () => number = now,
  ) {}

  /** Throws 503 while the feature is switched off. */
  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "These community settings are switched off for now. Try again later.");
  }

  private row(orgId: string, rows: RowReader = this.ctx.ws): SettingsRow | undefined {
    return rows.get<SettingsRow>("community_settings", { org_id: orgId });
  }

  /** The starting channel if it can still be one (archived or made private: none). */
  private liveStartChannel(r: SettingsRow | undefined, orgId: string): string | null {
    const id = r?.start_channel_id ?? null;
    return id && suitableStartChannel(this.ctx, this.ctx.authz.conversation(id), orgId) ? id : null;
  }

  finishedAt(orgId: string, userId: string): number | null {
    return this.ctx.ws.get<{ finished_at: number }>("onboarding_completions", { org_id: orgId, user_id: userId })?.finished_at ?? null;
  }

  /**
   * Whether [userId] must finish [orgId]'s onboarding before posting or reacting: only plain members who joined after
   * "must finish" was turned on, while onboarding asks questions. Owners, admins, guests, editors and bots never must.
   */
  mustFinish(orgId: string, userId: string): boolean {
    if (!this.enabled) return false;
    const r = this.row(orgId);
    if (!r?.onboarding_required || r.onboarding_required_since === null) return false;
    const m = this.ctx.ws.get<{ role: string; joined_at: number }>("org_members", { org_id: orgId, user_id: userId });
    if (!m || m.role !== "MEMBER" || m.joined_at < r.onboarding_required_since) return false;
    if (this.ctx.authz.can(orgId, userId, "workspace.edit") || !onboardingOn(this.ctx, orgId)) return false;
    return this.finishedAt(orgId, userId) === null;
  }

  status(orgId: string, userId: string): z.infer<typeof OnboardingStatus> {
    const r = this.row(orgId);
    const finishedAt = this.finishedAt(orgId, userId);
    return {
      onboardingRequired: !!r?.onboarding_required,
      onboardingDone: finishedAt !== null,
      finishedAt,
      startChannelId: this.liveStartChannel(r, orgId),
      mustFinishOnboarding: this.mustFinish(orgId, userId),
    };
  }

  /** The look and links anyone who may see the community sees (invite preview); nothing while the feature is off. */
  profile(orgId: string): { background?: string | null; links?: Link[] } {
    if (!this.enabled) return {};
    const r = this.row(orgId);
    return { background: r?.background ?? null, links: r ? parseLinks(r.links) : [] };
  }

  /** What community views carry: the profile and custom invite link, and for members their onboarding. */
  summary(orgId: string, userId: string, member: boolean): Record<string, unknown> {
    if (!this.enabled) return {};
    const base = { ...this.profile(orgId), inviteSlug: inviteSlugOf(this.ctx.ws, orgId) };
    if (!member) return base;
    const s = this.status(orgId, userId);
    return { ...base, voiceClips: this.clipsAllowed(orgId), onboardingRequired: s.onboardingRequired, onboardingDone: s.onboardingDone, startChannelId: s.startChannelId, mustFinishOnboarding: s.mustFinishOnboarding };
  }

  clipsPolicyKey(orgId: string): string {
    return `community.voice_clips.block:${orgId}`;
  }

  clipsPolicy(orgId: string) {
    const requested = this.row(orgId)?.voice_clips === 1;
    const blocked = communityClipsBlocked(this.ctx.platform, orgId);
    return { requested, blocked, available: this.enabled, effective: this.enabled && requested && !blocked };
  }

  clipsAllowed(orgId: string): boolean {
    return this.clipsPolicy(orgId).effective;
  }

  view(orgId: string): z.infer<typeof CommunitySettingsView> {
    const org = this.ctx.ws.get<{ name: string; accent: string | null }>("orgs", { id: orgId })!;
    const r = this.row(orgId);
    return {
      name: org.name,
      voiceClips: this.clipsAllowed(orgId),
      accent: org.accent ?? null,
      background: r?.background ?? null,
      links: r ? parseLinks(r.links) : [],
      inviteSlug: inviteSlugOf(this.ctx.ws, orgId),
      inviteSlugMinMembers: INVITE_SLUG_MIN_MEMBERS,
      memberCount: this.ctx.ws.count("org_members", { org_id: orgId }),
      onboardingRequired: !!r?.onboarding_required,
      onboardingRequiredSince: r?.onboarding_required_since ?? null,
      startChannelId: r?.start_channel_id ?? null,
      updatedAt: r?.updated_at ?? null,
    };
  }

  /** The slug [body] asks for, checked (null: free it; undefined: unchanged or the same as now). */
  private wantedSlug(orgId: string, body: Body): string | null | undefined {
    if (body.inviteSlug === undefined) return undefined;
    if (body.inviteSlug === null || body.inviteSlug === "") return inviteSlugOf(this.ctx.ws, orgId) ? null : undefined;
    const slug = normalizeInviteSlug(body.inviteSlug);
    if (slug === inviteSlugOf(this.ctx.ws, orgId)) return undefined;
    const members = this.ctx.ws.count("org_members", { org_id: orgId });
    if (members < INVITE_SLUG_MIN_MEMBERS) {
      throw new ApiError(403, "invite_slug_needs_members", `A custom invite link opens up once the community has ${INVITE_SLUG_MIN_MEMBERS} members`, { minMembers: INVITE_SLUG_MIN_MEMBERS, members });
    }
    requireSlugFree(this.ctx.ws, orgId, slug);
    return slug;
  }

  /** Checks everything [body] sets before anything is written. */
  private validate(orgId: string, body: Body): { slug: string | null | undefined } {
    if (body.startChannelId && !suitableStartChannel(this.ctx, this.ctx.authz.conversation(body.startChannelId), orgId)) {
      throw new ApiError(400, "start_channel_invalid", "Pick a text channel of this community that everyone can see", { channelId: body.startChannelId });
    }
    return { slug: this.wantedSlug(orgId, body) };
  }

  /** The settings row [body] leads to ("must finish" remembers when it was last turned on). */
  private nextRow(orgId: string, actorId: string, body: Body, t: number, rows: RowReader): SettingsRow {
    const r = this.row(orgId, rows);
    const required = body.onboardingRequired ?? !!r?.onboarding_required;
    const turnedOn = required && !r?.onboarding_required;
    return {
      org_id: orgId,
      background: body.background === undefined ? (r?.background ?? null) : (body.background?.toLowerCase() ?? null),
      voice_clips: body.voiceClips === undefined ? (r?.voice_clips ?? 0) : Number(body.voiceClips),
      links: body.links === undefined ? (r?.links ?? "[]") : JSON.stringify(body.links.map((l) => ({ label: l.label, url: l.url }))),
      onboarding_required: required ? 1 : 0,
      onboarding_required_since: turnedOn ? t : (r?.onboarding_required_since ?? null),
      start_channel_id: body.startChannelId === undefined ? (r?.start_channel_id ?? null) : body.startChannelId,
      updated_at: t,
      updated_by: actorId,
    };
  }

  /** The names of the fields [body] changes, for the audit log. */
  private changed(orgId: string, body: Body, next: SettingsRow, slug: string | null | undefined, rows: RowReader): string[] {
    const org = rows.get<{ name: string; accent: string | null }>("orgs", { id: orgId })!;
    const r = this.row(orgId, rows);
    const out: string[] = [];
    if (body.name !== undefined && body.name !== org.name) out.push("name");
    if (body.accent !== undefined && (body.accent?.toLowerCase() ?? null) !== (org.accent ?? null)) out.push("accent");
    if (next.background !== (r?.background ?? null)) out.push("background");
    if (next.voice_clips !== (r?.voice_clips ?? 0)) out.push("voiceClips");
    if (next.links !== (r?.links ?? "[]")) out.push("links");
    if (slug !== undefined) out.push("inviteSlug");
    if (next.onboarding_required !== (r?.onboarding_required ?? 0)) out.push("onboardingRequired");
    if (next.start_channel_id !== (r?.start_channel_id ?? null)) out.push("startChannelId");
    return out;
  }

  /** Applies [body] in one write unit (the caller checked the permission); the fields that changed. */
  async update(orgId: string, actorId: string, body: Body): Promise<{ changed: string[]; slug: string | null | undefined }> {
    const { slug } = this.validate(orgId, body);
    const t = this.clock();
    return this.ctx.ws.write((w) => {
      const next = this.nextRow(orgId, actorId, body, t, w);
      const changed = this.changed(orgId, body, next, slug, w);
      if (changed.length === 0) return { changed, slug };
      this.writeOrg(w, orgId, body, t);
      w.upsert("community_settings", { ...next }, "replace");
      if (slug === null) releaseInviteSlug(w, orgId, t);
      else if (slug !== undefined) claimInviteSlug(w, orgId, actorId, slug, t);
      return { changed, slug };
    });
  }

  /** The name and accent live on the community itself. */
  private writeOrg(w: RowWriter, orgId: string, body: Body, t: number): void {
    if (body.name === undefined && body.accent === undefined) return;
    const set: Record<string, string | number | null> = { updated_at: t };
    if (body.name !== undefined) set.name = body.name;
    if (body.accent !== undefined) set.accent = body.accent?.toLowerCase() ?? null;
    w.update("orgs", { id: orgId }, set);
  }

  /**
   * [userId] finished onboarding: after the required questions and, when the community asks for it, agreeing to its
   * rules (the flow's order). Finishing again moves the time.
   */
  async finish(orgId: string, userId: string): Promise<void> {
    if (!onboardingOn(this.ctx, orgId)) throw new ApiError(409, "onboarding_off", "This community doesn't ask onboarding questions");
    const missing = unansweredRequiredPrompt(this.ctx, orgId, userId);
    if (missing) throw new ApiError(400, "answer_required", `Answer "${missing.title}"`, { promptId: missing.id });
    if (this.ctx.authz.mustAgreeRules(orgId, userId)) throw new ApiError(403, "rules_not_agreed", "Agree to this community's rules before you post or react", { orgId });
    const t = this.clock();
    await this.ctx.ws.write((w) => w.upsert("onboarding_completions", { org_id: orgId, user_id: userId, finished_at: t }, { finished_at: t }));
  }

  /** The account is deleted: its onboarding completions and standard links' codes (the invitations go with it). */
  async deleteForUser(userId: string): Promise<void> {
    await this.ctx.ws.write((w) => {
      w.delete("onboarding_completions", { user_id: userId });
      w.delete("community_standard_invites", { user_id: userId });
    });
  }

  /** The member left or was removed: rejoining means onboarding again, and their standard link stops. */
  async forgetMember(orgId: string, userId: string): Promise<void> {
    const t = this.clock();
    await this.ctx.ws.write((w) => {
      w.delete("onboarding_completions", { org_id: orgId, user_id: userId });
      const std = w.get<{ invite_id: string }>("community_standard_invites", { org_id: orgId, user_id: userId });
      if (!std) return;
      w.update("invitations", { id: std.invite_id, revoked_at: null }, { revoked_at: t });
      w.delete("community_standard_invites", { org_id: orgId, user_id: userId });
    });
  }
}

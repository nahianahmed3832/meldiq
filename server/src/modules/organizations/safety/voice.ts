import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { namesOf } from "../../accounts/index.js";
import type { VoiceBanView } from "../../../shared/contracts/http/community.js";

interface VoiceBanRow {
  org_id: string;
  user_id: string;
  reason: string | null;
  banned_by: string;
  banned_at: number;
}

interface VoiceMuteRow {
  org_id: string;
  user_id: string;
  muted_by: string;
  muted_at: number;
}

/** The most voice bans one list shows, like the ban list. */
const VOICE_BAN_LIST_MAX = 500;

/**
 * Voice bans and server mutes (community parity A2, docs/COMMUNITY_SAFETY_API.md): community_voice_bans and
 * community_voice_mutes, read synchronously because joining a call and its media token ask them (Authz.canConnectVoice,
 * Authz.canSpeakInVoice). Callers check permissions; [enabled] false (COMMUNITY_SAFETY=off) enforces nothing.
 */
export class VoiceModeration {
  constructor(
    private readonly ctx: AppContext,
    private readonly enabled: boolean,
  ) {}

  banned(orgId: string, userId: string): boolean {
    return this.enabled && !!this.ctx.ws.get("community_voice_bans", { org_id: orgId, user_id: userId });
  }

  muted(orgId: string, userId: string): boolean {
    return this.enabled && !!this.ctx.ws.get("community_voice_mutes", { org_id: orgId, user_id: userId });
  }

  mutedAt(orgId: string, userId: string): number | null {
    return this.ctx.ws.get<VoiceMuteRow>("community_voice_mutes", { org_id: orgId, user_id: userId })?.muted_at ?? null;
  }

  /** The community's voice bans, newest first, with names (a ban of someone unknown here isn't listed). */
  bans(orgId: string): z.infer<typeof VoiceBanView>[] {
    const rows = this.ctx.ws.all<VoiceBanRow>("community_voice_bans", { where: { org_id: orgId }, orderBy: [["banned_at", "desc"]] });
    const ids = [...new Set([...rows.map((b) => b.user_id), ...rows.map((b) => b.banned_by)])];
    const people = new Map(namesOf(this.ctx.identity, ids).map((u) => [u.id, u]));
    return rows
      .flatMap((b) => {
        const u = people.get(b.user_id);
        if (!u) return [];
        return [{ userId: b.user_id, displayName: u.displayName, username: u.username, reason: b.reason, bannedAt: b.banned_at, bannedBy: b.banned_by, bannedByName: people.get(b.banned_by)?.displayName ?? null }];
      })
      .slice(0, VOICE_BAN_LIST_MAX);
  }

  /** Bans [userId] from voice (again: the reason is replaced, the first time kept). */
  async ban(orgId: string, userId: string, actorId: string, reason: string | null, at: number): Promise<void> {
    await this.ctx.ws.write((w) => w.upsert("community_voice_bans", { org_id: orgId, user_id: userId, reason, banned_by: actorId, banned_at: at }, { reason }));
  }

  /** Whether there was a voice ban to lift. */
  async unban(orgId: string, userId: string): Promise<boolean> {
    return (await this.ctx.ws.write((w) => w.delete("community_voice_bans", { org_id: orgId, user_id: userId }))) > 0;
  }

  /** Mutes or unmutes; whether anything changed. */
  async setMuted(orgId: string, userId: string, muted: boolean, actorId: string, at: number): Promise<boolean> {
    if (muted === !!this.mutedAt(orgId, userId)) return false;
    await this.ctx.ws.write((w) => {
      if (muted) w.insert("community_voice_mutes", { org_id: orgId, user_id: userId, muted_by: actorId, muted_at: at }, { orIgnore: true });
      else w.delete("community_voice_mutes", { org_id: orgId, user_id: userId });
    });
    return true;
  }

  /** A server mute ends when the person leaves the community; a voice ban stays, like a ban. */
  async forgetMember(orgId: string, userId: string): Promise<void> {
    if (this.mutedAt(orgId, userId) === null) return;
    await this.ctx.ws.write((w) => w.delete("community_voice_mutes", { org_id: orgId, user_id: userId }));
  }

  async removeOrg(orgId: string): Promise<void> {
    await this.ctx.ws.write((w) => {
      w.delete("community_voice_bans", { org_id: orgId });
      w.delete("community_voice_mutes", { org_id: orgId });
    });
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.ctx.ws.write((w) => {
      w.delete("community_voice_bans", { user_id: userId });
      w.delete("community_voice_mutes", { user_id: userId });
    });
  }
}

import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { RulesBody, RulesSummary, RulesView } from "../../../shared/contracts/http/communityRules.js";
import { ApiError, badRequest } from "../../../shared/errors.js";
import { newId, now } from "../../../shared/utilities/util.js";
import type { ConversationRow } from "../authz.js";
import type { RulesStore, StoredAgreement, StoredRule, StoredRules } from "./store.js";

/** The longest plain-text copy of the rules kept on the community (orgs.rules, read by older apps and the preview). */
const PLAIN_RULES_MAX = 4000;
const RULE_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** The numbered rules as plain text: "1. Title" then the description, a blank line between rules. */
export function plainRules(rules: readonly StoredRule[]): string {
  const text = rules.map((r, i) => (r.description ? `${i + 1}. ${r.title}\n${r.description}` : `${i + 1}. ${r.title}`)).join("\n\n");
  return text.length > PLAIN_RULES_MAX ? `${text.slice(0, PLAIN_RULES_MAX - 1).trimEnd()}…` : text;
}

/** A channel that can be the rules channel: a live text or announcement channel of [orgId] that isn't private. */
export function suitableRulesChannel(conv: ConversationRow | undefined, orgId: string): boolean {
  return !!conv && conv.type === "CHANNEL" && conv.org_id === orgId && !conv.archived_at && conv.voice !== 1 && (conv.format ?? "text") === "text" && (conv.kind === "PUBLIC" || conv.kind === "ANNOUNCEMENT");
}

const agreementKey = (orgId: string, userId: string) => `${orgId}|${userId}`;

/**
 * A community's rules channel and rules (API 0.65.0, feature "rules-channel", docs/SETTINGS_PARITY_API.md). Reads come
 * from this in-memory copy, because posting is checked synchronously (Authz.canPost, admitConversation); every change
 * goes to the store first. With COMMUNITY_RULES=off the routes answer 503 and nothing is enforced.
 */
export class CommunityRules {
  private readonly byOrg = new Map<string, StoredRules>();
  private readonly agreed = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    readonly store: RulesStore,
    readonly enabled: boolean,
    private readonly clock: () => number = now,
  ) {}

  async load(): Promise<void> {
    for (const r of await this.store.all()) this.byOrg.set(r.orgId, r);
    for (const a of await this.store.agreements()) this.agreed.set(agreementKey(a.orgId, a.userId), a.agreedAt);
  }

  /** Throws 503 while the feature is switched off. */
  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Community rules are switched off for now. Try again later.");
  }

  /** The stored rules channel of [orgId] (it may since have been archived: callers compare with a live channel). */
  channelIdOf(orgId: string): string | null {
    return this.enabled ? (this.byOrg.get(orgId)?.channelId ?? null) : null;
  }

  /** The rules channel if it's still a channel that can be one. */
  private liveChannel(orgId: string): string | null {
    const id = this.channelIdOf(orgId);
    return id && suitableRulesChannel(this.ctx.authz.conversation(id), orgId) ? id : null;
  }

  agreedAt(orgId: string, userId: string): number | null {
    return this.agreed.get(agreementKey(orgId, userId)) ?? null;
  }

  /** Whether [userId] has to agree before posting or reacting in [orgId]: not people who can edit the community. */
  mustAgree(orgId: string, userId: string): boolean {
    if (!this.enabled) return false;
    const r = this.byOrg.get(orgId);
    if (!r?.required || r.rules.length === 0) return false;
    if (!this.ctx.authz.orgRole(orgId, userId) || this.ctx.authz.can(orgId, userId, "workspace.edit")) return false;
    return this.agreedAt(orgId, userId) === null;
  }

  view(orgId: string, userId: string): z.infer<typeof RulesView> {
    const r = this.byOrg.get(orgId);
    return {
      channelId: this.liveChannel(orgId),
      required: !!r?.required,
      rules: (r?.rules ?? []).map((x) => ({ ...x })),
      updatedAt: r?.updatedAt ?? null,
      agreedAt: this.agreedAt(orgId, userId),
      mustAgree: this.mustAgree(orgId, userId),
    };
  }

  /** What community views carry: absent while the feature is off or the community has neither a channel nor rules. */
  summary(orgId: string, userId: string): { rulesChannel?: z.infer<typeof RulesSummary> } {
    const r = this.enabled ? this.byOrg.get(orgId) : undefined;
    if (!r || (!r.channelId && r.rules.length === 0)) return {};
    return { rulesChannel: { channelId: this.liveChannel(orgId), required: r.required, count: r.rules.length, agreedAt: this.agreedAt(orgId, userId), mustAgree: this.mustAgree(orgId, userId) } };
  }

  /**
   * Sets everything at once (the caller checked the permission). The channel must suit; turning "must agree" on needs a
   * rule. The rules are also kept as plain text on the community, for the preview and for apps that only know that.
   */
  async set(orgId: string, actorId: string, body: z.infer<typeof RulesBody>): Promise<{ before: StoredRules | undefined; after: StoredRules }> {
    if (body.channelId && !suitableRulesChannel(this.ctx.authz.conversation(body.channelId), orgId)) {
      throw new ApiError(400, "rules_channel_invalid", "Pick a text or announcement channel of this community that everyone can see", { channelId: body.channelId });
    }
    if (body.required && body.rules.length === 0) throw badRequest("Add a rule before asking members to agree");
    const seen = new Set<string>();
    const rules: StoredRule[] = body.rules.map((x) => {
      const id = x.id && RULE_ID.test(x.id) && !seen.has(x.id) ? x.id : newId("rule");
      seen.add(id);
      return { id, title: x.title, description: x.description || null };
    });
    const before = this.byOrg.get(orgId);
    const after: StoredRules = { orgId, channelId: body.channelId, required: body.required, rules, updatedAt: this.clock(), updatedBy: actorId };
    await this.store.put(after);
    this.byOrg.set(orgId, after);
    await this.keepPlainCopy(orgId, before?.rules ?? [], rules);
    return { before, after };
  }

  /** orgs.rules follows the list; once the list is emptied, a copy this service wrote is cleared (other text is kept). */
  private async keepPlainCopy(orgId: string, before: readonly StoredRule[], after: readonly StoredRule[]): Promise<void> {
    const current = this.ctx.ws.get<{ rules: string | null }>("orgs", { id: orgId })?.rules ?? null;
    const next = after.length > 0 ? plainRules(after) : before.length > 0 && current === plainRules(before) ? null : current;
    if (next !== current) await this.ctx.ws.write((w) => w.update("orgs", { id: orgId }, { rules: next }));
  }

  /** [userId] agrees; agreeing again keeps the first time. Whether it was new. */
  async agree(orgId: string, userId: string): Promise<boolean> {
    if (this.agreedAt(orgId, userId) !== null) return false;
    const a: StoredAgreement = { orgId, userId, agreedAt: this.clock() };
    // false when the store had one already (a retry that raced): either way the member has agreed.
    const added = await this.store.agree(a);
    this.agreed.set(agreementKey(orgId, userId), a.agreedAt);
    return added;
  }

  /** The member left or was removed: rejoining means agreeing again. */
  async forgetMember(orgId: string, userId: string): Promise<void> {
    if (!this.agreed.has(agreementKey(orgId, userId))) return;
    await this.store.forget(orgId, userId);
    this.agreed.delete(agreementKey(orgId, userId));
  }

  async removeOrg(orgId: string): Promise<void> {
    await this.store.removeOrg(orgId);
    this.byOrg.delete(orgId);
    for (const k of [...this.agreed.keys()]) if (k.startsWith(`${orgId}|`)) this.agreed.delete(k);
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.store.deleteForUser(userId);
    for (const k of [...this.agreed.keys()]) if (k.endsWith(`|${userId}`)) this.agreed.delete(k);
  }
}

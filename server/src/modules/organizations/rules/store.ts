/** One rule in a community's numbered list. */
export interface StoredRule {
  id: string;
  title: string;
  description: string | null;
}

/** A community's rules channel, its rules, and whether members must agree to them. */
export interface StoredRules {
  orgId: string;
  channelId: string | null;
  required: boolean;
  rules: StoredRule[];
  updatedAt: number;
  updatedBy: string;
}

/** A member agreed to [orgId]'s rules at [agreedAt]. */
export interface StoredAgreement {
  orgId: string;
  userId: string;
  agreedAt: number;
}

/**
 * Where community rules are kept (API 0.65.0, docs/SETTINGS_PARITY_API.md): MongoDB whenever the server has one
 * (`community_rules` and `community_rule_agreements`: new data goes to MongoDB), otherwise this process's memory.
 * CommunityRules keeps an in-memory copy of everything for the request path (posting is checked synchronously).
 */
export interface RulesStore {
  readonly backend: "memory" | "mongodb";
  all(): Promise<StoredRules[]>;
  agreements(): Promise<StoredAgreement[]>;
  put(r: StoredRules): Promise<void>;
  /** The community is gone: its rules and everyone's agreements. */
  removeOrg(orgId: string): Promise<void>;
  /** Records [a] unless the member agreed before; whether it was new. */
  agree(a: StoredAgreement): Promise<boolean>;
  /** The member left (or was removed): their agreement goes with them. */
  forget(orgId: string, userId: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

const key = (orgId: string, userId: string) => `${orgId}|${userId}`;
const copyRules = (r: StoredRules): StoredRules => ({ ...r, rules: r.rules.map((x) => ({ ...x })) });

export class MemoryRulesStore implements RulesStore {
  readonly backend = "memory" as const;
  private readonly byOrg = new Map<string, StoredRules>();
  private readonly agreed = new Map<string, StoredAgreement>();

  async all(): Promise<StoredRules[]> {
    return [...this.byOrg.values()].map(copyRules);
  }

  async agreements(): Promise<StoredAgreement[]> {
    return [...this.agreed.values()].map((a) => ({ ...a }));
  }

  async put(r: StoredRules): Promise<void> {
    this.byOrg.set(r.orgId, copyRules(r));
  }

  async removeOrg(orgId: string): Promise<void> {
    this.byOrg.delete(orgId);
    for (const [k, a] of this.agreed) if (a.orgId === orgId) this.agreed.delete(k);
  }

  async agree(a: StoredAgreement): Promise<boolean> {
    const k = key(a.orgId, a.userId);
    if (this.agreed.has(k)) return false;
    this.agreed.set(k, { ...a });
    return true;
  }

  async forget(orgId: string, userId: string): Promise<void> {
    this.agreed.delete(key(orgId, userId));
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const [k, a] of this.agreed) if (a.userId === userId) this.agreed.delete(k);
  }
}

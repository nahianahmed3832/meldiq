import type { GroupAddPolicy } from "../../../shared/contracts/http/relationships.js";

/** API 0.65.0: who may add someone to group chats, and whether they're suggested to people they share communities with. */
export interface PrivacyChoices {
  groupAddPolicy: GroupAddPolicy;
  suggestable: boolean;
}

/**
 * Where these choices are kept (docs/SETTINGS_PARITY_API.md): MongoDB whenever the server has one (`privacy_settings`,
 * new data goes to MongoDB), otherwise this process's memory (development and tests without MONGODB_URI). They sit
 * beside messaging_settings rather than in it, so that table and its MongoDB validator stay as they are.
 */
export interface PrivacyStore {
  readonly backend: "memory" | "mongodb" | "postgres";
  /** The person's own choices, or null when they never chose (defaults apply: rules.ts privacyChoicesOf). */
  get(userId: string): Promise<PrivacyChoices | null>;
  /** The choices of those of [userIds] who made any. */
  many(userIds: readonly string[]): Promise<Map<string, PrivacyChoices>>;
  put(userId: string, choices: PrivacyChoices, at: number): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

export class MemoryPrivacyStore implements PrivacyStore {
  readonly backend = "memory" as const;
  private readonly rows = new Map<string, PrivacyChoices>();

  async get(userId: string): Promise<PrivacyChoices | null> {
    const c = this.rows.get(userId);
    return c ? { ...c } : null;
  }

  async many(userIds: readonly string[]): Promise<Map<string, PrivacyChoices>> {
    return new Map(userIds.flatMap((id) => (this.rows.has(id) ? [[id, { ...this.rows.get(id)! }] as const] : [])));
  }

  async put(userId: string, choices: PrivacyChoices): Promise<void> {
    this.rows.set(userId, { ...choices });
  }

  async deleteForUser(userId: string): Promise<void> {
    this.rows.delete(userId);
  }
}

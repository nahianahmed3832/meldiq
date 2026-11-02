import type { DB } from "../../../infrastructure/database/db.js";
import { type NavPrefs, type StoredPrefs, zNavPrefs } from "./schema.js";

/** Outcome of a conditional write: the new document, or the current one when [baseRev] was stale. */
export type PrefsWrite = { ok: true; doc: StoredPrefs } | { ok: false; current: StoredPrefs | null };

/**
 * Where personal navigation preferences live: SQLite (migration 015) or MongoDB (src/mongo/preferences.ts), chosen by
 * MONGODB_DOMAINS. Async so both look the same to the routes.
 */
export interface PreferenceStore {
  readonly backend: "sqlite" | "mongodb" | "postgres";
  get(userId: string, workspaceId: string): Promise<StoredPrefs | null>;
  /**
   * Writes [prefs] only if the stored revision is still [baseRev] (0: nothing stored yet). Revisions only go up, so two
   * devices writing at once never silently overwrite each other: the second gets the current document back.
   */
  put(userId: string, workspaceId: string, prefs: NavPrefs, baseRev: number, at: number): Promise<PrefsWrite>;
  /** Someone left or was removed from an organisation: their arrangement of it goes too. */
  deleteForMember(userId: string, workspaceId: string): Promise<void>;
  /** An organisation was deleted. */
  deleteForWorkspace(workspaceId: string): Promise<void>;
  /** A person's identity was deleted. */
  deleteForUser(userId: string): Promise<void>;
}

interface Row {
  user_id: string;
  workspace_id: string;
  doc: string;
  rev: number;
  updated_at: number;
}

/** Stored documents were validated on the way in; a row that no longer parses reads as empty rather than failing. */
function fromRow(r: Row): StoredPrefs {
  const parsed = zNavPrefs.safeParse(JSON.parse(r.doc));
  const prefs = parsed.success ? parsed.data : { starred: [], sections: [], collapsed: [], notify: {}, saved: [] };
  return { userId: r.user_id, workspaceId: r.workspace_id, prefs, rev: r.rev, updatedAt: r.updated_at };
}

export class SqlitePreferenceStore implements PreferenceStore {
  readonly backend = "sqlite" as const;
  constructor(private readonly db: DB) {}

  async get(userId: string, workspaceId: string): Promise<StoredPrefs | null> {
    const r = this.db.prepare("SELECT * FROM nav_preferences WHERE user_id = ? AND workspace_id = ?").get(userId, workspaceId) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  async put(userId: string, workspaceId: string, prefs: NavPrefs, baseRev: number, at: number): Promise<PrefsWrite> {
    const doc = JSON.stringify(prefs);
    // One synchronous transaction: the check and the write can't interleave with another request.
    return this.db.transaction((): PrefsWrite => {
      const current = this.db.prepare("SELECT * FROM nav_preferences WHERE user_id = ? AND workspace_id = ?").get(userId, workspaceId) as Row | undefined;
      if ((current?.rev ?? 0) !== baseRev) return { ok: false, current: current ? fromRow(current) : null };
      const rev = baseRev + 1;
      this.db
        .prepare(
          `INSERT INTO nav_preferences (user_id, workspace_id, doc, rev, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, workspace_id) DO UPDATE SET doc = excluded.doc, rev = excluded.rev, updated_at = excluded.updated_at`,
        )
        .run(userId, workspaceId, doc, rev, at);
      return { ok: true, doc: { userId, workspaceId, prefs, rev, updatedAt: at } };
    })();
  }

  async deleteForMember(userId: string, workspaceId: string): Promise<void> {
    this.db.prepare("DELETE FROM nav_preferences WHERE user_id = ? AND workspace_id = ?").run(userId, workspaceId);
  }

  async deleteForWorkspace(workspaceId: string): Promise<void> {
    this.db.prepare("DELETE FROM nav_preferences WHERE workspace_id = ?").run(workspaceId);
  }

  async deleteForUser(userId: string): Promise<void> {
    this.db.prepare("DELETE FROM nav_preferences WHERE user_id = ?").run(userId);
  }
}

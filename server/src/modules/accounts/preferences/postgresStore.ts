import type { MeldiqPostgres } from "../../../infrastructure/database/postgres/client.js";
import { type NavPrefs, type StoredPrefs, zNavPrefs } from "./schema.js";
import type { PreferenceStore, PrefsWrite } from "./store.js";

interface PreferenceRow { user_id: string; workspace_id: string; doc: string; rev: number; updated_at: number }

/** Optimistic revision checks happen in SQL, including concurrent first writes from different devices. */
export class PostgresPreferenceStore implements PreferenceStore {
  readonly backend = "postgres" as const;
  constructor(private readonly db: MeldiqPostgres) {}
  async get(userId: string, workspaceId: string): Promise<StoredPrefs | null> {
    const row = (await this.db.query<PreferenceRow>("SELECT * FROM meldiq.nav_preferences WHERE user_id=$1 AND workspace_id=$2", [userId, workspaceId])).rows[0];
    return row ? decode(row) : null;
  }
  async put(userId: string, workspaceId: string, prefs: NavPrefs, baseRev: number, at: number): Promise<PrefsWrite> {
    if (!Number.isSafeInteger(baseRev) || baseRev < 0 || baseRev >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid preference revision");
    const params = [userId, workspaceId, JSON.stringify(prefs), baseRev + 1, at];
    const result = baseRev === 0
      ? await this.db.query<PreferenceRow>(`INSERT INTO meldiq.nav_preferences(user_id,workspace_id,doc,rev,updated_at)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,workspace_id) DO NOTHING RETURNING *`, params)
      : await this.db.query<PreferenceRow>(`UPDATE meldiq.nav_preferences SET doc=$3,rev=$4,updated_at=$5
          WHERE user_id=$1 AND workspace_id=$2 AND rev=$6 RETURNING *`, [...params, baseRev]);
    return result.rows[0] ? {ok: true, doc: decode(result.rows[0])} : {ok: false, current: await this.get(userId, workspaceId)};
  }
  async deleteForMember(userId: string, workspaceId: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.nav_preferences WHERE user_id=$1 AND workspace_id=$2", [userId, workspaceId]);
  }
  async deleteForWorkspace(workspaceId: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.nav_preferences WHERE workspace_id=$1", [workspaceId]);
  }
  async deleteForUser(userId: string): Promise<void> {
    await this.db.query("DELETE FROM meldiq.nav_preferences WHERE user_id=$1", [userId]);
  }
}

function decode(row: PreferenceRow): StoredPrefs {
  let data: unknown;
  try { data = JSON.parse(row.doc); } catch { data = null; }
  const parsed = zNavPrefs.safeParse(data);
  return {userId: row.user_id, workspaceId: row.workspace_id, prefs: parsed.success ? parsed.data : zNavPrefs.parse({}), rev: row.rev, updatedAt: row.updated_at};
}

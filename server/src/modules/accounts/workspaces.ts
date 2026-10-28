import type { AppContext } from "../../app/context.js";
import type { OrgRole } from "../organizations/authz.js";
import { ApiError } from "../../shared/errors.js";
import { now } from "../../shared/utilities/util.js";
import { compareText, foldAscii } from "../../shared/utilities/sqlText.js";
import type { AccountStore, AccountRow } from "./store.js";

/** The workspace every account has: DMs, groups and contacts outside any organisation (audit C6). */
export const PERSONAL_WORKSPACE_ID = "personal";

export interface WorkspaceView {
  id: string;
  kind: "personal" | "organization";
  name: string;
  role: OrgRole;
  slug: string | null;
  /** The organisation's avatar revision (GET /v1/orgs/:id/photo); null for the personal workspace or no avatar. */
  photoRev: number | null;
}

/**
 * The workspaces an account can switch between (docs/ORBIT_2_ARCHITECTURE §4): its personal workspace and every
 * organisation its encryption identity is a member of. Which one is open is remembered on the account so all its devices
 * agree; switching grants nothing, since every request is still checked by authz.ts.
 */
export class WorkspaceService {
  constructor(
    private readonly ctx: AppContext,
    private readonly store: AccountStore,
  ) {}

  list(a: AccountRow): { workspaces: WorkspaceView[]; selectedWorkspaceId: string } {
    const personal: WorkspaceView = { id: PERSONAL_WORKSPACE_ID, kind: "personal", name: "Personal", role: "OWNER", slug: null, photoRev: null };
    const orgs = a.user_id ? this.orgsOf(a.user_id) : [];
    const workspaces = [personal, ...orgs.map((o): WorkspaceView => ({ id: o.id, kind: "organization", name: o.name, role: o.role, slug: o.slug, photoRev: o.photo_rev }))];
    // A remembered organisation the person has left (or that was deleted) falls back to the personal workspace.
    const selected = workspaces.some((w) => w.id === a.selected_workspace_id) ? a.selected_workspace_id! : PERSONAL_WORKSPACE_ID;
    return { workspaces, selectedWorkspaceId: selected };
  }

  /** The organisations [userId] is in with their role there, by name (ASCII case ignored). */
  private orgsOf(userId: string): { id: string; name: string; slug: string; photo_rev: number | null; role: OrgRole }[] {
    const roles = new Map(this.ctx.ws.all<{ org_id: string; role: OrgRole }>("org_members", { where: { user_id: userId } }).map((m) => [m.org_id, m.role]));
    return this.ctx.ws
      .all<{ id: string; name: string; slug: string; photo_rev: number | null }>("orgs", { where: { id: { in: [...roles.keys()] } } })
      .sort((x, y) => compareText(foldAscii(x.name), foldAscii(y.name)))
      .map((o) => ({ id: o.id, name: o.name, slug: o.slug, photo_rev: o.photo_rev, role: roles.get(o.id)! }));
  }

  async select(a: AccountRow, workspaceId: string): Promise<string> {
    const member = workspaceId === PERSONAL_WORKSPACE_ID || (!!a.user_id && !!this.ctx.authz.orgRole(workspaceId, a.user_id));
    // Same answer for an organisation that doesn't exist and one the person isn't in.
    if (!member) throw new ApiError(404, "workspace_not_found", "Workspace not found");
    await this.store.updateAccount(a.id, { selected_workspace_id: workspaceId }, now());
    return workspaceId;
  }
}

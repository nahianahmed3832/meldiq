import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateBranchesAndTeams, verifyCommunityMigration } from "../src/modules/organizations/communityMigration.js";
import { newId } from "../src/shared/utilities/util.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Branches and teams become roles and categories (docs/COMMUNITY_REBUILD_2026-10-21.md §6). The legacy rows are written
 * the way the old server wrote them, then converted, then checked: nobody gains or loses a channel, the people who ran
 * a branch or team still manage its channels, invitations grant the role, and running it again changes nothing.
 */
let h: Harness;
let owner: GriipClient, branchManager: GriipClient, branchMember: GriipClient, lead: GriipClient, teamMember: GriipClient, other: GriipClient, teamsManager: GriipClient, guest: GriipClient;
let org: string, branch: string, team: string, crossTeam: string, archivedTeam: string;
let branchChannel: string, teamChannel: string, teamPrivate: string, crossChannel: string, archivedChannel: string, inviteId: string;

// A one-off conversion of SQLite data (src/admin.ts refuses it once the workspace domain is in MongoDB).
const sqliteWorkspace = !(process.env.MELDIQ_TEST_MONGO_DOMAINS ?? "").split(",").includes("workspace");

const ids = async (c: GriipClient) => ((await c.req("GET", "/v1/conversations")).conversations as { id: string }[]).map((x) => x.id);

beforeAll(async () => {
  if (!sqliteWorkspace) return;
  h = await startServer();
  owner = await h.client("mowner");
  branchManager = await h.client("mbranchmgr");
  branchMember = await h.client("mbranchmember");
  lead = await h.client("mlead");
  teamMember = await h.client("mteammember");
  other = await h.client("mother");
  teamsManager = await h.client("mteamsmgr");
  guest = await h.client("mguest");
  org = (await owner.req("POST", "/v1/orgs", { name: "Legacy Corp" })).org.id;

  const db = h.ctx.db;
  const t = Date.now();
  const addMember = (u: GriipClient, role: string) => db.prepare("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(org, u.userId, role, t);
  for (const u of [branchManager, branchMember, lead, teamMember, other, teamsManager]) addMember(u, "MEMBER");
  addMember(guest, "GUEST");
  // A custom role holding the retired teams.manage power, as stored before the rebuild.
  const legacyRole = newId("role");
  db.prepare(
    `INSERT INTO org_roles (id, org_id, name, description, color, icon, permissions, denies, template, position, rev, created_by, created_at, updated_at)
     VALUES (?, ?, 'Project Manager', NULL, NULL, 'briefcase', '["teams.create","teams.manage","channels.create"]', '[]', 'project_manager', 0, 1, ?, ?, ?)`,
  ).run(legacyRole, org, owner.userId, t, t);
  db.prepare("INSERT INTO org_role_members (role_id, org_id, user_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?)").run(legacyRole, org, teamsManager.userId, owner.userId, t);

  branch = newId("b");
  db.prepare("INSERT INTO branches (id, org_id, name, created_at, updated_at) VALUES (?, ?, 'Dhaka', ?, ?)").run(branch, org, t, t);
  for (const [u, r] of [[branchManager, "MANAGER"], [branchMember, "MEMBER"], [lead, "MEMBER"], [teamMember, "MEMBER"]] as const) {
    db.prepare("INSERT INTO branch_members (branch_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(branch, u.userId, r, t);
  }
  team = newId("t");
  crossTeam = newId("t");
  archivedTeam = newId("t");
  db.prepare("INSERT INTO teams (id, org_id, branch_id, name, created_at, updated_at) VALUES (?, ?, ?, 'Support', ?, ?)").run(team, org, branch, t, t);
  db.prepare("INSERT INTO teams (id, org_id, branch_id, name, created_at, updated_at) VALUES (?, ?, NULL, 'Product', ?, ?)").run(crossTeam, org, t, t);
  db.prepare("INSERT INTO teams (id, org_id, branch_id, name, created_at, updated_at, archived_at) VALUES (?, ?, NULL, 'Old project', ?, ?, ?)").run(archivedTeam, org, t, t, t);
  for (const [u, r] of [[lead, "LEAD"], [teamMember, "MEMBER"]] as const) db.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(team, u.userId, r, t);
  db.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)").run(crossTeam, other.userId, t);
  db.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)").run(archivedTeam, other.userId, t);

  const channel = (name: string, scope: string, scopeId: string, kind: string, members: GriipClient[]) => {
    const id = newId("c");
    db.prepare(
      `INSERT INTO conversations (id, type, org_id, scope, scope_id, kind, name, auto_join, created_by, created_at, updated_at) VALUES (?, 'CHANNEL', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, org, scope, scopeId, kind, name, kind === "PRIVATE" ? 0 : 1, owner.userId, t, t);
    for (const u of [owner, ...members]) db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(id, u.userId, u === owner ? "ADMIN" : "MEMBER", t);
    return id;
  };
  branchChannel = channel("dhaka", "BRANCH", branch, "PUBLIC", [branchManager, branchMember, lead, teamMember, teamsManager]);
  teamChannel = channel("support", "TEAM", team, "ANNOUNCEMENT", [branchManager, lead, teamMember, teamsManager]);
  teamPrivate = channel("escalations", "TEAM", team, "PRIVATE", [lead]);
  crossChannel = channel("product", "TEAM", crossTeam, "PUBLIC", [other, teamsManager]);
  archivedChannel = channel("old-project", "TEAM", archivedTeam, "PUBLIC", [other, teamsManager]);
  db.prepare("INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)").run(crossChannel, guest.userId, t);

  inviteId = newId("inv");
  db.prepare(
    `INSERT INTO invitations (id, org_id, code_hash, code_hint, role, branch_id, team_id, max_uses, created_by, created_at, expires_at) VALUES (?, ?, 'h', 'abcd', 'MEMBER', ?, ?, 5, ?, ?, ?)`,
  ).run(inviteId, org, branch, team, owner.userId, t, t + 86_400_000);
});
afterAll(async () => h?.close());

describe.skipIf(!sqliteWorkspace)("branch and team migration", () => {
  it("converts each branch and team into a role with the same people and a category with their channels", () => {
    const r = migrateBranchesAndTeams(h.ctx.db);
    expect(r).toMatchObject({ branches: 1, teams: 3, converted: 4, channels: 5 });
    const roles = h.ctx.db.prepare("SELECT id, name, template FROM org_roles WHERE org_id = ? AND template LIKE 'migrated-%' ORDER BY name").all(org) as { id: string; name: string; template: string }[];
    expect(roles.map((x) => x.name)).toEqual(["Dhaka", "Old project", "Product", "Support"]);
    const support = roles.find((x) => x.name === "Support")!;
    const holders = (h.ctx.db.prepare("SELECT user_id FROM org_role_members WHERE role_id = ?").all(support.id) as { user_id: string }[]).map((x) => x.user_id).sort();
    expect(holders).toEqual([lead.userId, teamMember.userId].sort());
    // Old scope columns stay as they were, so a rolled-back server still reads them.
    expect(h.ctx.db.prepare("SELECT scope, scope_id FROM conversations WHERE id = ?").get(teamChannel)).toEqual({ scope: "TEAM", scope_id: team });
    expect((h.ctx.db.prepare("SELECT grant_role_id FROM invitations WHERE id = ?").get(inviteId) as { grant_role_id: string }).grant_role_id).toBe(support.id);
  });

  it("keeps exactly who can see every channel", () => {
    const diffs = verifyCommunityMigration(h.ctx.db, (c, u) => h.ctx.authz.canViewChannel(h.ctx.authz.conversation(c)!, u));
    expect(diffs).toEqual([]);
  });

  it("removes nobody when memberships are re-checked, and the API agrees", async () => {
    const lost = h.ctx.authz.reconcileCommunity(org, Date.now());
    expect([...lost.entries()]).toEqual([]);
    expect(await ids(teamMember)).toEqual(expect.arrayContaining([branchChannel, teamChannel]));
    expect(await ids(branchMember)).toContain(branchChannel);
    expect(await ids(branchMember)).not.toContain(teamChannel);
    await expectStatus(branchMember.req("GET", `/v1/conversations/${teamChannel}`), 404);
    await expectStatus(other.req("GET", `/v1/conversations/${branchChannel}`), 404);
    // The guest keeps the channel a manager added them to.
    expect(await ids(guest)).toContain(crossChannel);
  });

  it("lets branch managers and team leads keep managing their channels, and nothing else", async () => {
    expect((await branchManager.req("GET", `/v1/conversations/${teamChannel}`)).conversation.canManage).toBe(true);
    expect((await lead.req("GET", `/v1/conversations/${teamChannel}`)).conversation.canManage).toBe(true);
    // An announcement channel: the lead posts as its manager, a plain team member doesn't.
    expect((await lead.req("GET", `/v1/conversations/${teamChannel}`)).conversation.canPost).toBe(true);
    expect((await teamMember.req("GET", `/v1/conversations/${teamChannel}`)).conversation.canPost).toBe(false);
    expect((await lead.req("GET", `/v1/conversations/${branchChannel}`)).conversation.canManage).toBe(false);
    // The Project Manager (retired teams.manage) still sees the cross-branch team's channel.
    expect((await teamsManager.req("GET", `/v1/conversations/${crossChannel}`)).conversation.canManage).toBe(true);
    // A lead can create channels in their team's category.
    const cat = (await lead.req("GET", `/v1/conversations/${teamChannel}`)).conversation.categoryId;
    await lead.req("POST", `/v1/orgs/${org}/channels`, { name: "support-2", categoryId: cat });
    await expectStatus(lead.req("POST", `/v1/orgs/${org}/channels`, { name: "elsewhere" }), 403);
  });

  it("archives the channels of an archived team and leaves private channels private", async () => {
    expect((await other.req("GET", `/v1/conversations/${archivedChannel}`)).conversation.archived).toBe(true);
    expect(await ids(teamMember)).not.toContain(teamPrivate);
    expect(await ids(lead)).toContain(teamPrivate);
  });

  it("does nothing the second time", () => {
    expect(migrateBranchesAndTeams(h.ctx.db)).toMatchObject({ converted: 0 });
  });
});

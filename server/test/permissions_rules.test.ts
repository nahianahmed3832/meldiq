import { describe, expect, it } from "vitest";
import type { OrgRole } from "../src/modules/organizations/authz.js";
import { BASE_ROLE_PERMISSIONS, EVERYDAY_POWERS, type Permission, PERMISSION_KEYS, PERMISSIONS, ROLE_TEMPLATES, permissionDef } from "../src/modules/organizations/permissions/catalog.js";
import { type Actor, canActOn, effectivePermissions, type RoleGrant, roleAssignmentRefusal, roleDefinitionRefusal, roleRemovalRefusal } from "../src/modules/organizations/permissions/rules.js";
import { orgRoleChangeRefusal, removalAllowed, titleChangeAllowed } from "../src/modules/organizations/roleRules.js";

/**
 * The permission catalog and the pure role rules (docs/WORKSPACE_ROLES.md). The app's `RoleRulesTest` mirrors these
 * cases, so the two can't drift silently.
 */
const actor = (base: OrgRole, extra: Permission[] = [], denies: Permission[] = []): Actor => ({ base, perms: effectivePermissions(base, [{ permissions: extra, denies }]) });
const grant = (permissions: Permission[], denies: Permission[] = []): RoleGrant => ({ permissions, denies });
const member = { base: "MEMBER" as OrgRole, perms: BASE_ROLE_PERMISSIONS.MEMBER, self: false };

/** What a guest holds: posting, files and voice, and the everyday message powers (community parity A1). */
const GUEST_SET = ["messages.attach", "messages.post", "voice.connect", "voice.speak", ...EVERYDAY_POWERS].sort();

describe("permission catalog", () => {
  it("has a definition for every key and nothing platform-wide", () => {
    expect(PERMISSIONS.map((p) => p.key)).toEqual([...PERMISSION_KEYS]);
    for (const p of PERMISSIONS) {
      expect(p.label.length).toBeGreaterThan(3);
      expect(p.key.startsWith("platform")).toBe(false);
    }
  });

  it("keeps owner-only powers out of every other base role", () => {
    for (const base of ["ADMIN", "MEMBER", "GUEST"] as OrgRole[]) {
      for (const p of BASE_ROLE_PERMISSIONS[base]) expect([base, p, permissionDef(p).ownerOnly]).toEqual([base, p, false]);
    }
    expect(BASE_ROLE_PERMISSIONS.ADMIN.has("roles.delegate")).toBe(false);
    expect(BASE_ROLE_PERMISSIONS.OWNER.size).toBe(PERMISSION_KEYS.length);
  });

  it("gives members and guests no administrative power by default", () => {
    for (const p of BASE_ROLE_PERMISSIONS.MEMBER) expect([p, permissionDef(p).admin]).toEqual([p, false]);
    // Guests may also join and talk in the voice channels a manager added them to (2026-10-21).
    // Community parity A1: the everyday powers everyone had before they were permissions are in both base sets.
    expect([...BASE_ROLE_PERMISSIONS.GUEST].sort()).toEqual(GUEST_SET);
  });

  it("only uses catalog keys in the starter templates", () => {
    for (const t of ROLE_TEMPLATES) {
      for (const p of [...t.permissions, ...t.denies]) expect(PERMISSION_KEYS).toContain(p);
      for (const p of t.denies) expect(permissionDef(p).restrictable).toBe(true);
    }
  });
});

describe("effective permissions", () => {
  it("adds grants, removes restrictions, and the order of roles never matters", () => {
    const a: RoleGrant = grant(["channels.manage", "messages.announce"]);
    const b: RoleGrant = grant([], ["messages.post"]);
    const c: RoleGrant = grant(["messages.post"]); // a grant never beats a restriction
    const one = effectivePermissions("MEMBER", [a, b, c]);
    const two = effectivePermissions("MEMBER", [c, b, a]);
    expect([...one].sort()).toEqual([...two].sort());
    expect(one.has("channels.manage")).toBe(true);
    expect(one.has("messages.post")).toBe(false);
  });

  it("never grants owner-only powers through a role", () => {
    const p = effectivePermissions("ADMIN", [grant(["workspace.delete", "workspace.transfer"])]);
    expect(p.has("workspace.delete")).toBe(false);
    expect(p.has("workspace.transfer")).toBe(false);
  });

  it("gives guests only what a guest may hold", () => {
    const p = effectivePermissions("GUEST", [grant(["messages.attach", "messages.announce", "channels.manage", "members.remove", "channels.view"])]);
    expect([...p].sort()).toEqual(GUEST_SET);
  });

  it("can't restrict an owner, and restricts only restrictable permissions", () => {
    expect(effectivePermissions("OWNER", [grant([], ["messages.post"])]).has("messages.post")).toBe(true);
    // members.remove isn't restrictable: a stored restriction of it is ignored
    expect(effectivePermissions("ADMIN", [grant([], ["members.remove" as Permission])]).has("members.remove")).toBe(true);
  });
});

describe("defining roles", () => {
  it("needs roles.manage and only the definer's own powers", () => {
    expect(roleDefinitionRefusal(actor("MEMBER"), grant(["messages.announce"]))?.code).toBe("forbidden");
    expect(roleDefinitionRefusal(actor("MEMBER", ["roles.manage"]), grant(["messages.announce"]))?.code).toBe("beyond_your_powers");
    expect(roleDefinitionRefusal(actor("MEMBER", ["roles.manage", "messages.announce"]), grant(["messages.announce"]))).toBeNull();
  });

  it("needs roles.delegate for administrative powers: admins can't make admin-like roles, owners can", () => {
    expect(roleDefinitionRefusal(actor("ADMIN"), grant(["channels.manage"]))?.code).toBe("delegation_required");
    expect(roleDefinitionRefusal(actor("ADMIN"), grant(["messages.announce"]))).toBeNull();
    expect(roleDefinitionRefusal(actor("OWNER"), grant(["channels.manage", "roles.delegate"]))).toBeNull();
  });

  it("refuses owner-only powers, unrestrictable restrictions and grant-and-deny", () => {
    expect(roleDefinitionRefusal(actor("OWNER"), grant(["workspace.transfer"]))?.code).toBe("owner_only");
    expect(roleDefinitionRefusal(actor("OWNER"), grant([], ["members.remove"]))?.code).toBe("not_restrictable");
    expect(roleDefinitionRefusal(actor("OWNER"), grant(["messages.post"], ["messages.post"]))?.code).toBe("grant_and_deny");
  });

  it("won't let anyone edit a role that's already stronger than them", () => {
    const strong = grant(["channels.manage", "members.ban"]);
    expect(roleDefinitionRefusal(actor("ADMIN"), grant(["messages.announce"]), strong)?.code).toBe("delegation_required");
    const delegated = actor("MEMBER", ["roles.manage", "roles.delegate", "channels.manage"]);
    expect(roleDefinitionRefusal(delegated, grant(["channels.manage"]), strong)?.code).toBe("beyond_your_powers");
  });
});

describe("assigning and removing roles", () => {
  it("needs roles.assign and powers the assigner holds", () => {
    expect(roleAssignmentRefusal(actor("MEMBER"), member, grant(["messages.announce"]))?.code).toBe("forbidden");
    expect(roleAssignmentRefusal(actor("ADMIN"), member, grant(["messages.announce"]))).toBeNull();
    expect(roleAssignmentRefusal(actor("ADMIN"), member, grant(["channels.manage"]))?.code).toBe("delegation_required");
    expect(roleAssignmentRefusal(actor("OWNER"), member, grant(["channels.manage"]))).toBeNull();
  });

  it("refuses roles a guest can't hold", () => {
    expect(roleAssignmentRefusal(actor("OWNER"), { ...member, base: "GUEST", perms: BASE_ROLE_PERMISSIONS.GUEST }, grant(["channels.manage"]))?.code).toBe("not_for_guests");
    expect(roleAssignmentRefusal(actor("OWNER"), { ...member, base: "GUEST", perms: BASE_ROLE_PERMISSIONS.GUEST }, grant(["messages.attach"]))).toBeNull();
  });

  it("keeps admins off admins and owners, and everyone off people with powers they lack", () => {
    const admin = { base: "ADMIN" as OrgRole, perms: BASE_ROLE_PERMISSIONS.ADMIN, self: false };
    expect(canActOn(actor("ADMIN"), admin)).toBe(false);
    expect(canActOn(actor("ADMIN"), { ...admin, self: true })).toBe(true);
    expect(canActOn(actor("OWNER"), { ...admin, base: "OWNER" })).toBe(true);
    const coAdmin = { base: "MEMBER" as OrgRole, perms: effectivePermissions("MEMBER", [grant(["roles.delegate", "members.remove"])]), self: false };
    expect(canActOn(actor("ADMIN"), coAdmin)).toBe(false); // holds roles.delegate, which admins don't
    // A restricted admin (no posting) still manages ordinary members.
    expect(canActOn(actor("ADMIN", [], ["messages.post"]), member)).toBe(true);
  });

  it("won't let a restricted person lift their own restriction", () => {
    const readOnly = grant([], ["messages.post"]);
    const me = actor("MEMBER", ["roles.assign"], ["messages.post"]);
    expect(roleRemovalRefusal(me, { base: "MEMBER", perms: me.perms, self: true }, readOnly)?.code).toBe("beyond_your_powers");
    expect(roleRemovalRefusal(actor("ADMIN"), member, readOnly)).toBeNull();
  });
});

describe("base-role rules with delegated permissions", () => {
  it("lets a member with members.roles switch members and guests, but never touch admins", () => {
    const hr = actor("MEMBER", ["members.roles"]);
    expect(orgRoleChangeRefusal(hr, "MEMBER", "GUEST", false, 1)).toBeNull();
    expect(orgRoleChangeRefusal(hr, "MEMBER", "ADMIN", false, 1)?.status).toBe(403);
    expect(orgRoleChangeRefusal(hr, "ADMIN", "MEMBER", false, 1)?.status).toBe(403);
  });

  it("uses members.titles and members.remove for titles and removal", () => {
    expect(titleChangeAllowed(actor("MEMBER", ["members.titles"]), "MEMBER", false)).toBe(true);
    expect(titleChangeAllowed(actor("MEMBER", ["members.titles"]), "ADMIN", false)).toBe(false);
    expect(removalAllowed(actor("MEMBER", ["members.remove"]), "GUEST")).toBe(true);
    expect(removalAllowed(actor("MEMBER", ["members.remove"]), "ADMIN")).toBe(false);
    const coAdminPerms = effectivePermissions("MEMBER", [grant(["roles.delegate"])]);
    expect(removalAllowed("ADMIN", "MEMBER", coAdminPerms)).toBe(false);
  });
});

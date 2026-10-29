# Custom roles and permissions (2026-10-19)

Workspaces define their own roles on top of the protected base roles (Owner, Admin, Member, Guest). A role grants
exactly the permissions it lists; its name grants nothing. Server: `src/permissions/catalog.ts` (the catalog),
`src/permissions/rules.ts` (pure rules), `src/authz.ts` (evaluation), `src/routes/roles.ts` (API). App:
`ui/screens/workspace/roles/` (mirror rules in `RoleEditorRules.kt`, tested against the same cases).

## 1. The catalog

31 permissions in 8 categories, each enforced somewhere on the server: workspace (edit, usage, delete*, transfer*),
members (view, invite, manage invitations, change Member/Guest, titles, remove), roles (view, manage, assign,
delegate), branches and teams (create, manage), channels (create workspace channels, manage any channel, change access),
messaging (post, announce), apps (view, request, install/approve, configure, connect own account, connect workspace
accounts, uninstall, activity), security (audit log, policies). `*` owner-only: never in a custom role.

Flags per permission: **admin** (an administrative power: putting it into a role, or assigning such a role, needs
`roles.delegate`), **ownerOnly**, **guestAllowed** (what a guest may receive through a role), **restrictable** (what a
role may deny: posting, requesting apps, connecting accounts, the member directory). There are no platform powers in
the catalog: workspace roles can never grant them.

## 2. Effective permissions (deterministic)

`effectivePermissions(base, roles)`: the base role's set, plus every assigned active role's grants (minus owner-only;
for guests only guest-allowed ones), minus every role's restrictions (deny wins; restrictable only). Owners always hold
everything and can't be restricted, so someone can always fix a mistake. The order of roles never matters (tested).
Base sets: Owner all; Admin all but owner-only and `roles.delegate`; Member: directory, view roles, post, view/request
apps, connect own account; Guest: post (in channels they're explicitly added to). Existing behaviour of the base roles
is unchanged (all earlier workspace tests pass). Evaluated on every request (deny by default), so a change applies at once.

Where they're enforced: workspace profile and avatar, branch/team creation and management, channel creation, channel
management and access mode, announcements, posting (a read-only role stops messages and files in channels), member
directory, invitations (create, see and revoke others'), member role/title changes and removal, roles, audit log,
usage. Branch managers and team leads were replaced by roles and channel permissions (COMMUNITY_REBUILD_2026-10-21.md).

## 3. Anti-escalation rules

- Defining a role needs `roles.manage`; you can only grant or restrict powers you hold; admin powers need
  `roles.delegate`; you can't edit a role that's already beyond you (so admins can't edit an owner's co-admin role).
  Changing what a role does (its powers, its restrictions, archiving or restoring it) also needs you to be able to act
  on everyone who holds it (`holder_out_of_reach`): an admin can't restrict another admin by editing a role that admin
  holds. Renaming, colour and description stay open to anyone who may define it.
- Assigning needs `roles.assign`, a target you may act on, and a role within your powers (+ delegate for admin powers);
  guests can't receive non-guest powers. Removing a role that restricts someone needs the restricted power: a read-only
  member can't lift their own restriction.
- Acting on someone: owners act on anyone; nobody else acts on owners, or on admins other than themselves, or on
  someone holding an administrative power they lack (an admin can't remove a delegated co-admin).
- Base-role changes keep the earlier table; `members.roles`, `members.titles` and `members.remove` extend it to custom
  roles without touching admins or owners. The last owner can't step down or leave. A demoted guest keeps their custom
  roles (only guest-safe parts count), so a change is checked against the person both as they are and as they would
  be: promoting a guest back needs reach over the powers their roles would give them again.
- Ownership transfer: `POST /v1/orgs/:id/ownership` (owners), typing the exact workspace name; the new owner must be a
  member (not a guest); the previous owner becomes an admin. Audited (`org.ownership.transfer`).

## 4. Lifecycle and data

Create (blank, from a starter template: Moderator, Community Manager, Announcer, Helper, Read-Only
Member, or by cloning), edit with optimistic revisions (a stale edit gets 409 with the current role), archive (grants
nothing, assignments kept), restore, delete (archived only). Names unique among active roles (and never a base role's),
50 active roles per workspace, 20 per person, optional colour and icon. Assignments are removed with the member
(composite foreign key). Every change is audited (`role.create/update/archive/restore/delete/assign/unassign`) and
hidden from ordinary members' activity feed. Tables `org_roles` and `org_role_members` (migration 016) belong to the
**workspace** domain, in SQLite with the rest of authorisation, which is synchronous on the message path; they are
copied and verified by the MongoDB tools like every workspace table (docs/MONGODB.md §6 for moving that domain).

## 5. API

`GET /v1/orgs/:id/roles` (catalog, templates, base roles, roles, your permissions), `POST /v1/orgs/:id/roles`,
`PATCH /v1/roles/:id` (`baseRev`), `DELETE /v1/roles/:id`, `GET|PUT|DELETE /v1/roles/:id/members[/:userId]`,
`GET /v1/orgs/:id/members/:userId/permissions` (with sources), `POST /v1/orgs/:id/ownership`, `GET /v1/orgs/:id/usage`,
`GET /v1/orgs/:id/audit?before=&limit=&action=`, `GET /v1/orgs/:id/plan`. `GET /v1/orgs/:id` adds the caller's
`permissions.effective` and flags (`canViewRoles`, `canManageApps`, …); member lists add `customRoles`.

## 6. Community parity A1 (2026-10-30)

Fourteen more keys (`messages.react`, `.embed`, `.voice`, `.external_emoji`, `.polls`, `.big_text`, `.history`,
`.mention_all`, `.manage`, `threads.create`, `.post`, `.manage`, `members.nickname`, `.nicknames`), the community's
editable "@everyone" defaults (the Member base set per community), role extras (second colour, mentionable,
automatic assignment) and role order: docs/COMMUNITY_PERMISSIONS.md.

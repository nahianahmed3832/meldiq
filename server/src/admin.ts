/**
 * Operator CLI. Runs inside the api container; there is no HTTP admin surface.
 *
 *   docker compose -p griip-internal-messaging exec api node dist/admin.js <command>
 *
 *   stats                          counts of users, devices, orgs, queued items (no content)
 *   users                          list usernames and device counts
 *   invite <orgSlug> [ROLE] [uses] create an org invite (ROLE: ADMIN|MEMBER|GUEST)
 *   reg-invite [uses] [days] [note] create a registration invite (default 1 use, 7 days)
 *   loadtest-invite [uses] [days] [note]  load-test provisioning invite (synthetic accounts; default 100 uses, 30 days)
 *   loadtest-status                 synthetic accounts created in the last hour / 24 h, communities, invites
 *   loadtest-disable-all            disable every synthetic account and end its sessions
 *   reg-invites                    list registration invites (hint, uses, expiry; never the code)
 *   reg-invite-revoke <hint|id>    revoke a registration invite
 *   disable <username>             disable an account and drop its sessions
 *   enable <username>
 *   limits <username>              new-account limits, active devices and file use of one account (no content)
 *   limits-end <username>          end an account's new-account limits now (docs/ABUSE_CONTROLS.md)
 *   cleanup                        run the retention job now
 *   backup <file>                  consistent snapshot of the live database (never overwrites)
 *   verify-backup <file>           read-only check that a snapshot is intact and this server can use it
 *   fed-status                     federation identity, domain, known peers and queued deliveries
 *   fed-rotate-key                 add a new server key signed by the current one (stop the server first; the id stays)
 *   fed-decommission <reason> --yes  permanently retire this server id on the core network (can't be undone)
 *   fed-block <serverId> [reason]  refuse federation with a server; fed-unblock <serverId> lifts it
 *   org-duplicates                 list workspaces one person owns under the same name, with what each holds (counts only)
 *   org-delete-empty <orgId> [--yes]  remove one provably empty duplicate (dry run without --yes; back up first)
 *   channel-access-repair [--yes]  public channels created as opt-in before round 7: mark them auto-joined and add the
 *                                  members who may see them (dry run without --yes; back up first)
 *   storage-check                  which file store is configured and whether it answers (no secrets printed)
 *   storage-orphans [--delete]     stored files no record refers to, older than a day (dry run; --delete queues them
 *                                  for the retention job)
 *   table-counts                   rows in every table, as JSON (no content; backup manifests and migration checks)
 *   mongo-status | mongo-estimate | mongo-migrate | mongo-verify | mongo-rollback | mongo-dryrun
 *                                  MongoDB domains and migration (src/mongo/admin.ts, docs/MONGODB.md)
 *   retired-data [--purge --yes]   rows left in the tables of modules the community rebuild removed (apps, inbox,
 *                                  workflows, documents, developer keys, AI, groups); --purge --yes deletes them (back up first)
 *   community-migration [--verify] convert branches and teams into roles and categories (also runs at start-up);
 *                                  --verify compares everyone's visible channels with the old structure
 *   platform-admin-grant | platform-admin-list | platform-admin-revoke | platform-admin-reset-passkeys |
 *   platform-audit-verify          Platform Admin Console roles, enrolment codes and its audit chain
 *                                  (src/modules/platformAdmin/cli.ts)
 */
import { addWarning, revokeWarning, standingOf } from "./modules/accounts/standing.js";
import { BUG_STATUSES, type BugStatus, listBugReports, setBugStatus } from "./modules/accounts/bugReports.js";
import { MongoRelationshipStore } from "./modules/accounts/relationships/mongoStore.js";
import { type RelationshipStore, SqliteRelationshipStore } from "./modules/accounts/relationships/store.js";
import { Accounts } from "./modules/accounts/index.js";
import { Authz } from "./modules/organizations/authz.js";
import { backupDatabase, verifyBackup } from "./modules/administration/backup.js";
import { loadConfig } from "./app/config.js";
import { openDatabase } from "./infrastructure/database/db.js";
import { ServerIdentity } from "./modules/federation/identity.js";
import { Hub } from "./modules/realtime/hub.js";
import { endNewAccountLimits } from "./app/middleware/abuse.js";
import { createLoadtestInvite, LOADTEST_INVITE_MAX_DAYS, LOADTEST_INVITE_MAX_USES } from "./modules/accounts/index.js";
import { createRegistrationInvite } from "./modules/organizations/invites.js";
import type { AppContext } from "./app/context.js";
import { runCleanup } from "./modules/administration/jobs.js";
import { applyChannelAccessRepair, planChannelAccessRepair } from "./modules/messaging/channelRepair.js";
import { deleteEmptyOrg, findDuplicateOrgs, keepReason, orgFootprint, type OrgRepairStores } from "./modules/organizations/orgRepair.js";
import { MongoCallStore } from "./modules/calls/mongoStore.js";
import { type CallStore, SqliteCallStore } from "./modules/calls/store.js";
import { humanCode, newId, now, sha256Hex } from "./shared/utilities/util.js";
import { createBlobStore } from "./infrastructure/storage/index.js";
import { MONGO_COMMANDS, runMongoCommand } from "./infrastructure/database/mongo/admin.js";
import { RETIRED_COMMANDS, runRetiredCommand } from "./modules/administration/retiredData.js";
import { migrateBranchesAndTeams, verifyCommunityMigration } from "./modules/organizations/communityMigration.js";
import { openMongo } from "./infrastructure/database/mongo/index.js";
import { MongoRelayStore } from "./modules/messaging/relay/mongoStore.js";
import { PLATFORM_ADMIN_COMMANDS, runPlatformAdminCommand } from "./modules/platformAdmin/index.js";
import { MongoFileStore } from "./modules/files/mongoStore.js";
import { type FileStore, SqliteFileStore } from "./modules/files/store.js";
import { type RelayStore, SqliteRelayStore } from "./modules/messaging/relay/store.js";
import { MongoReportStore } from "./modules/organizations/reports/mongoStore.js";
import { ReportSealer } from "./modules/organizations/reports/seal.js";
import { type ReportStore, SqliteReportStore } from "./modules/organizations/reports/store.js";

/** Reports live where MONGODB_DOMAINS says. */
const fileStore = (ctx: AppContext): FileStore => (ctx.mongo?.owns("files") ? new MongoFileStore(ctx.mongo, console) : new SqliteFileStore(ctx.db));
const relayStore = (ctx: AppContext): RelayStore =>
  ctx.mongo?.owns("relay") ? new MongoRelayStore(ctx.mongo, ctx.db, console) : new SqliteRelayStore(ctx.db);
const reportStore = (ctx: AppContext): ReportStore => (ctx.mongo?.owns("reports") ? new MongoReportStore(ctx.mongo) : new SqliteReportStore(ctx.db));
const relationshipStore = (ctx: AppContext): RelationshipStore =>
  ctx.mongo?.owns("relationships") ? new MongoRelationshipStore(ctx.mongo) : new SqliteRelationshipStore(ctx.db);
const callStore = (ctx: AppContext): CallStore => (ctx.mongo?.owns("calls") ? new MongoCallStore(ctx.mongo) : new SqliteCallStore(ctx.db));

/** The stores org repair reads (files, relay and calls may live in MongoDB); [close] when done. */
async function repairStores(): Promise<{ stores: OrgRepairStores; close: () => Promise<void> }> {
  const ctx = { db } as AppContext;
  if (cfg.mongo) ctx.mongo = await openMongo(cfg.mongo, db);
  ctx.files = fileStore(ctx);
  ctx.relay = relayStore(ctx);
  ctx.calls = callStore(ctx);
  return {
    stores: ctx,
    close: async () => {
      await ctx.files.settled();
      await ctx.mongo?.close();
    },
  };
}

const [cmd, ...rest] = process.argv.slice(2);
// verify-backup only reads the snapshot: it must not open (or migrate) the live database.
if (cmd === "verify-backup") {
  if (!rest[0]) {
    console.error("usage: verify-backup <file>");
    process.exit(2);
  }
  const r = verifyBackup(rest[0]);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
const cfg = loadConfig();
const db = openDatabase(cfg.databasePath);
if (RETIRED_COMMANDS.includes(cmd)) {
  try {
    process.exitCode = runRetiredCommand(cmd, rest, db);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  db.close();
  process.exit();
}
if (PLATFORM_ADMIN_COMMANDS.includes(cmd)) {
  try {
    process.exitCode = await runPlatformAdminCommand(cmd, rest, cfg, db);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  db.close();
  process.exit();
}
if (MONGO_COMMANDS.includes(cmd)) {
  try {
    process.exitCode = await runMongoCommand(cmd, rest, cfg, db);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  db.close();
  process.exit();
}
const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

switch (cmd) {
  case "stats":
    console.table({
      users: one("SELECT COUNT(*) n FROM users"),
      activeDevices: one("SELECT COUNT(*) n FROM devices WHERE revoked_at IS NULL"),
      orgs: one("SELECT COUNT(*) n FROM orgs"),
      conversations: one("SELECT COUNT(*) n FROM conversations"),
      queuedEnvelopes: cfg.mongo?.domains.has("relay") ? "in MongoDB" : one("SELECT COUNT(*) n FROM delivery_queue WHERE kind = 'envelope'"),
      queuedReceipts: cfg.mongo?.domains.has("relay") ? "in MongoDB" : one("SELECT COUNT(*) n FROM delivery_queue WHERE kind = 'receipt'"),
      oldestQueuedHours: cfg.mongo?.domains.has("relay")
        ? "in MongoDB"
        : Math.round((now() - (one("SELECT COALESCE(MIN(created_at), 0) n FROM delivery_queue") || now())) / 3600_000),
      attachments: cfg.mongo?.domains.has("files") ? "in MongoDB" : one("SELECT COUNT(*) n FROM attachments"),
      liveCalls: cfg.mongo?.domains.has("calls") ? "in MongoDB" : one("SELECT COUNT(*) n FROM calls WHERE state != 'ENDED'"),
      pushEndpoints: one("SELECT COUNT(*) n FROM push_endpoints"),
      pushEndpointsFailing: one("SELECT COUNT(*) n FROM push_endpoints WHERE failing_since IS NOT NULL"),
    });
    break;
  case "users":
    console.table(
      db
        .prepare(
          "SELECT u.username, u.display_name, (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) devices, u.disabled_at IS NOT NULL disabled FROM users u ORDER BY u.created_at",
        )
        .all(),
    );
    break;
  case "invite": {
    const [slug, role = "MEMBER", uses = "1"] = rest;
    const org = db.prepare("SELECT id, created_by FROM orgs WHERE slug = ?").get(slug) as { id: string; created_by: string } | undefined;
    if (!org || !["ADMIN", "MEMBER", "GUEST"].includes(role)) {
      console.error("usage: invite <orgSlug> [ADMIN|MEMBER|GUEST] [uses]");
      process.exit(2);
    }
    const code = humanCode(12);
    db.prepare(
      `INSERT INTO invitations (id, org_id, code_hash, code_hint, role, max_uses, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId("inv"), org.id, sha256Hex(code), code.slice(-4), role, Number(uses), org.created_by, now(), now() + 72 * 3600_000);
    console.log(`${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}  (${role}, ${uses} use(s), 72h)`);
    break;
  }
  // ───────── API 0.46.0 (docs/ACCOUNT_SAFETY.md): staff warnings and bug reports ─────────
  case "warn": {
    const [username, days, ...words] = rest;
    const u = username ? (db.prepare("SELECT id FROM users WHERE username = ? AND deleted_at IS NULL").get(username) as { id: string } | undefined) : undefined;
    if (!u || !Number(days) || !words.length) {
      console.error("usage: warn <username> <days 1-365> <reason...>   (1 active warning limits an account, 2 limit it more, 3 suspend it)");
      process.exit(2);
    }
    const w = addWarning(db, u.id, words.join(" "), Number(days), "operator");
    console.log(`${w.id}  until ${new Date(w.expiresAt).toISOString()}  standing now: ${standingOf(db, u.id).level}`);
    break;
  }
  case "warnings": {
    const [username] = rest;
    const u = username ? (db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: string } | undefined) : undefined;
    if (!u) {
      console.error("usage: warnings <username>");
      process.exit(2);
    }
    const st = standingOf(db, u.id);
    console.log(`standing: ${st.level}`);
    console.table(st.warnings.map((w) => ({ id: w.id, reason: w.reason, until: new Date(w.expiresAt).toISOString() })));
    break;
  }
  case "unwarn": {
    const [id] = rest;
    if (!id) {
      console.error("usage: unwarn <warningId>");
      process.exit(2);
    }
    console.log(revokeWarning(db, id) ? "lifted" : "no active warning with that id");
    break;
  }
  case "bug-reports": {
    const [status] = rest;
    if (status && !BUG_STATUSES.includes(status as BugStatus)) {
      console.error(`usage: bug-reports [${BUG_STATUSES.join("|")}]`);
      process.exit(2);
    }
    console.table(
      listBugReports(db, (status as BugStatus) ?? null).map((b) => ({ id: b.id, from: b.username, status: b.status, summary: b.summary, page: b.page, at: new Date(b.created_at).toISOString() })),
    );
    break;
  }
  case "bug-report": {
    const [id, status, ...note] = rest;
    if (!id) {
      console.error(`usage: bug-report <id> [${BUG_STATUSES.join("|")}] [note...]`);
      process.exit(2);
    }
    if (!status) {
      console.log(db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(id) ?? "no such report");
      break;
    }
    if (!BUG_STATUSES.includes(status as BugStatus)) {
      console.error(`status must be one of ${BUG_STATUSES.join(", ")}`);
      process.exit(2);
    }
    console.log(setBugStatus(db, id, status as BugStatus, note.join(" ") || null) ? `set to ${status}` : "no such report");
    break;
  }
  case "reg-invite": {
    const [uses = "1", days = "7", ...note] = rest;
    try {
      const { code } = createRegistrationInvite(db, { maxUses: Number(uses), days: Number(days), note: note.join(" ") || null });
      console.log(`${code}  (registration, ${uses} use(s), ${days} day(s))`);
    } catch (e) {
      console.error(`usage: reg-invite [uses 1-1000] [days ≤30] [note]  (${(e as Error).message})`);
      process.exit(2);
    }
    break;
  }
  case "loadtest-invite": {
    // Load-test provisioning (docs/LOADTEST_PROVISIONING.md): accounts it admits are synthetic and counted against
    // LOADTEST_REGISTRATION_HOURLY_LIMIT / _DAILY_LIMIT, not the public per-network limits.
    const [uses = "100", days = "30", ...note] = rest;
    try {
      const { code } = createLoadtestInvite(db, { maxUses: Number(uses), days: Number(days), note: note.join(" ") || null });
      console.log(`${code}  (load-test provisioning, ${uses} use(s), ${days} day(s))`);
    } catch (e) {
      console.error(`usage: loadtest-invite [uses 1-${LOADTEST_INVITE_MAX_USES}] [days ≤${LOADTEST_INVITE_MAX_DAYS}] [note]  (${(e as Error).message})`);
      process.exit(2);
    }
    break;
  }
  case "loadtest-status": {
    const t = now();
    const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    console.table({
      "created in the last hour": n("SELECT COUNT(*) n FROM loadtest_registrations WHERE created_at > ?", t - 3_600_000),
      "created in the last 24 hours": n("SELECT COUNT(*) n FROM loadtest_registrations WHERE created_at > ?", t - 86_400_000),
      "synthetic accounts (active)": n("SELECT COUNT(*) n FROM users WHERE synthetic = 1 AND disabled_at IS NULL"),
      "synthetic accounts (disabled)": n("SELECT COUNT(*) n FROM users WHERE synthetic = 1 AND disabled_at IS NOT NULL"),
      "load-test communities": n("SELECT COUNT(*) n FROM orgs WHERE synthetic = 1"),
      "active load-test invites": n("SELECT COUNT(*) n FROM registration_invites WHERE purpose = 'loadtest' AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses", t),
    });
    break;
  }
  case "loadtest-disable-all": {
    // Cleanup: disables every synthetic account and ends its sessions (real accounts are never touched).
    const ids = (db.prepare("SELECT id FROM users WHERE synthetic = 1 AND disabled_at IS NULL").all() as { id: string }[]).map((r) => r.id);
    db.transaction(() => {
      for (const id of ids) {
        db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now(), id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      }
    })();
    console.log(`disabled ${ids.length} synthetic account(s)`);
    break;
  }
  case "reg-invites":
    console.table(
      db
        .prepare(
          "SELECT id, purpose, code_hint hint, note, uses, max_uses, datetime(expires_at / 1000, 'unixepoch') expires, revoked_at IS NOT NULL revoked FROM registration_invites ORDER BY created_at DESC",
        )
        .all(),
    );
    break;
  case "reg-invite-revoke": {
    const key = (rest[0] ?? "").toUpperCase();
    const res = db.prepare("UPDATE registration_invites SET revoked_at = ? WHERE (id = ? OR code_hint = ?) AND revoked_at IS NULL").run(now(), rest[0], key);
    console.log(res.changes ? `revoked ${res.changes} invite(s)` : "no matching active invite");
    break;
  }
  case "disable":
  case "enable": {
    const u = db.prepare("SELECT id FROM users WHERE username = ?").get(rest[0]) as { id: string } | undefined;
    if (!u) {
      console.error("no such user");
      process.exit(1);
    }
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(cmd === "disable" ? now() : null, u.id);
    if (cmd === "disable") db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    console.log(`${cmd}d ${rest[0]}`);
    break;
  }
  case "limits":
  case "limits-end": {
    const u = db.prepare("SELECT id, limited_until FROM users WHERE username = ?").get(rest[0]) as { id: string; limited_until: number | null } | undefined;
    if (!u) {
      console.error(`usage: ${cmd} <username>  (no such user)`);
      process.exit(1);
    }
    if (cmd === "limits-end") {
      console.log(endNewAccountLimits(db, u.id) ? `new-account limits ended for ${rest[0]}` : `${rest[0]} had no new-account limits`);
      break;
    }
    const t = now();
    const limited = !!u.limited_until && u.limited_until > t;
    console.log(
      JSON.stringify(
        {
          newAccountLimits: limited ? { until: new Date(u.limited_until!).toISOString() } : null,
          activeDevices: one("SELECT COUNT(*) n FROM devices WHERE user_id = ? AND revoked_at IS NULL", u.id),
          maxDevices: cfg.abuse.maxDevicesPerUser || null,
          filesUploadedLast24h: cfg.mongo?.domains.has("files")
            ? "in MongoDB"
            : one("SELECT COALESCE(SUM(size), 0) n FROM attachments WHERE uploader_user_id = ? AND created_at > ?", u.id, t - 86_400_000),
          filesStored: cfg.mongo?.domains.has("files") ? "in MongoDB" : one("SELECT COALESCE(SUM(size), 0) n FROM attachments WHERE uploader_user_id = ? AND expires_at > ?", u.id, t),
          // With MONGODB_DOMAINS history, SQLite only keeps the copy from before the migration.
          historyBytes: cfg.mongo?.domains.has("history") ? "in MongoDB" : one("SELECT COALESCE(SUM(bytes), 0) n FROM history_accounts WHERE user_id = ?", u.id),
        },
        null,
        2,
      ),
    );
    break;
  }
  case "table-counts": {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    console.log(JSON.stringify(Object.fromEntries(tables.map((t) => [t, one(`SELECT COUNT(*) n FROM "${t}"`)])), null, 2));
    break;
  }
  case "cleanup": {
    const ctx = { db, config: cfg, authz: new Authz(db), livekit: null, blobs: createBlobStore(cfg), log: console as any, audit: () => {} } as unknown as AppContext;
    // Domains kept in MongoDB are cleaned there (docs/MONGODB.md).
    if (cfg.mongo) ctx.mongo = await openMongo(cfg.mongo, db);
    ctx.relay = relayStore(ctx);
    ctx.files = fileStore(ctx);
    ctx.hub = new Hub(ctx.relay);
    ctx.accounts = new Accounts(ctx);
    ctx.reports = reportStore(ctx);
    ctx.relationships = relationshipStore(ctx);
    ctx.calls = callStore(ctx);
    try {
      const r = await runCleanup(ctx);
      console.table(r);
    } finally {
      await ctx.files.settled();
      await ctx.mongo?.close();
    }
    break;
  }
  case "backup": {
    if (!rest[0]) {
      console.error("usage: backup <file>");
      process.exit(2);
    }
    try {
      const r = await backupDatabase(db, rest[0]);
      console.log(`backup written: ${r.file} (${r.bytes} bytes)`);
    } catch (e) {
      console.error(`backup failed: ${(e as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case "fed-status": {
    if (!cfg.federation) {
      console.log("federation: off (FEDERATION_DOMAIN not set)");
      break;
    }
    const id = ServerIdentity.loadOrCreate(cfg.federation.keyDir);
    console.log(JSON.stringify({ serverId: id.serverId, domain: cfg.federation.domain, publicUrl: cfg.federation.publicUrl, keys: id.publicChain().length + 1, coreNodes: cfg.federation.coreNodes.length, quorum: cfg.federation.coreQuorum }, null, 2));
    console.table(db.prepare("SELECT server_id, domain, state, agreeing, datetime(verified_at / 1000, 'unixepoch') verified FROM federation_peers ORDER BY domain").all());
    console.table(db.prepare("SELECT peer_server_id, kind, COUNT(*) n, MAX(attempts) attempts FROM federation_outbox GROUP BY peer_server_id, kind").all());
    break;
  }
  case "fed-rotate-key": {
    if (!cfg.federation) throw new Error("federation is off");
    const id = ServerIdentity.loadOrCreate(cfg.federation.keyDir);
    id.rotateKey();
    console.log(`rotated: server ${id.serverId} now signs with key #${id.publicChain().length}. Start the server: it reissues its descriptor and re-announces.`);
    break;
  }
  case "fed-decommission": {
    if (!cfg.federation) throw new Error("federation is off");
    if (!rest[0] || rest[1] !== "--yes") {
      console.error('usage: fed-decommission "<reason>" --yes   (permanent: this server id can never federate again)');
      process.exit(2);
    }
    const id = ServerIdentity.loadOrCreate(cfg.federation.keyDir);
    const rec = id.selfSigned({ t: "griip.server.decommission" as const, reason: rest[0], at: Date.now() });
    for (const c of cfg.federation.coreNodes) {
      const r = await fetch(`${c.url.replace(/\/$/, "")}/core/v1/decommission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) }).catch((e) => e as Error);
      console.log(c.url, r instanceof Error ? r.message : r.status);
    }
    break;
  }
  case "org-duplicates": {
    const repair = await repairStores();
    const groups = await findDuplicateOrgs(repair.stores).finally(repair.close);
    if (groups.length === 0) console.log("No duplicate workspaces.");
    for (const g of groups) {
      console.log(`\n"${g.name}" owned by ${g.ownerUsername ?? g.ownerId}: ${g.orgs.length} workspaces (oldest first)`);
      console.table(
        g.orgs.map((o) => ({
          id: o.id,
          slug: o.slug,
          created: new Date(o.createdAt).toISOString(),
          members: o.members,
          teams: o.teams,
          channels: o.channels,
          removable: o.removable ? "yes (empty)" : `no: ${o.keepReason}`,
        })),
      );
    }
    break;
  }
  case "org-delete-empty": {
    const orgId = rest[0];
    if (!orgId) {
      console.error("usage: org-delete-empty <orgId> [--yes]   (refuses anything that isn't provably empty; back up first)");
      process.exit(2);
    }
    const repair = await repairStores();
    try {
      const f = await orgFootprint(repair.stores, orgId);
      const reason = await keepReason(repair.stores, orgId);
      console.log(JSON.stringify({ org: f ?? null, removable: reason === null, keepReason: reason }, null, 2));
      if (reason) {
        process.exitCode = 1;
        break;
      }
      if (!rest.includes("--yes")) {
        console.log("Dry run: nothing deleted. Run again with --yes to remove it.");
        break;
      }
      await deleteEmptyOrg(repair.stores, orgId);
      console.log(`Deleted empty workspace ${orgId}.`);
    } finally {
      await repair.close();
    }
    break;
  }
  case "channel-access-repair": {
    // Round 7 bug 6: public channels created as opt-in before the fix. Dry run unless --yes; back up first.
    const plan = planChannelAccessRepair(db);
    if (plan.length === 0) console.log("No public channel needs repair.");
    else console.table(plan.map((r) => ({ channel: r.channelId, org: r.orgId, name: r.name, scope: r.scope, add: r.add.length, leftThemselves: r.skippedLeft })));
    if (plan.length === 0) break;
    if (!rest.includes("--yes")) {
      console.log("Dry run: nothing changed. Run again with --yes to mark these channels auto-joined and add the members listed.");
      break;
    }
    console.log(`Repaired ${plan.length} channels, added ${applyChannelAccessRepair(db, plan, now())} memberships.`);
    break;
  }
  case "fed-block":
  case "fed-unblock": {
    if (!/^gs1[a-z2-7]{26}$/.test(rest[0] ?? "")) {
      console.error(`usage: ${cmd} <serverId> [reason]`);
      process.exit(2);
    }
    if (cmd === "fed-block") db.prepare("INSERT OR REPLACE INTO federation_blocks (server_id, reason, created_at) VALUES (?, ?, ?)").run(rest[0], rest.slice(1).join(" ") || null, now());
    else db.prepare("DELETE FROM federation_blocks WHERE server_id = ?").run(rest[0]);
    console.log(`${cmd === "fed-block" ? "blocked" : "unblocked"} ${rest[0]}`);
    break;
  }
  case "community-migration": {
    // Idempotent: branches and teams already converted are skipped. --verify then compares access, old rules vs new.
    const r = migrateBranchesAndTeams(db);
    console.log(`converted ${r.branches} branches and ${r.teams} teams (${r.channels} channels placed in categories)`);
    if (!rest.includes("--verify")) break;
    const authz = new Authz(db);
    const diffs = verifyCommunityMigration(db, (c, u) => {
      const conv = authz.conversation(c);
      return !!conv && authz.canViewChannel(conv, u);
    });
    if (diffs.length === 0) console.log("verified: everyone sees exactly the channels the old structure gave them");
    else {
      console.table(diffs.slice(0, 50));
      console.error(`${diffs.length} difference(s) in channel visibility (first 50 shown)`);
      process.exitCode = 1;
    }
    break;
  }
  case "storage-check": {
    const blobs = createBlobStore(cfg);
    const s3 = cfg.storage.s3;
    console.log(`backend: ${blobs.backend}${cfg.storage.readFallback ? ` · also reading: ${cfg.storage.readFallback}` : ""}${s3 ? ` · bucket ${s3.bucket} · region ${s3.region} · prefix "${s3.prefix}" · credentials: ${s3.credentials ? "S3_ACCESS_KEY_ID" : "AWS default chain"} · direct uploads: ${blobs.direct ? "on" : "off"} · presigned downloads: ${s3.presignedDownloads ? "on" : "off"}` : ""}`);
    try {
      let n = 0;
      for await (const _ of blobs.listIds("attachments")) if (++n >= 1) break;
      console.log("store reachable: yes (listing works)");
    } catch (e) {
      console.error(`store reachable: NO (${(e as Error).message})`);
      process.exitCode = 1;
    }
    break;
  }
  case "storage-orphans": {
    const blobs = createBlobStore(cfg);
    const fctx = { db, config: cfg } as unknown as AppContext;
    if (cfg.mongo) fctx.mongo = await openMongo(cfg.mongo, db);
    const files = fileStore(fctx);
    const cutoff = now() - 86_400_000;
    const orphans: { kind: "attachments" | "profile-photos"; id: string; size: number }[] = [];
    for await (const o of blobs.listIds("attachments")) {
      if (o.modifiedAt < cutoff && !(await files.knows(o.id))) orphans.push({ kind: "attachments", id: o.id, size: o.size });
    }
    // People's photos ("<userId>-<rev>", or "<userId>" before 2026-10-17), organisations' ("<orgId>-<rev>", 2026-10-19)
    // and community banners ("<orgId>_banner-<rev>", API 0.44.0).
    const photo = db.prepare(
      `SELECT 1 FROM users WHERE id = ? AND photo_rev IS NOT NULL AND (? = id || '-' || photo_rev OR ? = id)
       UNION SELECT 1 FROM orgs WHERE id = ? AND photo_rev IS NOT NULL AND ? = id || '-' || photo_rev
       UNION SELECT 1 FROM orgs WHERE id || '_banner' = ? AND banner_rev IS NOT NULL AND ? = id || '_banner-' || banner_rev`,
    );
    // A community's own emoji and stickers (batch B9) are stored there too, under their own ids.
    const expression = db.prepare("SELECT 1 FROM community_expressions WHERE id = ?");
    // API 0.45.0: people's animated avatars, their poster frames and profile banners ("<userId>_avatar-<rev>", ...).
    const profileMedia = db.prepare(
      `SELECT 1 FROM users WHERE (id || '_avatar' = ? OR id || '_poster' = ?) AND json_extract(avatar_media, '$.rev') = ?
       UNION SELECT 1 FROM users WHERE id || '_pbanner' = ? AND json_extract(profile_banner, '$.rev') = ?`,
    );
    const keptProfileMedia = (id: string) => {
      const m = /^(.*)-(\d+)$/.exec(id);
      return !!m && !!profileMedia.get(m[1], m[1], Number(m[2]), m[1], Number(m[2]));
    };
    for await (const o of blobs.listIds("profile-photos")) {
      const owner = o.id.replace(/-\d+$/, "");
      if (o.modifiedAt < cutoff && !photo.get(owner, o.id, o.id, owner, o.id, owner, o.id) && !expression.get(o.id) && !keptProfileMedia(o.id)) orphans.push({ kind: "profile-photos", id: o.id, size: o.size });
    }
    const bytes = orphans.reduce((a, o) => a + o.size, 0);
    console.log(`${orphans.length} orphaned file(s), ${bytes} bytes, older than a day (${blobs.backend})`);
    if (rest.includes("--delete")) {
      for (const o of orphans) files.queueBlobDelete(o.kind, o.id);
      await files.settled();
      console.log("queued for deletion; they're removed by the next retention run (or run: cleanup)");
    } else if (orphans.length) console.log("dry run: nothing deleted. Re-run with --delete to remove them.");
    await fctx.mongo?.close();
    break;
  }
  // Batch B4b: Meldiq's operators review reports sent to Meldiq (DMs, groups, illegal content).
  case "reports":
  case "report-show":
  case "report-close": {
    const ctx = { db, config: cfg } as unknown as AppContext;
    if (cfg.mongo) ctx.mongo = await openMongo(cfg.mongo, db);
    const store = reportStore(ctx);
    const sealer = ReportSealer.load(process.env, cfg.dataDir);
    try {
      if (cmd === "reports") {
        const rows = await store.list(null, rest[0] === "closed", 100);
        console.table(rows.map((r) => ({ id: r.id, reason: r.reason, status: r.status, target: r.target_user_id, conversation: r.conversation_id, at: new Date(r.created_at).toISOString() })));
      } else if (cmd === "report-show") {
        const r = rest[0] ? await store.get(rest[0]) : null;
        if (!r || r.org_id) throw new Error("usage: report-show <id> (a report sent to Meldiq)");
        console.log(JSON.stringify({ ...r, content: sealer.open(r.id, r.content), reporter_id: undefined }, null, 2));
      } else {
        const [id, status, ...note] = rest;
        const r = id ? await store.get(id) : null;
        if (!r || r.org_id || !["actioned", "dismissed"].includes(status ?? "")) throw new Error("usage: report-close <id> actioned|dismissed [note]");
        await store.setStatus(id, status as "actioned" | "dismissed", "operator", note.join(" ") || null, now());
        console.log(`${id}: ${status}`);
      }
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    } finally {
      await ctx.mongo?.close();
    }
    break;
  }
  default:
    console.log(
      "commands: stats | users | invite <orgSlug> [role] [uses] | reg-invite [uses] [days] [note] | reg-invites | reg-invite-revoke <hint|id> | disable <username> | enable <username> | cleanup | backup <file> | verify-backup <file> | fed-status | fed-rotate-key | fed-decommission <reason> --yes | fed-block <serverId> [reason] | fed-unblock <serverId> | reports [closed] | report-show <id> | report-close <id> actioned|dismissed [note] | warn <username> <days> <reason> | warnings <username> | unwarn <id> | bug-reports [status] | bug-report <id> [status] [note]",
    );
}
db.close();

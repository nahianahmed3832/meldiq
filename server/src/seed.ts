/**
 * DEVELOPMENT SEED — creates the "Meldiq Lab" sample community owned by an existing user: categories, text, forum,
 * announcement and voice channels, a role-gated category and invitations.
 *
 *   node dist/seed.js --owner <username>
 *
 * Refuses to run when NODE_ENV=production unless --force is passed. Seeded rows are tagged in
 * the audit log ("seed.dev") so they can be identified; no sample users or messages are created.
 */
import { Authz } from "./modules/organizations/authz.js";
import { loadConfig } from "./app/config.js";
import { openDomainRows } from "./app/domainRows.js";
import { openWorkspaceRows } from "./app/workspaceRows.js";
import { openMongo } from "./infrastructure/database/mongo/index.js";
import { openDatabase } from "./infrastructure/database/db.js";
import { humanCode, newId, now, sha256Hex } from "./shared/utilities/util.js";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.NODE_ENV === "production" && !args.includes("--force")) {
  console.error("Refusing to seed development data with NODE_ENV=production (pass --force to override).");
  process.exit(2);
}
const ownerName = arg("--owner");
if (!ownerName) {
  console.error("Usage: seed --owner <username>   (register the owner in the app first)");
  process.exit(2);
}
const cfg = loadConfig();
const db = openDatabase(cfg.databasePath);
const mongo = cfg.mongo ? await openMongo(cfg.mongo, db) : undefined;
const ws = await openWorkspaceRows(db, mongo, console);
const identity = await openDomainRows(db, "identity", mongo, console);
const authz = new Authz(ws);
const owner = identity.get<{ id: string }>("users", { username: ownerName });
if (!owner) {
  console.error(`No user named ${ownerName}. Register in the app first.`);
  process.exit(1);
}
if (ws.get("orgs", { slug: "meldiq-lab" })) {
  console.error("Meldiq Lab already exists — nothing to do.");
  process.exit(0);
}
const t = now();
const orgId = newId("o");
const codes: string[] = [];
await ws.write((w) => {
  const audit = (orgId: string, action: string, target: string, detail: string) =>
    w.insert("audit_log", { at: t, actor_id: owner.id, org_id: orgId, action, target, detail });
  w.insert("orgs", {
    id: orgId,
    name: "Meldiq Lab",
    slug: "meldiq-lab",
    description: "A sample community for trying Meldiq (development seed)",
    created_by: owner.id,
    created_at: t,
    updated_at: t,
    kind: "community",
    visibility: "public",
    join_policy: "open",
    rules: "1. Be kind.\n2. Stay on topic.\n3. No spam or self-promotion.",
  });
  w.insert("org_members", { org_id: orgId, user_id: owner.id, role: "OWNER", joined_at: t });
  audit(orgId, "seed.dev", orgId, "community");

  let categoryPosition = 0;
  const category = (name: string) => {
    const id = newId("cat");
    w.insert("channel_categories", { id, org_id: orgId, name, position: categoryPosition++, created_by: owner.id, created_at: t, updated_at: t });
    audit(orgId, "category.create", id, name);
    return id;
  };
  const positions = new Map<string, number>();
  const channel = (categoryId: string, name: string, topic: string, kind: string, opts: { voice?: boolean; format?: "text" | "forum" } = {}) => {
    const id = newId("c");
    const position = positions.get(categoryId) ?? 0;
    positions.set(categoryId, position + 1);
    w.insert("conversations", {
      id,
      type: "CHANNEL",
      org_id: orgId,
      scope: "ORG",
      scope_id: null,
      kind,
      name,
      topic,
      auto_join: kind === "PRIVATE" ? 0 : 1,
      created_by: owner.id,
      created_at: t,
      updated_at: t,
      voice: opts.voice ? 1 : 0,
      category_id: categoryId,
      position,
      format: opts.format ?? "text",
    });
    w.insert("conversation_members", { conversation_id: id, user_id: owner.id, role: "ADMIN", joined_at: t });
    audit(orgId, opts.voice ? "voice_room.create" : "channel.create", id, `${kind} ${name}`);
    return id;
  };

  const start = category("Start here");
  channel(start, "welcome", "What this community is about", "ANNOUNCEMENT");
  channel(start, "rules", "Read these before posting", "ANNOUNCEMENT");
  channel(start, "announcements", "News from the moderators", "ANNOUNCEMENT");
  const talk = category("Talk");
  channel(talk, "general", "Everyday conversation", "PUBLIC");
  channel(talk, "introductions", "Say hello", "PUBLIC");
  channel(talk, "help", "Ask a question: one post per question", "PUBLIC", { format: "forum" });
  channel(talk, "media", "Photos, videos and files", "PUBLIC");
  const voice = category("Voice");
  channel(voice, "lounge", "Drop in to talk", "PUBLIC", { voice: true });
  channel(voice, "screen-share", "Voice room for screen sharing tests", "PUBLIC", { voice: true });

  // A category only moderators see, gated with a role and two overwrites.
  const modRole = newId("role");
  w.insert("org_roles", {
    id: modRole,
    org_id: orgId,
    name: "Moderator",
    description: "Keeps conversations healthy",
    color: "#E39B7B",
    icon: "shield",
    permissions: JSON.stringify(["channels.manage", "channels.visibility", "messages.announce", "members.remove", "members.ban"]),
    denies: "[]",
    template: "moderator",
    position: 0,
    rev: 1,
    created_by: owner.id,
    created_at: t,
    updated_at: t,
  });
  const mods = category("Moderators");
  const overwrite = (subject: string, allow: string[], deny: string[]) =>
    w.insert("channel_overwrites", {
      target_type: "category",
      target_id: mods,
      org_id: orgId,
      subject,
      allow: JSON.stringify(allow),
      deny: JSON.stringify(deny),
      updated_by: owner.id,
      updated_at: t,
    });
  overwrite("everyone", [], ["channels.view"]);
  overwrite(modRole, ["channels.view"], []);
  channel(mods, "mod-chat", "Moderators only", "PUBLIC");
  channel(mods, "reports", "Things to look at", "PUBLIC");

  const invite = (label: string, grantRoleId: string | null) => {
    const code = humanCode(12);
    w.insert("invitations", {
      id: newId("inv"),
      org_id: orgId,
      code_hash: sha256Hex(code),
      code_hint: code.slice(-4),
      role: "MEMBER",
      max_uses: 50,
      created_by: owner.id,
      created_at: t,
      expires_at: t + 14 * 24 * 3600_000,
      grant_role_id: grantRoleId,
    });
    codes.push(`${label.padEnd(24)} ${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`);
  };
  invite("Member", null);
  invite("Moderator", modRole);
  authz.autoJoinScope(w, orgId, owner.id, t);
});
console.log(`Seeded Meldiq Lab (${orgId}) owned by @${ownerName}: public, open to join.`);
console.log("Invite codes (50 uses, 14 days):");
for (const c of codes) console.log("  " + c);
await mongo?.close();
db.close();

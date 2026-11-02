import type { Harness } from "./harness.js";

/**
 * Direct access to the account rows for tests, in whichever store the server keeps them (SQLite, or MongoDB with
 * MONGODB_DOMAINS including "accounts"), so the same suites run against both (docs/MONGODB.md › Tests).
 */
export function accountRows(h: Harness) {
  const mongo = h.ctx.accounts.store.backend === "mongodb" ? h.ctx.mongo!.db : null;
  const postgres = h.ctx.postgres?.rows;
  const db = h.ctx.db;
  const set = async (table: string, id: string, fields: Record<string, unknown>) => {
    if (postgres) { await postgres.write(writer => writer.update(table, {id}, fields)); return; }
    if (mongo) {
      await mongo.collection(table).updateOne({ _id: id as never }, { $set: fields });
      return;
    }
    const keys = Object.keys(fields);
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k] as never), id);
  };
  return {
    async passwordHash(email: string): Promise<string | undefined> {
      if (postgres) return (await h.ctx.accounts.store.accountByEmail(email))?.password_hash;
      if (mongo) return (await mongo.collection("accounts").findOne({ email }))?.password_hash;
      return (db.prepare("SELECT password_hash FROM accounts WHERE email = ?").get(email) as { password_hash: string } | undefined)?.password_hash;
    },
    async codeHashes(): Promise<string[]> {
      if (postgres) return postgres.all<{code_hash: string}>("account_codes").map(row => row.code_hash);
      if (mongo) return (await mongo.collection("account_codes").find({}).toArray()).map((r) => r.code_hash as string);
      return (db.prepare("SELECT code_hash FROM account_codes").all() as { code_hash: string }[]).map((r) => r.code_hash);
    },
    async emailsOfUser(userId: string): Promise<string[]> {
      if (postgres) return postgres.all<{email: string}>("accounts", {where: {user_id: userId}}).map(row => row.email);
      if (mongo) return (await mongo.collection("accounts").find({ user_id: userId }).toArray()).map((r) => r.email as string);
      return (db.prepare("SELECT email FROM accounts WHERE user_id = ?").all(userId) as { email: string }[]).map((r) => r.email);
    },
    async ticketCount(userId: string): Promise<number> {
      if (postgres) return postgres.count("legacy_tickets", {user_id: userId});
      if (mongo) return mongo.collection("legacy_tickets").countDocuments({ user_id: userId });
      return (db.prepare("SELECT COUNT(*) n FROM legacy_tickets WHERE user_id = ?").get(userId) as { n: number }).n;
    },
    async expireTickets(userId: string, at: number): Promise<void> {
      if (postgres) { await postgres.write(writer => writer.update("legacy_tickets", {user_id: userId}, {expires_at: at})); return; }
      if (mongo) await mongo.collection("legacy_tickets").updateMany({ user_id: userId }, { $set: { expires_at: at } });
      else db.prepare("UPDATE legacy_tickets SET expires_at = ? WHERE user_id = ?").run(at, userId);
    },
    async session(id: string): Promise<Record<string, any>> {
      if (postgres) return postgres.get("account_sessions", {id})!;
      if (mongo) return (await mongo.collection("account_sessions").findOne({ _id: id as never }))!;
      return db.prepare("SELECT * FROM account_sessions WHERE id = ?").get(id) as Record<string, any>;
    },
    setAccount: (id: string, fields: Record<string, unknown>) => set("accounts", id, fields),
    setSession: (id: string, fields: Record<string, unknown>) => set("account_sessions", id, fields),
  };
}

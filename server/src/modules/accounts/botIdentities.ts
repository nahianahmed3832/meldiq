import type { DB } from "../../infrastructure/database/db.js";

/**
 * Bot identities for AI agents (docs/AI_WORKFORCE_2_PLAN.md phase 5): users of kind 'agent' with server-held devices,
 * created only by AI Workforce's readers. They have no account, so they can't sign in; search and DMs skip them.
 */
export function createBotUser(db: DB, p: { id: string; username: string; displayName: string; identityKey: string; at: number }): void {
  db.prepare("INSERT INTO users (id, username, display_name, identity_key, avatar_color, created_at, updated_at, kind) VALUES (?, ?, ?, ?, 0, ?, ?, 'agent')").run(
    p.id,
    p.username,
    p.displayName,
    p.identityKey,
    p.at,
    p.at,
  );
}

export function addBotDevice(db: DB, p: { id: string; userId: string; name: string; signingKey: string; encryptionKey: string; certificate: string; at: number }): void {
  db.prepare("INSERT INTO devices (id, user_id, name, signing_key, encryption_key, certificate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.id, p.userId, p.name, p.signingKey, p.encryptionKey, p.certificate, p.at);
}

export function revokeBotDevice(db: DB, deviceId: string, at: number): void {
  db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, deviceId);
}

/** A device's public keys with its owner's identity key (to verify an envelope it signed). */
export function senderKeys(db: DB, deviceId: string, userId: string): { identityKey: string; signingKey: string; encryptionKey: string; certificate: string; kind: string } | null {
  const r = db
    .prepare("SELECT u.identity_key, u.kind, d.signing_key, d.encryption_key, d.certificate FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.user_id = ?")
    .get(deviceId, userId) as { identity_key: string; kind: string; signing_key: string; encryption_key: string; certificate: string } | undefined;
  return r ? { identityKey: r.identity_key, signingKey: r.signing_key, encryptionKey: r.encryption_key, certificate: r.certificate, kind: r.kind } : null;
}

/** A bot's identity key, its name, and one of its devices (null when revoked or someone else's). */
export function botDevice(db: DB, deviceId: string): { userId: string; identityKey: string; displayName: string; signingKey: string; encryptionKey: string; certificate: string } | null {
  const r = db
    .prepare(
      `SELECT u.id user_id, u.identity_key, u.display_name, d.signing_key, d.encryption_key, d.certificate FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.id = ? AND d.revoked_at IS NULL AND u.kind = 'agent'`,
    )
    .get(deviceId) as { user_id: string; identity_key: string; display_name: string; signing_key: string; encryption_key: string; certificate: string } | undefined;
  return r ? { userId: r.user_id, identityKey: r.identity_key, displayName: r.display_name, signingKey: r.signing_key, encryptionKey: r.encryption_key, certificate: r.certificate } : null;
}

export function identityKeyOf(db: DB, userId: string): string | null {
  return (db.prepare("SELECT identity_key FROM users WHERE id = ?").get(userId) as { identity_key: string } | undefined)?.identity_key ?? null;
}

export function isBot(db: DB, userId: string): boolean {
  return (db.prepare("SELECT kind FROM users WHERE id = ?").get(userId) as { kind: string } | undefined)?.kind === "agent";
}

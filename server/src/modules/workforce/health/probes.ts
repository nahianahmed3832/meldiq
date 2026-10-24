import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import type { BlobStore } from "../../../infrastructure/storage/blobstore.js";
import { agentCall, type CallableAgent, commandName } from "../invocation.js";

/**
 * The System Check's safe probes: each exercises the real thing and leaves nothing behind. None calls an AI model,
 * sends a message, or touches a community's records.
 */
export interface ProbeResult {
  ok: boolean;
  detail: string;
  ms: number;
}

async function timed(fn: () => Promise<string>): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const detail = await fn();
    return { ok: true, detail, ms: Math.round(performance.now() - start) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 300) : "failed", ms: Math.round(performance.now() - start) };
  }
}

/** A write and a read in a transaction that is rolled back: the database accepts writes and gives them back. */
export function databaseProbe(db: Database): Promise<ProbeResult> {
  const id = `probe_${crypto.randomBytes(6).toString("hex")}`;
  const rollback = new Error("rollback");
  return timed(async () => {
    let seen = false;
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO ai_system_checks (id, scope, org_id, requested_by, started_at, finished_at, worst, summary, report) VALUES (?, 'platform', NULL, 'probe', 0, 0, 'healthy', '{}', '[]')").run(id);
        seen = db.prepare("SELECT 1 FROM ai_system_checks WHERE id = ?").get(id) !== undefined;
        throw rollback;
      })();
    } catch (e) {
      if (e !== rollback) throw e;
    }
    if (!seen) throw new Error("a row written in a transaction couldn't be read back");
    if (db.prepare("SELECT 1 FROM ai_system_checks WHERE id = ?").get(id)) throw new Error("a rolled-back row is still there");
    return "wrote, read back and rolled back a row";
  });
}

/** A small random file through the AI file store: stored, read back byte for byte (SHA-256), then deleted. */
export function storageProbe(blobs: BlobStore): Promise<ProbeResult> {
  return timed(async () => {
    const id = `syscheck-${crypto.randomBytes(9).toString("hex")}`;
    const bytes = crypto.randomBytes(256);
    const want = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(blobs.spoolDir, { recursive: true });
    const spool = path.join(blobs.spoolDir, `${id}.probe`);
    fs.writeFileSync(spool, bytes);
    try {
      await blobs.putFile("ai-files", id, spool, bytes.length, want);
      const stream = await blobs.get("ai-files", id);
      if (!stream) throw new Error("the stored file couldn't be read back");
      const h = crypto.createHash("sha256");
      for await (const chunk of stream) h.update(chunk as Buffer);
      if (h.digest("hex") !== want) throw new Error("the file read back differs from what was stored");
    } finally {
      fs.rmSync(spool, { force: true });
      await blobs.delete("ai-files", id);
    }
    if (await blobs.exists("ai-files", id)) throw new Error("the test file was still there after deleting it");
    return `stored, read back (SHA-256 matched) and deleted a test file (${blobs.backend})`;
  });
}

/** Free space where the server keeps its data. */
export function diskSpace(dir: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * Whether each agent assigned to a channel can actually be called there by the shared rule: "@Name …" (agents
 * activated by mention) and "/command …" reach that agent and not another one with a longer or equal name.
 */
export function invocationProblems(agents: readonly CallableAgent[]): string[] {
  const problems: string[] = [];
  for (const a of agents) {
    if (a.activation === "explicit") continue;
    const tries = [...(a.activation === "mention" ? [`@${a.displayName} status?`] : []), `/${commandName(a.displayName)} status?`];
    for (const text of tries) {
      const call = agentCall(text, agents);
      if (!commandName(a.displayName)) problems.push(`${a.displayName} has no usable command name`);
      else if (!call) problems.push(`"${text.split(" ")[0]}" doesn't call ${a.displayName}`);
      else if (call.installId !== a.id) problems.push(`"${text.split(" ")[0]}" calls another agent with the same name`);
    }
  }
  return [...new Set(problems)];
}

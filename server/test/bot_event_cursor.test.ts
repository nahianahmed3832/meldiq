import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BotEventCursor,
  BOT_REPLAY_MS,
} from "../src/modules/bots/eventCursor.js";

describe("opaque bot replay cursors", () => {
  const folders: string[] = [];
  const folder = () => {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-bot-cursor-"));
    folders.push(value);
    return value;
  };
  afterEach(() => {
    for (const dir of folders.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });
  it("survives restart with a private key and preserves positions beyond JS integer precision", () => {
    const dir = folder(),
      first = new BotEventCursor(dir);
    const cursor = first.seal("bot-1", "9007199254740999", 10000);
    expect(new BotEventCursor(dir).open("bot-1", cursor, 11000)).toBe(
      "9007199254740999",
    );
    expect(
      fs.statSync(path.join(dir, "bot-event-cursor.key")).mode & 0o777,
    ).toBe(0o600);
    expect(cursor).not.toContain("9007199254740999");
  });
  it("rejects another bot, tampering, future positions' timestamps and expired cursors", () => {
    const codec = new BotEventCursor(folder());
    const cursor = codec.seal("bot-1", "1", 10000);
    expect(() => codec.open("bot-2", cursor, 10001)).toThrow(
      "Invalid bot event cursor",
    );
    expect(() =>
      codec.open("bot-1", cursor.slice(0, -4) + "aaaa", 10001),
    ).toThrow("Invalid bot event cursor");
    expect(() => codec.open("bot-1", cursor, 0)).toThrow(
      "Invalid bot event cursor",
    );
    expect(() => codec.open("bot-1", cursor, 10001 + BOT_REPLAY_MS)).toThrow(
      "expired",
    );
  });
  it("fails closed for permissive files, wrong keys and symlinks", () => {
    const dir = folder(),
      file = path.join(dir, "bot-event-cursor.key");
    fs.writeFileSync(file, Buffer.alloc(32), { mode: 0o644 });
    expect(() => new BotEventCursor(dir)).toThrow("private 32-byte");
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, Buffer.alloc(31));
    expect(() => new BotEventCursor(dir)).toThrow("private 32-byte");
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(folder(), "missing"), file);
    expect(() => new BotEventCursor(dir)).toThrow();
  });
});

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError, badRequest } from "../../shared/errors.js";

export const BOT_REPLAY_MS = 7 * 24 * 60 * 60_000;

/** Opaque positions avoid disclosing a global journal counter or other communities' traffic. */
export class BotEventCursor {
  private readonly key: Buffer;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "bot-event-cursor.key");
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0)
        throw new Error(
          "Bot cursor key must be a private 32-byte regular file",
        );
      this.key = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  seal(botId: string, position: string, now: number): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`meldiq.bot.events.v1:${botId}`));
    const value = Buffer.from(
      JSON.stringify({ v: 1, position, issuedAt: now }),
    );
    if (value.length > 128)
      throw new Error("Bot cursor position exceeds its encoding limit");
    // Fixed-size plaintext also hides the number of digits in the global journal position.
    const padded = Buffer.alloc(128, 0x20);
    value.copy(padded);
    const body = Buffer.concat([cipher.update(padded), cipher.final()]);
    return (
      "be1." +
      Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")
    );
  }

  open(botId: string, cursor: string, now: number): string {
    let value: { v: number; position: string; issuedAt: number };
    try {
      if (!/^be1\.[A-Za-z0-9_-]{40,600}$/.test(cursor)) throw new Error();
      const bytes = Buffer.from(cursor.slice(4), "base64url");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(`meldiq.bot.events.v1:${botId}`));
      decipher.setAuthTag(bytes.subarray(-16));
      value = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(12, -16)),
          decipher.final(),
        ]).toString(),
      );
      if (
        value.v !== 1 ||
        !/^(0|[1-9][0-9]{0,18})$/.test(value.position) ||
        !Number.isSafeInteger(value.issuedAt) ||
        value.issuedAt > now + 5_000
      )
        throw new Error();
    } catch {
      throw badRequest("Invalid bot event cursor");
    }
    if (now - value.issuedAt > BOT_REPLAY_MS)
      throw new ApiError(
        410,
        "bot_cursor_expired",
        "The replay cursor expired. Start a fresh event feed.",
      );
    return value.position;
  }
}

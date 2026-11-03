import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Console } from "node:console";
import { Writable } from "node:stream";
import type { AppContext } from "./context.js";
import { runOperatorCommand } from "./operatorCommand.js";
import { PostgresRelayStore } from "../modules/messaging/relay/postgresStore.js";

const REQUEST_LIMIT = 32 * 1024,
  OUTPUT_LIMIT = 2 * 1024 * 1024;
export function operatorSocketPath(dataDir: string): string {
  return path.join(dataDir, ".ops", "socket");
}
export interface OperatorReply {
  code: number;
  stdout: string;
  stderr: string;
}
function request(value: unknown): value is { command: string; args: string[] } {
  if (!value || typeof value !== "object") return false;
  const r = value as { command?: unknown; args?: unknown };
  return typeof r.command === "string" && /^[a-z][a-z0-9-]{0,80}$/.test(r.command) && Array.isArray(r.args) && r.args.length <= 64 && r.args.every((a) => typeof a === "string" && a.length <= 4096);
}
async function isListening(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(file);
    const finish = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish((error as NodeJS.ErrnoException).code !== "ECONNREFUSED"));
  });
}
/** Private same-UID IPC. No network listener, shell invocation, or second PostgreSQL writer. */
export async function openOperatorSocket(ctx: AppContext): Promise<() => Promise<void>> {
  if (!ctx.postgres) throw new Error("The local operator socket requires the active PostgreSQL runtime");
  const file = operatorSocketPath(ctx.config.dataDir);
  const directory = path.dirname(file);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || parent.mode & 0o077) throw new Error("Operator socket directory must be private and owned by this process");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (await isListening(file))) throw new Error("Operator socket path is already in use or unsafe");
    fs.unlinkSync(file);
  }
  let tail = Promise.resolve(),
    closing = false;
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(60_000, () => socket.destroy());
    let input = "",
      received = false;
    socket.on("data", (data) => {
      if (received) {
        socket.destroy();
        return;
      }
      input += data.toString("utf8");
      if (Buffer.byteLength(input) > REQUEST_LIMIT) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      received = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(input);
      } catch {
        socket.end(
          JSON.stringify({
            code: 2,
            stdout: "",
            stderr: "Invalid operator request\n",
          }) + "\n",
        );
        return;
      }
      if (closing || !request(parsed)) {
        socket.end(
          JSON.stringify({
            code: 2,
            stdout: "",
            stderr: "Invalid operator request\n",
          }) + "\n",
        );
        return;
      }
      const command = parsed;
      tail = tail
        .then(async () => {
          if (socket.destroyed) return;
          const reply: OperatorReply = { code: 0, stdout: "", stderr: "" };
          let bytes = 0,
            truncated = false;
          const output = (field: "stdout" | "stderr") =>
            new Writable({
              write(chunk, _encoding, done) {
                bytes += chunk.length;
                if (bytes <= OUTPUT_LIMIT) reply[field] += chunk.toString();
                else truncated = true;
                done();
              },
            });
          const console = new Console({
            stdout: output("stdout"),
            stderr: output("stderr"),
            colorMode: false,
          });
          try {
            ctx.postgres!.rows.assertAvailable();
            reply.code = await runOperatorCommand(command.command, command.args, ctx, console);
            await ctx.postgres!.rows.settled();
            await ctx.files.settled();
            if (ctx.relay instanceof PostgresRelayStore) await ctx.relay.settled();
          } catch (error) {
            reply.code = 1;
            console.error(error instanceof Error ? error.message : "Operator command failed");
          }
          if (truncated) {
            reply.code = 1;
            reply.stderr += "\nOperator output exceeded the limit; narrow the query.\n";
          }
          socket.end(JSON.stringify(reply) + "\n");
        })
        .catch(() => {
          socket.destroy();
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  fs.chmodSync(file, 0o600);
  return async () => {
    closing = true;
    const stopped = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await tail;
    for (const socket of peers) socket.destroy();
    await stopped;
  };
}

export async function callOperatorSocket(file: string, command: string, args: string[]): Promise<OperatorReply> {
  if (!request({ command, args })) throw new Error("Invalid operator command");
  const stat = fs.lstatSync(file);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error("A private local operator socket is required");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.setEncoding("utf8");
    let text = "",
      complete = false;
    const fail = () => {
      if (!complete) {
        complete = true;
        reject(new Error("The active PostgreSQL operator service is unavailable; no legacy database was opened"));
      }
      socket.destroy();
    };
    socket.setTimeout(60_000, fail);
    socket.once("error", fail);
    socket.once("end", () => {
      if (!complete) fail();
    });
    socket.once("connect", () => socket.write(JSON.stringify({ command, args }) + "\n"));
    socket.on("data", (data) => {
      text += data.toString("utf8");
      if (Buffer.byteLength(text) > OUTPUT_LIMIT + 64 * 1024) {
        fail();
        return;
      }
      if (!text.includes("\n")) return;
      try {
        const reply = JSON.parse(text) as OperatorReply;
        if (!Number.isInteger(reply.code) || typeof reply.stdout !== "string" || typeof reply.stderr !== "string") throw new Error();
        complete = true;
        socket.destroy();
        resolve(reply);
      } catch {
        fail();
      }
    });
  });
}

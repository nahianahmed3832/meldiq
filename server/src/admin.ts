import path from "node:path";
import { runOperatorCommand } from "./modules/administration/operatorCommand.js";
import { callOperatorSocket, operatorSocketPath } from "./modules/administration/operatorSocket.js";

const [command = "help", ...args] = process.argv.slice(2);
try {
  if (process.env.DATABASE_MODE?.trim() === "supabase") {
    const file = operatorSocketPath(path.resolve(process.env.DATA_DIR ?? "./data"));
    const reply = await callOperatorSocket(file, command, args);
    process.stdout.write(reply.stdout);
    process.stderr.write(reply.stderr);
    process.exitCode = reply.code;
  } else process.exitCode = await runOperatorCommand(command, args);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Operator command failed");
  process.exitCode = 1;
}

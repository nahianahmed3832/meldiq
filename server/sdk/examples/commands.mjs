import { MeldiqBot, MeldiqBotError } from "../javascript/index.mjs";

const bot = new MeldiqBot({ apiOrigin: process.env.MELDIQ_API_ORIGIN, token: process.env.MELDIQ_BOT_TOKEN });
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

try {
  await bot.setCommands([{ name: "hello", description: "A private greeting from this bot", options: [] }], { signal: stop.signal });
  while (!stop.signal.aborted) {
    const batch = await bot.interactions({ wait: 20, signal: stop.signal });
    for (const interaction of batch.interactions) {
      await bot.reply(interaction.id, "Hello from your Meldiq bot.", { ephemeral: true, signal: stop.signal });
    }
  }
} catch (error) {
  if (!stop.signal.aborted) {
    // No request objects, headers, environment values or raw handler errors are logged.
    process.stderr.write(error instanceof MeldiqBotError ? `Bot stopped: ${error.code} (${error.status})\n` : "Bot stopped: check its local configuration\n");
    process.exitCode = 1;
  }
}

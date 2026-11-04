import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import {
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
  dispose,
} from "@livekit/rtc-node";
import { MeldiqBot, MeldiqBotError } from "../javascript/index.mjs";
import { createVoiceKeys, openVoiceKey } from "../javascript/voice.mjs";

// Optional example running on the operator's own infrastructure. No media recording or file writes.
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
let bot, lease, room, renewal, prompt;
try {
  bot = new MeldiqBot({
    apiOrigin: process.env.MELDIQ_API_ORIGIN,
    token: process.env.MELDIQ_BOT_TOKEN,
  });
  const channelId = process.env.MELDIQ_VOICE_CHANNEL;
  if (!channelId) throw new TypeError("Configure a voice channel");
  const voice = await createVoiceKeys();
  // Only public configuration is printed. Never print voice.keys, the room key, media grant or bot token.
  process.stdout.write(
    `Public X25519 key: ${voice.publicKey}\nSHA-256 fingerprint: ${voice.fingerprint}\n`,
  );
  prompt = createInterface({ input: process.stdin, output: process.stdout });
  await prompt.question(
    "Configure this public key, request voice.connect, and obtain manager review. Press Enter after approval: ",
    { signal: stop.signal },
  );
  prompt.close();
  prompt = undefined;
  lease = await bot.joinVoice(channelId, {
    requestId: crypto.randomUUID(),
    signal: stop.signal,
  });
  renewal = setInterval(() => {
    void bot
      .renewVoice(lease.leaseId, { signal: stop.signal })
      .catch(() => stop.abort());
  }, 15_000);
  const deadline = Date.now() + 30_000;
  let response;
  do {
    response = await bot.voiceKey(lease.leaseId, { signal: stop.signal });
    if (response.key) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (!stop.signal.aborted && Date.now() < deadline);
  const keyText = await openVoiceKey(voice.keys, response);
  room = new Room();
  room.on(RoomEvent.Disconnected, () => stop.abort());
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    // Consume frames without storing them, logging contents or publishing a track.
    void (async () => {
      for await (const _ of new AudioStream(track, 48000, 1))
        if (stop.signal.aborted) break;
    })().catch(() => stop.abort());
  });
  await room.connect(lease.media.url, lease.media.token, {
    autoSubscribe: true,
    encryption: {
      keyProviderOptions: { sharedKey: new TextEncoder().encode(keyText) },
    },
  });
  await bot.voiceConnected(lease.leaseId, { signal: stop.signal });
  process.stdout.write("Voice listener connected. Press Ctrl+C to leave.\n");
  if (!stop.signal.aborted) await once(stop.signal, "abort");
} catch (error) {
  if (!stop.signal.aborted) {
    process.stderr.write(
      error instanceof MeldiqBotError
        ? `Voice listener stopped: ${error.code} (${error.status})\n`
        : "Voice listener stopped: check its local configuration and optional dependencies\n",
    );
    process.exitCode = 1;
  }
} finally {
  clearInterval(renewal);
  prompt?.close();
  await room?.disconnect().catch(() => undefined);
  if (bot && lease) await bot.leaveVoice(lease.leaseId).catch(() => undefined);
  await dispose();
}

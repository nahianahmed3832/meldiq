import { z } from "zod/v4";

const id = z.string().min(1).max(64);
export const BotVoiceKeyRequest = z.strictObject({
  leaseId: id,
  botId: id,
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  manifestRev: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});
export type BotVoiceKeyRequest = z.infer<typeof BotVoiceKeyRequest>;
/** HPKE X25519 encapsulation and AES-256-GCM ciphertext of exactly one 32-byte media key. */
export const BotVoicePacket = z.strictObject({
  enc: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  ct: z.string().regex(/^[A-Za-z0-9+/]{64}$/),
});
export type BotVoicePacket = z.infer<typeof BotVoicePacket>;
export const BotVoiceLease = z.strictObject({
  leaseId: id,
  botId: id,
  callId: id,
  channelId: id,
  manifestRev: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});
export const BOT_VOICE_HPKE_INFO = "meldiq-bot-voice-v1";
export const botVoiceAad = (
  callId: string,
  channelId: string,
  botId: string,
  leaseId: string,
  manifestRev: number,
) =>
  JSON.stringify([
    BOT_VOICE_HPKE_INFO,
    callId,
    channelId,
    botId,
    leaseId,
    manifestRev,
  ]);

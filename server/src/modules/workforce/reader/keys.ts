import crypto from "node:crypto";
import { canonical, type Ed25519Pair, ed25519FromSeed, newEd25519, newX25519, seal, sign, unseal } from "../../../infrastructure/crypto/envelope.js";

/**
 * Key custody for agents' reader devices (docs/AI_WORKFORCE_2_PLAN.md phase 5, docs/AI_AGENT_CHANNEL_READ_PROPOSAL.md
 * §6.2). Two keys are derived from PLATFORM_SECRETS_KEY with their own labels: one seals each agent's identity seed,
 * one wraps each reader's own random key, which seals that reader's device keys and everything it keeps. Deleting a
 * reader's wrapped key (switch-off) leaves its device keys and context unreadable. Without PLATFORM_SECRETS_KEY no
 * reader can exist.
 */
const IDENTITY_LABEL = "meldiq-ai-agent-identity-v1";
const WRAP_LABEL = "meldiq-ai-reader-wrap-v1";
const KEY_BYTES = 32;

export interface ReaderDeviceKeys {
  signing: Ed25519Pair;
  encPriv: Buffer;
  /** The per-reader key: seals what the reader keeps. */
  key: Buffer;
}

export interface NewReaderDevice {
  wrappedKey: string;
  sealedKeys: string;
  signingKey: string;
  encryptionKey: string;
  certificate: string;
}

export class ReaderKeys {
  private readonly identityKey: Buffer | null;
  private readonly wrapKey: Buffer | null;

  constructor(master: Buffer | null) {
    const derive = (label: string) => (master ? Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), label, KEY_BYTES)) : null);
    this.identityKey = derive(IDENTITY_LABEL);
    this.wrapKey = derive(WRAP_LABEL);
  }

  get available(): boolean {
    return this.identityKey !== null && this.wrapKey !== null;
  }

  private require(k: Buffer | null): Buffer {
    if (!k) throw new Error("PLATFORM_SECRETS_KEY is not set: agents can't hold reader keys");
    return k;
  }

  /** A new agent identity: its sealed seed (stored) and the key pair. */
  newIdentity(installId: string): { sealedSeed: string; pair: Ed25519Pair } {
    const pair = newEd25519();
    return { sealedSeed: seal(this.require(this.identityKey), pair.seed, `identity:${installId}`), pair };
  }

  identity(installId: string, sealedSeed: string): Ed25519Pair {
    return ed25519FromSeed(unseal(this.require(this.identityKey), sealedSeed, `identity:${installId}`));
  }

  /** A device for one reader: keys certified by the agent's identity, sealed under a fresh per-reader key. */
  newDevice(readerId: string, identity: Ed25519Pair): NewReaderDevice {
    const signing = newEd25519();
    const enc = newX25519();
    const key = crypto.randomBytes(KEY_BYTES);
    const identityB64 = identity.pub.toString("base64");
    const signingKey = signing.pub.toString("base64");
    const encryptionKey = enc.pub.toString("base64");
    return {
      wrappedKey: seal(this.require(this.wrapKey), key, `reader:${readerId}`),
      sealedKeys: seal(key, Buffer.from(JSON.stringify({ signingSeed: signing.seed.toString("base64"), encPriv: enc.priv.toString("base64") })), `device:${readerId}`),
      signingKey,
      encryptionKey,
      certificate: sign(identity, canonical.deviceCert(identityB64, signingKey, encryptionKey)),
    };
  }

  open(readerId: string, wrappedKey: string, sealedKeys: string): ReaderDeviceKeys {
    const key = unseal(this.require(this.wrapKey), wrappedKey, `reader:${readerId}`);
    const k = JSON.parse(unseal(key, sealedKeys, `device:${readerId}`).toString("utf8")) as { signingSeed: string; encPriv: string };
    return { signing: ed25519FromSeed(Buffer.from(k.signingSeed, "base64")), encPriv: Buffer.from(k.encPriv, "base64"), key };
  }

  /** Text a reader keeps, bound to its message. */
  sealText(key: Buffer, readerId: string, messageId: string, text: string): string {
    return seal(key, Buffer.from(JSON.stringify({ text }), "utf8"), `context:${readerId}:${messageId}`);
  }

  openText(key: Buffer, readerId: string, messageId: string, sealed: string): string {
    return (JSON.parse(unseal(key, sealed, `context:${readerId}:${messageId}`).toString("utf8")) as { text: string }).text;
  }
}

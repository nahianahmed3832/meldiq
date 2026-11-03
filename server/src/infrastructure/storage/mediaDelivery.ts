import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export function mediaDeliveryConfig(env: NodeJS.ProcessEnv) {
  if (!env.MEDIA_PUBLIC_BASE_URL) return null;
  const origin = new URL(env.MEDIA_PUBLIC_BASE_URL);
  if (origin.protocol !== "https:" || origin.href !== origin.origin + "/") throw Error("Invalid media delivery origin");
  if (!/^[a-f0-9]{64}$/i.test(env.MEDIA_GRANT_KEY ?? "") || !/^[a-f0-9]{64}$/i.test(env.MEDIA_EDGE_SECRET ?? "") ||
      env.MEDIA_GRANT_KEY === env.MEDIA_EDGE_SECRET) throw Error("Independent 256-bit media secrets required");
  return { origin: origin.origin, key: Buffer.from(env.MEDIA_GRANT_KEY!, "hex"), edge: env.MEDIA_EDGE_SECRET! };
}
type Delivery = NonNullable<ReturnType<typeof mediaDeliveryConfig>>;

// Only the API can open a grant. Bind it to one attachment and reauthenticate the
// session on redemption so that device or session revocation also revokes access.
export function mediaUrl(config: Delivery, id: string, bearer: string, now: number) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.key, nonce);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify([now + 60_000, bearer])), cipher.final()]);
  const ticket = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  return config.origin + "/attachments/" + encodeURIComponent(id) + "?ticket=" + ticket;
}

export function openMediaGrant(config: Delivery, id: string, ticket: unknown, edge: unknown, now: number): string | undefined {
  if (typeof edge !== "string" || !/^[a-f0-9]{64}$/i.test(edge) || !timingSafeEqual(Buffer.from(edge), Buffer.from(config.edge))) return;
  if (typeof ticket !== "string" || ticket.length > 14000 || !/^[A-Za-z0-9_-]+$/.test(ticket)) return;
  try {
    const bytes = Buffer.from(ticket, "base64url");
    const cipher = createDecipheriv("aes-256-gcm", config.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const [expires, session] = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    if (Number.isSafeInteger(expires) && now < expires && typeof session === "string") return session;
  } catch { /* Malformed, expired and wrong-file grants receive the same response. */ }
}

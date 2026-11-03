import crypto from "node:crypto";
import type { AppContext } from "../../app/context.js";
import { now } from "../../shared/utilities/util.js";

const ttl = 120_000;
function mac(key: Buffer, body: Buffer) {
  const derived = crypto.createHmac("sha256", key).update("meldiq/device-challenge/v1").digest();
  return crypto.createHmac("sha256", derived).update(body).digest().subarray(0,16);
}

/** Mint without a WAN write. Restart-safe with the configured key; legacy unsigned nonces
 * already in flight are still redeemable. Only the single PostgreSQL writer uses spent markers. */
export async function issueChallenge(ctx: AppContext) {
  const t = now(), expiresAt = t + ttl;
  if (ctx.postgres && ctx.config.platformSecretsKey) {
    ctx.postgres.rows.assertAvailable();
    const body = crypto.randomBytes(30); // 6-byte expiry + 24 bytes of entropy
    body.writeUIntBE(expiresAt,0,6);
    return {nonce: Buffer.concat([body,mac(ctx.config.platformSecretsKey,body)]).toString("base64url"), expiresAt};
  }
  const nonce = crypto.randomBytes(24).toString("base64url");
  await ctx.ephemeral.write(w => w.insert("auth_challenges", {nonce, created_at:t, expires_at:expiresAt}));
  return {nonce, expiresAt};
}

export function consumeChallenge(ctx: AppContext, nonce: string): Promise<boolean> {
  return ctx.ephemeral.write(w => {
    const t = now();
    if (/^[A-Za-z0-9_-]{32}$/.test(nonce)) return w.delete("auth_challenges", {nonce, expires_at:{gt:t}})>0;
    if (!ctx.postgres || !ctx.config.platformSecretsKey || !/^[A-Za-z0-9_-]{62}$/.test(nonce)) return false;
    const data=Buffer.from(nonce,"base64url");
    if (data.toString("base64url")!==nonce) return false;
    const expiry=data.readUIntBE(0,6);
    if (expiry<=t || expiry>t+ttl || !crypto.timingSafeEqual(data.subarray(30),mac(ctx.config.platformSecretsKey,data.subarray(0,30)))) return false;
    // Outside every released HTTP nonce length limit (including v3). Older runtimes can
    // neither redeem nor delete the spent marker after a rollback. Existing expiry GC removes it.
    const marker="spent:"+crypto.createHash("sha512").update(data).digest("hex");
    return w.insert("auth_challenges",{nonce:marker,created_at:t,expires_at:expiry},{orIgnore:true}).inserted;
  });
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import type { MeldiqPostgres } from "../../infrastructure/database/postgres/client.js";
import type { SupabaseAccessVerifier, SupabasePrincipal } from "../../infrastructure/database/postgres/auth.js";

export interface SupabaseTransportDeps {
  postgres: MeldiqPostgres;
  verifier: SupabaseAccessVerifier;
  /** Must call the application's complete current authorization/device rules. No default allow implementation. */
  authorizeRealtime(principal: SupabasePrincipal, conversationId: string): Promise<{ presence: boolean; typing: boolean }>;
}
const topicRequest = z.strictObject({ conversationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });

/** Staged transport plugin. Register only after the legacy identity/device boundary has been migrated.
 * Its caller supplies the full business authorizer; this module never infers roles from client metadata.
 */
export async function registerSupabaseTransport(app: FastifyInstance, deps: SupabaseTransportDeps) {
  async function principal(request: FastifyRequest): Promise<SupabasePrincipal> {
    const header=request.headers.authorization;
    const token=header?.startsWith("Bearer ")?header.slice(7):null;
    const resolved=token?await deps.verifier.verify(token):null;
    if(!resolved)throw Object.assign(new Error("Authentication required"),{statusCode:401});
    return resolved;
  }
  app.addHook("onSend",async(request,reply,payload)=>{
    if(request.url.startsWith("/v3/"))reply.header("Cache-Control","private, no-store");
    return payload;
  });
  app.get("/v3/auth/me",async(request)=>{
    const owner=await principal(request);
    return {authUserId:owner.authUserId,accountId:owner.accountId,userId:owner.userId};
  });
  app.post("/v3/realtime/grants",{bodyLimit:2048},async(request)=>{
    const owner=await principal(request);
    const body=topicRequest.safeParse(request.body);
    if(!body.success)throw Object.assign(new Error("Invalid conversation request"),{statusCode:400});
    const rights=await deps.authorizeRealtime(owner,body.data.conversationId);
    const topics=[`conversation:${body.data.conversationId}`];
    if(rights.presence||rights.typing)topics.push(`ephemeral:${body.data.conversationId}`);
    await deps.postgres.transaction(async()=>{
      for(const topic of topics)await deps.postgres.query(`INSERT INTO meldiq_private.realtime_grants(auth_user_id,topic,expires_at,presence,ephemeral_broadcast)
        VALUES($1,$2,now()+interval '2 minutes',$3,$4) ON CONFLICT(auth_user_id,topic) DO UPDATE
        SET expires_at=excluded.expires_at,presence=excluded.presence,ephemeral_broadcast=excluded.ephemeral_broadcast`,
        [owner.authUserId,topic,topic.startsWith("ephemeral:")&&rights.presence,topic.startsWith("ephemeral:")&&rights.typing]);
    });
    return {topics,expiresIn:120};
  });
}

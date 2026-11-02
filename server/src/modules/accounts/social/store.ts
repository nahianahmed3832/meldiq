import type { AppContext } from "../../../app/context.js";
import { ApiError } from "../../../shared/errors.js";
import { isDuplicateKey } from "../../../infrastructure/database/mongo/client.js";
import type { SocialProvider } from "./config.js";
import { PostgresRows } from "../../../infrastructure/database/rows/postgresRows.js";
export interface ExternalIdentity {
  provider: SocialProvider;
  issuer: string;
  subject: string;
  email: string | null;
  displayName?: string;
}
export interface SocialIdentity extends ExternalIdentity {
  id: string;
  account_id: string;
  connected_at: number;
}
export interface SocialFlow {
  id: string;
  provider: SocialProvider;
  challenge: string;
  verifier: string;
  cookie: string;
  accountId: string | null;
  sessionId: string | null;
  platform: "web" | "android";
  nonce: string;
  receiptHash?: string;
  identity?: ExternalIdentity;
  stage: "pending" | "authorizing" | "exchanging" | "ready" | "used";
  expiresAt: number;
}
/** Uses exactly the account domain's backend and surrounding transaction. No second identity database. */
export class SocialStore {
  constructor(private readonly ctx: AppContext) {}
  private get postgres(): PostgresRows | undefined {
    return this.ctx.accounts.store.backend === "postgres" && this.ctx.identity instanceof PostgresRows ? this.ctx.identity : undefined;
  }
  private get mongo() {
    return this.ctx.mongo?.owns("accounts") ? this.ctx.mongo : undefined;
  }
  private get options() {
    return { session: this.mongo?.session() };
  }
  async insertFlow(f: SocialFlow): Promise<void> {
    const r = {
      id: f.id,
      data: JSON.stringify(f),
      stage: f.stage,
      expires_at: f.expiresAt,
    };
    if (this.postgres) { await this.postgres.write(writer => writer.insert("account_social_flows", r)); return; }
    if (this.mongo)
      await this.mongo.db
        .collection("account_social_flows")
        .insertOne({ _id: f.id as never, ...r }, this.options);
    else
      this.ctx.db
        .prepare("INSERT INTO account_social_flows VALUES (?, ?, ?, ?)")
        .run(r.id, r.data, r.stage, r.expires_at);
  }
  async flow(id: string): Promise<SocialFlow | null> {
    if (this.postgres) {
      const row = this.postgres.get<{data: string; stage: SocialFlow["stage"]}>("account_social_flows", {id});
      return row ? {...JSON.parse(row.data), stage: row.stage} as SocialFlow : null;
    }
    const r = this.mongo
      ? await this.mongo.db
          .collection("account_social_flows")
          .findOne({ id }, this.options)
      : (this.ctx.db
          .prepare("SELECT data, stage FROM account_social_flows WHERE id = ?")
          .get(id) as { data: string; stage: SocialFlow["stage"] } | undefined);
    return r
      ? ({ ...JSON.parse(r.data as string), stage: r.stage } as SocialFlow)
      : null;
  }
  async replace(
    f: SocialFlow,
    expected: SocialFlow["stage"],
  ): Promise<boolean> {
    if (this.postgres) return this.postgres.write(writer => writer.update("account_social_flows", {id: f.id, stage: expected}, {data: JSON.stringify(f), stage: f.stage}) === 1);
    if (this.mongo)
      return (
        (
          await this.mongo.db
            .collection("account_social_flows")
            .updateOne(
              { id: f.id, stage: expected },
              { $set: { data: JSON.stringify(f), stage: f.stage } },
              this.options,
            )
        ).modifiedCount === 1
      );
    return (
      this.ctx.db
        .prepare(
          "UPDATE account_social_flows SET data = ?, stage = ? WHERE id = ? AND stage = ?",
        )
        .run(JSON.stringify(f), f.stage, f.id, expected).changes === 1
    );
  }
  async find(i: ExternalIdentity): Promise<SocialIdentity | null> {
    const { provider, issuer, subject } = i;
    if (this.postgres) return this.postgres.get<SocialIdentity>("account_social_identities", {provider, issuer, subject}) ?? null;
    return (
      ((this.mongo
        ? await this.mongo.db
            .collection("account_social_identities")
            .findOne({ provider, issuer, subject }, this.options)
        : this.ctx.db
            .prepare(
              "SELECT * FROM account_social_identities WHERE provider = ? AND issuer = ? AND subject = ?",
            )
            .get(provider, issuer, subject)) as SocialIdentity | null) ?? null
    );
  }
  async list(accountId: string): Promise<SocialIdentity[]> {
    if (this.postgres) return this.postgres.all("account_social_identities", {where: {account_id: accountId}});
    return (
      this.mongo
        ? await this.mongo.db
            .collection("account_social_identities")
            .find({ account_id: accountId }, this.options)
            .toArray()
        : this.ctx.db
            .prepare(
              "SELECT * FROM account_social_identities WHERE account_id = ?",
            )
            .all(accountId)
    ) as SocialIdentity[];
  }
  async link(i: SocialIdentity): Promise<void> {
    try {
      if (this.postgres) {
        await this.postgres.write(writer => writer.insert("account_social_identities", {
          id: i.id, account_id: i.account_id, provider: i.provider, issuer: i.issuer, subject: i.subject, email: i.email, connected_at: i.connected_at,
        }));
        return;
      }
      if (this.mongo)
        await this.mongo.db
          .collection("account_social_identities")
          .insertOne(
            {
              _id: i.id as never,
              id: i.id,
              account_id: i.account_id,
              provider: i.provider,
              issuer: i.issuer,
              subject: i.subject,
              email: i.email,
              connected_at: i.connected_at,
            },
            this.options,
          );
      else
        this.ctx.db
          .prepare(
            "INSERT INTO account_social_identities VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            i.id,
            i.account_id,
            i.provider,
            i.issuer,
            i.subject,
            i.email,
            i.connected_at,
          );
    } catch (e) {
      if (
        isDuplicateKey(e) ||
        (e as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")
      )
        throw new ApiError(
          409,
          "identity_conflict",
          "This provider is already connected. Sign in to its Meldiq account or use account recovery; accounts cannot be merged automatically.",
        );
      throw e;
    }
  }
  async unlink(accountId: string, provider: SocialProvider): Promise<void> {
    if (this.postgres) { await this.postgres.write(writer => writer.delete("account_social_identities", {account_id: accountId, provider})); return; }
    if (this.mongo)
      await this.mongo.db
        .collection("account_social_identities")
        .deleteOne({ account_id: accountId, provider }, this.options);
    else
      this.ctx.db
        .prepare(
          "DELETE FROM account_social_identities WHERE account_id = ? AND provider = ?",
        )
        .run(accountId, provider);
  }
  async purge(): Promise<number> {
    if (this.postgres) return this.postgres.write(writer => writer.delete("account_social_flows", {expires_at: {lte: Date.now()}}));
    if (this.mongo)
      return (
        await this.mongo.db
          .collection("account_social_flows")
          .deleteMany({ expires_at: { $lte: Date.now() } })
      ).deletedCount;
    return this.ctx.db
      .prepare("DELETE FROM account_social_flows WHERE expires_at <= ?")
      .run(Date.now()).changes;
  }
}

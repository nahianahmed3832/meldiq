import crypto from "node:crypto";
import type { z } from "zod/v4";
import type { AppContext } from "../../app/context.js";
import { networkKey } from "../../app/middleware/abuse.js";
import {
  type AccountRow,
  deleteOperatorAccount,
  insertOperatorAccount,
  listOperatorAccounts,
  type OperatorAccountRow,
  operatorAccount,
  staticCodeHash,
  updateOperatorVerification,
} from "../accounts/index.js";
import type { AdminAccountCreateBody, AdminAccountVerificationBody, AdminCreatedAccountsQuery } from "../../shared/contracts/http/platformAdminInsights.js";
import { ApiError, badRequest } from "../../shared/errors.js";
import { newId, now } from "../../shared/utilities/util.js";
import type { PlatformAudit } from "./audit.js";
import type { AdminPrincipal } from "./auth.js";
import type { RequestMeta } from "./credentials.js";
import { decodeCursor, encodeCursor } from "./pagination.js";
import { can } from "./permissions.js";

type CreateBody = z.infer<typeof AdminAccountCreateBody>;
type VerificationBody = z.infer<typeof AdminAccountVerificationBody>;
type ListQuery = z.infer<typeof AdminCreatedAccountsQuery>;

/** Bytes of randomness in a generated password (24 characters of base64url). */
const GENERATED_PASSWORD_BYTES = 18;

/**
 * Accounts made in the Platform Admin Console (docs/ADMIN_ACCOUNTS.md): an operator creates an email-and-password
 * account and chooses how it proves its address — at once (verified), with a fixed tester code, or with the normal
 * emailed code. The operator row and its audit entry are one platform unit; the account is made in the accounts domain.
 */
export class AdminAccounts {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: PlatformAudit,
  ) {}

  async create(p: AdminPrincipal, b: CreateBody, meta: RequestMeta) {
    const accounts = this.ctx.accounts;
    if (b.verification === "email" && b.sendCode && !accounts.mailer.available) throw new ApiError(503, "email_unavailable", "This server can't send email right now. Choose another verification, or don't send the code yet.");
    if (await accounts.store.accountByEmail(b.email)) throw new ApiError(409, "email_taken", "That email already has a Meldiq account.");
    const id = newId("acc");
    const generated = b.password === undefined ? crypto.randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url") : null;
    const t = now();
    // The operator row comes first: an account never exists without it, so its tester code and protection hold at once.
    await this.ctx.platform.write((w) => {
      insertOperatorAccount(w, this.row(p, id, b, t));
      this.audit.append(w, {
        action: "account.create",
        outcome: "success",
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        targetType: "account",
        targetId: id,
        reason: b.reason,
        requestId: meta.requestId,
        network: networkKey(meta.ip),
        detail: { verification: b.verification, tester: b.tester, codeEnds: b.codeExpiresAt ?? null },
      });
    });
    let created: AccountRow | null = null;
    try {
      created = await accounts.service.createByOperator({ id, name: b.name, email: b.email, password: b.password ?? generated!, verified: b.verification === "verified" });
    } finally {
      if (!created) await this.ctx.platform.write((w) => deleteOperatorAccount(w, id));
    }
    if (!created) throw new ApiError(409, "email_taken", "That email already has a Meldiq account.");
    let codeSent = false;
    if (b.verification === "email" && b.sendCode) {
      await accounts.service.sendCode(created, "verify_email", null);
      codeSent = true;
    }
    const row = operatorAccount(this.ctx.platform, id)!;
    return { account: (await this.views(p, [row]))[0]!, password: generated, codeSent };
  }

  async list(p: AdminPrincipal, q: ListQuery) {
    const rows = listOperatorAccounts(this.ctx.platform, decodeCursor(q.cursor), q.limit);
    const shown = rows.slice(0, q.limit);
    const last = shown[shown.length - 1];
    const nextCursor = rows.length > q.limit && last ? encodeCursor({ createdAt: last.created_at, id: last.account_id }) : null;
    return { accounts: await this.views(p, shown), nextCursor };
  }

  /** Changes how an operator-made account proves its email; "verified" also marks the address proven now. */
  async setVerification(p: AdminPrincipal, accountId: string, b: VerificationBody, meta: RequestMeta) {
    const before = operatorAccount(this.ctx.platform, accountId);
    if (!before) throw new ApiError(404, "not_found", "No account made in the console has that id.");
    const account = await this.ctx.accounts.store.accountById(accountId);
    if (!account) throw new ApiError(404, "not_found", "That account was deleted.");
    const t = now();
    await this.ctx.platform.write((w) => {
      const next = this.row(p, accountId, { ...b, tester: before.tester === 1, note: before.note ?? undefined }, t);
      updateOperatorVerification(w, accountId, { verification: next.verification, code_hash: next.code_hash, code_expires_at: next.code_expires_at, updated_by: p.account.id, updated_at: t });
      this.audit.append(w, {
        action: "account.verification",
        outcome: "success",
        actorAccountId: p.account.id,
        actorRole: p.grant.role,
        targetType: "account",
        targetId: accountId,
        reason: b.reason,
        requestId: meta.requestId,
        network: networkKey(meta.ip),
        detail: { before: before.verification, after: b.verification, codeEnds: b.codeExpiresAt ?? null },
      });
    });
    if (b.verification === "verified" && !account.email_verified_at) await this.ctx.accounts.service.markVerified(accountId);
    return { account: (await this.views(p, [operatorAccount(this.ctx.platform, accountId)!]))[0]! };
  }

  private row(p: AdminPrincipal, id: string, b: { verification: OperatorAccountRow["verification"]; staticCode?: string; codeExpiresAt?: number; tester: boolean; note?: string }, t: number): OperatorAccountRow {
    if (b.codeExpiresAt !== undefined && b.codeExpiresAt <= t) throw badRequest("The fixed code's end must be in the future.");
    return {
      account_id: id,
      verification: b.verification,
      code_hash: b.verification === "static_code" ? staticCodeHash(id, b.staticCode!) : null,
      code_expires_at: b.verification === "static_code" ? (b.codeExpiresAt ?? null) : null,
      tester: b.tester ? 1 : 0,
      note: b.note ?? null,
      created_by: p.account.id,
      created_at: t,
      updated_by: p.account.id,
      updated_at: t,
    };
  }

  private async views(p: AdminPrincipal, rows: OperatorAccountRow[]) {
    const showEmail = can(p.grant.role, "users.view_email");
    const names = new Map<string, string>();
    const out = [];
    for (const r of rows) {
      const a = await this.ctx.accounts.store.accountById(r.account_id);
      if (!names.has(r.created_by)) names.set(r.created_by, (await this.ctx.accounts.store.accountById(r.created_by))?.name ?? "");
      out.push({
        accountId: r.account_id,
        name: a?.name ?? "Deleted account",
        email: a && showEmail ? a.email : null,
        verification: r.verification,
        verified: !!a?.email_verified_at,
        codeExpiresAt: r.code_expires_at,
        tester: r.tester === 1,
        note: r.note,
        userId: a?.user_id ?? null,
        exists: !!a,
        createdBy: { accountId: r.created_by, name: names.get(r.created_by) || null },
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }
    return out;
  }
}

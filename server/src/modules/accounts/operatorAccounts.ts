import crypto from "node:crypto";
import type { RowReader, RowWriter, Where } from "../../infrastructure/database/rows/index.js";
import { sha256Hex } from "../../shared/utilities/util.js";

/**
 * Accounts an operator made in the Platform Admin Console (docs/ADMIN_ACCOUNTS.md), read by sign-up and verification.
 * The row lives in the platform domain (operator_accounts); the account itself in the accounts domain.
 */
export type OperatorVerification = "verified" | "static_code" | "email";

export interface OperatorAccountRow {
  account_id: string;
  verification: OperatorVerification;
  code_hash: string | null;
  code_expires_at: number | null;
  tester: number;
  note: string | null;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
}

export function operatorAccount(platform: RowReader, accountId: string): OperatorAccountRow | undefined {
  return platform.get<OperatorAccountRow>("operator_accounts", { account_id: accountId });
}

/** A fixed code is stored like an emailed one: a hash bound to the account, so a stored hash says nothing on its own. */
export const staticCodeHash = (accountId: string, code: string) => sha256Hex(`${accountId}:static_verify_email:${code}`);

/** Whether [code] (digits only) is this account's fixed code and the code hasn't ended. */
export function staticCodeMatches(row: OperatorAccountRow | undefined, accountId: string, code: string, t: number): boolean {
  if (!row || row.verification !== "static_code" || !row.code_hash) return false;
  if (row.code_expires_at !== null && row.code_expires_at <= t) return false;
  const expected = Buffer.from(row.code_hash, "hex");
  const given = Buffer.from(staticCodeHash(accountId, code), "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// The console's writes and listing (platformAdmin/accountsAdmin.ts) go through these, so the table has one owner.

export function insertOperatorAccount(w: RowWriter, row: OperatorAccountRow): void {
  w.insert("operator_accounts", { ...row });
}

export function updateOperatorVerification(w: RowWriter, accountId: string, set: Pick<OperatorAccountRow, "verification" | "code_hash" | "code_expires_at" | "updated_by" | "updated_at">): void {
  w.update("operator_accounts", { account_id: accountId }, { ...set });
}

export function deleteOperatorAccount(w: RowWriter, accountId: string): void {
  w.delete("operator_accounts", { account_id: accountId });
}

/** Newest first; [after] is the last row of the previous page. One row more than [limit] says whether more follow. */
export function listOperatorAccounts(platform: RowReader, after: { createdAt: number; id: string } | undefined, limit: number): OperatorAccountRow[] {
  const where: Where = after ? { $or: [{ created_at: { lt: after.createdAt } }, { created_at: after.createdAt, account_id: { lt: after.id } }] } : {};
  return platform.all<OperatorAccountRow>("operator_accounts", {
    where,
    orderBy: [
      ["created_at", "desc"],
      ["account_id", "desc"],
    ],
    limit: limit + 1,
  });
}

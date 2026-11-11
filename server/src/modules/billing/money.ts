/** Exact decimal parsing for financial inputs. Provider-supported currencies must be explicitly selected. */
export function parseMinor(value: string, digits: number): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > 3) throw new Error("Unsupported currency precision");
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${digits || 1}})?$`).test(value) || (digits === 0 && value.includes("."))) throw new Error("Invalid monetary amount");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Monetary amount exceeds safe range");
  return Number(result);
}

export function decimalMinor(amount: number, digits: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isInteger(digits) || digits < 0 || digits > 3) throw new Error("Invalid minor units");
  const n = BigInt(amount), scale = 10n ** BigInt(digits);
  return digits ? `${n / scale}.${String(n % scale).padStart(digits, "0")}` : String(n);
}

import { z } from "zod";
import { badRequest } from "../errors.js";

/**
 * Anything with Zod's safeParse: routes and shared contracts use the patched Zod 4 runtime and produce the same
 * bounded 400 response here.
 */
export interface Schema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

/** Request validation shared by every route: the parsed value, or a 400 listing what's wrong (docs/architecture/ARCHITECTURE_1_0_PLAN.md §4). */
export function parse<T>(schema: Schema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      "Invalid request",
      r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return r.data;
}

export const zId = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const zB64 = z.string().min(4).max(400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const zKey = z.string().length(44).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const zSig = z.string().length(88).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const zName = z.string().trim().min(1).max(80);
export const zText = z.string().trim().max(500);

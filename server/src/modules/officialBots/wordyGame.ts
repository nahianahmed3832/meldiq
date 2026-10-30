import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Wordy's game itself (community parity batch D part 2), with no storage: the word lists (assets/wordy beside src/ or
 * dist/, or WORDY_DIR), the day's word for a community, and how a guess scores.
 */

export const WORD_LENGTH = 5;
export const MAX_TRIES = 6;
const DAY_MS = 86_400_000;
/** Wordy #1 was 1 January 2026 (UTC). */
const FIRST_DAY = Date.UTC(2026, 0, 1);

export type Mark = "hit" | "near" | "miss";
const SQUARES: Record<Mark, string> = { hit: "🟩", near: "🟨", miss: "⬛" };

function readList(file: string): string[] {
  const dir = process.env.WORDY_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/wordy");
  return fs
    .readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));
}

let lists: { answers: readonly string[]; valid: ReadonlySet<string> } | null = null;

/** The answers (the daily word is one of them) and every word a guess may be; read once. */
export function wordLists(): { answers: readonly string[]; valid: ReadonlySet<string> } {
  if (!lists) {
    const answers = readList("answers.txt");
    lists = { answers, valid: new Set([...answers, ...readList("guesses.txt")]) };
  }
  return lists;
}

/** The UTC day of [at]: "2026-10-30". */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** The day before [day]. */
export const dayBefore = (day: string): string => dayOf(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
const dayNumber = (day: string): number => Math.floor((Date.parse(`${day}T00:00:00Z`) - FIRST_DAY) / DAY_MS);
/** "Wordy #304". */
export const puzzleNumber = (day: string): number => dayNumber(day) + 1;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * The word of [day] in [orgId]: the same for everyone there that day, different between communities, and no word
 * comes back before every answer has had its day (a walk through the list with a step that shares no factor with its
 * length, both drawn from the community's id).
 */
export function dailyWord(orgId: string, day: string): string {
  const { answers } = wordLists();
  const n = answers.length;
  const h = crypto.createHash("sha256").update(`wordy:${orgId}`).digest();
  const offset = h.readUInt32BE(0) % n;
  let step = (h.readUInt32BE(4) % (n - 1)) + 1;
  while (gcd(step, n) !== 1) step = (step % (n - 1)) + 1;
  const i = (((offset + step * dayNumber(day)) % n) + n) % n;
  return answers[i]!;
}

/** Whether [word] is a guess Wordy takes. */
export const isWord = (word: string): boolean => wordLists().valid.has(word);

/**
 * How [guess] scores against [answer]: right letters in the right place first, then the others left to right, each
 * letter of the answer matching once (so a doubled letter in the guess is only yellow as often as the answer has it).
 */
export function score(guess: string, answer: string): Mark[] {
  const marks: Mark[] = Array<Mark>(WORD_LENGTH).fill("miss");
  const left = new Map<string, number>();
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === answer[i]) marks[i] = "hit";
    else left.set(answer[i]!, (left.get(answer[i]!) ?? 0) + 1);
  }
  for (let i = 0; i < WORD_LENGTH; i++) {
    const c = guess[i]!;
    if (marks[i] === "hit" || !left.get(c)) continue;
    marks[i] = "near";
    left.set(c, left.get(c)! - 1);
  }
  return marks;
}

/** "🟩🟨⬛⬛⬛": a guess's row, letters hidden. */
export const squares = (marks: readonly Mark[]): string => marks.map((m) => SQUARES[m]).join("");

/** The board of [guesses] against [answer], one row of squares per guess. */
export const board = (guesses: readonly string[], answer: string): string => guesses.map((g) => squares(score(g, answer))).join("\n");

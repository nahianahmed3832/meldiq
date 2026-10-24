import { z } from "zod/v4";

/**
 * How a message in a channel calls an AI agent: the one rule the server's channel readers apply and the apps apply in
 * their composers (web src/sync/agentRules.ts, Android data/ai/AgentRules.kt). All three test against the same cases,
 * shared/contracts/fixtures/rules/agent-invocation.json, so they can't drift apart.
 *
 * - "@Name" anywhere in the message, at its start or after a space, ending where the name ends ("@Reel Maker2" isn't
 *   "@Reel Maker"), for agents activated by mention.
 * - "/name" at the start only, by the agent's command name ("Agent Manager" → "/agent-manager", or "/agentmanager"),
 *   for agents activated by mention or by command.
 * - Agents set to "explicit" answer only the Ask dialog. The longest matching name wins.
 *
 * What it asks is the message without the call: "fix this @Agent Manager?" → "fix this?".
 */
export const ACTIVATIONS = ["mention", "command", "explicit"] as const;
export type Activation = (typeof ACTIVATIONS)[number];

export interface CallableAgent {
  id: string;
  displayName: string;
  activation: Activation;
}

export interface AgentCall {
  installId: string;
  brief: string;
}

/** "Reel Maker" → "reel-maker": the command an agent answers to. */
export const commandName = (displayName: string): string =>
  displayName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What may follow a name: the end, a space or punctuation. */
const NAME_END = "(?=$|[\\s,:;.!?])";

/** Where [text] calls [a]: the start and length of the call, or null. */
function callIn(text: string, a: CallableAgent): { index: number; length: number } | null {
  if (a.activation === "explicit") return null;
  const slug = commandName(a.displayName);
  if (slug) {
    const command = new RegExp(`^/(${slug}|${slug.replace(/-/g, "")})${NAME_END}`, "i").exec(text);
    if (command) return { index: 0, length: command[0].length };
  }
  if (a.activation !== "mention" || !a.displayName.trim()) return null;
  const mention = new RegExp(`(^|\\s)@${escapeRegExp(a.displayName)}${NAME_END}`, "i").exec(text);
  return mention ? { index: mention.index + mention[1]!.length, length: mention[0].length - mention[1]!.length } : null;
}

/** [text] without its call: the space before it goes, and punctuation that only separated it from the request. */
export function withoutCall(text: string, at: { index: number; length: number }): string {
  const before = text.slice(0, at.index).trimEnd();
  const after = text.slice(at.index + at.length);
  return (before ? before + after : after.replace(/^[\s,:;]+/, "")).trim();
}

/** The agent [text] calls and what it asks, or null for an ordinary message or a call with nothing asked. */
export function agentCall(text: string, agents: readonly CallableAgent[]): AgentCall | null {
  const t = text.trim();
  let best: { agent: CallableAgent; at: { index: number; length: number } } | null = null;
  for (const a of agents) {
    const at = callIn(t, a);
    if (at && (!best || at.length > best.at.length)) best = { agent: a, at };
  }
  if (!best) return null;
  const brief = withoutCall(t, best.at);
  return brief ? { installId: best.agent.id, brief } : null;
}

/** Whether [text] calls [agent] at all, and what it asks (the whole text when the call is all there is). */
export function callOf(text: string, agent: CallableAgent): AgentCall | null {
  const at = callIn(text.trim(), agent);
  return at ? { installId: agent.id, brief: withoutCall(text.trim(), at) } : null;
}

/** The shared cases (shared/contracts/fixtures/rules/agent-invocation.json). */
export const InvocationCases = z.strictObject({
  agents: z.array(z.strictObject({ id: z.string(), displayName: z.string(), activation: z.enum(ACTIVATIONS) })).min(1),
  cases: z
    .array(
      z.strictObject({
        why: z.string().min(1),
        text: z.string(),
        expect: z.strictObject({ installId: z.string(), brief: z.string().min(1) }).nullable(),
      }),
    )
    .min(1),
});

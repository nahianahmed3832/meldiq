import { z } from "zod/v4";
import { idParams } from "./primitives.js";
import { route } from "./route.js";
const OptionId = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/);
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
export const ManagedPollPublic = z.strictObject({
  version: z.literal(1).default(1),
  question: z.string().trim().min(1).max(300),
  options: z
    .array(
      z.strictObject({
        id: OptionId,
        text: z.string().trim().min(1).max(100),
        emoji: z.string().max(16).optional(),
      }),
    )
    .min(2)
    .max(10),
  multi: z.boolean().default(false),
  endsAt: z.number().int().positive().optional(),
  quiz: z.boolean().default(false),
  reveal: z.literal("after_close").default("after_close"),
});
export const ManagedPollInput = ManagedPollPublic.extend({
  correctOptionIds: z.array(OptionId).min(1).max(10).optional(),
}).superRefine((p, c) => {
  if (
    !unique(p.options.map((o) => o.id)) ||
    !unique(
      p.options.map((o) =>
        o.text.replace(/\s+/g, " ").normalize("NFKC").toLowerCase(),
      ),
    )
  )
    c.addIssue({
      code: "custom",
      message: "Each poll option must be distinct",
    });
  const ids = new Set(p.options.map((o) => o.id)),
    answers = p.correctOptionIds ?? [];
  if (
    p.quiz
      ? !answers.length ||
        !unique(answers) ||
        answers.some((id) => !ids.has(id)) ||
        (!p.multi && answers.length !== 1)
      : !!answers.length
  )
    c.addIssue({
      code: "custom",
      message: "Choose valid correct answers for a quiz",
    });
});
export const ManagedPollVote = z.strictObject({
  choices: z.array(OptionId).max(10).refine(unique, "Each choice once"),
  anonymous: z.boolean().optional(),
});
export const ManagedPollState = z.strictObject({
  id: z.string(),
  poll: ManagedPollPublic,
  closed: z.boolean(),
  rev: z.number().int().positive(),
  mine: z
    .strictObject({ choices: z.array(OptionId), anonymous: z.boolean() })
    .nullable(),
  total: z.number().int().nonnegative(),
  counts: z.array(
    z.strictObject({ id: OptionId, votes: z.number().int().nonnegative() }),
  ),
  voters: z.array(
    z.strictObject({
      userId: z.string().nullable(),
      choices: z.array(OptionId),
    }),
  ),
  correctOptionIds: z.array(OptionId).nullable(),
  canClose: z.boolean(),
});
export const managedPollContracts = [
  route({
    method: "GET",
    url: "/v1/polls/:id",
    tag: "messages",
    auth: true,
    summary:
      "Current authorized poll totals; anonymous ballots omit identities and quiz answers remain hidden until close.",
    params: idParams,
    response: ManagedPollState,
    errors: ["not_found"],
  }),
  route({
    method: "PUT",
    url: "/v1/polls/:id/vote",
    tag: "messages",
    auth: true,
    summary:
      "Replace or remove this member's choices, respecting membership, posting rights and server expiry.",
    params: idParams,
    body: ManagedPollVote,
    response: ManagedPollState,
    errors: ["not_found", "forbidden", "conflict"],
  }),
  route({
    method: "POST",
    url: "/v1/polls/:id/close",
    tag: "messages",
    auth: true,
    summary: "Idempotently close an authored poll and reveal quiz answers.",
    params: idParams,
    response: ManagedPollState,
    errors: ["not_found", "forbidden"],
  }),
];

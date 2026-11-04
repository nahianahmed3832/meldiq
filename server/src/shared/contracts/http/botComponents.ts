import { z } from "zod/v4";

const key = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine(
    (value) => !["__proto__", "prototype", "constructor"].includes(value),
    "Choose another id",
  );
const label = z.string().trim().min(1).max(80);
const common = { customId: key, label, disabled: z.boolean().optional() };
export const BotFormField = z
  .strictObject({
    id: key,
    label,
    style: z.enum(["short", "paragraph"]).default("short"),
    required: z.boolean().default(true),
    minLength: z.number().int().min(0).max(1000).default(0),
    maxLength: z.number().int().min(1).max(1000).default(1000),
  })
  .refine(
    (field) => field.minLength <= field.maxLength,
    "A field's minimum cannot exceed its maximum",
  );
export const BotComponent = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("button") }),
  z
    .strictObject({
      ...common,
      type: z.literal("select"),
      options: z
        .array(z.strictObject({ label, value: key }))
        .min(1)
        .max(25)
        .refine(
          (items) =>
            new Set(items.map((item) => item.value)).size === items.length,
          "Use each option value once",
        ),
      minValues: z.number().int().min(0).max(25).default(1),
      maxValues: z.number().int().min(1).max(25).default(1),
    })
    .refine(
      (item) =>
        item.minValues <= item.maxValues &&
        item.maxValues <= item.options.length,
      "Choose a valid option range",
    ),
  z.strictObject({
    ...common,
    type: z.literal("form"),
    fields: z
      .array(BotFormField)
      .min(1)
      .max(5)
      .refine(
        (fields) =>
          new Set(fields.map((field) => field.id)).size === fields.length,
        "Use each field id once",
      ),
  }),
]);
export const BotComponentList = z
  .array(BotComponent)
  .min(1)
  .max(5)
  .refine(
    (items) =>
      new Set(items.map((item) => item.customId)).size === items.length,
    "Use each component id once",
  );
export const BotMessageComponents = z.strictObject({
  expiresAt: z.number().int().positive(),
  items: BotComponentList,
});
export const ComponentInteractionBody = z
  .strictObject({
    kind: z.literal("component"),
    channelId: z.string().min(1).max(64),
    botId: z.string().min(1).max(64),
    messageId: z.string().min(1).max(64),
    customId: key,
    interactionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    values: z.array(key).max(25).default([]),
    fields: z.record(key, z.string().max(1000)).default({}),
  })
  .refine(
    (value) =>
      Object.keys(value.fields).length <= 5 &&
      Object.values(value.fields).join("").length <= 4000,
    "A form may contain at most 4000 characters across five fields",
  );
export const BotComponentInvocation = z.strictObject({
  messageId: z.string().min(1).max(64),
  customId: key,
  label,
  type: z.enum(["button", "select", "form"]),
  values: z.array(key).max(25).optional(),
  fields: z.record(key, z.string().max(1000)).optional(),
});
export type BotComponent = z.output<typeof BotComponent>;
export type BotComponentInvocation = z.output<typeof BotComponentInvocation>;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const words = (v: unknown): string => (typeof v === "string" ? v : "");
/** All visible rich text and link targets participate in native character/link/content policies. */
export function botRichText(payload: Record<string, unknown>): string {
  const parts = [words(payload.text)];
  for (const value of list(payload.embeds)) {
    const e = obj(value);
    parts.push(
      ...["title", "description", "url"].map((key) => words(e[key])),
      words(obj(e.author).name),
      words(obj(e.footer).text),
      words(obj(e.image).url),
      words(obj(e.thumbnail).url),
    );
  }
  for (const value of list(payload.buttons)) {
    const button = obj(value);
    parts.push(words(button.label), words(button.url));
  }
  for (const value of list(obj(payload.botComponents).items)) {
    const component = obj(value);
    parts.push(words(component.label));
    for (const option of list(component.options))
      parts.push(words(obj(option).label));
    for (const field of list(component.fields))
      parts.push(words(obj(field).label));
  }
  return parts.filter(Boolean).join("\n");
}

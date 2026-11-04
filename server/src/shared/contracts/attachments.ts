import { z } from "zod/v4";

/** Native encrypted file reference, shared by ordinary publication and approved bot posts. */
export const AttachmentDescriptor = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(512),
  mime: z.string().max(255),
  size: z.number().int().positive(),
  key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  chunk: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .optional(),
});
export const MessageAttachment = AttachmentDescriptor.extend({
  thumbnail: AttachmentDescriptor.extend({
    mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
    size: z
      .number()
      .int()
      .positive()
      .max(128 * 1024),
    chunk: z.undefined().optional(),
  }).nullish(),
});

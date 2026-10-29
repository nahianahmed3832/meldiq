import { z } from "zod/v4";
import { zReason } from "./platformAdmin.js";
import { zCount, zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Creators (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md): verifying a channel you run on another platform (an
 * operator checks a proof screenshot; approved, you get the Creator badge), and a small creator programme where
 * verified creators send links to what they made about Meldiq. Nothing here pays anyone: an operator can write a
 * reward note on a post, and that's all the server knows about rewards.
 */

export const CREATOR_PLATFORMS = ["youtube", "tiktok", "twitch", "instagram", "x"] as const;
export const CreatorPlatform = z.enum(CREATOR_PLATFORMS);
/** The rules people are shown before applying, and that operators check. */
export const CREATOR_RULES = { minFollowers: 1000, notesMax: 500, proofMaxBytes: 4 * 1024 * 1024 } as const;

const oneLine = (v: string) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v);
const zHttpsLink = z
  .string()
  .trim()
  .max(300, "Links can be up to 300 characters")
  .refine((v) => /^https:\/\/[^\s/$.?#][^\s]*$/i.test(v), "Links start with https://");

/** POST /v2/creators/verification: the form, as query parameters beside the proof screenshot (the request body). */
export const CreatorVerificationQuery = z.strictObject({
  platform: CreatorPlatform,
  channelName: z.string().trim().min(2, "Give your channel's name").max(100).refine(oneLine, "A channel name is one line of plain text"),
  link: zHttpsLink,
  notes: z.string().trim().max(CREATOR_RULES.notesMax, `Notes can be up to ${CREATOR_RULES.notesMax} characters`).optional(),
  /** The applicant's word that the code line is in their channel's bio. */
  bioLineConfirmed: z.literal("true", { error: "Put the code line in your channel's bio first, then confirm it" }),
});

export const ReviewStatus = z.enum(["pending", "approved", "rejected"]);

export const CreatorApplication = z.strictObject({
  id: z.string(),
  platform: CreatorPlatform,
  channelName: z.string(),
  link: z.string(),
  notes: z.string().nullable(),
  status: ReviewStatus,
  /** Why it was turned down (shown to the applicant). */
  reason: z.string().nullable(),
  createdAt: zTime,
  reviewedAt: zTime.nullable(),
});

export const CreatorVerificationView = z.strictObject({
  /** The line to put in your channel's bio ("meldiq: <username>"); null until you pick a username. */
  codeLine: z.string().nullable(),
  rules: z.strictObject({
    minFollowers: z.number().int(),
    /** The channel's name must match your username or display name (letters and digits; case, spaces, "_" and "." don't count). */
    nameMatches: z.array(z.enum(["username", "displayName"])),
    platforms: z.array(CreatorPlatform),
    notesMax: z.number().int(),
    proofMaxBytes: z.number().int(),
    proofTypes: z.array(z.string()),
  }),
  /** Whether you hold the Creator badge now (an approved channel whose name still matches your username). */
  verified: z.boolean(),
  /** Your applications, newest first. */
  applications: z.array(CreatorApplication),
});

export const CreatorPostBody = z.strictObject({
  url: zHttpsLink,
  platform: CreatorPlatform,
  views: z.number().int().nonnegative().max(10_000_000_000).optional(),
});

export const CreatorPost = z.strictObject({
  id: z.string(),
  url: z.string(),
  platform: CreatorPlatform,
  views: zCount.nullable(),
  /** An operator counted it for the programme. */
  counted: z.boolean(),
  /** What an operator noted about its reward, if anything. */
  rewardNote: z.string().nullable(),
  createdAt: zTime,
  reviewedAt: zTime.nullable(),
});

export const CreatorProgramApplication = z.strictObject({ id: z.string(), status: ReviewStatus, reason: z.string().nullable(), createdAt: zTime, reviewedAt: zTime.nullable() });

export const CreatorProgramView = z.strictObject({
  steps: z.strictObject({
    /** You hold the Creator badge. */
    verified: z.boolean(),
    /** You have a programme application, of any status. */
    applied: z.boolean(),
    /** Your latest programme application was approved: you can send posts. */
    approved: z.boolean(),
  }),
  /** Your latest programme application. */
  application: CreatorProgramApplication.nullable(),
  /** Your posts, newest first. */
  posts: z.array(CreatorPost),
});

const creators = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "creators", auth: true, ...c });

export const creatorRoutes = [
  creators({ method: "GET", url: "/v2/creators/verification", summary: "Your code line, the rules, whether you're a verified creator, and your applications.", response: CreatorVerificationView }),
  creators({
    method: "POST",
    url: "/v2/creators/verification",
    summary: "Apply to verify a channel: the form as query parameters and a PNG, JPEG or WebP screenshot (up to 4 MB) of the channel with its follower count as application/octet-stream. One open application at a time.",
    query: CreatorVerificationQuery,
    binary: "request",
    status: 201,
    response: z.strictObject({ application: CreatorApplication }),
    errors: ["application_open", "creator_name_mismatch", "too_large", "storage_unavailable"],
  }),
  creators({ method: "GET", url: "/v2/creators/program", summary: "The creator programme's steps (verified, applied, approved), your application and your posts.", response: CreatorProgramView }),
  creators({
    method: "POST",
    url: "/v2/creators/program/apply",
    summary: "Apply to the creator programme (verified creators only; one open application at a time).",
    status: 201,
    response: z.strictObject({ application: CreatorProgramApplication }),
    errors: ["not_verified_creator", "application_open", "conflict"],
  }),
  creators({ method: "GET", url: "/v2/creators/posts", summary: "The posts you sent to the creator programme, newest first.", response: z.strictObject({ posts: z.array(CreatorPost) }) }),
  creators({
    method: "POST",
    url: "/v2/creators/posts",
    summary: "Send a link to something you made about Meldiq (approved programme members who are still verified).",
    body: CreatorPostBody,
    status: 201,
    response: z.strictObject({ post: CreatorPost }),
    errors: ["not_in_creator_program", "conflict", "limit_reached"],
  }),
];

/* The admin console's side (modules/platformAdmin/creators.ts). Like the other /admin/v1 schemas, not in ROUTE_CONTRACTS. */

export const AdminCreatorListQuery = z.strictObject({
  status: ReviewStatus.default("pending"),
  /** The `next` of the previous page. */
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const AdminCreatorPostsQuery = z.strictObject({
  /** "pending": not counted yet; "counted": counted. */
  status: z.enum(["pending", "counted"]).default("pending"),
  before: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const AdminCreatorParams = z.strictObject({ id: z.string().regex(/^cr[a-z]?_[A-Za-z0-9_-]{8,40}$/) });
export const AdminCreatorReject = z.strictObject({ reason: zReason });
export const AdminCreatorPostReview = z.strictObject({
  counted: z.boolean(),
  rewardNote: z.string().trim().max(300).refine(oneLine, "One line of plain text").nullable().optional(),
});

const AdminCreatorPerson = z.strictObject({ userId: z.string(), username: z.string().nullable(), displayName: z.string().nullable() });

export const AdminCreatorVerificationEntry = CreatorApplication.extend({
  user: AdminCreatorPerson,
  /** The line their bio should show now. */
  codeLine: z.string().nullable(),
  /** Whether the channel name matches their current username or display name. */
  nameMatches: z.boolean(),
  proofUrl: z.string(),
  proofType: z.string(),
  proofSize: zCount,
  reviewedBy: z.string().nullable(),
});
export const AdminCreatorVerificationPage = z.strictObject({ applications: z.array(AdminCreatorVerificationEntry), next: zTime.nullable() });
export const AdminCreatorVerificationDecided = z.strictObject({ application: CreatorApplication });

export const AdminCreatorProgramEntry = CreatorProgramApplication.extend({ user: AdminCreatorPerson, verified: z.boolean(), reviewedBy: z.string().nullable() });
export const AdminCreatorProgramPage = z.strictObject({ applications: z.array(AdminCreatorProgramEntry), next: zTime.nullable() });
export const AdminCreatorProgramDecided = z.strictObject({ application: CreatorProgramApplication });

export const AdminCreatorPostEntry = CreatorPost.extend({ user: AdminCreatorPerson, reviewedBy: z.string().nullable() });
export const AdminCreatorPostsPage = z.strictObject({ posts: z.array(AdminCreatorPostEntry), next: zTime.nullable() });
export const AdminCreatorPostReviewed = z.strictObject({ post: CreatorPost });

import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";
import { BugReportBody } from "./users.js";

/** Bug reports from Settings (API 0.46.0, docs/ACCOUNT_SAFETY.md); staff review them with the operator CLI. */
const bug = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "bug-reports", auth: true, ...c });

const BugReportView = z.strictObject({
  id: z.string(),
  summary: z.string(),
  details: z.string(),
  page: z.string().nullable(),
  status: z.enum(["open", "confirmed", "fixed", "not_a_bug", "duplicate"]),
  staffNote: z.string().nullable(),
  createdAt: zTime,
  updatedAt: zTime,
});

export const bugReportRoutes = [
  bug({
    method: "POST",
    url: "/v1/bug-reports",
    summary: "Report a bug: what went wrong and where (up to 10 a day). Nothing from your messages is attached.",
    body: BugReportBody,
    response: z.strictObject({ report: BugReportView }),
    status: 201,
    errors: ["rate_limited"],
  }),
  bug({
    method: "GET",
    url: "/v1/bug-reports",
    summary: "Your bug reports and what staff said, and whether you've earned the Bug Hunter badge.",
    response: z.strictObject({ reports: z.array(BugReportView), bugHunter: z.boolean() }),
  }),
];

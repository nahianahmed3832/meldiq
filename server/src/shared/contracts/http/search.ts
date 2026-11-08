import { z } from "zod/v4";
import { ConversationView, UserSummary } from "./conversations.js";
import { route } from "./route.js";

/** Universal search over what the server can read: people, channels, workspaces and groups (docs/SEARCH.md). */

/** One kind's results. */
const searchPage = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item),
    /** Pass back as `cursor` (with `types` set to this one kind) for the next page; null at the end. */
    next: z.string().nullable(),
  });

export const SearchPerson = UserSummary.extend({ online: z.boolean().nullable() });
export const SearchChannel = ConversationView.extend({ orgName: z.string() });
export const SearchWorkspace = z.strictObject({ id: z.string(), name: z.string(), slug: z.string(), myRole: z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]) });

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(60),
  /** Comma-separated kinds; all of them when absent. */
  types: z.string().max(80).optional(),
  orgId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().max(40).optional(),
});

export const SearchResult = z.strictObject({
  query: z.string(),
  /** One page per kind asked for (unknown kinds are ignored); workspaces and groups are empty with orgId. */
  results: z.strictObject({
    people: searchPage(SearchPerson).optional(),
    channels: searchPage(SearchChannel).optional(),
    workspaces: searchPage(SearchWorkspace).optional(),
    groups: searchPage(ConversationView).optional(),
  }),
});

export const privateSearch = route({
  method: "POST", url: "/v2/search", tag: "search",
  summary: "Search people, channels, workspaces and groups without putting search terms in the request URL.",
  auth: true, body: SearchQuery, response: SearchResult, errors: ["not_found"],
});

export const searchRoutes = [
  privateSearch,
  route({
    method: "GET",
    url: "/v1/search",
    tag: "search",
    summary: "Search people, channels, workspaces and groups by name (optionally within one workspace).",
    auth: true,
    query: SearchQuery,
    response: SearchResult,
    errors: ["not_found"],
  }),
];

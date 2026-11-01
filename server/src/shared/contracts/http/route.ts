import type { z } from "zod/v4";
import type { ErrorCode } from "../../errors.js";

/**
 * One HTTP route's contract (docs/architecture/ARCHITECTURE_1_0_PLAN.md §4): what it takes and what it answers. The
 * route validates its input with these schemas; the test suite checks every answer against `response`; OpenAPI
 * (docs/api/openapi.json) is generated from them.
 */
export interface RouteContract {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Fastify's template, e.g. "/v1/calls/:id/join". */
  url: string;
  /** One line for the API documentation. */
  summary: string;
  /** Area in the documentation (OpenAPI tag). */
  tag: string;
  /** false: no bearer token needed. */
  auth: boolean;
  /**
   * API 0.65.0 batch B: a credential other than a person's session. "bot": `Authorization: Bot <token>` (/v2/bot/…);
   * "oauth": an app's OAuth access token as the bearer (/v2/oauth/userinfo), which no other route accepts.
   */
  scheme?: "bot" | "oauth" | "console";
  /** "oauth": errors are RFC 6749 §5.2 bodies (`{ error, error_description }`), not the error envelope. */
  errorFormat?: "oauth";
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** The success body (JSON). For `binary` routes, unused. */
  response: z.ZodType;
  /** The request or the answer is raw bytes (application/octet-stream), not JSON. */
  binary?: "request" | "response";
  /** The success status (200 unless stated). */
  status?: number;
  /** Error codes this route is documented to answer with (besides the common ones: bad_request, unauthorized, rate_limited). */
  errors?: readonly ErrorCode[];
  /** The route exists only with an optional feature: "federation" when FEDERATION_DOMAIN is set. */
  requires?: "federation" | "admin_console";
}

export const route = (c: RouteContract): RouteContract => c;

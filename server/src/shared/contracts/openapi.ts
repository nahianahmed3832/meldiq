import { z } from "zod/v4";
import { ERROR_CODES } from "../errors.js";
import { ErrorEnvelope, ROUTE_CONTRACTS, type RouteContract } from "./http/index.js";
import { OAuthErrorBody } from "./http/oauthApps.js";
import { ClientEvent, ServerEvent } from "./realtime.js";

/**
 * docs/api/openapi.json and docs/api/realtime.schema.json, generated from the contracts (`npm run contracts`; a test
 * fails when the committed files differ from what the schemas generate).
 */

type Json = Record<string, unknown>;

const schemaOf = (s: z.ZodType, io: "input" | "output"): Json => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io, unrepresentable: "any" }) as Json;
  return rest;
};

function parameters(c: RouteContract): Json[] {
  const out: Json[] = [];
  const add = (where: "path" | "query", s: z.ZodType | undefined) => {
    if (!s) return;
    const js = schemaOf(s, "input") as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, schema] of Object.entries(js.properties ?? {})) {
      out.push({ name, in: where, required: where === "path" || (js.required ?? []).includes(name), schema });
    }
  };
  add("path", c.params);
  add("query", c.query);
  return out;
}

function operation(c: RouteContract): Json {
  const ok = String(c.status ?? 200);
  const success =
    c.binary === "response"
      ? { description: "The bytes (or 302 to a storage URL)", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }
      : { description: "OK", content: { "application/json": { schema: schemaOf(c.response, "output") } } };
  const errors = c.errorFormat === "oauth"
    ? { default: { description: "Error (RFC 6749 §5.2)", content: { "application/json": { schema: { $ref: "#/components/schemas/OAuthError" } } } } }
    : c.errors?.length
    ? {
        default: {
          description: `Error. Codes: ${c.errors.join(", ")}`,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
        },
      }
    : { default: { $ref: "#/components/responses/Error" } };
  const op: Json = {
    tags: [c.tag],
    summary: c.summary,
    operationId: `${c.method.toLowerCase()}${c.url.replace(/[/:{}-]+(\w)/g, (_m, ch: string) => ch.toUpperCase())}`,
    parameters: parameters(c),
    responses: { [ok]: success, ...errors },
  };
  if (c.auth) op.security = [{ [c.scheme === "bot" ? "bot" : c.scheme === "oauth" ? "oauthToken" : "bearer"]: [] }];
  if (c.binary === "request") op.requestBody = { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } };
  else if (c.body) op.requestBody = { required: true, content: { "application/json": { schema: schemaOf(c.body, "input") } } };
  return op;
}

export function buildOpenApi(version: string): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const c of ROUTE_CONTRACTS) {
    const p = c.url.replace(/:(\w+)/g, "{$1}");
    paths[p] = { ...paths[p], [c.method.toLowerCase()]: operation(c) };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Meldiq API",
      version,
      description:
        "The canonical contract of the Meldiq server (docs/architecture/ARCHITECTURE_1_0_PLAN.md §4), generated from src/shared/contracts. " +
        "Fields are only ever added within a version; clients ignore unknown fields. Routes not listed here exist but aren't documented yet.",
    },
    servers: [{ url: "https://msg.meldiq.app" }],
    tags: [...new Set(ROUTE_CONTRACTS.map((c) => c.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        // API 0.65.0 batch B: bots send `Authorization: Bot <token>`; apps send their OAuth access token as the bearer.
        bot: { type: "apiKey", in: "header", name: "Authorization", description: "Bot <token>" },
        oauthToken: { type: "http", scheme: "bearer", description: "An OAuth access token from POST /v2/oauth/token (only /v2/oauth/userinfo accepts it)" },
      },
      schemas: { ErrorEnvelope: schemaOf(ErrorEnvelope, "output"), OAuthError: schemaOf(OAuthErrorBody, "output") },
      responses: { Error: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } } },
    },
    "x-error-codes": ERROR_CODES,
  };
}

export function buildRealtimeSchema(): Json {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Meldiq WebSocket frames (/v1/ws)",
    description: "Generated from src/shared/contracts/realtime.ts. Clients ignore frames and fields they don't know.",
    $defs: { ServerEvent: schemaOf(ServerEvent, "output"), ClientEvent: schemaOf(ClientEvent, "input") },
  };
}

# AI operations (Platform Admin 2.0, API 0.34.0)

Provider connections, credentials, approved models and prices, the gateway every AI request goes through, usage, and
budgets (`modules/ai`). Since 2026-10-24 **AI Workforce** (`AI_WORKFORCE.md`) uses it: model capabilities, their
verification and `auto` routing are in `AI_WORKFORCE.md` §4 (`modules/ai/capabilities.ts`, `routing.ts`, `gateway.ts`).
It never receives conversation content: messages are end-to-end encrypted and nothing decrypts them. Agents get only
what a person sends them on purpose, with a notice saying it isn't end-to-end encrypted.

## Providers

Anthropic, OpenAI and Google AI (Gemini API), each at its fixed official address in code. Nobody can point the
server at another host: there's no SSRF and no billing proxy. Model ids are checked against a strict pattern before
they go into a URL. A connection starts disabled and without a key, and can be enabled only once it has one.

The **connection test** lists the models the key can use. It's a real, authenticated request that providers don't
charge for. The result (status and error kind, never a response body) is stored, so "configured" and "working" are
told apart. The **generation test** sends one fixed prompt ("Reply with the single word: pong") through the gateway
with every control applied. It costs a few tokens.

## Credentials

- Encrypted with AES-256-GCM using `PLATFORM_SECRETS_KEY`, 32 bytes from the server's environment (`openssl rand -hex 32`). The key is never in the database.
- Each ciphertext is bound to its provider row.
- A key is sent once over the console's HTTPS session (a super admin with a fresh passkey check). It's never returned, logged or audited: the audit records only "set", "rotated" or "removed".
- Without `PLATFORM_SECRETS_KEY`, credentials can't be stored. The console says so; there's no plain-text fallback.
- Rotating replaces the stored key at once. Removing it also disables the provider. Revoking the old key at the provider is the operator's step there.
- Losing or changing `PLATFORM_SECRETS_KEY` makes stored keys unreadable, so they have to be entered again.

## The gateway

The order:

1. the kill switch (`ai.enabled`, off by default);
2. the feature (only listed features);
3. the provider enabled and the model on its allowlist;
4. input and output caps: 20,000 characters, 4,096 tokens;
5. quota reservations for requests, estimated tokens and estimated cost, for the person, their organization and the platform (`docs/QUOTAS.md`);
6. the call, with a timeout and bounded retries (network, 429 or 5xx only, before any answer);
7. an explicitly configured fallback provider, on its first approved model;
8. settlement with the provider's own token counts, or a labelled estimate;
9. one `ai_usage` row: counts, cost, latency and outcome. Never the prompt or the answer.

A failed or refused request releases its reservations. The kill switch refuses everything before any provider is
called; messaging, calls and sign-in are unaffected.

## Costs

Prices are entered per model by an operator: micro-USD per million tokens, in and out separately, with their source
and date. Every cost shown is an estimate from those prices, never an invoice. Requests without a price are counted as
unpriced, not as free.

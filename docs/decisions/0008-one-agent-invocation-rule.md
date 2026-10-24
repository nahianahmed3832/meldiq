# 0008: One rule for calling an agent from a message

**Status:** Accepted (2026-10-25)

## Context

A message calls an AI agent in two places. The apps (web and Android) intercept it in the composer, because a mention
inside an end-to-end encrypted message is invisible to the server; the server's channel readers decide it for channels
an agent reads. The three copies drifted: the apps matched "@Agent" only at the start of a message, and the server
accepted "/agentmanager" where the apps offer "/agent-manager". A request ending in "@Agent Manager" reached no agent.

## Decision

`server/src/modules/workforce/invocation.ts` defines the rule, and every client mirrors it:

- "@Name" anywhere in the message, at its start or after a space, ending where the name ends, calls an agent activated
  by mention.
- "/name" (the agent's command name, or the same without dashes) at the start calls an agent activated by mention or by
  command.
- `explicit` agents answer only the Ask dialog. The longest matching name wins.
- The request is the message without the call ("fix this @Agent?" → "fix this?"). A call with nothing asked is not a
  request.

`shared/contracts/fixtures/rules/agent-invocation.json` holds the cases. The server, web and Android suites all run
them, and the server's contracts test validates the file, so a change to the rule changes all three or fails.

## Consequences

- A mention anywhere works the same in every app and in reading channels.
- Ordinary messages that mention an agent mid-sentence now go to the agent (with the AI notice the first time), not to
  the channel. That's what people expect of a bot mention.
- The rule is duplicated in three languages, held together by the shared cases rather than by shared code.

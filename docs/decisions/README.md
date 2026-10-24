# Architecture decision records

One file per decision: context, decision, consequences. Earlier decisions (D-01 to D-17) are in `../DECISIONS.md`.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-no-federation-yet.md) | Self-hosting means independent instances; no federation yet | **Superseded** by 0005 |
| [0002](0002-server-profiles.md) | One account per server, held as separate on-device profiles | Accepted |
| [0003](0003-voice-messages-as-attachments.md) | Voice messages are encrypted attachments with two optional fields | Accepted |
| [0004](0004-call-reachability.md) | Call reachability: ring recovery, an alerted state and busy, without push | Accepted |
| [0005](0005-federated-network.md) | Griip is a federated network with a replicated core registry | Accepted |
| [0006](0006-remote-users-as-shadows.md) | Remote users are "shadow" rows with their real ids | Accepted |
| [0007](0007-calls-hosted-by-caller.md) | Cross-server calls are hosted by the caller's server | Accepted |
| [0008](0008-one-agent-invocation-rule.md) | One rule for calling an agent from a message, shared by server, web and Android | Accepted |

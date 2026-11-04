/** Native server capability history. A deployed server serves only entries present in that server's source. */
export const BOT_CHANGELOG = {
  protocolVersion: 1,
  entries: [
    {
      version: "1.0-preview",
      date: "2026-11-05",
      changes: [
        "Requested manifests and explicit installation approval intersect with current native community authority.",
        "ID-only seven-day replay, opaque bot-bound cursors and a dedicated authenticated gateway.",
        "Current message history, moderation, reactions, pins, commands and native community controller adapters.",
        "Recipient-controlled personal messages, explicit bot-profile consent and revocation-safe private message events.",
        "Native rich controls with private, source-bound leased interactions and current-access checks.",
        "Community voice preview: reviewed public encryption keys, separate media leases, transient HPKE handoff and durable removal-only metadata.",
        "Separate file upload/read approvals, native encrypted upload/publication and revocation-checked streaming downloads; existing grants do not expand automatically.",
        "First-party JavaScript and Python source clients; no hosted bot execution.",
      ],
    },
  ],
};

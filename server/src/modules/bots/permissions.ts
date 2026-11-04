import type { z } from "zod/v4";
import { ApiError, forbidden, notFound } from "../../shared/errors.js";
import {
  BotPermissionList,
  type BotManifestUpdate,
  type BotInstallationApproval,
  type BotPlatformScope,
} from "../../shared/contracts/http/botPlatform.js";
import { requireBotManager } from "../organizations/index.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";
import { isBotUser } from "../accounts/index.js";
import type { RowWriter } from "../../infrastructure/database/rows/index.js";
import { newId } from "../../shared/utilities/util.js";
import { botVoiceFingerprint, validateBotVoicePublicKey } from "./voiceKeys.js";

type Requested = {
  bot_id: string;
  permissions: string;
  rev: number;
  updated_at: number;
  voice_public_key?: string | null;
};
type Approved = {
  org_id: string;
  bot_id: string;
  permissions: string;
  manifest_rev: number;
  rev: number;
  approved_by: string;
  approved_at: number;
  install_key: string;
};
type CredentialBinding = {
  bot_id: string;
  org_id: string;
  bot_token_hash: string;
  install_key: string;
  created_at: number;
};
type CredentialRevision = {
  bot_id: string;
  owner_id: string;
  token_hash: string;
  created_at: number;
  active: number;
};
const read = (value: string | undefined): BotPlatformScope[] => {
  try {
    return BotPermissionList.parse(JSON.parse(value ?? "[]"));
  } catch {
    return [];
  }
};
const READ_SCOPES = new Set([
  "communities.read",
  "channels.read",
  "members.read",
  "events.read",
  "direct_messages",
]);
const nativePermission = (permission: BotPlatformScope) =>
  permission === "files.upload" ? "messages.attach" : permission === "files.read" ? "messages.history" : permission;

/** Requested scopes, installation approval, then current native roles/channel authority: all must allow an action. */
export class BotPermissions {
  constructor(private readonly bots: BotService) {}

  manifest(botId: string) {
    const row = this.bots.ctx.ws.get<Requested>("bot_requested_permissions", {
      bot_id: botId,
    });
    const voicePublicKey = row?.voice_public_key ?? null;
    return { botId, permissions: read(row?.permissions), rev: row?.rev ?? 0, voicePublicKey, voiceKeyFingerprint: botVoiceFingerprint(voicePublicKey) };
  }

  async update(
    ownerId: string,
    botId: string,
    body: z.infer<typeof BotManifestUpdate>,
  ) {
    const bot = await this.bots.store.bot(botId);
    if (!bot || bot.ownerId !== ownerId)
      throw notFound("You have no bot with that id");
    validateBotVoicePublicKey(body.voicePublicKey);
    await this.bots.ctx.ws.write((w) => {
      const prior = w.get<Requested>("bot_requested_permissions", {
        bot_id: botId,
      });
      if ((prior?.rev ?? 0) !== body.rev)
        throw new ApiError(
          409,
          "stale_revision",
          "The requested permissions changed. Reload before saving.",
        );
      const change = {
        permissions: JSON.stringify(body.permissions),
        rev: body.rev + 1,
        updated_at: this.bots.clock(),
        ...(body.voicePublicKey === undefined ? {} : { voice_public_key: body.voicePublicKey }),
      };
      w.upsert(
        "bot_requested_permissions",
        { bot_id: botId, ...change },
        change,
      );
    });
    this.bots.ctx.audit({
      actorId: ownerId,
      action: "bot.permissions.requested",
      target: botId,
    });
    this.bots.events.invalidate(botId);
    return this.manifest(botId);
  }

  installation(orgId: string, botId: string) {
    const row = this.bots.ctx.ws.get<Approved>("bot_installation_permissions", {
      org_id: orgId,
      bot_id: botId,
    });
    return {
      orgId,
      botId,
      permissions: read(row?.permissions),
      manifestRev: row?.manifest_rev ?? 0,
      rev: row?.rev ?? 0,
      approvedBy: row?.approved_by ?? null,
      approvedAt: row?.approved_at ?? null,
    };
  }

  review(actorId: string, orgId: string, botId: string) {
    const ctx = this.bots.ctx;
    requireBotManager(ctx, orgId, actorId);
    ctx.authz.requireOrgMember(orgId, botId);
    const manifest = this.manifest(botId);
    const actorPermissions = ctx.authz.permissions(orgId, actorId);
    return {
      manifest,
      installation: this.installation(orgId, botId),
      approvable: manifest.permissions.filter(
        (permission) =>
          READ_SCOPES.has(permission) ||
          actorPermissions.has(nativePermission(permission) as never),
      ),
    };
  }

  async approve(
    actorId: string,
    orgId: string,
    botId: string,
    body: z.infer<typeof BotInstallationApproval>,
  ) {
    const ctx = this.bots.ctx;
    requireBotManager(ctx, orgId, actorId);
    if (!(await this.bots.store.bot(botId)))
      throw notFound("No bot with that id");
    await ctx.ws.write((w) => {
      requireBotManager(ctx, orgId, actorId);
      ctx.authz.requireOrgMember(orgId, botId);
      const manifest = w.get<Requested>("bot_requested_permissions", {
        bot_id: botId,
      });
      if (!manifest || manifest.rev !== body.manifestRev)
        throw new ApiError(
          409,
          "stale_revision",
          "The bot changed its requested permissions. Review them again.",
        );
      const prior = w.get<Approved>("bot_installation_permissions", {
        org_id: orgId,
        bot_id: botId,
      });
      if ((prior?.rev ?? 0) !== body.rev)
        throw new ApiError(
          409,
          "stale_revision",
          "This installation changed. Reload before saving.",
        );
      const requested = new Set(read(manifest.permissions));
      const actorPermissions = ctx.authz.permissions(orgId, actorId);
      for (const permission of body.permissions) {
        if (!requested.has(permission))
          throw forbidden("The bot did not request this permission");
        if (
          !READ_SCOPES.has(permission) &&
          !actorPermissions.has(nativePermission(permission) as never)
        )
          throw forbidden("You cannot approve a permission you do not hold");
      }
      const change = {
        permissions: JSON.stringify(body.permissions),
        manifest_rev: manifest.rev,
        rev: body.rev + 1,
        approved_by: actorId,
        approved_at: this.bots.clock(),
        install_key: prior?.install_key || newId("bi"),
      };
      w.upsert(
        "bot_installation_permissions",
        { org_id: orgId, bot_id: botId, ...change },
        change,
      );
    });
    ctx.audit({
      actorId,
      orgId,
      action: "bot.permissions.approved",
      target: botId,
    });
    this.bots.events.invalidate(botId);
    return this.installation(orgId, botId);
  }

  allows(bot: Bot, orgId: string, permission: BotPlatformScope): boolean {
    return this.allowsId(bot.id, orgId, permission);
  }

  private allowsId(
    botId: string,
    orgId: string,
    permission: BotPlatformScope,
  ): boolean {
    const ctx = this.bots.ctx;
    if (!ctx.authz.permissions(orgId, botId).size) return false;
    const approved = this.installation(orgId, botId);
    return (
      approved.permissions.includes(permission) &&
      this.manifest(botId).permissions.includes(permission)
    );
  }

  require(bot: Bot, orgId: string, permission: BotPlatformScope): void {
    if (!this.allows(bot, orgId, permission))
      throw forbidden(
        "This bot installation has not been approved for that action",
      );
  }

  /** Unlike the ordinary scope intersection, media key approval binds the exact current manifest revision. */
  approvedVoiceKey(bot: Bot, orgId: string) {
    this.require(bot, orgId, "voice.connect");
    const manifest = this.manifest(bot.id);
    if (!manifest.voicePublicKey || this.installation(orgId, bot.id).manifestRev !== manifest.rev)
      throw forbidden("A manager must review the current bot voice encryption key before it can join media");
    return { publicKey: manifest.voicePublicKey, fingerprint: manifest.voiceKeyFingerprint!, revision: manifest.rev, installationKey: this.installationKey(orgId, bot.id) };
  }

  async prepareCredential(
    actorId: string,
    orgId: string,
    authenticatedHash?: string,
  ): Promise<CredentialBinding | null> {
    if (!isBotUser(this.bots.ctx, actorId)) return null;
    const bot = await this.bots.store.bot(actorId);
    if (!bot || !authenticatedHash || bot.tokenHash !== authenticatedHash)
      throw forbidden("The bot credential is no longer valid");
    await this.bots.requireActive(bot);
    this.require(bot, orgId, "webhooks.manage");
    return {
      bot_id: actorId,
      org_id: orgId,
      bot_token_hash: authenticatedHash,
      install_key: this.installationKey(orgId, actorId),
      created_at: this.bots.clock(),
    };
  }

  bindCredential(
    writer: RowWriter,
    credentialId: string,
    binding: CredentialBinding | null,
  ): void {
    if (binding)
      writer.upsert(
        "bot_derived_credentials",
        { credential_id: credentialId, ...binding },
        binding,
      );
    else
      writer.delete("bot_derived_credentials", { credential_id: credentialId });
  }

  /** Returns a currently authorized bot actor, or null for an independently human-owned credential. */
  async credentialActor(credentialId: string): Promise<string | null> {
    const binding = this.bots.ctx.ws.get<CredentialBinding>(
      "bot_derived_credentials",
      { credential_id: credentialId },
    );
    if (!binding) return null;
    const bot = await this.bots.store.bot(binding.bot_id);
    if (!bot || bot.tokenHash !== binding.bot_token_hash)
      throw notFound("No webhook at that address");
    await this.bots.requireActive(bot);
    if (
      !this.allows(bot, binding.org_id, "webhooks.manage") ||
      binding.install_key !== this.installationKey(binding.org_id, bot.id)
    )
      throw notFound("No webhook at that address");
    return bot.id;
  }

  async credentialRevision(
    bot: Bot,
    tokenHash: string,
    active = true,
  ): Promise<void> {
    await this.bots.ctx.ws.write((w) => {
      const row = {
        bot_id: bot.id,
        owner_id: bot.ownerId,
        token_hash: tokenHash,
        created_at: bot.createdAt,
        active: active ? 1 : 0,
      };
      w.upsert("bot_credential_revisions", row, row);
    });
  }

  async prepareInvite(
    actorId: string,
    orgId: string,
    authenticatedHash?: string,
  ): Promise<CredentialBinding | null> {
    if (!isBotUser(this.bots.ctx, actorId)) return null;
    const bot = await this.bots.store.bot(actorId);
    if (!bot || !authenticatedHash || bot.tokenHash !== authenticatedHash)
      throw forbidden("The bot credential is no longer valid");
    await this.bots.requireActive(bot);
    this.require(bot, orgId, "members.invite");
    const peers = await this.bots.store.botsOf(bot.ownerId);
    // Seed existing owners once, without overwriting a concurrent rotation/deletion tombstone.
    await this.bots.ctx.ws.write((w) => {
      for (const peer of peers)
        if (!w.get("bot_credential_revisions", { bot_id: peer.id })) {
          w.insert("bot_credential_revisions", {
            bot_id: peer.id,
            owner_id: peer.ownerId,
            token_hash: peer.tokenHash,
            created_at: peer.createdAt,
            active: 1,
          });
        }
    });
    return {
      bot_id: bot.id,
      org_id: orgId,
      bot_token_hash: authenticatedHash,
      install_key: this.installationKey(orgId, bot.id),
      created_at: this.bots.clock(),
    };
  }

  bindInvite(
    writer: RowWriter,
    inviteId: string,
    role: string,
    binding: CredentialBinding | null,
  ): void {
    if (!binding) return;
    const revision = writer.get<CredentialRevision>(
      "bot_credential_revisions",
      { bot_id: binding.bot_id },
    );
    if (
      !revision?.active ||
      revision.token_hash !== binding.bot_token_hash ||
      binding.install_key !==
        this.installationKey(binding.org_id, binding.bot_id) ||
      !this.allowsId(binding.bot_id, binding.org_id, "members.invite") ||
      !this.bots.ctx.authz.canIssueInvite(binding.org_id, binding.bot_id, role)
    )
      throw forbidden("The bot's invitation permission changed");
    writer.insert("bot_invite_credentials", {
      invite_id: inviteId,
      ...binding,
    });
  }

  inviteCredentialValid(
    inviteId: string,
    creatorId: string,
    orgId: string,
  ): boolean {
    const ctx = this.bots.ctx;
    const binding = ctx.ws.get<CredentialBinding>("bot_invite_credentials", {
      invite_id: inviteId,
    });
    if (!binding) return !isBotUser(ctx, creatorId);
    const revision = ctx.ws.get<CredentialRevision>(
      "bot_credential_revisions",
      { bot_id: binding.bot_id },
    );
    if (
      !revision?.active ||
      revision.token_hash !== binding.bot_token_hash ||
      binding.install_key !== this.installationKey(orgId, binding.bot_id) ||
      ctx.accounts.identityBlocked(binding.bot_id) ||
      !this.allowsId(binding.bot_id, orgId, "members.invite")
    )
      return false;
    const limits = ctx.mojo.limitsOf(revision.owner_id);
    if (!limits) return true;
    return ctx.ws
      .all<CredentialRevision>("bot_credential_revisions", {
        where: { owner_id: revision.owner_id, active: 1 },
        orderBy: [
          ["created_at", "asc"],
          ["bot_id", "asc"],
        ],
        limit: limits.bots,
      })
      .some((row) => row.bot_id === binding.bot_id);
  }

  /** Internal current installation identity; never part of a public response. */
  installationIdentity(orgId: string, botId: string): string {
    return this.installationKey(orgId, botId);
  }
  private installationKey(orgId: string, botId: string): string {
    return (
      this.bots.ctx.ws.get<Approved>("bot_installation_permissions", {
        org_id: orgId,
        bot_id: botId,
      })?.install_key ?? ""
    );
  }

  /** Seed only absent denial records; a removed/rotated credential must never be resurrected. */
  async ensureCredentials(bot: Bot) {
    const peers = await this.bots.store.botsOf(bot.ownerId);
    await this.bots.ctx.ws.write((w) => {
      for (const peer of peers) if (!w.get("bot_credential_revisions", { bot_id: peer.id }))
        w.insert("bot_credential_revisions", { bot_id: peer.id, owner_id: peer.ownerId, token_hash: peer.tokenHash, created_at: peer.createdAt, active: 1 });
    });
  }
  currentCredential(botId: string, tokenHash: string): boolean {
    const { ctx } = this.bots;
    const row = ctx.ws.get<CredentialRevision>("bot_credential_revisions", { bot_id: botId });
    if (!row?.active || row.token_hash !== tokenHash || ctx.accounts.identityBlocked(botId)) return false;
    const limits = ctx.mojo.limitsOf(row.owner_id);
    return !limits || ctx.ws.all<CredentialRevision>("bot_credential_revisions", { where: { owner_id: row.owner_id, active: 1 }, orderBy: [["created_at", "asc"], ["bot_id", "asc"]], limit: limits.bots }).some((peer) => peer.bot_id === botId);
  }

  revisionKey(orgId: string, botId: string): string {
    const row = this.bots.ctx.ws.get<Approved>("bot_installation_permissions", {
      org_id: orgId,
      bot_id: botId,
    });
    return JSON.stringify([
      this.manifest(botId).rev,
      row?.install_key ?? null,
      row?.rev ?? 0,
    ]);
  }
}

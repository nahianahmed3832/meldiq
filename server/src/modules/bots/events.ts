import { ApiError } from "../../shared/errors.js";
import { botChannels, membershipsOf } from "../organizations/index.js";
import type { BotService } from "./service.js";
import type { Bot } from "./store.js";
import { BotEventCursor, BOT_REPLAY_MS } from "./eventCursor.js";
import { BotEventPage } from "../../shared/contracts/http/botPlatform.js";

type Grant = {
  org: string;
  channel: string | null;
  kind: string;
  since: number;
};
type JournalEvent = {
  id: string;
  seq: string;
  kind: string;
  org_id: string | null;
  conversation_id: string | null;
  actor_id: string | null;
  target_id: string | null;
  source_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
};

/** Durable ID-only events. Message content remains on the separately authorized native history path. */
export class BotEvents {
  private cursor?: BotEventCursor;
  private cleanupAt = 0;
  private cleanup?: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private readonly invalidations = new Set<(botId: string) => void>();
  constructor(private readonly bots: BotService) {}

  supported(): boolean {
    return !!this.bots.ctx.postgres;
  }
  onWake(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  notify(): void {
    for (const listener of this.listeners) listener();
  }
  onInvalidate(listener: (botId: string) => void): () => void {
    this.invalidations.add(listener);
    return () => {
      this.invalidations.delete(listener);
    };
  }
  invalidate(botId: string): void {
    for (const listener of this.invalidations) listener(botId);
    this.notify();
  }
  authorityKey(bot: Bot): string {
    const revisions = membershipsOf(this.bots.ctx.ws, bot.id)
      .map((row) => [
        row.org_id,
        this.bots.permissions.revisionKey(row.org_id, bot.id),
      ])
      .sort((a, b) => a[0].localeCompare(b[0]));
    return JSON.stringify({ grants: this.grants(bot), revisions });
  }
  communities(bot: Bot): string[] {
    return membershipsOf(this.bots.ctx.ws, bot.id).map((row) => row.org_id);
  }

  /** One shared wake-up query; unrelated activity must not start a database poll for every bot socket. */
  async changes(after: string) {
    const result = await this.database().query<{
      watermark: string;
      changed: { org: string | null; bot: string | null }[];
    }>(
      `WITH clock AS (
      SELECT last_seq FROM meldiq_private.bot_event_clock WHERE singleton=1
    ) SELECT clock.last_seq::text AS watermark, COALESCE((SELECT jsonb_agg(changed) FROM (
      SELECT DISTINCT j.org_id AS org,j.target_bot_id AS bot FROM meldiq_private.bot_event_journal j
      WHERE j.seq>$1::bigint AND j.seq<=clock.last_seq LIMIT 201
    ) changed),'[]'::jsonb) AS changed FROM clock`,
      [after],
    );
    return result.rows[0];
  }

  private database() {
    const db = this.bots.ctx.postgres?.database;
    if (!db)
      throw new ApiError(
        503,
        "bot_events_unavailable",
        "Durable bot events require the authoritative PostgreSQL adapter",
      );
    return db;
  }

  private codec() {
    return (this.cursor ??= new BotEventCursor(this.bots.ctx.config.dataDir));
  }

  async fresh(bot: Bot): Promise<Bot> {
    const current = await this.bots.store.bot(bot.id);
    if (!current || current.tokenHash !== bot.tokenHash)
      throw new ApiError(401, "unauthorized", "The bot credential was revoked");
    await this.bots.requireActive(current);
    return current;
  }

  private grants(bot: Bot): Grant[] {
    const { ctx, permissions } = this.bots;
    const result: Grant[] = [];
    const add = (
      org: string,
      channel: string | null,
      kind: string,
      since: number,
    ) => result.push({ org, channel, kind, since });
    for (const membership of membershipsOf(ctx.ws, bot.id)) {
      const org = membership.org_id;
      // Command arguments are already explicitly addressed to this bot. Current channel membership still applies.
      for (const channel of botChannels(ctx, org, bot.id)) {
        if (channel.canPost)
          add(
            org,
            channel.id,
            "command",
            Math.max(
              membership.joined_at ?? 0,
              ctx.authz.memberSince(channel.id, bot.id) ?? 0,
            ),
          );
        if (!permissions.allows(bot, org, "events.read")) continue;
        const conv = ctx.authz.conversation(channel.id)!;
        if (permissions.allows(bot, org, "messages.history")) {
          const historySince = ctx.authz.historySince(conv, bot.id) ?? 0;
          for (const kind of ["message", "reaction_add", "reaction_remove"])
            add(org, channel.id, kind, historySince);
        }
        if (
          permissions.allows(bot, org, "voice.connect") &&
          !ctx.authz.voiceBanned(org, bot.id) &&
          ctx.authz.channelPermissions(conv, bot.id).has("voice.connect")
        ) {
          for (const kind of ["voice_join", "voice_leave"])
            add(org, channel.id, kind, 0);
        }
      }
      if (!permissions.allows(bot, org, "events.read")) continue;
      if (
        permissions.allows(bot, org, "members.read") &&
        ctx.authz.permissions(org, bot.id).has("members.view")
      )
        for (const kind of ["member_join", "member_leave"])
          add(org, null, kind, 0);
      if (
        permissions.allows(bot, org, "members.invite") &&
        ctx.authz.permissions(org, bot.id).has("members.invites.manage")
      ) {
        for (const kind of ["invite_create", "invite_delete"])
          add(org, null, kind, 0);
      }
    }
    if (result.length > 20_000)
      throw new ApiError(
        429,
        "rate_limited",
        "Too many event subscriptions for one bot",
      );
    return result.sort(
      (a, b) =>
        a.org.localeCompare(b.org) ||
        (a.channel ?? "").localeCompare(b.channel ?? "") ||
        a.kind.localeCompare(b.kind) ||
        a.since - b.since,
    );
  }

  async page(bot: Bot, cursor?: string, limit = 50) {
    const db = this.database();
    await this.fresh(bot);
    const now = this.bots.clock();
    const position = cursor ? this.codec().open(bot.id, cursor, now) : "0";
    for (let attempt = 0; attempt < 3; attempt++) {
      const grants = JSON.stringify(this.grants(bot));
      const authority = this.authorityKey(bot);
      const result = await db.query<{
        watermark: string;
        events: JournalEvent[];
      }>(
        `WITH clock AS (
        SELECT last_seq FROM meldiq_private.bot_event_clock WHERE singleton=1
      ), grants AS (
        SELECT * FROM jsonb_to_recordset($3::jsonb) AS g(org text,channel text,kind text,since bigint)
      ) SELECT clock.last_seq::text AS watermark, COALESCE((
        SELECT jsonb_agg(to_jsonb(page) ORDER BY page.seq::bigint) FROM (
          SELECT j.id,j.seq::text,j.kind,j.org_id,j.conversation_id,j.actor_id,j.target_id,j.source_id,j.metadata,j.created_at
          FROM meldiq_private.bot_event_journal j
          WHERE j.seq>$1::bigint AND j.seq<=clock.last_seq AND j.expires_at>$4 AND j.created_at>=$4-$6
          AND (j.kind<>'command' OR EXISTS (
            SELECT 1 FROM meldiq.bot_interactions i
            JOIN meldiq.conversation_members recipient ON recipient.conversation_id=i.conversation_id AND recipient.user_id=i.bot_id AND recipient.joined_at<=i.created_at
            JOIN meldiq.conversation_members sender ON sender.conversation_id=i.conversation_id AND sender.user_id=i.user_id AND sender.joined_at<=i.created_at
            JOIN meldiq.org_members member ON member.org_id=i.org_id AND member.user_id=i.user_id AND member.joined_at<=i.created_at
            WHERE i.id=j.source_id AND i.bot_id=$2 AND i.expires_at>$4 AND i.state<>'replied' AND (member.expires_at IS NULL OR member.expires_at>$4)
          ))
          AND ((j.kind='test' AND j.target_bot_id=$2) OR (
            (j.target_bot_id IS NULL OR j.target_bot_id=$2) AND EXISTS (
              SELECT 1 FROM grants g WHERE g.org=j.org_id AND g.channel IS NOT DISTINCT FROM j.conversation_id
              AND g.kind=j.kind
              AND (j.kind='command' OR EXISTS (SELECT 1 FROM meldiq_private.bot_installation_boundaries boundary
                WHERE boundary.org_id=j.org_id AND boundary.bot_id=$2 AND j.seq>boundary.after_seq))
              AND (j.kind NOT IN ('message','reaction_add','reaction_remove') OR EXISTS (
                SELECT 1 FROM meldiq.message_events m WHERE m.id=CASE WHEN j.kind='message' THEN j.source_id ELSE j.target_id END
                AND m.conversation_id=j.conversation_id AND m.audience='all' AND m.server_ts>=g.since
              ))
            )
          )) ORDER BY j.seq LIMIT $5
        ) page
      ),'[]'::jsonb) AS events FROM clock`,
        [position, bot.id, grants, now, limit + 1, BOT_REPLAY_MS],
      );
      await this.fresh(bot);
      if (this.authorityKey(bot) !== authority) continue;
      const row = result.rows[0];
      if (!row || BigInt(position) > BigInt(row.watermark))
        throw new ApiError(400, "bad_request", "Invalid bot event cursor");
      const more = row.events.length > limit;
      const selected = row.events.slice(0, limit);
      const next = more ? selected.at(-1)!.seq : row.watermark;
      this.prune(now);
      return BotEventPage.parse({
        events: selected.map(({ seq: _seq, ...event }) => ({
          id: event.id,
          type: event.kind,
          communityId: event.org_id,
          channelId: event.conversation_id,
          actorId: event.actor_id,
          targetId: event.target_id,
          sourceId: event.source_id,
          data: event.metadata,
          createdAt: event.created_at,
        })),
        cursor: this.codec().seal(bot.id, next, now),
        more,
        replayWindowSeconds: BOT_REPLAY_MS / 1000,
      });
    }
    throw new ApiError(
      409,
      "stale_revision",
      "Bot permissions changed during replay. Retry with the same cursor.",
    );
  }

  /** Bounded operational queue cleanup; it never changes message, file, call or audit retention. */
  private prune(now: number) {
    if (now < this.cleanupAt || this.cleanup) return;
    this.cleanupAt = now + 60_000;
    this.cleanup = this.database()
      .query(
        `DELETE FROM meldiq_private.bot_event_journal WHERE seq IN (
      SELECT seq FROM meldiq_private.bot_event_journal WHERE expires_at<=$1 ORDER BY expires_at LIMIT 1000
    )`,
        [now],
      )
      .then(() => {})
      .catch(() => {
        this.cleanupAt = 0;
      })
      .finally(() => {
        this.cleanup = undefined;
      });
  }
}

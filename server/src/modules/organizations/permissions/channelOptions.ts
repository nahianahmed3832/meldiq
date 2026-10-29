/**
 * A community channel's options (community parity A1, feature "community-permissions", migration 069): pure, so the
 * routes, authorisation and the tests read the same rules.
 *
 * - textOnly: no files, GIFs or stickers, except from people who manage the channel or its messages;
 * - noGifs: no GIFs from the picker and no GIF links (pictures are fine), with the same exception;
 * - stage (voice channels): people listen until a moderator lets them speak;
 * - readOnly: everyone reads and reacts; only holders of [posterRoleIds] and the channel's managers post.
 */
export interface ChannelOptions {
  textOnly: boolean;
  noGifs: boolean;
  stage: boolean;
  readOnly: boolean;
  posterRoleIds: string[];
}

export const NO_CHANNEL_OPTIONS: ChannelOptions = { textOnly: false, noGifs: false, stage: false, readOnly: false, posterRoleIds: [] };

/** At most this many roles may post in a read-only channel. */
export const POSTER_ROLES_MAX = 20;

/** The stored row of channel_options. */
export interface ChannelOptionsRow {
  conversation_id: string;
  org_id: string;
  text_only: number;
  no_gifs: number;
  stage: number;
  read_only: number;
  poster_role_ids: string;
  updated_by: string;
  updated_at: number;
}

function parseIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, POSTER_ROLES_MAX) : [];
  } catch {
    return [];
  }
}

export function optionsOfRow(r: ChannelOptionsRow | undefined): ChannelOptions {
  if (!r) return NO_CHANNEL_OPTIONS;
  return { textOnly: r.text_only === 1, noGifs: r.no_gifs === 1, stage: r.stage === 1, readOnly: r.read_only === 1, posterRoleIds: parseIds(r.poster_role_ids) };
}

/** Whether a read-only channel stops this person posting: they hold none of its poster roles and don't moderate it. */
export function readOnlyStops(o: ChannelOptions, roleIds: readonly string[], moderates: boolean): boolean {
  return o.readOnly && !moderates && !o.posterRoleIds.some((r) => roleIds.includes(r));
}

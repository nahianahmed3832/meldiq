import type { z } from "zod/v4";
import type {
  LobbyBoard,
  LobbyLook,
  LobbySection,
  LobbySectionKey,
  LobbySettings,
  LobbyTemplateKey,
} from "../../../shared/contracts/http/communityLobby.js";
import { LOBBY_SECTION_KEYS } from "../../../shared/contracts/http/communityLobby.js";

export type Settings = z.infer<typeof LobbySettings>;
export type Look = z.infer<typeof LobbyLook>;
export type Section = z.infer<typeof LobbySection>;
export type SectionKey = z.infer<typeof LobbySectionKey>;
export type Board = z.infer<typeof LobbyBoard>;
export type TemplateKey = z.infer<typeof LobbyTemplateKey>;

/** Cards in the side column of the classic layout by default (the rest sit in the main column). */
const SIDE_BY_DEFAULT: ReadonlySet<SectionKey> = new Set([
  "leaderboard",
  "pick_roles",
  "rules",
  "who_runs_it",
  "links",
]);

export const DEFAULT_LOOK: Look = {
  layout: "classic",
  accent: "auto",
  background: "glow",
  cards: "filled",
  font: "default",
  bannerHeight: "normal",
  title: "left",
};

export const DEFAULT_SECTIONS: readonly Section[] = LOBBY_SECTION_KEYS.map(
  (key) => ({
    key,
    shown: true,
    column: SIDE_BY_DEFAULT.has(key) ? "side" : "main",
  }),
);

/** A community that never saved its lobby: shown to members, everything empty, the default look and order. */
export function defaultSettings(): Settings {
  return {
    enabled: true,
    tagline: null,
    buttons: [],
    about: null,
    mainChannelIds: [],
    faq: [],
    showWhoRunsIt: true,
    look: { ...DEFAULT_LOOK },
    sections: DEFAULT_SECTIONS.map((s) => ({ ...s })),
    phoneOrder: [...LOBBY_SECTION_KEYS],
    ordersLinked: false,
    leaderboards: ["levels", "messages_week", "invites"],
  };
}

interface Template {
  look: Look;
  /** Shown cards in order, each with its column; every other card follows, hidden, in its default column. */
  shown: readonly (readonly [SectionKey, "main" | "side"])[];
  leaderboards: readonly Board[];
  /** Starter questions, only used when the FAQ is empty. */
  faq: readonly (readonly [string, string])[];
}

const TEMPLATES: Record<TemplateKey, Template> = {
  // Live voice up top, bold and dark: rooms, then where to chat, then what's happening.
  gaming: {
    look: {
      layout: "classic",
      accent: "#8b5cf6",
      background: "mesh",
      cards: "glass",
      font: "display",
      bannerHeight: "tall",
      title: "left",
    },
    shown: [
      ["live_now", "main"],
      ["main_channels", "main"],
      ["giveaways", "main"],
      ["feed", "main"],
      ["about", "main"],
      ["faq", "main"],
      ["leaderboard", "side"],
      ["pick_roles", "side"],
      ["rules", "side"],
      ["who_runs_it", "side"],
    ],
    leaderboards: ["levels", "messages_week", "invites"],
    faq: [
      [
        "How do I find people to play with?",
        "Hop into a voice room under Live now, or say what you're playing in one of the main channels.",
      ],
      [
        "How do I get my game roles?",
        "Use Pick your roles on this page to choose the games you play. You can change them any time.",
      ],
      [
        "Can I share clips and streams?",
        "Yes, in the channels meant for them. Keep it to your own content and read the rules first.",
      ],
    ],
  },
  // Calm and readable: one centred column, serif text, no leaderboards or giveaways.
  study: {
    look: {
      layout: "spotlight",
      accent: "#4f7cac",
      background: "plain",
      cards: "outline",
      font: "serif",
      bannerHeight: "short",
      title: "centered",
    },
    shown: [
      ["about", "main"],
      ["main_channels", "main"],
      ["live_now", "main"],
      ["faq", "main"],
      ["rules", "main"],
      ["pick_roles", "main"],
      ["who_runs_it", "main"],
      ["links", "main"],
    ],
    leaderboards: ["messages_week"],
    faq: [
      [
        "Where do I ask a question?",
        "Pick the main channel for your subject and include what you tried so far.",
      ],
      [
        "Are there study sessions?",
        "When people are studying together, their rooms show under Live now. Join quietly and say hi in the chat.",
      ],
      [
        "Can I share notes?",
        "Yes, as long as they're your own or you're allowed to share them.",
      ],
    ],
  },
  // Banner and links first: a magazine page that leads with the feed and where to follow.
  creators: {
    look: {
      layout: "magazine",
      accent: "#ec4899",
      background: "banner_blur",
      cards: "filled",
      font: "rounded",
      bannerHeight: "tall",
      title: "centered",
    },
    shown: [
      ["feed", "main"],
      ["links", "main"],
      ["about", "main"],
      ["main_channels", "main"],
      ["giveaways", "main"],
      ["faq", "main"],
      ["leaderboard", "side"],
      ["who_runs_it", "side"],
      ["rules", "side"],
      ["pick_roles", "side"],
    ],
    leaderboards: ["invites", "messages_week"],
    faq: [
      [
        "When are new posts out?",
        "New uploads land in the Feed on this page as soon as they're live.",
      ],
      [
        "How do I get notified?",
        "Pick the notification roles under Pick your roles, if the community has them.",
      ],
      [
        "Can I promote my own work?",
        "Only in the channels made for it. Check the rules first.",
      ],
      [
        "How do I support the creator?",
        "The links on this page are the best place to start.",
      ],
    ],
  },
  // Warm and friendly: a glow, rounded type, everyone's favourite channels and who's around.
  hangout: {
    look: {
      layout: "classic",
      accent: "#f59e0b",
      background: "glow",
      cards: "filled",
      font: "rounded",
      bannerHeight: "normal",
      title: "left",
    },
    shown: [
      ["about", "main"],
      ["main_channels", "main"],
      ["live_now", "main"],
      ["giveaways", "main"],
      ["faq", "main"],
      ["pick_roles", "side"],
      ["leaderboard", "side"],
      ["who_runs_it", "side"],
      ["rules", "side"],
      ["links", "side"],
    ],
    leaderboards: ["messages_week", "levels"],
    faq: [
      [
        "I'm new, where do I start?",
        "Say hi in the first main channel. People here are friendly.",
      ],
      [
        "Can I invite friends?",
        "Of course. Use Invite people in the community menu.",
      ],
      [
        "Who do I talk to if something's wrong?",
        "Message anyone under Who runs it.",
      ],
    ],
  },
  // Just the essentials, compact.
  minimal: {
    look: {
      layout: "compact",
      accent: "auto",
      background: "plain",
      cards: "outline",
      font: "default",
      bannerHeight: "short",
      title: "left",
    },
    shown: [
      ["about", "main"],
      ["main_channels", "main"],
      ["faq", "main"],
      ["rules", "main"],
    ],
    leaderboards: ["messages_week"],
    faq: [
      [
        "What is this community about?",
        "Read the about text above, then jump into a main channel.",
      ],
      ["Where are the rules?", "Under Rules on this page."],
      [
        "Who can I ask for help?",
        "Anyone who runs the community: ask in a main channel.",
      ],
    ],
  },
};

/** A template's full section list: its shown cards in order, then the others hidden. */
function templateSections(t: Template): Section[] {
  const shown = new Set(t.shown.map(([k]) => k));
  const rest = DEFAULT_SECTIONS.filter((s) => !shown.has(s.key)).map((s) => ({
    ...s,
    shown: false,
  }));
  return [
    ...t.shown.map(([key, column]) => ({ key, shown: true, column })),
    ...rest,
  ];
}

/**
 * [current] with [key]'s look, section layout and boards. Text, channels and buttons stay; the template's starter
 * questions fill the FAQ only when it's empty. [newFaqId] makes each starter question's id.
 */
export function applyTemplate(
  current: Settings,
  key: TemplateKey,
  newFaqId: () => string,
): Settings {
  const t = TEMPLATES[key];
  const sections = templateSections(t);
  const faq =
    current.faq.length > 0
      ? current.faq
      : t.faq.map(([question, answer]) => ({
          id: newFaqId(),
          question,
          answer,
        }));
  return {
    ...current,
    look: { ...t.look },
    sections,
    phoneOrder: sections.map((s) => s.key),
    ordersLinked: false,
    leaderboards: [...t.leaderboards],
    faq,
    showWhoRunsIt: sections.find((s) => s.key === "who_runs_it")!.shown,
  };
}

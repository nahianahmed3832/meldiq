/** Permanent cosmetic achievements. Progress comes only from accepted server activity. */
export type AchievementMetric =
  | "visits"
  | "streak"
  | "earned"
  | "level"
  | "quests"
  | "invites"
  | "communities"
  | "chatBlocks";
export interface AchievementSpec {
  id: string;
  name: string;
  description: string;
  metric: AchievementMetric;
  goal: number;
  tier: "bronze" | "silver" | "gold" | "mythic";
  icon: string;
}
export const ACHIEVEMENTS: readonly AchievementSpec[] = [
  {
    id: "first-ember",
    name: "First Ember",
    description: "Check in on your first eligible day.",
    metric: "visits",
    goal: 1,
    tier: "bronze",
    icon: "flame",
  },
  {
    id: "regular",
    name: "Regular",
    description: "Visit Meldiq on 30 different days.",
    metric: "visits",
    goal: 30,
    tier: "silver",
    icon: "calendar",
  },
  {
    id: "familiar-face",
    name: "Familiar Face",
    description: "Visit Meldiq on 100 different days.",
    metric: "visits",
    goal: 100,
    tier: "gold",
    icon: "calendar",
  },
  {
    id: "kindling",
    name: "Kindling",
    description: "Keep a three-day visit streak.",
    metric: "streak",
    goal: 3,
    tier: "bronze",
    icon: "flame",
  },
  {
    id: "steady-flame",
    name: "Steady Flame",
    description: "Keep a seven-day visit streak.",
    metric: "streak",
    goal: 7,
    tier: "silver",
    icon: "flame",
  },
  {
    id: "bright-flame",
    name: "Bright Flame",
    description: "Keep a fourteen-day visit streak.",
    metric: "streak",
    goal: 14,
    tier: "gold",
    icon: "flame",
  },
  {
    id: "everglow",
    name: "Everglow",
    description: "Keep a thirty-day visit streak.",
    metric: "streak",
    goal: 30,
    tier: "mythic",
    icon: "flame",
  },
  {
    id: "ember-keeper",
    name: "Ember Keeper",
    description: "Earn 100 Embers in total.",
    metric: "earned",
    goal: 100,
    tier: "bronze",
    icon: "gem",
  },
  {
    id: "ember-collector",
    name: "Ember Collector",
    description: "Earn 1,000 Embers in total.",
    metric: "earned",
    goal: 1000,
    tier: "silver",
    icon: "gem",
  },
  {
    id: "ember-vault",
    name: "Ember Vault",
    description: "Earn 10,000 Embers in total.",
    metric: "earned",
    goal: 10000,
    tier: "mythic",
    icon: "gem",
  },
  {
    id: "rising-light",
    name: "Rising Light",
    description: "Reach account level 5.",
    metric: "level",
    goal: 5,
    tier: "bronze",
    icon: "star",
  },
  {
    id: "trailblazer",
    name: "Trailblazer",
    description: "Reach account level 10.",
    metric: "level",
    goal: 10,
    tier: "silver",
    icon: "star",
  },
  {
    id: "luminary",
    name: "Luminary",
    description: "Reach account level 25.",
    metric: "level",
    goal: 25,
    tier: "gold",
    icon: "crown",
  },
  {
    id: "constellation",
    name: "Constellation",
    description: "Reach account level 50.",
    metric: "level",
    goal: 50,
    tier: "mythic",
    icon: "crown",
  },
  {
    id: "quest-apprentice",
    name: "Quest Apprentice",
    description: "Complete 5 quests.",
    metric: "quests",
    goal: 5,
    tier: "bronze",
    icon: "compass",
  },
  {
    id: "quest-seeker",
    name: "Quest Seeker",
    description: "Complete 25 quests.",
    metric: "quests",
    goal: 25,
    tier: "silver",
    icon: "compass",
  },
  {
    id: "quest-master",
    name: "Quest Master",
    description: "Complete 100 quests.",
    metric: "quests",
    goal: 100,
    tier: "gold",
    icon: "trophy",
  },
  {
    id: "welcome-guide",
    name: "Welcome Guide",
    description: "Invite someone who stays in a community for seven days.",
    metric: "invites",
    goal: 1,
    tier: "bronze",
    icon: "heart",
  },
  {
    id: "community-magnet",
    name: "Community Magnet",
    description: "Bring five people who stay for seven days.",
    metric: "invites",
    goal: 5,
    tier: "silver",
    icon: "heart",
  },
  {
    id: "bridge-builder",
    name: "Bridge Builder",
    description: "Bring ten people who stay for seven days.",
    metric: "invites",
    goal: 10,
    tier: "gold",
    icon: "heart",
  },
  {
    id: "first-campfire",
    name: "First Campfire",
    description: "Join your first community.",
    metric: "communities",
    goal: 1,
    tier: "bronze",
    icon: "tent",
  },
  {
    id: "wayfinder",
    name: "Wayfinder",
    description: "Be part of three communities.",
    metric: "communities",
    goal: 3,
    tier: "silver",
    icon: "tent",
  },
  {
    id: "world-walker",
    name: "World Walker",
    description: "Be part of ten communities.",
    metric: "communities",
    goal: 10,
    tier: "gold",
    icon: "globe",
  },
  {
    id: "first-conversation",
    name: "First Conversation",
    description: "Complete your first five-minute active chat block.",
    metric: "chatBlocks",
    goal: 1,
    tier: "bronze",
    icon: "message",
  },
  {
    id: "conversation-weaver",
    name: "Conversation Weaver",
    description: "Complete twenty active chat blocks.",
    metric: "chatBlocks",
    goal: 20,
    tier: "silver",
    icon: "message",
  },
  {
    id: "campfire-storyteller",
    name: "Campfire Storyteller",
    description: "Complete one hundred active chat blocks.",
    metric: "chatBlocks",
    goal: 100,
    tier: "gold",
    icon: "message",
  },
];

export type AchievementProgress = Record<AchievementMetric, number>;
export type AchievementAward = {
  userId: string;
  achievementId: string;
  at: number;
};

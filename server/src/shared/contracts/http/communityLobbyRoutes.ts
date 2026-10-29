import { OrgParamsNonEmpty } from "./community.js";
import {
  LobbyFeedAccepted,
  LobbyFeedCreated,
  LobbyFeedDeleted,
  LobbyFeedParams,
  LobbyFeedPostBody,
  LobbySeen,
  LobbySettingsBody,
  LobbySettingsView,
  LobbyTemplateBody,
} from "./communityLobby.js";
import { LobbyView } from "./communityLobbyView.js";
import { route } from "./route.js";

/** The lobby's routes (community parity B, feature "community-lobby", docs/COMMUNITY_PARITY_API.md › Lobby). */

const tag = "community-lobby";

export const communityLobbyRoutes = [
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/lobby",
    tag,
    summary: "The community's lobby as the viewer sees it: header, settings, main channels, who runs it, live rooms, leaderboards and feed.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: LobbyView,
    errors: ["not_found", "feature_disabled"],
  }),
  route({
    method: "GET",
    url: "/v1/orgs/:orgId/lobby/settings",
    tag,
    summary: "The lobby's settings and revision (the feed URL's state for people who can edit the community).",
    auth: true,
    params: OrgParamsNonEmpty,
    response: LobbySettingsView,
    errors: ["not_found", "feature_disabled"],
  }),
  route({
    method: "PUT",
    url: "/v1/orgs/:orgId/lobby/settings",
    tag,
    summary: "Change the lobby (people who can edit the community); fields left out stay, a stale revision is refused.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: LobbySettingsBody,
    response: LobbySettingsView,
    errors: ["not_found", "forbidden", "lobby_stale", "lobby_channel_invalid", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/lobby/template",
    tag,
    summary: "Apply a template's look and sections; text, channels and buttons stay, starter questions fill an empty FAQ.",
    auth: true,
    params: OrgParamsNonEmpty,
    body: LobbyTemplateBody,
    response: LobbySettingsView,
    errors: ["not_found", "forbidden", "lobby_stale", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/lobby/seen",
    tag,
    summary: "The viewer has opened the lobby (apps open it first only before this); the first time is kept.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: LobbySeen,
    errors: ["not_found", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/orgs/:orgId/lobby/feed",
    tag,
    summary: "Create the lobby's feed URL, or replace it (the old one stops working); the token is shown only now.",
    auth: true,
    params: OrgParamsNonEmpty,
    response: LobbyFeedCreated,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "DELETE",
    url: "/v1/orgs/:orgId/lobby/feed",
    tag,
    summary: "Delete the lobby's feed URL (posts already in the lobby stay).",
    auth: true,
    params: OrgParamsNonEmpty,
    response: LobbyFeedDeleted,
    errors: ["not_found", "forbidden", "feature_disabled"],
  }),
  route({
    method: "POST",
    url: "/v1/lobby-feed/:token",
    tag,
    summary: "Post to a community's lobby feed through its secret URL: {title, text, url, image} or a Discord-style webhook body.",
    auth: false,
    params: LobbyFeedParams,
    body: LobbyFeedPostBody,
    response: LobbyFeedAccepted,
    errors: ["not_found", "lobby_feed_invalid", "feature_disabled"],
  }),
];

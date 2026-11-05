import { LiveKitService } from "../../src/modules/calls/livekit.js";

export class ControlPlaneSfu {
  publicUrl = "wss://media.example.test";
  identities = new Map<string, Set<string>>();
  updates: unknown[][] = [];
  failRemove = false;
  signer = new LiveKitService({
    apiUrl: "http://127.0.0.1:9",
    publicUrl: this.publicUrl,
    apiKey: "key",
    apiSecret: "test-secret-at-least-thirty-two-bytes",
  });
  async token() {
    return "test-human-media";
  }
  botToken(p: Parameters<LiveKitService["botToken"]>[0]) {
    return this.signer.botToken(p);
  }
  async roomNames() {
    return [...this.identities.keys()];
  }
  async participantIdentities(room: string) {
    return [...(this.identities.get(room) ?? [])];
  }
  async participantUsers(room: string) {
    return new Set(
      (await this.participantIdentities(room)).map((id) => id.split(".")[0]),
    );
  }
  async setCanPublish(
    room: string,
    identity: string,
    publish: boolean,
    data = true,
  ) {
    this.updates.push([identity, publish, data]);
    return this.identities.get(room)?.has(identity)
      ? ("updated" as const)
      : ("absent" as const);
  }
  async removeParticipant(room: string, identity: string) {
    if (this.failRemove) return "error" as const;
    return this.identities.get(room)?.delete(identity)
      ? ("removed" as const)
      : ("absent" as const);
  }
  async deleteRoom(room: string) {
    this.identities.delete(room);
  }
  async muteAudio() {
    return "muted" as const;
  }
  add(room: string, identity: string) {
    if (!this.identities.has(room)) this.identities.set(room, new Set());
    this.identities.get(room)!.add(identity);
  }
}

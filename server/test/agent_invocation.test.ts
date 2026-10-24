import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentCall, commandName, InvocationCases } from "../src/modules/workforce/invocation.js";
import { FIXTURES } from "./support/contracts.js";

/**
 * How a message calls an agent (src/modules/workforce/invocation.ts): the shared cases the web and Android composers
 * test against too, so a mention works the same wherever it's typed and whichever side reads it.
 */
const shared = InvocationCases.parse(JSON.parse(fs.readFileSync(path.join(FIXTURES, "rules/agent-invocation.json"), "utf8")));

describe("calling an agent from a message", () => {
  it.each(shared.cases.map((c) => [c.why, c] as const))("%s", (_why, c) => {
    expect(agentCall(c.text, shared.agents)).toEqual(c.expect);
  });

  it("names commands as the apps do", () => {
    expect(commandName("Data Désk!")).toBe("data-desk");
    expect(commandName("Agent Manager")).toBe("agent-manager");
  });
});

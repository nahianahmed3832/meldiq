import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_DOCS, fixtureName, renderContracts } from "../scripts/contracts.js";
import { ErrorEnvelope, ROUTE_CONTRACTS } from "../src/shared/contracts/http/index.js";
import { ServerEvent } from "../src/shared/contracts/realtime.js";
import { FIXTURES } from "./support/contracts.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * The published contract (docs/architecture/ARCHITECTURE_1_0_PLAN.md §4.2): docs/api matches the schemas, every
 * documented route exists, and every golden fixture in shared/contracts/fixtures still satisfies its schema (the
 * Android and web suites decode the same files). Every other suite checks the live answers (test/support/contracts.ts).
 */

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];

describe("contracts", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer();
  });
  afterAll(async () => h.close());

  it("docs/api is what the schemas generate (run npm run contracts after changing them)", () => {
    for (const [name, text] of Object.entries(renderContracts())) {
      expect(fs.readFileSync(path.join(API_DOCS, name), "utf8"), name).toBe(text);
    }
  });

  it("documents only routes the server has", () => {
    // Routes of an optional feature (`requires`, e.g. federation) aren't registered by the default test server.
    const missing = ROUTE_CONTRACTS.filter((c) => !c.requires)
      .map((c) => `${c.method} ${c.url}`)
      .filter((r) => !h.contracts.routes.has(r));
    expect(missing).toEqual([]);
  });

  it("documents at least the client-critical areas (the count only goes up)", () => {
    const total = [...h.contracts.routes].filter((r) => !r.startsWith("HEAD ") && !/^\w+ \/(fed|core)\//.test(r)).length;
    expect(ROUTE_CONTRACTS.length).toBeGreaterThanOrEqual(30);
    expect(ROUTE_CONTRACTS.length).toBeLessThanOrEqual(total);
  });

  it("keeps every golden fixture valid against its schema", () => {
    const byFile = new Map(ROUTE_CONTRACTS.map((c) => [fixtureName(c.method, c.url), c]));
    const files = walk(FIXTURES).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const file of files) {
      const rel = path.relative(FIXTURES, file).split(path.sep).join("/");
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const schema = rel.startsWith("realtime/")
        ? ServerEvent
        : rel.startsWith("http/errors/")
          ? ErrorEnvelope
          : byFile.get(path.basename(rel, ".json"))?.response;
      if (!schema) bad.push(`${rel}: no schema (a route contract was renamed or removed)`);
      else if (!schema.safeParse(json).success) bad.push(`${rel}: doesn't match its schema`);
    }
    expect(bad).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  safeSvg,
  lottieWebp,
} from "../src/modules/accounts/collectibles/vectors.js";
describe("safe vector processing", () => {
  it("rasterizes a self-contained SVG and rejects active/external XML", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="20" fill="#22d3ee"/></svg>',
    );
    expect(
      (await sharp(safeSvg(svg)).png().toBuffer({ resolveWithObject: true }))
        .info.width,
    ).toBe(64);
    for (const s of [
      "<svg><script>alert(1)</script></svg>",
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      '<svg><image href="https://evil.example/x"/></svg>',
      '<svg onload="x()"/>',
      '<svg><rect style="fill:url(https://evil.example)"/></svg>',
    ])
      expect(() => safeSvg(Buffer.from(s))).toThrow();
  });
  it("produces animated WebP and a static first-frame fallback from shape Lottie", async () => {
    const doc = {
      v: "5.7.0",
      w: 64,
      h: 64,
      fr: 10,
      ip: 0,
      op: 10,
      assets: [],
      layers: [
        {
          ty: 4,
          ks: {
            p: {
              a: 1,
              k: [
                {
                  t: 0,
                  s: [0, 0],
                  e: [10, 0],
                  o: { x: [0.1, 0.1], y: [0.9, 0.9] },
                  i: { x: [0.1, 0.1], y: [1, 1] },
                },
                { t: 10, s: [10, 0] },
              ],
            },
          },
          shapes: [
            { ty: "el", p: { a: 0, k: [20, 32] }, s: { a: 0, k: [20, 20] } },
            { ty: "fl", c: { a: 0, k: [0, 1, 1, 1] }, o: { a: 0, k: 100 } },
          ],
        },
      ],
    };
    const image = await lottieWebp(Buffer.from(JSON.stringify(doc)));
    expect((await sharp(image, { animated: true }).metadata()).pages).toBe(10);
    expect(
      (
        await sharp(image, { page: 0, pages: 1 })
          .webp()
          .toBuffer({ resolveWithObject: true })
      ).info.height,
    ).toBe(64);
    const middle = await sharp(image, { page: 5, pages: 1 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    let mass = 0,
      weightedX = 0;
    for (let pixel = 0; pixel < 64 * 64; pixel++) {
      const alpha = middle[pixel * 4 + 3];
      mass += alpha;
      weightedX += (pixel % 64) * alpha;
    }
    expect(weightedX / mass).toBeGreaterThan(27);
    for (const extra of [
      { assets: [{ p: "https://evil.example" }] },
      { layers: [{ ty: 4, ks: { p: { x: "eval(x)" } }, shapes: [] }] },
      { layers: [{ ty: 2, refId: "image" }] },
      { op: 1000000 },
    ])
      await expect(
        lottieWebp(Buffer.from(JSON.stringify({ ...doc, ...extra }))),
      ).rejects.toThrow();
  });
});

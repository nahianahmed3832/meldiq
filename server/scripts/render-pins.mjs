#!/usr/bin/env node
/**
 * Draws Meldiq's own profile pins (API 0.64.0, docs/PROFILE_PINS.md) into assets/pins/<id>.webp: 128 × 128 badges, a
 * rounded hexagon in two colours with a white glyph. The ids must match MELDIQ_PINS in
 * src/modules/accounts/pins/builtins.ts. Needs the `sharp` dev dependency.
 *
 *   node scripts/render-pins.mjs            write every pin
 *   node scripts/render-pins.mjs --sheet x.png   also draw them side by side, to look at
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { GLYPHS } from "./pins/glyphs.mjs";

const SIZE = 128;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets", "pins");

/** id: the glyph and the badge's two colours (top-left to bottom-right). */
export const PIN_ART = {
  "early-member": { glyph: "sprout", from: "#4ade80", to: "#0f766e" },
  "one-year": { glyph: "cake", from: "#f9a8d4", to: "#be185d" },
  explorer: { glyph: "compass", from: "#7dd3fc", to: "#4338ca" },
  founder: { glyph: "flag", from: "#fcd34d", to: "#c2410c" },
  "spark-giver": { glyph: "gem", from: "#c4b5fd", to: "#6d28d9" },
  artist: { glyph: "paintbrush", from: "#f0abfc", to: "#a21caf" },
  "bug-hunter": { glyph: "bug", from: "#fca5a5", to: "#b91c1c" },
};

/** A hexagon with its points rounded, centred in the canvas. */
function hexagon(r, cx = SIZE / 2, cy = SIZE / 2) {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  return `M${pts.map((p) => p.map((n) => n.toFixed(2)).join(" ")).join(" L")} Z`;
}

const attrs = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${v}"`)
    .join(" ");

function svg({ glyph, from, to }) {
  const shapes = GLYPHS[glyph].map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join("");
  // The glyph is 24 units wide; 56 px of it sits in the middle.
  const scale = 56 / 24;
  const offset = (SIZE - 56) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <path d="${hexagon(58)}" fill="${to}" stroke="${to}" stroke-width="10" stroke-linejoin="round"/>
  <path d="${hexagon(56)}" fill="url(#g)" stroke="url(#g)" stroke-width="8" stroke-linejoin="round"/>
  <path d="${hexagon(46)}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="3" stroke-linejoin="round"/>
  <path d="${hexagon(56)}" fill="url(#shine)" stroke-linejoin="round"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${shapes}</g>
</svg>`;
}

async function main() {
  const args = process.argv.slice(2);
  const sheetAt = args.indexOf("--sheet");
  fs.mkdirSync(outDir, { recursive: true });
  const rendered = [];
  for (const [id, art] of Object.entries(PIN_ART)) {
    const buf = await sharp(Buffer.from(svg(art))).webp({ lossless: true }).toBuffer();
    fs.writeFileSync(path.join(outDir, `${id}.webp`), buf);
    rendered.push({ id, buf });
    console.log(`${id}.webp ${buf.length} bytes`);
  }
  if (sheetAt >= 0) {
    const gap = 16;
    const width = rendered.length * (SIZE + gap) + gap;
    const sheet = sharp({ create: { width, height: SIZE + 2 * gap, channels: 4, background: "#1e1f22" } }).composite(rendered.map((r, i) => ({ input: r.buf, left: gap + i * (SIZE + gap), top: gap })));
    await sheet.png().toFile(args[sheetAt + 1]);
  }
}

await main();

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ACHIEVEMENTS } from "../../src/modules/points/achievements.js";
const glyphs: Record<string, string> = {
  flame:
    '<path d="M33 5c1 15 18 19 18 36 0 13-8 21-20 21S11 54 11 42c0-9 5-16 10-22-1 10 2 14 6 17C22 22 29 15 33 5Z" fill="currentColor" stroke="none"/><path d="m31 35 8 11-8 10-8-10 8-11Z" fill="#fff2bf" stroke="none"/>',
  calendar:
    '<rect x="10" y="15" width="44" height="40" rx="8"/><path d="M21 9v12m22-12v12M10 29h44m-29 11 6 6 11-12"/>',
  gem: '<path d="m7 23 10-13h30l10 13-25 33L7 23Zm0 0h50M17 10l15 46 15-46M24 10l-7 13m23-13 7 13"/>',
  star: '<path d="m32 7 8 16 18 3-13 13 3 18-16-9-16 9 3-18L6 26l18-3 8-16Z"/>',
  crown:
    '<path d="m9 20 12 11L32 12l11 19 12-11-6 32H15L9 20Zm6 32h34M22 43h20"/><circle cx="9" cy="17" r="3"/><circle cx="32" cy="9" r="3"/><circle cx="55" cy="17" r="3"/>',
  compass:
    '<circle cx="32" cy="32" r="24"/><path d="m43 20-7 17-16 7 7-17 16-7Z"/><circle cx="32" cy="32" r="2"/>',
  trophy:
    '<path d="M19 9h26v20c0 18-26 18-26 0V9Zm0 7H9v9c0 9 8 12 14 11m22-20h10v9c0 9-8 12-14 11M32 44v12m-11 0h22"/>',
  heart: '<path d="M32 55 12 36C-3 20 19 1 32 19 45 1 67 20 52 36L32 55Z"/>',
  tent: '<path d="M32 8 6 56h52L32 8Zm0 24L19 56h26L32 32Zm-9-20 8 13m10-13-8 13"/>',
  globe:
    '<circle cx="32" cy="32" r="24"/><ellipse cx="32" cy="32" rx="11" ry="24"/><path d="M8 32h48M13 18h38M13 46h38"/>',
  message:
    '<path d="M11 10h42a5 5 0 0 1 5 5v29a5 5 0 0 1-5 5H28L12 60V49h-1a5 5 0 0 1-5-5V15a5 5 0 0 1 5-5Z"/><path d="M19 24h26M19 35h18"/>',
};
const colors = {
  bronze: ["#a46947", "#f1bb8e"],
  silver: ["#526f98", "#d0ecff"],
  gold: ["#b88224", "#ffe9a0"],
  mythic: ["#6851b8", "#e4c2ff"],
};
const folder = path.resolve("assets/pins");
await fs.mkdir(folder, { recursive: true });
for (const a of ACHIEVEMENTS) {
  const [dark, light] = colors[a.tier];
  const shape =
    a.tier === "mythic"
      ? '<path d="M64 7 112 26v40c0 27-29 47-48 55C45 113 16 93 16 66V26L64 7Z"/>'
      : a.tier === "gold"
        ? '<path d="m64 6 16 13 21 1 4 21 17 16-13 19-2 22-23 5-20 17-20-17-23-5-2-22L6 57l17-16 4-21 21-1L64 6Z"/>'
        : a.tier === "silver"
          ? '<path d="m64 7 45 26v53l-45 27-45-27V33L64 7Z"/>'
          : '<circle cx="64" cy="64" r="54"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="b" x2="0" y2="1"><stop stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs><g fill="#18191e" stroke="url(#b)" stroke-width="4">${shape}</g><circle cx="64" cy="64" r="42" fill="${dark}" fill-opacity=".18" stroke="${light}" stroke-opacity=".22"/><g transform="translate(32 30)" color="${light}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${glyphs[a.icon] ?? glyphs.flame}</g></svg>`;
  await sharp(Buffer.from(svg))
    .webp({ quality: 95 })
    .toFile(path.join(folder, a.id + ".webp"));
}
console.log(`Rendered ${ACHIEVEMENTS.length} original achievement emblems.`);

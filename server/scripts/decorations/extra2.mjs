import { ANIM } from "./classic.mjs";
import { pair, pumpkin } from "./extra.mjs";
import { at, f, g, leaf, place, R, rad, radial, radiusPath, ring, sparkle, svg, wave } from "./shapes.mjs";

/**
 * Meldiq's own decorations, part four: a second batch of community favourites (a retro TV, chrome, flower wreaths,
 * a chess ring, blinking eyes, a lamb hood and word stickers), each drawn here from scratch.
 */

const pathOf = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join("");
const frameOf = (t) => Math.round(t * ANIM) % ANIM;

/** The piece of the ring between radii [r0] and [r1] from [a0] to [a1] degrees. */
function sector(r0, r1, a0, a1) {
  const [p0, p1, p2, p3] = [at(a0, r1), at(a1, r1), at(a1, r0), at(a0, r0)];
  return `M${f(p0[0])} ${f(p0[1])} A${r1} ${r1} 0 0 1 ${f(p1[0])} ${f(p1[1])} L${f(p2[0])} ${f(p2[1])} A${r0} ${r0} 0 0 0 ${f(p3[0])} ${f(p3[1])}Z`;
}

/** [n] petals of [petal] round the origin, then a centre of radius [core]. */
const flower = (n, petal, core, coreFill, coreEdge) => {
  let out = "";
  for (let i = 0; i < n; i++) out += g(`rotate(${f((i * 360) / n)})`, petal);
  return out + `<circle r="${f(core)}" fill="${coreFill}" stroke="${coreEdge}" stroke-width="1.5"/>`;
};
const daisy = (s) => flower(12, `<ellipse cy="${f(-s * 0.55)}" rx="${f(s * 0.17)}" ry="${f(s * 0.42)}" fill="#ffffff" stroke="#d3d8e3" stroke-width="1.2"/>`, s * 0.26, "#ffcf3a", "#d99a12");
const blossomFlower = (s, fill, edge) =>
  flower(5, `<path d="M0 0 C${f(-s * 0.42)} ${f(-s * 0.3)} ${f(-s * 0.36)} ${f(-s * 0.9)} 0 ${f(-s * 0.78)} C${f(s * 0.36)} ${f(-s * 0.9)} ${f(s * 0.42)} ${f(-s * 0.3)} 0 0Z" fill="${fill}" stroke="${edge}" stroke-width="1.5"/>`, s * 0.16, "#ffe27a", "#e08aa8");
const roundFlower = (s, fill, edge) => flower(5, `<circle cy="${f(-s * 0.42)}" r="${f(s * 0.3)}" fill="${fill}" stroke="${edge}" stroke-width="1.5"/>`, s * 0.2, "#ffd84a", "#c98a12");

const bowTie = {
  id: "bow-tie",
  name: "Bow tie",
  frames: 1,
  draw: () => {
    const half = `<path d="M-5 -6 L-34 -19 Q-42 0 -34 19 L-5 6Z" fill="#d6293a" stroke="#7d0a16" stroke-width="3" stroke-linejoin="round"/><path d="M-12 -4 L-28 -10 M-12 4 L-28 10" stroke="#9b1020" stroke-width="2.5" stroke-linecap="round"/>`;
    const tie = half + g("scale(-1 1)", half) + `<rect x="-8" y="-10" width="16" height="20" rx="5" fill="#e8394a" stroke="#7d0a16" stroke-width="3"/>`;
    return svg("", g(place(...at(90, R - 26), 0, 1.35), tie));
  },
};

const retroTv = {
  id: "retro-tv",
  name: "Retro TV",
  frames: 1,
  draw: () => {
    const hole = R + 6;
    const body = `M70 8 H442 Q504 8 504 70 V438 Q504 500 442 500 H70 Q8 500 8 438 V70 Q8 8 70 8Z M${256 - hole} 256 A${hole} ${hole} 0 1 0 ${256 + hole} 256 A${hole} ${hole} 0 1 0 ${256 - hole} 256Z`;
    const grille = [0, 1, 2, 3].map((i) => `<path d="M30 ${44 + i * 12} H${74 - i * 10}" stroke="#6e5a3a" stroke-width="5" stroke-linecap="round"/>`).join("");
    const knob = (y, r) => `<circle cx="466" cy="${y}" r="${r}" fill="#8a7a5a" stroke="#4d3f26" stroke-width="3"/><path d="M466 ${y - r + 4} V${y}" stroke="#f0e4c8" stroke-width="3" stroke-linecap="round"/>`;
    return svg(
      `<linearGradient id="tv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eadbb9"/><stop offset="1" stop-color="#c4ad80"/></linearGradient>`,
      `<path d="${body}" fill="url(#tv)" fill-rule="evenodd" stroke="#6e5a3a" stroke-width="5" stroke-linejoin="round"/>` +
        ring(R + 11, 14, "#24242b") + ring(R + 3, 3, "#4a4a55") +
        `<path d="M${f(at(-158, R + 11)[0])} ${f(at(-158, R + 11)[1])} A${R + 11} ${R + 11} 0 0 1 ${f(at(-112, R + 11)[0])} ${f(at(-112, R + 11)[1])}" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.35"/>` +
        grille + knob(66, 15) + knob(114, 11) + `<circle cx="466" cy="156" r="5" fill="#ff4a3d"/>`,
    );
  },
};

const chromeFrame = {
  id: "chrome-frame",
  name: "Chrome frame",
  frames: ANIM,
  draw: (t) => {
    const stops = [[0, "#ffffff"], [0.16, "#9aa3b5"], [0.3, "#f5f7fb"], [0.42, "#dff3ff"], [0.52, "#5d6577"], [0.64, "#eef1f6"], [0.76, "#ffd9f2"], [0.88, "#8890a2"], [1, "#ffffff"]];
    const grad = `<linearGradient id="ch" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${f(t * 360)} 0.5 0.5)">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
    const blob = (d) => radiusPath((a) => R + 15 + d + 7 * Math.sin(rad(a * 5)) + 3 * Math.sin(rad(a * 11 + 40)), 2);
    const star = (s) => `<path d="M0 ${-s} Q${f(s * 0.16)} ${f(-s * 0.16)} ${s} 0 Q${f(s * 0.16)} ${f(s * 0.16)} 0 ${s} Q${f(-s * 0.16)} ${f(s * 0.16)} ${-s} 0 Q${f(-s * 0.16)} ${f(-s * 0.16)} 0 ${-s}Z" fill="url(#ch)" stroke="#3d4250" stroke-width="2.5"/>`;
    const stars = [[-48, 40, 30, 0], [-140, 40, 24, 0.4], [150, 30, 18, 0.7]].map(([deg, d, s, ph]) => g(place(...at(deg, R + d), 0, 0.8 + 0.25 * Math.abs(wave(t, ph))), star(s))).join("");
    return svg(
      grad,
      `<path d="${blob(0)}" fill="none" stroke="#3d4250" stroke-width="27" stroke-linejoin="round"/><path d="${blob(0)}" fill="none" stroke="url(#ch)" stroke-width="21" stroke-linejoin="round"/><path d="${blob(-5)}" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.75"/>` + stars,
    );
  },
};

const shinyApple = {
  id: "shiny-apple",
  name: "Shiny apple",
  frames: 1,
  draw: () => {
    const apple =
      `<path d="M2 -34 Q4 -48 14 -56" stroke="#5a3a1c" stroke-width="6" fill="none" stroke-linecap="round"/>` + g("translate(8 -46) rotate(-28)", leaf(36, 13, "#3fae4f") + `<path d="M3 0 H30" stroke="#2a7a36" stroke-width="2"/>`) +
      `<path d="M0 -30 C-14 -44 -50 -40 -50 -6 C-50 28 -26 48 -11 46 C-5 45 5 45 11 46 C26 48 50 28 50 -6 C50 -40 14 -44 0 -30Z" fill="url(#ap)" stroke="#7d0a16" stroke-width="3.5" stroke-linejoin="round"/>` +
      `<ellipse cx="-22" cy="-14" rx="9" ry="15" fill="#ffffff" opacity="0.5" transform="rotate(20 -22 -14)"/><circle cx="-16" cy="12" r="3.5" fill="#ffffff" opacity="0.4"/>`;
    return svg(radial("ap", [[0, "#ff7a7f"], [0.6, "#d81f2c"], [1, "#8f0d18"]], 0.75), g(place(...at(-136, R + 32), -8, 1.2), apple));
  },
};

const littlePumpkin = {
  id: "little-pumpkin",
  name: "Little pumpkin",
  frames: 1,
  draw: () => {
    const curl = `<path d="M12 -44 C30 -60 52 -50 46 -36 C42 -26 30 -32 36 -40" stroke="#4f6b22" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
    const leafy = g("translate(4 -42) rotate(-150)", leaf(34, 14, "#5c8f2a") + `<path d="M3 0 H28" stroke="#3d6318" stroke-width="2"/>`);
    return svg("", g(place(...at(-42, R + 30), 6, 1.3), curl + leafy + pumpkin(42, false) + `<ellipse cx="-20" cy="-14" rx="6" ry="14" fill="#ffffff" opacity="0.3" transform="rotate(14 -20 -14)"/>`));
  },
};

const flowerVine = {
  id: "flower-vine",
  name: "Flower vine",
  frames: 1,
  draw: () => {
    const radius = (a) => R + 14 + 6 * Math.sin(rad(a * 6));
    const pts = [];
    for (let a = 140; a <= 292; a += 3) pts.push(at(a, radius(a)));
    let leaves = "";
    for (let i = 0, a = 146; a < 288; a += 13, i++) leaves += g(place(...at(a, radius(a)), a + (i % 2 ? 60 : -60)), leaf(34, 13, i % 3 ? "#3fae4f" : "#5cc96b") + `<path d="M3 0 H26" stroke="#22702d" stroke-width="1.5"/>`);
    const curlAt = (deg, dist, rot, k) => g(place(...at(deg, dist), rot, k), `<path d="M0 0 C12 -4 18 -16 10 -22 C4 -26 -2 -20 3 -15" stroke="#2c7d38" stroke-width="3" fill="none" stroke-linecap="round"/>`);
    const blooms = [[156, 40, "#ffb6cf", "#e2759e"], [194, 34, "#d9c2ff", "#9b7ad6"], [228, 42, "#ffffff", "#c9ccd6"], [258, 32, "#ffb6cf", "#e2759e"], [284, 40, "#d9c2ff", "#9b7ad6"]];
    return svg(
      "",
      `<path d="${pathOf(pts)}" stroke="#2c7d38" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` + leaves +
        curlAt(292, radius(292), -40, 1.6) + curlAt(172, R + 16, 200, 1.1) + curlAt(244, R + 34, 60, 1.1) +
        blooms.map(([a, s, c, e]) => g(place(...at(a, radius(a)), a * 2), roundFlower(s, c, e))).join(""),
    );
  },
};

const whiteFlowers = {
  id: "white-flowers",
  name: "White flowers",
  frames: 1,
  draw: () => {
    let out = "";
    for (let i = 0; i < 18; i++) {
      const deg = i * 20 - 90;
      const s = 29 - 12 * Math.max(0, Math.sin(rad(deg))) + (i % 2 ? -4 : 3);
      out += g(place(...at(deg + 10, R + 12), deg * 3 + 10), leaf(22, 9, "#4f9a4a")) + g(place(...at(deg, R + 9), deg * 3), daisy(s));
    }
    return svg("", ring(R + 12, 4, "#4f9a4a") + out);
  },
};

const pinkWreath = {
  id: "pink-wreath",
  name: "Pink blossom wreath",
  frames: 1,
  draw: () => {
    const colours = [["#ffb6cf", "#e2759e"], ["#ff8fb8", "#d0577f"], ["#ffd1e0", "#e898b4"]];
    let leaves = "";
    let blooms = "";
    for (let i = 0; i < 32; i++) {
      const deg = i * 11.25;
      leaves += g(place(...at(deg, R + 12), deg + (i % 2 ? 58 : -58)), leaf(30, 12, i % 3 ? "#3f9a4c" : "#5cbf68"));
    }
    for (let i = 0; i < 20; i++) {
      const deg = i * 18 + 4;
      const bottom = Math.max(0, Math.sin(rad(deg)));
      const s = (bottom > 0.85 ? 18 : 32 + (i % 3) * 4) * (1 - 0.25 * bottom);
      const [c, e] = colours[i % 3];
      blooms += g(place(...at(deg, R + 10 + (i % 2) * 5), deg * 2 + i * 17), blossomFlower(s, c, e));
    }
    return svg("", ring(R + 12, 6, "#2f7a3a") + leaves + blooms);
  },
};

const chessRing = {
  id: "chess-ring",
  name: "Chess ring",
  frames: 1,
  draw: () => {
    let cells = "";
    for (let col = 0; col < 40; col++) for (let row = 0; row < 2; row++) cells += `<path d="${sector(R + 4 + row * 15, R + 19 + row * 15, col * 9, col * 9 + 9)}" fill="${(col + row) % 2 ? "#1d1d22" : "#f2efe6"}"/>`;
    const pawn = `<path d="M-22 0 H22 L18 -9 H-18Z M-14 -9 C-10 -22 -8 -30 -6 -36 H6 C8 -30 10 -22 14 -9Z"/><rect x="-12" y="-41" width="24" height="6" rx="2"/><circle cy="-52" r="12"/>`;
    const rook = `<path d="M-22 0 H22 L19 -9 H-19Z M-15 -9 L-12 -40 H12 L15 -9Z M-17 -40 V-58 H-10 V-51 H-4 V-58 H4 V-51 H10 V-58 H17 V-40Z"/>`;
    return svg(
      "",
      cells + ring(R + 4, 2.5, "#55555f") + ring(R + 34, 2.5, "#55555f") +
        g(place(...at(-46, R + 20), 0, 1.3), pawn, `fill="#f7f4ec" stroke="#2a2a30" stroke-width="3" stroke-linejoin="round"`) +
        g(place(...at(-134, R + 22), 0, 1.3), rook, `fill="#24242c" stroke="#e6e1d4" stroke-width="3" stroke-linejoin="round"`),
    );
  },
};

const blinkingEyes = {
  id: "blinking-eyes",
  name: "Blinking eyes",
  frames: ANIM,
  draw: (t) => {
    const irises = ["#8a4dff", "#2dbb6b", "#e5312b", "#2f7bf0"];
    const look = 3.5 * wave(t);
    let out = "";
    for (let i = 0, deg = -200; deg <= 20; deg += 20, i++) {
      const phase = (frameOf(t) + i * 5) % ANIM;
      const open = phase === 0 ? 0.08 : phase === 1 ? 0.5 : 1;
      const h = 14 * open;
      const eye =
        `<path d="M-19 0 Q0 ${f(-h * 1.15)} 19 0 Q0 ${f(h * 1.15)} -19 0Z" fill="#fbfbfd" stroke="#1b1b22" stroke-width="3" stroke-linejoin="round"/>` +
        (open > 0.3 ? `<ellipse cx="${f(look)}" rx="8" ry="${f(8 * open)}" fill="${irises[i % 4]}"/><ellipse cx="${f(look)}" rx="3.6" ry="${f(3.6 * open)}" fill="#111114"/><circle cx="${f(look + 2.5)}" cy="${f(-2.5 * open)}" r="1.8" fill="#ffffff"/>` : "") +
        `<path d="M-12 ${f(-h * 0.8)} L-15 ${f(-h * 0.8 - 6)} M0 ${f(-h * 1.05)} V${f(-h * 1.05 - 7)} M12 ${f(-h * 0.8)} L15 ${f(-h * 0.8 - 6)}" stroke="#1b1b22" stroke-width="2.5" stroke-linecap="round"/>`;
      out += g(place(...at(deg, R + 12), deg + 90, i % 2 ? 1.1 : 1.24), eye);
    }
    return svg("", out);
  },
};

const blackOutline = {
  id: "black-outline",
  name: "Black outline",
  frames: 1,
  draw: () => svg("", ring(R + 7, 13, "#0b0b0e")),
};

const lambHood = {
  id: "lamb-hood",
  name: "Lamb hood",
  frames: 1,
  draw: () => {
    const puff = (deg, dist, r) => {
      const [x, y] = at(deg, dist);
      return `<circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="#fbf7ee" stroke="#c9bda4" stroke-width="2.5"/><path d="M${f(x - r * 0.35)} ${f(y + 1)} C${f(x - r * 0.35)} ${f(y - r * 0.4)} ${f(x + r * 0.35)} ${f(y - r * 0.4)} ${f(x + r * 0.3)} ${f(y + 1)}" stroke="#d9cfba" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    };
    let wool = "";
    for (let i = 0, deg = 140; deg <= 400; deg += 10, i++) wool += puff(deg, R + 21, 15 + (i % 2) * 2);
    for (let i = 0, deg = 145; deg <= 395; deg += 9, i++) wool += puff(deg, R + 6, 16 + (i % 3) * 2);
    const ear = `<path d="M0 0 C16 -16 46 -16 58 2 C46 18 16 16 0 0Z" fill="#fbf7ee" stroke="#c9bea8" stroke-width="3"/><path d="M8 0 C18 -8 38 -8 48 2 C38 9 18 8 8 0Z" fill="#ffc2d4"/>`;
    return svg("", wool + pair(-38, R + 14, 15, 1.2, ear));
  },
};

/** A tilted word sticker with a white edge, centred at [deg] on the avatar's rim. */
const sticker = (id, name, lines, bg, fg, deg, rot, size = 30, extra = "") => ({
  id,
  name,
  frames: 1,
  draw: () => {
    const width = (l) => [...l].reduce((s, ch) => s + (ch === " " ? 0.3 : ch === ch.toUpperCase() && /[A-Z]/.test(ch) ? 0.74 : 0.58), 0) * size;
    const w = Math.max(...lines.map(width)) + 34;
    const h = lines.length * size * 1.08 + 22;
    const text = lines.map((l, i) => `<text x="0" y="${f((i - (lines.length - 1) / 2) * size * 1.08 + size * 0.36)}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${size}" fill="${fg}">${l}</text>`).join("");
    const body = `<rect x="${f(-w / 2 + 5)}" y="${f(-h / 2 + 6)}" width="${f(w)}" height="${f(h)}" rx="14" fill="#000000" opacity="0.3"/><rect x="${f(-w / 2)}" y="${f(-h / 2)}" width="${f(w)}" height="${f(h)}" rx="14" fill="${bg}" stroke="#ffffff" stroke-width="7"/>`;
    return svg("", g(place(...at(deg, R - 18), rot), body + text + extra));
  },
});

export const EXTRA2 = [
  bowTie,
  retroTv,
  chromeFrame,
  shinyApple,
  littlePumpkin,
  flowerVine,
  whiteFlowers,
  pinkWreath,
  chessRing,
  blinkingEyes,
  blackOutline,
  lambHood,
  sticker("the-goat", "The GOAT", ["THE GOAT"], "#ffc82e", "#3b2a00", -84, 7, 42, g("translate(-118 -30)", sparkle(16, "#ffffff"))),
  sticker("dont-touch", "Don't touch", ["Don’t touch"], "#e5312b", "#ffffff", -96, -7, 38),
  sticker("gg-wp", "GG WP", ["GG WP"], "#7b4dff", "#ffffff", -78, -8, 48),
  sticker("afk", "AFK", ["AFK"], "#2b2d36", "#7cff6a", -64, 12, 54),
  sticker("main-character", "Main character", ["Main", "character"], "#ff5fa8", "#ffffff", -62, 10, 36, g("translate(86 -42)", sparkle(16, "#fff6c2"))),
];

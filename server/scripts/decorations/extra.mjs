import { ANIM, falling, twinkles, wingsDeco } from "./classic.mjs";
import { arc, at, blur, C, f, flame, g, leaf, linear, outside, place, R, rad, radial, radiusPath, ring, rng, S, snowflake, sparkle, star5, svg, wave } from "./shapes.mjs";

/**
 * Meldiq's own decorations, part three: more themes people ask for in community-made decorations (HUDs, neon, pride
 * bands, Halloween, ears and tails, weather, a katana, a crate…), each drawn here from scratch.
 */

const val = (v, p) => (typeof v === "function" ? v(p) : v);
const pathOf = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join("");
const frameOf = (t) => Math.round(t * ANIM) % ANIM;

/** Overlapping circles along the circle of radius [dist] from [a0] to [a1] degrees, sized [size(p)]: tails and bodies. */
function tube(a0, a1, dist, size, fill, n = 48) {
  let out = "";
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    const [x, y] = at(a0 + (a1 - a0) * p, val(dist, p));
    out += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(val(size, p))}" fill="${val(fill, p)}"/>`;
  }
  return out;
}

/** A pair of shapes drawn for the right side, mirrored onto the left about the centre line. */
const pair = (deg, dist, rot, k, shape) => g(place(...at(deg, dist), rot, k), shape) + g(`translate(${S} 0) scale(-1 1)`, g(place(...at(deg, dist), rot, k), shape));

const pumpkin = (s, face) =>
  `<path d="M0 ${f(-s * 0.7)} Q${f(s * 0.05)} ${f(-s * 1.05)} ${f(s * 0.32)} ${f(-s * 1.12)}" stroke="#4f6b22" stroke-width="${f(s * 0.22)}" stroke-linecap="round" fill="none"/>` +
  [-1, 1].map((d) => `<ellipse cx="${f(d * s * 0.42)}" rx="${f(s * 0.6)}" ry="${f(s * 0.76)}" fill="#e8721c" stroke="#9a420a" stroke-width="${f(s * 0.07)}"/>`).join("") +
  `<ellipse rx="${f(s * 0.46)}" ry="${f(s * 0.82)}" fill="#f78f2a" stroke="#9a420a" stroke-width="${f(s * 0.07)}"/>` +
  (face
    ? `<path d="M${f(-s * 0.5)} ${f(-s * 0.1)} L${f(-s * 0.3)} ${f(-s * 0.4)} L${f(-s * 0.12)} ${f(-s * 0.1)}Z M${f(s * 0.5)} ${f(-s * 0.1)} L${f(s * 0.3)} ${f(-s * 0.4)} L${f(s * 0.12)} ${f(-s * 0.1)}Z M${f(-s * 0.55)} ${f(s * 0.18)} Q0 ${f(s * 0.75)} ${f(s * 0.55)} ${f(s * 0.18)} L${f(s * 0.25)} ${f(s * 0.32)} L0 ${f(s * 0.2)} L${f(-s * 0.25)} ${f(s * 0.32)}Z" fill="#3a1a06"/>`
    : "");

function ghost(s) {
  let bottom = "";
  for (let i = 0; i < 4; i++) bottom += ` Q${f(s - s * 0.5 * i - s * 0.25)} ${f(i % 2 ? s * 0.62 : s * 1.2)} ${f(s - s * 0.5 * (i + 1))} ${f(s * 0.9)}`;
  return (
    `<path d="M${f(-s)} ${f(s * 0.9)} V${f(-s * 0.1)} A${f(s)} ${f(s)} 0 0 1 ${f(s)} ${f(-s * 0.1)} V${f(s * 0.9)}${bottom}Z" fill="#f7f8ff" stroke="#b9c0dc" stroke-width="${f(s * 0.08)}" stroke-linejoin="round"/>` +
    [-1, 1].map((d) => `<ellipse cx="${f(d * s * 0.34)}" cy="${f(-s * 0.05)}" rx="${f(s * 0.13)}" ry="${f(s * 0.2)}" fill="#25252f"/>`).join("") +
    `<ellipse cy="${f(s * 0.4)}" rx="${f(s * 0.12)}" ry="${f(s * 0.16)}" fill="#25252f"/>`
  );
}

/** A small bat [s] wide, wings at [flap] (-1 up to 1 down). */
function bat(s, flap, fill = "#16121c") {
  const y = -10 * flap;
  const d = `M0 -6 C-8 -10 -14 ${f(y - 4)} -40 ${f(y - 6)} C-34 ${f(y + 2)} -32 4 -26 10 C-20 4 -12 6 -6 12 L0 8 L6 12 C12 6 20 4 26 10 C32 4 34 ${f(y + 2)} 40 ${f(y - 6)} C14 ${f(y - 4)} 8 -10 0 -6Z M-5 -5 L-4 -13 L0 -8 L4 -13 L5 -5Z`;
  return g(`scale(${f(s / 80)})`, `<path d="${d}" fill="${fill}"/>`);
}

const neon = (id, name, colour, light) => ({
  id,
  name,
  frames: ANIM,
  draw: (t) => {
    const glow = frameOf(t) === 11 ? 0.25 : 0.6 + 0.3 * wave(t);
    return svg(
      blur("b", 12) + blur("s", 4),
      ring(R + 12, 30, colour, `filter="url(#b)" opacity="${f(glow)}"`) +
        ring(R + 12, 10, colour, `filter="url(#s)"`) +
        ring(R + 12, 7, colour) +
        ring(R + 12, 2.5, light) +
        ring(R + 1, 3, colour, `opacity="${f(0.4 + 0.3 * glow)}"`),
    );
  },
});

const hud = (id, name, colour, light) => ({
  id,
  name,
  frames: ANIM,
  draw: (t) => {
    let ticks = "";
    for (let i = 0; i < 72; i++) {
      if (i % 18 > 14) continue;
      ticks += `<path d="${pathOf([at(i * 5, R + 5), at(i * 5, R + (i % 6 ? 12 : 20))])}"/>`;
    }
    const spin = t * 90;
    const arcs = [0, 90, 180, 270].map((a) => `<path d="${arc(R + 30, a + spin + 12, a + spin + 66)}" stroke-width="6"/>`).join("");
    const bracket = `<path d="M0 54 V0 H54" stroke-width="7"/><path d="M14 40 V14 H40" stroke-width="3"/>`;
    const corners = [[16, 16, 0], [496, 16, 90], [496, 496, 180], [16, 496, 270]].map(([x, y, r]) => g(place(x, y, r), bracket)).join("");
    const pointers = [-90, 0, 180].map((d) => g(place(...at(d, R + 24), d + 90), `<path d="M-9 -8 L9 -8 L0 6Z" fill="${colour}" stroke="none"/>`)).join("");
    const readout = [0, 1, 2].map((i) => `<rect x="${404 + (i % 2) * 14}" y="${58 + i * 11}" width="${40 - (i % 2) * 14}" height="5" fill="${colour}" stroke="none"/>`).join("");
    const dot = frameOf(t) % 8 < 5 ? `<circle cx="52" cy="62" r="7" fill="${light}" stroke="none"/>` : "";
    const art = `<g fill="none" stroke="${colour}" stroke-width="3" stroke-linecap="square">${ring(R + 2, 2.5, colour)}${ticks}${arcs}${corners}${pointers}${readout}${dot}</g>`;
    return svg(blur("b", 6), `<g filter="url(#b)" opacity="0.85">${art}</g>${art}`);
  },
});

/** Concentric pride bands, first colour outermost; [w] weights each band. */
const pride = (id, name, bands) => ({
  id,
  name,
  frames: 1,
  draw: () => {
    const total = bands.reduce((s, [, w = 1]) => s + w, 0);
    const unit = 37 / total;
    let r = R + 38;
    let out = "";
    for (const [c, w = 1] of bands) {
      out += ring(r - (w * unit) / 2, w * unit + 0.8, c);
      r -= w * unit;
    }
    return svg("", out);
  },
});

const devil = (id, name, light, mid, dark) => ({
  id,
  name,
  frames: 1,
  draw: () => {
    const horn = `<path d="M-24 2 C-28 -40 -8 -72 26 -88 C12 -62 12 -30 24 2 Q0 10 -24 2Z" fill="url(#h)" stroke="${dark}" stroke-width="4" stroke-linejoin="round"/><path d="M-10 -14 C-12 -40 0 -62 16 -76" stroke="${light}" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.55"/>`;
    const pts = [];
    for (let deg = 52; deg >= -14; deg -= 2) pts.push(at(deg, R + 16 + 7 * Math.sin(rad(deg * 7))));
    const tail = pathOf(pts);
    const [ex, ey] = pts[pts.length - 1];
    const spade = `<path d="M0 -24 C10 -12 20 -2 15 8 C11 14 4 12 0 6 C-4 12 -11 14 -15 8 C-20 -2 -10 -12 0 -24Z" fill="url(#h)" stroke="${dark}" stroke-width="3.5" stroke-linejoin="round"/>`;
    return svg(
      linear("h", [[0, light], [0.55, mid], [1, dark]]),
      pair(-56, R - 38, 26, 1.05, horn) +
        `<path d="${tail}" stroke="${dark}" stroke-width="13" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="${tail}" stroke="${mid}" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
        g(place(ex, ey + 4, -10, 1.1), spade),
    );
  },
});

const snowyAntlers = {
  id: "snowy-antlers",
  name: "Snowy antlers",
  frames: 1,
  draw: () => {
    const lines = `M0 0 C6 -30 22 -60 50 -92 M8 -30 C2 -48 4 -62 -4 -78 M24 -60 C20 -78 24 -94 20 -110 M38 -78 C50 -86 62 -86 74 -82`;
    const snow = [[50, -96, 13], [20, -114, 10], [-4, -82, 10], [76, -86, 10], [32, -72, 9], [12, -46, 8]].map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${f(r * 0.62)}" fill="#ffffff"/>`).join("");
    const antler = `<path d="${lines}" stroke="#4a3220" stroke-width="18" fill="none" stroke-linecap="round"/><path d="${lines}" stroke="#8a6040" stroke-width="12" fill="none" stroke-linecap="round"/>${snow}`;
    const holly = [[-150, "#2f8a3a"], [-30, "#3fae4f"]].map(([r, c]) => g(`rotate(${r})`, `<path d="M0 0 L8 -8 L16 -3 L24 -10 L32 -2 L40 -8 L46 0 L40 8 L32 2 L24 10 L16 3 L8 8Z" fill="${c}" stroke="#1d5a26" stroke-width="2" stroke-linejoin="round"/>`)).join("");
    const berries = [[-7, 2], [7, 2], [0, -8]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="#d6293a" stroke="#7d0a16" stroke-width="2"/>`).join("");
    return svg(
      "",
      pair(-70, R - 90, 30, 1.35, antler) + g(place(...at(-90, R - 8), 0, 1.3), holly + berries) + g(place(...at(-150, R + 24)), snowflake(14, "#ffffff", 3)) + g(place(...at(-22, R + 26)), snowflake(12, "#ffffff", 3)),
    );
  },
};

const inkSplatter = {
  id: "ink-splatter",
  name: "Ink splatter",
  frames: 1,
  draw: () => {
    const r = rng(211);
    const blob = (a) => R + 10 + 5 * Math.sin(rad(a * 7) + 1) + 3 * Math.sin(rad(a * 17));
    let splats = "";
    for (const [deg, s] of [[-140, 1.3], [-62, 1], [-12, 0.8], [160, 0.9], [28, 0.6], [-100, 0.7]]) {
      const [x, y] = at(deg, R + 16);
      let spikes = "";
      for (let i = 0; i < 9; i++) {
        const a = deg - 80 + r() * 160;
        const l = Math.min((18 + r() * 22) * s, roomAlong(x, y, a, 10) - 8 * s);
        spikes += g(place(x, y, a), `<path d="M0 -5 Q${f(l * 0.6)} -2 ${f(l)} 0 Q${f(l * 0.6)} 2 0 5Z"/><circle cx="${f(l + 6 * s)}" r="${f(2 + r() * 3 * s)}"/>`);
      }
      splats += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(16 * s)}"/>` + spikes;
    }
    let drops = "";
    for (let i = 0; i < 26; i++) {
      const [x, y] = at(r() * 360, R + 22 + r() * 30);
      if (y < S - 12 && y > 12 && x > 12 && x < S - 12) drops += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(1.5 + r() * 4)}"/>`;
    }
    const drip = (deg, l) => {
      const [x, y] = at(deg, R + 10);
      return `<path d="M${f(x - 6)} ${f(y)} L${f(x - 3)} ${f(y + l)} A4 4 0 0 0 ${f(x + 4)} ${f(y + l)} L${f(x + 6)} ${f(y)}Z"/>`;
    };
    return svg(
      "",
      `<g fill="#0b0b0e"><path d="${radiusPath(blob, 3)}" fill="none" stroke="#0b0b0e" stroke-width="16" stroke-linejoin="round"/>${splats}${drops}${drip(-170, 40)}${drip(-8, 30)}</g>` +
        `<path d="${arc(R + 12, -150, -110)}" stroke="#ffffff" stroke-opacity="0.22" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    );
  },
};

const nightcap = {
  id: "nightcap",
  name: "Sleepy nightcap",
  frames: ANIM,
  draw: (t) => {
    const cone = `M-92 -4 C-82 -70 -10 -96 70 -84 C120 -76 150 -40 156 6 C132 -26 108 -40 88 -4Z`;
    const stars = [[-40, -40, 9], [10, -62, 7], [48, -40, 10], [96, -56, 7], [-70, -24, 6], [128, -18, 6]].map(([x, y, r]) => g(place(x, y), star5(r, "#ffe27a"))).join("");
    let trim = "";
    for (let i = 0; i < 9; i++) trim += `<circle cx="${-88 + i * 22}" cy="${i % 2 ? 2 : -2}" r="15" fill="#f7f8ff" stroke="#c9cfe6" stroke-width="2"/>`;
    const cap = `<path d="${cone}" fill="#2f63d6" stroke="#18367a" stroke-width="5" stroke-linejoin="round"/>${stars}${trim}<circle cx="158" cy="18" r="19" fill="#f7f8ff" stroke="#c9cfe6" stroke-width="2"/>`;
    let zs = "";
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1;
      const k = 0.7 + p * 0.6;
      zs += g(place(78 - p * 30, 150 - p * 90, -12, k), `<path d="M-9 -9 H9 L-9 9 H9" stroke="#dfe6ff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`, `opacity="${f(Math.sin(Math.PI * p))}"`);
    }
    return svg("", g(place(232, 92, 8, 1), cap) + zs);
  },
};

const silverOrbit = {
  id: "silver-orbit",
  name: "Silver orbit",
  frames: ANIM,
  draw: (t) => {
    let ticks = "";
    for (let i = 0; i < 60; i++) ticks += `<path d="${pathOf([at(i * 6, R + 22), at(i * 6, R + (i % 5 ? 30 : 38))])}" stroke="#e3e7ee" stroke-width="${i % 5 ? 2.5 : 4}" stroke-linecap="round"/>`;
    const [bx, by] = at(t * 360 - 90, R + 12);
    return svg(
      linear("sv", [[0, "#ffffff"], [0.5, "#aeb4c0"], [1, "#5d6370"]], 0, 0, 1, 1) + blur("b", 5),
      ring(R + 3, 2, "#c9ced8") + ring(R + 12, 9, "url(#sv)") + ring(R + 12, 1.5, "#4a4f5a", `opacity="0.6"`) + ticks +
        `<circle cx="${f(bx)}" cy="${f(by)}" r="13" fill="#ffffff" filter="url(#b)"/><circle cx="${f(bx)}" cy="${f(by)}" r="9" fill="url(#sv)" stroke="#4a4f5a" stroke-width="1.5"/>`,
    );
  },
};

const littleDragon = {
  id: "little-dragon",
  name: "Little dragon",
  frames: 1,
  draw: () => {
    const [a0, a1] = [150, 318];
    const size = (p) => 5 + 15 * Math.min(1, p * 1.4);
    const dist = R + 10;
    let spikes = "";
    for (let p = 0.12; p < 0.92; p += 0.075) {
      const deg = a0 + (a1 - a0) * p;
      spikes += g(place(...at(deg, dist + size(p) - 4), deg + 90), `<path d="M-6 0 L0 ${f(-4 - size(p) * 0.3)} L6 0Z" fill="#ffb43b" stroke="#a8620c" stroke-width="2" stroke-linejoin="round"/>`);
    }
    const wingShape = `<path d="M0 0 C-6 -30 10 -58 40 -70 C34 -54 46 -44 40 -32 C52 -34 58 -24 54 -12 C36 -14 16 -8 0 0Z" fill="#62d68a" stroke="#1f7a42" stroke-width="3" stroke-linejoin="round"/><path d="M2 -4 L36 -62 M4 -2 L46 -30" stroke="#1f7a42" stroke-width="2"/>`;
    const head = `<path d="M-8 -16 C8 -26 34 -24 50 -12 C58 -6 58 8 48 12 L10 18 C-4 18 -12 4 -8 -16Z" fill="#3fbf6a" stroke="#1f7a42" stroke-width="4" stroke-linejoin="round"/><path d="M0 -16 L-18 -38 L12 -20Z M10 -20 L0 -44 L22 -22Z" fill="#fff1c7" stroke="#a8862c" stroke-width="2" stroke-linejoin="round"/><ellipse cx="22" cy="-6" rx="6" ry="7" fill="#ffffff"/><circle cx="24" cy="-5" r="3.5" fill="#1b1b22"/><circle cx="48" cy="-2" r="2.5" fill="#1f7a42"/><path d="M30 10 Q40 12 48 7" stroke="#1f7a42" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    const [hx, hy] = at(a1, dist);
    return svg(
      "",
      g(place(...at(232, dist + 6), -62, 0.95), wingShape) +
        spikes +
        tube(a0, a1, dist, (p) => size(p) + 3, "#1f7a42") +
        tube(a0, a1, dist, size, "#3fbf6a") +
        tube(a0 + 6, a1 - 4, (p) => dist - size(p) * 0.4, (p) => size(p) * 0.45, "#f3e2a0") +
        g(place(hx, hy, a1 + 90 - 70, 1.25), head),
    );
  },
};

const fox = {
  id: "fox-ears",
  name: "Fox ears and tail",
  frames: 1,
  draw: () => {
    const ear = `<path d="M-46 10 L-4 -96 L46 10Z" fill="#f07a22" stroke="#9c4410" stroke-width="5" stroke-linejoin="round"/><path d="M-24 2 L-4 -58 L22 2Z" fill="#fff3e6"/><path d="M-16 -72 L-4 -96 L9 -72 Q-3 -64 -16 -72Z" fill="#3a2418"/>`;
    const size = (p) => 6 + 19 * Math.sin(Math.PI * p * 0.8);
    return svg(
      "",
      pair(-52, R - 36, 34, 1.05, ear) + tube(58, -18, R + 10, (p) => size(p) + 3, "#9c4410") + tube(58, -18, R + 10, size, (p) => (p > 0.8 ? "#fff7ee" : p > 0.74 ? "#ffd9b8" : "#f07a22")),
    );
  },
};

const halloweenWreath = {
  id: "halloween-wreath",
  name: "Halloween wreath",
  frames: 1,
  draw: () => {
    const twig = (a) => R + 12 + 5 * Math.sin(rad(a * 8));
    const colours = ["#e8721c", "#6b2fa0", "#a8261b", "#f2a33a"];
    let leaves = "";
    for (let i = 0; i < 30; i++) {
      const deg = i * 12 + 3;
      if (deg > 62 && deg < 118) continue;
      leaves += g(place(...at(deg, twig(deg)), deg + (i % 2 ? 55 : -55)), leaf(28, 11, colours[i % 4]));
    }
    return svg(
      "",
      `<path d="${radiusPath(twig, 3)}" fill="none" stroke="#3b2a1e" stroke-width="8"/><path d="${radiusPath((a) => twig(a + 20) + 4, 3)}" fill="none" stroke="#5a4130" stroke-width="4"/>` +
        leaves +
        g(place(...at(-138, R + 18)), pumpkin(36, true)) +
        g(place(...at(-38, R + 18)), pumpkin(28, false)) +
        g(place(...at(150, R + 14)), pumpkin(24, true)) +
        g(place(...at(-90, R + 10)), ghost(22)) +
        g(place(...at(12, R + 10), 10), ghost(20)) +
        g(place(...at(-64, R + 30), 12), bat(72, 0.3)),
    );
  },
};

const ghosts = {
  id: "ghosts",
  name: "Ghosts",
  frames: ANIM,
  draw: (t) => {
    let out = "";
    for (const [deg, dist, s, ph] of [[-135, 50, 40, 0], [-64, 22, 28, 0.3], [-24, 28, 24, 0.6], [-160, 24, 24, 0.15], [-100, 18, 18, 0.8]]) {
      const [x, y] = at(deg, R + dist);
      out += g(place(x + 4 * wave(t, ph + 0.25), y + 6 * wave(t, ph), 8 * wave(t, ph + 0.5)), ghost(s), `opacity="0.94"`);
    }
    return svg("", out);
  },
};

const ufos = {
  id: "ufos",
  name: "UFOs",
  frames: ANIM,
  draw: (t) => {
    const frame = frameOf(t);
    const ufo = (shift) =>
      `<ellipse cy="-12" rx="22" ry="20" fill="#bff4ff" fill-opacity="0.9" stroke="#5aa9c4" stroke-width="3"/><ellipse cx="-8" cy="-20" rx="6" ry="4" fill="#ffffff" opacity="0.8"/>` +
      `<ellipse rx="50" ry="15" fill="url(#mt)" stroke="#3d424d" stroke-width="3"/><ellipse cy="7" rx="28" ry="6" fill="#5d6370"/>` +
      [-34, -17, 0, 17, 34].map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 2 : 0}" r="4.5" fill="${(i + frame + shift) % 3 ? "#5c6070" : "#ffe35a"}"/>`).join("");
    return svg(
      linear("mt", [[0, "#f2f4f8"], [0.6, "#a7aebb"], [1, "#6a7180"]]),
      g(place(80, 82 + 6 * wave(t), -14 + 4 * wave(t, 0.25), 1.25), ufo(0)) + g(place(440, 108 + 6 * wave(t, 0.5), 12 + 4 * wave(t, 0.75), 1.0), ufo(1)) + twinkles(331, 6, t, (s) => sparkle(7 + s * 6, "#ffffff"), 18, 40),
    );
  },
};

const soundWaves = {
  id: "sound-waves",
  name: "Sound waves",
  frames: ANIM,
  draw: (t) => {
    let bars = "";
    for (let i = 0; i < 60; i++) {
      const deg = i * 6;
      const envelope = 1 - 0.75 * Math.max(0, Math.sin(rad(deg)));
      const len = (6 + 26 * (0.5 + 0.5 * wave(t * 2, i * 0.137)) * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.7)))) * envelope;
      bars += `<path d="${pathOf([at(deg, R + 7), at(deg, R + 7 + len)])}" stroke="hsl(${Math.round(270 - 90 * Math.abs(Math.sin(rad(deg / 2))))},95%,66%)" stroke-width="5.5" stroke-linecap="round"/>`;
    }
    const note = `<path d="M8 -28 V6" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/><ellipse cx="0" cy="8" rx="9" ry="7" fill="#ffffff" transform="rotate(-20 0 8)"/><path d="M8 -28 Q22 -22 19 -8" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round"/>`;
    const notes = [[-138, 0, 1.2], [-40, 0.5, 1]].map(([deg, ph, k]) => g(place(...at(deg, R + 52), 10 * wave(t, ph), k), note, `opacity="${f(0.7 + 0.3 * wave(t, ph))}"`)).join("");
    return svg(blur("b", 6), `<g filter="url(#b)" opacity="0.7">${bars}</g>${bars}${notes}`);
  },
};

const peekingBunny = {
  id: "peeking-bunny",
  name: "Peeking bunny",
  frames: 1,
  draw: () => {
    const ear = (x, r) => g(`translate(${x} -24) rotate(${r})`, `<path d="M-13 0 C-18 -30 -14 -66 0 -76 C14 -66 18 -30 13 0Z" fill="#fbfbfd" stroke="#c4c8d4" stroke-width="3.5"/><path d="M-6 -6 C-9 -28 -7 -54 0 -62 C7 -54 9 -28 6 -6Z" fill="#ffb8cf"/>`);
    const face = `<ellipse rx="42" ry="36" fill="#fbfbfd" stroke="#c4c8d4" stroke-width="3.5"/><circle cx="-15" cy="-2" r="5.5" fill="#25252f"/><circle cx="15" cy="-2" r="5.5" fill="#25252f"/><circle cx="-13" cy="-4" r="1.8" fill="#ffffff"/><circle cx="17" cy="-4" r="1.8" fill="#ffffff"/><path d="M-5 8 L5 8 L0 13Z" fill="#ff8fb3"/><path d="M0 13 Q-5 19 -10 16 M0 13 Q5 19 10 16" stroke="#8a8f9c" stroke-width="2" fill="none" stroke-linecap="round"/><ellipse cx="-27" cy="10" rx="7" ry="4" fill="#ffc9da"/><ellipse cx="27" cy="10" rx="7" ry="4" fill="#ffc9da"/>`;
    const paws = [-26, 26].map((x) => `<ellipse cx="${x}" cy="38" rx="13" ry="9" fill="#fbfbfd" stroke="#c4c8d4" stroke-width="3"/><path d="M${x - 4} 34 V40 M${x + 4} 34 V40" stroke="#c4c8d4" stroke-width="2" stroke-linecap="round"/>`).join("");
    return svg("", g(place(...at(-45, R + 22), 45, 0.92), ear(-16, -10) + ear(16, 12) + face + paws));
  },
};

const topHat = {
  id: "top-hat",
  name: "Top hat",
  frames: 1,
  draw: () => {
    const hat = `<ellipse rx="98" ry="17" fill="#1b1b22" stroke="#0a0a0d" stroke-width="4"/><path d="M-56 -4 L-62 -118 Q0 -128 62 -118 L56 -4 Q0 6 -56 -4Z" fill="#24242d" stroke="#0a0a0d" stroke-width="4" stroke-linejoin="round"/><ellipse cy="-119" rx="62" ry="10" fill="#33333f" stroke="#0a0a0d" stroke-width="3"/><path d="M-57 -18 L-58 -44 Q0 -36 58 -44 L57 -18 Q0 -10 -57 -18Z" fill="#b3122b"/><path d="M-46 -54 L-49 -106" stroke="#4d4d5c" stroke-width="7" stroke-linecap="round"/>`;
    return svg("", g(place(...at(-97, R - 90), -10, 0.9), hat));
  },
};

const skullRing = {
  id: "skull-ring",
  name: "Skull ring",
  frames: 1,
  draw: () => {
    const skull = `<circle cy="-5" r="16" fill="#f2ecdc" stroke="#3a332b" stroke-width="2.5"/><rect x="-10" y="5" width="20" height="13" rx="3" fill="#f2ecdc" stroke="#3a332b" stroke-width="2.5"/><circle cy="-5" r="14.5" fill="#f2ecdc"/><ellipse cx="-6.5" cy="-3" rx="5" ry="5.5" fill="#2a2420"/><ellipse cx="6.5" cy="-3" rx="5" ry="5.5" fill="#2a2420"/><path d="M0 4 L-3 9 H3Z" fill="#2a2420"/><path d="M-5 12 V18 M0 12 V18 M5 12 V18" stroke="#3a332b" stroke-width="1.8"/>`;
    let out = "";
    for (let deg = -205; deg <= 25; deg += 23) out += g(place(...at(deg, R + 12), deg + 90, 1.25), skull);
    return svg("", ring(R + 6, 5, "#d8cfb8") + ring(R + 6, 1.5, "#6b604f") + out);
  },
};

const purpleEnergy = {
  id: "purple-energy",
  name: "Purple energy",
  frames: ANIM,
  draw: (t) => {
    const r = rng(500 + frameOf(t));
    let spikes = "";
    for (let i = 0; i < 48; i++) {
      const deg = i * 7.5 + (r() - 0.5) * 4;
      const envelope = 1 - 0.65 * Math.max(0, Math.sin(rad(deg)));
      const len = (12 + 24 * r()) * envelope;
      spikes += `<path d="${pathOf([at(deg - 2.4, R + 4), at(deg + (r() - 0.5) * 6, R + 4 + len), at(deg + 2.4, R + 4)])}Z" fill="url(#ev)"/>`;
    }
    return svg(
      radial("ev", [[0.4, "#f3e2ff"], [1, "#9b3dff"]], 0.9) + blur("b", 9),
      ring(R + 10, 28, "#9d4dff", `filter="url(#b)" opacity="${f(0.55 + 0.25 * wave(t * 2))}"`) + `<g filter="url(#b)" opacity="0.8">${spikes}</g>` + spikes + ring(R + 4, 4, "#ecd6ff") + twinkles(509, 6, t, (s) => sparkle(7 + s * 6, "#f6ecff"), 24, 38),
    );
  },
};

const katana = {
  id: "katana",
  name: "Katana and petals",
  frames: ANIM,
  draw: (t) => {
    let wrap = "";
    for (let i = 0; i < 5; i++) wrap += `<path d="M${8 + i * 11} 0 L${13.5 + i * 11} -6 L${19 + i * 11} 0 L${13.5 + i * 11} 6Z" fill="#e9dcc0"/>`;
    const sword =
      `<rect x="0" y="-9" width="64" height="18" rx="5" fill="#1f1a24" stroke="#0c0a0f" stroke-width="2.5"/>${wrap}<rect x="-6" y="-9" width="9" height="18" rx="3" fill="#c99a2e"/>` +
      `<path d="M76 -8 Q160 -10 238 -24 Q234 -12 226 -7 Q152 7 76 8Z" fill="url(#bl)" stroke="#5d6370" stroke-width="2" stroke-linejoin="round"/><path d="M84 2 Q120 0 140 1 Q160 -2 180 -1 Q200 -4 224 -6" stroke="#ffffff" stroke-width="1.8" fill="none" opacity="0.8"/>` +
      `<rect x="66" y="-9" width="10" height="18" rx="2" fill="#e0b64a" stroke="#7a5810" stroke-width="1.5"/><ellipse cx="64" rx="6" ry="17" fill="#2b2420" stroke="#c99a2e" stroke-width="3"/>`;
    const [mx, my] = at(-135, R + 18);
    const petal = (c) => `<path d="M0 -8 C6 -8 8 -1 0 8 C-8 -1 -6 -8 0 -8Z M0 -8 L-2 -5 L2 -5Z" fill="${c}"/>`;
    const petals = falling(601, 24, t, (x, y, s) => g(place(x, y, s * 360 + t * 220, 1.2 + s * 0.6), petal(s > 0.5 ? "#ffc8db" : "#ff9fc1")), 1);
    return svg(linear("bl", [[0, "#ffffff"], [0.5, "#c3c8d2"], [1, "#7d8492"]], 0, 0, 0, 1), petals + g(place(mx - 0.707 * 100, my + 0.707 * 100, -45, 0.86), sword));
  },
};

const pigeon = {
  id: "pigeon",
  name: "Pigeon",
  frames: 1,
  draw: () => {
    const bird =
      `<path d="M-30 -30 L-64 -8 L-56 0 L-26 -18Z" fill="#5b6070" stroke="#3e4350" stroke-width="2" stroke-linejoin="round"/>` +
      `<path d="M-6 -12 L-8 0 M-8 0 L-14 2 M-8 0 L-2 2 M4 -12 L6 0 M6 0 L0 2 M6 0 L12 2" stroke="#e8838f" stroke-width="4" stroke-linecap="round"/>` +
      `<ellipse cx="-4" cy="-34" rx="36" ry="24" fill="#9aa1b2" stroke="#5b6070" stroke-width="2.5" transform="rotate(-14 -4 -34)"/>` +
      `<path d="M-30 -46 C-8 -56 18 -48 22 -30 C6 -22 -16 -22 -40 -26Z" fill="#838a9b" stroke="#5b6070" stroke-width="2"/><path d="M-22 -36 L4 -38 M-24 -30 L2 -31" stroke="#3e4350" stroke-width="3.5" stroke-linecap="round"/>` +
      `<ellipse cx="18" cy="-56" rx="14" ry="18" fill="url(#iri)"/><circle cx="24" cy="-74" r="13" fill="#8d94a6" stroke="#5b6070" stroke-width="2"/>` +
      `<circle cx="28" cy="-77" r="3.6" fill="#ff8a1f"/><circle cx="28.5" cy="-77" r="1.6" fill="#111"/><ellipse cx="37" cy="-75" rx="3" ry="2" fill="#eef0f4"/><path d="M36 -73 L47 -70 L36 -67Z" fill="#3a3a42"/>`;
    return svg(linear("iri", [[0, "#5fd6a0"], [0.5, "#7a6bd6"], [1, "#9aa1b2"]], 0, 0, 1, 1), g(`${place(...at(-45, R - 22), 18, 1.25)} scale(-1 1)`, bird));
  },
};

const candles = {
  id: "floating-candles",
  name: "Floating candles",
  frames: ANIM,
  draw: (t) => {
    const k = 1.3;
    let out = "";
    for (const [deg, want, ph] of [[-172, 40, 0], [-148, 34, 0.35], [-128, 30, 0.7], [-52, 30, 0.2], [-32, 36, 0.55], [-8, 42, 0.85]]) {
      const [x, y] = at(deg, R + 12);
      const h = Math.round(Math.min(want, (y - 12) / k - 30));
      const flicker = 1 + 0.15 * wave(t * 2, ph);
      const candle =
        `<rect x="-9" y="${-h}" width="18" height="${h}" rx="3" fill="#f6efd8" stroke="#c9b98f" stroke-width="2"/><path d="M-9 ${-h + 4} Q-9 ${-h + 12} -5 ${-h + 12} Q-2 ${-h + 7} 1 ${-h + 15} Q4 ${-h + 9} 9 ${-h + 8} V${-h + 4}Z" fill="#fffaea"/>` +
        `<path d="M0 ${-h} V${-h - 6}" stroke="#3a332b" stroke-width="2"/>` +
        `<circle cy="${-h - 14}" r="16" fill="#ffcf5a" filter="url(#b)" opacity="0.6"/>` +
        g(`translate(0 ${-h - 5}) scale(1 ${f(flicker)})`, flame(20, 6, "#ffb21a") + flame(11, 3, "#fff6c2"));
      out += g(place(x, y + 5 * wave(t, ph), 0, k), candle);
    }
    return svg(blur("b", 6), out);
  },
};

const dogEars = {
  id: "dog-ears",
  name: "Dog ears",
  frames: 1,
  draw: () => {
    const ear =
      `<path d="M-30 0 C-54 10 -64 60 -58 100 C-52 136 -10 142 6 118 C20 96 16 40 26 6 Q0 -14 -30 0Z" fill="#8b5a2b" stroke="#3f2410" stroke-width="4" stroke-linejoin="round"/>` +
      `<path d="M-46 44 C-52 74 -48 104 -36 120" stroke="#b9844e" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.8"/>` +
      `<path d="M-30 0 Q0 -14 26 6 C18 26 -12 30 -36 16Z" fill="#5e3a1b" stroke="#3f2410" stroke-width="3" stroke-linejoin="round"/>`;
    return svg("", pair(-44, R - 16, -16, 1.05, `<g transform="scale(-1 1)">${ear}</g>`));
  },
};

const wanted = {
  id: "wanted",
  name: "Wanted",
  frames: 1,
  draw: () => {
    const edge = [];
    const r = rng(733);
    for (let x = -112; x <= 112; x += 14) edge.push([x, -34 + r() * 5]);
    for (let y = -34; y <= 34; y += 12) edge.push([112 - r() * 4, y]);
    for (let x = 112; x >= -112; x -= 14) edge.push([x, 34 - r() * 5]);
    for (let y = 34; y >= -34; y -= 12) edge.push([-112 + r() * 4, y]);
    const label =
      `<path d="${pathOf(edge)}Z" fill="#ead3a2" stroke="#8a6633" stroke-width="3" stroke-linejoin="round"/>` +
      `<text x="0" y="12" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-weight="bold" font-size="38" letter-spacing="3" fill="#3b2410">WANTED</text>` +
      `<path d="M-84 22 H84" stroke="#6b4a22" stroke-width="2.5"/><path d="M-84 -24 H84" stroke="#6b4a22" stroke-width="2.5"/>` +
      `<circle cx="-100" cy="-24" r="5" fill="#6b6f78" stroke="#3a3d44" stroke-width="2"/><circle cx="100" cy="-24" r="5" fill="#6b6f78" stroke="#3a3d44" stroke-width="2"/>`;
    return svg("", g(place(...at(-90, R - 14), -5, 1.2), label));
  },
};

const whiteCatEars = {
  id: "white-cat-ears",
  name: "White cat ears",
  frames: 1,
  draw: () => {
    const ear = `<path d="M-46 10 Q-30 -40 -12 -86 Q-6 -98 2 -86 Q24 -40 46 10Z" fill="#fbfbfd" stroke="#bfc3cf" stroke-width="4.5" stroke-linejoin="round"/><path d="M-26 2 Q-16 -30 -6 -58 Q10 -30 22 2Z" fill="#ffb8cf"/><path d="M-12 0 L-6 -20 M0 0 L-2 -16 M10 0 L4 -18" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>`;
    return svg("", pair(-52, R - 36, 34, 1.05, ear));
  },
};

const deerEars = {
  id: "deer-ears",
  name: "Deer ears",
  frames: 1,
  draw: () => {
    const ear = `<path d="M0 0 C-24 -16 -28 -54 0 -80 C28 -54 24 -16 0 0Z" fill="#b8814a" stroke="#6e4a26" stroke-width="4"/><path d="M0 -10 C-13 -22 -15 -46 0 -64 C15 -46 13 -22 0 -10Z" fill="#f4dcc6"/>`;
    const lines = `M0 0 C-4 -26 6 -46 -2 -72 M-1 -30 C-14 -38 -22 -48 -24 -60 M2 -52 C12 -58 18 -66 20 -78`;
    const antler = `<path d="${lines}" stroke="#4a3220" stroke-width="12" fill="none" stroke-linecap="round"/><path d="${lines}" stroke="#a87a52" stroke-width="7" fill="none" stroke-linecap="round"/>`;
    return svg("", pair(-42, R - 14, 40, 1.35, ear) + pair(-74, R - 60, 16, 1.2, antler));
  },
};

const freshOrange = {
  id: "fresh-orange",
  name: "Fresh orange",
  frames: 1,
  draw: () => {
    const r = rng(811);
    let dimples = "";
    for (let i = 0; i < 26; i++) dimples += `<circle cx="${f((r() - 0.5) * 66)}" cy="${f((r() - 0.5) * 66)}" r="1.4" fill="#d9660a" opacity="0.6"/>`;
    const fruit = `<circle r="44" fill="url(#or)" stroke="#b85600" stroke-width="3"/>${dimples}<ellipse cx="-16" cy="-18" rx="12" ry="7" fill="#ffffff" opacity="0.45" transform="rotate(-35 -16 -18)"/><path d="M0 -42 L2 -52" stroke="#6b4a22" stroke-width="5" stroke-linecap="round"/>${g("translate(2 -50) rotate(-30)", leaf(34, 12, "#3fae4f"))}${g("translate(2 -50) rotate(-165)", leaf(26, 10, "#2f8a3a"))}`;
    const wedge = (i) => {
      const [a0, a1] = [rad(i * 45 + 4), rad(i * 45 + 41)];
      return `<path d="M0 0 L${f(22 * Math.cos(a0))} ${f(22 * Math.sin(a0))} A22 22 0 0 1 ${f(22 * Math.cos(a1))} ${f(22 * Math.sin(a1))}Z" fill="#ffa726"/>`;
    };
    const slice = `<circle r="31" fill="#f57c00"/><circle r="26" fill="#fff3d6"/>${Array.from({ length: 8 }, (_, i) => wedge(i)).join("")}`;
    return svg(radial("or", [[0, "#ffc061"], [0.7, "#f88a0c"], [1, "#e26d00"]], 0.7), g(place(...at(-44, R + 42)), fruit) + g(place(...at(152, R + 18), 20, 1.2), slice));
  },
};

/** How far a ray from ([x], [y]) at [deg] runs before it is [margin] from the canvas edge. */
function roomAlong(x, y, deg, margin = 8) {
  const [ux, uy] = [Math.cos(rad(deg)), Math.sin(rad(deg))];
  const limit = (p, u) => (u > 1e-6 ? (S - margin - p) / u : u < -1e-6 ? (margin - p) / u : Infinity);
  return Math.min(limit(x, ux), limit(y, uy));
}

const sprouts = {
  id: "sprouts",
  name: "Sprouts",
  frames: 1,
  draw: () => {
    const k = 1.35;
    const sprout = (h, big) =>
      `<path d="M0 0 C-5 ${f(-h * 0.4)} 5 ${f(-h * 0.7)} 0 ${f(-h)}" stroke="#2f8a3a" stroke-width="5" fill="none" stroke-linecap="round"/>` +
      g(`translate(0 ${f(-h)}) rotate(-155)`, leaf(26 * big, 12 * big, "#5cc96b")) +
      g(`translate(0 ${f(-h)}) rotate(-25)`, leaf(30 * big, 13 * big, "#3fae4f") + `<path d="M3 0 L${f(24 * big)} 0" stroke="#2f8a3a" stroke-width="1.5"/>`);
    let out = "";
    for (const [deg, want, big] of [[-160, 34, 0.9], [-136, 56, 1.15], [-112, 34, 1], [-90, 22, 0.85], [-68, 34, 1], [-44, 56, 1.15], [-20, 34, 0.9]]) {
      const [x, y] = at(deg, R - 4);
      const h = Math.min(want, roomAlong(x, y, deg, 16) / k - 20 * big);
      out += g(place(x, y, deg + 90, k), sprout(h, big));
    }
    return svg("", out);
  },
};

const warpSpeed = {
  id: "warp-speed",
  name: "Warp speed",
  frames: ANIM,
  draw: (t) => {
    const r = rng(907);
    const colours = ["#ffffff", "#9fd8ff", "#c9a8ff"];
    let out = "";
    for (let i = 0; i < 90; i++) {
      const deg = r() * 360;
      const p = (t + r()) % 1;
      const d0 = R + 6 + p * 150;
      const len = 8 + p * 64;
      out += `<path d="${pathOf([at(deg, d0), at(deg, d0 + len)])}" stroke="${colours[i % 3]}" stroke-width="${f(2.5 + p * 4)}" stroke-linecap="round" opacity="${f(Math.min(1, p * 5) * (1 - 0.4 * p))}"/>`;
    }
    return svg(blur("b", 7), ring(R + 6, 14, "#7fc8ff", `filter="url(#b)" opacity="0.55"`) + out);
  },
};

const vortex = {
  id: "vortex",
  name: "Vortex",
  frames: ANIM,
  draw: (t) => {
    let arms = "";
    for (let k = 0; k < 6; k++) {
      const a = k * 60 + t * 60;
      const pts = [];
      for (let s = 0; s <= 30; s++) pts.push(at(a + s * 5, R + 30 - s * 0.8));
      arms += `<path d="${pathOf(pts)}" stroke="${k % 2 ? "#4fc3ff" : "#9a6bff"}" stroke-width="${k % 2 ? 6 : 8}" fill="none" stroke-linecap="round"/>`;
    }
    return svg(blur("b", 7), ring(R + 8, 16, "#6a4dff", `filter="url(#b)" opacity="0.5"`) + `<g filter="url(#b)" opacity="0.8">${arms}</g>${arms}` + ring(R + 3, 3, "#d6ccff", `opacity="0.8"`));
  },
};

const cloud = (dark) =>
  `<circle cx="-24" cy="6" r="20" fill="${dark}"/><circle cx="2" cy="-8" r="26" fill="${dark}"/><circle cx="28" cy="4" r="20" fill="${dark}"/><rect x="-44" y="4" width="90" height="22" rx="11" fill="${dark}"/><circle cx="-4" cy="-12" r="18" fill="#c3c9d4"/><circle cx="-24" cy="2" r="14" fill="#c3c9d4"/>`;

const rain = {
  id: "rain",
  name: "Rain",
  frames: ANIM,
  draw: (t) =>
    svg(
      "",
      falling(977, 66, t, (x, y, s) => `<path d="M${f(x)} ${f(y)} l-5 ${f(-18 - s * 12)}" stroke="#a8dcff" stroke-width="4" stroke-linecap="round" opacity="${f(0.6 + 0.4 * s)}"/>`, 2) +
        g(place(80, 70, 0, 1.3), cloud("#8e97a8")) +
        g(place(436, 62, 0, 1.05), cloud("#8e97a8")),
    ),
};

const spiderWeb = {
  id: "spider-web",
  name: "Spider web",
  frames: ANIM,
  draw: (t) => {
    const p0 = [8, 8];
    const reach = (deg) => {
      const [ux, uy] = [Math.cos(rad(deg)), Math.sin(rad(deg))];
      const [dx, dy] = [p0[0] - C, p0[1] - C];
      const b = dx * ux + dy * uy;
      const disc = b * b - (dx * dx + dy * dy - (R + 6) ** 2);
      return Math.min(disc > 0 ? -b - Math.sqrt(disc) : 230, 230);
    };
    const spokes = [3, 16, 30, 45, 60, 74, 87].map((d) => [d, reach(d)]);
    const pt = (deg, d) => [p0[0] + d * Math.cos(rad(deg)), p0[1] + d * Math.sin(rad(deg))];
    let threads = spokes.map(([d, l]) => `M${p0[0]} ${p0[1]} L${pathOf([pt(d, l)]).slice(1)}`).join(" ");
    for (let j = 1; j <= 5; j++) {
      const q = j / 5.4;
      for (let i = 0; i < spokes.length - 1; i++) {
        const [a, la] = spokes[i];
        const [b, lb] = spokes[i + 1];
        const [x0, y0] = pt(a, la * q);
        const [x1, y1] = pt(b, lb * q);
        const [cx, cy] = pt((a + b) / 2, ((la + lb) / 2) * q * 0.86);
        threads += ` M${f(x0)} ${f(y0)} Q${f(cx)} ${f(cy)} ${f(x1)} ${f(y1)}`;
      }
    }
    const [ax, ay] = pt(74, reach(74) * 0.62);
    const hang = 70 + 14 * wave(t);
    const legs = [-1, 1].map((s) => [-6, -2, 2, 6].map((y, i) => `<path d="M0 ${y} Q${s * 10} ${y - 8 + i * 3} ${s * (14 + (i % 2) * 2)} ${y + 4 + i * 2}" stroke="#16161b" stroke-width="2.5" fill="none" stroke-linecap="round"/>`).join("")).join("");
    const spider = `${legs}<circle r="7" fill="#16161b"/><ellipse cy="12" rx="9" ry="11" fill="#16161b"/><circle cx="-2.5" cy="-2" r="1.5" fill="#ff5a5a"/><circle cx="2.5" cy="-2" r="1.5" fill="#ff5a5a"/>`;
    return svg(
      "",
      `<path d="${threads}" stroke="#eef1f6" stroke-width="2" fill="none" opacity="0.85"/>` + `<path d="M${f(ax)} ${f(ay)} V${f(ay + hang)}" stroke="#eef1f6" stroke-width="1.5" opacity="0.8"/>` + g(place(ax, ay + hang + 8, 0, 1.4), spider),
    );
  },
};

const crate = {
  id: "wooden-crate",
  name: "Wooden crate",
  frames: 1,
  draw: () => {
    const plank = (x, y, w, h) => {
      const along = w > h;
      let grain = "";
      for (let i = 1; i < 3; i++) grain += along ? `<path d="M${x + 10} ${f(y + (h * i) / 3)} Q${x + w / 2} ${f(y + (h * i) / 3 + 4)} ${x + w - 10} ${f(y + (h * i) / 3)}" stroke="#7a4a1e" stroke-width="2" fill="none" opacity="0.6"/>` : `<path d="M${f(x + (w * i) / 3)} ${y + 10} Q${f(x + (w * i) / 3 + 4)} ${y + h / 2} ${f(x + (w * i) / 3)} ${y + h - 10}" stroke="#7a4a1e" stroke-width="2" fill="none" opacity="0.6"/>`;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="url(#wd)" stroke="#5a3412" stroke-width="3"/>${grain}`;
    };
    const block = (x, y) => `<rect x="${x}" y="${y}" width="50" height="50" rx="4" fill="#9a5e28" stroke="#5a3412" stroke-width="3"/>` + [[12, 12], [38, 12], [12, 38], [38, 38]].map(([dx, dy]) => `<circle cx="${x + dx}" cy="${y + dy}" r="3.5" fill="#3d3d44"/>`).join("");
    return svg(
      linear("wd", [[0, "#d39a5a"], [1, "#b07a3f"]], 0, 0, 1, 1),
      plank(56, 6, 400, 44) + plank(56, 474, 400, 32) + plank(6, 56, 44, 400) + plank(462, 56, 44, 400) + block(6, 6) + block(456, 6) + block(6, 456) + block(456, 456),
    );
  },
};

const monocle = {
  id: "monocle",
  name: "Monocle",
  frames: 1,
  draw: () => {
    const [mx, my] = at(-38, R - 10);
    let links = "";
    for (let i = 0; i < 16; i++) {
      const deg = -16 + i * 4.6;
      links += g(place(...at(deg, R + 20 + 4 * Math.sin((i / 11) * Math.PI)), deg + 90), i % 2 ? `<rect x="-9" y="-2" width="18" height="4" rx="2" fill="url(#gd)" stroke="#6b4800" stroke-width="1"/>` : `<ellipse rx="9" ry="5" fill="none" stroke="#6b4800" stroke-width="5"/><ellipse rx="9" ry="5" fill="none" stroke="url(#gd)" stroke-width="3"/>`);
    }
    return svg(
      linear("gd", [[0, "#fff1a6"], [0.45, "#f0bd30"], [1, "#9a6b00"]], 0, 0, 1, 1),
      links + g(place(...at(56, R + 22), 56), `<rect x="-14" y="-4" width="28" height="8" rx="3" fill="url(#gd)" stroke="#6b4800" stroke-width="2"/>`) +
        `<circle cx="${f(mx)}" cy="${f(my)}" r="40" fill="#e8f6ff" fill-opacity="0.16"/><circle cx="${f(mx)}" cy="${f(my)}" r="40" fill="none" stroke="#6b4800" stroke-width="13"/><circle cx="${f(mx)}" cy="${f(my)}" r="40" fill="none" stroke="url(#gd)" stroke-width="9"/>` +
        `<path d="M${f(mx - 22)} ${f(my - 14)} A26 26 0 0 1 ${f(mx - 2)} ${f(my - 26)}" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.8"/>`,
    );
  },
};

const GLYPHS = ["111101101101111", "010110010010111", "111001111100111", "111001011001111", "101101111001001", "111100111001111", "111100111101111", "111001010010010", "111101111101111", "111101111001111", "110101110101110", "011100100100011"];

const codeRain = {
  id: "code-rain",
  name: "Code rain",
  frames: ANIM,
  draw: (t) => {
    const r = rng(1013);
    const [cw, ch, px] = [18, 21, 3.4];
    const rows = Math.ceil(S / ch);
    let out = "";
    for (let col = 0; col < Math.floor(S / cw); col++) {
      const speed = r() < 0.5 ? 1 : 2;
      const phase = r();
      const trail = 6 + Math.floor(r() * 8);
      const head = Math.floor(((t * speed + phase) % 1) * (rows + trail));
      for (let row = 0; row < rows; row++) {
        const k = head - row;
        if (k < 0 || k >= trail) continue;
        const [x, y] = [col * cw + 4, row * ch + 2];
        if (!outside(x + 5, y + 8, 4)) continue;
        const glyph = GLYPHS[(col * 7 + row * 13 + (k === 0 ? frameOf(t) : 0)) % GLYPHS.length];
        let cells = "";
        for (let i = 0; i < 15; i++) if (glyph[i] === "1") cells += `<rect x="${f(x + (i % 3) * px)}" y="${f(y + Math.floor(i / 3) * px)}" width="${px}" height="${px}"/>`;
        out += `<g fill="${k === 0 ? "#e9ffe9" : "#39ff6a"}" opacity="${f(1 - k / trail)}">${cells}</g>`;
      }
    }
    return svg("", out);
  },
};

const pawPrints = {
  id: "paw-prints",
  name: "Paw prints",
  frames: ANIM,
  draw: (t) => {
    const paw = `<path d="M0 -2 C9 -2 15 6 15 12 C15 18 9 18 0 16 C-9 18 -15 18 -15 12 C-15 6 -9 -2 0 -2Z"/><ellipse cx="-14" cy="-8" rx="5" ry="6.5"/><ellipse cx="-5" cy="-15" rx="5" ry="7"/><ellipse cx="5" cy="-15" rx="5" ry="7"/><ellipse cx="14" cy="-8" rx="5" ry="6.5"/>`;
    const n = 12;
    let out = "";
    for (let i = 0; i < n; i++) {
      const deg = 150 + i * 21;
      const fade = 1 - ((t - i / n + 1) % 1);
      out += g(place(...at(deg, R + (i % 2 ? 24 : 12)), deg + 180, 1.0), paw, `fill="#ffb3cf" opacity="${f(0.2 + 0.8 * fade)}"`);
    }
    return svg("", out);
  },
};

const saturn = {
  id: "saturn-ring",
  name: "Saturn ring",
  frames: ANIM,
  draw: (t) => {
    const band = (d, w, c, extra = "") => `<ellipse cx="${C}" cy="${C}" rx="${R + 22 + d}" ry="${R + 2 + d}" fill="none" stroke="${c}" stroke-width="${w}" transform="rotate(-20 ${C} ${C})" ${extra}/>`;
    return svg(
      blur("b", 6),
      band(8, 22, "#f2d79e", `filter="url(#b)" opacity="0.5"`) + band(2, 5, "#c99a5b") + band(7, 4, "#f6e3b8") + band(12, 5, "#a8743f") + band(16.5, 3, "#e9c98a") + twinkles(1103, 9, t, (s, i) => sparkle(8 + s * 10, i % 3 ? "#fff6d8" : "#ffe08a"), 16, 44),
    );
  },
};

const vampire = {
  id: "vampire",
  name: "Vampire",
  frames: ANIM,
  draw: (t) => {
    const outer = [[118, R - 4], [130, R + 32], [160, R + 38], [-172, R + 38], [-150, R + 36]];
    const inner = [[-152, R + 22], [-170, R + 26], [165, R + 26], [140, R + 18], [125, R + 4]];
    const back = [];
    for (let d = -148; d >= -238; d -= 6) back.push([d, R - 2]);
    const collar = `<path d="${pathOf([...outer, ...back].map(([d, r]) => at(d, r)))}Z" fill="#141018" stroke="#050407" stroke-width="3" stroke-linejoin="round"/>`;
    const lining = `<path d="${pathOf([...inner, ...[-238, -220, -200, -180, -160].map((d) => [d, R + 4])].map(([d, r]) => at(d, r)))}Z" fill="#a3121f"/>`;
    const fangs = [-1, 1].map((s) => g(place(...at(90 + s * 7, R - 2)), `<path d="M-5 0 L5 0 L0 16Z" fill="#ffffff" stroke="#c9ccd6" stroke-width="1.5" stroke-linejoin="round"/>`)).join("");
    const bats = [[-124, 30, 0], [-90, 24, 0.33], [-56, 30, 0.66]].map(([deg, d, ph]) => g(place(...at(deg, R + d)), bat(76, wave(t * 2, ph)))).join("");
    const side = collar + lining;
    return svg("", side + g(`translate(${S} 0) scale(-1 1)`, side) + `<path d="${arc(R + 1, 76, 104)}" stroke="#7d0a16" stroke-width="5" fill="none" stroke-linecap="round"/>` + fangs + bats);
  },
};

export const EXTRA = [
  snowyAntlers,
  hud("hud-orange", "Orange HUD", "#ff8a1f", "#ffd9a8"),
  hud("hud-red", "Red HUD", "#ff3341", "#ffc2c7"),
  inkSplatter,
  nightcap,
  silverOrbit,
  littleDragon,
  fox,
  neon("neon-purple", "Purple neon", "#b24dff", "#f0dcff"),
  neon("neon-cyan", "Cyan neon", "#00e5ff", "#d4fbff"),
  neon("neon-pink", "Pink neon", "#ff3fb4", "#ffd6ef"),
  neon("neon-red", "Red neon", "#ff2a3d", "#ffd0d4"),
  wingsDeco("raven-wings", "Raven wings", "#1b1b22", "#6c6c80"),
  halloweenWreath,
  ghosts,
  ufos,
  soundWaves,
  peekingBunny,
  topHat,
  skullRing,
  purpleEnergy,
  pride("pride", "Pride", [["#e40303"], ["#ff8c00"], ["#ffed00"], ["#008026"], ["#24408e"], ["#732982"]]),
  pride("trans-pride", "Trans pride", [["#5bcefa"], ["#f5a9b8"], ["#ffffff"], ["#f5a9b8"], ["#5bcefa"]]),
  pride("lesbian-pride", "Lesbian pride", [["#d52d00"], ["#ff9a56"], ["#ffffff"], ["#d362a4"], ["#a30262"]]),
  pride("bi-pride", "Bi pride", [["#d60270", 2], ["#9b4f96", 1], ["#0038a8", 2]]),
  pride("pan-pride", "Pan pride", [["#ff218c"], ["#ffd800"], ["#21b1ff"]]),
  pride("aroace-pride", "Aroace pride", [["#e28c00"], ["#eccd00"], ["#ffffff"], ["#62aedc"], ["#203856"]]),
  katana,
  pigeon,
  candles,
  dogEars,
  wanted,
  whiteCatEars,
  deerEars,
  devil("red-devil", "Red devil", "#ff6a5f", "#c4161f", "#4a0508"),
  devil("purple-devil", "Purple devil", "#c79bff", "#7a2fd0", "#2a0b4d"),
  freshOrange,
  sprouts,
  warpSpeed,
  vortex,
  rain,
  spiderWeb,
  crate,
  monocle,
  codeRain,
  pawPrints,
  saturn,
  vampire,
];

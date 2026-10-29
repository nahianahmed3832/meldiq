import { at, blur, bolt, C, f, flame, g, heart, linear, place, R, radial, ring, rng, S, segmentedRing, snowflake, sparkle, star5, svg, wave, wing, outside } from "./shapes.mjs";

/**
 * Meldiq's own decorations, part one: the classics (flames, crowns, halos, rings…). Each is { id, name, frames, draw },
 * draw(t) giving the SVG at t in [0, 1); frames 1 is a still image.
 */

const ANIM = 16;

const flames = {
  id: "flames",
  name: "Flames",
  frames: ANIM,
  draw: (t) => {
    let body = "";
    const n = 26;
    for (let i = 0; i < n; i++) {
      const deg = -200 + (i * 220) / (n - 1);
      const top = Math.cos(((deg + 90) * Math.PI) / 180);
      const h = 26 + 34 * Math.max(0, top) + 9 * wave(t * 2, i * 0.37);
      const [x, y] = at(deg, R - 6);
      body += g(place(x, y, deg + 90), flame(h, 11, "url(#fo)") + flame(h * 0.55, 6, "url(#fi)"));
    }
    return svg(
      linear("fo", [[0, "#ffd34d"], [0.5, "#ff7a1a"], [1, "#e0300b"]], 0, 0, 0, 1) + linear("fi", [[0, "#fff6c2"], [1, "#ffb21a"]], 0, 0, 0, 1) + blur("b", 9),
      ring(R + 2, 14, "#ff6a1a", `filter="url(#b)" opacity="${f(0.55 + 0.15 * wave(t))}"`) + body,
    );
  },
};

const crown = {
  id: "crown",
  name: "Crown",
  frames: 1,
  draw: () => {
    const [x, y] = at(-96, R - 72);
    const shape = `<path d="M-78 0 L-84 -66 L-42 -30 L0 -86 L42 -30 L84 -66 L78 0 Z" fill="url(#gold)" stroke="#8a5a00" stroke-width="4" stroke-linejoin="round"/>`;
    const band = `<rect x="-80" y="-14" width="160" height="22" rx="6" fill="url(#gold2)" stroke="#8a5a00" stroke-width="3"/>`;
    const gems = [[-46, "#e23d4f"], [0, "#2f7bf0"], [46, "#2dbb6b"]].map(([gx, c]) => `<circle cx="${gx}" cy="-3" r="7" fill="${c}" stroke="#fff" stroke-opacity="0.6" stroke-width="2"/>`).join("");
    const balls = [[-84, -66], [0, -86], [84, -66]].map(([bx, by]) => `<circle cx="${bx}" cy="${by}" r="8" fill="#fff3b0" stroke="#8a5a00" stroke-width="3"/>`).join("");
    return svg(
      linear("gold", [[0, "#fff1a6"], [0.45, "#f5c431"], [1, "#b47b00"]]) + linear("gold2", [[0, "#ffe27a"], [1, "#c48a0a"]]),
      g(place(x, y, -9, 1.12), shape + band + gems + balls),
    );
  },
};

const halo = {
  id: "halo",
  name: "Halo",
  frames: ANIM,
  draw: (t) => {
    const y = 34 + 5 * wave(t);
    const e = (w, c, extra = "") => `<ellipse cx="${C}" cy="${f(y)}" rx="104" ry="20" fill="none" stroke="${c}" stroke-width="${w}" ${extra}/>`;
    return svg(blur("b", 7), e(18, "#ffe27a", `filter="url(#b)" opacity="0.8"`) + e(10, "#ffd84a") + e(3, "#fffbe0"));
  },
};

const horns = {
  id: "horns",
  name: "Horns",
  frames: 1,
  draw: () => {
    const horn = `<path d="M-30 0 C-36 -46 -18 -86 12 -104 C2 -74 6 -40 30 0 Q0 10 -30 0Z" fill="url(#h)" stroke="#4a0508" stroke-width="4" stroke-linejoin="round"/><path d="M-14 -20 C-16 -50 -4 -76 10 -92" stroke="#ff8a8a" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.6"/>`;
    const [lx, ly] = at(-126, R - 40);
    const [rx, ry] = at(-54, R - 40);
    return svg(
      linear("h", [[0, "#ff5a4f"], [0.6, "#b3121b"], [1, "#5c0408"]], 0, 0, 0, 1),
      g(`${place(lx, ly, -28, 1.1)} scale(-1 1)`, horn) + g(place(rx, ry, 28, 1.1), horn),
    );
  },
};

const catEars = {
  id: "cat-ears",
  name: "Cat ears",
  frames: 1,
  draw: () => {
    const ear = `<path d="M-46 8 L-8 -92 L46 8 Z" fill="#2d2d38" stroke="#16161c" stroke-width="5" stroke-linejoin="round"/><path d="M-26 0 L-8 -60 L24 0 Z" fill="#f6a5c8" stroke-linejoin="round"/>`;
    const [lx, ly] = at(-128, R - 36);
    const [rx, ry] = at(-52, R - 36);
    return svg("", g(`${place(lx, ly, -36, 1.05)} scale(-1 1)`, ear) + g(place(rx, ry, 36, 1.05), ear));
  },
};

const wingsDeco = (id, name, fill, edge) => ({
  id,
  name,
  frames: ANIM,
  draw: (t) => {
    const flap = 9 * wave(t);
    const [lx, ly] = at(-158, R - 26);
    const [rx, ry] = at(-22, R - 26);
    const w = wing(6, 150, fill, edge);
    return svg("", g(`${place(lx, ly, 10 - flap)}`, w) + g(`${place(rx, ry, flap - 10)} scale(-1 1)`, w));
  },
});

const headphones = {
  id: "headphones",
  name: "Headphones",
  frames: 1,
  draw: () => {
    const cup = (x) => `<rect x="${x - 22}" y="214" width="44" height="98" rx="20" fill="#2b2b36" stroke="#14141a" stroke-width="4"/><rect x="${x - 6}" y="234" width="12" height="58" rx="6" fill="#8b6cff"/><rect x="${x - 6}" y="234" width="12" height="58" rx="6" fill="#b9a6ff" filter="url(#b)"/>`;
    return svg(
      blur("b", 5),
      `<path d="M38 262 C38 70 474 70 474 262" fill="none" stroke="#2b2b36" stroke-width="20" stroke-linecap="round"/><path d="M50 250 C56 92 456 92 462 250" fill="none" stroke="#5a5a6c" stroke-width="5" stroke-linecap="round"/>` +
        cup(36) + cup(476),
    );
  },
};

const laurel = {
  id: "laurel",
  name: "Laurel",
  frames: 1,
  draw: () => {
    let leaves = "";
    for (const side of [-1, 1]) {
      for (let i = 0; i < 13; i++) {
        const deg = 90 - side * (12 + i * 13);
        const [x, y] = at(deg, R + 8 + (i % 2 ? 10 : -6));
        const tangent = deg - side * 90 + (i % 2 ? -25 : 25) * side;
        leaves += g(place(x, y, tangent), `<path d="M0 0 Q22 -14 46 0 Q22 14 0 0Z" fill="url(#lg)" stroke="#7a5200" stroke-width="2"/>`);
      }
    }
    const [bx, by] = at(90, R + 10);
    return svg(
      linear("lg", [[0, "#ffe486"], [1, "#c9900e"]]),
      `<path d="${arcPath(R + 8, 100, 255)}" stroke="#a87405" stroke-width="6" fill="none"/><path d="${arcPath(R + 8, -75, 80)}" stroke="#a87405" stroke-width="6" fill="none"/>` +
        leaves +
        g(place(bx, by), `<path d="M-14 -6 L14 -6 L8 16 L0 10 L-8 16Z" fill="#d6293a"/><circle r="8" fill="#e8394a"/>`),
    );
  },
};

function arcPath(r, a0, a1) {
  const [x0, y0] = at(a0, r);
  const [x1, y1] = at(a1, r);
  return `M${f(x0)} ${f(y0)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
}

/** Particles that drift down through the canvas and are only drawn outside the avatar. */
function falling(seed, n, t, draw, speed = 1) {
  const r = rng(seed);
  let out = "";
  for (let i = 0; i < n; i++) {
    const x0 = r() * S;
    const y0 = r() * S;
    const s = r();
    const sway = 8 * wave(t, r());
    const y = (y0 + t * S * speed) % S;
    const x = x0 + sway;
    if (!outside(x, y, 8)) continue;
    out += draw(x, y, s, i);
  }
  return out;
}

const snow = {
  id: "snow",
  name: "Snow",
  frames: ANIM,
  draw: (t) => svg("", falling(7, 46, t, (x, y, s) => g(place(x, y, s * 60), snowflake(9 + s * 8, "#ffffff", 3)))),
};

/** Particles around the ring that rise and fade. */
function rising(seed, n, t, draw) {
  const r = rng(seed);
  let out = "";
  for (let i = 0; i < n; i++) {
    const deg = r() * 360;
    const dist = R + 10 + r() * 30;
    const phase = r();
    const p = (t + phase) % 1;
    const [x, y] = at(deg, dist);
    const opacity = 0.25 + 0.75 * Math.sin(Math.PI * p);
    out += `<g opacity="${f(opacity)}">${draw(x, y - p * 26, r(), i)}</g>`;
  }
  return out;
}

const hearts = {
  id: "hearts",
  name: "Hearts",
  frames: ANIM,
  draw: (t) => {
    const colours = ["#ff6fa8", "#ff8fc0", "#ff4f8b", "#ffb3d1"];
    return svg("", rising(11, 14, t, (x, y, s, i) => g(place(x, y, (s - 0.5) * 30), heart(24 + s * 14, colours[i % colours.length]))));
  },
};

/** Twinkling points at fixed places around the avatar. */
function twinkles(seed, n, t, draw, min = 12, max = 40) {
  const r = rng(seed);
  let out = "";
  for (let i = 0; i < n; i++) {
    const deg = r() * 360;
    const [x, y] = at(deg, R + min + r() * (max - min));
    const k = 0.35 + 0.65 * Math.max(0, wave(t, r()));
    out += g(place(x, y, 0, k), draw(r(), i), `opacity="${f(0.4 + 0.6 * k)}"`);
  }
  return out;
}

const stars = {
  id: "stars",
  name: "Stars",
  frames: ANIM,
  draw: (t) => svg("", twinkles(23, 14, t, (s, i) => sparkle(13 + s * 12, i % 3 ? "#fff6d0" : "#ffd86b"))),
};

const lightning = {
  id: "lightning",
  name: "Lightning",
  frames: ANIM,
  draw: (t) => {
    const r = rng(5);
    let out = "";
    const frame = Math.round(t * ANIM);
    for (let i = 0; i < 9; i++) {
      const deg = i * 40 + r() * 20;
      const [x, y] = at(deg, R + 22);
      const on = (frame + i * 5) % 8 < 5;
      if (!on) continue;
      out += g(place(x, y, deg + 90 + (r() - 0.5) * 30), `<g filter="url(#b)">${bolt(52, "#7fd0ff")}</g>${bolt(48, "#e9f8ff")}`);
    }
    return svg(blur("b", 4), out);
  },
};

const glowRing = (id, name, colour, light, animated = true) => ({
  id,
  name,
  frames: animated ? ANIM : 1,
  draw: (t) =>
    svg(
      blur("b", 10),
      ring(R + 9, 22, colour, `filter="url(#b)" opacity="${f(0.55 + (animated ? 0.3 * wave(t) : 0.2))}"`) + ring(R + 8, 10, colour) + ring(R + 8, 3, light, `opacity="0.8"`),
    ),
});

const rainbow = {
  id: "rainbow",
  name: "Rainbow",
  frames: ANIM,
  draw: (t) => {
    const hue = (i) => `hsl(${Math.round((i * 5 + t * 360) % 360)},95%,62%)`;
    return svg(blur("b", 9), `<g filter="url(#b)" opacity="0.6">${segmentedRing(R + 10, 20, 72, hue)}</g>${segmentedRing(R + 10, 13, 72, hue)}`);
  },
};

const fire = {
  id: "fire",
  name: "Fire",
  frames: ANIM,
  draw: (t) => {
    const col = (i) => `hsl(${Math.round(8 + 38 * (0.5 + 0.5 * Math.sin((i / 72) * Math.PI * 4 + t * Math.PI * 2)))},100%,${Math.round(50 + 8 * Math.sin(i))}%)`;
    let embers = rising(31, 14, t, (x, y, s) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(2 + s * 2.5)}" fill="#ffcf4a"/>`);
    return svg(blur("b", 10), `<g filter="url(#b)" opacity="0.75">${segmentedRing(R + 9, 24, 72, col)}</g>${segmentedRing(R + 9, 14, 72, col)}${embers}`);
  },
};

const ice = {
  id: "ice",
  name: "Ice",
  frames: 1,
  draw: () =>
    svg(
      blur("b", 9),
      ring(R + 9, 22, "#8fd8ff", `filter="url(#b)" opacity="0.7"`) + ring(R + 8, 12, "#dff6ff") + ring(R + 3, 3, "#9fdcff") +
        g(place(...at(-42, R + 12)), snowflake(32, "#ffffff", 6)) + g(place(...at(136, R + 14)), snowflake(24, "#e6f7ff", 5)),
    ),
};

const gold = {
  id: "gold",
  name: "Gold",
  frames: 1,
  draw: () =>
    svg(
      linear("gd", [[0, "#fff4b8"], [0.3, "#e8b730"], [0.55, "#8a5e00"], [0.8, "#f6d35a"], [1, "#b98a0c"]], 0, 0, 1, 1),
      ring(R + 9, 18, "url(#gd)") + ring(R + 1, 2.5, "#6b4800", `opacity="0.7"`) + ring(R + 17, 2.5, "#fff2b0", `opacity="0.7"`),
    ),
};

const sparkleRing = {
  id: "sparkle",
  name: "Sparkle",
  frames: ANIM,
  draw: (t) => {
    const big = [[-150, 30, 0], [-28, 24, 0.33], [62, 22, 0.66]]
      .map(([deg, r, ph]) => g(place(...at(deg, R + 16), 0, 0.7 + 0.3 * Math.abs(wave(t, ph))), `<g filter="url(#b)">${sparkle(r + 4, "#fff4c4")}</g>${sparkle(r, "#ffffff")}`))
      .join("");
    return svg(blur("b", 6), ring(R + 7, 16, "#fff8e0", `filter="url(#b)" opacity="0.8"`) + ring(R + 7, 7, "#ffffff") + big);
  },
};

const galaxy = {
  id: "galaxy",
  name: "Galaxy",
  frames: ANIM,
  draw: (t) => {
    const col = (i) => `hsl(${Math.round(250 + 60 * Math.sin((i / 72) * Math.PI * 2 + t * Math.PI * 2))},90%,${Math.round(62 + 10 * Math.sin(i * 0.7))}%)`;
    const r = rng(41);
    let dots = "";
    for (let i = 0; i < 16; i++) {
      const deg = r() * 360 + t * 90;
      dots += g(place(...at(deg, R + 12 + r() * 26)), sparkle(4 + r() * 7, i % 2 ? "#e8e0ff" : "#ffffff"));
    }
    return svg(blur("b", 10), `<g filter="url(#b)" opacity="0.7">${segmentedRing(R + 9, 24, 72, col)}</g>${segmentedRing(R + 9, 12, 72, col)}${dots}`);
  },
};

const neonRing = {
  id: "neon-ring",
  name: "Neon rings",
  frames: 1,
  draw: () =>
    svg(
      blur("b", 8),
      ring(R + 16, 12, "#ff4fd8", `filter="url(#b)"`) + ring(R + 16, 5, "#ffc6f3") + ring(R + 5, 10, "#24d4e0", `filter="url(#b)"`) + ring(R + 5, 4, "#b8fbff"),
    ),
};

const heartbeat = {
  id: "heartbeat",
  name: "Heartbeat",
  frames: ANIM,
  draw: (t) => {
    const beat = Math.max(0, Math.sin(t * Math.PI * 4)) ** 3;
    return svg(
      blur("b", 9),
      ring(R + 9, 22, "#ff5c9e", `filter="url(#b)" opacity="${f(0.45 + 0.4 * beat)}"`) + ring(R + 9, 12, "#ff7ab5") + ring(R + 9, 4, "#ffd0e4") +
        g(place(...at(-48, R + 30), 12, 1 + 0.18 * beat), heart(58, "#ff5c9e")) + g(place(...at(-26, R + 34), -14, 0.9 + 0.12 * beat), heart(36, "#ff8fc0")) + g(place(...at(150, R + 22), -10), heart(32, "#ffc2da")),
    );
  },
};

const toxic = {
  id: "toxic",
  name: "Toxic",
  frames: ANIM,
  draw: (t) => {
    let drips = "";
    for (const [deg, len, ph] of [[70, 44, 0], [96, 60, 0.4], [118, 38, 0.7], [56, 30, 0.2]]) {
      const [x, y] = at(deg, R + 12);
      const l = len * (0.5 + 0.5 * ((t + ph) % 1));
      drips += `<path d="M${f(x - 8)} ${f(y)} L${f(x - 5)} ${f(y + l)} A5 5 0 0 0 ${f(x + 5)} ${f(y + l)} L${f(x + 8)} ${f(y)}Z" fill="#6dff3a"/>`;
    }
    return svg(blur("b", 10), ring(R + 9, 24, "#39ff14", `filter="url(#b)" opacity="${f(0.55 + 0.25 * wave(t))}"`) + ring(R + 9, 12, "#4ce62a") + ring(R + 9, 4, "#c8ff9e") + drips);
  },
};

export const CLASSIC = [
  flames,
  crown,
  halo,
  horns,
  catEars,
  wingsDeco("wings", "Wings", "#f4f8ff", "#a9bde0"),
  headphones,
  laurel,
  snow,
  hearts,
  stars,
  lightning,
  glowRing("glow", "Glow", "#ff7a5c", "#ffd2c4"),
  rainbow,
  fire,
  ice,
  gold,
  sparkleRing,
  galaxy,
  neonRing,
  heartbeat,
  toxic,
];
export { falling, rising, twinkles, arcPath, wingsDeco, glowRing, ANIM };

import { ANIM, falling, glowRing, twinkles, wingsDeco } from "./classic.mjs";
import { at, bird, blur, bow, C, f, flame, g, leaf, linear, outside, place, R, radial, radiusPath, ring, rng, S, snowflake, sparkle, star5, svg, wave, wing } from "./shapes.mjs";

/**
 * Meldiq's own decorations, part two: themes people love in community-made decorations (night skies, lace, thorns,
 * cats, crows…), each drawn here from scratch, and a few of Meldiq's own (Meldling's ears, a controller, bubbles).
 */

const starryNight = {
  id: "starry-night",
  name: "Starry night",
  frames: ANIM,
  draw: (t) =>
    svg(
      "",
      ring(R + 10, 3, "#d9dde8", `opacity="0.8"`) +
        g(place(...at(-52, R + 24), -20), `<path d="M0 -34 A34 34 0 1 0 30 18 A26 26 0 1 1 0 -34Z" fill="#fff4c9"/>`) +
        twinkles(3, 10, t, (s) => sparkle(9 + s * 10, "#ffffff"), 14, 38) +
        g(place(...at(-150, R + 26)), `<polygon points="0,-14 4,-5 13,-4 6,3 8,12 0,7 -8,12 -6,3 -13,-4 -4,-5" fill="none" stroke="#c9cede" stroke-width="2.5" stroke-linejoin="round"/>`),
    ),
};

const smoke = {
  id: "smoke",
  name: "Black smoke",
  frames: ANIM,
  draw: (t) => {
    const r = rng(17);
    let puffs = "";
    for (let i = 0; i < 26; i++) {
      const deg = (i * 360) / 26 + t * 360 * (i % 2 ? 0.25 : -0.25) + r() * 10;
      const [x, y] = at(deg, R + 6 + r() * 22);
      puffs += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(20 + r() * 16)}" fill="${i % 3 ? "#121214" : "#2a2a30"}" opacity="${f(0.55 + 0.3 * r())}"/>`;
    }
    return svg(blur("b", 9), `<g filter="url(#b)">${puffs}</g>` + ring(R + 2, 5, "#0b0b0d", `opacity="0.8"`));
  },
};

const lace = (id, name, fill, detail, inner) => ({
  id,
  name,
  frames: 1,
  draw: () => {
    let scallops = "";
    for (let i = 0; i < 40; i++) {
      const [x, y] = at(i * 9, R + 18);
      scallops += `<circle cx="${f(x)}" cy="${f(y)}" r="15" fill="${fill}"/>`;
      const [hx, hy] = at(i * 9, R + 22);
      scallops += `<circle cx="${f(hx)}" cy="${f(hy)}" r="4" fill="${detail}"/>`;
    }
    return svg("", scallops + ring(R + 6, 16, fill) + ring(R + 6, 3, inner, `stroke-dasharray="5 6"`));
  },
});

/** A wavy radius around the avatar: six waves, shifted by [shift] degrees. */
const wavy = (shift) => (a) => R + 10 + 7 * Math.sin(((a + shift) * Math.PI * 6) / 180);

const thorns = {
  id: "crimson",
  name: "Crimson thorns",
  frames: 1,
  draw: () => {
    let spikes = "";
    for (let i = 0; i < 30; i++) {
      const deg = i * 12 + (i % 2) * 4;
      spikes += g(place(...at(deg, wavy(0)(deg)), deg + (i % 2 ? 30 : -30)), `<path d="M0 -5 L22 0 L0 5Z" fill="#7d0a16"/>`);
    }
    const vine = (shift, w, c) => `<path d="${radiusPath(wavy(shift), 3)}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round"/>`;
    return svg(blur("b", 6), `<g filter="url(#b)" opacity="0.6">${vine(0, 14, "#c2182b")}</g>` + vine(0, 7, "#5c0610") + vine(30, 5, "#9b1020") + spikes);
  },
};

const blossom = {
  id: "blossom",
  name: "Blossom",
  frames: ANIM,
  draw: (t) => {
    const flower = (s) => {
      let p = "";
      for (let i = 0; i < 5; i++) p += g(`rotate(${i * 72})`, `<ellipse cx="0" cy="${f(-s * 0.55)}" rx="${f(s * 0.36)}" ry="${f(s * 0.55)}" fill="#ffc3d7" stroke="#f08cb0" stroke-width="1.5"/>`);
      return p + `<circle r="${f(s * 0.18)}" fill="#ff7aa6"/>`;
    };
    const petals = falling(29, 26, t, (x, y, s) => g(place(x, y, s * 360 + t * 200), `<ellipse rx="8" ry="5" fill="${s > 0.5 ? "#ffd0e0" : "#ffb0cc"}"/>`), 0.8);
    return svg("", petals + g(place(...at(-140, R + 8)), flower(34)) + g(place(...at(-116, R + 22), 20), flower(26)) + g(place(...at(-162, R + 26), -10), flower(22)));
  },
};

const blackCats = {
  id: "black-cats",
  name: "Black cats",
  frames: 1,
  draw: () => {
    const cat = `<path d="M-30 30 C-34 0 -26 -24 -18 -30 L-24 -58 L-4 -38 L4 -38 L24 -58 L18 -30 C26 -24 34 0 30 30 Z" fill="#111114"/><ellipse cx="-10" cy="-14" rx="5" ry="7" fill="#ffd23f"/><ellipse cx="10" cy="-14" rx="5" ry="7" fill="#ffd23f"/><ellipse cx="-10" cy="-14" rx="1.8" ry="5" fill="#111"/><ellipse cx="10" cy="-14" rx="1.8" ry="5" fill="#111"/><path d="M-4 -2 L0 2 L4 -2" stroke="#f6a5c8" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    const paws = `<ellipse cx="-16" cy="30" rx="10" ry="7" fill="#111114"/><ellipse cx="16" cy="30" rx="10" ry="7" fill="#111114"/>`;
    const tail = `<path d="M24 20 C60 20 62 -20 44 -30" stroke="#111114" stroke-width="9" fill="none" stroke-linecap="round"/>`;
    return svg("", g(place(...at(-46, R - 30), 42, 1.3), tail + cat + paws) + g(place(...at(162, R - 14), -72, 1.15), cat + paws));
  },
};

const chains = {
  id: "chains",
  name: "Chains",
  frames: 1,
  draw: () => {
    let links = "";
    for (let i = 0; i < 17; i++) {
      const deg = 18 + i * 10;
      const [x, y] = at(deg, R + 4 + 10 * Math.sin((i / 16) * Math.PI));
      const vertical = i % 2;
      const [rx, ry] = vertical ? [8, 17] : [17, 9];
      links += g(place(x, y, deg + 90), `<ellipse rx="${rx}" ry="${ry}" fill="none" stroke="url(#sv)" stroke-width="7"/><ellipse rx="${rx}" ry="${ry}" fill="none" stroke="#4a4f5a" stroke-width="1.5" opacity="0.7"/>`);
    }
    const [px, py] = at(-30, R + 6);
    return svg(
      linear("sv", [[0, "#ffffff"], [0.5, "#aeb4c0"], [1, "#5d6370"]], 0, 0, 1, 1),
      links + g(place(px, py, 20, 1.2), `<rect x="-16" y="-10" width="32" height="28" rx="5" fill="url(#sv)" stroke="#4a4f5a" stroke-width="2"/><path d="M-9 -10 V-20 A9 9 0 0 1 9 -20 V-10" stroke="url(#sv)" stroke-width="5" fill="none"/><circle cy="2" r="4" fill="#4a4f5a"/>`),
    );
  },
};

const glitter = {
  id: "black-glitter",
  name: "Black glitter",
  frames: ANIM,
  draw: (t) => {
    const r = rng(53);
    let dots = "";
    for (let i = 0; i < 260; i++) {
      const [x, y] = at(r() * 360, R + 2 + r() * 26);
      const c = ["#0d0d10", "#1f1f26", "#3b3b46", "#8a8a99"][Math.floor(r() * 4)];
      dots += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(1.8 + r() * 2.8)}" fill="${c}"/>`;
    }
    return svg("", dots + twinkles(59, 8, t, (s) => sparkle(10 + s * 10, "#ffffff"), 4, 30));
  },
};

const clouds = {
  id: "clouds",
  name: "Clouds",
  frames: 1,
  draw: () => {
    const puff = (deg, dist, s) =>
      g(place(...at(deg, dist), 0, s), `<circle cx="-26" cy="6" r="22" fill="#ffffff"/><circle cx="0" cy="-8" r="28" fill="#ffffff"/><circle cx="28" cy="4" r="22" fill="#ffffff"/><rect x="-46" y="4" width="92" height="22" rx="11" fill="#ffffff"/><path d="M-44 22 H44" stroke="#dfe6f2" stroke-width="5" stroke-linecap="round"/>`);
    return svg(
      blur("b", 8),
      `<circle cx="${C}" cy="22" r="14" fill="#fff6c6" filter="url(#b)"/><circle cx="${C}" cy="22" r="9" fill="#ffffff"/>` + puff(60, R - 4, 1.0) + puff(118, R - 4, 0.95) + puff(90, R + 2, 0.85) + puff(-158, R - 2, 0.75),
    );
  },
};

function batShape(s, flap) {
  const k = s / 40;
  const y = -12 * k * flap;
  const p = (x, yy) => `${f(x * k)} ${f(yy * k)}`;
  return (
    `<path d="M${p(0, -6)} C${p(-6, -6)} ${p(-10, y / k)} ${p(-40, -8 + y / k)} C${p(-32, 2)} ${p(-26, 2)} ${p(-22, 8)} C${p(-16, 2)} ${p(-10, 4)} ${p(0, 10)} ` +
    `C${p(10, 4)} ${p(16, 2)} ${p(22, 8)} C${p(26, 2)} ${p(32, 2)} ${p(40, -8 + y / k)} C${p(10, y / k)} ${p(6, -6)} ${p(0, -6)}Z" fill="#111114"/>` +
    `<path d="M${p(-5, -6)} L${p(-3, -12)} L${p(0, -7)} L${p(3, -12)} L${p(5, -6)}" fill="#111114"/>`
  );
}

const bloodMoon = {
  id: "blood-moon",
  name: "Blood moon",
  frames: ANIM,
  draw: (t) => {
    let bats = "";
    for (const [deg, s, ph] of [[-120, 40, 0], [-70, 32, 0.3], [-162, 28, 0.6], [150, 30, 0.15]]) bats += g(place(...at(deg, R + 26)), batShape(s, wave(t * 2, ph)));
    const [mx, my] = at(-40, R + 12);
    return svg(
      radial("m", [[0, "#ff6a4d"], [0.7, "#b3121b"], [1, "#5c0408"]]) + blur("b", 10),
      `<circle cx="${f(mx)}" cy="${f(my)}" r="62" fill="#ff3b2f" filter="url(#b)" opacity="0.5"/><circle cx="${f(mx)}" cy="${f(my)}" r="48" fill="url(#m)"/>` + ring(R + 4, 4, "#7a0b14") + bats,
    );
  },
};

const cuteBow = {
  id: "cute-bow",
  name: "Cute bow",
  frames: 1,
  draw: () => svg("", g(place(...at(-42, R - 6), 24, 1.3), bow(100, "#ffb6cf", "#e2759e") + `<ellipse cx="-30" cy="-12" rx="8" ry="4" fill="#ffffff" opacity="0.6" transform="rotate(-20)"/>`)),
};

const ggBubble = {
  id: "gg",
  name: "GG",
  frames: 1,
  draw: () =>
    svg(
      "",
      g(place(...at(-38, R + 2)), `<path d="M-50 -34 H50 A16 16 0 0 1 66 -18 V14 A16 16 0 0 1 50 30 H-14 L-34 48 L-30 30 H-50 A16 16 0 0 1 -66 14 V-18 A16 16 0 0 1 -50 -34Z" fill="#ffffff" stroke="#1d1d24" stroke-width="5" stroke-linejoin="round"/><text x="0" y="12" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="40" fill="#1d1d24">gg</text>`),
    ),
};

const acid = {
  id: "acid",
  name: "Acid",
  frames: ANIM,
  draw: (t) => {
    const goo = (w, c, extra = "") =>
      `<path d="${radiusPath((a) => R + 12 + 9 * Math.sin((a * Math.PI * 9) / 180 + t * Math.PI * 2) * Math.sin((a * Math.PI * 4) / 180 - t * Math.PI * 2), 3)}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" ${extra}/>`;
    return svg(blur("b", 9), goo(26, "#7cff00", `filter="url(#b)" opacity="0.7"`) + goo(14, "#5bd400") + goo(5, "#d8ff8a") + twinkles(61, 6, t, (s) => sparkle(9 + s * 9, "#eaffc4"), 10, 34));
  },
};

/** A point on an ellipse of radii [rx], [ry] around the centre, turned by [rot] degrees, at fraction [p] of the way round. */
function onEllipse(rx, ry, rot, p) {
  const a = p * Math.PI * 2;
  const [x, y] = [rx * Math.cos(a), ry * Math.sin(a)];
  const r0 = (rot * Math.PI) / 180;
  return [C + x * Math.cos(r0) - y * Math.sin(r0), C + x * Math.sin(r0) + y * Math.cos(r0)];
}

const starOrbit = {
  id: "star-orbit",
  name: "Star orbit",
  frames: ANIM,
  draw: (t) => {
    const orbit = (c, w) => `<ellipse cx="${C}" cy="${C}" rx="${R + 26}" ry="${R + 2}" fill="none" stroke="${c}" stroke-width="${w}" transform="rotate(-20 ${C} ${C})"/>`;
    const colours = ["#fff2a8", "#ffc2e6", "#bdf3ff"];
    let starsOn = "";
    for (let i = 0; i < 3; i++) starsOn += g(place(...onEllipse(R + 26, R + 2, -20, t / 3 + i / 3), t * 360), star5(22, colours[i]));
    return svg(blur("b", 6), `<g filter="url(#b)">${orbit("#5ee7ff", 12)}</g>` + orbit("#bff6ff", 5) + starsOn);
  },
};

const circlet = {
  id: "circlet",
  name: "Circlet",
  frames: 1,
  draw: () => {
    let spikes = "";
    for (let i = 0; i < 16; i++) {
      const deg = i * 22.5;
      spikes += g(place(...at(deg, R + 4), deg), `<path d="M0 -10 L${i % 2 === 0 ? 32 : 20} 0 L0 10Z" fill="url(#sv)" stroke="#3d424d" stroke-width="2" stroke-linejoin="round"/>`);
    }
    return svg(linear("sv", [[0, "#ffffff"], [0.45, "#b9bfcc"], [1, "#565c69"]], 0, 0, 1, 1), spikes + ring(R + 4, 10, "url(#sv)") + ring(R + 4, 2, "#3d424d"));
  },
};

const blueRing = {
  id: "blue-ring",
  name: "Blue ring",
  frames: 1,
  draw: () => svg(blur("b", 6), ring(R + 10, 20, "#0e2a52") + ring(R + 10, 6, "#3e8bff", `filter="url(#b)"`) + ring(R + 10, 3, "#a9cfff") + ring(R + 19, 2, "#0a1a33")),
};

const money = {
  id: "money",
  name: "Money",
  frames: ANIM,
  draw: (t) => {
    const coin = `<circle r="17" fill="#f5c431" stroke="#9a6b00" stroke-width="3"/><text y="7" text-anchor="middle" font-family="DejaVu Sans, Arial" font-weight="bold" font-size="20" fill="#9a6b00">$</text>`;
    const bill = `<rect x="-28" y="-15" width="56" height="30" rx="3" fill="#7ccf7a" stroke="#2f7a32" stroke-width="2.5"/><circle r="9" fill="none" stroke="#2f7a32" stroke-width="2.5"/><text y="5" text-anchor="middle" font-family="DejaVu Sans, Arial" font-weight="bold" font-size="13" fill="#2f7a32">$</text>`;
    const r = rng(71);
    let out = "";
    for (let i = 0; i < 10; i++) {
      const deg = -170 + i * 36 + r() * 12;
      const [x, y] = at(deg, R + 18 + r() * 12);
      out += g(place(x, y + 6 * wave(t, r()), (r() - 0.5) * 50 + 14 * wave(t, r())), i % 2 ? coin : bill);
    }
    return svg("", out);
  },
};

const catEarsBlack = {
  id: "black-cat-ears",
  name: "Black cat ears",
  frames: 1,
  draw: () => {
    const ear = `<path d="M-48 10 L-6 -96 L48 10 Z" fill="#0f0f12" stroke-linejoin="round"/><path d="M-26 0 L-6 -58 L24 0 Z" fill="#f48fb8"/>`;
    const whiskers = (side) => `<g transform="translate(${side < 0 ? 56 : 456} 300) scale(${side} 1)"><path d="M0 0 L-46 -12 M0 10 L-48 10 M0 20 L-44 32" stroke="#f2f2f5" stroke-width="5" stroke-linecap="round"/></g>`;
    return svg("", g(`${place(...at(-128, R - 38), -34, 1.05)} scale(-1 1)`, ear) + g(place(...at(-52, R - 38), 34, 1.05), ear) + whiskers(-1) + whiskers(1));
  },
};

const crows = {
  id: "crows",
  name: "Crows",
  frames: ANIM,
  draw: (t) => {
    let out = "";
    for (let i = 0; i < 6; i++) {
      const deg = -200 + i * 40 + t * 40;
      out += g(place(...at(deg, R + 22 + (i % 2) * 10), deg + 270), bird(62 - (i % 3) * 8, wave(t * 2, i * 0.17), "#141418"));
    }
    return svg("", out);
  },
};

const haloWings = {
  id: "halo-wings",
  name: "Halo and wings",
  frames: ANIM,
  draw: (t) => {
    const y = 34 + 5 * wave(t);
    const e = (w, c, extra = "") => `<ellipse cx="${C}" cy="${f(y)}" rx="96" ry="18" fill="none" stroke="${c}" stroke-width="${w}" ${extra}/>`;
    const w = wing(6, 150, "#f6f8ff", "#b4c1db");
    return svg(blur("b", 7), g(place(...at(-158, R - 26), 10), w) + g(`${place(...at(-22, R - 26), -10)} scale(-1 1)`, w) + e(18, "#ffe27a", `filter="url(#b)" opacity="0.8"`) + e(10, "#ffd84a") + e(3, "#fffbe0"));
  },
};

const iceFairy = {
  id: "ice-fairy",
  name: "Ice fairy",
  frames: ANIM,
  draw: (t) => {
    let crystals = "";
    for (let i = 0; i < 11; i++) {
      const deg = -190 + i * 20;
      const l = 30 + 16 * Math.cos(((deg + 90) * Math.PI) / 180);
      crystals += g(place(...at(deg, R + 8), deg + 90), `<path d="M0 0 L-9 ${f(-l * 0.5)} L0 ${f(-l)} L9 ${f(-l * 0.5)}Z" fill="url(#ic)" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>`);
    }
    return svg(
      linear("ic", [[0, "#ffffff"], [1, "#7fd0ff"]]) + blur("b", 7),
      ring(R + 6, 16, "#a8e4ff", `filter="url(#b)" opacity="0.7"`) + crystals + g(place(C, 36, 0, 1.15), bow(100, "#8fd3ff", "#3f8ed6")) + twinkles(83, 8, t, (s) => snowflake(9 + s * 7, "#ffffff", 3), 18, 40),
    );
  },
};

const batWings = {
  id: "bat-wings",
  name: "Bat wings",
  frames: 1,
  draw: () => {
    const w = `<path d="M0 0 C-20 -40 -60 -70 -110 -70 C-96 -56 -92 -44 -96 -30 C-82 -38 -70 -36 -62 -24 C-52 -34 -40 -32 -32 -18 C-24 -26 -12 -22 0 0Z" fill="url(#bw)" stroke="#1d0f2b" stroke-width="3" stroke-linejoin="round"/><path d="M0 0 L-96 -64 M-12 -6 L-62 -26 M-6 -2 L-32 -20" stroke="#1d0f2b" stroke-width="2" opacity="0.7"/>`;
    return svg(linear("bw", [[0, "#7a4bb3"], [1, "#2e1747"]]), g(place(...at(-140, R - 44), 10, 1.0), w) + g(`${place(...at(-40, R - 44), -10, 1.0)} scale(-1 1)`, w));
  },
};

const staticRing = {
  id: "static",
  name: "Static",
  frames: 8,
  draw: (t) => {
    const r = rng(1000 + Math.round(t * 8));
    let px = "";
    for (let i = 0; i < 700; i++) {
      const [x, y] = at(r() * 360, R - 2 + r() * 34);
      const v = Math.round(60 + r() * 195);
      px += `<rect x="${f(x)}" y="${f(y)}" width="5" height="5" fill="rgb(${v},${v},${v})"/>`;
    }
    return svg("", px);
  },
};

const inferno = {
  id: "inferno",
  name: "Inferno",
  frames: ANIM,
  draw: (t) => {
    let body = "";
    for (let i = 0; i < 36; i++) {
      const deg = i * 10 + t * 30;
      const h = 32 + 12 * wave(t * 2, i * 0.29);
      body += g(place(...at(deg, R - 2), deg + 115), flame(h, 11, "url(#fo)") + flame(h * 0.55, 5.5, "url(#fi)"));
    }
    return svg(linear("fo", [[0, "#ffe066"], [0.5, "#ff6a00"], [1, "#c81d0b"]]) + linear("fi", [[0, "#fff7cf"], [1, "#ffb21a"]]) + blur("b", 10), ring(R + 6, 22, "#ff4d00", `filter="url(#b)" opacity="0.7"`) + body);
  },
};

const toast = {
  id: "toast",
  name: "Toast",
  frames: 1,
  draw: () => {
    const crust = `M70 500 L70 210 C20 200 10 120 50 80 C90 30 170 40 200 70 C230 20 330 10 380 50 C450 40 500 110 470 180 C460 200 450 206 442 210 L442 500 Z`;
    const r = R - 6;
    const hole = `M${C - r} ${C} A${r} ${r} 0 1 0 ${C + r} ${C} A${r} ${r} 0 1 0 ${C - r} ${C}Z`;
    return svg(linear("br", [[0, "#f6d39a"], [1, "#e2b06a"]]), `<path d="${crust} ${hole}" fill="url(#br)" fill-rule="evenodd" stroke="#a8682a" stroke-width="16" stroke-linejoin="round"/><path d="${hole}" fill="none" stroke="#c99257" stroke-width="5"/>`);
  },
};

const shootingStars = {
  id: "shooting-stars",
  name: "Shooting stars",
  frames: ANIM,
  draw: (t) => {
    let out = "";
    for (const [y0, ph, len] of [[60, 0, 100], [420, 0.4, 80], [140, 0.7, 70]]) {
      const p = (t + ph) % 1;
      const x = -80 + p * 680;
      const y = y0 + p * 60;
      if (!outside(x, y, 6)) continue;
      out += `<path d="M${f(x)} ${f(y)} L${f(x - len)} ${f(y - len * 0.09)}" stroke="url(#tail)" stroke-width="6" stroke-linecap="round"/>` + g(place(x, y), sparkle(13, "#ffffff"));
    }
    return svg(`<linearGradient id="tail" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/></linearGradient>`, out.replaceAll("url(#tail)", "#ffffff") + twinkles(91, 7, t, (s) => sparkle(8 + s * 7, "#fff6d0"), 14, 40));
  },
};

const moonlitOrb = {
  id: "moonlit-orb",
  name: "Moonlit orb",
  frames: ANIM,
  draw: (t) => {
    const orbit = (rot) => `<ellipse cx="${C}" cy="${C}" rx="${R + 30}" ry="${R + 4}" fill="none" stroke="#c8ccd8" stroke-width="3" opacity="0.8" transform="rotate(${rot} ${C} ${C})"/>`;
    const [mx, my] = onEllipse(R + 30, R + 4, -25, t);
    const [sx, sy] = onEllipse(R + 30, R + 4, 35, t + 0.5);
    return svg(blur("b", 5), orbit(-25) + orbit(35) + `<circle cx="${f(mx)}" cy="${f(my)}" r="18" fill="#fff8de" filter="url(#b)"/><circle cx="${f(mx)}" cy="${f(my)}" r="13" fill="#fffbea"/>` + g(place(sx, sy), sparkle(16, "#ffffff")));
  },
};

const doodleNotes = {
  id: "doodle-notes",
  name: "Doodle notes",
  frames: ANIM,
  draw: (t) => {
    const note = `<path d="M6 -26 V6" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/><ellipse cx="0" cy="8" rx="8" ry="6" fill="#ffffff" transform="rotate(-20 0 8)"/><path d="M6 -26 Q18 -20 16 -8" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    const twin = `<path d="M-8 -22 L12 -28 V2 M-8 -22 V6" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="-14" cy="8" rx="7" ry="5" fill="#ffffff"/><ellipse cx="6" cy="4" rx="7" ry="5" fill="#ffffff"/>`;
    let out = "";
    for (const [deg, k, ph, shape] of [[-56, 1.5, 0, note], [-34, 1.2, 0.3, twin], [-76, 1.1, 0.6, note], [150, 1.3, 0.2, twin]]) {
      const [x, y] = at(deg, R + 26);
      out += g(place(x, y + 6 * wave(t, ph), 8 * wave(t, ph + 0.25), k), shape);
    }
    return svg("", out + g(place(...at(-18, R + 30)), sparkle(12, "#ffffff")));
  },
};

const glitch = {
  id: "glitch",
  name: "Glitch",
  frames: 8,
  draw: (t) => {
    const r = rng(300 + Math.round(t * 8));
    const shift = () => (r() - 0.5) * 12;
    const ringAt = (dx, dy, c, w) => `<circle cx="${f(C + dx)}" cy="${f(C + dy)}" r="${R + 8}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
    let bars = "";
    for (let i = 0; i < 5; i++) {
      const y = r() * S;
      const x = r() < 0.5 ? 10 + r() * 60 : 440 + r() * 50;
      bars += `<rect x="${f(x)}" y="${f(y)}" width="${f(20 + r() * 40)}" height="${f(4 + r() * 6)}" fill="${["#ff2d6f", "#2de2ff", "#ffffff"][i % 3]}" opacity="0.9"/>`;
    }
    return svg("", ringAt(shift(), shift(), "#ff2d6f", 8) + ringAt(shift(), shift(), "#2de2ff", 8) + ringAt(0, 0, "#ffffff", 5) + bars);
  },
};

const censored = {
  id: "censored",
  name: "Censored",
  frames: 1,
  draw: () => svg("", g(place(...at(52, R - 18), -16), `<rect x="-120" y="-24" width="240" height="48" fill="#0b0b0d"/><text x="0" y="12" text-anchor="middle" font-family="DejaVu Sans, Arial" font-weight="bold" font-size="34" letter-spacing="4" fill="#ffffff">CENSORED</text>`)),
};

const lookHere = {
  id: "look-here",
  name: "Look here",
  frames: ANIM,
  draw: (t) =>
    svg("", ring(R + 6, 12, "#e5312b") + g(place(...at(-42, R + 30 + 6 * wave(t)), 138, 1.3), `<path d="M0 0 L22 -16 L22 -7 L54 -7 L54 7 L22 7 L22 16Z" fill="#e5312b" stroke="#8a0f0b" stroke-width="2.5" stroke-linejoin="round"/>`)),
};

const bubbles = {
  id: "bubbles",
  name: "Bubbles",
  frames: ANIM,
  draw: (t) => {
    const r = rng(101);
    let out = "";
    for (let i = 0; i < 18; i++) {
      const x0 = r() * S;
      const s = 10 + r() * 14;
      const y = S - ((t + r()) % 1) * (S + 40) + 20;
      const x = x0 + 10 * wave(t, r());
      if (!outside(x, y, s * 0.5)) continue;
      out += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s)}" fill="#bfe9ff" fill-opacity="0.18" stroke="#e6f7ff" stroke-width="3"/><path d="M${f(x - s * 0.5)} ${f(y - s * 0.2)} A${f(s * 0.6)} ${f(s * 0.6)} 0 0 1 ${f(x - s * 0.1)} ${f(y - s * 0.6)}" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    }
    return svg("", out);
  },
};

const autumn = {
  id: "autumn",
  name: "Autumn leaves",
  frames: ANIM,
  draw: (t) => {
    const colours = ["#e8662a", "#d33f1f", "#f2a33a", "#b5481c"];
    const maple = (c) => `<path d="M0 -16 L4 -6 L13 -9 L9 0 L15 4 L5 6 L6 14 L0 9 L-6 14 L-5 6 L-15 4 L-9 0 L-13 -9 L-4 -6Z" fill="${c}" stroke-linejoin="round"/><path d="M0 9 L0 20" stroke="${c}" stroke-width="2.5"/>`;
    return svg("", falling(113, 28, t, (x, y, s, i) => g(place(x, y, s * 360 + t * 240, 1.1 + s * 0.5), maple(colours[i % colours.length])), 0.7));
  },
};

const gamepad = {
  id: "gamepad",
  name: "Gamepad",
  frames: 1,
  draw: () => {
    const pad = `<path d="M-58 -24 C-74 -24 -84 -10 -86 8 C-88 30 -80 44 -66 44 C-54 44 -48 30 -36 24 H36 C48 30 54 44 66 44 C80 44 88 30 86 8 C84 -10 74 -24 58 -24Z" fill="#2c2f3a" stroke="#14151b" stroke-width="5" stroke-linejoin="round"/><path d="M-56 0 H-36 M-46 -10 V10" stroke="#e9eaf0" stroke-width="7" stroke-linecap="round"/><circle cx="40" cy="-4" r="6" fill="#ff7a5c"/><circle cx="54" cy="8" r="6" fill="#5ee7ff"/><circle cx="26" cy="8" r="6" fill="#ffd84a"/><circle cx="40" cy="20" r="6" fill="#7cff6a"/>`;
    return svg("", g(place(...at(48, R + 6), -18, 1.15), pad));
  },
};

const meldlingEars = {
  id: "meldling-ears",
  name: "Meldling ears",
  frames: 1,
  draw: () => {
    // Meldling's fluffy ears from the Meldiq logo (brand/meldling.png): cream with the logo's teal edge.
    const ear = `<path d="M-40 18 C-56 -22 -48 -66 -22 -78 C-2 -86 22 -64 34 -36 C44 -50 62 -54 70 -44 C78 -32 66 -6 44 18 Z" fill="#fdfcf9" stroke="#045349" stroke-width="7" stroke-linejoin="round"/>`;
    return svg("", g(`${place(...at(-128, R - 34), -24, 1.1)} scale(-1 1)`, ear) + g(place(...at(-52, R - 34), 24, 1.1), ear));
  },
};

const sunflower = {
  id: "sunflower",
  name: "Sunflower",
  frames: 1,
  draw: () => {
    let petals = "";
    for (let i = 0; i < 36; i++) {
      const deg = i * 10 + (i % 2) * 5;
      petals += g(place(...at(deg, R + 6 + (i % 2) * 6), deg), `<path d="M0 0 Q15 -9 28 0 Q15 9 0 0Z" fill="${i % 2 ? "#ffcc1f" : "#ffb300"}" stroke="#c77d00" stroke-width="1.5"/>`);
    }
    return svg("", petals + ring(R + 3, 12, "#6b3d14") + ring(R + 3, 4, "#3e2108", `stroke-dasharray="3 5"`));
  },
};

const vines = {
  id: "vines",
  name: "Vines",
  frames: 1,
  draw: () => {
    const radius = (a) => R + 10 + 6 * Math.sin((a * Math.PI * 5) / 180);
    let leaves = "";
    for (let i = 0; i < 22; i++) {
      const deg = i * 16.4;
      leaves += g(place(...at(deg, radius(deg)), deg + (i % 2 ? 50 : -50)), leaf(32, 13, i % 3 ? "#3fae4f" : "#62c95b") + `<path d="M0 0 L26 0" stroke="#1f6b2c" stroke-width="1.5"/>`);
    }
    return svg("", `<path d="${radiusPath(radius, 3)}" fill="none" stroke="#2c7d38" stroke-width="7"/>` + leaves);
  },
};

const roses = {
  id: "roses",
  name: "Roses",
  frames: 1,
  draw: () => {
    const rose = `<circle r="22" fill="#c8102e"/><path d="M-12 -6 A13 13 0 1 1 10 10 A8 8 0 1 1 -2 -2" fill="none" stroke="#7d0a1c" stroke-width="3.5" stroke-linecap="round"/><path d="M-20 4 A20 20 0 0 0 16 16" fill="none" stroke="#e8344f" stroke-width="3" stroke-linecap="round"/>`;
    const lf = (deg) => g(`rotate(${deg})`, leaf(36, 13, "#2f8a3a"));
    const cluster = (deg, k, rot) => g(place(...at(deg, R + 4), rot, k), lf(-150) + lf(-30) + lf(70) + rose);
    return svg("", cluster(140, 1.3, 10) + cluster(116, 1.05, -20) + cluster(162, 0.95, 30) + cluster(-40, 0.9, 0));
  },
};

const ocean = {
  id: "ocean",
  name: "Ocean",
  frames: ANIM,
  draw: (t) => {
    const wv = (shift, base, amp, c, w) => `<path d="${radiusPath((a) => R + base + amp * Math.sin((a * Math.PI * 10) / 180 + (t + shift) * Math.PI * 2), 2)}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round"/>`;
    return svg("", wv(0, 18, 6, "#1d6fd6", 13) + wv(0.5, 10, 5, "#4fb3ff", 10) + wv(0.25, 23, 4, "#e6f6ff", 4));
  },
};

const bunnyEars = {
  id: "bunny-ears",
  name: "Bunny ears",
  frames: 1,
  draw: () => {
    const ear = `<path d="M-24 10 C-34 -40 -26 -110 0 -126 C26 -110 34 -40 24 10 Z" fill="#fbfbfd" stroke="#cfd2dc" stroke-width="4"/><path d="M-11 -6 C-16 -40 -12 -92 0 -104 C12 -92 16 -40 11 -6 Z" fill="#ffb8cf"/>`;
    return svg("", g(place(...at(-112, R - 74), -18, 0.92), ear) + g(place(...at(-68, R - 74), 26, 0.92), ear));
  },
};

const confetti = {
  id: "confetti",
  name: "Confetti",
  frames: ANIM,
  draw: (t) => {
    const colours = ["#ff5c7a", "#ffd84a", "#5ee7ff", "#7cff6a", "#b38cff", "#ff9f43"];
    return svg(
      "",
      falling(127, 46, t, (x, y, s, i) => g(place(x, y, s * 360 + t * 400 * (i % 2 ? 1 : -1)), i % 3 ? `<rect x="-8" y="-4" width="16" height="8" fill="${colours[i % 6]}"/>` : `<circle r="6" fill="${colours[i % 6]}"/>`), 1.1),
    );
  },
};

const headset = {
  id: "headset",
  name: "Gamer headset",
  frames: 1,
  draw: () => {
    const cup = (x) => `<rect x="${x - 24}" y="206" width="48" height="104" rx="22" fill="#1b1d24" stroke="#0b0c10" stroke-width="4"/><rect x="${x - 8}" y="226" width="16" height="64" rx="8" fill="#ff2d55"/>`;
    return svg(
      blur("b", 5),
      `<path d="M38 262 C38 66 474 66 474 262" fill="none" stroke="#1b1d24" stroke-width="22" stroke-linecap="round"/><path d="M48 252 C54 86 458 86 464 252" fill="none" stroke="#ff2d55" stroke-width="5" stroke-linecap="round"/>` +
        cup(36) +
        cup(476) +
        `<path d="M52 300 C70 380 120 420 176 430" fill="none" stroke="#1b1d24" stroke-width="10" stroke-linecap="round"/><rect x="170" y="418" width="36" height="24" rx="11" fill="#1b1d24"/><circle cx="198" cy="430" r="6" fill="#ff2d55" filter="url(#b)"/>`,
    );
  },
};

const witchHat = {
  id: "witch-hat",
  name: "Witch hat",
  frames: 1,
  draw: () => {
    const hat = `<ellipse cx="0" cy="0" rx="112" ry="22" fill="#3a1f5c" stroke="#1d0f2b" stroke-width="4"/><path d="M-62 -6 C-50 -60 -20 -120 30 -150 C20 -120 22 -90 46 -60 L62 -6 Z" fill="#4b2876" stroke="#1d0f2b" stroke-width="4" stroke-linejoin="round"/><path d="M-58 -16 C-30 -8 30 -8 60 -16 L58 -30 C30 -22 -30 -22 -54 -30Z" fill="#ff9f1c"/><rect x="-10" y="-30" width="20" height="16" rx="3" fill="none" stroke="#ffd84a" stroke-width="4"/>`;
    return svg("", g(place(...at(-98, R - 104), -12, 0.86), hat));
  },
};

export const MORE = [
  starryNight,
  smoke,
  lace("white-lace", "White lace", "#fbfbfd", "#d9dbe3", "#c9ccd6"),
  lace("black-lace", "Black lace", "#121216", "#3a3a44", "#55555f"),
  thorns,
  blossom,
  blackCats,
  chains,
  glitter,
  clouds,
  bloodMoon,
  cuteBow,
  ggBubble,
  acid,
  starOrbit,
  circlet,
  blueRing,
  money,
  catEarsBlack,
  wingsDeco("angel-wings", "Pink angel wings", "#ffd6e7", "#f08cb0"),
  crows,
  haloWings,
  iceFairy,
  batWings,
  staticRing,
  inferno,
  toast,
  shootingStars,
  moonlitOrb,
  doodleNotes,
  glitch,
  censored,
  lookHere,
  bubbles,
  autumn,
  gamepad,
  meldlingEars,
  sunflower,
  vines,
  roses,
  ocean,
  bunnyEars,
  confetti,
  headset,
  witchHat,
  glowRing("mint-glow", "Mint glow", "#3ee6b0", "#c9fff0"),
];

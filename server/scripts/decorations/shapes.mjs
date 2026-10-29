/**
 * Drawing helpers for Meldiq's own profile decorations (docs/PROFILE_DECORATIONS.md). Every decoration is SVG on a
 * 512 × 512 canvas whose middle circle (radius R, 1/1.2 of the canvas, as the apps draw the avatar) holds the avatar;
 * the art sits around it and may overlap its edge. Angles are in degrees, 0 to the right and -90 at the top.
 */

export const S = 512;
export const C = 256;
export const R = 213;

export const rad = (d) => (d * Math.PI) / 180;
/** The point at [deg] and [dist] from the centre. */
export const at = (deg, dist) => [C + dist * Math.cos(rad(deg)), C + dist * Math.sin(rad(deg))];
export const f = (n) => Math.round(n * 100) / 100;
export const wave = (t, phase = 0) => Math.sin(2 * Math.PI * (t + phase));

/** A seeded random source (mulberry32), so every render of a decoration is the same. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs}</defs>${body}</svg>`;

export const blur = (id, sd) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
export const linear = (id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join("")}</linearGradient>`;
export const radial = (id, stops, r = 0.5) =>
  `<radialGradient id="${id}" cx="0.5" cy="0.5" r="${r}">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join("")}</radialGradient>`;

export const ring = (r, width, stroke, extra = "") => `<circle cx="${C}" cy="${C}" r="${f(r)}" fill="none" stroke="${stroke}" stroke-width="${f(width)}" ${extra}/>`;
export const g = (transform, body, extra = "") => `<g transform="${transform}" ${extra}>${body}</g>`;
export const place = (x, y, rot = 0, scale = 1) => `translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${f(scale)})`;

/** A four-pointed sparkle of radius [r] at the origin. */
export const sparkle = (r, fill) => {
  const k = r * 0.22;
  return `<path d="M0 ${-r} Q${k} ${-k} ${r} 0 Q${k} ${k} 0 ${r} Q${-k} ${k} ${-r} 0 Q${-k} ${-k} 0 ${-r}Z" fill="${fill}"/>`;
};
/** A five-pointed star of outer radius [r] at the origin. */
export const star5 = (r, fill, inner = 0.45) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const d = i % 2 ? r * inner : r;
    const a = rad(-90 + i * 36);
    pts.push(`${f(d * Math.cos(a))},${f(d * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="${fill}" stroke-linejoin="round"/>`;
};
/** A heart [s] wide, centred on the origin. */
export const heart = (s, fill) => {
  const k = s / 2;
  return `<path d="M0 ${f(k * 0.9)} C${f(-k * 1.6)} ${f(-k * 0.1)} ${f(-k * 0.6)} ${f(-k * 1.2)} 0 ${f(-k * 0.35)} C${f(k * 0.6)} ${f(-k * 1.2)} ${f(k * 1.6)} ${f(-k * 0.1)} 0 ${f(k * 0.9)}Z" fill="${fill}"/>`;
};
/** A six-armed snowflake of radius [r]. */
export const snowflake = (r, stroke, width = 2) => {
  let d = "";
  for (let i = 0; i < 6; i++) {
    const a = rad(i * 60);
    const [x, y] = [r * Math.cos(a), r * Math.sin(a)];
    d += `M0 0L${f(x)} ${f(y)}`;
    for (const side of [-1, 1]) {
      const b = a + side * rad(40);
      const [mx, my] = [x * 0.6, y * 0.6];
      d += `M${f(mx)} ${f(my)}L${f(mx + r * 0.3 * Math.cos(b))} ${f(my + r * 0.3 * Math.sin(b))}`;
    }
  }
  return `<path d="${d}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`;
};
/** A lightning bolt [s] tall, pointing down. */
export const bolt = (s, fill) => {
  const k = s / 10;
  return `<path d="M${f(1 * k)} ${f(-5 * k)} L${f(-3 * k)} ${f(1 * k)} L${f(-0.2 * k)} ${f(1 * k)} L${f(-1.5 * k)} ${f(5 * k)} L${f(3.2 * k)} ${f(-1.2 * k)} L${f(0.4 * k)} ${f(-1.2 * k)} L${f(2 * k)} ${f(-5 * k)}Z" fill="${fill}" stroke-linejoin="round"/>`;
};
/** A flame [h] tall and [w] wide, its base on the origin and its tip up (-y). */
export const flame = (h, w, fill) =>
  `<path d="M${f(-w)} 0 C${f(-w)} ${f(-h * 0.45)} ${f(-w * 0.15)} ${f(-h * 0.6)} 0 ${f(-h)} C${f(w * 0.45)} ${f(-h * 0.55)} ${f(w)} ${f(-h * 0.4)} ${f(w)} 0 Q0 ${f(h * 0.12)} ${f(-w)} 0Z" fill="${fill}"/>`;
/** A leaf [l] long, along +x from the origin. */
export const leaf = (l, w, fill) => `<path d="M0 0 Q${f(l * 0.5)} ${f(-w)} ${f(l)} 0 Q${f(l * 0.5)} ${f(w)} 0 0Z" fill="${fill}"/>`;
/** A wing of [n] feathers fanning from the origin towards -x (mirror with scale(-1 1)). */
export function wing(n, len, fill, edge) {
  let out = "";
  for (let i = 0; i < n; i++) {
    const a = -150 + (i * 70) / Math.max(1, n - 1);
    const l = len * (1 - i * 0.12);
    out += `<g transform="rotate(${f(a)})"><path d="M0 0 Q${f(l * 0.5)} ${f(-l * 0.16)} ${f(l)} 0 Q${f(l * 0.5)} ${f(l * 0.16)} 0 0Z" fill="${fill}" stroke="${edge}" stroke-width="2"/></g>`;
  }
  return out;
}
/** A bow: two loops, tails and a knot, about [s] wide. */
export function bow(s, fill, shade) {
  const k = s / 100;
  return (
    `<path d="M0 0 L${f(-30 * k)} ${f(42 * k)} L${f(-14 * k)} ${f(40 * k)} L${f(-6 * k)} ${f(52 * k)} Z" fill="${shade}"/>` +
    `<path d="M0 0 L${f(30 * k)} ${f(42 * k)} L${f(14 * k)} ${f(40 * k)} L${f(6 * k)} ${f(52 * k)} Z" fill="${shade}"/>` +
    `<path d="M0 0 C${f(-20 * k)} ${f(-34 * k)} ${f(-56 * k)} ${f(-26 * k)} ${f(-50 * k)} ${f(-2 * k)} C${f(-46 * k)} ${f(18 * k)} ${f(-18 * k)} ${f(14 * k)} 0 0Z" fill="${fill}" stroke="${shade}" stroke-width="${f(3 * k)}"/>` +
    `<path d="M0 0 C${f(20 * k)} ${f(-34 * k)} ${f(56 * k)} ${f(-26 * k)} ${f(50 * k)} ${f(-2 * k)} C${f(46 * k)} ${f(18 * k)} ${f(18 * k)} ${f(14 * k)} 0 0Z" fill="${fill}" stroke="${shade}" stroke-width="${f(3 * k)}"/>` +
    `<ellipse cx="0" cy="0" rx="${f(11 * k)}" ry="${f(13 * k)}" fill="${shade}"/>`
  );
}
/** A closed path around the centre whose radius is [r(deg)]. */
export function radiusPath(r, step = 2) {
  let d = "";
  for (let a = 0; a <= 360; a += step) {
    const [x, y] = at(a, r(a));
    d += `${a ? "L" : "M"}${f(x)} ${f(y)}`;
  }
  return `${d}Z`;
}
/** An arc of the circle of radius [r] from [a0] to [a1] degrees (clockwise). */
export function arc(r, a0, a1) {
  const [x0, y0] = at(a0, r);
  const [x1, y1] = at(a1, r);
  return `M${f(x0)} ${f(y0)} A${f(r)} ${f(r)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
}
/** A ring drawn as [n] arcs coloured by [colour(i)], for gradients round the circle (SVG has no conic gradient). */
export function segmentedRing(r, width, n, colour, extra = "") {
  let out = "";
  for (let i = 0; i < n; i++) out += `<path d="${arc(r, (i * 360) / n - 0.6, ((i + 1) * 360) / n + 0.6)}" stroke="${colour(i)}" stroke-width="${width}" fill="none" ${extra}/>`;
  return out;
}
/** Whether a point is clear of the avatar's circle by [margin]. */
export const outside = (x, y, margin = 0) => Math.hypot(x - C, y - C) > R + margin;
/** A bird in flight, [s] wide, wings at [flap] (-1 up to 1 down). */
export const bird = (s, flap, fill) => {
  const k = s / 2;
  const y = f(-k * 0.55 * (1 - flap));
  return `<path d="M${f(-k)} ${y} Q${f(-k * 0.45)} ${f(-k * 0.2)} 0 ${f(k * 0.12)} Q${f(k * 0.45)} ${f(-k * 0.2)} ${f(k)} ${y} Q${f(k * 0.4)} ${f(k * 0.05)} 0 ${f(k * 0.35)} Q${f(-k * 0.4)} ${f(k * 0.05)} ${f(-k)} ${y}Z" fill="${fill}"/>`;
};

import { SaxesParser } from "saxes";
import sharp from "sharp";
import { badRequest } from "../../../shared/errors.js";

const fail = () =>
  badRequest(
    "Unsupported or unsafe vector. Use a self-contained SVG or 2D shape-only Lottie (no scripts, images, text, effects or external resources).",
  );
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const tags = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "title",
  "desc",
]);
const attrs = new Set([
  "id",
  "xmlns",
  "width",
  "height",
  "viewBox",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "fill-rule",
  "clip-rule",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "transform",
  "gradientTransform",
  "gradientUnits",
  "offset",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "clipPathUnits",
  "preserveAspectRatio",
]);
/** Parse and rebuild an SVG from a closed vocabulary before passing it to a rasterizer. No network/file references. */
export function safeSvg(input: Buffer): Buffer {
  if (input.length > 512 * 1024) throw fail();
  const parser = new SaxesParser({ xmlns: true });
  let out = "",
    depth = 0,
    count = 0,
    root = false;
  parser.on("error", () => {
    throw fail();
  });
  parser.on("doctype", () => {
    throw fail();
  });
  parser.on("processinginstruction", () => {
    throw fail();
  });
  parser.on("cdata", () => {
    throw fail();
  });
  parser.on("opentag", (tag) => {
    if (
      ++count > 2048 ||
      ++depth > 24 ||
      !tags.has(tag.local) ||
      tag.prefix ||
      (tag.uri && tag.uri !== "http://www.w3.org/2000/svg")
    )
      throw fail();
    if (!root) {
      if (tag.local !== "svg") throw fail();
      root = true;
    }
    const parts: string[] = [];
    for (const attr of Object.values(tag.attributes)) {
      const key = attr.name,
        value = attr.value;
      if (key === "xmlns") {
        if (value !== "http://www.w3.org/2000/svg") throw fail();
        continue;
      }
      if (
        !attrs.has(key) ||
        value.length > 32000 ||
        /[<>"'\\]|(?:javascript|data|file|https?|ftp):/i.test(value)
      )
        throw fail();
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z][\w-]*\)$/.test(value))
        throw fail();
      if (!/^[A-Za-z0-9#.,%+()\s_:\/-]*$/.test(value)) throw fail();
      parts.push(`${key}="${escape(value)}"`);
    }
    if (depth === 1) parts.push('xmlns="http://www.w3.org/2000/svg"');
    out += `<${tag.local}${parts.length ? " " + parts.join(" ") : ""}>`;
  });
  parser.on("closetag", (tag) => {
    out += `</${tag.local}>`;
    depth--;
  });
  parser.on("text", (text) => {
    if (text.trim()) out += escape(text);
  });
  try {
    parser.write(input.toString("utf8")).close();
  } catch {
    throw fail();
  }
  if (!root || depth !== 0) throw fail();
  return Buffer.from(out);
}

type Obj = Record<string, any>; // JSON is structurally validated below; no values are evaluated as code.
const number = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e6)
    throw fail();
  return v;
};
const pair = (v: unknown): number[] => {
  if (!Array.isArray(v) || v.length < 2 || v.length > 4) throw fail();
  return v.map(number);
};
function inspect(v: unknown, depth = 0, counter = { n: 0 }): void {
  if (++counter.n > 12000 || depth > 24) throw fail();
  if (Array.isArray(v)) {
    for (const x of v) inspect(x, depth + 1, counter);
  } else if (v && typeof v === "object")
    for (const [key, x] of Object.entries(v)) {
      if (
        [
          "__proto__",
          "constructor",
          "prototype",
          "refId",
          "ti",
          "to",
          "masksProperties",
          "ef",
          "tm",
          "chars",
          "fonts",
        ].includes(key)
      )
        throw fail();
      if (key === "x" && typeof x === "string") throw fail();
      inspect(x, depth + 1, counter);
    }
  else if (typeof v === "string" && v.length > 32000) throw fail();
  else if (typeof v === "number") number(v);
}
function easing(a: Obj, b: Obj, progress: number, dimension: number): number {
  if (!a.o || !a.i) return progress;
  const component = (p: Obj, key: string) =>
    number(Array.isArray(p[key]) ? (p[key][dimension] ?? p[key][0]) : p[key]);
  const x1 = component(a.o, "x"),
    y1 = component(a.o, "y"),
    x2 = component(a.i, "x"),
    y2 = component(a.i, "y");
  if (
    x1 < 0 ||
    x1 > 1 ||
    x2 < 0 ||
    x2 > 1 ||
    Math.abs(y1) > 100 ||
    Math.abs(y2) > 100
  )
    throw fail();
  const cubic = (t: number, p: number, q: number) =>
    3 * (1 - t) ** 2 * t * p + 3 * (1 - t) * t * t * q + t ** 3;
  let low = 0,
    high = 1;
  for (let n = 0; n < 20; n++) {
    const mid = (low + high) / 2;
    if (cubic(mid, x1, x2) < progress) low = mid;
    else high = mid;
  }
  return cubic((low + high) / 2, y1, y2);
}
function property(p: any, t: number, fallback: any): any {
  if (p == null) return fallback;
  if (typeof p !== "object" || !Object.hasOwn(p, "k")) throw fail();
  if (!p.a) return p.k;
  const keys = p.k;
  if (!Array.isArray(keys) || !keys.length || keys.length > 120) throw fail();
  let a = keys[0],
    b = keys[0];
  for (const k of keys) {
    if (number(k.t) <= t) a = k;
    else {
      b = k;
      break;
    }
    b = k;
  }
  const start = a.s ?? a.e,
    end = a.e ?? b.s ?? start;
  const mix =
    a.h === 1 || b.t <= a.t
      ? 0
      : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  if (
    Array.isArray(start) &&
    start.every((x) => typeof x === "number") &&
    Array.isArray(end)
  )
    return start.map(
      (x, i) =>
        number(x) +
        (number(end[i] ?? x) - x) * (mix === 0 ? 0 : easing(a, b, mix, i)),
    );
  throw fail();
}
const scalar = (p: any, t: number, fallback: number) => {
  const v = property(p, t, fallback);
  return number(Array.isArray(v) ? v[0] : v);
};
function transform(tr: Obj | undefined, t: number): string {
  if (!tr) return "";
  const p = pair(property(tr.p, t, [0, 0])),
    a = pair(property(tr.a, t, [0, 0])),
    s = pair(property(tr.s, t, [100, 100]));
  if (tr.sk || tr.sa || tr.rx || tr.ry || tr.or) throw fail();
  return `transform="translate(${p[0]} ${p[1]}) rotate(${scalar(tr.r, t, 0)}) scale(${s[0] / 100} ${s[1] / 100}) translate(${-a[0]} ${-a[1]})" opacity="${Math.max(0, Math.min(1, scalar(tr.o, t, 100) / 100))}"`;
}
function color(p: any, t: number): string {
  const c = property(p, t, [0, 0, 0, 1]);
  if (!Array.isArray(c) || c.length < 3) throw fail();
  return `rgb(${c
    .slice(0, 3)
    .map((n: number) => Math.round(Math.max(0, Math.min(1, number(n))) * 255))
    .join(",")})`;
}
function group(shapes: Obj[], t: number, budget: { n: number }): string {
  if (!Array.isArray(shapes) || shapes.length > 256) throw fail();
  let fill = "none",
    stroke = "none",
    width = 0,
    fo = 1,
    so = 1,
    tr: Obj | undefined;
  let fills = 0,
    strokes = 0;
  for (const s of shapes) {
    if (s.ty === "fl") {
      if (++fills > 1) throw fail();
      fill = color(s.c, t);
      fo = scalar(s.o, t, 100) / 100;
    }
    if (s.ty === "st") {
      if (++strokes > 1) throw fail();
      stroke = color(s.c, t);
      width = scalar(s.w, t, 1);
      so = scalar(s.o, t, 100) / 100;
    }
    if (s.ty === "tr") tr = s;
  }
  let body = "";
  for (const s of shapes) {
    if (++budget.n > 512) throw fail();
    if (s.hd) continue;
    switch (s.ty) {
      case "gr":
        body += group(s.it, t, budget);
        break;
      case "el": {
        const p = pair(property(s.p, t, [0, 0])),
          z = pair(property(s.s, t, [0, 0]));
        body += `<ellipse cx="${p[0]}" cy="${p[1]}" rx="${Math.abs(z[0] / 2)}" ry="${Math.abs(z[1] / 2)}"/>`;
        break;
      }
      case "rc": {
        const p = pair(property(s.p, t, [0, 0])),
          z = pair(property(s.s, t, [0, 0]));
        body += `<rect x="${p[0] - z[0] / 2}" y="${p[1] - z[1] / 2}" width="${Math.abs(z[0])}" height="${Math.abs(z[1])}" rx="${Math.max(0, scalar(s.r, t, 0))}"/>`;
        break;
      }
      case "sh": {
        if (s.ks?.a) throw fail();
        const p = property(s.ks, t, null);
        if (
          !p ||
          !Array.isArray(p.v) ||
          p.v.length > 128 ||
          p.v.length < 2 ||
          !Array.isArray(p.i) ||
          !Array.isArray(p.o)
        )
          throw fail();
        const v = p.v.map(pair),
          i = p.i.map(pair),
          o = p.o.map(pair);
        if (v.length !== i.length || v.length !== o.length) throw fail();
        let d = `M${v[0][0]},${v[0][1]}`;
        for (let k = 1; k <= (p.c ? v.length : v.length - 1); k++) {
          const a = (k - 1) % v.length,
            b = k % v.length;
          d += ` C${v[a][0] + o[a][0]},${v[a][1] + o[a][1]} ${v[b][0] + i[b][0]},${v[b][1] + i[b][1]} ${v[b][0]},${v[b][1]}`;
        }
        body += `<path d="${d}${p.c ? " Z" : ""}"/>`;
        break;
      }
      case "fl":
      case "st":
      case "tr":
        break;
      default:
        throw fail();
    }
  }
  return `<g ${transform(tr, t)} fill="${fill}" fill-opacity="${fo}" stroke="${stroke}" stroke-opacity="${so}" stroke-width="${Math.max(0, width)}">${body}</g>`;
}
/** A bounded, self-contained 2D Lottie subset, rasterized once for all platforms. Unsupported constructs fail closed. */
export async function lottieWebp(input: Buffer): Promise<Buffer> {
  if (input.length > 512 * 1024) throw fail();
  let doc: Obj;
  try {
    doc = JSON.parse(input.toString("utf8"));
    inspect(doc);
  } catch {
    throw fail();
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw fail();
  const w = number(doc.w),
    h = number(doc.h),
    fr = number(doc.fr),
    ip = number(doc.ip),
    op = number(doc.op);
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 32 ||
    h < 32 ||
    w > 1024 ||
    h > 1024 ||
    fr <= 0 ||
    fr > 120 ||
    op <= ip ||
    (op - ip) / fr > 5 ||
    doc.ddd ||
    !Array.isArray(doc.layers) ||
    doc.layers.length > 32 ||
    (doc.assets?.length ?? 0)
  )
    throw fail();
  const fps = Math.min(20, fr),
    frames = Math.max(1, Math.ceil(((op - ip) / fr) * fps));
  if (w * h * frames > 32_000_000) throw fail();
  const buffers: Buffer[] = [];
  for (let f = 0; f < frames; f++) {
    const t = ip + (f * fr) / fps;
    let body = "";
    const budget = { n: 0 };
    for (const layer of [...doc.layers].reverse()) {
      if (
        layer.ddd ||
        layer.parent != null ||
        (layer.bm ?? 0) !== 0 ||
        (layer.sr ?? 1) !== 1 ||
        (layer.st ?? 0) !== 0 ||
        (layer.ty !== 4 && layer.ty !== 3)
      )
        throw fail();
      if (
        layer.ty === 3 ||
        t < (layer.ip ?? ip) ||
        t >= (layer.op ?? op) ||
        layer.hd
      )
        continue;
      body += `<g ${transform(layer.ks, t)}>${group(layer.shapes, t, budget)}</g>`;
    }
    buffers.push(
      await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`,
        ),
        { limitInputPixels: 32_000_000 },
      )
        .ensureAlpha()
        .raw()
        .toBuffer(),
    );
  }
  return sharp(Buffer.concat(buffers), {
    raw: { width: w, height: h * frames, channels: 4, pageHeight: h },
  })
    .webp({ quality: 85, delay: Math.round(1000 / fps), loop: 0 })
    .toBuffer();
}

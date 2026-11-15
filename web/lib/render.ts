// Browser-side image maths: normalisation, stretch, rainbow composite, difference map.
import type { Img } from "./types";

export type Stretch = "asinh" | "linear" | "log";
export type Norm = { w: number; h: number; data: Float32Array; sigma?: number };

const finiteSample = (a: Float32Array, maxN = 20000) => {
  const step = Math.max(1, Math.floor(a.length / maxN));
  const out: number[] = [];
  for (let i = 0; i < a.length; i += step) if (Number.isFinite(a[i])) out.push(a[i]);
  return Float32Array.from(out).sort();
};
const pct = (sorted: Float32Array, p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))] : 0);

/**
 * Saturated star cores arrive as NaN (the detector overflowed there), which would draw as a black
 * hole in the middle of the brightest star. Fill any NaN region that is mostly ringed by very
 * bright pixels with the brightest value in the image, so it draws as white (saturated) instead.
 * NaN regions that are simply "no data" (edges, masked defects) are left alone.
 */
export function fillSaturated(data: Float32Array, w: number, h: number, bright: number): number {
  const seen = new Uint8Array(data.length);
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i]) && data[i] > max) max = data[i];
  if (!Number.isFinite(max) || max < bright) return 0;
  let filled = 0;
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (seen[start] || Number.isFinite(data[start])) continue;
    const comp: number[] = [];
    let border = 0, hot = 0, edge = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge++;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (Number.isFinite(data[j])) { border++; if (data[j] >= bright) hot++; }
        else if (!seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (border > 0 && hot / border >= 0.5 && edge < comp.length * 0.25) {
      for (const i of comp) data[i] = max;
      filled += comp.length;
    }
  }
  return filled;
}

/** Subtract median background and divide by robust sigma so epochs are comparable. NaN preserved. */
export function normalise(img: Img): Norm {
  const s = finiteSample(img.data);
  const med = pct(s, 50);
  const dev = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) dev[i] = Math.abs(s[i] - med);
  dev.sort();
  const sigma = Math.max(1e-6, 1.4826 * pct(dev, 50));
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = (img.data[i] - med) / sigma;
  fillSaturated(out, img.w, img.h, 25);
  return { w: img.w, h: img.h, data: out, sigma };
}

export type Levels = { lo: number; hi: number };
/**
 * Display range from percentiles, in units of the image's own noise (sigma).
 * `minLo` keeps the black point above the noise (used by the rainbow trail so noise does not turn
 * into coloured speckle); the white point is never less than MIN_SPAN sigma above black, so a field
 * that is pure noise stays dark instead of being stretched to white.
 */
const MIN_SPAN = 40;
export function levels(n: Norm, bp: number, wp: number, minLo = -Infinity): Levels {
  const s = finiteSample(n.data);
  const lo = Math.max(pct(s, bp), minLo);
  const hi = Math.max(pct(s, wp), lo + MIN_SPAN);
  return { lo, hi };
}

/**
 * One display range shared by every date from the same survey, in real brightness units, so a star
 * that got brighter looks brighter. (Scaling each date on its own would hide exactly that.)
 * Returns per-image levels in each image's own noise units, or null where the image is not loaded.
 */
export function sharedLevels(norms: (Norm | null)[], groups: string[], bp: number, wp: number): (Levels | null)[] {
  const out: (Levels | null)[] = norms.map(() => null);
  const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
  for (const g of new Set(groups)) {
    const idx = norms.map((n, i) => (n && groups[i] === g ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const sig = idx.map((i) => norms[i]!.sigma ?? 1);
    const samples = idx.map((i) => finiteSample(norms[i]!.data));
    const lo = med(samples.map((s, k) => pct(s, bp) * sig[k]));
    const hi = Math.max(Math.max(...samples.map((s, k) => pct(s, wp) * sig[k])), lo + MIN_SPAN * med(sig));
    idx.forEach((i, k) => { out[i] = { lo: lo / sig[k], hi: hi / sig[k] }; });
  }
  return out;
}

export function stretchFn(kind: Stretch): (t: number) => number {
  if (kind === "linear") return (t) => t;
  if (kind === "log") return (t) => Math.log10(1 + 999 * t) / 3;
  const k = 30, d = Math.asinh(k); // strong lift for faint stars next to a very bright one
  return (t) => Math.asinh(k * t) / d;
}

function lut(kind: Stretch): Float32Array {
  const f = stretchFn(kind), L = new Float32Array(1025);
  for (let i = 0; i <= 1024; i++) L[i] = f(i / 1024);
  return L;
}
/** Stretched 0..1 values; NaN -> 0 */
export function stretched(n: Norm, lv: Levels, kind: Stretch): Float32Array {
  const L = lut(kind), out = new Float32Array(n.data.length), r = 1 / (lv.hi - lv.lo);
  for (let i = 0; i < out.length; i++) {
    const v = n.data[i];
    if (!Number.isFinite(v)) { out[i] = 0; continue; }
    const t = (v - lv.lo) * r;
    out[i] = t <= 0 ? 0 : t >= 1 ? 1 : L[(t * 1024) | 0];
  }
  return out;
}

export function toGray(n: Norm, lv: Levels, kind: Stretch, invert = false): ImageData {
  const s = stretched(n, lv, kind);
  const id = new ImageData(n.w, n.h);
  for (let i = 0; i < s.length; i++) {
    const g = invert ? 255 - Math.round(s[i] * 255) : Math.round(s[i] * 255);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = g;
    id.data[i * 4 + 3] = 255;
  }
  return id;
}

// Colour-blind-safe sequential ramp: blue (earliest) -> pale neutral -> vermilion (latest). Blue/orange axis survives deuteranopia & protanopia.
const STOPS: [number, number, number][] = [[0.0, 0.45, 1.0], [0.96, 0.92, 0.75], [1.0, 0.3, 0.05]];
export function rampColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x)), f = x - i;
  return [0, 1, 2].map((c) => STOPS[i][c] * (1 - f) + STOPS[i + 1][c] * f) as [number, number, number];
}

/** Rainbow trail. Each epoch is stretched, then tinted by its position in time. Stationary -> white, movers -> coloured streak. */
export function rainbow(epochs: { n: Norm; lv: Levels }[], kind: Stretch): ImageData | null {
  const N = epochs.length;
  if (!N) return null;
  const { w, h } = epochs[0].n;
  const S = epochs.map((e) => stretched(e.n, e.lv, kind));
  const cols = epochs.map((_, i) => rampColor(N === 1 ? 0.5 : i / (N - 1)));
  const mean = [0, 1, 2].map((c) => cols.reduce((a, x) => a + x[c], 0) / N);
  const cn = cols.map((c) => [c[0] / mean[0], c[1] / mean[1], c[2] / mean[2]]); // average colour = white
  const id = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    let sum = 0, mx = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < N; i++) {
      const s = S[i][p];
      if (s <= 0) continue;
      sum += s; if (s > mx) mx = s;
      r += s * cn[i][0]; g += s * cn[i][1]; b += s * cn[i][2];
    }
    if (sum > 0) { r = (r / sum) * mx; g = (g / sum) * mx; b = (b / sum) * mx; }
    id.data[p * 4] = Math.min(255, r * 255); id.data[p * 4 + 1] = Math.min(255, g * 255); id.data[p * 4 + 2] = Math.min(255, b * 255);
    id.data[p * 4 + 3] = 255;
  }
  return id;
}

/**
 * Mean of several dates. Each is first put back into common brightness units (data * sigma); the result
 * is expressed in the noise units of `ref`, so display levels worked out for `ref` apply to it unchanged.
 */
export function combine(list: Norm[], ref: Norm): Norm {
  if (list.length === 1 && list[0] === ref) return ref;
  const rs = ref.sigma ?? 1, n = ref.data.length;
  const out = new Float32Array(n);
  const sig = list.map((m) => m.sigma ?? 1);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = 0; k < list.length; k++) { const v = list[k].data[i]; if (Number.isFinite(v)) { s += v * sig[k]; c++; } }
    out[i] = c ? s / c / rs : NaN;
  }
  return { w: ref.w, h: ref.h, data: out, sigma: rs };
}

/** A difference picture before colouring: values in noise units, and the value that maps to full colour. */
export type DiffField = { w: number; h: number; data: Float32Array; scale: number; floor: number };

/**
 * Remove slowly varying background mismatch (zodiacal gradients) in place. Returns the value that maps
 * to full colour, and a floor below which a pixel is plain noise and stays uncoloured.
 */
function settle(d: Float32Array, w: number, h: number): { scale: number; floor: number } {
  const n = d.length, step = Math.max(1, Math.floor(n / 20000));
  const bgv = boxBlur(d, w, h, Math.max(8, Math.round(w / 10)));
  const abs: number[] = [];
  for (let i = 0; i < n; i++) { d[i] -= bgv[i]; if (i % step === 0 && Number.isFinite(d[i])) abs.push(Math.abs(d[i])); }
  const sorted = Float32Array.from(abs).sort();
  const noise = Math.max(1e-6, 1.4826 * pct(sorted, 50)); // robust scatter of the difference itself
  // full colour at the 99.9th percentile of |difference|, never below 8 times the noise; nothing under 2.5 times the noise is coloured
  return { scale: Math.max(8 * noise, pct(sorted, 99.9)), floor: 2.5 * noise };
}

/** Negative -> blue, positive -> orange, zero -> black (or white when inverted). NaN -> background. */
export function paintDiff(f: DiffField, scale = f.scale, invert = false): ImageData {
  const id = new ImageData(f.w, f.h), k = Math.asinh(6);
  for (let i = 0; i < f.data.length; i++) {
    const v = f.data[i];
    let r = 0, g = 0, bl = 0;
    if (Number.isFinite(v)) {
      const s = Math.asinh(6 * Math.min(1, Math.max(0, (Math.abs(v) - f.floor) / Math.max(1e-6, scale - f.floor)))) / k;
      if (v > 0) { r = 255 * s; g = 150 * s; bl = 0; }          // orange  (#FF9600)
      else { r = 0; g = 130 * s; bl = 255 * s; }                 // blue    (#0082FF)
      if (invert) { r += 255 * (1 - s); g += 255 * (1 - s); bl += 255 * (1 - s); }
    } else if (invert) r = g = bl = 255;
    id.data[i * 4] = r; id.data[i * 4 + 1] = g; id.data[i * 4 + 2] = bl; id.data[i * 4 + 3] = 255;
  }
  return id;
}

/** B minus A on normalised (sigma) data. Negative -> blue, positive -> orange, zero -> black. NaN -> black. */
export function difference(a: Norm, b: Norm, gain: number, invert = false): ImageData {
  const n = a.data.length;
  const d = new Float32Array(n);
  // undo per-epoch sigma scaling so equal-brightness stars cancel; express result in mean sigma
  const sa = a.sigma ?? 1, sb = b.sigma ?? 1, sm = (sa + sb) / 2;
  for (let i = 0; i < n; i++) d[i] = (b.data[i] * sb - a.data[i] * sa) / sm;
  const lv = settle(d, a.w, a.h), scale = Math.max(lv.floor * 1.5, lv.scale / Math.max(0.2, gain));
  return paintDiff({ w: a.w, h: a.h, data: d, scale, floor: lv.floor }, scale, invert);
}

/**
 * One date minus the per-pixel median of the other dates (WiseView's "each date minus the rest").
 * Everything that sits still at constant brightness is in the median and cancels; what moved or
 * changed is left. Works in common brightness units; the result is in units of the target's noise.
 */
export function minusRest(target: Norm, rest: Norm[]): DiffField | null {
  if (!rest.length) return null;
  const n = target.data.length, ts = target.sigma ?? 1;
  const sig = rest.map((m) => m.sigma ?? 1);
  const d = new Float32Array(n), buf = new Float32Array(rest.length);
  for (let i = 0; i < n; i++) {
    const t = target.data[i];
    if (!Number.isFinite(t)) { d[i] = NaN; continue; }
    let c = 0;
    for (let k = 0; k < rest.length; k++) {
      const v = rest[k].data[i] * sig[k];
      if (!Number.isFinite(v)) continue;
      let j = c++; // insertion sort: the list is short
      while (j > 0 && buf[j - 1] > v) { buf[j] = buf[j - 1]; j--; }
      buf[j] = v;
    }
    d[i] = c ? (t * ts - (c & 1 ? buf[c >> 1] : (buf[c / 2 - 1] + buf[c / 2]) / 2)) / ts : NaN;
  }
  return { w: target.w, h: target.h, data: d, ...settle(d, target.w, target.h) };
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k += 2) { const v = src[y * w + k]; if (Number.isFinite(v) && Math.abs(v) < 8) { s += v; c++; } }
    tmp[y * w + x] = c ? s / c : 0;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k += 2) { s += tmp[k * w + x]; c++; }
    out[y * w + x] = s / c;
  }
  return out;
}

// Shift-and-add: slide every date back along a trial motion, then add them up.
// Something that really moves that way lands on the same pixel every time and adds up;
// fixed stars land on a different pixel each time and smear out.
//
// Conventions used everywhere in this file:
//   - pixel (x, y) is a pixel index: x grows to the right, y grows downward, pixel centres are at whole numbers;
//   - east is LEFT (x decreases eastward), north is UP (y decreases northward);
//   - pixel scale = fovArcmin * 60 / w arcsec per pixel;
//   - image values are in units of that image's own noise.
import type { Norm } from "./render";
import { msToYear } from "./motion";

/** Which dates to combine. `groups[i]` names the survey of date i; only groups listed in `include` are used (all if omitted). */
export type Select = { groups?: string[]; include?: string[] };
export type StackOpts = Select & {
  /** Subtract what stays put (the median of the other dates from the same group) before stacking. */
  removeStatic?: boolean;
};
export type Stack = Norm & { used: number; refMs: number };
/** A date with the unmoving sky subtracted. `bright[k]` = 1 where the unmoving sky is brighter than `brightLimit`. */
export type Residual = Norm & { bright: Uint8Array };

const ARCSEC_PER_PIX = (fovArcmin: number, w: number) => (fovArcmin * 60) / w;

/** Indexes of the dates that are loaded and selected. */
export function selected(norms: (Norm | null)[], sel?: Select): number[] {
  const first = norms.find((n) => n) ?? null;
  const out: number[] = [];
  for (let i = 0; i < norms.length; i++) {
    const n = norms[i];
    if (!n || !first || n.w !== first.w || n.h !== first.h) continue;
    if (sel?.include && sel.groups && !sel.include.includes(sel.groups[i])) continue;
    out.push(i);
  }
  return out;
}

/** Where something sitting at (x, y) on the reference date appears on another date: (x + dx, y + dy), in pixels. */
export function pixelShift(ms: number, refMs: number, fovArcmin: number, w: number, pmEastMasYr: number, pmNorthMasYr: number): { dx: number; dy: number } {
  const dt = msToYear(ms) - msToYear(refMs), s = ARCSEC_PER_PIX(fovArcmin, w);
  return { dx: (-pmEastMasYr / 1000) * dt / s, dy: (-pmNorthMasYr / 1000) * dt / s };
}

const mad = (a: Float32Array): number => {
  const step = Math.max(1, Math.floor(a.length / 4000)), s = new Float32Array(Math.ceil(a.length / step));
  let m = 0;
  for (let i = 0; i < a.length; i += step) if (a[i] === a[i]) s[m++] = a[i];
  if (m < 8) return 1;
  const v = s.subarray(0, m).sort(), med = v[m >> 1];
  for (let i = 0; i < m; i++) v[i] = Math.abs(v[i] - med);
  v.sort();
  return Math.max(1e-6, 1.4826 * v[m >> 1]);
};

/**
 * For each date: the picture minus the median of the OTHER dates in the same group, back in noise units.
 * Fixed stars cancel; anything that moved, appeared or changed is left. Dates outside the selection,
 * or alone in their group, come back as null.
 */
export function staticResiduals(norms: (Norm | null)[], sel?: Select, brightLimit = 40): (Residual | null)[] {
  const out: (Residual | null)[] = norms.map(() => null);
  const idx = selected(norms, sel);
  const names = [...new Set(idx.map((i) => sel?.groups?.[i] ?? ""))];
  for (const g of names) {
    const gi = idx.filter((i) => (sel?.groups?.[i] ?? "") === g), N = gi.length;
    if (N < 2) continue;
    const { w, h } = norms[gi[0]]!, P = w * h;
    const src = gi.map((i) => norms[i]!.data), sig = gi.map((i) => norms[i]!.sigma ?? 1);
    const res = gi.map(() => new Float32Array(P)), bright = gi.map(() => new Uint8Array(P));
    const val = new Float64Array(N), ord = new Int32Array(N), rank = new Int32Array(N);
    for (let p = 0; p < P; p++) {
      let m = 0;
      for (let k = 0; k < N; k++) { // insertion sort of the finite values, in real brightness units
        const v = src[k][p] * sig[k];
        if (v !== v) { rank[k] = -1; continue; }
        let j = m++;
        while (j > 0 && val[j - 1] > v) { val[j] = val[j - 1]; ord[j] = ord[j - 1]; j--; }
        val[j] = v; ord[j] = k;
      }
      for (let j = 0; j < m; j++) rank[ord[j]] = j;
      const r = m - 1; // how many others
      for (let k = 0; k < N; k++) {
        const q = rank[k];
        if (q < 0 || r < 1) { res[k][p] = NaN; continue; }
        // median of the sorted list with entry q removed
        const a = (r - 1) >> 1, b = r >> 1;
        const med = (val[a >= q ? a + 1 : a] + val[b >= q ? b + 1 : b]) / 2;
        res[k][p] = (val[q] - med) / sig[k];
        if (med / sig[k] > brightLimit) bright[k][p] = 1;
      }
    }
    gi.forEach((i, k) => {
      const s = mad(res[k]);
      if (s !== 1) for (let p = 0; p < P; p++) res[k][p] /= s;
      out[i] = { w, h, data: res[k], sigma: sig[k] * s, bright: bright[k] };
    });
  }
  return out;
}

/** Relative weight of each date: fainter-noise dates count for more, within a group. Different groups are not compared. */
function weights(norms: (Norm | null)[], idx: number[], sel?: Select): Float64Array {
  const wts = new Float64Array(norms.length).fill(1);
  const by = new Map<string, number[]>();
  for (const i of idx) { const g = sel?.groups?.[i] ?? ""; (by.get(g) ?? by.set(g, []).get(g)!).push(i); }
  for (const gi of by.values()) {
    const s = gi.map((i) => norms[i]!.sigma ?? 1).sort((a, b) => a - b), med = s[s.length >> 1] || 1;
    for (const i of gi) wts[i] = Math.min(4, Math.max(0.25, med / (norms[i]!.sigma || med)));
  }
  return wts;
}

/**
 * Shift every selected date back along the given motion to the reference date, then average.
 * The result is again in noise units: pure noise stays near 1, a mover with that motion grows
 * roughly as the square root of the number of dates. Returns null if nothing is loaded.
 * `refMs` defaults to the latest selected date, so the stack lines up with the newest picture.
 */
export function shiftAndAdd(
  norms: (Norm | null)[], epochMs: number[], fovArcmin: number,
  pmEastMasYr: number, pmNorthMasYr: number, refMs?: number, opts?: StackOpts,
): Stack | null {
  const use: (Norm | null)[] = opts?.removeStatic ? staticResiduals(norms, opts) : norms;
  const idx = selected(use, opts);
  if (!idx.length) return null;
  const { w, h } = use[idx[0]]!, P = w * h;
  const ref = refMs ?? Math.max(...idx.map((i) => epochMs[i]));
  const wts = weights(use, idx, opts);
  const acc = new Float64Array(P), den = new Float64Array(P);
  for (const i of idx) {
    const d = use[i]!.data, wt = wts[i];
    const { dx, dy } = pixelShift(epochMs[i], ref, fovArcmin, w, pmEastMasYr, pmNorthMasYr);
    const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    // interpolating between pixels averages their noise down; account for it so the result stays in noise units
    const q = wt * wt * (w00 * w00 + w10 * w10 + w01 * w01 + w11 * w11);
    const ya = Math.max(0, -iy), yb = Math.min(h - 1, h - 1 - iy - (fy > 0 ? 1 : 0));
    const xa = Math.max(0, -ix), xb = Math.min(w - 1, w - 1 - ix - (fx > 0 ? 1 : 0));
    for (let y = ya; y <= yb; y++) {
      const row = (y + iy) * w + ix, o = y * w;
      for (let x = xa; x <= xb; x++) {
        const k = row + x;
        let v = w00 * d[k];
        if (w10) v += w10 * d[k + 1];
        if (w01) v += w01 * d[k + w];
        if (w11) v += w11 * d[k + w + 1];
        if (v !== v) continue;
        acc[o + x] += wt * v; den[o + x] += q;
      }
    }
  }
  const data = new Float32Array(P);
  for (let p = 0; p < P; p++) data[p] = den[p] > 0 ? acc[p] / Math.sqrt(den[p]) : NaN;
  return { w, h, data, sigma: 1, used: idx.length, refMs: ref };
}

/** Brightest finite pixel within `r` pixels of (x, y), or of the whole image (minus an `edge` border) if no position is given. */
export function peakNear(n: Norm, at?: { x: number; y: number } | null, r = 2, edge = 3): { x: number; y: number; value: number } | null {
  const xa = at ? Math.max(0, Math.round(at.x - r)) : edge, xb = at ? Math.min(n.w - 1, Math.round(at.x + r)) : n.w - 1 - edge;
  const ya = at ? Math.max(0, Math.round(at.y - r)) : edge, yb = at ? Math.min(n.h - 1, Math.round(at.y + r)) : n.h - 1 - edge;
  let best: { x: number; y: number; value: number } | null = null;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
    const v = n.data[y * n.w + x];
    if (v === v && (!best || v > best.value)) best = { x, y, value: v };
  }
  return best;
}

/** Light 3x3 blur (1-2-1), rescaled so pure noise stays at 1. Makes a star-sized blob stand out and forgives half-pixel misses. */
export function smooth3(n: Norm): Float32Array {
  const { w, h, data } = n, out = new Float32Array(w * h).fill(NaN);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    const v = 4 * data[k] + 2 * (data[k - 1] + data[k + 1] + data[k - w] + data[k + w]) + data[k - w - 1] + data[k - w + 1] + data[k + w - 1] + data[k + w + 1];
    out[k] = v / 6; // sqrt(16 + 4*4 + 4*1) = 6
  }
  const s = mad(out);
  if (s > 1) for (let k = 0; k < out.length; k++) out[k] /= s; // neighbouring pixels share noise in resampled pictures
  return out;
}

export type SearchOpts = StackOpts & {
  /** Fastest motion tried, arcsec per year. Default 10. */
  maxRateArcsecYr?: number;
  /** Date on which the object sat at `at`. Default: the latest selected date. */
  refMs?: number;
  /** How far from `at` the object may be on the reference date, pixels. Default 2. */
  slopPx?: number;
  /** Upper limit on the number of motions tried in the coarse pass. Default 40000. */
  maxTrials?: number;
};
export type SearchResult = {
  pmEastMasYr: number; pmNorthMasYr: number; rateArcsecYr: number;
  /** Peak of the stacked picture at the best motion, in noise units. */
  snr: number;
  /** The same spot stacked with no motion at all, for comparison. */
  snrStill: number;
  /** Where the peak sits on the reference date, pixels. */
  x: number; y: number;
  refMs: number; used: number; tried: number; stepArcsecYr: number;
};

/**
 * Try every straight-line motion up to `maxRateArcsecYr` for something sitting near `at` on the
 * reference date, and return the one whose stack is brightest. Coarse grid first (steps of about
 * one pixel of total travel), then a finer pass around the winner. Because thousands of motions are
 * tried, pure noise typically reaches about 4 to 5; treat anything below about 6 as unproven.
 */
export function searchMotion(norms: (Norm | null)[], epochMs: number[], fovArcmin: number, at: { x: number; y: number }, opts: SearchOpts = {}): SearchResult | null {
  const use: (Norm | null)[] = opts.removeStatic ? staticResiduals(norms, opts) : norms;
  const idx = selected(use, opts);
  if (idx.length < 2) return null;
  const { w, h } = use[idx[0]]!;
  const ref = opts.refMs ?? Math.max(...idx.map((i) => epochMs[i]));
  const scale = ARCSEC_PER_PIX(fovArcmin, w);
  const dts = idx.map((i) => msToYear(epochMs[i]) - msToYear(ref));
  const reach = Math.max(...dts.map(Math.abs));
  if (!(reach > 0)) return null;
  const maxRate = opts.maxRateArcsecYr ?? 10, slop = Math.max(0, Math.round(opts.slopPx ?? 2));
  const sm = idx.map((i) => smooth3(use[i]!));
  const wt = weights(use, idx, opts), wts = idx.map((i) => wt[i]);
  const need = Math.max(2, Math.ceil(idx.length / 2));

  // value of the stack at (x, y) on the reference date for a motion given in pixels per year (vx right, vy down)
  const N = idx.length;
  const at0 = (x: number, y: number, vx: number, vy: number): number => {
    let a = 0, d = 0, c = 0;
    for (let k = 0; k < N; k++) {
      const px = Math.round(x + vx * dts[k]), py = Math.round(y + vy * dts[k]);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const v = sm[k][py * w + px];
      if (v !== v) continue;
      a += wts[k] * v; d += wts[k] * wts[k]; c++;
    }
    return c >= need ? a / Math.sqrt(d) : -Infinity;
  };
  const bil = (m: Float32Array, x: number, y: number): number => {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) return NaN;
    const fx = x - ix, fy = y - iy, k = iy * w + ix;
    return (1 - fx) * (1 - fy) * m[k] + fx * (1 - fy) * m[k + 1] + (1 - fx) * fy * m[k + w] + fx * fy * m[k + w + 1];
  };
  const at1 = (x: number, y: number, vx: number, vy: number): number => {
    let a = 0, d = 0, c = 0;
    for (let k = 0; k < N; k++) {
      const v = bil(sm[k], x + vx * dts[k], y + vy * dts[k]);
      if (v !== v) continue;
      a += wts[k] * v; d += wts[k] * wts[k]; c++;
    }
    return c >= need ? a / Math.sqrt(d) : -Infinity;
  };

  const vmax = maxRate / scale; // pixels per year
  let step = 1 / reach;         // one pixel of travel at the farthest date
  const cap = opts.maxTrials ?? 40000;
  if ((2 * vmax / step + 1) ** 2 > cap) step = (2 * vmax) / (Math.sqrt(cap) - 1);
  const n = Math.max(1, Math.ceil(vmax / step));
  let best = { v: -Infinity, x: at.x, y: at.y, vx: 0, vy: 0 }, tried = 0;
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const vx = i * step, vy = j * step;
    if (vx * vx + vy * vy > vmax * vmax * 1.0001) continue;
    tried++;
    for (let oy = -slop; oy <= slop; oy++) for (let ox = -slop; ox <= slop; ox++) {
      const v = at0(at.x + ox, at.y + oy, vx, vy);
      if (v > best.v) best = { v, x: at.x + ox, y: at.y + oy, vx, vy };
    }
  }
  if (!Number.isFinite(best.v)) return null;
  // finer passes around the winner
  for (let f = step / 2, pos = 0.5; f >= step / 8 && f * reach >= 0.1; f /= 2, pos = 0.25) {
    const c = { ...best };
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const vx = c.vx + i * f, vy = c.vy + j * f, x = c.x + ox * pos, y = c.y + oy * pos;
      const v = at1(x, y, vx, vy);
      if (v > best.v) best = { v, x, y, vx, vy };
    }
  }
  const pmE = -best.vx * scale * 1000, pmN = -best.vy * scale * 1000;
  const plain: StackOpts = { groups: opts.groups, include: opts.include };
  const st = shiftAndAdd(use, epochMs, fovArcmin, pmE, pmN, ref, plain)!;
  const pk = peakNear(st, best, 2) ?? { x: best.x, y: best.y, value: best.v };
  const still = peakNear(shiftAndAdd(use, epochMs, fovArcmin, 0, 0, ref, plain)!, pk, 1);
  return {
    pmEastMasYr: pmE, pmNorthMasYr: pmN, rateArcsecYr: Math.hypot(pmE, pmN) / 1000,
    snr: pk.value, snrStill: still ? still.value : NaN, x: pk.x, y: pk.y,
    refMs: ref, used: idx.length, tried, stepArcsecYr: step * scale,
  };
}

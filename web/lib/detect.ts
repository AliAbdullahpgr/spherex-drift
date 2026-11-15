// A simple automatic search for things that move.
//  1. For each date, subtract the median of the other dates (same survey): fixed stars cancel.
//  2. Keep the spots left over that stand well above the noise.
//  3. Link spots from three or more dates that lie on one straight line at one steady speed.
// Pixel conventions as in shiftadd.ts: x right, y down, east is left, north is up.
import type { Norm } from "./render";
import { msToYear } from "./motion";
import { injectObject } from "./planetx";
import { selected, smooth3, staticResiduals, type Residual, type Select } from "./shiftadd";

export type Detection = { /** index of the date */ i: number; /** pixels */ x: number; y: number; /** height above the noise after a light blur */ snr: number };
export type Candidate = {
  track: Detection[];
  /** Motion in milliarcseconds per year (east and north positive). */
  pmEast: number; pmNorth: number;
  rateArcsecYr: number;
  /** Combined strength of all the detections on the track (root sum of squares of their signal-to-noise). */
  score: number;
  /** On how many dates the track was inside the picture and not hidden by a bright star. */
  possible: number;
};
export type FindOpts = Select & {
  /** Lowest spot kept, in noise units. Default 5. */
  threshold?: number;
  /** How far a spot may sit from the straight line, pixels. Default 1.5. */
  tolPx?: number;
  /** Fastest motion considered, arcsec per year. Default 20. */
  maxRateArcsecYr?: number;
  /** Fewest dates on a track. Default 3. */
  minDates?: number;
  /** A track must be seen on at least this share of the dates where it could have been. Default 0.5. */
  minFraction?: number;
  /** Least total travel across all the dates, pixels; anything slower counts as not moving. Default 3. */
  minShiftPx?: number;
  /** Border ignored, pixels. Default 4. */
  edgePx?: number;
  /** Fixed sources brighter than this (noise units) are masked, with a small margin. Default 40. */
  brightLimit?: number;
  /** Strongest spots kept per date. Default 25. */
  maxPerDate?: number;
  /** Most candidates returned. Default 10. */
  maxCandidates?: number;
};

const D = { threshold: 5, tolPx: 1.5, maxRateArcsecYr: 20, minDates: 3, minFraction: 0.5, minShiftPx: 3, edgePx: 4, brightLimit: 40, maxPerDate: 25, maxCandidates: 10 };

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!src[y * w + x]) continue;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) tmp[y * w + k] = 1;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!tmp[y * w + x]) continue;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) out[k * w + x] = 1;
  }
  return out;
}

/** Pixels where a detection cannot be trusted: no data nearby, a bright fixed star nearby, or the border. */
export function badMask(res: Residual, edgePx = D.edgePx): Uint8Array {
  const { w, h, data, bright } = res, P = w * h;
  const nan = new Uint8Array(P);
  let anyNan = false, anyBright = false;
  for (let p = 0; p < P; p++) { if (data[p] !== data[p]) { nan[p] = 1; anyNan = true; } if (bright[p]) anyBright = true; }
  const a = anyNan ? dilate(nan, w, h, 2) : nan, b = anyBright ? dilate(bright, w, h, 3) : bright;
  const out = new Uint8Array(P);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    out[p] = a[p] || b[p] || x < edgePx || y < edgePx || x >= w - edgePx || y >= h - edgePx ? 1 : 0;
  }
  return out;
}

/** Local maxima of the lightly blurred residual above `threshold`, strongest first, with sub-pixel positions. */
export function detectPeaks(res: Residual, i: number, bad: Uint8Array, threshold = D.threshold, max = D.maxPerDate): Detection[] {
  const { w, h } = res, s = smooth3(res), out: Detection[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, v = s[p];
    if (!(v >= threshold) || bad[p]) continue;
    if (s[p - w - 1] >= v || s[p - w] >= v || s[p - w + 1] >= v || s[p - 1] >= v || s[p + 1] > v || s[p + w - 1] > v || s[p + w] > v || s[p + w + 1] > v) continue;
    let sw = 0, sx = 0, sy = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = s[p + dy * w + dx];
      if (q > 0) { sw += q; sx += q * dx; sy += q * dy; }
    }
    out.push({ i, x: x + sx / sw, y: y + sy / sw, snr: v });
  }
  out.sort((a, b) => b.snr - a.snr);
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * Look for things that move in a straight line at a steady speed.
 * Returns up to `maxCandidates` candidates, strongest first. Each needs spots on at least `minDates`
 * dates, at three or more clearly different places, all within `tolPx` of one straight-line motion.
 */
export function findMovers(norms: (Norm | null)[], epochMs: number[], fovArcmin: number, opts: FindOpts = {}): Candidate[] {
  const o = { ...D, ...opts };
  const res = staticResiduals(norms, opts, o.brightLimit);
  const idx = selected(res);
  if (idx.length < o.minDates) return [];
  const { w, h } = res[idx[0]]!;
  const scale = (fovArcmin * 60) / w; // arcsec per pixel
  const yr = epochMs.map(msToYear);
  const span = Math.max(...idx.map((i) => yr[i])) - Math.min(...idx.map((i) => yr[i]));
  if (!(span > 0)) return [];
  const vMax = o.maxRateArcsecYr / scale, vMin = o.minShiftPx / span; // pixels per year

  // spots on every date, bucketed on a coarse grid so neighbours are quick to find
  const cell = Math.max(2, Math.ceil(o.tolPx)), cw = Math.ceil(w / cell) + 2;
  const bad = new Map<number, Uint8Array>(), dets = new Map<number, Detection[]>(), grid = new Map<number, Map<number, Detection[]>>();
  for (const i of idx) {
    const b = badMask(res[i]!, o.edgePx), d = detectPeaks(res[i]!, i, b, o.threshold, o.maxPerDate), g = new Map<number, Detection[]>();
    for (const q of d) { const k = (Math.floor(q.y / cell) + 1) * cw + Math.floor(q.x / cell) + 1; (g.get(k) ?? g.set(k, []).get(k)!).push(q); }
    bad.set(i, b); dets.set(i, d); grid.set(i, g);
  }
  const nearest = (i: number, x: number, y: number): Detection | null => {
    const g = grid.get(i)!, cx = Math.floor(x / cell) + 1, cy = Math.floor(y / cell) + 1;
    let best: Detection | null = null, bd = o.tolPx * o.tolPx;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = g.get((cy + dy) * cw + cx + dx);
      if (list) for (const q of list) { const d2 = (q.x - x) ** 2 + (q.y - y) ** 2; if (d2 <= bd) { bd = d2; best = q; } }
    }
    return best;
  };
  type Line = { x0: number; y0: number; vx: number; vy: number; t0: number };
  const gather = (L: Line) => {
    const tr: Detection[] = []; let possible = 0;
    for (const i of idx) {
      const x = L.x0 + L.vx * (yr[i] - L.t0), y = L.y0 + L.vy * (yr[i] - L.t0);
      const rx = Math.round(x), ry = Math.round(y);
      if (rx < 0 || ry < 0 || rx >= w || ry >= h || bad.get(i)![ry * w + rx]) continue;
      possible++;
      const q = nearest(i, x, y);
      if (q) tr.push(q);
    }
    return { tr, possible };
  };
  const fit = (tr: Detection[]): Line => { // least squares, weighted by strength
    let sw = 0, st = 0, sx = 0, sy = 0;
    for (const q of tr) { sw += q.snr; st += q.snr * yr[q.i]; sx += q.snr * q.x; sy += q.snr * q.y; }
    const t0 = st / sw, x0 = sx / sw, y0 = sy / sw;
    let stt = 0, stx = 0, sty = 0;
    for (const q of tr) { const dt = yr[q.i] - t0; stt += q.snr * dt * dt; stx += q.snr * dt * (q.x - x0); sty += q.snr * dt * (q.y - y0); }
    return { x0, y0, t0, vx: stt > 0 ? stx / stt : 0, vy: stt > 0 ? sty / stt : 0 };
  };
  const places = (tr: Detection[]): number => { // how many clearly different places the track visits
    let n = 0, last: Detection | null = null;
    for (const q of tr) if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1) { n++; last = q; }
    return n;
  };

  const found: (Candidate & { key: string })[] = [], seen = new Set<string>();
  for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
    const i = idx[a], j = idx[b], dt = yr[j] - yr[i];
    if (!(Math.abs(dt) > 1e-6)) continue;
    for (const p of dets.get(i)!) for (const q of dets.get(j)!) {
      const vx = (q.x - p.x) / dt, vy = (q.y - p.y) / dt, v = Math.hypot(vx, vy);
      if (v > vMax || v < vMin) continue;
      let L: Line = { x0: p.x, y0: p.y, vx, vy, t0: yr[i] };
      let { tr, possible } = gather(L);
      if (tr.length < o.minDates) continue;
      for (let it = 0; it < 2; it++) { L = fit(tr); ({ tr, possible } = gather(L)); if (tr.length < o.minDates) break; }
      if (tr.length < o.minDates || tr.length < o.minFraction * possible) continue;
      L = fit(tr);
      const rate = Math.hypot(L.vx, L.vy);
      if (rate > vMax || rate < vMin || places(tr) < 3) continue;
      const key = tr.map((d) => `${d.i}:${d.x.toFixed(1)},${d.y.toFixed(1)}`).join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        key, track: tr, possible,
        pmEast: -L.vx * scale * 1000, pmNorth: -L.vy * scale * 1000, rateArcsecYr: rate * scale, // east is left, north is up
        score: Math.sqrt(tr.reduce((s, d) => s + d.snr * d.snr, 0)),
      });
    }
  }
  // strongest first; a spot may belong to only one candidate
  found.sort((a, b) => b.score - a.score);
  const usedSpots = new Set<Detection>(), out: Candidate[] = [];
  for (const c of found) {
    if (c.track.filter((d) => usedSpots.has(d)).length > c.track.length / 3) continue;
    c.track.forEach((d) => usedSpots.add(d));
    const { key: _k, ...rest } = c; void _k;
    out.push(rest);
    if (out.length >= o.maxCandidates) break;
  }
  return out;
}

export type ScoreLevel = { name: "bright" | "medium" | "faint"; snr: number; found: number; total: number };
export type FinderScore = {
  levels: ScoreLevel[];
  /** Candidates reported on the untouched pictures. False alarms, unless something there really does move. */
  falseAlarms: number;
  baseline: Candidate[];
  /** Extra wrong candidates that showed up during the trials, summed over all trials. */
  spurious: number;
  trials: number;
  /** Slowest and fastest simulated motion, arcsec per year. */
  rateRange: [number, number];
  msPerRun: number;
};
export type ScoreOpts = FindOpts & { seed?: number; onProgress?: (done: number, total: number) => void; signal?: { cancelled: boolean } };

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const sameMotion = (a: Candidate, e: number, n: number, tolMas: number) => Math.hypot(a.pmEast - e, a.pmNorth - n) <= tolMas;

/**
 * Measure how well findMovers does on these very pictures: hide `trials` simulated movers, one at a
 * time, at random places, speeds and directions, in three brightness classes (peak 30, 12 and 6 times
 * the noise), and count how many come back with the right motion (within 15 percent). Also reports
 * what the finder says about the untouched pictures. Runs in slices so the page stays responsive.
 */
export async function scoreFinder(norms: (Norm | null)[], epochMs: number[], fovArcmin: number, trials = 30, opts: ScoreOpts = {}): Promise<FinderScore> {
  const o = { ...D, ...opts };
  const levels: ScoreLevel[] = [{ name: "bright", snr: 30, found: 0, total: 0 }, { name: "medium", snr: 12, found: 0, total: 0 }, { name: "faint", snr: 6, found: 0, total: 0 }];
  const idx = selected(norms, opts);
  const t0 = now();
  const baseline = findMovers(norms, epochMs, fovArcmin, opts);
  let spent = now() - t0, runs = 1, spurious = 0;
  const empty: FinderScore = { levels, falseAlarms: baseline.length, baseline, spurious: 0, trials: 0, rateRange: [0, 0], msPerRun: spent };
  if (idx.length < o.minDates) return empty;
  const w = norms[idx[0]]!.w, scale = (fovArcmin * 60) / w;
  const ms = idx.map((i) => epochMs[i]), lo = Math.min(...ms), hi = Math.max(...ms), refMs = (lo + hi) / 2;
  const span = msToYear(hi) - msToYear(lo);
  if (!(span > 0)) return empty;
  // slow enough to stay in the picture, fast enough to travel a few star-widths (slower ones are partly erased by the median)
  const rMin = (Math.max(1.5 * o.minShiftPx, 8) * scale) / span, rMax = Math.max(rMin * 1.2, Math.min(o.maxRateArcsecYr * 0.9, (0.45 * fovArcmin * 60) / span));
  const R = rng(opts.seed ?? 20260101);
  const pause = () => new Promise<void>((r) => setTimeout(r, 0));
  let done = 0;
  for (let t = 0; t < trials; t++) {
    if (opts.signal?.cancelled) break;
    const L = levels[t % levels.length];
    const rate = rMin * Math.pow(rMax / rMin, R()), dir = R() * 2 * Math.PI;
    const e = rate * Math.sin(dir) * 1000, n = rate * Math.cos(dir) * 1000;
    const inj = injectObject(norms, epochMs, { x0: 0.3 + 0.4 * R(), y0: 0.3 + 0.4 * R(), snr: L.snr, pmEastMasYr: e, pmNorthMasYr: n, refMs, fovArcmin });
    const t1 = now();
    const got = findMovers(inj.norms, epochMs, fovArcmin, opts);
    spent += now() - t1; runs++;
    const tolMas = Math.max(0.15 * rate, scale / span) * 1000;
    const hit = got.find((c) => sameMotion(c, e, n, tolMas) && c.track.some((d) => Math.hypot(d.x - (inj.track[d.i].x * w - 0.5), d.y - (inj.track[d.i].y * w - 0.5)) < 3));
    L.total++; if (hit) L.found++;
    spurious += got.filter((c) => c !== hit && !baseline.some((b) => sameMotion(b, c.pmEast, c.pmNorth, tolMas) && Math.hypot(b.track[0].x - c.track[0].x, b.track[0].y - c.track[0].y) < 4)).length;
    done++;
    opts.onProgress?.(done, trials);
    await pause();
  }
  return { levels, falseAlarms: baseline.length, baseline, spurious, trials: done, rateRange: [rMin, rMax], msPerRun: spent / runs };
}

// Measure how far an object actually moved in the images, to compare with the catalogue.
import type { Norm } from "./render";

/** Brightness-weighted centre of whatever sits near (x0, y0), in pixels. Null if nothing clear is there. */
export function centroid(n: Norm, x0: number, y0: number, rPix: number): { x: number; y: number; peak: number } | null {
  let cx = x0, cy = y0, peak = 0;
  for (let iter = 0; iter < 3; iter++) {
    const r = iter === 0 ? rPix : rPix * 0.7;
    let sw = 0, sx = 0, sy = 0; peak = 0;
    const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(n.w - 1, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(n.h - 1, Math.ceil(cy + r));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      const v = n.data[y * n.w + x];
      if (!Number.isFinite(v) || v < 3) continue; // data are in units of the image's own noise
      if (v > peak) peak = v;
      sw += v; sx += v * x; sy += v * y;
    }
    if (sw <= 0) return null;
    cx = sx / sw; cy = sy / sw;
  }
  return peak >= 6 ? { x: cx, y: cy, peak } : null;
}

export type Sample = { yr: number; east: number; north: number }; // arcsec
export type Fit = { rate: number; pmEast: number; pmNorth: number; n: number; spanYr: number };

/** Straight-line fit of position against time. Needs at least three dates across half a year. */
export function fitMotion(s: Sample[]): Fit | null {
  if (s.length < 3) return null;
  const t0 = s.reduce((a, b) => a + b.yr, 0) / s.length;
  const span = Math.max(...s.map((p) => p.yr)) - Math.min(...s.map((p) => p.yr));
  if (span < 0.5) return null;
  const stt = s.reduce((a, p) => a + (p.yr - t0) ** 2, 0);
  const slope = (f: (p: Sample) => number) => { const m = s.reduce((a, p) => a + f(p), 0) / s.length; return s.reduce((a, p) => a + (p.yr - t0) * (f(p) - m), 0) / stt; };
  const pmEast = slope((p) => p.east), pmNorth = slope((p) => p.north);
  return { rate: Math.hypot(pmEast, pmNorth), pmEast, pmNorth, n: s.length, spanYr: span };
}

export const msToYear = (ms: number) => 2000 + (ms - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000);

// Turns the per-exposure measurements from /spectrum into a spectrum and a light curve.
import type { SpectrumPoint } from "./types";
import type { Epoch } from "./epochs";
import type { Norm } from "./render";

export type Measure = { wl: number; v: number; err: number; pass: number; ms: number; det: number };
export type Picked = { pts: Measure[]; kind: "flux" | "halo" };

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Choose which brightness measure to plot. A normal star uses aperture flux. A star bright enough
 * to saturate the detector has no usable core, so its outer halo is used instead: the halo's
 * brightness rises and falls with the star's.
 */
export function pickMeasure(points: SpectrumPoint[]): Picked {
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const clean = points.filter((p) => ok(p.flux_mjy_sr) && !p.saturated);
  const halo = points.filter((p) => ok(p.halo_mjy_sr));
  const useHalo = clean.length < 0.5 * points.length && halo.length > clean.length;
  const src = useHalo ? halo : points.filter((p) => ok(p.flux_mjy_sr));
  return {
    kind: useHalo ? "halo" : "flux",
    pts: src.map((p) => ({ wl: p.wavelength_um, v: (useHalo ? p.halo_mjy_sr : p.flux_mjy_sr) as number, err: useHalo ? 0 : (p.err ?? 0), pass: p.pass, ms: p.time ? Date.parse(p.time) : NaN, det: p.detector ?? 0 })),
  };
}

export type CurvePoint = { pass: number; ms: number; v: number; n: number; err: number };
/** change = last pass / first pass - 1; sigma = how many times larger that change is than its own uncertainty. */
export type Curve = { det: number; wl: number; points: CurvePoint[]; change: number; sigma: number; measurement?: "aperture" | "halo" };

/** Relative aperture brightness in the real linear WISE preview pixels.
 * Restore each image's original scale before comparing dates (display sigma varies).
 * This is a quick-look trend, not calibrated catalogue photometry.
 */
export function wiseLightCurve(norms: (Norm | null)[], epochs: Epoch[], fov: number): Curve[] {
  const by = new Map<number, CurvePoint[]>();
  // The high-range upstream PNG clips at 30,000 linear units. Use the same
  // outer-halo aperture on every date when any epoch's centre reaches that limit.
  const useHalo = norms.some((n, i) => n && epochs[i]?.survey === "wise" &&
    n.data[Math.floor(n.h / 2) * n.w + Math.floor(n.w / 2)] * (n.sigma ?? 1) > 28500);
  epochs.forEach((e, i) => {
    const n = norms[i];
    if (!n || e.survey !== "wise") return;
    const radius = Math.max(2, 6 / (fov * 60 / n.w));
    const haloInner = 24 / (fov * 60 / n.w), haloOuter = 42 / (fov * 60 / n.w);
    const skyInner = useHalo ? 60 / (fov * 60 / n.w) : radius * 2.5;
    const skyOuter = useHalo ? 78 / (fov * 60 / n.w) : radius * 4;
    const cx = (n.w - 1) / 2, cy = (n.h - 1) / 2;
    const aperture: number[] = [], sky: number[] = [];
    let expected = 0;
    for (let y = Math.max(0, Math.floor(cy - skyOuter)); y <= Math.min(n.h - 1, Math.ceil(cy + skyOuter)); y++) {
      for (let x = Math.max(0, Math.floor(cx - skyOuter)); x <= Math.min(n.w - 1, Math.ceil(cx + skyOuter)); x++) {
        const r = Math.hypot(x - cx, y - cy);
        const v = n.data[y * n.w + x] * (n.sigma ?? 1);
        if (useHalo ? r >= haloInner && r <= haloOuter : r <= radius) { expected++; if (Number.isFinite(v)) aperture.push(v); }
        else if (r >= skyInner && r <= skyOuter && Number.isFinite(v)) sky.push(v);
      }
    }
    if (aperture.length < expected * .8 || sky.length < 10) return;
    const bg = median(sky), v = aperture.reduce((sum, x) => sum + x - bg, 0);
    if (!(v > 0)) return;
    const err = 1.4826 * median(sky.map(x => Math.abs(x - bg))) * Math.sqrt(aperture.length);
    const points = by.get(e.wl) ?? [];
    points.push({ pass: e.pass, ms: e.ms, v, err, n: 1 }); by.set(e.wl, points);
  });
  return [...by.entries()].filter(([, points]) => points.length >= 3).map(([wl, points]) => {
    points.sort((a, b) => a.ms - b.ms);
    const a = points[0], b = points[points.length - 1];
    return { det: wl < 4 ? 1 : 2, wl, points, change: b.v / a.v - 1, sigma: 0,
      measurement: useHalo ? "halo" : "aperture" };
  });
}

/** One line per detector (wavelength band): the median brightness in each pass. */
export function lightCurve(picked: Picked): Curve[] {
  const by = new Map<number, Measure[]>();
  for (const p of picked.pts) if (p.det && Number.isFinite(p.ms)) (by.get(p.det) ?? by.set(p.det, []).get(p.det)!).push(p);
  const out: Curve[] = [];
  for (const [det, ps] of by) {
    const passes = [...new Set(ps.map((p) => p.pass))].sort((a, b) => a - b);
    const points = passes.map((pass) => {
      const g = ps.filter((p) => p.pass === pass);
      const v = median(g.map((p) => p.v));
      // uncertainty of the median from the scatter of the exposures in this pass
      const err = (1.4826 * median(g.map((p) => Math.abs(p.v - v)))) / Math.sqrt(Math.max(1, g.length));
      return { pass, ms: median(g.map((p) => p.ms)), v, n: g.length, err };
    }).filter((c) => c.n >= 5);
    if (points.length < 2) continue;
    const a = points[0], b = points[points.length - 1];
    // a band only counts if the star is clearly detected in it on the first date
    if (!(a.v > 0) || a.v < 5 * a.err) continue;
    out.push({ det, wl: median(ps.map((p) => p.wl)), points, change: b.v / a.v - 1, sigma: Math.abs(b.v - a.v) / Math.max(1e-12, Math.hypot(a.err, b.err)) });
  }
  return out.sort((a, b) => a.det - b.det);
}

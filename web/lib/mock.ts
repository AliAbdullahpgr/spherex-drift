// Synthetic backend for ?mock=1 / offline development. Produces the same shapes as CONTRACT.md.
// Mock scene (size N px across `fov` arcmin): fixed stars, ONE MOVER (brown-dwarf-like) that is at the
// image centre in 2026.0 and moves (-18, +14) px/yr * (5/fov) (x right, y down), ONE VARIABLE star at (96,168).
import type { Frame, FramesResponse, Target, SpectrumResponse, Img } from "./types";
import { pix2sky, sky2pix } from "./coords";

export const MOCK_TARGETS: Target[] = [
  { id: "barnard", name: "Barnard's Star", ra: 269.4521, dec: 4.6934, note: "nearest single star, high proper motion", kind: "mover" },
  { id: "epsindib", name: "Epsilon Indi B", ra: 330.8704, dec: -56.7861, note: "brown dwarf pair orbiting a star", kind: "mover" },
  { id: "wise0855", name: "WISE 0855", ra: 133.795129, dec: -7.245147, note: "fast-moving brown dwarf (made-up motion in demo mode)", kind: "mover", pm_mas_yr: [21094, -16406], epoch: 2026 },
  { id: "rwaur", name: "RW Aurigae", ra: 76.9588, dec: 30.4004, note: "variable star", kind: "variable" },
  { id: "rdra", name: "R Draconis", ra: 244.3982, dec: 66.7586, note: "variable star", kind: "variable" },
];

export const MOVER_V = { x: -18, y: 14 }; // px/yr at fov=5
export const VAR_POS = { x: 96, y: 168 };
export const MOCK_SIZE = 256;
const DET_WL = [0.85, 1.15, 1.6, 2.4, 3.6, 4.6];
const PASS_DATES = ["2025-06-10", "2025-12-08", "2026-06-09", "2026-11-02"];
const WISE_DATES = ["2010-03-01", "2010-09-05", "2014-01-10", "2015-01-12", "2016-01-14", "2017-01-12", "2018-01-10", "2019-01-09", "2021-01-08", "2023-01-07"];

function yearOf(iso: string) {
  const t = Date.parse(iso);
  return 1970 + t / (365.25 * 86400000);
}
const mjdOf = (iso: string) => Date.parse(iso) / 86400000 + 40587;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function mockFrames(ra: number, dec: number, fov: number): FramesResponse {
  const frames: Frame[] = [];
  PASS_DATES.forEach((d, pi) => {
    for (let det = 1; det <= 6; det++) {
      // one position has a few exposures per detector per pass, at slightly different wavelengths
      for (let k = 0; k < 2; k++) {
        const day = pi === 2 && det === 3 && k === 1 ? 0 : k * 1.5 + (det - 1) * 0.3; // pass 3 / det 3 has only one exposure
        if (pi === 2 && det === 3 && k === 1) continue;
        const t = new Date(Date.parse(d + "T10:00:00Z") + day * 86400000).toISOString().replace(".000Z", "Z");
        const id = `mock-s-${pi + 1}-${det}-${k}`;
        const flags: string[] = [];
        if (pi === 1 && det === 2 && k === 0) flags.push("contaminated");
        if (pi === 3 && det === 6 && k === 1) flags.push("saturated");
        if (pi === 0 && det === 4 && k === 1) flags.push("cosmic_ray");
        frames.push({
          id, survey: "spherex", time: t, mjd: mjdOf(t), detector: det,
          wavelength_um: +(DET_WL[det - 1] * (1 + 0.04 * (k - 0.5))).toFixed(3), pass: pi + 1, flags,
          image_url: `/image/${id}?ra=${ra}&dec=${dec}&fov=${fov}&stretch=asinh`,
        });
      }
    }
  });
  const passes = PASS_DATES.map((d, i) => ({ pass: i + 1, start: d, end: d, n_frames: frames.filter((f) => f.pass === i + 1).length }));
  return { ra, dec, fov, frames, passes };
}

export function mockWise(ra: number, dec: number, fov: number): FramesResponse {
  const frames: Frame[] = [];
  WISE_DATES.forEach((d, i) => {
    for (const wl of [3.4, 4.6]) {
      const t = d + "T06:00:00Z";
      const id = `mock-w-${i + 1}-${wl}`;
      frames.push({ id, survey: "wise", time: t, mjd: mjdOf(t), detector: null, wavelength_um: wl, pass: i + 1, flags: [], image_url: `/wise/image/${id}?ra=${ra}&dec=${dec}&fov=${fov}` });
    }
  });
  return { ra, dec, fov, frames, passes: [] };
}

function gauss(a: Float32Array, n: number, cx: number, cy: number, amp: number, sig: number) {
  const r = Math.ceil(sig * 4);
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      a[y * n + x] += amp * Math.exp(-d2 / (2 * sig * sig));
    }
  }
}

type Spec = { year: number; wl: number; kind: "stack" | "frame"; seed: string; survey: "spherex" | "wise" };

/** Render one mock image. */
export function mockImage(ra: number, dec: number, fov: number, size: number, spec: Spec): Img {
  const n = size;
  const a = new Float32Array(n * n);
  const sky = hash(`${ra.toFixed(3)},${dec.toFixed(3)}`);
  const R = rng(sky);
  const sc = n / 256; // keep geometry in 256-px units
  const pxScale = (fov / 5) ** -1; // px per yr scale
  const sig = (spec.survey === "wise" ? 2.4 : 1.9) * sc;
  // fixed stars (two bright ones at known places for tests)
  const stars: { x: number; y: number; f: number; slope: number }[] = [
    { x: 60, y: 70, f: 900, slope: 0.3 }, { x: 190, y: 200, f: 700, slope: -0.2 },
  ];
  for (let i = 0; i < 60; i++) stars.push({ x: R() * 256, y: R() * 256, f: 25 + 220 * R() ** 3, slope: R() * 2 - 1 });
  const wlf = (slope: number) => Math.pow(spec.wl / 2.2, slope);
  for (const s of stars) gauss(a, n, s.x * sc, s.y * sc, s.f * wlf(s.slope), sig);
  // variable star: 1.2-year period, big amplitude
  gauss(a, n, VAR_POS.x * sc, VAR_POS.y * sc, 600 * (1 + 0.75 * Math.sin((2 * Math.PI * spec.year) / 1.2)) * wlf(0.1), sig);
  // mover: brighter at long wavelengths (brown dwarf)
  const dt = spec.year - 2026;
  const mx = 128 + MOVER_V.x * pxScale * dt, my = 128 + MOVER_V.y * pxScale * dt;
  gauss(a, n, mx * sc, my * sc, 650 * Math.pow(spec.wl / 3, 2.2), sig);
  // background gradient + noise; offset differs per exposure (zodiacal light)
  const rn = rng(hash(spec.seed));
  const bg = 40 + 60 * rn();
  const gx = (rn() - 0.5) * 30, gy = (rn() - 0.5) * 30;
  const noise = spec.kind === "stack" ? 3.0 : 5.5;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (rn() + rn() + rn() - 1.5) * 2;
    a[y * n + x] += bg + gx * (x / n) + gy * (y / n) + noise * u;
  }
  if (spec.kind === "frame") {
    // cosmic rays and hot pixels exist in single exposures only (stacks reject them); masked pixels are NaN
    for (let i = 0; i < 6; i++) { const x = Math.floor(rn() * n), y = Math.floor(rn() * n); a[y * n + x] += 900; if (x + 1 < n) a[y * n + x + 1] += 500; }
    for (let i = 0; i < 4; i++) a[Math.floor(rn() * n * n)] = NaN;
  }
  // a dead column at the edge, NaN in every image
  for (let y = 0; y < n; y++) a[y * n + n - 1] = NaN;
  return { w: n, h: n, data: a };
}

export function mockFrameImage(frameId: string, ra: number, dec: number, fov: number, size: number): Img {
  const m = frameId.match(/^mock-(s|w)-(\d+)-(\d+)(?:-(\d+))?/);
  if (!m) throw new Error("unknown mock frame " + frameId);
  if (m[1] === "w") {
    const idx = +m[2] - 1;
    const wl = frameId.endsWith("3.4") ? 3.4 : 4.6;
    return mockImage(ra, dec, fov, size, { year: yearOf(WISE_DATES[idx]), wl, kind: "frame", seed: frameId, survey: "wise" });
  }
  const pass = +m[2], det = +m[3], k = +m[4];
  return mockImage(ra, dec, fov, size, { year: yearOf(PASS_DATES[pass - 1]) + (k * 1.5 + det * 0.3) / 365, wl: DET_WL[det - 1] * (1 + 0.04 * (k - 0.5)), kind: "frame", seed: frameId, survey: "spherex" });
}

export function mockStack(ra: number, dec: number, fov: number, pass: number, det: number, size: number): Img {
  return mockImage(ra, dec, fov, size, { year: yearOf(PASS_DATES[pass - 1]) + 0.01, wl: DET_WL[det - 1], kind: "stack", seed: `stack-${pass}-${det}`, survey: "spherex" });
}

export function mockSpectrum(ra: number, dec: number, radiusArcsec: number, center: { ra: number; dec: number }, fov: number): SpectrumResponse {
  // The mock spectrum depends on where, relative to the field centre, the click landed.
  const p = sky2pix(ra, dec, 256, (fov * 60) / 256, center.ra, center.dec);
  const nearVar = Math.hypot(p.x - VAR_POS.x, p.y - VAR_POS.y) < 8;
  const points: SpectrumResponse["points"] = [];
  PASS_DATES.forEach((d, pi) => {
    for (let det = 1; det <= 6; det++) for (let k = 0; k < 2; k++) {
      if (pi === 2 && det === 3 && k === 1) continue;
      const wl = DET_WL[det - 1] * (1 + 0.04 * (k - 0.5));
      let f = 20 * Math.pow(wl / 2.2, -1.2) + 4;
      f *= 1 - 0.45 * Math.exp(-((wl - 3.0) ** 2) / (2 * 0.12 ** 2)) * (nearVar ? 0.3 : 1); // water-ice dip
      f *= 1 - 0.3 * Math.exp(-((wl - 4.27) ** 2) / (2 * 0.06 ** 2));
      if (nearVar) f *= 1 + 0.7 * Math.sin((2 * Math.PI * yearOf(d)) / 1.2);
      const rr = rng(hash(`${ra.toFixed(4)}${dec.toFixed(4)}${pi}${det}${k}`));
      f += (rr() - 0.5) * 1.2;
      points.push({ wavelength_um: +wl.toFixed(3), flux_mjy_sr: +f.toFixed(3), err: 0.6, time: d + "T10:00:00Z", pass: pi + 1, detector: det, flags: [] });
    }
  });
  points.sort((a, b) => a.wavelength_um - b.wavelength_um);
  return { points };
}
export { pix2sky };

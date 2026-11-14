// "Could this tool find a Planet X?" Hide a simulated distant planet in the real images.
// The object is fake and always labelled as such; the sky behind it is real.
import type { Norm } from "./render";
import { msToYear } from "./motion";

export type PlanetXOpts = { distAU: number; snr: number; seed: number; fovArcmin: number };
export type PlanetXResult = { norms: (Norm | null)[]; track: { x: number; y: number }[]; wobbleArcsec: number; driftArcsecYr: number; inView: number };

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * How a body at `distAU` from the Sun appears to move:
 *  - a yearly back-and-forth (parallax) of 206265 / distance arcsec each way, because we watch from a moving Earth;
 *  - a slow steady drift along its orbit of 1,296,000 / distance^1.5 arcsec per year (circular orbit).
 */
export function apparentMotion(distAU: number) {
  return { wobbleArcsec: 206265 / distAU, driftArcsecYr: 1296000 / Math.pow(distAU, 1.5) };
}

export function injectPlanetX(norms: (Norm | null)[], epochMs: number[], o: PlanetXOpts): PlanetXResult {
  const R = rng(o.seed);
  const { wobbleArcsec, driftArcsecYr } = apparentMotion(o.distAU);
  const fov = o.fovArcmin * 60;
  const start = { x: 0.25 + 0.5 * R(), y: 0.25 + 0.5 * R() };
  const axis = R() * Math.PI * 2, phase = R() * Math.PI * 2, driftDir = axis + (R() < 0.5 ? 0 : Math.PI);
  const yr0 = epochMs.length ? msToYear(epochMs[0]) : 0;
  const track = epochMs.map((ms) => {
    const dt = msToYear(ms) - yr0;
    const along = wobbleArcsec * (Math.cos(2 * Math.PI * dt + phase) - Math.cos(phase)) + driftArcsecYr * dt * Math.cos(driftDir - axis);
    const across = driftArcsecYr * dt * Math.sin(driftDir - axis) * 0.15;
    return { x: start.x + (along * Math.cos(axis) - across * Math.sin(axis)) / fov, y: start.y + (along * Math.sin(axis) + across * Math.cos(axis)) / fov };
  });
  const out = norms.map((n, i) => {
    if (!n) return null;
    const t = track[i];
    const px = t.x * n.w - 0.5, py = t.y * n.h - 0.5;
    if (px < -6 || py < -6 || px > n.w + 6 || py > n.h + 6) return n;
    const sig = Math.max(1.1, 3.0 / (fov / n.w)); // about a 7 arcsec wide star image
    const data = new Float32Array(n.data);
    const r = Math.ceil(sig * 4);
    for (let y = Math.max(0, Math.floor(py - r)); y <= Math.min(n.h - 1, Math.ceil(py + r)); y++)
      for (let x = Math.max(0, Math.floor(px - r)); x <= Math.min(n.w - 1, Math.ceil(px + r)); x++) {
        const k = y * n.w + x;
        if (Number.isFinite(data[k])) data[k] += o.snr * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * sig * sig));
      }
    return { ...n, data };
  });
  const inView = track.filter((t) => t.x > 0.02 && t.x < 0.98 && t.y > 0.02 && t.y < 0.98).length;
  return { norms: out, track, wobbleArcsec, driftArcsecYr, inView };
}

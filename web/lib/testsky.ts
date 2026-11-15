// Synthetic skies for the unit tests: Gaussian noise, fixed stars, and (optionally) one hand-drawn mover.
import type { Norm } from "./render";

export function rand(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const YEAR = 365.25 * 86400000;
export const blob = (d: Float32Array, w: number, x: number, y: number, amp: number, sig = 1.2) => {
  const h = d.length / w;
  for (let j = Math.max(0, Math.floor(y - 6)); j <= Math.min(h - 1, Math.ceil(y + 6)); j++)
    for (let i = Math.max(0, Math.floor(x - 6)); i <= Math.min(w - 1, Math.ceil(x + 6)); i++)
      d[j * w + i] += amp * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sig * sig));
};
/** `n` dates, `years` apart in total, each `w` pixels square with unit noise and the same fixed stars. */
export function sky(n: number, w: number, years: number, seed = 7, stars = 12): { norms: Norm[]; ms: number[]; starsAt: { x: number; y: number }[] } {
  const R = rand(seed), g = () => Math.sqrt(-2 * Math.log(1 - R())) * Math.cos(2 * Math.PI * R());
  const starsAt = Array.from({ length: stars }, () => ({ x: 8 + R() * (w - 16), y: 8 + R() * (w - 16), a: 20 + R() * 300 }));
  const t0 = Date.UTC(2012, 0, 1);
  const ms = Array.from({ length: n }, (_, i) => t0 + (i / (n - 1)) * years * YEAR);
  const norms = ms.map(() => {
    const d = new Float32Array(w * w);
    for (let k = 0; k < d.length; k++) d[k] = g();
    for (const s of starsAt) blob(d, w, s.x, s.y, s.a * (1 + 0.02 * g())); // stars flicker a little
    return { w, h: w, data: d, sigma: 1 };
  });
  return { norms, ms, starsAt };
}

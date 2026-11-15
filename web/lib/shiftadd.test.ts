import { describe, it, expect } from "vitest";
import { shiftAndAdd, searchMotion, pixelShift, staticResiduals, peakNear, selected } from "./shiftadd";
import { injectObject } from "./planetx";
import { sky, blob, YEAR } from "./testsky";

const W = 128, FOV = (W * 2) / 60; // 2 arcsec per pixel
const PM_E = 3000, PM_N = -1500;   // mas/yr: 1.5 px/yr to the left, 0.75 px/yr downward

function scene(snr: number, stars = 12) {
  const s = sky(12, W, 10, 11, stars);
  const refMs = s.ms[s.ms.length - 1];
  const inj = injectObject(s.norms, s.ms, { x0: 0.4, y0: 0.6, snr, pmEastMasYr: PM_E, pmNorthMasYr: PM_N, refMs, fovArcmin: FOV });
  return { ...s, norms: inj.norms, refMs, at: { x: 0.4 * W - 0.5, y: 0.6 * W - 0.5 } };
}

describe("direction conventions", () => {
  it("east is left and north is up", () => {
    const later = pixelShift(YEAR, 0, FOV, W, 2000, 0); // 2 arcsec east in one year = 1 pixel
    expect(later.dx).toBeCloseTo(-1, 5); expect(later.dy).toBeCloseTo(0, 5);
    const north = pixelShift(YEAR, 0, FOV, W, 0, 2000);
    expect(north.dx).toBeCloseTo(0, 5); expect(north.dy).toBeCloseTo(-1, 5);
  });
  it("a blob drawn further left each year stacks up only for an eastward motion", () => {
    const s = sky(8, W, 7, 3, 0);
    s.norms.forEach((n, i) => blob(n.data, W, 80 - 2 * i, 50, 5)); // 2 px left per year = 4 arcsec/yr east
    const ref = s.ms[0];
    const east = peakNear(shiftAndAdd(s.norms, s.ms, FOV, 4000, 0, ref)!, { x: 80, y: 50 }, 1)!.value;
    const west = peakNear(shiftAndAdd(s.norms, s.ms, FOV, -4000, 0, ref)!, { x: 80, y: 50 }, 1)!.value;
    expect(east).toBeGreaterThan(10); expect(west).toBeLessThan(6);
  });
});

describe("shiftAndAdd", () => {
  it("keeps pure noise at about 1 after stacking", () => {
    const s = sky(12, W, 10, 5, 0);
    const st = shiftAndAdd(s.norms, s.ms, FOV, 1234, -777)!;
    let n = 0, ss = 0;
    for (const v of st.data) if (Number.isFinite(v)) { n++; ss += v * v; }
    expect(Math.sqrt(ss / n)).toBeGreaterThan(0.9); expect(Math.sqrt(ss / n)).toBeLessThan(1.1);
  });
  it("a faint mover adds up at its true motion, not at zero motion or on any single date", () => {
    const { norms, ms, refMs, at } = scene(4, 0);
    const right = peakNear(shiftAndAdd(norms, ms, FOV, PM_E, PM_N, refMs)!, at, 1)!.value;
    const still = peakNear(shiftAndAdd(norms, ms, FOV, 0, 0, refMs)!, at, 1)!.value;
    const single = Math.max(...norms.map((n, i) => { const p = pixelShift(ms[i], refMs, FOV, W, PM_E, PM_N); return peakNear(n!, { x: at.x + p.dx, y: at.y + p.dy }, 1)!.value; }));
    expect(right).toBeGreaterThan(9);
    expect(right).toBeGreaterThan(still * 2);
    expect(right).toBeGreaterThan(single * 1.5);
  });
  it("removing what stays put leaves the mover as the brightest thing despite bright stars", () => {
    const { norms, ms, refMs, at } = scene(5);
    const pk = peakNear(shiftAndAdd(norms, ms, FOV, PM_E, PM_N, refMs, { removeStatic: true })!)!;
    expect(Math.hypot(pk.x - at.x, pk.y - at.y)).toBeLessThan(1.5);
    expect(pk.value).toBeGreaterThan(10);
  });
  it("only combines the groups the caller selects", () => {
    const { norms, ms } = scene(5, 0);
    const groups = ms.map((_, i) => (i < 8 ? "wise" : "spherex"));
    expect(selected(norms, { groups, include: ["spherex"] })).toEqual([8, 9, 10, 11]);
    expect(shiftAndAdd(norms, ms, FOV, 0, 0, undefined, { groups, include: ["wise"] })!.used).toBe(8);
    const res = staticResiduals(norms, { groups, include: ["spherex"] });
    expect(res.slice(0, 8).every((r) => r === null)).toBe(true); expect(res[9]).not.toBeNull();
  });
});

describe("searchMotion", () => {
  it("recovers the motion of a faint mover from a click near it", () => {
    const { norms, ms, refMs, at } = scene(5);
    const t0 = performance.now();
    const r = searchMotion(norms, ms, FOV, { x: Math.round(at.x) + 1, y: Math.round(at.y) - 1 }, { refMs, removeStatic: true, maxRateArcsecYr: 8 })!;
    console.log(`searchMotion ${W}x${W}x12: ${(performance.now() - t0).toFixed(0)} ms, ${r.tried} motions, snr ${r.snr.toFixed(1)}`);
    expect(Math.hypot(r.pmEastMasYr - PM_E, r.pmNorthMasYr - PM_N)).toBeLessThan(0.15 * Math.hypot(PM_E, PM_N));
    expect(r.pmEastMasYr).toBeGreaterThan(0); expect(r.pmNorthMasYr).toBeLessThan(0);
    expect(r.snr).toBeGreaterThan(10); expect(r.snr).toBeGreaterThan(2 * r.snrStill);
  });
});

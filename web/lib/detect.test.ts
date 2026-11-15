import { describe, it, expect } from "vitest";
import { findMovers, scoreFinder } from "./detect";
import { injectObject } from "./planetx";
import { sky, blob } from "./testsky";

const W = 128, FOV = (W * 2) / 60; // 2 arcsec per pixel

describe("injectObject", () => {
  it("puts the object where asked and moves it east = left, north = up", () => {
    const s = sky(5, W, 4, 2, 0);
    const blank = s.norms.map((n) => ({ ...n, data: new Float32Array(n.data.length) }));
    const r = injectObject(blank, s.ms, { x0: 0.5, y0: 0.25, snr: 20, pmEastMasYr: 4000, pmNorthMasYr: 2000, refMs: s.ms[0], fovArcmin: FOV });
    const peak = (d: Float32Array) => { let k = 0; for (let i = 1; i < d.length; i++) if (d[i] > d[k]) k = i; return { x: k % W, y: (k / W) | 0, v: d[k] }; };
    const first = peak(r.norms[0]!.data), last = peak(r.norms[4]!.data);
    expect(Math.abs(first.x - (0.5 * W - 0.5))).toBeLessThanOrEqual(0.5); expect(Math.abs(first.y - (0.25 * W - 0.5))).toBeLessThanOrEqual(0.5);
    expect(first.v).toBeGreaterThan(17); expect(first.v).toBeLessThanOrEqual(20);
    expect(last.x - first.x).toBeCloseTo(-8, 0); // 4 arcsec/yr east for 4 years at 2 arcsec per pixel
    expect(last.y - first.y).toBeCloseTo(-4, 0);
    expect(r.track[4].x).toBeCloseTo(0.5 - 16 / (FOV * 60), 4);
    expect(r.inView).toBe(5);
  });
});

describe("findMovers", () => {
  it("finds the mover first, with the right speed and direction, and nothing on fixed stars", () => {
    const s = sky(12, W, 10, 21);
    const inj = injectObject(s.norms, s.ms, { x0: 0.45, y0: 0.55, snr: 8, pmEastMasYr: -2500, pmNorthMasYr: 1800, refMs: (s.ms[0] + s.ms[11]) / 2, fovArcmin: FOV });
    const c = findMovers(inj.norms, s.ms, FOV);
    expect(c.length).toBeGreaterThan(0);
    const rate = Math.hypot(2.5, 1.8);
    expect(Math.abs(c[0].rateArcsecYr - rate)).toBeLessThan(0.15 * rate);
    expect(Math.hypot(c[0].pmEast + 2500, c[0].pmNorth - 1800)).toBeLessThan(0.15 * rate * 1000);
    expect(c[0].track.length).toBeGreaterThanOrEqual(9);
    for (const d of c[0].track) expect(Math.hypot(d.x - (inj.track[d.i].x * W - 0.5), d.y - (inj.track[d.i].y * W - 0.5))).toBeLessThan(1.5);
    for (const k of c) for (const d of k.track) for (const st of s.starsAt) expect(Math.hypot(d.x - st.x, d.y - st.y)).toBeGreaterThan(3);
    expect(c.length).toBe(1);
  });
  it("reports nothing when nothing moves", () => {
    const s = sky(12, W, 10, 22);
    expect(findMovers(s.norms, s.ms, FOV)).toEqual([]);
  });
  it("reports east for a blob drawn further left each date", () => {
    const s = sky(8, W, 7, 23, 4);
    s.norms.forEach((n, i) => blob(n.data, W, 90 - 3 * i, 40 + i, 10)); // 3 px left, 1 px down per year
    const c = findMovers(s.norms, s.ms, FOV);
    expect(c[0].pmEast).toBeGreaterThan(5000); expect(c[0].pmEast).toBeLessThan(7000); // 6 arcsec/yr east
    expect(c[0].pmNorth).toBeLessThan(-1500); expect(c[0].pmNorth).toBeGreaterThan(-2500); // 2 arcsec/yr south
  });
  it("does not link two flickering stars seen at two clumps of dates into a mover", () => {
    const s = sky(10, W, 10, 24, 0);
    s.norms.forEach((n, i) => blob(n.data, W, i < 4 ? 40 : 70, i < 4 ? 40 : 60, i < 4 || i > 6 ? 12 : 0));
    expect(findMovers(s.norms, s.ms, FOV)).toEqual([]);
  });
  it("is fast enough for 256 x 256 x 30 dates, and scoreFinder gives an honest tally", async () => {
    const s = sky(30, 256, 16, 25, 40);
    const fov = (256 * 2.75) / 60;
    findMovers(s.norms, s.ms, fov);
    const t0 = performance.now();
    const base = findMovers(s.norms, s.ms, fov);
    const ms = performance.now() - t0;
    const sc = await scoreFinder(s.norms, s.ms, fov, 12);
    console.log(`findMovers 256x256x30: ${ms.toFixed(0)} ms; scoreFinder ${sc.msPerRun.toFixed(0)} ms per run; ` + sc.levels.map((l) => `${l.name} ${l.found}/${l.total}`).join(", ") + `; false alarms ${sc.falseAlarms}, spurious ${sc.spurious}`);
    expect(base.length).toBe(0);
    expect(ms).toBeLessThan(1500);
    expect(sc.trials).toBe(12);
    expect(sc.levels[0].found).toBeGreaterThanOrEqual(sc.levels[0].total - 1);
    expect(sc.levels[1].found).toBeGreaterThanOrEqual(sc.levels[1].total - 1);
    expect(sc.falseAlarms).toBe(0);
  }, 60000);
});

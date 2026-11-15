import { describe, expect, it } from "vitest";
import { knownAt, pickKnownTimes, propagateGaia, skyToFrac, buildLinks, type GaiaSource, type KnownObject } from "./overlays";

const barnard: GaiaSource = { source_id: "4472832130942575872", ra: 269.44850252543836, dec: 4.739420051112412, pmra: -801.5509783684709, pmdec: 10362.394206546573, gmag: 8.19, ref_epoch: 2016.0 };
const view = { ra: 269.446268, dec: 4.768204, fov: 5 };

describe("overlays", () => {
  it("moves Barnard's Star to the field centre by 2026", () => {
    const p = propagateGaia(barnard, Date.UTC(2026, 0, 1, 12));
    const f = skyToFrac(p.ra, p.dec, view);
    expect(Math.abs(f.x - 0.5)).toBeLessThan(0.004);
    expect(Math.abs(f.y - 0.5)).toBeLessThan(0.004);
    const f0 = skyToFrac(barnard.ra, barnard.dec, view); // 2016: 104 arcsec south, slightly east
    expect(f0.y).toBeGreaterThan(0.8);
    expect(f0.x).toBeLessThan(0.5);
  });
  it("picks the nearest time and moves the asteroid along its motion", () => {
    const o: KnownObject = { time: "2026-01-10T00:00:00Z", name: "Ceres", number: 1, ra: 11.323506, dec: -4.159246, vmag: 8.9, motion_arcsec_hr: 37.6, dra_arcsec_hr: 29.8116, ddec_arcsec_hr: 22.9165 };
    const far: KnownObject = { ...o, time: "2026-03-10T00:00:00Z", ra: 30 };
    const r = knownAt([far, o], Date.parse("2026-01-10T01:00:00Z"));
    expect(r).toHaveLength(1);
    expect(r[0].ra).toBeCloseTo(11.33185, 4); // JPL Horizons one hour later
    expect(r[0].dec).toBeCloseTo(-4.15287, 4);
    expect(knownAt([o], Date.parse("2026-01-12T00:00:00Z"))).toHaveLength(0);
  });
  it("reduces exposure times", () => {
    const t = pickKnownTimes(["2026-01-10T00:00:10Z", "2026-01-10T00:30:00Z", "2026-01-10T01:00:00Z", "2026-06-01T00:00:00Z"]);
    expect(t).toEqual(["2026-01-10T00:30:00Z", "2026-06-01T00:00:00Z"]);
    const many = Array.from({ length: 100 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString());
    expect(pickKnownTimes(many).length).toBe(12);
  });
  it("builds links", () => {
    expect(buildLinks(133.795129, -7.245147).find((l) => l.id === "wiseview")!.url).toBe("https://byw.tools/wiseview#ra=133.795129&dec=-7.245147&size=176&band=2");
  });
});

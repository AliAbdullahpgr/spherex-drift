import { describe, it, expect } from "vitest";
import { parseCoords, matchTargets, resolveInput, pix2sky, sky2pix } from "./coords";

const targets = [
  { id: "barnard", name: "Barnard's Star", ra: 269.45, dec: 4.69 },
  { id: "epsindib", name: "Epsilon Indi B", ra: 330.87, dec: -56.79 },
  { id: "wise0855", name: "WISE 0855", ra: 133.795129, dec: -7.245147 },
  { id: "rwaur", name: "RW Aurigae", ra: 76.96, dec: 30.4 },
  { id: "rdra", name: "R Draconis", ra: 244.4, dec: 66.76 },
];
const near = (r: any, ra: number, dec: number, tol = 1e-3) => {
  expect(r.ok).toBe(true);
  expect(Math.abs(r.ra - ra)).toBeLessThan(tol);
  expect(Math.abs(r.dec - dec)).toBeLessThan(tol);
};

describe("parseCoords", () => {
  it("decimal with space", () => near(parseCoords("133.7951 -7.2451"), 133.7951, -7.2451));
  it("decimal with comma", () => near(parseCoords("133.7951, -7.2451"), 133.7951, -7.2451));
  it("sexagesimal hms/dms", () => near(parseCoords("08h55m10.831s -07d14m42.53s"), 133.7951, -7.2451, 2e-4));
  it("sexagesimal colons", () => near(parseCoords("08:55:10.83 -07:14:42.5"), 133.7951, -7.2451, 2e-4));
  it("sexagesimal spaces", () => near(parseCoords("08 55 10.83 -07 14 42.5"), 133.7951, -7.2451, 2e-4));
  it("positive dec with plus sign", () => near(parseCoords("17h57m48.5s +04d41m36s"), 269.452, 4.693, 1e-3));
  it("dec -00 keeps sign", () => near(parseCoords("10 00 00 -00 30 00"), 150, -0.5));
  it("rejects out of range", () => {
    expect(parseCoords("400 10").ok).toBe(false);
    expect(parseCoords("10 95").ok).toBe(false);
  });
  it("rejects junk", () => {
    expect(parseCoords("Orion Nebula").ok).toBe(false);
    expect(parseCoords("").ok).toBe(false);
    expect(parseCoords("12 13 14").ok).toBe(false);
  });
});

describe("matchTargets", () => {
  it("exact + prefix", () => {
    expect(matchTargets("WISE 0855", targets)[0].id).toBe("wise0855");
    expect(matchTargets("barnards", targets)[0].id).toBe("barnard");
    expect(matchTargets("Barnard's Star", targets)[0].id).toBe("barnard");
    expect(matchTargets("r dra", targets)[0].id).toBe("rdra");
    expect(matchTargets("rw aur", targets)[0].id).toBe("rwaur");
  });
  it("never matches on a single word / letter", () => {
    expect(matchTargets("r", targets)).toEqual([]);
    expect(matchTargets("Orion Nebula", targets)).toEqual([]);
    expect(matchTargets("the star r", targets)).toEqual([]);
    expect(matchTargets("star", targets)).toEqual([]);
    expect(matchTargets("indi", targets)).toEqual([]);
  });
});

describe("resolveInput", () => {
  it("unknown name gives message", () => {
    const r = resolveInput("Orion Nebula", targets);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not one of the quick-pick/);
  });
  it("coords", () => near(resolveInput("08h55m10.831s -07d14m42.53s", targets), 133.7951, -7.2451, 2e-4));
  it("name", () => near(resolveInput("WISE 0855", targets), 133.795129, -7.245147));
});

describe("projection", () => {
  it("round trips and orients N up, E left", () => {
    const s = pix2sky(100, 100, 256, 1.2, 133.8, -7.2);
    const p = sky2pix(s.ra, s.dec, 256, 1.2, 133.8, -7.2);
    expect(Math.abs(p.x - 100)).toBeLessThan(1e-6);
    const left = pix2sky(0, 127.5, 256, 1.2, 133.8, -7.2);
    expect(left.ra).toBeGreaterThan(133.8); // east (larger RA) is left
    const up = pix2sky(127.5, 0, 256, 1.2, 133.8, -7.2);
    expect(up.dec).toBeGreaterThan(-7.2);
  });
});

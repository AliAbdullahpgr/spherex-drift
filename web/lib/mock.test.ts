import { describe, expect, it } from "vitest";
import { findMovers } from "./detect";
import { mockFrameImage, mockSpectrum, mockWise, MOCK_TARGETS } from "./mock";
import { lightCurve, pickMeasure } from "./photometry";
import { normalise } from "./render";

describe("labelled demonstration data", () => {
  it("keeps the demo mover detectable across the WISE dates", () => {
    const target = MOCK_TARGETS.find(t => t.id === "wise0855")!;
    const frames = mockWise(target.ra, target.dec, 5).frames.filter(f => f.wavelength_um === 4.6);
    const norms = frames.map(f => normalise(mockFrameImage(f.id, target.ra, target.dec, 5, 256)));
    const movers = findMovers(norms, frames.map(f => Date.parse(f.time)), 5, { maxRateArcsecYr: 40 });
    expect(movers.some(m => Math.abs(m.rateArcsecYr - 8.1) < 1)).toBe(true);
  });
  it("provides enough observations for variable-star light curves", () => {
    const target = MOCK_TARGETS.find(t => t.id === "rwaur")!;
    const spectrum = mockSpectrum(target.ra, target.dec, 6, target, 5);
    const curves = lightCurve(pickMeasure(spectrum.points));
    expect(curves.length).toBe(6);
    expect(curves.some(c => c.sigma >= 5 && Math.abs(c.change) > .1)).toBe(true);
  });
});

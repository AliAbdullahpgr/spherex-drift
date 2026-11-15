import { describe, expect, it } from "vitest";
import { wiseLightCurve } from "./photometry";
import type { Epoch } from "./epochs";

describe("WISE quick-look brightness", () => {
  it("restores each epoch's linear intensity scale before comparing brightness", () => {
    const epochs = [0, 1, 2].map((i) => ({ survey: "wise", ms: i * 365.25 * 86400000,
      pass: i + 1, wl: 4.6 } as Epoch));
    const norms = [1, 5, 2].map((sigma, i) => {
      const data = new Float32Array(32 * 32);
      for (let y = 14; y <= 17; y++) for (let x = 14; x <= 17; x++) data[y * 32 + x] = (i === 2 ? 200 : 100) / sigma;
      return { w: 32, h: 32, data, sigma };
    });
    const curve = wiseLightCurve(norms, epochs, 1)[0];
    expect(curve.points).toHaveLength(3);
    expect(curve.points[1].v / curve.points[0].v).toBeCloseTo(1);
    expect(curve.points[2].v / curve.points[0].v).toBeCloseTo(2);
    expect(curve.sigma).toBe(0); // preview measurements make no significance claim
  });
});

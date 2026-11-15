import { describe, expect, it } from "vitest";
import { DEFAULTS, readState, writeState } from "./urlstate";

describe("shared viewer links", () => {
  it("round-trips viewer settings and a selected pass range", () => {
    const state = { ...DEFAULTS, ra: 10, dec: -20, det: 2, mode: "diff" as const, wise: true, pf: 2, pt: 3, play: false, fov: 10 };
    expect(readState(writeState(state))).toEqual(state);
  });
  it.each(["9", "0", "1.5", "-2", "NaN"])("rejects invalid detector %s", (detector) => {
    expect(readState(`detector=${detector}`).det).toBeNull();
  });
  it("keeps linked brightness, field of view and speed within the actual control ranges", () => {
    const state = readState("bp=99&wp=1&fov=0.01&speed=100");
    expect(state).toMatchObject({ bp: 95, wp: 96, fov: 1, speed: 6 });
  });
  it("orders and rounds pass filters to avoid a blank view", () => {
    expect(readState("pf=3.5&pt=1.2")).toMatchObject({ pf: 1, pt: 3 });
  });
  it("preserves older two-date difference links", () => {
    expect(readState("mode=diff&a=0&b=2").diff).toBe("pair");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { getSpectrum, setMock } from "./api";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("spectrum requests", () => {
  const view = { ra: 133.8, dec: -7.2, fov: 5 };
  function stalledFetch() {
    setMock(false);
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      const signal = options.signal!;
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("stops a stalled archive request after 30 seconds with a useful retry message", async () => {
    vi.useFakeTimers();
    const fetch = stalledFetch();
    const result = getSpectrum(view.ra, view.dec, view);
    const assertion = expect(result).rejects.toThrow("longer than 30 seconds");
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels superseded requests without reporting an archive timeout", async () => {
    vi.useFakeTimers(); stalledFetch();
    const controller = new AbortController();
    const result = getSpectrum(view.ra, view.dec, view, 6, controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a successful measurement", async () => {
    vi.useFakeTimers(); setMock(false);
    const spectrum = { points: [{ wavelength_um: 2, flux_mjy_sr: 1 }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => spectrum }));
    expect(await getSpectrum(view.ra, view.dec, view)).toEqual(spectrum);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// The ONLY module that talks to the backend (or the mock). See CONTRACT.md.
import type { Frame, FramesResponse, Img, SpectrumResponse, Target, View } from "./types";
import { EXAMPLE_TARGETS } from "./targets";
import { MOCK_TARGETS, mockFrameImage, mockFrames, mockSpectrum, mockStack, mockWise } from "./mock";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");
export const IMG_SIZE = 256;

let mockMode = false;
const fieldSources = new Map<string, string>();
const fieldKey = (v: View) => `${v.ra.toFixed(5)}|${v.dec.toFixed(5)}|${v.fov}`;
export function setMock(v: boolean) { mockMode = v; }
export function isMock() { return mockMode; }

/** Decide mock vs real. `?mock=1` forces mock; otherwise probe /health, fall back to mock if unreachable. */
export async function detectBackend(forceMock: boolean): Promise<{ mock: boolean; reason?: string }> {
  if (forceMock) { mockMode = true; return { mock: true, reason: "forced" }; }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(`${API_URL}/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error("status " + r.status);
    mockMode = false;
    return { mock: false };
  } catch {
    mockMode = true;
    return { mock: true, reason: "unreachable" };
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(signal: AbortSignal | undefined, timeoutMs: number, message: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try { return await run(controller.signal); }
  catch (error) { if (timedOut) throw new Error(message); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

async function getJSON<T>(path: string, signal?: AbortSignal, timeoutMs = 60000, message = "The archive did not respond within 60 seconds. Try again."): Promise<T> {
  return request(signal, timeoutMs, message, async (signal) => {
    const r = await fetch(API_URL + path, { signal });
    if (!r.ok) {
      let d = "";
      try { d = (await r.json()).detail; } catch {}
      throw new Error(`${r.status} ${d || r.statusText}`);
    }
    return await r.json();
  });
}

/** Parse float32 little-endian payload. Header X-Shape "h,w" preferred; tolerates a real .npy header. */
export function parseNpy(buf: ArrayBuffer, shapeHeader?: string | null): Img {
  let off = 0;
  let h = 0, w = 0;
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x93 && u8[1] === 0x4e) { // \x93NUMPY
    const major = u8[6];
    const hl = major === 1 ? u8[8] | (u8[9] << 8) : new DataView(buf).getUint32(8, true);
    off = (major === 1 ? 10 : 12) + hl;
    const hdr = new TextDecoder().decode(u8.slice(major === 1 ? 10 : 12, off));
    const m = hdr.match(/\((\d+),\s*(\d+)/);
    if (m) { h = +m[1]; w = +m[2]; }
  }
  const n = (buf.byteLength - off) / 4;
  if (shapeHeader) {
    const p = shapeHeader.split(",").map((x) => parseInt(x.trim(), 10));
    if (p.length >= 2 && p[0] * p[1] === n) { h = p[0]; w = p[1]; }
  }
  if (!h || !w || h * w !== n) { h = w = Math.round(Math.sqrt(n)); }
  if (h * w !== n) throw new Error("Image payload has an unexpected size");
  // copy to guarantee alignment; platform is little-endian in practice
  const data = new Float32Array(n);
  new Uint8Array(data.buffer).set(u8.subarray(off, off + n * 4));
  return { w, h, data };
}

async function getNpy(path: string, signal?: AbortSignal): Promise<Img> {
  return request(signal, 60000, "The image took longer than 60 seconds. Retry the failed images.", async (signal) => {
    const r = await fetch(API_URL + path, { signal });
    if (!r.ok) {
      let d = "";
      try { d = (await r.json()).detail; } catch {}
      throw new Error(`${r.status} ${d || r.statusText}`);
    }
    return parseNpy(await r.arrayBuffer(), r.headers.get("X-Shape"));
  });
}

const q = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

export async function getTargets(): Promise<Target[]> {
  if (mockMode) return MOCK_TARGETS;
  try { return await getJSON<Target[]>("/targets"); } catch { return EXAMPLE_TARGETS; }
}

/**
 * List the exposures covering a position. `quick` skips the per-exposure check (wavelengths are then
 * band centres and there are no quality flags) and answers in a few seconds instead of up to a minute.
 */
export async function getFrames(v: View, signal?: AbortSignal, quick = false): Promise<FramesResponse> {
  if (mockMode) { await delay(quick ? 80 : 250); return mockFrames(v.ra, v.dec, v.fov); }
  const result = await getJSON<FramesResponse>(`/frames?${q({ ra: v.ra, dec: v.dec, fov: v.fov, group: "detector", survey: "spherex", probe: quick ? "false" : "true" })}`, signal);
  fieldSources.set(fieldKey(v), result.source || "exposures");
  return result;
}

/** Look up an object name (any star, galaxy, nebula) with the backend's name service. */
export async function resolveName(name: string, signal?: AbortSignal): Promise<{ name: string; ra: number; dec: number } | null> {
  if (mockMode) return null;
  return request(signal, 15000, "Name lookup timed out. Enter RA and Dec, or try again.", async (signal) => {
    const r = await fetch(`${API_URL}/resolve?${q({ name })}`, { signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("The name lookup service is not answering. Enter RA and Dec instead.");
    return await r.json();
  });
}

export async function getWiseFrames(v: View, signal?: AbortSignal): Promise<FramesResponse> {
  if (mockMode) { await delay(150); return mockWise(v.ra, v.dec, v.fov); }
  return getJSON(`/wise/frames?${q({ ra: v.ra, dec: v.dec, fov: v.fov })}`, signal);
}

/** Single exposure (SPHEREx or WISE). Uses the frame's own image_url so the backend controls routing. */
export async function getFrameImage(f: Frame, v: View, signal?: AbortSignal): Promise<Img> {
  if (mockMode) { await delay(120 + Math.random() * 200); return mockFrameImage(f.id, v.ra, v.dec, v.fov, IMG_SIZE); }
  const u = new URL(f.image_url, "http://localhost/");
  u.searchParams.set("ra", String(v.ra)); u.searchParams.set("dec", String(v.dec)); u.searchParams.set("fov", String(v.fov));
  u.searchParams.set("size", String(IMG_SIZE)); u.searchParams.set("format", "npy");
  return getNpy(u.pathname + u.search, signal);
}

export async function getStack(v: View, pass: number, detector: number, signal?: AbortSignal): Promise<Img> {
  if (mockMode) { await delay(200 + Math.random() * 300); return mockStack(v.ra, v.dec, v.fov, pass, detector, IMG_SIZE); }
  return getNpy(`/stack?${q({ ra: v.ra, dec: v.dec, fov: v.fov, pass, detector, size: IMG_SIZE, format: "npy" })}`, signal);
}

export async function getSpectrum(ra: number, dec: number, center: View, radiusArcsec = 6, signal?: AbortSignal): Promise<SpectrumResponse> {
  if (mockMode) { await delay(300); return mockSpectrum(ra, dec, radiusArcsec, center, center.fov); }
  // cra/cdec = centre of the field on screen: lets the backend reuse pixels it already has (fast).
  return getJSON(`/spectrum?${q({ ra, dec, radius_arcsec: radiusArcsec, cra: center.ra, cdec: center.dec, fov: center.fov, source: fieldSources.get(fieldKey(center)) || "exposures" })}`, signal, 30000,
    "The archive took longer than 30 seconds. Try again, or choose a spot closer to the centre.");
}

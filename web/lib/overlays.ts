// Catalogue overlays and context: Gaia stars, known solar-system objects, a picture of the same field from
// another survey, and look-up links. Backend: api/app/overlays.py (see CONTRACT.md "Catalogue overlays").
// Catalogue failures are kept distinct from a successful empty result.
import { API_URL, isMock } from "./api";
import { sky2pix } from "./coords";
import type { View } from "./types";

/** One Gaia DR3 star. ra/dec are for `ref_epoch` (2016.0); pmra is pm_ra*cos(dec); both in mas/yr. */
export type GaiaSource = {
  source_id: string; ra: number; dec: number; pmra: number | null; pmdec: number | null;
  gmag?: number | null; ref_epoch?: number;
};
/** A known asteroid, comet or planet at one of the requested times (IMCCE SkyBoT, seen from Earth's centre). */
export type KnownObject = {
  time: string; name: string; number: number | null; ra: number; dec: number; vmag: number | null;
  class?: string | null; motion_arcsec_hr: number | null;
  /** Motion on the sky towards east and north, arcsec per hour. */
  dra_arcsec_hr?: number | null; ddec_arcsec_hr?: number | null; err_arcsec?: number | null;
};
export type ContextInfo = {
  available: boolean; source: string | null; label: string | null; kind: "visible" | "infrared" | null;
  about?: string | null; note?: string | null;
};
export type SkyLink = { id: string; label: string; url: string; about?: string };

export const GAIA_COLOR = "#4dd0e1";
export const KNOWN_COLOR = "#ff6ad5";
/** Stars moving faster than this (arcsec per year) get an arrow. */
export const ARROW_MIN_ARCSEC_YR = 0.2;
const YEAR_MS = 365.25 * 86400000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

const qs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
const viewQ = (v: View) => qs({ ra: v.ra, dec: v.dec, fov: v.fov });

async function json<T>(path: string, signal?: AbortSignal, timeoutMs = 30000): Promise<T | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const r = await fetch(API_URL + path, { signal: controller.signal });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

// ---------------------------------------------------------------- geometry
export function epochYear(ms: number): number { return 2000 + (ms - J2000_MS) / YEAR_MS; }

/** Total proper motion in arcsec per year (0 when Gaia has none). */
export function pmArcsecYr(s: GaiaSource): number { return Math.hypot(s.pmra ?? 0, s.pmdec ?? 0) / 1000; }

/** Where the star is at a given time, moved along its proper motion from the catalogue epoch. */
export function propagateGaia(s: GaiaSource, epochMs: number): { ra: number; dec: number } {
  const dt = epochYear(epochMs) - (s.ref_epoch ?? 2016.0);
  const dec = s.dec + ((s.pmdec ?? 0) * dt) / 3.6e6;
  const ra = s.ra + ((s.pmra ?? 0) * dt) / 3.6e6 / Math.max(1e-6, Math.cos((s.dec * Math.PI) / 180));
  return { ra: ((ra % 360) + 360) % 360, dec };
}

/** Sky position -> fraction (0..1) of the square image: x from the left (east) edge, y from the top (north). */
export function skyToFrac(ra: number, dec: number, v: View): { x: number; y: number } {
  const n = 256;
  const p = sky2pix(ra, dec, n, (v.fov * 60) / n, v.ra, v.dec);
  return { x: (p.x + 0.5) / n, y: (p.y + 0.5) / n };
}

/**
 * Known objects for the requested time closest to `epochMs`, each moved along its hourly motion to
 * `epochMs`. Nothing is returned when the closest requested time is more than `maxHours` away.
 */
export function knownAt(objs: KnownObject[], epochMs: number, maxHours = 6): KnownObject[] {
  let best = Infinity, bestT = "";
  const seen = new Set<string>();
  for (const o of objs) {
    if (seen.has(o.time)) continue;
    seen.add(o.time);
    const d = Math.abs(Date.parse(o.time) - epochMs);
    if (d < best) { best = d; bestT = o.time; }
  }
  if (!bestT || best > maxHours * 3600000) return [];
  const h = (epochMs - Date.parse(bestT)) / 3600000;
  return objs.filter((o) => o.time === bestT).map((o) => ({
    ...o,
    dec: o.dec + ((o.ddec_arcsec_hr ?? 0) * h) / 3600,
    ra: o.ra + ((o.dra_arcsec_hr ?? 0) * h) / 3600 / Math.max(1e-6, Math.cos((o.dec * Math.PI) / 180)),
  }));
}

/** Reduce many exposure times to at most `max` representative ones (exposures within `hours` share one). */
export function pickKnownTimes(timesIso: string[], max = 12, hours = 4): string[] {
  const ms = [...new Set(timesIso.map((t) => Date.parse(t)).filter((t) => isFinite(t)))].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const t of ms) {
    const g = groups[groups.length - 1];
    if (g && t - g[0] <= hours * 3600000) g.push(t); else groups.push([t]);
  }
  let reps = groups.map((g) => g[Math.floor(g.length / 2)]);
  if (reps.length > max) reps = Array.from({ length: max }, (_, i) => reps[Math.round((i * (reps.length - 1)) / (max - 1))]);
  return [...new Set(reps)].map((t) => new Date(Math.round(t / 60000) * 60000).toISOString().replace(".000Z", "Z"));
}

// ---------------------------------------------------------------- data
function mockGaia(v: View): GaiaSource[] {
  const deg = v.fov / 60, cd = Math.max(0.05, Math.cos((v.dec * Math.PI) / 180));
  const at = (id: string, dx: number, dy: number, pmra: number | null, pmdec: number | null, gmag: number): GaiaSource =>
    ({ source_id: id, ra: v.ra + (dx * deg) / cd, dec: v.dec + dy * deg, pmra, pmdec, gmag, ref_epoch: 2016.0 });
  return [
    at("mock-1", 0.02, -0.33, -801.6, 10362.4, 8.2), at("mock-2", -0.31, 0.22, 4.1, -7.9, 11.4),
    at("mock-3", 0.27, 0.31, -12.3, 2.2, 12.9), at("mock-4", 0.36, -0.18, 310.0, -240.0, 13.6),
    at("mock-5", -0.12, -0.38, 1.0, 0.4, 14.8), at("mock-6", -0.4, -0.05, null, null, 16.1),
  ];
}
function mockKnown(v: View, times: string[]): KnownObject[] {
  const t0 = times.length ? Date.parse(times[0]) : 0;
  return times.map((t) => {
    const h = Math.max(-6, Math.min(6, (Date.parse(t) - t0) / 3600000));
    return { time: t, name: "Demo asteroid", number: 99999, ra: v.ra + (v.fov / 60) * 0.2 - (h * 28) / 3600, dec: v.dec + (v.fov / 60) * 0.15 + (h * 11) / 3600,
      vmag: 15.2, class: "MB>Middle", motion_arcsec_hr: 30.1, dra_arcsec_hr: -28, ddec_arcsec_hr: 11, err_arcsec: 0.05 };
  });
}

/** Gaia DR3 stars in the field (up to 300 brightest plus every fast mover). Empty when no service answers. */
export async function getGaia(v: View, signal?: AbortSignal): Promise<GaiaSource[]> {
  return (await lookupGaia(v, signal)).items;
}
export type CatalogueResult<T> = { items: T[]; note?: string; unavailable: boolean };
export async function lookupGaia(v: View, signal?: AbortSignal): Promise<CatalogueResult<GaiaSource>> {
  if (isMock()) return { items: mockGaia(v), unavailable: false };
  const j = await json<{ sources: GaiaSource[]; note?: string }>(`/gaia?${viewQ(v)}`, signal, 45000);
  return { items: j?.sources ?? [], unavailable: !j || !!j.note,
    note: j?.note || (!j ? "The Gaia catalogue could not be reached. Try again." : undefined) };
}
/** Kept for older callers. */
export const getGaiaSources = getGaia;

/**
 * Known solar-system objects in the field. Pass every exposure time; they are reduced to at most 12
 * representative times (the first lookup takes 5 to 9 seconds per time, later ones are instant).
 */
export async function getKnownObjects(v: View, timesIso: string[], signal?: AbortSignal): Promise<KnownObject[]> {
  return (await lookupKnownObjects(v, timesIso, signal)).items;
}
export async function lookupKnownObjects(v: View, timesIso: string[], signal?: AbortSignal): Promise<CatalogueResult<KnownObject>> {
  const times = pickKnownTimes(timesIso);
  if (!times.length) return { items: [], unavailable: false };
  if (isMock()) return { items: mockKnown(v, times), unavailable: false };
  const j = await json<{ objects: KnownObject[]; note?: string }>(`/known?${viewQ(v)}&times=${encodeURIComponent(times.join(","))}`, signal, 90000);
  return { items: j?.objects ?? [], unavailable: !j || !!j.note,
    note: j?.note || (!j ? "The asteroid catalogue could not be reached. Try again." : undefined) };
}

/** URL of the colour picture of the same field from another survey (JPEG, north up, east left). */
export function contextUrl(v: View, size = 512): string { return `${API_URL}/context?${viewQ(v)}&size=${size}`; }

/** Which survey the context picture comes from, or available=false when none covers the field. */
export async function getContextInfo(v: View, signal?: AbortSignal): Promise<ContextInfo> {
  const none: ContextInfo = { available: false, source: null, label: null, kind: null };
  if (isMock()) return { ...none, note: "Demo mode has no picture from other surveys." };
  return (await json<ContextInfo>(`/context/info?${viewQ(v)}&size=512`, signal)) ?? { ...none, note: "The picture service is not answering." };
}

/** Same links the backend builds; used directly so the list works offline too. */
export function buildLinks(ra: number, dec: number): SkyLink[] {
  const r = ra.toFixed(6), d = dec.toFixed(6), c = encodeURIComponent(`${r} ${dec >= 0 ? "+" : ""}${d}`);
  return [
    { id: "simbad", label: "SIMBAD", about: "Named objects within 2 arcmin", url: `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${c}&CooFrame=ICRS&Radius=2&Radius.unit=arcmin` },
    { id: "vizier", label: "VizieR", about: "Every published catalogue, within 30 arcsec", url: `https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-c=${c}&-c.rs=30` },
    { id: "legacy", label: "Legacy Survey viewer", about: "Deep visible-light sky map", url: `https://www.legacysurvey.org/viewer?ra=${r}&dec=${d}&layer=ls-dr10&zoom=14&mark=${r},${d}` },
    { id: "wiseview", label: "WiseView", about: "WISE infrared images since 2010 as a blink movie", url: `https://byw.tools/wiseview#ra=${r}&dec=${d}&size=176&band=2` },
    { id: "finderchart", label: "IRSA finder chart", about: "The same spot in DSS, SDSS, 2MASS and WISE", url: `https://irsa.ipac.caltech.edu/applications/finderchart/servlet/api?mode=getResult&locstr=${r}+${encodeURIComponent((dec >= 0 ? "+" : "") + d)}&subsetsize=5.0` },
  ];
}
export async function getLinks(ra: number, dec: number): Promise<SkyLink[]> {
  if (isMock()) return buildLinks(ra, dec);
  const j = await json<{ links: SkyLink[] }>(`/links?${qs({ ra, dec })}`);
  return j?.links?.length ? j.links : buildLinks(ra, dec);
}

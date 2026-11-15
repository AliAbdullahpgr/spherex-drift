import type { Frame } from "./types";

export type Epoch = {
  key: string;
  survey: "spherex" | "wise";
  kind: "stack" | "frame";
  label: string;
  time: string;
  ms: number;
  pass: number;
  detector: number | null;
  wl: number;
  flags: string[];
  n: number;
  frame?: Frame; // for single frames
};

export const WISE_BAND = (wl: number) => (wl < 4 ? "W1" : "W2");
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

export type DetInfo = { detector: number; wl: number; passes: number[]; nFrames: number };

export function detectorInfo(frames: Frame[]): DetInfo[] {
  const by = new Map<number, Frame[]>();
  for (const f of frames) if (f.detector != null) (by.get(f.detector) ?? by.set(f.detector, []).get(f.detector)!).push(f);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([d, fs]) => ({
    detector: d, wl: mean(fs.map((f) => f.wavelength_um)), passes: [...new Set(fs.map((f) => f.pass))].sort((a, b) => a - b), nFrames: fs.length,
  }));
}

/** Best default detector: most passes covered, ties -> longer wavelength (brown dwarfs/movers are brighter). */
export function defaultDetector(frames: Frame[]): number {
  const info = detectorInfo(frames);
  if (!info.length) return 4;
  info.sort((a, b) => b.passes.length - a.passes.length || b.wl - a.wl);
  return info[0].detector;
}

export type EpochOpts = { src: "stack" | "frame"; detector: number; includeWise: boolean; passFrom: number; passTo: number };

export function buildEpochs(spx: Frame[], wise: Frame[], o: EpochOpts): Epoch[] {
  const out: Epoch[] = [];
  const det = spx.filter((f) => f.detector === o.detector && f.pass >= o.passFrom && f.pass <= o.passTo);
  if (o.src === "stack") {
    const passes = [...new Set(det.map((f) => f.pass))].sort((a, b) => a - b);
    for (const p of passes) {
      const fs = det.filter((f) => f.pass === p);
      const ms = mean(fs.map((f) => Date.parse(f.time)));
      out.push({
        key: `s:stack:${p}:${o.detector}`, survey: "spherex", kind: "stack", label: `Pass ${p} stack`, time: new Date(ms).toISOString(), ms,
        pass: p, detector: o.detector, wl: mean(fs.map((f) => f.wavelength_um)), flags: [...new Set(fs.flatMap((f) => f.flags))], n: fs.length,
      });
    }
  } else {
    for (const f of [...det].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
      out.push({ key: `s:frame:${f.id}`, survey: "spherex", kind: "frame", label: `Pass ${f.pass} exposure`, time: f.time, ms: Date.parse(f.time), pass: f.pass, detector: o.detector, wl: f.wavelength_um, flags: f.flags, n: 1, frame: f });
    }
  }
  if (o.includeWise && wise.length) {
    const dwl = det.length ? mean(det.map((f) => f.wavelength_um)) : 4.6;
    const bands = [...new Set(wise.map((f) => f.wavelength_um))];
    const wl = bands.sort((a, b) => Math.abs(a - dwl) - Math.abs(b - dwl))[0];
    const ws = wise.filter((f) => f.wavelength_um === wl).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const wout: Epoch[] = ws.map((f) => ({ key: `w:${f.id}`, survey: "wise" as const, kind: "frame" as const, label: `WISE ${WISE_BAND(f.wavelength_um)} ${f.time.slice(0, 7)}`, time: f.time, ms: Date.parse(f.time), pass: f.pass, detector: null, wl: f.wavelength_um, flags: f.flags, n: 1, frame: f }));
    out.unshift(...wout);
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/** Dates that can be compared pixel for pixel: same survey, same band. */
export const groupOf = (e: Epoch) => (e.survey === "wise" ? `wise:${WISE_BAND(e.wl)}` : `spherex:${e.detector}`);
const YEAR = 365.25 * 86400000;

/** One frame of the animation: one date, or several dates of the same survey and band averaged together. */
export type AnimFrame = { idx: number; members: number[]; ms: number; from: number; to: number };

/**
 * Frames to animate. windowYr = 0 gives one frame per date. Otherwise each frame is every date of the
 * same survey and band within windowYr of that date, so the full time span gives a single frame;
 * dates that would give the identical frame are shown once.
 */
export function animFrames(epochs: Epoch[], windowYr: number, endsOnly: boolean): AnimFrame[] {
  const out: AnimFrame[] = [];
  const seen = new Set<string>();
  epochs.forEach((e, i) => {
    const g = groupOf(e);
    const members = windowYr > 0 ? epochs.map((x, j) => (groupOf(x) === g && Math.abs(x.ms - e.ms) <= windowYr * YEAR + 1 ? j : -1)).filter((j) => j >= 0) : [i];
    const key = members.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    const t = members.map((j) => epochs[j].ms);
    out.push({ idx: i, members, ms: mean(t), from: Math.min(...t), to: Math.max(...t) });
  });
  return endsOnly && out.length > 2 ? [out[0], out[out.length - 1]] : out;
}

/**
 * The dates subtracted from a frame in "each date minus the rest": every other date of the same survey
 * and band. Dates within a year of the frame are left out (a slow mover would partly subtract itself)
 * as long as at least three others remain.
 */
export function restOf(epochs: Epoch[], f: AnimFrame): number[] {
  const g = groupOf(epochs[f.idx]);
  const mine = new Set(f.members);
  const others = epochs.map((x, j) => (groupOf(x) === g && !mine.has(j) ? j : -1)).filter((j) => j >= 0);
  const far = others.filter((j) => epochs[j].ms < f.from - YEAR || epochs[j].ms > f.to + YEAR);
  return far.length >= 3 ? far : others;
}

export const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const FLAG_HELP: Record<string, string> = {
  contaminated: "Another source or a ghost may be contaminating this frame near the target.",
  saturated: "Some pixels near the target are saturated; brightness is unreliable.",
  cosmic_ray: "A cosmic-ray hit was masked near the target.",
  masked: "Part of the cutout is masked (no data).",
};
export const flagHelp = (f: string) => FLAG_HELP[f] ?? `Quality flag: ${f.replace(/_/g, " ")}`;

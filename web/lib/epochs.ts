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

export const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const FLAG_HELP: Record<string, string> = {
  contaminated: "Another source or a ghost may be contaminating this frame near the target.",
  saturated: "Some pixels near the target are saturated; brightness is unreliable.",
  cosmic_ray: "A cosmic-ray hit was masked near the target.",
  masked: "Part of the cutout is masked (no data).",
};
export const flagHelp = (f: string) => FLAG_HELP[f] ?? `Quality flag: ${f.replace(/_/g, " ")}`;

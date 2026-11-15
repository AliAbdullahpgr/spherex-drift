import type { Stretch } from "./render";

export type Mode = "blink" | "rainbow" | "diff";
export type AppState = {
  ra: number; dec: number; fov: number; mode: Mode; frame: number; det: number | null; stretch: Stretch;
  bp: number; wp: number; wise: boolean; speed: number; src: "stack" | "frame";
  a: number | null; b: number | null; pf: number | null; pt: number | null; cross: boolean; mark: boolean; mock: boolean; embed: boolean; play: boolean;
  /** Sharp (nearest-neighbour) pixels; white-sky display; which kind of difference; years of dates averaged per frame; first and last dates only. */
  sharp: boolean; inv: boolean; diff: "each" | "pair"; win: number; ends: boolean;
};

export const DEFAULTS: AppState = {
  ra: 133.795129, dec: -7.245147, fov: 5, mode: "blink", frame: 0, det: null, stretch: "asinh", bp: 50, wp: 99.8,
  wise: false, speed: 2, src: "stack", a: null, b: null, pf: null, pt: null, cross: true, mark: true, mock: false, embed: false, play: true,
  sharp: true, inv: false, diff: "each", win: 0, ends: false,
};

const num = (v: string | null, d: number) => { const x = v == null || v === "" ? NaN : Number(v); return Number.isFinite(x) ? x : d; };
const optNum = (v: string | null) => { const x = v == null || v === "" ? NaN : Number(v); return Number.isFinite(x) ? x : null; };

export function readState(search: string): AppState {
  const p = new URLSearchParams(search);
  const mode = p.get("mode");
  const st = p.get("stretch");
  const ra = num(p.get("ra"), DEFAULTS.ra), dec = num(p.get("dec"), DEFAULTS.dec);
  const detector = optNum(p.get("detector"));
  const bp = Math.min(95, Math.max(0, num(p.get("bp"), DEFAULTS.bp)));
  const wp = Math.min(100, Math.max(90, bp + 1, num(p.get("wp"), DEFAULTS.wp)));
  const pass = (key: string) => { const value = optNum(p.get(key)); return value == null ? null : Math.max(1, Math.floor(value)); };
  let pf = pass("pf"), pt = pass("pt");
  if (pf != null && pt != null && pf > pt) [pf, pt] = [pt, pf];
  return {
    ra: ra >= 0 && ra < 360 ? ra : DEFAULTS.ra, dec: dec >= -90 && dec <= 90 ? dec : DEFAULTS.dec,
    fov: Math.min(30, Math.max(1, num(p.get("fov"), DEFAULTS.fov))),
    mode: mode === "rainbow" || mode === "diff" ? mode : "blink",
    frame: Math.max(0, Math.floor(num(p.get("frame"), 0))),
    det: detector != null && Number.isInteger(detector) && detector >= 1 && detector <= 6 ? detector : null,
    stretch: st === "linear" || st === "log" ? st : "asinh",
    bp, wp,
    wise: p.get("wise") === "1", speed: Math.min(6, Math.max(0.25, num(p.get("speed"), DEFAULTS.speed))),
    src: p.get("src") === "frame" ? "frame" : "stack",
    a: optNum(p.get("a")), b: optNum(p.get("b")), pf, pt,
    cross: p.get("cross") !== "0", mark: p.get("mark") !== "0", mock: p.get("mock") === "1", embed: p.get("embed") === "1", play: p.get("play") !== "0",
    sharp: p.get("sharp") !== "0", inv: p.get("inv") === "1",
    // links made before "each date minus the rest" existed carry a and b: keep them on the two-date view
    diff: p.get("diff") === "pair" || (p.get("diff") == null && (p.has("a") || p.has("b"))) ? "pair" : "each",
    win: Math.min(30, Math.max(0, num(p.get("win"), 0))), ends: p.get("ends") === "1",
  };
}

export function writeState(s: AppState): string {
  const p = new URLSearchParams();
  p.set("ra", s.ra.toFixed(6)); p.set("dec", s.dec.toFixed(6)); p.set("fov", String(+s.fov.toFixed(2)));
  p.set("mode", s.mode);
  if (s.frame) p.set("frame", String(s.frame));
  if (s.det != null) p.set("detector", String(s.det));
  if (s.stretch !== "asinh") p.set("stretch", s.stretch);
  if (s.bp !== DEFAULTS.bp) p.set("bp", String(s.bp));
  if (s.wp !== DEFAULTS.wp) p.set("wp", String(s.wp));
  if (s.wise) p.set("wise", "1");
  if (s.speed !== DEFAULTS.speed) p.set("speed", String(s.speed));
  if (s.src === "frame") p.set("src", "frame");
  if (s.a != null) p.set("a", String(s.a));
  if (s.b != null) p.set("b", String(s.b));
  if (s.pf != null) p.set("pf", String(s.pf));
  if (s.pt != null) p.set("pt", String(s.pt));
  if (!s.cross) p.set("cross", "0");
  if (!s.mark) p.set("mark", "0");
  if (s.mock) p.set("mock", "1");
  if (s.embed) p.set("embed", "1");
  if (!s.play) p.set("play", "0");
  if (!s.sharp) p.set("sharp", "0");
  if (s.inv) p.set("inv", "1");
  if (s.mode === "diff" && s.diff === "pair") p.set("diff", "pair");
  if (s.win) p.set("win", String(s.win));
  if (s.ends) p.set("ends", "1");
  return p.toString();
}

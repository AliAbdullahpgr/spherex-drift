"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import { fmtDec, fmtRA, resolveInput } from "@/lib/coords";
import { animFrames, buildEpochs, defaultDetector, detectorInfo, fmtDate, flagHelp, groupOf, restOf, type AnimFrame, type Epoch } from "@/lib/epochs";
import { combine, difference, levels, minusRest, normalise, paintDiff, rainbow, sharedLevels, toGray, type DiffField, type Norm } from "@/lib/render";
import { lightCurve, pickMeasure } from "@/lib/photometry";
import { centroid, fitMotion, msToYear, type Sample } from "@/lib/motion";
import { apparentMotion, injectPlanetX } from "@/lib/planetx";
import { DEFAULTS, readState, writeState, type AppState, type Mode } from "@/lib/urlstate";
import type { Frame, SpectrumPoint, Target } from "@/lib/types";
import Viewer, { Readout } from "./Viewer";
import Timeline, { type Mark } from "./Timeline";
import Pad from "./Pad";
import Spectrum from "./Spectrum";
import Walkthrough from "./Walkthrough";
import Filmstrip from "./Filmstrip";
import LightCurve from "./LightCurve";
import MotionLab from "./MotionLab";
import SkyOverlay from "./SkyOverlay";
import ContextPanel from "./ContextPanel";
import { getGaia, getKnownObjects } from "@/lib/overlays";

const SIZE = api.IMG_SIZE;
type Hover = { x: number; y: number; ra: number; dec: number } | null;

export default function App() {
  const [s, setS] = useState<AppState>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [backend, setBackend] = useState<{ mock: boolean; reason?: string } | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [spx, setSpx] = useState<Frame[]>([]);
  const [wise, setWise] = useState<Frame[]>([]);
  const [framesState, setFramesState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [framesErr, setFramesErr] = useState("");
  const [wiseNote, setWiseNote] = useState("");
  const [ver, setVer] = useState(0); // bumps when an image arrives
  const cache = useRef(new Map<string, Norm>());
  const [prog, setProg] = useState({ done: 0, total: 0, current: "", failed: 0, lastErr: "" });
  const [playing, setPlaying] = useState(true); // the animation runs by itself; play=0 in the address opens it paused
  const [loopTick, setLoopTick] = useState(0); // goes up each time the animation starts over
  const [input, setInput] = useState("");
  const [inputMsg, setInputMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [picked, setPicked] = useState<{ x: number; y: number; ra: number; dec: number } | null>(null);
  const [spec, setSpec] = useState<{ state: "idle" | "loading" | "done" | "error"; points: SpectrumPoint[]; err?: string }>({ state: "idle", points: [] });

  const [listing, setListing] = useState<"quick" | "full" | "done">("done"); // how complete the exposure list is
  const [autoDet, setAutoDet] = useState<number | null>(null);
  const [centre, setCentre] = useState<{ state: "idle" | "loading" | "done" | "error"; points: SpectrumPoint[] }>({ state: "idle", points: [] });
  const [px, setPx] = useState<{ on: boolean; dist: number; snr: number; seed: number; reveal: boolean }>({ on: false, dist: 5000, snr: 12, seed: 1, reveal: false });
  const [resolving, setResolving] = useState(false);
  const nowPos = useRef<{ ra: number; dec: number } | null>(null);
  const [ov, setOv] = useState({ gaia: false, motion: false, known: false });
  const [gaia, setGaia] = useState<Awaited<ReturnType<typeof getGaia>>>([]);
  const [known, setKnown] = useState<Awaited<ReturnType<typeof getKnownObjects>>>([]);
  const [ovBusy, setOvBusy] = useState("");
  const [lab, setLab] = useState<{ marks: { x: number; y: number; label?: string }[]; path: { x: number; y: number }[] }>({ marks: [], path: [] });

  const set = useCallback((p: Partial<AppState>) => setS((o) => ({ ...o, ...p })), []);

  // ---- init from URL
  useEffect(() => {
    const st = readState(window.location.search);
    const q = new URLSearchParams(window.location.search);
    // A bare link opens on the clearest view we have: WISE 0855 blinking through 16 years of WISE and SPHEREx.
    if (!q.has("ra") && !q.has("mode")) { st.mode = "blink"; st.wise = true; }
    setS(st); setPlaying(st.play);
    setInput(`${st.ra.toFixed(5)} ${st.dec.toFixed(5)}`);
    api.detectBackend(st.mock).then((b) => {
      setBackend(b);
      api.getTargets().then(setTargets);
      setReady(true);
    });
  }, []);

  // ---- state -> URL (the frame number is left out while the animation runs, so the address is not rewritten every frame)
  const animated = s.mode === "blink" || (s.mode === "diff" && s.diff === "each");
  const urlStr = useMemo(() => writeState({ ...s, play: playing, frame: playing && animated ? 0 : s.frame }), [s, playing, animated]);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => { try { window.history.replaceState(null, "", "?" + urlStr); } catch { /* browsers limit how often the address may change */ } }, 150);
    return () => clearTimeout(t);
  }, [urlStr, ready]);

  // ---- fetch frame lists whenever the patch changes
  const viewKey = `${s.ra.toFixed(5)}|${s.dec.toFixed(5)}|${s.fov}`;
  const view = useMemo(() => ({ ra: s.ra, dec: s.dec, fov: s.fov }), [s.ra, s.dec, s.fov]);
  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    setFramesState("loading"); setFramesErr(""); setWiseNote(""); setPicked(null); setSpec({ state: "idle", points: [] });
    setCentre({ state: "idle", points: [] }); setAutoDet(null); setListing("quick");
    setSpx([]); setWise([]); // never show or request the previous position's exposures against the new one
    api.getWiseFrames(view, ctl.signal).then((w) => {
      if (ctl.signal.aborted) return;
      setWise(w.frames); if (!w.frames.length) setWiseNote("No WISE images cover this patch.");
    }).catch((e) => { if (!ctl.signal.aborted) { setWise([]); setWiseNote("WISE images could not be loaded: " + (e?.message ?? "unknown error")); } });
    (async () => {
      try {
        // 1. quick list: enough to start showing pictures within seconds
        const quick = await api.getFrames(view, ctl.signal, true);
        if (ctl.signal.aborted) return;
        setSpx(quick.frames); setAutoDet(quick.frames.length ? defaultDetector(quick.frames) : null);
        setFramesState("done"); setListing(quick.frames.length ? "full" : "done");
        if (!quick.frames.length) return;
        // 2. full list in the background: exact wavelengths and quality flags
        const full = await api.getFrames(view, ctl.signal, false);
        if (ctl.signal.aborted) return;
        setSpx(full.frames); setListing("done");
        // 3. brightness of whatever sits at the centre, for the light curve and spectrum
        setCentre({ state: "loading", points: [] });
        try {
          const at = nowPos.current ?? { ra: view.ra, dec: view.dec };
          const r = await api.getSpectrum(at.ra, at.dec, view, 6, ctl.signal);
          if (!ctl.signal.aborted) setCentre({ state: "done", points: r.points });
        } catch { if (!ctl.signal.aborted) setCentre({ state: "error", points: [] }); }
      } catch (e: any) {
        if (ctl.signal.aborted) return;
        setFramesErr(e?.message ?? String(e)); setFramesState("error"); setListing("done");
      }
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewKey]);

  const detInfo = useMemo(() => detectorInfo(spx), [spx]);
  const det = s.det ?? autoDet ?? defaultDetector(spx);
  const allPasses = useMemo(() => [...new Set(spx.map((f) => f.pass))].sort((a, b) => a - b), [spx]);
  const passFrom = Math.max(s.pf ?? allPasses[0] ?? 1, allPasses[0] ?? 1);
  const passTo = Math.min(s.pt ?? allPasses[allPasses.length - 1] ?? 1, allPasses[allPasses.length - 1] ?? 1);
  const epochs = useMemo(() => buildEpochs(spx, wise, { src: s.src, detector: det, includeWise: s.wise, passFrom, passTo }), [spx, wise, s.src, det, s.wise, passFrom, passTo]);

  // ---- progressive image loading (current epoch first)
  const imgKey = (e: Epoch) => `${viewKey}|${e.key}`;
  const frameIdx = Math.min(s.frame, Math.max(0, epochs.length - 1));
  useEffect(() => {
    if (!ready || framesState !== "done" || !epochs.length) { setProg({ done: 0, total: 0, current: "", failed: 0, lastErr: "" }); return; }
    const ctl = new AbortController();
    const order = [...epochs.keys()].sort((i, j) => (i === frameIdx ? -1 : j === frameIdx ? 1 : i - j));
    const todo = order.map((i) => epochs[i]).filter((e) => !cache.current.has(imgKey(e)));
    let done = epochs.length - todo.length, failed = 0, lastErr = "";
    setProg({ done, total: epochs.length, current: "", failed, lastErr });
    let next = 0;
    const worker = async () => {
      while (!ctl.signal.aborted) {
        const e = todo[next++];
        if (!e) return;
        setProg((p) => ({ ...p, current: describe(e) }));
        try {
          const img = e.kind === "stack" ? await api.getStack(view, e.pass, e.detector!, ctl.signal) : await api.getFrameImage(e.frame!, view, ctl.signal);
          if (ctl.signal.aborted) return;
          cache.current.set(imgKey(e), normalise(img));
          done++;
          setVer((v) => v + 1);
        } catch (err: any) {
          if (ctl.signal.aborted) return;
          failed++; lastErr = err?.message ?? String(err);
        }
        setProg({ done, total: epochs.length, current: next < todo.length ? describe(todo[next] ?? e) : "", failed, lastErr });
      }
    };
    Promise.all([worker(), worker(), worker()]);
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, framesState, epochs, viewKey]);

  const rawNorms = useMemo(() => epochs.map((e) => cache.current.get(imgKey(e)) ?? null), [epochs, ver, viewKey]); // eslint-disable-line
  const planet = useMemo(() => (px.on && epochs.length ? injectPlanetX(rawNorms, epochs.map((e) => e.ms), { distAU: px.dist, snr: px.snr, seed: px.seed, fovArcmin: s.fov }) : null), [px.on, px.dist, px.snr, px.seed, rawNorms, epochs, s.fov]);
  const norms = planet ? planet.norms : rawNorms;
  // blink uses one brightness scale per survey so real changes in brightness stay visible
  const shared = useMemo(() => sharedLevels(norms, epochs.map((e) => e.survey), s.bp, s.wp), [norms, epochs, s.bp, s.wp]);
  const loadedIdx = norms.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);

  // ---- animation frames: one per date, or several dates of the same survey and band averaged
  const frames = useMemo(() => animFrames(epochs, s.win, s.ends), [epochs, s.win, s.ends]);
  const fi = useMemo(() => {
    if (!frames.length) return 0;
    let k = frames.findIndex((f) => f.idx === frameIdx);
    if (k < 0) k = frames.findIndex((f) => f.members.includes(frameIdx));
    if (k >= 0) return k;
    const t = epochs[frameIdx]?.ms ?? 0;
    return frames.reduce((best, f, q) => (Math.abs(f.ms - t) < Math.abs(frames[best].ms - t) ? q : best), 0);
  }, [frames, frameIdx, epochs]);
  const curF: AnimFrame | undefined = frames[fi];
  /** The picture for one frame: the mean of its loaded dates, in the noise units of `ref`. */
  const frameNorm = (f: AnimFrame | undefined): { n: Norm; ref: number } | null => {
    if (!f) return null;
    const ld = f.members.filter((q) => norms[q]);
    if (!ld.length) return null;
    const ref = norms[f.idx] ? f.idx : ld[0];
    return { n: combine(ld.map((q) => norms[q]!), norms[ref]!), ref };
  };
  const curNorm = useMemo(() => frameNorm(curF), [curF, norms]); // eslint-disable-line
  const rest = useMemo(() => (curF ? restOf(epochs, curF) : []), [epochs, curF]);
  // frames that can be drawn right now
  const avail = frames.map((f, k) => {
    if (!f.members.some((q) => norms[q])) return -1;
    if (s.mode === "diff" && !restOf(epochs, f).some((q) => norms[q])) return -1;
    return k;
  }).filter((k) => k >= 0);

  // ---- play loop (skips frames that are not loaded yet; holds the last frame a little longer)
  const live = useRef({ avail, fi, frames });
  live.current = { avail, fi, frames };
  useEffect(() => {
    if (!playing || !animated) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const { avail: av, fi: at, frames: fr } = live.current;
      let hold = 1;
      if (av.length >= 2) {
        const nxt = av.find((k) => k > at) ?? av[0];
        if (nxt < at) setLoopTick((v) => v + 1);
        setS((o) => ({ ...o, frame: fr[nxt].idx }));
        if (nxt === av[av.length - 1]) hold = 1.8;
      }
      t = setTimeout(tick, (hold * 1000) / s.speed);
    };
    t = setTimeout(tick, 1000 / s.speed);
    return () => clearTimeout(t);
  }, [playing, animated, s.speed]);
  const step = (d: number) => { if (frames.length < 2) return; setPlaying(false); set({ frame: frames[(fi + d + frames.length) % frames.length].idx }); };

  // ---- each date minus the rest: worked out one frame at a time and kept, so the loop is cheap after the first pass
  const eachCache = useRef<{ tok: unknown[]; map: Map<string, { g: string; f: DiffField }> }>({ tok: [], map: new Map() });
  const eachField = (f: AnimFrame | undefined): { f: DiffField; scale: number } | null => {
    const target = frameNorm(f);
    if (!f || !target) return null;
    const c = eachCache.current, tok = [epochs, viewKey, planet?.norms ?? null];
    if (tok.some((x, q) => x !== c.tok[q])) { c.tok = tok; c.map.clear(); }
    const others = restOf(epochs, f).filter((q) => norms[q]);
    if (!others.length) return null;
    const key = `${f.members.filter((q) => norms[q]).join(",")}|${others.join(",")}`, g = groupOf(epochs[f.idx]);
    let hit = c.map.get(key);
    if (!hit) {
      const fld = minusRest(target.n, others.map((q) => norms[q]!));
      if (!fld) return null;
      hit = { g, f: fld };
      c.map.set(key, hit);
    }
    // one colour scale per survey (the median over the frames seen so far), so the picture does not pulse between dates
    const sc = [...c.map.values()].filter((v) => v.g === g).map((v) => v.f.scale).sort((a, b) => a - b);
    return { f: hit.f, scale: sc[sc.length >> 1] };
  };

  // ---- diff selection (never defaults to A-A)
  const n = epochs.length;
  const aIdx = s.a != null && s.a < n ? s.a : 0;
  const bIdx = s.b != null && s.b < n && s.b !== aIdx ? s.b : Math.max(0, n - 1);
  const dMismatch = useMemo(() => {
    const A = epochs[aIdx], B = epochs[bIdx];
    if (!A || !B) return "";
    const rel = Math.abs(A.wl - B.wl) / ((A.wl + B.wl) / 2);
    if (A.survey !== B.survey || rel > 0.15)
      return `A is ${A.survey === "wise" ? "WISE " : ""}${A.wl.toFixed(2)} µm and B is ${B.survey === "wise" ? "WISE " : ""}${B.wl.toFixed(2)} µm. Different wavelengths make stars look brighter or fainter on their own, so the difference will not show motion cleanly. Compare epochs from the same detector.`;
    return "";
  }, [epochs, aIdx, bIdx]);

  // ---- render image
  const image = useMemo(() => {
    if (!epochs.length) return null;
    if (s.mode === "blink") {
      return curNorm ? toGray(curNorm.n, shared[curNorm.ref] ?? levels(curNorm.n, s.bp, s.wp), s.stretch, s.inv) : null;
    }
    if (s.mode === "rainbow") {
      const list = norms.map((nm) => (nm ? { n: nm, lv: levels(nm, s.bp, s.wp, 2.5) } : null)).filter(Boolean) as { n: Norm; lv: ReturnType<typeof levels> }[];
      return rainbow(list, s.stretch);
    }
    if (s.diff === "each") {
      const e = eachField(curF);
      return e ? paintDiff(e.f, e.scale, s.inv) : null;
    }
    const A = norms[aIdx], B = norms[bIdx];
    return A && B && aIdx !== bIdx ? difference(A, B, 1, s.inv) : null;
  }, [norms, shared, s.mode, s.diff, s.inv, s.bp, s.wp, s.stretch, curF, curNorm, aIdx, bIdx, epochs.length]); // eslint-disable-line

  const busy = useMemo(() => {
    if (framesState === "loading") return "Asking the archive which exposures cover this patch of sky. This takes a few seconds.";
    if (framesState === "error") return null;
    if (!epochs.length) return null;
    if (s.mode === "blink" && !curNorm) return `Fetching ${describe(epochs[frameIdx])} from the archive. This can take several seconds per image.`;
    if (s.mode === "rainbow" && prog.done < prog.total) return image ? `Rainbow so far uses ${prog.done} of ${prog.total} epochs. Still fetching ${prog.current}…` : `Fetching ${prog.current}…`;
    if (s.mode === "diff" && s.diff === "each") return image || !rest.length ? null : "Fetching the other dates to subtract. Each one can take several seconds.";
    if (s.mode === "diff" && !image) return aIdx === bIdx ? null : `Fetching the two epochs to subtract (${describe(epochs[aIdx])}, ${describe(epochs[bIdx])})…`;
    return null;
  }, [framesState, epochs, curNorm, frameIdx, s.mode, s.diff, rest.length, image, prog, aIdx, bIdx]);

  // ---- known target under the crosshair, and where its catalogued motion says it should be
  const target = useMemo(() => targets.find((t) => Math.hypot((t.ra - s.ra) * Math.cos((s.dec * Math.PI) / 180), t.dec - s.dec) * 3600 < 2) ?? null, [targets, s.ra, s.dec]);
  const expected = useMemo(() => {
    if (!target?.pm_mas_yr || target.epoch == null) return null;
    const [pmRa, pmDec] = target.pm_mas_yr;
    const at = (ms: number) => {
      const yr = 2000 + (ms - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000);
      const dt = yr - target.epoch!;
      const scale = (s.fov * 60) / 1; // arcsec across the image
      return { x: 0.5 - (pmRa * dt) / 1000 / scale, y: 0.5 - (pmDec * dt) / 1000 / scale }; // east is left, north is up
    };
    return { at, rate: Math.hypot(pmRa, pmDec) / 1000, dir: compassDir(pmRa, pmDec) };
  }, [target, s.fov]);
  // sky position of a known mover in mid-2026, when SPHEREx saw it (used for its automatic spectrum)
  nowPos.current = target?.pm_mas_yr && target.epoch != null
    ? { ra: target.ra + ((target.pm_mas_yr[0] * (2026.0 - target.epoch)) / 3.6e6) / Math.cos((target.dec * Math.PI) / 180), dec: target.dec + (target.pm_mas_yr[1] * (2026.0 - target.epoch)) / 3.6e6 }
    : null;
  const inView = (q: { x: number; y: number }) => q.x > 0.01 && q.x < 0.99 && q.y > 0.01 && q.y < 0.99;

  // ---- measure the motion in the pictures themselves and compare with the catalogue
  const measured = useMemo(() => {
    if (!expected) return null;
    const fov = s.fov * 60;
    const samples: Sample[] = [];
    rawNorms.forEach((nm, i) => {
      if (!nm) return;
      const e = expected.at(epochs[i].ms);
      const c = centroid(nm, e.x * nm.w - 0.5, e.y * nm.h - 0.5, 14 / (fov / nm.w));
      if (c) samples.push({ yr: msToYear(epochs[i].ms), east: (0.5 - (c.x + 0.5) / nm.w) * fov, north: (0.5 - (c.y + 0.5) / nm.h) * fov });
    });
    const fit = fitMotion(samples);
    return fit ? { ...fit, dir: compassDir(fit.pmEast, fit.pmNorth) } : null;
  }, [expected, rawNorms, epochs, s.fov]);
  const centrePicked = useMemo(() => (centre.state === "done" ? pickMeasure(centre.points) : null), [centre]);
  const curves = useMemo(() => (centrePicked ? lightCurve(centrePicked) : []), [centrePicked]);
  const clickedPicked = useMemo(() => (spec.state === "done" ? pickMeasure(spec.points) : null), [spec]);

  // ---- catalogue overlays, fetched only when switched on
  useEffect(() => { setGaia([]); setKnown([]); setLab({ marks: [], path: [] }); }, [viewKey]);
  useEffect(() => {
    if (!(ov.gaia || ov.motion) || gaia.length) return;
    const ctl = new AbortController();
    setOvBusy("Looking up Gaia stars…");
    getGaia(view, ctl.signal).then((g) => { if (!ctl.signal.aborted) { setGaia(g); setOvBusy(g.length ? "" : "No Gaia stars came back for this patch."); } });
    return () => ctl.abort();
  }, [ov.gaia, ov.motion, viewKey]); // eslint-disable-line
  const spxTimes = useMemo(() => epochs.filter((e) => e.survey === "spherex").map((e) => e.time), [epochs]);
  useEffect(() => {
    if (!ov.known || known.length || !spxTimes.length) return;
    const ctl = new AbortController();
    setOvBusy("Asking which known asteroids were here on each date…");
    getKnownObjects(view, spxTimes, ctl.signal).then((k) => { if (!ctl.signal.aborted) { setKnown(k); setOvBusy(k.length ? "" : "No known asteroids were in this patch on these dates."); } });
    return () => ctl.abort();
  }, [ov.known, viewKey, spxTimes.length]); // eslint-disable-line

  // ---- keyboard: space plays, arrows step
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) return;
      if (!animated || frames.length < 2) return;
      if (e.key === " ") { e.preventDefault(); setPlaying((v) => !v); }
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [animated, frames, fi]); // eslint-disable-line

  // ---- actions
  const jump = (ra: number, dec: number, label: string | undefined, extra: Partial<AppState> = {}) => {
    setInputMsg({ kind: "ok", text: label ? `${label}: ${ra.toFixed(5)}, ${dec.toFixed(5)}` : `${fmtRA(ra)}  ${fmtDec(dec)}` });
    setInput(`${ra.toFixed(5)} ${dec.toFixed(5)}`);
    cache.current.clear();
    setPx((p) => ({ ...p, on: false, reveal: false }));
    set({ ra, dec, frame: 0, a: null, b: null, pf: null, pt: null, det: null, ...extra });
  };
  const go = async (text: string) => {
    const r = resolveInput(text, targets);
    if (r.ok) {
      const t = targets.find((x) => x.name === r.label);
      // movers need the long WISE baseline to show motion; variables are clearest as a blink
      jump(r.ra, r.dec, r.label, t?.kind === "mover" ? { wise: true } : t?.kind === "variable" ? { wise: false, mode: "blink" } : {});
      return;
    }
    const name = text.trim();
    if (!name || !/[a-z]/i.test(name) || /^[\d\s.+\-:hmsd°'"]+$/i.test(name)) { setInputMsg({ kind: "err", text: r.error }); return; }
    // not coordinates and not a test target: ask the name service (any star, galaxy or nebula)
    setResolving(true); setInputMsg({ kind: "ok", text: `Looking up "${name}"…` });
    try {
      const hit = await api.resolveName(name);
      if (hit) jump(hit.ra, hit.dec, hit.name);
      else setInputMsg({ kind: "err", text: `No object called "${name}" was found. Check the spelling, or enter RA and Dec.` });
    } catch (e: any) { setInputMsg({ kind: "err", text: e?.message ?? "Name lookup failed. Enter RA and Dec instead." }); }
    finally { setResolving(false); }
  };
  const applyWalk = (p: Partial<AppState>) => { cache.current.clear(); set({ ...p, frame: 0, a: null, b: null, pf: null, pt: null, det: null }); setInput(`${(p.ra ?? s.ra).toFixed(5)} ${(p.dec ?? s.dec).toFixed(5)}`); setInputMsg(null); };
  // drag, double-click, wheel and pinch on the picture: same settings, new patch of sky
  const recentre = (ra: number, dec: number) => {
    cache.current.clear();
    setInput(`${ra.toFixed(5)} ${dec.toFixed(5)}`); setInputMsg(null);
    set({ ra, dec: Math.max(-90, Math.min(90, dec)) });
  };
  const zoom = (fov: number) => { cache.current.clear(); set({ fov }); };
  const pick = async (p: { x: number; y: number; ra: number; dec: number }) => {
    setPicked(p);
    setSpec({ state: "loading", points: [] });
    try {
      const r = await api.getSpectrum(p.ra, p.dec, view, 6);
      setSpec({ state: "done", points: r.points });
    } catch (e: any) { setSpec({ state: "error", points: [], err: e?.message ?? String(e) }); }
  };

  const cur = curF ? epochs[curF.idx] : epochs[frameIdx];
  const many = !!curF && curF.members.length > 1;
  const when = curF ? (many ? `${fmtDate(curF.from).slice(0, 7)} to ${fmtDate(curF.to).slice(0, 7)}` : fmtDate(curF.ms)) : "";
  const inFrame = new Set(curF?.members ?? []);
  const marks: Mark[] = epochs.map((_, i) => (animated ? (curF && i === curF.idx ? "active" : inFrame.has(i) ? "in" : "none") : s.mode === "rainbow" ? "in" : i === aIdx ? "a" : i === bIdx ? "b" : "none"));
  const hoverVal = hover && s.mode === "blink" && curNorm ? `${curNorm.n.data[hover.y * curNorm.n.w + hover.x].toFixed(1)} σ` : undefined;
  const what = cur ? (many ? `${curF!.members.length} ${cur.survey === "wise" ? "WISE" : "SPHEREx"} dates combined` : cur.label) : "";
  const caption = s.mode === "blink" && cur ? `${what} ${when}`
    : s.mode === "rainbow" ? `Rainbow trail of ${loadedIdx.length} epochs`
    : s.diff === "each" ? (cur ? `${what} ${when} minus the other dates` : "Each date minus the rest")
    : `Difference ${epochs[bIdx]?.label ?? ""} minus ${epochs[aIdx]?.label ?? ""}`;
  const noCoverage = framesState === "done" && !spx.length;
  const thumbCache = useRef(new WeakMap<Norm, { key: string; img: ImageData }>());
  const thumbs = useMemo(() => norms.map((nm, i) => {
    if (!nm) return null;
    const lv = shared[i] ?? levels(nm, s.bp, s.wp);
    const key = `${lv.lo.toFixed(3)}|${lv.hi.toFixed(3)}|${s.stretch}`;
    const hit = thumbCache.current.get(nm);
    if (hit && hit.key === key) return hit.img;
    const img = toGray(nm, lv, s.stretch);
    thumbCache.current.set(nm, { key, img });
    return img;
  }), [norms, shared, s.bp, s.wp, s.stretch]);
  const selectEpoch = (i: number) => {
    if (animated) { setPlaying(false); set({ frame: i }); }
    else if (s.mode === "rainbow") { setPlaying(false); set({ mode: "blink", frame: i }); }
    else if (i !== aIdx && i !== bIdx) set(Math.abs(i - aIdx) <= Math.abs(i - bIdx) ? { a: i, b: bIdx } : { a: aIdx, b: i });
  };
  const srcName = cur ? (cur.survey === "wise" ? "WISE" : `SPHEREx pass ${cur.pass}`) : "";
  const hud = s.mode === "blink" && cur
    ? { big: when, small: many ? `${curF!.members.length} ${cur.survey === "wise" ? "WISE" : "SPHEREx"} dates combined, ${cur.wl.toFixed(2)} µm` : `${srcName}, ${cur.wl.toFixed(2)} µm${cur.kind === "stack" ? `, ${cur.n} exposures combined` : ""}` }
    : s.mode === "rainbow" && n
      ? { big: `${fmtDate(epochs[0].ms).slice(0, 4)} to ${fmtDate(epochs[n - 1].ms).slice(0, 4)}`, small: `${loadedIdx.length} dates in one picture` }
      : s.mode === "diff" && s.diff === "each" && cur
        ? { big: when, small: rest.length ? `minus the middle value of ${rest.length} other ${cur.survey === "wise" ? "WISE" : "SPHEREx"} ${rest.length === 1 ? "date" : "dates"}` : "no other date to subtract" }
        : s.mode === "diff" && epochs[aIdx] && epochs[bIdx]
          ? { big: `${fmtDate(epochs[bIdx].ms)} minus ${fmtDate(epochs[aIdx].ms)}`, small: "newer minus older" }
          : undefined;
  const pair = s.mode === "diff" && s.diff === "pair";
  const showMarks = s.mark && expected && epochs.length > 0;
  const pmMarks = !showMarks ? [] : (animated && curF ? [{ ...expected!.at(curF.ms), tone: "now" as const }]
    : pair && epochs[aIdx] && epochs[bIdx] ? [{ ...expected!.at(epochs[aIdx].ms), label: "A", tone: "a" as const }, { ...expected!.at(epochs[bIdx].ms), label: "B", tone: "b" as const }]
    : []).filter(inView);
  let pmPath = showMarks && s.mode === "rainbow" && epochs.length > 1 ? [expected!.at(epochs[0].ms), expected!.at(epochs[n - 1].ms)] : [];
  let allMarks = pmMarks as { x: number; y: number; label?: string; tone?: "now" | "a" | "b" }[];
  if (planet && px.reveal) {
    if (animated && curF && planet.track[curF.idx]) allMarks = [...allMarks, { ...planet.track[curF.idx], label: "simulated", tone: "b" as const }].filter(inView);
    else if (s.mode === "rainbow") pmPath = planet.track;
    else if (pair) allMarks = [...allMarks, ...[aIdx, bIdx].map((k) => ({ ...planet.track[k], label: "simulated", tone: "b" as const }))].filter(inView);
  }
  const modeHelp: Record<Mode, string> = {
    blink: "Flip between pictures of the same patch of sky taken months or years apart. Stars hold still. Anything that jumps is moving.",
    rainbow: "Every date in one picture: the oldest is tinted blue, the newest orange. Stars add up to white. A mover leaves a coloured streak.",
    diff: s.diff === "each"
      ? "Each date with the other dates subtracted. Everything that holds still at the same brightness cancels to black. Only what moved or changed is left."
      : "The newer picture minus the older one. Stars cancel out. A mover leaves a blue spot where it was and an orange spot where it is now.",
  };
  const modeName: Record<Mode, string> = { blink: "Blink", rainbow: "Rainbow trail", diff: "Difference" };

  const modeSub: Record<Mode, string> = { blink: "flip between dates", rainbow: "all dates in one picture", diff: "only what moved or changed" };
  const spanYr = n > 1 ? (epochs[n - 1].ms - epochs[0].ms) / (365.25 * 86400000) : 0;
  const winMax = Math.max(0.5, Math.ceil(spanYr * 2) / 2);

  return (
    <div className={`app ${s.embed ? "embed" : ""}`}>
      {!s.embed && (
        <header className="top">
          <a className="wordmark" href="./" aria-label="SPHEREx Drift, start over">SPHEREx Drift</a>
          <span className="topnote">Real NASA SPHEREx images, with WISE images back to 2010</span>
        </header>
      )}
      {backend?.mock && (
        <div className="banner" role="status" data-testid="mock-banner">
          {backend.reason === "unreachable" ? "Backend not reachable, so this shows synthetic demo data: " : "Demo mode: "}
          the sky is made up, with one moving star and one variable star.
        </div>
      )}

      <div className="shell">
        {/* ---------------- left: where to look ---------------- */}
        <nav className="rail left" aria-label="Where to look">
          <section className="about" data-testid="about-target">
            <h1 className="title">{target ? target.name : "Custom position"}</h1>
            {target
              ? <p className="lede">{target.kind === "variable" ? "A star whose brightness changes." : target.kind === "mover" ? "A nearby object that moves across the sky." : ""}{expected ? <> It moves <b>{expected.rate.toFixed(1)}″ per year</b>, heading {expected.dir}.</> : null}</p>
              : <p className="lede coords">{fmtRA(s.ra)} {fmtDec(s.dec)}</p>}
            {expected && (
              <>
                <p className="note">The yellow ring marks where that motion puts it on each date.</p>
                <p className="measured" data-testid="measured">
                  {measured
                    ? <>Measured in these images: <b>{measured.rate.toFixed(1)}″ per year</b>, heading {measured.dir}, from {measured.n} dates across {measured.spanYr.toFixed(1)} years. The catalogue says {expected.rate.toFixed(1)}″.</>
                    : s.wise ? "Not enough clear detections yet to measure its motion from the pictures." : "Add the WISE images to measure its motion from the pictures."}
                </p>
                <label className="check"><input type="checkbox" checked={s.mark} onChange={(e) => set({ mark: e.target.checked })} data-testid="mark-toggle" /> Show expected position</label>
              </>
            )}
            {target?.kind === "variable" && <p className="note">It stays in place. Watch it brighten and fade in Blink, or click it to compare its spectrum between passes.</p>}
          </section>

          <form onSubmit={(e) => { e.preventDefault(); go(input); }} className="coordform">
            <h2 className="h"><label htmlFor="coords">Go to a position</label></h2>
            <div className="searchrow">
              <input id="coords" data-testid="coord-input" value={input} onChange={(e) => setInput(e.target.value)} inputMode="text" autoComplete="off" spellCheck={false}
                placeholder="RA and Dec, or a target name" />
              <button className="go" type="submit" data-testid="coord-go" disabled={resolving}>Go</button>
            </div>
            <div className={`msg ${inputMsg?.kind ?? ""}`} data-testid="coord-msg" role="status">{inputMsg?.text ?? `Now showing ${fmtRA(s.ra)} ${fmtDec(s.dec)}`}</div>
            <p className="hint">Use decimal degrees, or a form like 08h55m10.8s -07d14m42s.</p>
          </form>

          <section>
            <h2 className="h">Test targets</h2>
            <ul className="cat" data-testid="targets">
              {targets.map((t) => (
                <li key={t.id}>
                  <button className={`catrow ${target?.id === t.id ? "on" : ""}`} aria-current={target?.id === t.id ? "true" : undefined} onClick={() => { setInput(t.name); go(t.name); }} data-testid={`target-${t.id}`} title={t.note}>
                    <span className="nm">{t.name}</span>
                    <span className="tag">{t.kind === "variable" ? "changes" : t.kind === "mover" ? "moves" : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <Walkthrough onApply={applyWalk} />
        </nav>

        {/* ---------------- centre: the picture ---------------- */}
        <main className="stage">
          <div className="tabs" role="tablist">
            {(["blink", "rainbow", "diff"] as Mode[]).map((m) => (
              <button key={m} role="tab" aria-selected={s.mode === m} className={`tab ${s.mode === m ? "on" : ""}`} onClick={() => set({ mode: m })} data-testid={`mode-${m}`}>
                <span className="tl">{modeName[m]}</span>
                <span className="sub">{modeSub[m]}</span>
              </button>
            ))}
          </div>

          {framesState === "error" && <div className="alert" data-testid="frames-error">Could not load the exposure list: {framesErr}</div>}
          {noCoverage && <div className="alert" data-testid="no-coverage">No SPHEREx exposures cover this position yet. Try one of the test targets, or a different position.</div>}

          <Viewer
            image={image} size={SIZE} fov={s.fov} ra={s.ra} dec={s.dec} crosshair={s.cross} busy={busy} picked={picked}
            onHover={setHover} onPick={pick} caption={caption} marks={[...allMarks, ...lab.marks.map((m) => ({ ...m, tone: "b" as const }))]} path={lab.path.length > 1 ? lab.path : pmPath} hud={hud}
            sharp={s.sharp && s.mode !== "rainbow"} invert={s.inv && s.mode !== "rainbow"} loopTick={animated ? loopTick : 0}
            onRecentre={recentre} onZoom={zoom} loading={busy != null}
          >
            {(ov.gaia || ov.motion || ov.known) && s.mode !== "rainbow" && cur && (
              <SkyOverlay view={view} epochMs={cur.ms} spanMs={epochs.length > 1 ? [epochs[0].ms, epochs[n - 1].ms] : undefined}
                gaia={gaia} known={known} showGaia={ov.gaia} showMotion={ov.motion} showKnown={ov.known} />
            )}
          </Viewer>
          {px.on && <p className="simnote" data-testid="px-note">These pictures contain one simulated object. Everything else is real.</p>}
          <div className="under">
            <Readout hover={hover} value={hoverVal} />
            <span className="caption" data-testid="caption">{caption}{s.mode === "blink" && cur ? `, ${cur.wl.toFixed(2)} µm` : ""}</span>
          </div>

          <p className="explain">{modeHelp[s.mode]}</p>

          {s.mode === "diff" && (
            <div className="diffctl" data-testid="diffctl">
              <div className="seg" role="group" aria-label="What to subtract">
                <button className={`segbtn ${s.diff === "each" ? "on" : ""}`} aria-pressed={s.diff === "each"} onClick={() => set({ diff: "each" })} data-testid="diff-each">Each date minus the rest</button>
                <button className={`segbtn ${s.diff === "pair" ? "on" : ""}`} aria-pressed={s.diff === "pair"} onClick={() => set({ diff: "pair" })} data-testid="diff-pair">Two dates</button>
              </div>
              {pair && (
                <>
                  <div className="diffpick">
                    <label>Older picture (A, subtracted)
                      <select value={aIdx} onChange={(e) => set({ a: +e.target.value })} data-testid="diff-a">{epochs.map((e, i) => <option key={e.key} value={i}>{e.label} · {fmtDate(e.ms)} · {e.wl.toFixed(2)} µm</option>)}</select></label>
                    <label>Newer picture (B)
                      <select value={bIdx} onChange={(e) => set({ b: +e.target.value })} data-testid="diff-b">{epochs.map((e, i) => <option key={e.key} value={i}>{e.label} · {fmtDate(e.ms)} · {e.wl.toFixed(2)} µm</option>)}</select></label>
                  </div>
                  {epochs.length < 2 && <div className="alert">Need at least two epochs to subtract.</div>}
                  {aIdx === bIdx && epochs.length >= 2 && <div className="alert">Pick two different epochs: subtracting an epoch from itself is blank.</div>}
                  {dMismatch && <div className="alert warn" data-testid="diff-warning">⚠ {dMismatch}</div>}
                  <p className="keyline"><span className="sw blue" /> It was here <span className="sw orange" /> It is here now</p>
                </>
              )}
              {!pair && (
                <>
                  {cur && !rest.length && framesState === "done" && <div className="alert" data-testid="each-alone">This is the only {cur.survey === "wise" ? "WISE" : "SPHEREx"} date at this wavelength, so there is nothing to subtract from it.</div>}
                  <p className="keyline" data-testid="each-key"><span className="sw orange" /> Brighter on this date than on the others <span className="sw blue" /> Fainter</p>
                </>
              )}
            </div>
          )}
          {animated && (
            <div className="transport" data-testid="transport">
              <button className="btn sq" onClick={() => step(-1)} aria-label="Previous date" disabled={frames.length < 2}><svg viewBox="0 0 16 16" aria-hidden><path d="M10 3 5 8l5 5" /></svg></button>
              <button className="btn solid play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"} data-testid="play" disabled={avail.length < 2}>{playing
                  ? <><svg viewBox="0 0 16 16" aria-hidden className="fill"><path d="M4 3h3v10H4zM9 3h3v10H9z" /></svg><span>Pause</span></>
                  : <><svg viewBox="0 0 16 16" aria-hidden className="fill"><path d="M4.5 2.5v11l9-5.5z" /></svg><span>Play</span></>}</button>
              <button className="btn sq" onClick={() => step(1)} aria-label="Next date" disabled={frames.length < 2}><svg viewBox="0 0 16 16" aria-hidden><path d="M6 3l5 5-5 5" /></svg></button>
              <span className="count" data-testid="frame-count">{frames.length ? `${fi + 1} of ${frames.length}` : ""}</span>
              <label className="inline">Speed
                <input type="range" min="0.25" max="6" step="0.25" value={s.speed} onChange={(e) => set({ speed: +e.target.value })} aria-label="Playback speed" />
                <span className="mono">{s.speed}/s</span>
              </label>
              {cur && !many && listing === "done" && (cur.flags.length > 0
                ? <span className="badge warn" data-testid="flags" title={cur.flags.map((f) => `${f.replace(/_/g, " ")}: ${flagHelp(f)}`).join("\n")}>{cur.flags.length} quality {cur.flags.length === 1 ? "flag" : "flags"}</span>
                : <span className="badge ok" title="No quality flags near the centre">clean</span>)}
            </div>
          )}
          {animated && n > 1 && (
            <div className="combine" data-testid="combine">
              <label className="field">Combine dates within <span className="val">{s.win ? `${Math.min(s.win, winMax)} ${Math.min(s.win, winMax) === 1 ? "year" : "years"}` : "off, single dates"}</span>
                <input type="range" min="0" max={winMax} step="0.5" value={Math.min(s.win, winMax)} onChange={(e) => set({ win: +e.target.value })} aria-label="Combine dates within this many years" data-testid="win" /></label>
              <label className="check"><input type="checkbox" checked={s.ends} onChange={(e) => set({ ends: e.target.checked })} data-testid="ends" /> First and last dates only</label>
            </div>
          )}
          {s.mode === "rainbow" && (
            <p className="keyline" data-testid="rainbow-help"><span className="ramp" /> Oldest to newest. White means it did not move or change.</p>
          )}

          <Filmstrip epochs={epochs} thumbs={thumbs} marks={marks} onSelect={selectEpoch} />
          <Timeline epochs={epochs} marks={marks} onSelect={selectEpoch} />
          <p className="prog" data-testid="progress" role="status">
            {framesState === "loading" ? "Looking up exposures…" : n ? `${prog.done} of ${prog.total} images loaded${prog.done < prog.total ? ` · now fetching ${prog.current}` : ""}${prog.failed ? ` · ${prog.failed} failed (${prog.lastErr})` : ""}${listing === "full" ? ". Still checking wavelengths and quality flags for every exposure." : ""}` : ""}
          </p>
        </main>

        {/* ---------------- right: instrument settings ---------------- */}
        <aside className="rail right">
          <section>
            <h2 className="h">View</h2>
            <label className="field">Field of view <span className="val">{s.fov}′</span>
              <input type="range" min="1" max="30" step="0.5" value={s.fov} onChange={(e) => { cache.current.clear(); set({ fov: +e.target.value }); }} aria-label="Field of view" data-testid="fov" /></label>
            <label className="field">Wavelength
              <select value={det} onChange={(e) => set({ det: +e.target.value, frame: 0, a: null, b: null })} data-testid="detector">
                {(detInfo.length ? detInfo : [1, 2, 3, 4, 5, 6].map((d) => ({ detector: d, wl: 0, passes: [] as number[], nFrames: 0 }))).map((d) => <option key={d.detector} value={d.detector}>{d.wl ? `${d.wl.toFixed(1)} µm, ` : ""}detector {d.detector}{d.passes.length ? `, ${d.passes.length} passes` : ""}</option>)}
              </select></label>
            <label className="field">Images
              <select value={s.src} onChange={(e) => set({ src: e.target.value as "stack" | "frame", frame: 0, a: null, b: null })} data-testid="src">
                <option value="stack">One per pass (combined)</option><option value="frame">Every single exposure</option></select></label>
            <label className="check"><input type="checkbox" checked={s.wise} onChange={(e) => set({ wise: e.target.checked, frame: 0, a: null, b: null })} data-testid="wise-toggle" /> Add WISE images, 2010 to 2024{wise.length === 0 && framesState === "done" ? " (none)" : ""}</label>
            <label className="check"><input type="checkbox" checked={s.cross} onChange={(e) => set({ cross: e.target.checked })} /> Crosshair</label>
            <label className="check"><input type="checkbox" checked={ov.gaia} onChange={(e) => setOv((o) => ({ ...o, gaia: e.target.checked }))} data-testid="ov-gaia" /> Mark Gaia catalogue stars</label>
            <label className="check"><input type="checkbox" checked={ov.motion} onChange={(e) => setOv((o) => ({ ...o, motion: e.target.checked }))} data-testid="ov-motion" /> Arrows on stars Gaia says are moving</label>
            <label className="check"><input type="checkbox" checked={ov.known} onChange={(e) => setOv((o) => ({ ...o, known: e.target.checked }))} data-testid="ov-known" /> Label known asteroids</label>
            {ovBusy && (ov.gaia || ov.motion || ov.known) && <p className="dim small" role="status">{ovBusy}</p>}
            {(ov.gaia || ov.motion || ov.known) && <p className="dim small">A mover with no ring, arrow or label is one no catalogue lists here.</p>}
            <label className="check"><input type="checkbox" checked={s.sharp} onChange={(e) => set({ sharp: e.target.checked })} data-testid="sharp-toggle" /> Sharp pixels</label>
            <label className="check"><input type="checkbox" checked={s.inv} onChange={(e) => set({ inv: e.target.checked })} data-testid="invert-toggle" /> Invert, white sky and dark stars</label>
            {wiseNote && <p className="dim small">{wiseNote}</p>}
            {s.mode !== "diff" && (
              <details className="more" open={s.bp !== DEFAULTS.bp || s.wp !== DEFAULTS.wp || s.stretch !== "asinh"}>
                <summary>Brightness and contrast</summary>
                <div className="stretch" data-testid="stretch">
                  <div className="seg" role="group" aria-label="Stretch">
                    {(["asinh", "linear", "log"] as const).map((k) => <button key={k} className={`segbtn ${s.stretch === k ? "on" : ""}`} onClick={() => set({ stretch: k })} data-testid={`stretch-${k}`}>{k}</button>)}
                  </div>
                  <label className="field">Black point <span className="val">{s.bp}%</span><input type="range" min="0" max="95" step="1" value={s.bp} onChange={(e) => set({ bp: Math.min(+e.target.value, s.wp - 1) })} data-testid="bp" /></label>
                  <label className="field">White point <span className="val">{s.wp}%</span><input type="range" min="90" max="100" step="0.1" value={s.wp} onChange={(e) => set({ wp: Math.max(+e.target.value, s.bp + 1) })} data-testid="wp" /></label>
                  <button className="btn small" onClick={() => set({ bp: DEFAULTS.bp, wp: DEFAULTS.wp, stretch: "asinh" })}>Reset</button>
                </div>
              </details>
            )}
          </section>

          <section>
            <h2 className="h">Data available here</h2>
            <p className="dim small">Columns are SPHEREx passes over this spot, rows are wavelengths. Numbers count exposures. Click a cell to view it, or drag across passes to limit the dates.</p>
            <Pad
              frames={spx} detector={det} passFrom={passFrom} passTo={passTo} currentPass={cur?.survey === "spherex" ? cur.pass : null}
              onSelect={(sel) => {
                if (sel.click) set({ det: sel.detector, pf: null, pt: null, frame: Math.max(0, epochs.findIndex((e) => e.survey === "spherex" && e.pass === sel.passFrom)), a: null, b: null });
                else set({ det: sel.detector, pf: sel.passFrom, pt: sel.passTo, frame: 0, a: null, b: null });
              }}
            />
            {(s.pf != null || s.pt != null) && <button className="btn small" onClick={() => set({ pf: null, pt: null, frame: 0 })}>Use all passes</button>}
          </section>

          <section data-testid="lightcurve-panel">
            <h2 className="h">Brightness over time</h2>
            {expected
              ? <p className="dim">This object moves, so its brightness at one fixed spot is not a fair measure. The spectrum below is taken where it is now.</p>
              : centre.state === "done" && centrePicked
              ? <LightCurve curves={curves} kind={centrePicked.kind} />
              : centre.state === "error"
                ? <p className="dim">The brightness at the centre could not be measured.</p>
                : <p className="dim" role="status">{framesState === "done" && !spx.length ? "No SPHEREx data here." : <><i className="spin" /> Measuring whatever sits at the centre in every exposure…</>}</p>}
          </section>

          <section data-testid="spectrum-panel">
            <h2 className="h">Spectrum</h2>
            {spec.state === "loading" && <p className="dim" role="status"><i className="spin" /> Measuring the spectrum there. Near the centre this takes a few seconds; far from it, up to a minute.</p>}
            {spec.state === "error" && <p className="alert">Spectrum failed: {spec.err}</p>}
            {spec.state === "done" && picked && clickedPicked && <Spectrum picked={clickedPicked} title={`Where you clicked: RA ${picked.ra.toFixed(5)}, Dec ${picked.dec.toFixed(5)}`} />}
            {spec.state === "idle" && (centrePicked && centrePicked.pts.length
              ? <Spectrum picked={centrePicked} title={expected ? `${target?.name ?? "The object"}, measured where it is now` : "At the centre of the picture"} />
              : <p className="dim" role="status">{centre.state === "done" ? "Nothing bright enough to measure at that spot." : <><i className="spin" /> Measuring brightness at every wavelength. This can take up to a minute the first time.</>}</p>)}
            {spec.state !== "loading" && <p className="dim small">Click any star in the picture to see its spectrum instead.</p>}
          </section>

          <section>
            <MotionLab norms={norms} epochs={epochs} fovArcmin={s.fov} catalogPm={target?.pm_mas_yr} picked={picked ? { x: picked.x, y: picked.y } : null} pickedMs={cur?.ms}
              onMarks={(marks, path) => setLab({ marks, path: path ?? [] })} />
          </section>

          <section data-testid="planetx-panel">
            <h2 className="h">Could you spot a Planet X?</h2>
            <p className="dim small">Hide a simulated distant planet in these real images, then try to find it. Nothing like it has been found; this tests whether the pictures could show one.</p>
            <label className="check"><input type="checkbox" checked={px.on} onChange={(e) => setPx((v) => ({ ...v, on: e.target.checked, reveal: false, seed: e.target.checked ? Math.floor(Math.random() * 1e9) : v.seed }))} data-testid="px-toggle" /> Hide a simulated planet</label>
            {px.on && (
              <div className="pxbox">
                <label className="field">Distance from the Sun
                  <select value={px.dist} onChange={(e) => setPx((v) => ({ ...v, dist: +e.target.value, reveal: false }))} data-testid="px-dist">
                    {[500, 2000, 5000, 20000].map((d) => <option key={d} value={d}>{d.toLocaleString("en")} times the Earth-Sun distance</option>)}
                  </select></label>
                <label className="field">Brightness
                  <select value={px.snr} onChange={(e) => setPx((v) => ({ ...v, snr: +e.target.value, reveal: false }))} data-testid="px-snr">
                    <option value={6}>Faint, barely above the noise</option><option value={12}>Medium</option><option value={30}>Bright</option>
                  </select></label>
                <p className="dim small">At that distance it swings {fmtArc(apparentMotion(px.dist).wobbleArcsec)} each way every year as the Earth moves, and drifts {fmtArc(apparentMotion(px.dist).driftArcsecYr)} a year along its orbit.</p>
                {planet && planet.inView < Math.max(2, epochs.length / 2) && <p className="alert warn">That swing is wider than this picture, so it is out of view on most dates. Widen the field of view to about {Math.min(30, Math.max(Math.ceil(s.fov) + 3, Math.ceil(((2 * apparentMotion(px.dist).wobbleArcsec + apparentMotion(px.dist).driftArcsecYr * (epochs.length > 1 ? msToYear(epochs[n - 1].ms) - msToYear(epochs[0].ms) : 1)) * 1.6) / 60)))}′, or pick a larger distance.</p>}
                <div className="row">
                  <button className="btn small" onClick={() => setPx((v) => ({ ...v, reveal: !v.reveal }))} data-testid="px-reveal">{px.reveal ? "Hide the answer" : "Show where it is"}</button>
                  <button className="btn small" onClick={() => setPx((v) => ({ ...v, seed: Math.floor(Math.random() * 1e9), reveal: false }))}>Hide it somewhere else</button>
                </div>
              </div>
            )}
          </section>
          <section>
            <ContextPanel view={view} />
          </section>
        </aside>
      </div>

      {!s.embed && (
        <footer className="foot">
          <span>Data from NASA/IPAC IRSA (SPHEREx) and unWISE via WiseView (WISE, NEOWISE). North is up, east is left.</span>
          <span>Copy the address bar to share this view. Space plays or pauses, arrow keys step. Drag the picture to move, scroll to zoom.</span>
        </footer>
      )}
    </div>
  );
}

function describe(e: Epoch | undefined): string {
  if (!e) return "";
  return e.survey === "wise" ? `${e.label}` : e.kind === "stack" ? `stack for pass ${e.pass}, detector ${e.detector}` : `exposure from pass ${e.pass}, detector ${e.detector}`;
}

/** Plain-language direction of a proper motion vector (east-positive, north-positive). */
function compassDir(pmRa: number, pmDec: number): string {
  const ang = (Math.atan2(pmRa, pmDec) * 180) / Math.PI; // 0 = north, 90 = east
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[((Math.round(ang / 45) % 8) + 8) % 8];
}

/** An angle in arcseconds, written the way a person would say it. */
function fmtArc(a: number): string {
  return a >= 120 ? `${(a / 60).toFixed(a >= 600 ? 0 : 1)} arcminutes` : `${a >= 10 ? a.toFixed(0) : a.toFixed(1)} arcseconds`;
}

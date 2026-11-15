"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import { fmtDec, fmtRA, resolveInput } from "@/lib/coords";
import { animFrames, buildEpochs, defaultDetector, detectorInfo, fmtDate, flagHelp, groupOf, restOf, type AnimFrame, type Epoch } from "@/lib/epochs";
import { combine, difference, levels, minusRest, normalise, paintDiff, rainbow, sharedLevels, toGray, type DiffField, type Norm } from "@/lib/render";
import { lightCurve, pickMeasure } from "@/lib/photometry";
import { centroid, fitMotion, msToYear, type Sample } from "@/lib/motion";
import { hideObject, PLANETX_DEFAULT, type PlanetXValue } from "@/lib/planetx";
import PlanetXPanel from "./PlanetXPanel";
import { DEFAULTS, readState, writeState, type AppState, type Mode } from "@/lib/urlstate";
import type { Frame, SpectrumPoint, Target } from "@/lib/types";
import Viewer, { Readout } from "./Viewer";
import Icon from "./Icon";
import Inspector, { type InspectorPanel } from "./Inspector";
import Timeline, { type Mark } from "./Timeline";
import Pad from "./Pad";
import Spectrum from "./Spectrum";
import Walkthrough from "./Walkthrough";
import Filmstrip from "./Filmstrip";
import LightCurve from "./LightCurve";
import MotionLab from "./MotionLab";
import SkyOverlay from "./SkyOverlay";
import ContextPanel from "./ContextPanel";
import { getGaia, getKnownObjects, lookupGaia, lookupKnownObjects, pickKnownTimes } from "@/lib/overlays";

const SIZE = api.IMG_SIZE;
type Hover = { x: number; y: number; ra: number; dec: number } | null;

export default function App() {
  const [s, setS] = useState<AppState>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [backend, setBackend] = useState<{ mock: boolean; reason?: string } | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [desktopControls, setDesktopControls] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1180px)");
    const sync = () => setDesktopControls(media.matches);
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const [panel, setPanel] = useState<InspectorPanel | null>(null);
  const [analysisTab, setAnalysisTab] = useState("motion");
  const [showFrames, setShowFrames] = useState(false);
  const [loop, setLoop] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const [spx, setSpx] = useState<Frame[]>([]);
  const [wise, setWise] = useState<Frame[]>([]);
  const [listedView, setListedView] = useState("");
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
  const spectrumRequest = useRef<AbortController | null>(null);
  const [specSeconds, setSpecSeconds] = useState(0);
  const imageRequests = useRef({ controller: new AbortController(), pending: new Map<string, Promise<Norm>>() });

  useEffect(() => {
    if (spec.state !== "loading") return;
    setSpecSeconds(0);
    const timer = setInterval(() => setSpecSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [spec.state]);

  const [listing, setListing] = useState<"quick" | "full" | "done">("done"); // how complete the exposure list is
  const [autoDet, setAutoDet] = useState<number | null>(null);
  const [centre, setCentre] = useState<{ state: "idle" | "loading" | "done" | "error"; points: SpectrumPoint[] }>({ state: "idle", points: [] });
  const [px, setPx] = useState<PlanetXValue>(PLANETX_DEFAULT);
  const [resolving, setResolving] = useState(false);
  const nameRequest = useRef<AbortController | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const nowPos = useRef<{ ra: number; dec: number } | null>(null);
  const [ov, setOv] = useState({ gaia: false, motion: false, known: false });
  const [gaia, setGaia] = useState<Awaited<ReturnType<typeof getGaia>>>([]);
  const [known, setKnown] = useState<Awaited<ReturnType<typeof getKnownObjects>>>([]);
  const [gaiaStatus, setGaiaStatus] = useState({ loading: false, error: false, text: "" });
  const [knownStatus, setKnownStatus] = useState({ loading: false, error: false, text: "" });
  const [gaiaRetry, retryGaia] = useState(0);
  const [knownRetry, retryKnown] = useState(0);
  const [reload, setReload] = useState(0);
  const [imageAttempt, setImageAttempt] = useState(0);
  const [lab, setLab] = useState<{ marks: { x: number; y: number; label?: string }[]; path: { x: number; y: number }[] }>({ marks: [], path: [] });

  const set = useCallback((p: Partial<AppState>) => setS((o) => ({ ...o, ...p })), []);

  // ---- init from URL
  useEffect(() => {
    const st = readState(window.location.search);
    const q = new URLSearchParams(window.location.search);
    // A bare link opens on the clearest view we have: WISE 0855 blinking through 16 years of WISE and SPHEREx.
    if (!q.has("ra") && !q.has("mode")) { st.mode = "blink"; st.wise = true; }
    if (!q.has("play") && window.matchMedia("(prefers-reduced-motion: reduce)").matches) st.play = false;
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
    const requests = { controller: new AbortController(), pending: new Map<string, Promise<Norm>>() };
    imageRequests.current = requests;
    cache.current.clear();
    return () => { requests.controller.abort(); spectrumRequest.current?.abort(); nameRequest.current?.abort(); };
  }, [viewKey, reload]);
  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    setListedView(viewKey);
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
  }, [ready, viewKey, reload]);

  const detInfo = useMemo(() => detectorInfo(spx), [spx]);
  const det = s.det ?? autoDet ?? defaultDetector(spx);
  const allPasses = useMemo(() => [...new Set(spx.map((f) => f.pass))].sort((a, b) => a - b), [spx]);
  const passFrom = Math.min(allPasses[allPasses.length - 1] ?? 1, Math.max(s.pf ?? allPasses[0] ?? 1, allPasses[0] ?? 1));
  const passTo = Math.max(passFrom, Math.min(s.pt ?? allPasses[allPasses.length - 1] ?? 1, allPasses[allPasses.length - 1] ?? 1));
  const epochs = useMemo(() => buildEpochs(spx, wise, { src: s.src, detector: det, includeWise: s.wise, passFrom, passTo }), [spx, wise, s.src, det, s.wise, passFrom, passTo]);

  // ---- progressive image loading (current epoch first)
  const imgKey = (e: Epoch) => `${viewKey}|${e.key}`;
  const frameIdx = Math.min(s.frame, Math.max(0, epochs.length - 1));
  useEffect(() => {
    if (!ready || listedView !== viewKey || !epochs.length) { setProg({ done: 0, total: 0, current: "", failed: 0, lastErr: "" }); return; }
    const requests = imageRequests.current;
    const signal = requests.controller.signal;
    let active = true;
    const order = [...epochs.keys()].sort((i, j) => (i === frameIdx ? -1 : j === frameIdx ? 1 : i - j));
    const todo = order.map((i) => epochs[i]).filter((e) => !cache.current.has(imgKey(e)));
    let done = epochs.length - todo.length, failed = 0, lastErr = "";
    setProg({ done, total: epochs.length, current: "", failed, lastErr });
    let next = 0;
    const worker = async () => {
      while (active && !signal.aborted) {
        const e = todo[next++];
        if (!e) return;
        setProg((p) => ({ ...p, current: describe(e) }));
        try {
          const key = imgKey(e);
          let request = requests.pending.get(key);
          if (!request) {
            request = (e.kind === "stack" ? api.getStack(view, e.pass, e.detector!, signal) : api.getFrameImage(e.frame!, view, signal))
              .then((img) => {
                const norm = normalise(img);
                if (!signal.aborted) { cache.current.set(key, norm); setVer((v) => v + 1); }
                return norm;
              });
            requests.pending.set(key, request);
          }
          try { await request; } finally { if (requests.pending.get(key) === request) requests.pending.delete(key); }
          if (!active || signal.aborted) return;
          done++;
        } catch (err: any) {
          if (!active || signal.aborted) return;
          failed++; lastErr = err?.message ?? String(err);
        }
        setProg({ done, total: epochs.length, current: next < todo.length ? describe(todo[next] ?? e) : "", failed, lastErr });
      }
    };
    void Promise.all(Array.from({ length: 6 }, worker));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, framesState, epochs, viewKey, listedView, imageAttempt]);

  const rawNorms = useMemo(() => epochs.map((e) => cache.current.get(imgKey(e)) ?? null), [epochs, ver, viewKey]); // eslint-disable-line
  const planet = useMemo(() => hideObject(rawNorms, epochs.map((e) => e.ms), px, s.fov),
    [px.on, px.kind, px.dist, px.snr, px.seed, px.pmEast, px.pmNorth, rawNorms, epochs, s.fov]); // eslint-disable-line react-hooks/exhaustive-deps
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
        if (!loop && at === av[av.length - 1]) { setPlaying(false); return; }
        const nxt = av.find((k) => k > at) ?? av[0];
        if (nxt < at) setLoopTick((v) => v + 1);
        setS((o) => ({ ...o, frame: fr[nxt].idx }));
        if (nxt === av[av.length - 1]) hold = 1.8;
      }
      t = setTimeout(tick, (hold * 1000) / s.speed);
    };
    t = setTimeout(tick, 1000 / s.speed);
    return () => clearTimeout(t);
  }, [playing, animated, s.speed, loop]);
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
  useEffect(() => {
    if (!target) return;
    document.querySelector(`[data-testid="target-${target.id}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
  }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps
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

  // ---- Catalogue failures must not look like a successful empty sky.
  useEffect(() => { setLab({ marks: [], path: [] }); }, [viewKey]);
  const wantsGaia = ov.gaia || ov.motion;
  useEffect(() => {
    setGaia([]);
    if (!wantsGaia) { setGaiaStatus({ loading: false, error: false, text: "" }); return; }
    const ctl = new AbortController();
    setGaiaStatus({ loading: true, error: false, text: "Looking up Gaia stars…" });
    lookupGaia(view, ctl.signal).then((result) => {
      if (ctl.signal.aborted) return;
      setGaia(result.items);
      setGaiaStatus({ loading: false, error: result.unavailable, text: result.note || `${result.items.length} Gaia stars returned for this field.` });
    });
    return () => ctl.abort();
  }, [wantsGaia, viewKey, gaiaRetry]); // eslint-disable-line react-hooks/exhaustive-deps
  const spxTimes = useMemo(() => epochs.filter((e) => e.survey === "spherex" && e.kind === "frame").map((e) => e.time), [epochs]);
  const knownTimesKey = pickKnownTimes(spxTimes).join(",");
  useEffect(() => {
    setKnown([]);
    if (!ov.known || !knownTimesKey) { setKnownStatus({ loading: false, error: false, text: "" }); return; }
    const ctl = new AbortController();
    setKnownStatus({ loading: true, error: false, text: "Looking up known asteroids at the selected exposure dates…" });
    lookupKnownObjects(view, knownTimesKey.split(","), ctl.signal).then((result) => {
      if (ctl.signal.aborted) return;
      setKnown(result.items);
      setKnownStatus({ loading: false, error: result.unavailable, text: result.note || (result.items.length ? `${result.items.length} known-object positions returned.` : "The catalogue returned no known objects for the checked dates.") });
    });
    return () => ctl.abort();
  }, [ov.known, viewKey, knownTimesKey, knownRetry]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keyboard: space plays, arrows step
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (document.querySelector("dialog[open]") || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || el?.closest("input,select,textarea,button,a,summary,[contenteditable=true],.data-table")) return;
      if (!animated || frames.length < 2) return;
      if (e.key === " ") { e.preventDefault(); if (!e.repeat) togglePlayback(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [animated, frames, fi, playing, loop]); // eslint-disable-line

  // ---- actions
  const jump = (ra: number, dec: number, label: string | undefined, extra: Partial<AppState> = {}) => {
    nameRequest.current?.abort(); setResolving(false);
    setInputMsg({ kind: "ok", text: label ? `${label}: ${ra.toFixed(5)}, ${dec.toFixed(5)}` : `${fmtRA(ra)}  ${fmtDec(dec)}` });
    setInput(`${ra.toFixed(5)} ${dec.toFixed(5)}`);
    setPx((p) => ({ ...p, on: false, reveal: false }));
    set({ ra, dec, frame: 0, a: null, b: null, pf: null, pt: null, det: null, ...extra });
  };
  const go = async (text: string) => {
    const r = resolveInput(text, targets);
    if (r.ok) {
      const t = targets.find((x) => x.name === r.label);
      if (t) setAnalysisTab(t.kind === "variable" ? "brightness" : "motion");
      // movers need the long WISE baseline to show motion; variables are clearest as a blink
      jump(r.ra, r.dec, r.label, t?.kind === "mover" ? { wise: true } : t?.kind === "variable" ? { wise: false, mode: "blink" } : {});
      return;
    }
    const name = text.trim();
    if (!name || !/[a-z]/i.test(name) || /^[\d\s.+\-:hmsd°'"]+$/i.test(name)) { setInputMsg({ kind: "err", text: r.error }); return; }
    // not coordinates and not a test target: ask the name service (any star, galaxy or nebula)
    nameRequest.current?.abort();
    const controller = new AbortController(); nameRequest.current = controller;
    setResolving(true); setInputMsg({ kind: "ok", text: `Looking up "${name}"…` });
    try {
      const hit = await api.resolveName(name, controller.signal);
      if (controller.signal.aborted) return;
      if (hit) jump(hit.ra, hit.dec, hit.name);
      else setInputMsg({ kind: "err", text: `No object called "${name}" was found. Check the spelling, or enter RA and Dec.` });
    } catch (e: any) { if (!controller.signal.aborted) setInputMsg({ kind: "err", text: e?.message ?? "Name lookup failed. Enter RA and Dec instead." }); }
    finally { if (nameRequest.current === controller) setResolving(false); }
  };
  const applyWalk = (p: Partial<AppState>) => { set({ ...p, frame: 0, a: null, b: null, pf: null, pt: null, det: null }); setInput(`${(p.ra ?? s.ra).toFixed(5)} ${(p.dec ?? s.dec).toFixed(5)}`); setInputMsg(null); };
  // drag, double-click, wheel and pinch on the picture: same settings, new patch of sky
  const recentre = (ra: number, dec: number) => {
    setInput(`${ra.toFixed(5)} ${dec.toFixed(5)}`); setInputMsg(null);
    set({ ra, dec: Math.max(-90, Math.min(90, dec)) });
  };
  const zoom = (fov: number) => { cache.current.clear(); set({ fov }); };
  const pick = async (p: { x: number; y: number; ra: number; dec: number }) => {
    spectrumRequest.current?.abort();
    const controller = new AbortController();
    spectrumRequest.current = controller;
    setPicked(p);
    setSpecSeconds(0);
    setSpec({ state: "loading", points: [] });
    try {
      const r = await api.getSpectrum(p.ra, p.dec, view, 6, controller.signal);
      if (!controller.signal.aborted) setSpec({ state: "done", points: r.points });
    } catch (e: any) { if (!controller.signal.aborted) setSpec({ state: "error", points: [], err: e?.message ?? String(e) }); }
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
  const modeName: Record<Mode, string> = { blink: "Blink", rainbow: "Trail", diff: "Difference" };

  const spanYr = n > 1 ? (epochs[n - 1].ms - epochs[0].ms) / (365.25 * 86400000) : 0;
  const winMax = Math.max(0.5, Math.ceil(spanYr * 2) / 2);

  const togglePlayback = () => {
    if (!playing && !loop && fi === frames.length - 1 && frames.length) set({ frame: frames[0].idx });
    setPlaying((value) => !value);
  };
  const analysisTabs = [{ id: "motion", label: "Motion" }, { id: "spectrum", label: "Spectrum" }, { id: "brightness", label: "Brightness" }, { id: "planet", label: "Simulate" }, { id: "context", label: "Context" }];

  return (
    <div ref={root} className={`app cinema ${s.embed ? "embed" : ""} ${desktopControls && !s.embed ? "desktop-controls" : ""} ${backend?.mock ? "has-demo" : ""}`}>
      <a className="skip-link" href="#sky-panel">Skip to sky viewer</a>
      {!s.embed && <header className="top">
        <a className="wordmark" href="./" aria-label="SPHEREx Drift, start over">SPHEREx <span>DRIFT</span></a>
        <div className="top-actions">
          {!desktopControls && <><button type="button" className="toolbar-button" data-testid="open-view" aria-haspopup={desktopControls ? undefined : "dialog"} onClick={() => setPanel("view")}><Icon name="view" /><span>View</span></button>
          <button type="button" className="toolbar-button" data-testid="open-analysis" aria-haspopup={desktopControls ? undefined : "dialog"} onClick={() => setPanel("analyze")}><Icon name="analyze" /><span>Analyze</span></button></>}
          <button type="button" className="icon-button" aria-label="Field notes and help" aria-haspopup="dialog" onClick={() => setPanel("about")}><Icon name="help" /></button>
        </div>
      </header>}
      {backend?.mock && (
        <div className="banner" role="status" data-testid="mock-banner">
          {backend.reason === "unreachable" ? "Offline · synthetic sky" : "Demo · synthetic sky"}
          <button type="button" className="btn small" disabled={reconnecting} onClick={async () => {
            setReconnecting(true);
            try { const result = await api.detectBackend(false); setBackend(result); if (!result.mock) { setTargets(await api.getTargets()); set({ mock: false }); setReload((n) => n + 1); } }
            finally { setReconnecting(false); }
          }}>{reconnecting ? "Connecting…" : "Retry real data"}</button>
        </div>
      )}
      {!s.embed && <nav className="target-rail" aria-label="Choose a target">
        <ul className="target-list" data-testid="targets">
          {targets.map((item) => <li key={item.id}>
            <button type="button" className={`target-card ${target?.id === item.id ? "active" : ""}`} aria-current={target?.id === item.id ? "true" : undefined} aria-label={`${item.name}, ${item.kind === "variable" ? "variable star" : "moving object"}`} onClick={() => { setInput(item.name); go(item.name); }} data-testid={`target-${item.id}`} title={item.note}>
              <span className="target-name">{item.name}</span>
              <span className="target-symbol"><Icon name={item.kind === "variable" ? "variable" : "motion"} /></span>
            </button>
          </li>)}
        </ul>
      </nav>}
      <main className="stage" id="sky-panel" tabIndex={-1} aria-label="Sky viewer">
        <h1 className="title sr-only">{target?.name ?? "Custom sky position"}</h1>
        <div className="screen">
          <Viewer
            image={image} size={SIZE} fov={s.fov} ra={s.ra} dec={s.dec} crosshair={s.cross} busy={busy} picked={picked}
            onHover={setHover} onPick={(point) => { setPlaying(false); pick(point); setAnalysisTab("spectrum"); setPanel("analyze"); }} caption={caption} marks={[...allMarks, ...lab.marks.map((m) => ({ ...m, tone: "b" as const }))]} path={lab.path.length > 1 ? lab.path : pmPath} hud={hud}
            sharp={s.sharp && s.mode !== "rainbow"} invert={s.inv && s.mode !== "rainbow"} loopTick={animated ? loopTick : 0}
            onRecentre={recentre} onZoom={zoom} loading={busy != null}
          >
            {(ov.gaia || ov.motion || ov.known) && s.mode !== "rainbow" && cur && (
              <SkyOverlay view={view} epochMs={cur.ms} spanMs={epochs.length > 1 ? [epochs[0].ms, epochs[n - 1].ms] : undefined}
                gaia={gaia} known={known} showGaia={ov.gaia} showMotion={ov.motion} showKnown={ov.known && cur.survey === "spherex" && cur.kind === "frame"} invert={s.inv} />
            )}
          </Viewer>

          <div className="screen-topline">
            <span className="screen-label">{s.mode === "rainbow" ? "ALL DATES" : s.mode === "diff" ? "DIFFERENCE" : srcName || "SKY ARCHIVE"}</span>
            {px.on && <span className="simulation-tag" data-testid="px-note">Simulated object added</span>}
          </div>
          <div className={`coordinate-readout ${hover ? "has-point" : ""}`}><Readout hover={hover} value={hoverVal} /></div>
          {framesState === "error" && <div className="screen-alert alert" data-testid="frames-error">{framesErr}<button type="button" className="btn small" onClick={() => setReload((value) => value + 1)} data-testid="frames-retry">Retry</button></div>}
          {noCoverage && <div className="screen-alert alert" data-testid="no-coverage">No SPHEREx coverage. Choose another target.</div>}
        </div>
        <div className="player-dock" data-testid="transport">
          <div className="seek-row">
            <span className="seek-date">{epochs[0] ? fmtDate(epochs[0].ms).slice(0, 4) : "—"}</span>
            <input type="range" className="seek" min="0" max={Math.max(0, frames.length - 1)} step="1" value={fi} disabled={!animated || frames.length < 2} aria-label="Seek observation date" aria-valuetext={`${fi + 1} of ${frames.length} dates${when ? `, ${when}` : ""}`} data-testid="seek" style={{ "--seek": `${frames.length > 1 ? fi / (frames.length - 1) * 100 : 0}%` } as React.CSSProperties} onChange={(event) => { setPlaying(false); const frame = frames[+event.target.value]; if (frame) set({ frame: frame.idx }); }} />
            <span className="seek-date">{epochs[n - 1] ? fmtDate(epochs[n - 1].ms).slice(0, 4) : "—"}</span>
          </div>
          <div className="player-row">
            <div className="playback-buttons">
              <button type="button" className="icon-button" onClick={() => step(-1)} aria-label="Previous date" title="Previous date" disabled={!animated || frames.length < 2}><Icon name="previous" /></button>
              <button type="button" className="play-button" onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause · Space" : "Play · Space"} data-testid="play" disabled={!animated || avail.length < 2}><Icon name={playing && animated ? "pause" : "play"} /></button>
              <button type="button" className="icon-button" onClick={() => step(1)} aria-label="Next date" title="Next date" disabled={!animated || frames.length < 2}><Icon name="next" /></button>
              <span className="count" data-testid="frame-count">{frames.length ? `${fi + 1} of ${frames.length}` : "—"}</span>
            </div>
          <div className="tabs" role="tablist" aria-label="Sky image display mode">
            {(["blink", "rainbow", "diff"] as Mode[]).map((m) => (
              <button key={m} id={`tab-${m}`} role="tab" tabIndex={s.mode === m ? 0 : -1} aria-selected={s.mode === m} className={`tab ${s.mode === m ? "on" : ""}`} onClick={() => set({ mode: m })} onKeyDown={(event) => {
                const modes: Mode[] = ["blink", "rainbow", "diff"];
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (modes.indexOf(m) + (event.key === "ArrowRight" ? 1 : 2)) % 3;
                set({ mode: modes[next] }); document.getElementById(`tab-${modes[next]}`)?.focus();
              }} data-testid={`mode-${m}`}>
                <span className="tl">{modeName[m]}</span>
              </button>
            ))}
          </div>


            <div className="player-extras">
              <select className="speed-select" value={s.speed} onChange={(event) => set({ speed: +event.target.value })} aria-label="Playback speed" data-testid="speed">{[...new Set([0.5, 1, 2, 3, 4, 6, s.speed])].sort((a, b) => a - b).map((rate) => <option key={rate} value={rate}>{rate / 2}×</option>)}</select>
              <button type="button" className="icon-button" aria-label="Loop playback" title="Loop playback" aria-pressed={loop} data-testid="loop-toggle" onClick={() => setLoop((value) => !value)}><Icon name="loop" /></button>
              <button type="button" className="icon-button" aria-label={showFrames ? "Hide frames" : "Show frames"} title="Browse frames" aria-pressed={showFrames} aria-expanded={showFrames} aria-controls="frame-browser" data-testid="frames-toggle" onClick={() => setShowFrames((value) => !value)}><Icon name="frames" /></button>
              <button type="button" className="icon-button" aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} title="Fullscreen" aria-pressed={fullscreen} data-testid="fullscreen" onClick={async () => { setFullscreenError(""); try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.current?.requestFullscreen(); } catch { setFullscreenError("Fullscreen is unavailable in this browser or embed."); } }}><Icon name="expand" /></button>
            </div>
          </div>
          <span className="sr-only" data-testid="caption">{caption}{cur ? `, ${cur.wl.toFixed(2)} µm` : ""}</span>
          {s.mode === "diff" && (
            <div className="diffctl" data-testid="diffctl">
              <div className="seg" role="group" aria-label="What to subtract">
                <button className={`segbtn ${s.diff === "each" ? "on" : ""}`} aria-pressed={s.diff === "each"} onClick={() => set({ diff: "each" })} data-testid="diff-each">Isolate</button>
                <button className={`segbtn ${s.diff === "pair" ? "on" : ""}`} aria-pressed={s.diff === "pair"} onClick={() => set({ diff: "pair" })} data-testid="diff-pair">Compare</button>
              </div>
              {pair && (
                <>
                  <div className="diffpick">
                    <label>A · subtract
                      <select value={aIdx} onChange={(e) => set({ a: +e.target.value })} data-testid="diff-a">{epochs.map((e, i) => <option key={e.key} value={i}>{e.label} · {fmtDate(e.ms)} · {e.wl.toFixed(2)} µm</option>)}</select></label>
                    <label>B · compare
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
                  <p className="keyline" data-testid="each-key"><span className="sw orange" /> Brighter <span className="sw blue" /> Fainter</p>
                </>
              )}
            </div>
          )}

          {s.mode === "rainbow" && <p className="mode-key" data-testid="rainbow-help"><span className="ramp" /> Old → new · white is unchanged</p>}
          <div id="frame-browser" hidden={!showFrames} className="frame-browser">
            <Filmstrip epochs={epochs} thumbs={thumbs} marks={marks} onSelect={selectEpoch} visible={showFrames} />
            <Timeline epochs={epochs} marks={marks} onSelect={selectEpoch} />
          </div>
          {fullscreenError && <p className="alert" role="alert">{fullscreenError}</p>}
          <div className={`loading-line ${prog.done === prog.total && !prog.failed && listing === "done" ? "settled" : ""}`}>
            <p className="prog" data-testid="progress" role="status">{!n && framesState === "loading" ? "Looking up exposures…" : n ? `${prog.done} of ${prog.total} images loaded${prog.done < prog.total ? ` · ${prog.current}` : ""}${prog.failed ? ` · ${prog.failed} failed (${prog.lastErr})` : ""}${listing === "full" ? " · checking wavelengths" : ""}` : ""}</p>
            {prog.failed > 0 && <button type="button" className="btn small" data-testid="images-retry" onClick={() => setImageAttempt((value) => value + 1)}>Retry images</button>}
          </div>
        </div>
      </main>
      <Inspector panel={panel} onChange={setPanel} docked={desktopControls && !s.embed}>
        <div hidden={!(desktopControls && !s.embed) && panel !== "view"} data-testid="view-panel">
          <form onSubmit={(e) => { e.preventDefault(); go(input); }} className="coordform">
            <h2 className="h"><label htmlFor="coords">Position</label></h2>
            <div className="searchrow">
              <input id="coords" data-testid="coord-input" aria-describedby="coordinate-feedback" aria-invalid={inputMsg?.kind === "err" || undefined} value={input} onChange={(e) => setInput(e.target.value)} inputMode="text" autoComplete="off" spellCheck={false}
                placeholder="RA and Dec, or a target name" />
              <button className="go" type="submit" data-testid="coord-go" disabled={resolving}>Go</button>
            </div>
            <div className={`msg ${inputMsg?.kind ?? ""} ${inputMsg?.kind !== "err" && !resolving ? "sr-only" : ""}`} id="coordinate-feedback" data-testid="coord-msg" role="status">{inputMsg?.text ?? `${fmtRA(s.ra)} ${fmtDec(s.dec)}`}</div>
            <p className="hint sr-only">Name, decimal degrees, or RA/Dec.</p>
          </form>
          <section className="view-controls">
            <h3 className="h">Image</h3>
            <label className="field">Field of view <span className="val">{s.fov}′</span>
              <input type="range" min="1" max="30" step="0.5" value={s.fov} onChange={(e) => set({ fov: +e.target.value })} aria-label="Field of view" data-testid="fov" /></label>
            <label className="field">Wavelength
              <select value={det} onChange={(e) => set({ det: +e.target.value, frame: 0, a: null, b: null })} data-testid="detector">
                {(detInfo.length ? detInfo : [1, 2, 3, 4, 5, 6].map((d) => ({ detector: d, wl: 0, passes: [] as number[], nFrames: 0 }))).map((d) => <option key={d.detector} value={d.detector} title={`Detector ${d.detector}; ${d.passes.length} passes`}>{d.wl ? `${d.wl.toFixed(1)} µm` : `Detector ${d.detector}`}</option>)}
              </select></label>
            <label className="field">Images
              <select value={s.src} onChange={(e) => set({ src: e.target.value as "stack" | "frame", frame: 0, a: null, b: null })} data-testid="src">
                <option value="stack">Stacks</option><option value="frame">Exposures</option></select></label>
            <label className="check"><input type="checkbox" role="switch" checked={s.wise} onChange={(e) => set({ wise: e.target.checked, frame: 0, a: null, b: null })} data-testid="wise-toggle" /> WISE archive · 2010–2024{wise.length === 0 && framesState === "done" ? " (none)" : ""}</label>
            {expected && <label className="check"><input type="checkbox" role="switch" checked={s.mark} onChange={(event) => set({ mark: event.target.checked })} data-testid="mark-toggle" />Expected position</label>}
            <label className="check"><input type="checkbox" role="switch" checked={s.cross} onChange={(e) => set({ cross: e.target.checked })} /> Crosshair</label>
            <label className="check"><input type="checkbox" role="switch" checked={ov.gaia} onChange={(e) => setOv((o) => ({ ...o, gaia: e.target.checked }))} data-testid="ov-gaia" /> Gaia stars</label>
            <label className="check"><input type="checkbox" role="switch" checked={ov.motion} onChange={(e) => setOv((o) => ({ ...o, motion: e.target.checked }))} data-testid="ov-motion" /> Motion vectors</label>
            <label className="check"><input type="checkbox" role="switch" checked={ov.known} onChange={(e) => { const checked = e.target.checked; setOv((o) => ({ ...o, known: checked })); if (checked) set({ src: "frame", wise: false, frame: 0 }); }} data-testid="ov-known" /> Known asteroids</label>
            {wantsGaia && <div role="status" className="dim small" data-testid="gaia-status">{gaiaStatus.text}{gaiaStatus.error && <button type="button" className="btn small" onClick={() => retryGaia((n) => n + 1)}>Retry Gaia</button>}</div>}
            {ov.known && <div role="status" className="dim small" data-testid="known-status">
              {knownStatus.text}
              {knownStatus.error && <button type="button" className="btn small" onClick={() => retryKnown((n) => n + 1)}>Retry asteroids</button>}
              <p>Individual exposures only. Up to 12 dates, ±6 hours; geocentric estimates.</p>
              {s.src !== "frame" && <button type="button" className="btn small" onClick={() => set({ src: "frame", wise: false, frame: 0 })}>Use individual SPHEREx exposures</button>}
              {!!known.length && <details><summary>Known objects as text</summary><ul>{known.map((o, i) => <li key={`${o.name}-${o.time}-${i}`}>{o.name}, {o.time}, RA {o.ra.toFixed(5)}°, Dec {o.dec.toFixed(5)}°</li>)}</ul></details>}
            </div>}
            {(wantsGaia || ov.known) && <p className="dim small">Missing markers do not rule out a catalogue match.</p>}
            <label className="check"><input type="checkbox" role="switch" checked={s.sharp} onChange={(e) => set({ sharp: e.target.checked })} data-testid="sharp-toggle" /> Sharp pixels</label>
            <label className="check"><input type="checkbox" role="switch" checked={s.inv} onChange={(e) => set({ inv: e.target.checked })} data-testid="invert-toggle" /> Invert sky</label>
            {wiseNote && <p className="dim small">{wiseNote}</p>}
            {s.mode !== "diff" && (
              <details className="more" open={s.bp !== DEFAULTS.bp || s.wp !== DEFAULTS.wp || s.stretch !== "asinh"}>
                <summary>Brightness and contrast</summary>
                <div className="stretch" data-testid="stretch">
                  <div className="seg" role="group" aria-label="Stretch">
                    {(["asinh", "linear", "log"] as const).map((k) => <button key={k} aria-pressed={s.stretch === k} className={`segbtn ${s.stretch === k ? "on" : ""}`} onClick={() => set({ stretch: k })} data-testid={`stretch-${k}`}>{k}</button>)}
                  </div>
                  <label className="field">Black point <span className="val">{s.bp}%</span><input type="range" min="0" max="95" step="1" value={s.bp} onChange={(e) => set({ bp: Math.min(+e.target.value, s.wp - 1) })} data-testid="bp" /></label>
                  <label className="field">White point <span className="val">{s.wp}%</span><input type="range" min="90" max="100" step="0.1" value={s.wp} onChange={(e) => set({ wp: Math.max(+e.target.value, s.bp + 1) })} data-testid="wp" /></label>
                  <button className="btn small" onClick={() => set({ bp: DEFAULTS.bp, wp: DEFAULTS.wp, stretch: "asinh" })}>Reset</button>
                </div>
              </details>
            )}
          </section>

          <section>
            <h3 className="h">Exposure map</h3>
            <p className="dim small">Choose a band and pass. Drag to select a range.</p>
            <Pad
              frames={spx} detector={det} passFrom={passFrom} passTo={passTo} currentPass={cur?.survey === "spherex" ? cur.pass : null}
              onSelect={(sel) => {
                if (sel.click) {
                  const nextEpochs = buildEpochs(spx, wise, { src: s.src, detector: sel.detector, includeWise: s.wise, passFrom: allPasses[0] ?? 1, passTo: allPasses[allPasses.length - 1] ?? 1 });
                  set({ det: sel.detector, pf: null, pt: null, frame: Math.max(0, nextEpochs.findIndex((e) => e.survey === "spherex" && e.pass === sel.passFrom)), a: null, b: null });
                }
                else set({ det: sel.detector, pf: sel.passFrom, pt: sel.passTo, frame: 0, a: null, b: null });
              }}
            />
            {(s.pf != null || s.pt != null) && <button className="btn small" onClick={() => set({ pf: null, pt: null, frame: 0 })}>Use all passes</button>}
          </section>


          <section><h3 className="h">Playback</h3>
          {animated && n > 1 && (
            <div className="combine" data-testid="combine">
              <label className="field">Blend dates · <span className="val">{s.win ? `${Math.min(s.win, winMax)} ${Math.min(s.win, winMax) === 1 ? "year" : "years"}` : "off"}</span>
                <input type="range" min="0" max={winMax} step="0.5" value={Math.min(s.win, winMax)} onChange={(e) => set({ win: +e.target.value })} aria-label="Blend dates · this many years" data-testid="win" /></label>
              <label className="check"><input type="checkbox" role="switch" checked={s.ends} onChange={(e) => set({ ends: e.target.checked })} data-testid="ends" /> First + last only</label>
            </div>
          )}

            {cur && !many && listing === "done" && cur.flags.length > 0 && <details className="quality-flags"><summary className="badge warn" data-testid="flags">{cur.flags.length} quality flags</summary><ul>{cur.flags.map((flag) => <li key={flag}><b>{flag.replace(/_/g, " ")}</b>: {flagHelp(flag)}</li>)}</ul></details>}
          </section>
        </div>
        <div hidden={!(desktopControls && !s.embed) && panel !== "analyze"}>
          <div className="analysis-tabs" role="tablist" aria-label="Analysis tool">{analysisTabs.map((tab, index) => <button type="button" key={tab.id} role="tab" id={`analysis-tab-${tab.id}`} aria-selected={analysisTab === tab.id} aria-controls={`analysis-${tab.id}`} tabIndex={analysisTab === tab.id ? 0 : -1} onClick={() => setAnalysisTab(tab.id)} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? analysisTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : analysisTabs.length - 1)) % analysisTabs.length;
            setAnalysisTab(analysisTabs[next].id); document.getElementById(`analysis-tab-${analysisTabs[next].id}`)?.focus();
          }}>{tab.label}</button>)}</div>
          <div role="tabpanel" id="analysis-motion" aria-labelledby="analysis-tab-motion" hidden={analysisTab !== "motion"}>
          <section id="motion-tools" tabIndex={-1} className="motion-tools" aria-label="Find something that moves">
            <MotionLab norms={norms} epochs={epochs} fovArcmin={s.fov} catalogPm={target?.pm_mas_yr} picked={picked ? { x: picked.x, y: picked.y } : null} pickedMs={cur?.ms}
              onMarks={(marks, path) => setLab({ marks, path: path ?? [] })} />
          </section>
          </div>
          <div role="tabpanel" id="analysis-spectrum" aria-labelledby="analysis-tab-spectrum" hidden={analysisTab !== "spectrum"}>
          <section id="spectrum-tools" tabIndex={-1} data-testid="spectrum-panel">
            <h2 className="h">Spectrum</h2>
            {spec.state === "loading" && <div role="status" data-testid="spectrum-loading">
              <p className="dim"><i className="spin" /> Measuring the spectrum · {specSeconds}s of 30s. {specSeconds >= 10 ? "The archive is still fetching pixels for this spot." : "Checking the available exposures."}</p>
              <button type="button" className="btn small" data-testid="spectrum-cancel" onClick={() => { spectrumRequest.current?.abort(); setSpec({ state: "error", points: [], err: "Measurement cancelled." }); }}>Cancel</button>
            </div>}
            {spec.state === "error" && <div className="alert" role="status" data-testid="spectrum-error">
              <p>{spec.err}</p>
              {picked && <button type="button" className="btn small" data-testid="spectrum-retry" onClick={() => pick(picked)}>Try again</button>}
            </div>}
            {spec.state === "done" && picked && clickedPicked && <Spectrum picked={clickedPicked} title={`Where you clicked: RA ${picked.ra.toFixed(5)}, Dec ${picked.dec.toFixed(5)}`} />}
            {spec.state === "idle" && (centre.state === "error"
              ? <div className="alert" role="status"><p>The spectrum could not be measured. Try again, or click another star.</p><button type="button" className="btn small" onClick={() => pick({ x: (SIZE - 1) / 2, y: (SIZE - 1) / 2, ra: s.ra, dec: s.dec })}>Retry at the centre</button></div>
              : centrePicked && centrePicked.pts.length
              ? <Spectrum picked={centrePicked} title={expected ? `${target?.name ?? "The object"}, measured where it is now` : "At the centre of the picture"} />
              : <p className="dim" role="status">{framesState === "done" && !spx.length ? "No SPHEREx spectrum is available for this field." : centre.state === "done" ? "Nothing bright enough to measure at that spot." : <><i className="spin" /> Measuring the centre…</>}</p>)}
            {spec.state !== "loading" && <p className="dim small">Click the image to sample another point.</p>}
          </section>


          </div>
          <div role="tabpanel" id="analysis-brightness" aria-labelledby="analysis-tab-brightness" hidden={analysisTab !== "brightness"}>
          <section data-testid="lightcurve-panel">
            <h2 className="h">Brightness</h2>
            {expected
              ? <p className="dim">Moving target: fixed-position brightness is unreliable. Use Spectrum.</p>
              : centre.state === "done" && centrePicked
              ? <LightCurve curves={curves} kind={centrePicked.kind} />
              : centre.state === "error"
                ? <p className="dim">The brightness at the centre could not be measured.</p>
                : <p className="dim" role="status">{framesState === "done" && !spx.length ? "No SPHEREx data here." : <><i className="spin" /> Measuring brightness…</>}</p>}
          </section>


          </div>
          <div role="tabpanel" id="analysis-planet" aria-labelledby="analysis-tab-planet" hidden={analysisTab !== "planet"}><PlanetXPanel value={px} onChange={setPx} epochsCount={epochs.length} spanYears={spanYr} fovArcmin={s.fov} inViewCount={planet?.inView ?? 0} /></div>
          <div role="tabpanel" id="analysis-context" aria-labelledby="analysis-tab-context" hidden={analysisTab !== "context"}>{ready && <ContextPanel view={view} />}</div>
        </div>
        <div hidden={panel !== "about"} className="field-notes">
          <section data-testid="about-target"><h3>{target?.name ?? "Custom position"}</h3><p className="dim">{target?.note ?? `${fmtRA(s.ra)} ${fmtDec(s.dec)}`}</p>
            {expected && <><p className="measured" data-testid="measured">{measured ? `Measured ${measured.rate.toFixed(1)}″/year ${measured.dir} · ${measured.n} dates. Catalogue ${expected.rate.toFixed(1)}″/year.` : `Catalogue ${expected.rate.toFixed(1)}″/year ${expected.dir}.`}</p></>}
          </section>
          <Walkthrough onApply={(value) => { applyWalk(value); setPanel(null); }} />
          <p className="dim small">North ↑ · East ←. Space plays/pauses. Arrow keys step through dates. Focus the image to select a point with the keyboard; Enter measures it. Shift + arrows pan.</p>
          <p className="dim small">SPHEREx: NASA/IPAC IRSA. WISE/NEOWISE: unWISE via WiseView.</p>
        </div>
      </Inspector>
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

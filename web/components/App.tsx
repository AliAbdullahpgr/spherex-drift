"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import { fmtDec, fmtRA, resolveInput } from "@/lib/coords";
import { buildEpochs, defaultDetector, detectorInfo, fmtDate, flagHelp, type Epoch } from "@/lib/epochs";
import { difference, levels, normalise, rainbow, toGray, type Norm } from "@/lib/render";
import { DEFAULTS, readState, writeState, type AppState, type Mode } from "@/lib/urlstate";
import type { Frame, SpectrumPoint, Target } from "@/lib/types";
import Viewer, { Readout } from "./Viewer";
import Timeline, { type Mark } from "./Timeline";
import Pad from "./Pad";
import Spectrum from "./Spectrum";
import Walkthrough from "./Walkthrough";
import Filmstrip from "./Filmstrip";

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
  const [playing, setPlaying] = useState(false);
  const [input, setInput] = useState("");
  const [inputMsg, setInputMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [picked, setPicked] = useState<{ x: number; y: number; ra: number; dec: number } | null>(null);
  const [spec, setSpec] = useState<{ state: "idle" | "loading" | "done" | "error"; points: SpectrumPoint[]; err?: string }>({ state: "idle", points: [] });

  const set = useCallback((p: Partial<AppState>) => setS((o) => ({ ...o, ...p })), []);

  // ---- init from URL
  useEffect(() => {
    const st = readState(window.location.search);
    setS(st);
    setInput(`${st.ra.toFixed(5)} ${st.dec.toFixed(5)}`);
    api.detectBackend(st.mock).then((b) => {
      setBackend(b);
      api.getTargets().then(setTargets);
      setReady(true);
    });
  }, []);

  // ---- state -> URL
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => window.history.replaceState(null, "", "?" + writeState({ ...s, play: playing })), 150);
    return () => clearTimeout(t);
  }, [s, ready, playing]);

  // ---- fetch frame lists whenever the patch changes
  const viewKey = `${s.ra.toFixed(5)}|${s.dec.toFixed(5)}|${s.fov}`;
  const view = useMemo(() => ({ ra: s.ra, dec: s.dec, fov: s.fov }), [s.ra, s.dec, s.fov]);
  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    setFramesState("loading"); setFramesErr(""); setWiseNote(""); setPicked(null); setSpec({ state: "idle", points: [] });
    (async () => {
      try {
        const [a, w] = await Promise.allSettled([api.getFrames(view, ctl.signal), api.getWiseFrames(view, ctl.signal)]);
        if (ctl.signal.aborted) return;
        if (a.status === "rejected") throw a.reason;
        setSpx(a.value.frames);
        if (w.status === "fulfilled") { setWise(w.value.frames); if (!w.value.frames.length) setWiseNote("No WISE coverage returned for this patch."); }
        else { setWise([]); setWiseNote("WISE epochs could not be loaded: " + (w.reason?.message ?? "unknown error")); }
        setFramesState("done");
      } catch (e: any) {
        if (ctl.signal.aborted) return;
        setFramesErr(e?.message ?? String(e)); setFramesState("error");
      }
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewKey]);

  const detInfo = useMemo(() => detectorInfo(spx), [spx]);
  const det = s.det ?? defaultDetector(spx);
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

  const norms = useMemo(() => epochs.map((e) => cache.current.get(imgKey(e)) ?? null), [epochs, ver, viewKey]); // eslint-disable-line
  const loadedIdx = norms.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);

  // ---- play loop (skips epochs that are not loaded yet)
  useEffect(() => {
    if (!playing || s.mode !== "blink" || loadedIdx.length < 2) return;
    const t = setInterval(() => {
      setS((o) => {
        const cur = Math.min(o.frame, epochs.length - 1);
        const nxt = loadedIdx.find((i) => i > cur) ?? loadedIdx[0];
        return { ...o, frame: nxt };
      });
    }, 1000 / s.speed);
    return () => clearInterval(t);
  }, [playing, s.mode, s.speed, loadedIdx.join(","), epochs.length]); // eslint-disable-line

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
      const nm = norms[frameIdx];
      return nm ? toGray(nm, levels(nm, s.bp, s.wp), s.stretch) : null;
    }
    if (s.mode === "rainbow") {
      const list = norms.map((nm) => (nm ? { n: nm, lv: levels(nm, s.bp, s.wp, 2.5) } : null)).filter(Boolean) as { n: Norm; lv: ReturnType<typeof levels> }[];
      return rainbow(list, s.stretch);
    }
    const A = norms[aIdx], B = norms[bIdx];
    return A && B && aIdx !== bIdx ? difference(A, B, 1) : null;
  }, [norms, s.mode, s.bp, s.wp, s.stretch, frameIdx, aIdx, bIdx, epochs.length]);

  const busy = useMemo(() => {
    if (framesState === "loading") return "Finding which exposures cover this patch of sky…";
    if (framesState === "error") return null;
    if (!epochs.length) return null;
    if (s.mode === "blink" && !norms[frameIdx]) return `Fetching ${describe(epochs[frameIdx])} from the archive. This can take several seconds per image.`;
    if (s.mode === "rainbow" && prog.done < prog.total) return image ? `Rainbow so far uses ${prog.done} of ${prog.total} epochs. Still fetching ${prog.current}…` : `Fetching ${prog.current}…`;
    if (s.mode === "diff" && !image) return aIdx === bIdx ? null : `Fetching the two epochs to subtract (${describe(epochs[aIdx])}, ${describe(epochs[bIdx])})…`;
    return null;
  }, [framesState, epochs, norms, frameIdx, s.mode, image, prog, aIdx, bIdx]);

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
  const inView = (q: { x: number; y: number }) => q.x > 0.01 && q.x < 0.99 && q.y > 0.01 && q.y < 0.99;

  // ---- keyboard: space plays, arrows step
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) return;
      if (s.mode !== "blink" || epochs.length < 2) return;
      if (e.key === " ") { e.preventDefault(); setPlaying((v) => !v); }
      else if (e.key === "ArrowRight") setS((o) => ({ ...o, frame: (Math.min(o.frame, epochs.length - 1) + 1) % epochs.length }));
      else if (e.key === "ArrowLeft") setS((o) => ({ ...o, frame: (Math.min(o.frame, epochs.length - 1) - 1 + epochs.length) % epochs.length }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.mode, epochs.length]);

  // ---- actions
  const go = (text: string) => {
    const r = resolveInput(text, targets);
    if (!r.ok) { setInputMsg({ kind: "err", text: r.error }); return; }
    setInputMsg({ kind: "ok", text: r.label ? `${r.label}: ${r.ra.toFixed(5)}, ${r.dec.toFixed(5)}` : `${fmtRA(r.ra)}  ${fmtDec(r.dec)}` });
    setInput(`${r.ra.toFixed(5)} ${r.dec.toFixed(5)}`);
    cache.current.clear();
    set({ ra: r.ra, dec: r.dec, frame: 0, a: null, b: null, pf: null, pt: null });
  };
  const applyWalk = (p: Partial<AppState>) => { cache.current.clear(); set({ ...p, frame: 0, a: null, b: null, pf: null, pt: null, det: null }); setInput(`${(p.ra ?? s.ra).toFixed(5)} ${(p.dec ?? s.dec).toFixed(5)}`); setInputMsg(null); };
  const pick = async (p: { x: number; y: number; ra: number; dec: number }) => {
    setPicked(p);
    setSpec({ state: "loading", points: [] });
    try {
      const r = await api.getSpectrum(p.ra, p.dec, view, 6);
      setSpec({ state: "done", points: r.points });
    } catch (e: any) { setSpec({ state: "error", points: [], err: e?.message ?? String(e) }); }
  };

  const cur = epochs[frameIdx];
  const marks: Mark[] = epochs.map((_, i) => (s.mode === "blink" ? (i === frameIdx ? "active" : "none") : s.mode === "rainbow" ? "in" : i === aIdx ? "a" : i === bIdx ? "b" : "none"));
  const hoverVal = hover && s.mode === "blink" && norms[frameIdx] ? `${norms[frameIdx]!.data[hover.y * norms[frameIdx]!.w + hover.x].toFixed(1)} σ` : undefined;
  const caption = s.mode === "blink" && cur ? `${cur.label} ${fmtDate(cur.ms)}` : s.mode === "rainbow" ? `Rainbow trail of ${loadedIdx.length} epochs` : `Difference ${epochs[bIdx]?.label ?? ""} minus ${epochs[aIdx]?.label ?? ""}`;
  const noCoverage = framesState === "done" && !spx.length;
  const thumbCache = useRef(new WeakMap<Norm, { key: string; img: ImageData }>());
  const thumbs = useMemo(() => norms.map((nm) => {
    if (!nm) return null;
    const key = `${s.bp}|${s.wp}|${s.stretch}`;
    const hit = thumbCache.current.get(nm);
    if (hit && hit.key === key) return hit.img;
    const img = toGray(nm, levels(nm, s.bp, s.wp), s.stretch);
    thumbCache.current.set(nm, { key, img });
    return img;
  }), [norms, s.bp, s.wp, s.stretch]);
  const selectEpoch = (i: number) => {
    if (s.mode === "blink") set({ frame: i });
    else if (s.mode === "rainbow") set({ mode: "blink", frame: i });
    else if (i !== aIdx && i !== bIdx) set(Math.abs(i - aIdx) <= Math.abs(i - bIdx) ? { a: i, b: bIdx } : { a: aIdx, b: i });
  };
  const hud = s.mode === "blink" && cur
    ? { big: fmtDate(cur.ms), small: `${cur.survey === "wise" ? "WISE" : `SPHEREx pass ${cur.pass}`} · ${cur.wl.toFixed(2)} µm${cur.kind === "stack" ? ` · ${cur.n} exposures combined` : ""}`, tag: "Blink" }
    : s.mode === "rainbow" && n
      ? { big: `${fmtDate(epochs[0].ms).slice(0, 4)} to ${fmtDate(epochs[n - 1].ms).slice(0, 4)}`, small: `${loadedIdx.length} dates in one picture`, tag: "Rainbow trail" }
      : s.mode === "diff" && epochs[aIdx] && epochs[bIdx]
        ? { big: `${fmtDate(epochs[bIdx].ms)} minus ${fmtDate(epochs[aIdx].ms)}`, small: "newer minus older", tag: "Difference" }
        : undefined;
  const showMarks = s.mark && expected && epochs.length > 0;
  const pmMarks = !showMarks ? [] : (s.mode === "blink" && cur ? [{ ...expected!.at(cur.ms), tone: "now" as const }]
    : s.mode === "diff" && epochs[aIdx] && epochs[bIdx] ? [{ ...expected!.at(epochs[aIdx].ms), label: "A", tone: "a" as const }, { ...expected!.at(epochs[bIdx].ms), label: "B", tone: "b" as const }]
    : []).filter(inView);
  const pmPath = showMarks && s.mode === "rainbow" && epochs.length > 1 ? [expected!.at(epochs[0].ms), expected!.at(epochs[n - 1].ms)] : [];
  const modeHelp: Record<Mode, string> = {
    blink: "Flip between pictures of the same patch of sky taken months or years apart. Stars hold still. Anything that jumps is moving.",
    rainbow: "Every date in one picture: the oldest is tinted blue, the newest orange. Stars add up to white. A mover leaves a coloured streak.",
    diff: "The newer picture minus the older one. Stars cancel out. A mover leaves a blue spot where it was and an orange spot where it is now.",
  };
  const modeName: Record<Mode, string> = { blink: "Blink", rainbow: "Rainbow trail", diff: "Difference" };

  const modeSub: Record<Mode, string> = { blink: "flip between dates", rainbow: "all dates in one picture", diff: "newer minus older" };

  return (
    <div className={`app ${s.embed ? "embed" : ""}`}>
      {!s.embed && (
        <header className="top">
          <a className="wordmark" href="./" aria-label="SPHEREx Drift, start over">SPHEREx <i>Drift</i></a>
          <span className="topnote">Real NASA SPHEREx images · WISE back to 2010</span>
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
          <form onSubmit={(e) => { e.preventDefault(); go(input); }} className="coordform">
            <label htmlFor="coords" className="lab">Go to any position</label>
            <div className="searchrow">
              <input id="coords" data-testid="coord-input" value={input} onChange={(e) => setInput(e.target.value)} inputMode="text" autoComplete="off" spellCheck={false}
                placeholder="RA Dec or a target name" />
              <button className="go" type="submit" data-testid="coord-go" aria-label="Go">→</button>
            </div>
            <div className={`msg ${inputMsg?.kind ?? ""}`} data-testid="coord-msg" role="status">{inputMsg?.text ?? `Now showing ${fmtRA(s.ra)} ${fmtDec(s.dec)}`}</div>
            <p className="hint">Decimal degrees or 08h55m10.8s -07d14m42s both work.</p>
          </form>

          <div className="lab">Test targets</div>
          <ol className="cat" data-testid="targets">
            {targets.map((t, i) => (
              <li key={t.id}>
                <button className={`catrow ${target?.id === t.id ? "on" : ""}`} onClick={() => { setInput(t.name); go(t.name); }} data-testid={`target-${t.id}`} title={t.note}>
                  <span className="num">{String(i + 1).padStart(2, "0")}</span>
                  <span className="nm">{t.name}</span>
                  <span className={`tag ${t.kind ?? ""}`}>{t.kind === "variable" ? "changes" : t.kind === "mover" ? "moves" : ""}</span>
                </button>
              </li>
            ))}
          </ol>

          {target && (
            <section className="about" data-testid="about-target">
              <div className="lab">{target.kind === "variable" ? "Variable star" : target.kind === "mover" ? "Known mover" : "Target"}</div>
              <h2 className="display">{target.name}</h2>
              {target.note && <p className="dim">{target.note.charAt(0).toUpperCase() + target.note.slice(1)}.</p>}
              {expected && (
                <>
                  <div className="stat"><b>{expected.rate.toFixed(1)}″</b><span>per year, heading {expected.dir}</span></div>
                  <p>The yellow ring shows where its catalogued motion puts it on each date.</p>
                  <label className="check"><input type="checkbox" checked={s.mark} onChange={(e) => set({ mark: e.target.checked })} data-testid="mark-toggle" /> Show expected position</label>
                </>
              )}
              {target.kind === "variable" && <p>It does not move. Watch its brightness change between dates in Blink, or click it to compare its spectrum pass by pass.</p>}
            </section>
          )}
          <Walkthrough onApply={applyWalk} />
        </nav>

        {/* ---------------- centre: the picture ---------------- */}
        <main className="stage">
          <div className="tabs" role="tablist">
            {(["blink", "rainbow", "diff"] as Mode[]).map((m, i) => (
              <button key={m} role="tab" aria-selected={s.mode === m} className={`tab ${s.mode === m ? "on" : ""}`} onClick={() => { set({ mode: m }); if (m !== "blink") setPlaying(false); }} data-testid={`mode-${m}`}>
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                <span className="tl">{modeName[m]}</span>
                <span className="sub">{modeSub[m]}</span>
              </button>
            ))}
          </div>

          {framesState === "error" && <div className="alert" data-testid="frames-error">Could not load the exposure list: {framesErr}</div>}
          {noCoverage && <div className="alert" data-testid="no-coverage">No SPHEREx exposures cover this position yet. Try one of the test targets, or a different position.</div>}

          <Viewer
            image={image} size={SIZE} fov={s.fov} ra={s.ra} dec={s.dec} crosshair={s.cross} busy={busy} picked={picked}
            onHover={setHover} onPick={pick} caption={caption} marks={pmMarks} path={pmPath} hud={hud}
          />
          <div className="under">
            <Readout hover={hover} value={hoverVal} />
            <span className="caption" data-testid="caption">{caption}{s.mode === "blink" && cur ? ` · ${cur.wl.toFixed(2)} µm` : ""}</span>
          </div>

          <p className="explain">{modeHelp[s.mode]}</p>

          {s.mode === "blink" && (
            <div className="transport" data-testid="transport">
              <button className="btn sq" onClick={() => set({ frame: (frameIdx - 1 + n) % n })} aria-label="Previous epoch" disabled={n < 2}>←</button>
              <button className="btn solid play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"} data-testid="play" disabled={loadedIdx.length < 2}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
              <button className="btn sq" onClick={() => set({ frame: (frameIdx + 1) % n })} aria-label="Next epoch" disabled={n < 2}>→</button>
              <span className="count">{n ? `${String(frameIdx + 1).padStart(2, "0")} / ${String(n).padStart(2, "0")}` : ""}</span>
              <label className="inline">Speed
                <input type="range" min="0.25" max="6" step="0.25" value={s.speed} onChange={(e) => set({ speed: +e.target.value })} aria-label="Playback speed" />
                <span className="mono">{s.speed}/s</span>
              </label>
              {cur && (cur.flags.length > 0
                ? <span className="badge warn" data-testid="flags" title={cur.flags.map((f) => `${f.replace(/_/g, " ")}: ${flagHelp(f)}`).join("\n")}>{cur.flags.length} quality {cur.flags.length === 1 ? "flag" : "flags"}</span>
                : <span className="badge ok" title="No quality flags near the centre">clean</span>)}
            </div>
          )}
          {s.mode === "diff" && (
            <div className="diffctl" data-testid="diffctl">
              <div className="diffpick">
                <label>A · older picture (subtracted)
                  <select value={aIdx} onChange={(e) => set({ a: +e.target.value })} data-testid="diff-a">{epochs.map((e, i) => <option key={e.key} value={i}>{e.label} · {fmtDate(e.ms)} · {e.wl.toFixed(2)} µm</option>)}</select></label>
                <label>B · newer picture
                  <select value={bIdx} onChange={(e) => set({ b: +e.target.value })} data-testid="diff-b">{epochs.map((e, i) => <option key={e.key} value={i}>{e.label} · {fmtDate(e.ms)} · {e.wl.toFixed(2)} µm</option>)}</select></label>
              </div>
              {epochs.length < 2 && <div className="alert">Need at least two epochs to subtract.</div>}
              {aIdx === bIdx && epochs.length >= 2 && <div className="alert">Pick two different epochs: subtracting an epoch from itself is blank.</div>}
              {dMismatch && <div className="alert warn" data-testid="diff-warning">⚠ {dMismatch}</div>}
              <p className="keyline"><span className="sw blue" /> it was here <span className="sw orange" /> it is here now</p>
            </div>
          )}
          {s.mode === "rainbow" && (
            <p className="keyline" data-testid="rainbow-help"><span className="ramp" /> oldest to newest · white means it did not move or change</p>
          )}

          <Filmstrip epochs={epochs} thumbs={thumbs} marks={marks} onSelect={selectEpoch} />
          <Timeline epochs={epochs} marks={marks} onSelect={selectEpoch} />
          <p className="prog" data-testid="progress" role="status">
            {framesState === "loading" ? "Looking up exposures…" : n ? `${prog.done} of ${prog.total} images loaded${prog.done < prog.total ? ` · now fetching ${prog.current}` : ""}${prog.failed ? ` · ${prog.failed} failed (${prog.lastErr})` : ""}` : ""}
          </p>
        </main>

        {/* ---------------- right: instrument settings ---------------- */}
        <aside className="rail right">
          <section>
            <div className="lab">View</div>
            <label className="field">Field of view <span className="val">{s.fov}′</span>
              <input type="range" min="1" max="30" step="0.5" value={s.fov} onChange={(e) => { cache.current.clear(); set({ fov: +e.target.value }); }} aria-label="Field of view" data-testid="fov" /></label>
            <label className="field">Wavelength (detector)
              <select value={det} onChange={(e) => set({ det: +e.target.value, frame: 0, a: null, b: null })} data-testid="detector">
                {(detInfo.length ? detInfo : [1, 2, 3, 4, 5, 6].map((d) => ({ detector: d, wl: 0, passes: [] as number[], nFrames: 0 }))).map((d) => <option key={d.detector} value={d.detector}>{d.wl ? `${d.wl.toFixed(1)} µm · ` : ""}detector {d.detector}{d.passes.length ? ` · ${d.passes.length} passes` : ""}</option>)}
              </select></label>
            <label className="field">Images
              <select value={s.src} onChange={(e) => set({ src: e.target.value as "stack" | "frame", frame: 0, a: null, b: null })} data-testid="src">
                <option value="stack">One per pass (combined)</option><option value="frame">Every single exposure</option></select></label>
            <label className="check"><input type="checkbox" checked={s.wise} onChange={(e) => set({ wise: e.target.checked, frame: 0, a: null, b: null })} data-testid="wise-toggle" /> Add WISE images, 2010 to 2024{wise.length === 0 && framesState === "done" ? " (none)" : ""}</label>
            <label className="check"><input type="checkbox" checked={s.cross} onChange={(e) => set({ cross: e.target.checked })} /> Crosshair</label>
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
            <div className="lab">Data that exists here</div>
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

          <section data-testid="spectrum-panel">
            <div className="lab">Spectrum</div>
            {spec.state === "idle" && <p className="dim">Click any star in the picture to plot its brightness at every wavelength SPHEREx measured, coloured by pass.</p>}
            {spec.state === "loading" && <p className="dim" role="status"><i className="spin" /> Measuring the spectrum there. Near the centre this takes a few seconds; far from it, up to a minute.</p>}
            {spec.state === "error" && <p className="alert">Spectrum failed: {spec.err}</p>}
            {spec.state === "done" && picked && <Spectrum points={spec.points} title={`RA ${picked.ra.toFixed(5)}, Dec ${picked.dec.toFixed(5)} · 6″ aperture`} />}
          </section>
        </aside>
      </div>

      {!s.embed && (
        <footer className="foot">
          <span>Data: NASA/IPAC IRSA (SPHEREx) · unWISE / WiseView (WISE, NEOWISE). North is up, east is left.</span>
          <span>The address bar holds the current view: copy it to share, add <span className="mono">&embed=1</span> to embed. Space plays, arrow keys step.</span>
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

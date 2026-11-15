"use client";
// Tools for finding something that moves: stack the dates along a trial motion, or let the
// computer look for movers by itself and say how well it does.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Epoch } from "@/lib/epochs";
import { toGray, type Norm } from "@/lib/render";
import { msToYear } from "@/lib/motion";
import { peakNear, searchMotion, selected, shiftAndAdd, staticResiduals, type SearchResult, type Stack } from "@/lib/shiftadd";
import { findMovers, scoreFinder, type Candidate, type FinderScore } from "@/lib/detect";
import css from "./MotionLab.module.css";

export type MotionLabMark = { x: number; y: number; label?: string };
export type MotionLabProps = {
  norms: (Norm | null)[];
  epochs: Epoch[];
  fovArcmin: number;
  /** Catalogue motion of the current target, milliarcseconds per year east and north. */
  catalogPm?: [number, number];
  /** Pixel the user clicked in the main picture. */
  picked?: { x: number; y: number } | null;
  /** Date (ms) of the picture that was clicked, if known. Without it every loaded date is tried. */
  pickedMs?: number;
  /** Draw these on the main picture: positions as fractions (0..1) of the image, and the path joining them. */
  onMarks?: (marks: MotionLabMark[], path?: { x: number; y: number }[]) => void;
};

const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const compass = (east: number, north: number) => DIRS[((Math.round((Math.atan2(east, north) * 180) / Math.PI / 45) % 8) + 8) % 8];
const rateText = (r: number) => `${r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)}″`;
const tidy = (arcsec: number) => String(Math.round(arcsec * 100) / 100);
const later = (fn: () => void) => setTimeout(fn, 30); // let "Working" paint before the sums start
const SURVEY: Record<string, string> = { spherex: "SPHEREx", wise: "WISE" };
const FINDER_MAX_RATE = 40; // includes the fast mover in the labelled demo sky

type StackResult = { stack: Stack; peak: { x: number; y: number; value: number }; still: number; east: number; north: number; search?: SearchResult };

export default function MotionLab({ norms, epochs, fovArcmin, catalogPm, picked, pickedMs, onMarks }: MotionLabProps) {
  const groups = useMemo(() => epochs.map((e) => e.survey as string), [epochs]);
  const ms = useMemo(() => epochs.map((e) => e.ms), [epochs]);
  const loadedBy = useMemo(() => {
    const c: Record<string, number> = {};
    norms.forEach((n, i) => { if (n && groups[i]) c[groups[i]] = (c[groups[i]] ?? 0) + 1; });
    return c;
  }, [norms, groups]);
  const surveys = Object.keys(loadedBy);
  const [which, setWhich] = useState<string>("auto");
  const include = useMemo(() => {
    if (which === "all" || surveys.length < 2) return surveys;
    if (which !== "auto" && surveys.includes(which)) return [which];
    return [[...surveys].sort((a, b) => loadedBy[b] - loadedBy[a])[0]];
  }, [which, surveys.join(","), loadedBy]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = useMemo(() => ({ groups, include }), [groups, include]);
  const idx = useMemo(() => selected(norms, sel), [norms, sel]);
  const spanYr = idx.length > 1 ? msToYear(Math.max(...idx.map((i) => ms[i]))) - msToYear(Math.min(...idx.map((i) => ms[i]))) : 0;
  const enough = idx.length >= 3 && spanYr > 0;

  const [east, setEast] = useState("0");
  const [north, setNorth] = useState("0");
  const [clean, setClean] = useState(true);
  const [maxRate, setMaxRate] = useState(10);
  const [busy, setBusy] = useState<"" | "stack" | "search" | "find" | "test">("");
  const [progress, setProgress] = useState("");
  const [res, setRes] = useState<StackResult | null>(null);
  const [note, setNote] = useState("");
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [shown, setShown] = useState(-1);
  const [score, setScore] = useState<FinderScore | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const cancel = useRef({ cancelled: false });

  // the pictures changed: earlier answers no longer describe them
  const dataKey = `${idx.join(",")}|${fovArcmin}|${epochs.map((e) => e.key).join(",")}`;
  useEffect(() => {
    cancel.current.cancelled = true; cancel.current = { cancelled: false };
    setRes(null); setCands(null); setScore(null); setShown(-1); setNote(""); setBusy(""); setProgress("");
    onMarks?.([], []);
  }, [dataKey, norms]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancel.current.cancelled = true; }, []);

  useEffect(() => {
    const c = cv.current;
    if (!c || !res) return;
    c.width = res.stack.w; c.height = res.stack.h;
    c.getContext("2d")!.putImageData(toGray(res.stack, { lo: 0.5, hi: Math.max(25, res.peak.value) }, "asinh"), 0, 0);
  }, [res]);

  const base = (): (Norm | null)[] => (clean ? staticResiduals(norms, sel) : norms);
  const finish = (use: (Norm | null)[], e: number, n: number, search?: SearchResult) => {
    const stack = shiftAndAdd(use, ms, fovArcmin, e, n, search?.refMs, sel);
    if (!stack) { setRes(null); setNote("No pictures are loaded yet."); return; }
    const peak = (search ? peakNear(stack, search, 2) : peakNear(stack)) ?? { x: 0, y: 0, value: 0 };
    const still = peakNear(shiftAndAdd(use, ms, fovArcmin, 0, 0, stack.refMs, sel)!, peak, 1)?.value ?? NaN;
    setRes({ stack, peak, still, east: e, north: n, search });
    setNote("");
  };
  const runStack = (e = parseFloat(east) * 1000, n = parseFloat(north) * 1000) => {
    if (!Number.isFinite(e) || !Number.isFinite(n)) { setNote("Type the motion as numbers, for example 2.5 and -1."); return; }
    setBusy("stack");
    const token = cancel.current;
    later(() => { if (token.cancelled) return; try { finish(base(), e, n); } catch { setNote("The dates could not be stacked. Try another set of dates."); } finally { setBusy(""); } });
  };
  const useCatalogue = () => {
    if (!catalogPm) return;
    setEast(tidy(catalogPm[0] / 1000)); setNorth(tidy(catalogPm[1] / 1000));
    runStack(catalogPm[0], catalogPm[1]);
  };
  const runSearch = () => {
    if (!picked) return;
    setBusy("search"); setProgress("");
    const token = cancel.current;
    later(async () => {
      try {
        const use = base();
        // which date was clicked? if we were not told, try each loaded date (at most 8, evenly spread)
        let refs = idx.map((i) => ms[i]);
        if (pickedMs != null) refs = [pickedMs];
        else if (refs.length > 8) refs = Array.from({ length: 8 }, (_, k) => refs[Math.round((k * (refs.length - 1)) / 7)]);
        let best: SearchResult | null = null;
        for (let k = 0; k < refs.length; k++) {
          if (token.cancelled) return;
          const r = searchMotion(use, ms, fovArcmin, picked, { ...sel, refMs: refs[k], maxRateArcsecYr: maxRate, maxTrials: refs.length > 1 ? 12000 : 40000 });
          if (r && (!best || r.snr > best.snr)) best = r;
          if (refs.length > 1) { setProgress(`${k + 1} of ${refs.length}`); await new Promise((ok) => setTimeout(ok, 0)); }
        }
        if (token.cancelled) return;
        if (!best) { setRes(null); setNote("Could not search there: too few dates cover that spot."); return; }
        setEast(tidy(best.pmEastMasYr / 1000)); setNorth(tidy(best.pmNorthMasYr / 1000));
        finish(use, best.pmEastMasYr, best.pmNorthMasYr, best);
      } finally { if (!token.cancelled) { setBusy(""); setProgress(""); } }
    });
  };
  const runFind = () => {
    setBusy("find");
    const token = cancel.current;
    later(() => { if (token.cancelled) return; try { setCands(findMovers(norms, ms, fovArcmin, { ...sel, maxRateArcsecYr: FINDER_MAX_RATE })); setShown(-1); } catch { setNote("The mover search could not finish. Try another set of dates."); } finally { setBusy(""); } });
  };
  const runTest = () => {
    setBusy("test"); setProgress("");
    const token = cancel.current;
    later(async () => {
      try {
        const s = await scoreFinder(norms, ms, fovArcmin, 30, { ...sel, maxRateArcsecYr: FINDER_MAX_RATE, signal: token, onProgress: (d, t) => setProgress(`${d} of ${t}`) });
        if (!token.cancelled) setScore(s);
      } finally { if (!token.cancelled) { setBusy(""); setProgress(""); } }
    });
  };
  const show = (c: Candidate, k: number) => {
    if (shown === k) { setShown(-1); onMarks?.([], []); return; }
    const w = norms[c.track[0].i]?.w ?? 1;
    const pts = c.track.map((d) => ({ x: (d.x + 0.5) / w, y: (d.y + 0.5) / w }));
    const year = (i: number) => new Date(ms[i]).toISOString().slice(0, 7);
    const last = c.track.length - 1;
    onMarks?.(pts.map((p, j) => (j === 0 || j === last ? { ...p, label: year(c.track[j].i) } : p)), pts);
    setShown(k);
  };

  const w = res?.stack.w ?? 1;
  const refDate = res ? new Date(res.stack.refMs).toISOString().slice(0, 10) : "";
  const usedText = include.map((g) => SURVEY[g] ?? g).join(" and ");

  return (
    <section data-testid="motionlab">
      <h2 className="h">Find motion</h2>
      <p className="dim small">Combine dates to reveal motion.</p>
      {!!busy && <button type="button" className="btn small" data-testid="motion-cancel" onClick={() => { cancel.current.cancelled = true; cancel.current = { cancelled: false }; setBusy(""); setProgress(""); setNote("Computation cancelled."); }}>Cancel</button>}
      {surveys.length > 1 && (
        <label className="field">Dates
          <select value={which === "auto" ? include[0] : which} onChange={(e) => setWhich(e.target.value)} data-testid="ml-dates">
            {surveys.map((g) => <option key={g} value={g}>{SURVEY[g] ?? g} only ({loadedBy[g]} dates)</option>)}
            <option value="all">Both together</option>
          </select></label>
      )}
      {!enough && <p className="dim small" role="status">This needs at least three loaded dates{usedText ? ` from ${usedText}` : ""}. {idx.length} loaded so far.</p>}

      <div className={css.part}>
        <h3 className={css.sub}>Automatic detection</h3>
        <p className="dim small">Straight-line tracks across ≥3 dates. Up to {FINDER_MAX_RATE} ″/year.</p>
        <div className={css.row}>
          <button type="button" className="btn small" disabled={!enough || !!busy} onClick={runFind} data-testid="fm-run">Find movers</button>
          <button type="button" className="btn small" disabled={!enough || !!busy} onClick={runTest} data-testid="fm-test">Evaluate</button>
        </div>
        {busy === "find" && <p className="dim small" role="status"><i className="spin" /> Looking.</p>}
        {busy === "test" && <p className="dim small" role="status"><i className="spin" /> Hiding simulated movers and looking for each one{progress ? `, ${progress}` : ""}.</p>}
        {cands && (cands.length === 0
          ? <p className="small" style={{ marginTop: 12 }} data-testid="fm-list" role="status">Nothing in these {idx.length} {usedText} dates moves in a straight line clearly enough to report.</p>
          : (
            <ul className={css.list} data-testid="fm-list">
              {cands.map((c, k) => (
                <li key={k} className={shown === k ? css.on : undefined}>
                  <span>Moves <span className={css.num2}>{rateText(c.rateArcsecYr)}</span> per year heading {compass(c.pmEast, c.pmNorth)}, seen on {c.track.length} of {c.possible} dates</span>
                  <button type="button" className="btn small" onClick={() => show(c, k)} aria-pressed={shown === k}>{shown === k ? "Hide" : "Show"}</button>
                </li>
              ))}
            </ul>
          ))}
        {cands && cands.length > 0 && <p className="dim small">Candidates need visual confirmation.</p>}
        {score && (
          <div data-testid="fm-score" style={{ marginTop: 12 }}>
            <p className="small">
              Found {score.levels.map((l, i) => `${i === score.levels.length - 1 && i > 0 ? "and " : ""}${l.found} of ${l.total} ${l.name}`).join(", ")} simulated movers; {score.falseAlarms === 0 ? "no false alarms" : `${score.falseAlarms} ${score.falseAlarms === 1 ? "candidate" : "candidates"}`} in the untouched pictures.
            </p>
            <p className="dim small">
              Each simulated mover was hidden in these same pictures at a random place, moving between {rateText(score.rateRange[0])} and {rateText(score.rateRange[1])} per year. Bright means 30 times the noise at its peak, medium 12, faint 6. It counts as found only if the finder reports the right speed and direction to within 15 percent.
              {score.falseAlarms > 0 && " Candidates in the untouched pictures are false alarms unless something there really does move."}
              {score.spurious > 0 && ` The finder also reported ${score.spurious} wrong ${score.spurious === 1 ? "candidate" : "candidates"} during the test.`}
            </p>
          </div>
        )}
      </div>
      <div className={css.part}>
        <h3 className={css.sub}>Shift + stack</h3>
        <p className="dim small">Align dates along a trial motion.</p>
        <div className={css.pair}>
          <label className="field">East · ″/year
            <input className={css.num} type="number" step="0.1" value={east} onChange={(e) => setEast(e.target.value)} data-testid="sa-east" /></label>
          <label className="field">North · ″/year
            <input className={css.num} type="number" step="0.1" value={north} onChange={(e) => setNorth(e.target.value)} data-testid="sa-north" /></label>
        </div>
        <p className="dim small">Negative = west / south.</p>
        <label className="check"><input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} data-testid="sa-clean" /> Remove static background</label>
        <div className={css.row}>
          <button type="button" className="btn small" disabled={!enough || !!busy} onClick={() => runStack()} data-testid="sa-run">Stack</button>
          {catalogPm && <button type="button" className="btn small" disabled={!enough || !!busy} onClick={useCatalogue} data-testid="sa-catalog">Use catalogue</button>}
        </div>
        <label className="field" style={{ marginTop: 16 }}>Search limit
          <select value={maxRate} onChange={(e) => setMaxRate(+e.target.value)} data-testid="sa-maxrate">
            {[2, 5, 10, 20].map((r) => <option key={r} value={r}>{r} arcseconds per year</option>)}
          </select></label>
        <button type="button" className="btn small" style={{ marginTop: 0 }} disabled={!enough || !!busy || !picked} onClick={runSearch} data-testid="sa-search">Search selected point</button>
        {!picked && <p className="dim small">Select a point in the image first.</p>}
        {(busy === "stack" || busy === "search") && <p className="dim small" role="status"><i className="spin" /> {busy === "search" ? `Trying thousands of motions${progress ? `, ${progress}` : ""}.` : "Stacking."}</p>}
        {note && <p className="alert warn" role="status">{note}</p>}
        <div className={css.stack} hidden={!res}>
          <canvas ref={cv} width={64} height={64} role="img" data-testid="sa-canvas" aria-label="The dates stacked along the chosen motion; measurements are given below" />
          {res && <i className={css.ring} style={{ left: `${((res.peak.x + 0.5) / w) * 100}%`, top: `${((res.peak.y + 0.5) / w) * 100}%` }} aria-hidden />}
        </div>
        {res && (
          <div className={css.result} data-testid="sa-result" role="status">
            <p className="small">
              {res.search ? "Best motion found: " : "Stacked at "}
              <span className={css.num2}>{rateText(Math.hypot(res.east, res.north) / 1000)}</span> per year{Math.hypot(res.east, res.north) > 0 ? ` heading ${compass(res.east, res.north)}` : " (no motion)"}.
              The brightest spot {res.search ? "near your click" : "in the stack"} (ringed) stands <span className={css.num2}>{res.peak.value.toFixed(1)}</span> times above the noise, from {res.stack.used} {usedText} dates.
              {Number.isFinite(res.still) && Math.hypot(res.east, res.north) > 0 && <> Stacked without any motion, the same spot reaches <span className={css.num2}>{res.still.toFixed(1)}</span>.</>}
            </p>
            <p className="dim small">
              {res.search
                ? `${res.search.tried.toLocaleString("en")} motions were tried, so chance alone can reach about 5. Trust it only if it is well above that.`
                : "Below about 5 is what noise alone can do."} The stack shows the sky as on {refDate}; north is up, east is left.
            </p>
          </div>
        )}
      </div>

    </section>
  );
}

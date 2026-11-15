"use client";
// "Inject an object" Controls only: the parent keeps the value and does the hiding
// (see hideObject in lib/planetx.ts).
import { apparentMotion, type PlanetXValue } from "@/lib/planetx";
import { useState } from "react";
import css from "./MotionLab.module.css";

export type { PlanetXValue };
export type PlanetXPanelProps = {
  value: PlanetXValue;
  onChange: (next: PlanetXValue) => void;
  /** How many dates are on screen. */
  epochsCount: number;
  /** Years between the first and last date. */
  spanYears: number;
  fovArcmin: number;
  /** On how many dates the simulated object is inside the picture (0 when switched off). */
  inViewCount: number;
};

const newSeed = () => Math.floor(Math.random() * 1e9);
/** An angle in arcseconds, written the way a person would say it. */
const fmtArc = (a: number) => (a >= 120 ? `${(a / 60).toFixed(a >= 600 ? 0 : 1)} arcminutes` : `${a >= 10 ? a.toFixed(0) : a.toFixed(1)} arcseconds`);
const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const compass = (east: number, north: number) => DIRS[((Math.round((Math.atan2(east, north) * 180) / Math.PI / 45) % 8) + 8) % 8];

export default function PlanetXPanel({ value: v, onChange, epochsCount, spanYears, fovArcmin, inViewCount }: PlanetXPanelProps) {
  const [eastDraft, setEastDraft] = useState(String(v.pmEast));
  const [northDraft, setNorthDraft] = useState(String(v.pmNorth));
  const set = (p: Partial<PlanetXValue>) => onChange({ ...v, reveal: false, ...p });
  const m = apparentMotion(v.dist);
  const span = spanYears > 0 ? spanYears : 1;
  const rate = Math.hypot(v.pmEast, v.pmNorth);
  const travel = v.kind === "distance" ? 2 * m.wobbleArcsec + m.driftArcsecYr * span : rate * span;
  const widenTo = Math.min(30, Math.max(Math.ceil(fovArcmin) + 3, Math.ceil((travel * 1.6) / 60)));
  const mostlyOut = v.on && epochsCount > 0 && inViewCount < Math.max(2, epochsCount / 2);
  const num = (s: string) => { const x = parseFloat(s); return Number.isFinite(x) ? Math.max(-60, Math.min(60, x)) : 0; };

  return (
    <section data-testid="planetx-panel">
      <h2 className="h">Inject an object</h2>
      <p className="dim small">Add a simulated object to the real sky.</p>
      <label className="check"><input type="checkbox" checked={v.on} onChange={(e) => onChange({ ...v, on: e.target.checked, reveal: false, seed: e.target.checked ? newSeed() : v.seed })} data-testid="px-toggle" /> Enable simulation</label>
      {v.on && (
        <div className="pxbox">
          <div className="seg" role="group" aria-label="How to describe the object">
            <button type="button" className={`segbtn ${v.kind === "distance" ? "on" : ""}`} aria-pressed={v.kind === "distance"} onClick={() => set({ kind: "distance" })} data-testid="px-kind-distance">Distance</button>
            <button type="button" className={`segbtn ${v.kind === "custom" ? "on" : ""}`} aria-pressed={v.kind === "custom"} onClick={() => set({ kind: "custom" })} data-testid="px-kind-custom">Linear motion</button>
          </div>
          {v.kind === "distance" ? (
            <label className="field">Distance from the Sun
              <select value={v.dist} onChange={(e) => set({ dist: +e.target.value })} data-testid="px-dist">
                {[500, 2000, 5000, 20000].map((d) => <option key={d} value={d}>{d.toLocaleString("en")} AU</option>)}
              </select></label>
          ) : (
            <div className={css.pair}>
              <label className="field">East · ″/year
                <input className={css.num} type="number" min="-60" max="60" step="0.1" value={eastDraft} onChange={(e) => { setEastDraft(e.target.value); if (e.target.value !== "" && Number.isFinite(+e.target.value)) set({ pmEast: num(e.target.value) }); }} onBlur={(e) => { const value = num(e.target.value); setEastDraft(String(value)); set({ pmEast: value }); }} data-testid="px-pm-east" /></label>
              <label className="field">North · ″/year
                <input className={css.num} type="number" min="-60" max="60" step="0.1" value={northDraft} onChange={(e) => { setNorthDraft(e.target.value); if (e.target.value !== "" && Number.isFinite(+e.target.value)) set({ pmNorth: num(e.target.value) }); }} onBlur={(e) => { const value = num(e.target.value); setNorthDraft(String(value)); set({ pmNorth: value }); }} data-testid="px-pm-north" /></label>
            </div>
          )}
          <label className="field">Brightness
            <select value={v.snr} onChange={(e) => set({ snr: +e.target.value })} data-testid="px-snr">
              <option value={6}>Faint, barely above the noise</option><option value={12}>Medium</option><option value={30}>Bright</option>
            </select></label>
          {v.kind === "distance"
            ? <p className="dim small">At that distance it swings {fmtArc(m.wobbleArcsec)} each way every year as the Earth moves, and drifts {fmtArc(m.driftArcsecYr)} a year along its orbit.</p>
            : <p className="dim small">{rate > 0
                ? <>It moves in a straight line, {fmtArc(rate)} a year heading {compass(v.pmEast, v.pmNorth)}: {fmtArc(travel)} across these dates. Use negative numbers for west or south.</>
                : <>With both set to zero it stays put, like an ordinary star. Use negative numbers for west or south.</>}</p>}
          {mostlyOut && (
            <p className="alert warn" data-testid="px-warn">
              {v.kind === "distance"
                ? <>That swing is wider than this picture, so it is out of view on most dates. Widen the field of view to about {widenTo}′, or pick a larger distance.</>
                : <>At that speed it leaves this picture on most dates. Widen the field of view to about {widenTo}′, or type a slower motion.</>}
            </p>
          )}
          <div className="row">
            <button type="button" className="btn small" onClick={() => onChange({ ...v, reveal: !v.reveal })} data-testid="px-reveal">{v.reveal ? "Hide marker" : "Reveal"}</button>
            <button type="button" className="btn small" onClick={() => set({ seed: newSeed() })} data-testid="px-move">New position</button>
          </div>
        </div>
      )}
    </section>
  );
}

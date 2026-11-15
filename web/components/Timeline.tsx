"use client";
import type { Epoch } from "@/lib/epochs";
import { fmtDate } from "@/lib/epochs";

export type Mark = "none" | "active" | "a" | "b" | "in";

export default function Timeline({ epochs, marks, onSelect }: { epochs: Epoch[]; marks: Mark[]; onSelect: (i: number) => void }) {
  if (!epochs.length) return null;
  const t0 = Math.min(...epochs.map((e) => e.ms)), t1 = Math.max(...epochs.map((e) => e.ms));
  const pad = Math.max((t1 - t0) * 0.04, 20 * 86400000);
  const lo = t0 - pad, hi = t1 + pad;
  const pos = (ms: number) => ((ms - lo) / (hi - lo)) * 100;
  const y0 = new Date(lo).getUTCFullYear() + 1, y1 = new Date(hi).getUTCFullYear();
  const span = y1 - y0 + 1;
  const step = span > 12 ? 4 : span > 6 ? 2 : 1;
  const ticks: number[] = [];
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) ticks.push(y);
  return (
    <div className="timeline" data-testid="timeline" role="group" aria-label="Timeline, spacing proportional to date">
      <div className="track">
        {ticks.map((y) => (
          <span key={y} className="tick" style={{ left: `${pos(Date.UTC(y, 0, 1))}%` }}><b>{y}</b></span>
        ))}
        {epochs.map((e, i) => (
          <button
            key={e.key} className={`mark ${e.survey} ${marks[i]}`} style={{ left: `${pos(e.ms)}%` }}
            title={`${e.label} · ${fmtDate(e.ms)} · ${e.wl.toFixed(2)} µm`} aria-label={`${e.label}, ${fmtDate(e.ms)}`}
            aria-pressed={marks[i] !== "none"}
            onClick={() => onSelect(i)}
          >{marks[i] === "a" ? "A" : marks[i] === "b" ? "B" : ""}</button>
        ))}
      </div>
      <div className="legend"><span className="dot wise" /> WISE / NEOWISE <span className="dot spherex" /> SPHEREx <span className="muted">gaps are to scale in time</span></div>
    </div>
  );
}

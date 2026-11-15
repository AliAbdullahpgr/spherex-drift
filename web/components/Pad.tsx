"use client";
import { useRef, useState } from "react";
import type { Frame } from "@/lib/types";
import { detectorInfo } from "@/lib/epochs";

type Props = {
  frames: Frame[];
  detector: number;
  passFrom: number; passTo: number;
  currentPass: number | null;
  onSelect: (sel: { detector: number; passFrom: number; passTo: number; click: boolean }) => void;
};

export default function Pad({ frames, detector, passFrom, passTo, currentPass, onSelect }: Props) {
  const info = detectorInfo(frames);
  const passes = [...new Set(frames.map((f) => f.pass))].sort((a, b) => a - b);
  const dets = [...info].sort((a, b) => b.detector - a.detector); // long wavelength on top
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ det: number; p0: number; p1: number } | null>(null);
  const keyboardAnchor = useRef<number | null>(null);
  if (!passes.length) return <p className="muted">No SPHEREx coverage to show here.</p>;
  const cell = (d: number, p: number) => frames.filter((f) => f.detector === d && f.pass === p);
  const locate = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const gx = 56; // y label width in px, matches CSS
    const cw = (r.width - gx) / passes.length, ch = r.height / dets.length;
    const ci = Math.min(passes.length - 1, Math.max(0, Math.floor((e.clientX - r.left - gx) / cw)));
    const ri = Math.min(dets.length - 1, Math.max(0, Math.floor((e.clientY - r.top) / ch)));
    return { p: passes[ci], d: dets[ri].detector };
  };
  const sel = drag ? { lo: Math.min(drag.p0, drag.p1), hi: Math.max(drag.p0, drag.p1), det: drag.det } : { lo: passFrom, hi: passTo, det: detector };
  return (
    <div className="pad" data-testid="pad" role="group" aria-label="SPHEREx exposures by detector and observing pass">
      <div
        ref={ref} className="padgrid" style={{ gridTemplateColumns: `56px repeat(${passes.length}, 1fr)`, gridTemplateRows: `repeat(${dets.length}, 1fr)` }}
        onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button:not(:disabled)")) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); const l = locate(e); setDrag({ det: l.d, p0: l.p, p1: l.p }); }}
        onPointerMove={(e) => { if (drag) { const l = locate(e); if (l.p !== drag.p1) setDrag({ ...drag, p1: l.p }); } }}
        onPointerUp={() => {
          if (!drag) return;
          const lo = Math.min(drag.p0, drag.p1), hi = Math.max(drag.p0, drag.p1);
          onSelect({ detector: drag.det, passFrom: lo, passTo: hi, click: lo === hi });
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {dets.map((di) => (
          <div key={"r" + di.detector} className="fragment" style={{ display: "contents" }}>
            <div className="ylab mono" style={{ gridColumn: 1 }}>{di.wl.toFixed(1)} µm<small>D{di.detector}</small></div>
            {passes.map((p) => {
              const fs = cell(di.detector, p);
              const nflag = fs.filter((f) => f.flags.length).length;
              const inRange = p >= sel.lo && p <= sel.hi;
              const act = di.detector === sel.det;
              return (
                <button type="button" disabled={!fs.length}
                  key={di.detector + "-" + p}
                  className={`cell ${fs.length ? "has" : "empty"} ${act && inRange ? "sel" : ""} ${act ? "row" : ""} ${currentPass === p && act ? "cur" : ""}`}
                  data-testid={`cell-${di.detector}-${p}`}
                  aria-label={`Detector ${di.detector}, ${di.wl.toFixed(2)} micrometres, pass ${p}: ${fs.length} exposures${nflag ? `, ${nflag} with quality flags` : ""}`}
                  aria-pressed={act && inRange}
                  onClick={(event) => { if (event.detail === 0) { keyboardAnchor.current = p; onSelect({ detector: di.detector, passFrom: p, passTo: p, click: true }); } }}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                    event.preventDefault(); event.stopPropagation();
                    const row = dets.findIndex((d) => d.detector === di.detector), col = passes.indexOf(p);
                    const nextRow = Math.max(0, Math.min(dets.length - 1, row + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0)));
                    const nextCol = event.key === "Home" ? 0 : event.key === "End" ? passes.length - 1 : Math.max(0, Math.min(passes.length - 1, col + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0)));
                    ref.current?.querySelector<HTMLButtonElement>(`[data-testid="cell-${dets[nextRow].detector}-${passes[nextCol]}"]`)?.focus();
                    if (event.shiftKey && nextRow === row) {
                      const anchor = keyboardAnchor.current ?? p; keyboardAnchor.current = anchor;
                      onSelect({ detector: di.detector, passFrom: Math.min(anchor, passes[nextCol]), passTo: Math.max(anchor, passes[nextCol]), click: false });
                    } else keyboardAnchor.current = passes[nextCol];
                  }}
                  title={`Detector ${di.detector} (${di.wl.toFixed(2)} µm), pass ${p}: ${fs.length} frames${nflag ? `, ${nflag} flagged` : ""}`}
                >
                  {fs.length ? fs.length : "–"}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="xlabs" style={{ gridTemplateColumns: `56px repeat(${passes.length}, 1fr)` }}>
        <span />
        {passes.map((p) => {
          const f = frames.find((x) => x.pass === p)!;
          return <span key={p} className="mono">P{p}<small>{f.time.slice(0, 7)}</small></span>;
        })}
      </div>
    </div>
  );
}

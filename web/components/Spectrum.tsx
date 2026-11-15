"use client";
import type { Picked } from "@/lib/photometry";

export const PASS_COLORS = ["#56B4E9", "#E69F00", "#009E73", "#CC79A7", "#F0E442", "#D55E00", "#0072B2"];
const MARKERS = [{ wl: 3.0, label: "water ice" }, { wl: 4.27, label: "CO₂" }, { wl: 4.67, label: "CO" }];

export default function Spectrum({ picked, title }: { picked: Picked; title: string }) {
  const points = picked.pts.map((p) => ({ wavelength_um: p.wl, flux_mjy_sr: p.v, err: p.err, pass: p.pass }));
  const W = 320, H = 210, L = 44, R = 8, T = 16, B = 34;
  const pts = points.filter((p) => Number.isFinite(p.flux_mjy_sr) && Number.isFinite(p.wavelength_um));
  if (!pts.length) return <p className="muted">No spectral points returned for this position.</p>;
  const x0 = 0.7, x1 = 5.1;
  const ys = pts.flatMap((p) => [p.flux_mjy_sr - (p.err ?? 0), p.flux_mjy_sr + (p.err ?? 0)]);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padY = (y1 - y0) * 0.08 || 1;
  y0 -= padY; y1 += padY;
  const X = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v: number) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B);
  const passes = [...new Set(pts.map((p) => p.pass))].sort((a, b) => a - b);
  const col = (p: number) => PASS_COLORS[(p - 1) % PASS_COLORS.length];
  const yt = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  return (
    <figure className="spectrum" data-testid="spectrum">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Flux versus wavelength">
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="#070706" stroke="#3a3832" />
        {[1, 2, 3, 4, 5].map((w) => (
          <g key={w}><line x1={X(w)} x2={X(w)} y1={T} y2={H - B} stroke="#1d1c19" /><text x={X(w)} y={H - B + 13} fill="#8d897e" fontSize="11" textAnchor="middle">{w}</text></g>
        ))}
        {yt.map((v, i) => (
          <g key={i}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="#1d1c19" /><text x={L - 6} y={Y(v) + 4} fill="#8d897e" fontSize="11" textAnchor="end">{(y1 - y0) >= 40 ? v.toFixed(0) : (y1 - y0) >= 2 ? v.toFixed(1) : v.toFixed(2)}</text></g>
        ))}
        <text x={(L + W - R) / 2} y={H - 5} fill="#cdc9be" fontSize="11" textAnchor="middle">wavelength (µm)</text>
        <text transform={`translate(10 ${(T + H - B) / 2}) rotate(-90)`} fill="#cdc9be" fontSize="11" textAnchor="middle">{picked.kind === "halo" ? "halo brightness (MJy/sr)" : "brightness (MJy/sr)"}</text>
        {MARKERS.map((m, i) => (
          <g key={m.wl} data-testid="spec-marker">
            <line x1={X(m.wl)} x2={X(m.wl)} y1={T} y2={H - B} stroke="#8d897e" strokeDasharray="4 3" />
            <text x={X(m.wl) + (i === 2 ? 4 : -4)} y={T + 10 + (i === 2 ? 11 : 0)} fill="#f0ede4" fontSize="11" textAnchor={i === 2 ? "start" : "end"}>{m.label}</text>
          </g>
        ))}
        {pts.map((p, i) => (
          <g key={i} data-testid="spec-point">
            {p.err ? <line x1={X(p.wavelength_um)} x2={X(p.wavelength_um)} y1={Y(p.flux_mjy_sr - p.err)} y2={Y(p.flux_mjy_sr + p.err)} stroke={col(p.pass)} opacity=".45" /> : null}
            <circle cx={X(p.wavelength_um)} cy={Y(p.flux_mjy_sr)} r="2.2" fill={col(p.pass)} stroke="#000" strokeWidth=".4" />
          </g>
        ))}
      </svg>
      <div className="legend">
        {passes.map((p) => <span key={p}><i className="dot" style={{ background: col(p) }} /> pass {p}</span>)}
        
      </div>
      <p className="dim small">Colour = observing pass.{picked.kind === "halo" ? " Saturated core; outer-halo measurement." : ""}</p>
      <details className="measurement-data" data-testid="spectrum-data">
        <summary>View spectrum measurements as a table</summary>
        <div className="data-table" tabIndex={0} role="region" aria-label="Spectrum measurements, scroll horizontally if needed">
          <table><caption>{title}. Brightness in MJy/sr.</caption>
            <thead><tr><th scope="col">Pass</th><th scope="col">Wavelength (µm)</th><th scope="col">Brightness</th><th scope="col">Uncertainty</th></tr></thead>
            <tbody>{pts.map((p, i) => <tr key={i}><td>{p.pass}</td><td>{p.wavelength_um.toFixed(3)}</td><td>{p.flux_mjy_sr.toPrecision(5)}</td><td>{p.err == null || p.err <= 0 ? "Unavailable" : p.err.toPrecision(3)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

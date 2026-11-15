"use client";
import type { Curve } from "@/lib/photometry";

// Wavelength colours, short to long: a colour-blind-safe ramp (blue to orange).
const BAND = ["#4c9cff", "#56c4e8", "#8fd9b6", "#f0e09a", "#ffb454", "#ff7a3d"];
const month = (ms: number) => new Date(ms).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" });

/** Brightness over time. Each line is one wavelength band, scaled so its first pass is 100%. */
export default function LightCurve({ curves, kind }: { curves: Curve[]; kind: "flux" | "halo" }) {
  const usable = curves.filter((c) => c.points[0].v > 0 && Number.isFinite(c.change));
  if (!usable.length) return <p className="dim">Not enough clean measurements here to follow brightness over time.</p>;
  const W = 320, H = 190, L = 40, R = 10, T = 10, B = 26;
  const all = usable.flatMap((c) => c.points.map((p) => ({ ms: p.ms, r: (p.v / c.points[0].v) * 100 })));
  const t0 = Math.min(...all.map((a) => a.ms)), t1 = Math.max(...all.map((a) => a.ms));
  let y0 = Math.min(0, ...all.map((a) => a.r)), y1 = Math.max(120, ...all.map((a) => a.r)) * 1.06;
  y0 = Math.max(y0, -20);
  const X = (ms: number) => L + ((ms - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const Y = (r: number) => H - B - ((Math.min(y1, Math.max(y0, r)) - y0) / (y1 - y0)) * (H - T - B);
  const ticks = [0, 50, 100, 150, 200].filter((v) => v >= y0 && v <= y1);
  const dates = usable.reduce((a, c) => (c.points.length > a.length ? c.points : a), usable[0].points);
  // only call it a change when it is well clear of the measurement scatter
  const real = usable.filter((c) => c.sigma >= 5 && Math.abs(c.change) >= 0.1);
  const strongest = [...(real.length ? real : usable)].sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
  const pct = Math.round(Math.abs(strongest.change) * 100);
  const steady = real.length === 0;
  return (
    <figure className="spectrum" data-testid="lightcurve">
      <p className="finding">
        {steady
          ? <>No change clear of the measurement scatter between {month(dates[0].ms)} and {month(dates[dates.length - 1].ms)}.</>
          : <>At {strongest.wl.toFixed(1)} µm it was <b>{pct}% {strongest.change < 0 ? "fainter" : "brighter"}</b> in {month(strongest.points[strongest.points.length - 1].ms)} than in {month(strongest.points[0].ms)}.</>}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Brightness over time, one line per wavelength band">
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="#070706" stroke="#3a3832" />
        {ticks.map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={v === 100 ? "#5a574f" : "#1d1c19"} strokeDasharray={v === 100 ? "4 4" : undefined} /><text x={L - 7} y={Y(v) + 4} fill="#96928a" fontSize="11" textAnchor="end">{v}%</text></g>
        ))}
        {dates.map((p) => <text key={p.pass} x={X(p.ms)} y={H - B + 15} fill="#96928a" fontSize="11" textAnchor={X(p.ms) < L + 30 ? "start" : X(p.ms) > W - R - 30 ? "end" : "middle"}>{month(p.ms)}</text>)}
        {usable.map((c) => (
          <g key={c.det} data-testid="lc-line">
            <polyline points={c.points.map((p) => `${X(p.ms)},${Y((p.v / c.points[0].v) * 100)}`).join(" ")} fill="none" stroke={BAND[(c.det - 1) % 6]} strokeWidth="1.6" strokeLinejoin="round" />
            {c.points.map((p) => <circle key={p.pass} cx={X(p.ms)} cy={Y((p.v / c.points[0].v) * 100)} r="3" fill={BAND[(c.det - 1) % 6]} stroke="#000" strokeWidth=".8" />)}
          </g>
        ))}
      </svg>
      <div className="legend">
        {usable.map((c) => <span key={c.det}><i className="dot" style={{ background: BAND[(c.det - 1) % 6] }} />{c.wl.toFixed(1)} µm</span>)}
      </div>
      <p className="dim small">Each line is one wavelength band, with its first pass set to 100%.{kind === "halo" ? " This star saturates the detector, so brightness is measured from its outer halo." : ""}</p>
      <details className="measurement-data" data-testid="lightcurve-data">
        <summary>View brightness measurements as a table</summary>
        <div className="data-table" tabIndex={0} role="region" aria-label="Brightness over time measurements, scroll horizontally if needed">
          <table><caption>Brightness relative to the first pass in each wavelength band.</caption>
            <thead><tr><th scope="col">Wavelength (µm)</th><th scope="col">Date</th><th scope="col">Pass</th><th scope="col">Brightness (%)</th></tr></thead>
            <tbody>{usable.flatMap((c) => c.points.map((p) => <tr key={`${c.det}-${p.pass}`}><td>{c.wl.toFixed(2)}</td><td>{month(p.ms)}</td><td>{p.pass}</td><td>{(p.v / c.points[0].v * 100).toFixed(1)}</td></tr>))}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

"use client";
import { useMemo } from "react";
import {
  ARROW_MIN_ARCSEC_YR, GAIA_COLOR, KNOWN_COLOR, knownAt, pmArcsecYr, propagateGaia, skyToFrac,
  type GaiaSource, type KnownObject,
} from "@/lib/overlays";
import styles from "./SkyOverlay.module.css";

export type SkyOverlayProps = {
  view: { ra: number; dec: number; fov: number };
  /** Time of the image on screen (ms since 1970). Stars are drawn where they were at this time. */
  epochMs: number;
  /** Time span the arrows cover: [start, end] in ms. Defaults to one year starting at epochMs. */
  spanMs?: [number, number];
  gaia?: GaiaSource[];
  known?: KnownObject[];
  showGaia: boolean;
  showMotion: boolean;
  showKnown: boolean;
  invert?: boolean;
};

const YEAR_MS = 365.25 * 86400000;
const MAX_RINGS = 200;
const inside = (p: { x: number; y: number }, m = 0) => p.x >= -m && p.x <= 1 + m && p.y >= -m && p.y <= 1 + m;
const f = (n: number) => +(n * 100).toFixed(3);

/** SVG layer for the square sky image (north up, east left). Put it inside the image's positioned box. */
export default function SkyOverlay({ view, epochMs, spanMs, gaia = [], known = [], showGaia, showMotion, showKnown, invert = false }: SkyOverlayProps) {
  const { ra, dec, fov } = view;
  const span0 = spanMs?.[0] ?? epochMs, span1 = spanMs?.[1] ?? epochMs + YEAR_MS;

  const rings = useMemo(() => {
    if (!showGaia) return [];
    const v = { ra, dec, fov };
    const out: { id: string; x: number; y: number; r: number; fast: boolean }[] = [];
    for (const s of gaia) {
      const fast = pmArcsecYr(s) >= ARROW_MIN_ARCSEC_YR;
      if (out.length >= MAX_RINGS && !fast) continue;
      const q = propagateGaia(s, epochMs);
      const p = skyToFrac(q.ra, q.dec, v);
      if (!inside(p)) continue;
      const g = s.gmag ?? 18;
      out.push({ id: s.source_id, x: p.x, y: p.y, r: Math.max(0.9, Math.min(2.2, 2.2 - (g - 8) * 0.13)), fast });
    }
    return out;
  }, [gaia, showGaia, epochMs, ra, dec, fov]);

  const arrows = useMemo(() => {
    if (!showMotion) return [];
    const v = { ra, dec, fov };
    const out: { id: string; x1: number; y1: number; x2: number; y2: number; head: string }[] = [];
    for (const s of gaia) {
      if (pmArcsecYr(s) < ARROW_MIN_ARCSEC_YR) continue;
      const a = propagateGaia(s, span0), b = propagateGaia(s, span1);
      const p = skyToFrac(a.ra, a.dec, v), q = skyToFrac(b.ra, b.dec, v);
      if (!inside(p, 0.05) && !inside(q, 0.05)) continue;
      const dx = (q.x - p.x) * 100, dy = (q.y - p.y) * 100, len = Math.hypot(dx, dy);
      let head = "";
      if (len > 0.5) {
        const h = Math.min(1.8, len * 0.45), ux = dx / len, uy = dy / len;
        const tip = { x: q.x * 100, y: q.y * 100 };
        const wing = (sgn: number) => `${(tip.x - h * (ux * 0.87 - sgn * uy * 0.5)).toFixed(3)},${(tip.y - h * (uy * 0.87 + sgn * ux * 0.5)).toFixed(3)}`;
        head = `${wing(1)} ${tip.x.toFixed(3)},${tip.y.toFixed(3)} ${wing(-1)}`;
      }
      out.push({ id: s.source_id, x1: f(p.x), y1: f(p.y), x2: f(q.x), y2: f(q.y), head });
    }
    return out;
  }, [gaia, showMotion, span0, span1, ra, dec, fov]);

  const marks = useMemo(() => {
    if (!showKnown) return [];
    const v = { ra, dec, fov };
    return knownAt(known, epochMs)
      .map((o) => ({ o, p: skyToFrac(o.ra, o.dec, v) }))
      .filter(({ p }) => inside(p))
      .map(({ o, p }) => ({ key: o.name, name: o.number && !/^\d{4} /.test(o.name) ? `${o.name} (${o.number})` : o.name, x: f(p.x), y: f(p.y), rough: (o.err_arcsec ?? 0) > 6, flip: p.x > 0.7 }));
  }, [known, showKnown, epochMs, ra, dec, fov]);

  return (
    <svg className={styles.layer} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden data-testid="sky-overlay">
      {rings.length > 0 && (
        <g fill="none" stroke={invert ? "#00536b" : GAIA_COLOR}>
          {rings.map((s) => (
            <circle key={s.id} cx={f(s.x)} cy={f(s.y)} r={s.r} strokeWidth={s.fast ? 1.6 : 1} strokeOpacity={s.fast ? 1 : 0.7} vectorEffect="non-scaling-stroke" data-testid="gaia-mark" />
          ))}
        </g>
      )}
      {arrows.length > 0 && (
        <g fill="none" stroke={invert ? "#00536b" : GAIA_COLOR} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {arrows.map((a) => (
            <g key={a.id} data-testid="gaia-arrow">
              <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} vectorEffect="non-scaling-stroke" />
              {a.head && <polyline points={a.head} vectorEffect="non-scaling-stroke" />}
            </g>
          ))}
        </g>
      )}
      {marks.map((m) => (
        <g key={m.key} data-testid="known-mark">
          <path d={`M${m.x} ${m.y - 2.4} L${m.x + 2.4} ${m.y} L${m.x} ${m.y + 2.4} L${m.x - 2.4} ${m.y} Z`} fill="none" stroke={invert ? "#8c1455" : KNOWN_COLOR} strokeWidth="1.6" strokeDasharray={m.rough ? "3 3" : undefined} vectorEffect="non-scaling-stroke" />
          <text className={styles.label} x={m.flip ? m.x - 3.4 : m.x + 3.4} y={m.y + 0.9} textAnchor={m.flip ? "end" : "start"}>{m.name}</text>
        </g>
      ))}
    </svg>
  );
}

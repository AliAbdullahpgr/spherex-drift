"use client";
import { useEffect, useRef } from "react";
import { fmtDec, fmtRA, pix2sky } from "@/lib/coords";

type Props = {
  image: ImageData | null;
  size: number;
  fov: number; // arcmin
  ra: number; dec: number;
  crosshair: boolean;
  busy: string | null; // message shown over the image while fetching
  picked: { x: number; y: number } | null;
  onHover: (info: { x: number; y: number; ra: number; dec: number } | null) => void;
  onPick: (info: { x: number; y: number; ra: number; dec: number }) => void;
  caption?: string;
  /** Expected positions of a known mover, as fractions (0..1) of the image. */
  marks?: { x: number; y: number; label?: string; tone?: "now" | "a" | "b" }[];
  /** Expected path of a known mover across the epochs shown. */
  path?: { x: number; y: number }[];
  /** Text drawn over the image corners: big line, small line, top-right tag. */
  hud?: { big?: string; small?: string; tag?: string };
};

const NICE = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

export default function Viewer({ image, size, fov, ra, dec, crosshair, busy, picked, onHover, onPick, caption, marks = [], path = [], hud }: Props) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    if (image) {
      if (c.width !== image.width) { c.width = image.width; c.height = image.height; }
      ctx.putImageData(image, 0, 0);
    } else {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
    }
  }, [image]);

  const w = image?.width ?? size;
  const scale = (fov * 60) / w;
  const locate = (e: { clientX: number; clientY: number }) => {
    const r = cv.current!.getBoundingClientRect();
    const x = Math.min(w - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * w)));
    const y = Math.min(w - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * w)));
    const s = pix2sky(x, y, w, scale, ra, dec);
    return { x, y, ra: s.ra, dec: s.dec };
  };
  const bar = [...NICE].reverse().find((n) => n <= fov * 0.35) ?? NICE[0];
  const barPct = (bar / fov) * 100;
  const barLabel = bar >= 1 ? `${bar} arcmin` : `${Math.round(bar * 60)} arcsec`;

  return (
    <div className="viewer" data-testid="viewer">
      <div className="frame">
        <canvas
          ref={cv} width={size} height={size} data-testid="viewer-canvas" aria-label={caption || "Sky image"}
          onPointerMove={(e) => onHover(locate(e))}
          onPointerLeave={() => onHover(null)}
          onClick={(e) => onPick(locate(e))}
        />
        <svg className="overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {crosshair && (
            <g stroke="rgba(255,255,255,.55)" strokeWidth="0.35" vectorEffect="non-scaling-stroke">
              <line x1="50" y1="38" x2="50" y2="46" vectorEffect="non-scaling-stroke" /><line x1="50" y1="54" x2="50" y2="62" vectorEffect="non-scaling-stroke" />
              <line x1="38" y1="50" x2="46" y2="50" vectorEffect="non-scaling-stroke" /><line x1="54" y1="50" x2="62" y2="50" vectorEffect="non-scaling-stroke" />
            </g>
          )}
          {picked && <circle cx={((picked.x + 0.5) / w) * 100} cy={((picked.y + 0.5) / w) * 100} r="2.4" fill="none" stroke="#ffd166" strokeWidth="1.5" vectorEffect="non-scaling-stroke" data-testid="pick-ring" />}
          {path.length > 1 && (
            <polyline points={path.map((q) => `${q.x * 100},${q.y * 100}`).join(" ")} fill="none" stroke="#ffd166" strokeOpacity=".75" strokeWidth="1.2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" data-testid="pm-path" />
          )}
          {/* TODO(gaia): proper-motion arrows for every field star are drawn here, see lib/overlays.ts */}
        </svg>
        {marks.map((m, i) => (
          <div key={i} className={`pmark ${m.tone ?? "now"}`} style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }} data-testid="pm-mark">{m.label && <span>{m.label}</span>}</div>
        ))}
        <svg className="compass" viewBox="0 0 60 60" aria-label="North is up, east is left">
          <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round">
            <path d="M30 34 V8 M30 8 l-4 6 M30 8 l4 6" /><path d="M30 34 H6 M6 34 l6 -4 M6 34 l6 4" />
          </g>
          <text x="30" y="5.5" textAnchor="middle" fontSize="9" fill="#fff">N</text>
          <text x="6" y="48" textAnchor="middle" fontSize="9" fill="#fff">E</text>
        </svg>
        <div className="scalebar" style={{ width: `${barPct}%` }} data-testid="scalebar"><span>{barLabel}</span></div>
        <i className="corner tl" aria-hidden /><i className="corner tr" aria-hidden /><i className="corner bl" aria-hidden /><i className="corner br" aria-hidden />
        {hud?.tag && <div className="hud tag">{hud.tag}</div>}
        {(hud?.big || hud?.small) && <div className="hud info">{hud.big && <b>{hud.big}</b>}{hud.small && <span>{hud.small}</span>}</div>}
        {busy && <div className="busy" role="status" data-testid="busy"><i className="spin" />{busy}</div>}
      </div>
    </div>
  );
}

export function Readout({ hover, value }: { hover: { ra: number; dec: number; x: number; y: number } | null; value?: string }) {
  return (
    <div className="readout mono" data-testid="readout" aria-live="off">
      {hover ? <>RA {fmtRA(hover.ra)} · Dec {fmtDec(hover.dec)} · {hover.ra.toFixed(5)}, {hover.dec.toFixed(5)}{value ? ` · ${value}` : ""}</> : "Hover for RA/Dec, click a pixel for its spectrum"}
    </div>
  );
}

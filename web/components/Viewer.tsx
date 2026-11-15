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
  /** Extra layers drawn over the picture (catalogue overlays). */
  children?: React.ReactNode;
  /** Draw each image pixel as a hard-edged square instead of smoothing. */
  sharp?: boolean;
  /** The picture has a white sky, so the furniture drawn over it must be dark. */
  invert?: boolean;
  /** Goes up by one each time the animation starts over; the border flashes. */
  loopTick?: number;
  /** Dragging or double-clicking asks for a new centre; the wheel or a pinch asks for a new field of view. */
  onRecentre?: (ra: number, dec: number) => void;
  onZoom?: (fov: number) => void;
  /** True while a picture for the current view is still on its way (keeps the dragged picture up meanwhile). */
  loading?: boolean;
};

const NICE = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const FOV_MIN = 1, FOV_MAX = 30;
const DRAG_PX = 5; // a press that moves less than this is a click

export default function Viewer({ image, size, fov, ra, dec, crosshair, busy, picked, onHover, onPick, caption, marks = [], path = [], hud, sharp = false, invert = false, loopTick = 0, onRecentre, onZoom, loading = false, children }: Props) {
  const cv = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // gesture state lives in refs: the picture follows the pointer without re-rendering React
  const g = useRef({
    pts: new Map<number, { x: number; y: number }>(), startX: 0, startY: 0, moved: false, pinch: 0, k: 1,
    stale: false, // the canvas still shows the previous view, shifted to where the new one will be
    suppressClick: false, clickT: 0 as unknown as ReturnType<typeof setTimeout>, wheelT: 0 as unknown as ReturnType<typeof setTimeout>, wheelFov: 0,
  });
  const show = (tx: number, ty: number, k: number, moving: boolean) => {
    if (cv.current) cv.current.style.transform = tx || ty || k !== 1 ? `translate(${tx}px, ${ty}px) scale(${k})` : "";
    frame.current?.classList.toggle("moving", moving);
  };

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    if (image) {
      if (c.width !== image.width) { c.width = image.width; c.height = image.height; }
      ctx.putImageData(image, 0, 0);
    } else if (g.current.stale && loading) {
      return; // keep the dragged or zoomed picture up until the new one arrives
    } else {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
    }
    if (g.current.stale) { g.current.stale = false; show(0, 0, 1, false); }
  }, [image, loading]);

  const w = image?.width ?? size;
  const scale = (fov * 60) / w;
  const locate = (e: { clientX: number; clientY: number }) => {
    const r = cv.current!.getBoundingClientRect();
    const x = Math.min(w - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * w)));
    const y = Math.min(w - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * w)));
    const s = pix2sky(x, y, w, scale, ra, dec);
    return { x, y, ra: s.ra, dec: s.dec };
  };
  /** Forget a previous view still parked on the canvas, so a new gesture starts from a clean picture. */
  const dropStale = () => {
    if (!g.current.stale) return;
    g.current.stale = false;
    const c = cv.current;
    if (c && !image) { const ctx = c.getContext("2d")!; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height); }
    show(0, 0, 1, false);
  };
  const commitZoom = (target: number) => {
    let f = Math.min(FOV_MAX, Math.max(FOV_MIN, Math.round(target * 2) / 2));
    if (f === fov && Math.abs(target / fov - 1) > 0.04) f = Math.min(FOV_MAX, Math.max(FOV_MIN, fov + (target > fov ? 0.5 : -0.5)));
    if (f === fov || !onZoom) { show(0, 0, 1, false); return; }
    g.current.stale = true;
    show(0, 0, fov / f, true);
    onZoom(f);
  };
  const live = useRef({ fov, commitZoom, dropStale });
  live.current = { fov, commitZoom, dropStale };

  // wheel: zoom. Needs a non-passive listener so the page does not scroll while the pointer is on the picture.
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const s = g.current, { fov: f } = live.current;
      if (s.stale) live.current.dropStale();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      s.wheelFov = Math.min(FOV_MAX, Math.max(FOV_MIN, (s.wheelFov || f) * Math.exp(Math.max(-300, Math.min(300, dy)) * 0.0015)));
      show(0, 0, f / s.wheelFov, true);
      clearTimeout(s.wheelT);
      s.wheelT = setTimeout(() => { const t = s.wheelFov; s.wheelFov = 0; live.current.commitZoom(t); }, 280);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => { c.removeEventListener("wheel", onWheel); clearTimeout(g.current.wheelT); clearTimeout(g.current.clickT); };
  }, []);

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const s = g.current;
    dropStale();
    s.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (s.pts.size === 1) { s.startX = e.clientX; s.startY = e.clientY; s.moved = false; s.pinch = 0; s.k = 1; }
    else if (s.pts.size === 2) { const [a, b] = [...s.pts.values()]; s.pinch = Math.hypot(a.x - b.x, a.y - b.y) || 1; s.moved = true; }
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = g.current;
    if (!s.pts.has(e.pointerId)) { if (!s.stale && !s.wheelFov) onHover(locate(e)); return; }
    s.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.pinch) {
      if (s.pts.size < 2) return; // one finger lifted: wait for the other
      const [a, b] = [...s.pts.values()];
      s.k = Math.min(8, Math.max(0.125, Math.hypot(a.x - b.x, a.y - b.y) / s.pinch));
      show(0, 0, s.k, true);
      return;
    }
    const dx = e.clientX - s.startX, dy = e.clientY - s.startY;
    if (!s.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!s.moved) { s.moved = true; onHover(null); }
    show(dx, dy, 1, true);
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const s = g.current;
    if (!s.pts.has(e.pointerId)) return;
    const last = s.pts.get(e.pointerId)!;
    s.pts.delete(e.pointerId);
    if (s.pts.size) return; // still pinching with the other finger
    if (!s.moved) return;   // a plain click: handled by onClick
    s.suppressClick = e.pointerType === "mouse"; // the browser still sends a click after a mouse drag
    if (cancelled) { show(0, 0, 1, false); return; }
    if (s.pinch) { s.pinch = 0; commitZoom(fov / s.k); return; }
    const r = e.currentTarget.getBoundingClientRect(); // includes the drag offset; its size does not change
    const dpx = ((last.x - s.startX) / r.width) * w, dpy = ((last.y - s.startY) / r.height) * w;
    if (Math.hypot(dpx, dpy) < 0.5 || !onRecentre) { show(0, 0, 1, false); return; }
    const c = (w - 1) / 2, sky = pix2sky(c - dpx, c - dpy, w, scale, ra, dec);
    s.stale = true; // leave the picture where it was dropped until the new one loads
    frame.current?.classList.add("moving");
    onRecentre(sky.ra, sky.dec);
  };
  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = g.current;
    if (s.suppressClick) { s.suppressClick = false; return; }
    if (s.stale) return;
    const at = locate(e);
    clearTimeout(s.clickT);
    if (e.detail >= 2) { // double-click: put that point in the middle
      if (!onRecentre) return;
      const r = e.currentTarget.getBoundingClientRect();
      s.stale = true;
      show(r.left + r.width / 2 - e.clientX, r.top + r.height / 2 - e.clientY, 1, true);
      onRecentre(at.ra, at.dec);
    } else s.clickT = setTimeout(() => onPick(at), e.detail === 1 ? 240 : 0); // wait to see if a second click follows
  };

  const bar = [...NICE].reverse().find((n) => n <= fov * 0.35) ?? NICE[0];
  const barPct = (bar / fov) * 100;
  const barLabel = bar >= 1 ? `${bar} arcmin` : `${Math.round(bar * 60)} arcsec`;

  return (
    <div className="viewer" data-testid="viewer">
      <div className={`frame ${invert ? "inv" : ""}`} ref={frame}>
        <canvas
          ref={cv} width={size} height={size} data-testid="viewer-canvas" aria-label={caption || "Sky image"} className={sharp ? "sharp" : undefined}
          onPointerDown={down} onPointerMove={move} onPointerUp={(e) => up(e)} onPointerCancel={(e) => up(e, true)}
          onPointerLeave={() => onHover(null)}
          onClick={click}
        />
        <svg className="overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {crosshair && (
            <g className="cross" strokeWidth="0.35" vectorEffect="non-scaling-stroke">
              <line x1="50" y1="38" x2="50" y2="46" vectorEffect="non-scaling-stroke" /><line x1="50" y1="54" x2="50" y2="62" vectorEffect="non-scaling-stroke" />
              <line x1="38" y1="50" x2="46" y2="50" vectorEffect="non-scaling-stroke" /><line x1="54" y1="50" x2="62" y2="50" vectorEffect="non-scaling-stroke" />
            </g>
          )}
          {picked && <circle className="onsky" cx={((picked.x + 0.5) / w) * 100} cy={((picked.y + 0.5) / w) * 100} r="2.4" fill="none" stroke="#ffd166" strokeWidth="1.5" vectorEffect="non-scaling-stroke" data-testid="pick-ring" />}
          {path.length > 1 && (
            <polyline className="onsky" points={path.map((q) => `${q.x * 100},${q.y * 100}`).join(" ")} fill="none" stroke="#ffd166" strokeOpacity=".75" strokeWidth="1.2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" data-testid="pm-path" />
          )}
          {/* TODO(gaia): proper-motion arrows for every field star are drawn here, see lib/overlays.ts */}
        </svg>
        {marks.map((m, i) => (
          <div key={i} className={`pmark ${m.tone ?? "now"}`} style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }} data-testid="pm-mark">{m.label && <span>{m.label}</span>}</div>
        ))}
        {children}
        <svg className="compass" viewBox="0 0 60 60" aria-label="North is up, east is left">
          <g stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round">
            <path d="M30 34 V8 M30 8 l-4 6 M30 8 l4 6" /><path d="M30 34 H6 M6 34 l6 -4 M6 34 l6 4" />
          </g>
          <text x="30" y="5.5" textAnchor="middle" fontSize="9" fill="#fff">N</text>
          <text x="6" y="48" textAnchor="middle" fontSize="9" fill="#fff">E</text>
        </svg>
        <div className="scalebar" style={{ width: `${barPct}%` }} data-testid="scalebar"><span>{barLabel}</span></div>
        <i className="corner tl" aria-hidden /><i className="corner tr" aria-hidden /><i className="corner bl" aria-hidden /><i className="corner br" aria-hidden />
        {loopTick > 0 && <i key={loopTick} className="loopflash" aria-hidden data-testid="loop-flash" />}
        {hud?.tag && <div className="hud tag">{hud.tag}</div>}
        {(hud?.big || hud?.small) && <div className="hud info">{hud.big && <b>{hud.big}</b>}{hud.small && <span>{hud.small}</span>}</div>}
        {busy && <div className="busy" role="status" data-testid="busy"><i className="spin" />{busy}</div>}
      </div>
    </div>
  );
}

export function Readout({ hover, value }: { hover: { ra: number; dec: number; x: number; y: number } | null; value?: string }) {
  return (
    <div className={`readout ${hover ? "mono" : ""}`} data-testid="readout" aria-live="off">
      {hover ? <>RA {fmtRA(hover.ra)} · Dec {fmtDec(hover.dec)} · {hover.ra.toFixed(5)}, {hover.dec.toFixed(5)}{value ? ` · ${value}` : ""}</> : "Drag to move, scroll to zoom, double-click to centre. Click a star for its spectrum."}
    </div>
  );
}

"use client";
import { useEffect, useRef } from "react";
import type { Epoch } from "@/lib/epochs";
import { fmtDate } from "@/lib/epochs";
import type { Mark } from "./Timeline";

function Thumb({ image }: { image: ImageData | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    if (!image) { ctx.fillStyle = "#0b0b0b"; ctx.fillRect(0, 0, c.width, c.height); return; }
    const off = document.createElement("canvas");
    off.width = image.width; off.height = image.height;
    off.getContext("2d")!.putImageData(image, 0, 0);
    // show the central half of the field so the target is recognisable at thumbnail size
    const q = image.width / 4;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, q, q, image.width / 2, image.height / 2, 0, 0, c.width, c.height);
  }, [image]);
  return <canvas ref={ref} width={64} height={64} aria-hidden />;
}

/** One thumbnail per date, oldest first. The honest-spacing ruler lives in Timeline. */
export default function Filmstrip({ epochs, thumbs, marks, onSelect }: { epochs: Epoch[]; thumbs: (ImageData | null)[]; marks: Mark[]; onSelect: (i: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const active = marks.findIndex((m) => m === "active");
  useEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>(".cellfilm.active");
    const box = wrap.current;
    if (!el || !box) return;
    const l = el.offsetLeft, r = l + el.offsetWidth;
    if (l < box.scrollLeft || r > box.scrollLeft + box.clientWidth) box.scrollTo({ left: l - box.clientWidth / 2 + el.offsetWidth / 2, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [active]);
  if (!epochs.length) return null;
  return (
    <div className="film" ref={wrap} data-testid="filmstrip" role="group" aria-label="Every date, oldest first">
      {epochs.map((e, i) => (
        <button key={e.key} className={`cellfilm ${e.survey} ${marks[i]}`} aria-pressed={marks[i] !== "none"} onClick={() => onSelect(i)} title={`${e.label} · ${fmtDate(e.ms)} · ${e.wl.toFixed(2)} µm`} aria-label={`${e.label}, ${fmtDate(e.ms)}`}>
          <Thumb image={thumbs[i]} />
          <span className="when">{fmtDate(e.ms).slice(0, 7)}</span>
          {(marks[i] === "a" || marks[i] === "b") && <span className="ab">{marks[i].toUpperCase()}</span>}
        </button>
      ))}
    </div>
  );
}

"use client";
import type { AppState } from "@/lib/urlstate";

export default function Walkthrough({ onApply }: { onApply: (p: Partial<AppState>) => void }) {
  return (
    <details className="walk" data-testid="walkthrough">
      <summary>How to spot a mover</summary>
      <ol>
        <li><b>Blink:</b> play the dates. Look for a point that moves.</li>
        <li><b>Trail:</b> blue is old, orange is new. White is unchanged.</li>
        <li><b>Difference:</b> static stars cancel. Orange is brighter; blue is fainter.</li>
        <li><b>Inspect:</b> click a point for its spectrum.</li>
      </ol>
      <div className="row">
        <button className="btn solid" onClick={() => onApply({ ra: 133.795129, dec: -7.245147, fov: 5, mode: "blink", wise: true })} data-testid="walk-go">Show me WISE 0855</button>
      </div>
    </details>
  );
}

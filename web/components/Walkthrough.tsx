"use client";
import type { AppState } from "@/lib/urlstate";

export default function Walkthrough({ onApply }: { onApply: (p: Partial<AppState>) => void }) {
  return (
    <details className="walk" data-testid="walkthrough">
      <summary>How to spot a mover</summary>
      <ol>
        <li><b>Stars stay put.</b> Almost everything in the picture is a distant star. Over years it does not shift, so it stays in the same place in every image.</li>
        <li><b>WISE 0855 does not.</b> It is a cold brown dwarf only about 7 light years away. Being so close, it drifts across the sky by roughly 8 arcseconds every year, one of the fastest movers known.</li>
        <li><b>Blink.</b> The Blink view plays by itself. Look for the one faint dot that jumps while its neighbours hold still. The border flashes each time the dates start over.</li>
        <li><b>Rainbow trail.</b> Every epoch is tinted from blue (oldest) to red (newest) and stacked. Stationary stars add up to white; a mover leaves a blue-to-red streak. Turn on WISE (2010 onward) to lengthen the streak to 15 years.</li>
        <li><b>Difference.</b> Each date has the other dates subtracted, so every star that holds still cancels to black. A mover is the one orange dot that walks across the picture.</li>
      </ol>
      <div className="row">
        <button className="btn solid" onClick={() => onApply({ ra: 133.795129, dec: -7.245147, fov: 5, mode: "blink", wise: true })} data-testid="walk-go">Show me WISE 0855</button>
      </div>
    </details>
  );
}

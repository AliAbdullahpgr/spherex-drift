"use client";
import { Children, useEffect, useRef } from "react";
import Icon from "./Icon";
export type InspectorPanel = "view" | "analyze" | "about";
export default function Inspector({ panel, onChange, children, docked = false }: { panel: InspectorPanel | null; onChange: (panel: InspectorPanel | null) => void; children: React.ReactNode; docked?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sections = Children.toArray(children);
  useEffect(() => {
    const element = dialog.current;
    const modal = panel && (!docked || panel === "about");
    if (modal && !element?.open) element?.showModal();
    else if (!modal && element?.open) element.close();
    if (docked && (panel === "view" || panel === "analyze")) document.getElementById(`controls-${panel}`)?.focus({ preventScroll: true });
  }, [panel, docked]);
  return <div className={`control-host ${docked ? "docked" : ""}`}>
    {docked && <>
      <aside className="control-rail view-rail" aria-labelledby="controls-view" data-testid="view-rail">
        <h2 id="controls-view" tabIndex={-1} className="rail-heading"><Icon name="view" />View controls</h2>
        {sections[0]}
      </aside>
      <aside className="control-rail analysis-rail" aria-labelledby="controls-analyze" data-testid="analysis-rail">
        <h2 id="controls-analyze" tabIndex={-1} className="rail-heading"><Icon name="analyze" />Analysis</h2>
        {sections[1]}
      </aside>
    </>}
    <dialog ref={dialog} className="inspector" aria-labelledby="inspector-title" onClose={() => onChange(null)} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
  }}>
    <div className="inspector-head">
      <h2 id="inspector-title">{panel === "view" ? "View" : panel === "analyze" ? "Analyze" : "Field notes"}</h2>
      <button type="button" className="icon-button" aria-label="Close inspector" onClick={() => onChange(null)}><Icon name="close" /></button>
    </div>
    <nav className="inspector-nav" aria-label="Inspector sections">
      {(["view", "analyze", "about"] as const).map((item) => <button type="button" key={item} aria-current={panel === item ? "page" : undefined} onClick={() => onChange(item)}>{item === "view" ? "View" : item === "analyze" ? "Analyze" : "Notes"}</button>)}
    </nav>
    <div className="inspector-body">{docked ? sections[2] : children}</div>
  </dialog></div>;
}

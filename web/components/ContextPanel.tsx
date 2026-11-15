"use client";
import { useEffect, useState } from "react";
import { buildLinks, contextUrl, getContextInfo, getLinks, type ContextInfo, type SkyLink } from "@/lib/overlays";
import styles from "./ContextPanel.module.css";

export type ContextPanelProps = {
  view: { ra: number; dec: number; fov: number };
  /** Name of the image this is compared with, e.g. "SPHEREx". */
  sourceLabel?: string;
};

type State = { status: "loading" } | { status: "ready"; info: ContextInfo } | { status: "none"; note?: string | null };

/** The same field in another survey, plus links to look the spot up elsewhere. */
export default function ContextPanel({ view, sourceLabel = "SPHEREx" }: ContextPanelProps) {
  const { ra, dec, fov } = view;
  const [state, setState] = useState<State>({ status: "loading" });
  const [loaded, setLoaded] = useState(false);
  const [links, setLinks] = useState<SkyLink[]>(() => buildLinks(ra, dec));

  useEffect(() => {
    const ctl = new AbortController();
    let live = true;
    setState({ status: "loading" });
    setLoaded(false);
    const t = setTimeout(() => {
      getContextInfo({ ra, dec, fov }, ctl.signal).then((info) => {
        if (!live) return;
        setState(info.available ? { status: "ready", info } : { status: "none", note: info.note });
      });
    }, 250);
    return () => { live = false; clearTimeout(t); ctl.abort(); };
  }, [ra, dec, fov]);

  useEffect(() => {
    let live = true;
    setLinks(buildLinks(ra, dec));
    getLinks(ra, dec).then((l) => { if (live) setLinks(l); });
    return () => { live = false; };
  }, [ra, dec]);

  const info = state.status === "ready" ? state.info : null;
  const light = info?.kind === "infrared" ? "infrared light" : "visible light";

  return (
    <section data-testid="context-panel">
      <h2 className="h">The same spot in another survey</h2>
      <figure className={styles.fig}>
        <div className={styles.pic} data-testid="context-picture" data-state={state.status}>
          {info && (
            <img
              src={contextUrl({ ra, dec, fov })} alt={`The same field in ${light} from ${info.label}`}
              onLoad={() => setLoaded(true)} onError={() => setState({ status: "none", note: "The picture could not be loaded." })}
              style={{ opacity: loaded ? 1 : 0 }} data-testid="context-image"
            />
          )}
          {(state.status === "loading" || (info && !loaded)) && (
            <div className={styles.state} role="status"><span className="spin" /> Looking for a picture of this spot</div>
          )}
          {state.status === "none" && (
            <div className={styles.state} data-testid="context-none">{state.note || "No other survey has a picture of this spot."}</div>
          )}
        </div>
        <figcaption className={`${styles.cap} dim small`}>
          {info ? (
            <><b>{info.label}</b>, {light}. {info.about} Same field and orientation as the {sourceLabel} image: north is up, east is left.</>
          ) : state.status === "none" ? (
            <>Use the links below to see this spot in other sky surveys.</>
          ) : (
            <>A colour picture of the same field, to compare with the {sourceLabel} image.</>
          )}
        </figcaption>
      </figure>
      <h2 className={`h ${styles.sub}`}>Look this spot up elsewhere</h2>
      <ul className={styles.links}>
        {links.filter((l) => l.id !== "finderchart").map((l) => (
          <li key={l.id}>
            <a className="btn" href={l.url} target="_blank" rel="noopener noreferrer" data-testid={`link-${l.id}`}>
              <span>{l.label}</span>{l.about && <span className="dim small">{l.about}</span>}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

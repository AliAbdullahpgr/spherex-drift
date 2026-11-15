import type { CSSProperties } from "react";

export type IconName = "play" | "pause" | "previous" | "next" | "search" | "view" | "analyze" | "help" | "close" | "expand" | "frames" | "loop" | "motion" | "variable" | "arrow";
const paths: Record<IconName, React.ReactNode> = {
  play: <path d="m8 5 11 7-11 7Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  previous: <><path d="M6 5v14m12-14-9 7 9 7Z" /></>,
  next: <><path d="M18 5v14M6 5l9 7-9 7Z" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  view: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  analyze: <><path d="M4 18V6m0 12h16M7 14l4-5 4 3 5-8" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 2m0 3h.01" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  expand: <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />,
  frames: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 5v14m8-14v14M3 9h5m-5 6h5m8-6h5m-5 6h5" /></>,
  loop: <><path d="m16 3 4 4-4 4M20 7H8a4 4 0 0 0-4 4m4 10-4-4 4-4M4 17h12a4 4 0 0 0 4-4" /></>,
  motion: <><path d="M3 17h3m-1-5h5m-2-5h5m1 10 7-7m-6 0h6v6" /></>,
  variable: <path d="M2 12h3l3-7 5 14 3-7h6" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
};
export default function Icon({ name, style }: { name: IconName; style?: CSSProperties }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}

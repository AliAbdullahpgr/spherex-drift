// Coordinate + target-name parsing. Pure functions, unit tested in coords.test.ts.

export type Sky = { ra: number; dec: number };
export type ParseResult = { ok: true; ra: number; dec: number; format: "decimal" | "sexagesimal" } | { ok: false; error: string };

const NUM = /[+-]?\d+(?:\.\d+)?|[+-]?\.\d+/g;

function sexToDeg(tokens: string[]): number {
  // tokens: [d, m?, s?] raw strings; first may carry the sign (including "-0")
  const neg = tokens[0].trim().startsWith("-");
  const parts = tokens.map((t) => Math.abs(parseFloat(t)));
  const v = parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600;
  return neg ? -v : v;
}

export function parseCoords(input: string): ParseResult {
  const s = input.trim().toLowerCase().replace(/[,;]/g, " ").replace(/[°′″'"]/g, (c) => (c === "°" ? "d " : c === "′" || c === "'" ? "m " : "s "));
  if (!s) return { ok: false, error: "Enter coordinates such as 133.7951 -7.2451, or 08h55m10.83s -07d14m42.5s." };
  if (/[a-ce-gi-ln-rt-z]/.test(s.replace(/[hdms]/g, ""))) return { ok: false, error: "That does not look like coordinates." };

  const hasMarkers = /\d\s*[hdms]/.test(s);
  const hasColon = s.includes(":");
  const nums = s.match(NUM) ?? [];

  if (!hasMarkers && !hasColon && nums.length === 2) {
    const ra = parseFloat(nums[0]);
    const dec = parseFloat(nums[1]);
    return validate(ra, dec, "decimal");
  }

  // sexagesimal: split into RA group and Dec group
  let raTok: string[];
  let decTok: string[];
  if (hasMarkers && /d/.test(s) && /h/.test(s)) {
    const idx = s.search(/[+-]?\s*\d+(?:\.\d+)?\s*d/);
    if (idx <= 0) return { ok: false, error: "Could not find the declination part (e.g. -07d14m42.5s)." };
    raTok = (s.slice(0, idx).match(NUM) ?? []);
    decTok = (s.slice(idx).replace(/\s+/g, " ").replace(/([+-])\s+/g, "$1").match(NUM) ?? []);
  } else {
    // colon or space separated: equal halves
    const t = s.replace(/([+-])\s+/g, "$1").match(NUM) ?? [];
    if (t.length !== 4 && t.length !== 6) {
      return { ok: false, error: "Expected two decimal numbers, or RA and Dec as h m s / d m s (4 or 6 numbers)." };
    }
    raTok = t.slice(0, t.length / 2);
    decTok = t.slice(t.length / 2);
  }
  if (raTok.length < 1 || raTok.length > 3 || decTok.length < 1 || decTok.length > 3) {
    return { ok: false, error: "Could not split the text into RA and Dec." };
  }
  if (raTok.some((x) => x.startsWith("-"))) return { ok: false, error: "RA cannot be negative." };
  const raH = sexToDeg(raTok.map((x) => x.replace(/^\+/, "")));
  if (raTok.length > 1 && (parseFloat(raTok[1]) >= 60 || (raTok[2] && parseFloat(raTok[2]) >= 60))) return { ok: false, error: "Minutes and seconds must be below 60." };
  if (decTok.length > 1 && (Math.abs(parseFloat(decTok[1])) >= 60 || (decTok[2] && Math.abs(parseFloat(decTok[2])) >= 60))) return { ok: false, error: "Minutes and seconds must be below 60." };
  const dec = sexToDeg(decTok);
  return validate(raH * 15, dec, "sexagesimal");
}

function validate(ra: number, dec: number, format: "decimal" | "sexagesimal"): ParseResult {
  if (!isFinite(ra) || !isFinite(dec)) return { ok: false, error: "Could not read those numbers." };
  if (ra < 0 || ra >= 360) return { ok: false, error: "RA must be between 0 and 360 degrees (0 to 24 hours)." };
  if (dec < -90 || dec > 90) return { ok: false, error: "Dec must be between -90 and +90 degrees." };
  return { ok: true, ra, dec, format };
}

export type NamedTarget = { id: string; name: string; ra: number; dec: number; note?: string };

export function normName(s: string): string {
  return s.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Exact or prefix match on the FULL name (or id). Never matches on a single word of the query. */
export function matchTargets(query: string, targets: NamedTarget[]): NamedTarget[] {
  const q = normName(query);
  if (!q) return [];
  const exact = targets.filter((t) => normName(t.name) === q || t.id.toLowerCase() === q);
  if (exact.length) return exact;
  if (q.length < 3) return [];
  return targets.filter((t) => normName(t.name).startsWith(q));
}

export type ResolveResult =
  | { ok: true; ra: number; dec: number; label?: string }
  | { ok: false; error: string };

export function resolveInput(input: string, targets: NamedTarget[]): ResolveResult {
  const text = input.trim();
  if (!text) return { ok: false, error: "Type coordinates or pick a target." };
  if (/\d/.test(text) && !matchTargets(text, targets).length) {
    const r = parseCoords(text);
    return r.ok ? { ok: true, ra: r.ra, dec: r.dec } : r;
  }
  const m = matchTargets(text, targets);
  if (m.length === 1) return { ok: true, ra: m[0].ra, dec: m[0].dec, label: m[0].name };
  if (m.length > 1) return { ok: false, error: `Several targets match: ${m.map((t) => t.name).join(", ")}. Type more of the name.` };
  return { ok: false, error: `"${text}" is not one of the quick-pick targets and is not coordinates. Name lookup is limited to: ${targets.map((t) => t.name).join(", ")}. Otherwise enter RA and Dec.` };
}

export function fmtRA(deg: number): string {
  const h = deg / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${String(hh).padStart(2, "0")}h${String(mm).padStart(2, "0")}m${ss.toFixed(2).padStart(5, "0")}s`;
}
export function fmtDec(deg: number): string {
  const sg = deg < 0 ? "-" : "+";
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${sg}${String(d).padStart(2, "0")}d${String(mm).padStart(2, "0")}m${ss.toFixed(1).padStart(4, "0")}s`;
}

/** Gnomonic (tangent-plane) projection helpers. Image: north up, east left. */
const D2R = Math.PI / 180;
/** Pixel (x right, y down, centre at (size-1)/2) -> sky. scaleArcsec = arcsec per pixel. */
export function pix2sky(x: number, y: number, size: number, scaleArcsec: number, ra0: number, dec0: number): Sky {
  const c = (size - 1) / 2;
  const xi = -(x - c) * scaleArcsec / 3600 * D2R; // east is left
  const eta = -(y - c) * scaleArcsec / 3600 * D2R; // north is up
  const d0 = dec0 * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return { ra: ra0, dec: dec0 };
  const cc = Math.atan(rho);
  const dec = Math.asin(Math.cos(cc) * Math.sin(d0) + (eta * Math.sin(cc) * Math.cos(d0)) / rho);
  const ra = ra0 * D2R + Math.atan2(xi * Math.sin(cc), rho * Math.cos(d0) * Math.cos(cc) - eta * Math.sin(d0) * Math.sin(cc));
  return { ra: ((ra / D2R) % 360 + 360) % 360, dec: dec / D2R };
}
export function sky2pix(ra: number, dec: number, size: number, scaleArcsec: number, ra0: number, dec0: number): { x: number; y: number } {
  const d = dec * D2R, d0 = dec0 * D2R, dr = (ra - ra0) * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dr);
  const xi = (Math.cos(d) * Math.sin(dr)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dr)) / cosc;
  const c = (size - 1) / 2;
  const k = 3600 / D2R / scaleArcsec;
  return { x: c - xi * k, y: c - eta * k };
}

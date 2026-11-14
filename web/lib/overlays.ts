// TODO(gaia): Gaia proper-motion arrows. Hook for a future overlay layer.
// Plan: query Gaia DR3 (via backend /gaia?ra&dec&fov, not in CONTRACT.md yet) for sources in the field and
// return { ra, dec, pmra, pmdec } per source. Viewer.tsx calls drawOverlays() after the image; draw an arrow
// from each source with length = pm * (years shown) so that "moves but has no arrow" candidates stand out.
export type GaiaSource = { ra: number; dec: number; pmra: number; pmdec: number; gmag?: number };
export async function getGaiaSources(_v: { ra: number; dec: number; fov: number }): Promise<GaiaSource[]> {
  return []; // not implemented
}

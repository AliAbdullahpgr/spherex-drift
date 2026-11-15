export type Target = {
  id: string; name: string; ra: number; dec: number; note?: string; kind?: "mover" | "variable";
  /** [pm_ra*cos(dec), pm_dec] in mas/yr, and the year ra/dec refer to. Only for known movers. */
  pm_mas_yr?: [number, number]; epoch?: number;
};
export type Frame = {
  id: string; survey: "spherex" | "wise"; time: string; mjd: number; detector: number | null;
  wavelength_um: number; pass: number; flags: string[]; image_url: string;
};
export type FramesResponse = {
  ra: number; dec: number; fov: number; frames: Frame[];
  source?: string; note?: string;
  passes: { pass: number; start: string; end: string; n_frames: number }[];
};
export type SpectrumPoint = {
  wavelength_um: number; flux_mjy_sr: number | null; err?: number | null; time?: string; pass: number; detector?: number;
  flags?: string[]; saturated?: boolean;
  /** Brightness of the star's outer halo: the usable measure when the core is saturated. */
  halo_mjy_sr?: number | null;
};
export type SpectrumResponse = { points: SpectrumPoint[] };
export type Img = { w: number; h: number; data: Float32Array };
export type View = { ra: number; dec: number; fov: number };

/**
 * Everything that defines a planet's surface, as plain data. The config travels to the Web
 * Workers with every chunk job (structured clone), so it must not contain classes or functions.
 */
export interface PlanetConfig {
  name: string;
  seed: number;
  /** Sea-level (reference) radius in metres. Terrain heights are relative to it. */
  radius: number;
  /** Time for one full turn about the spin axis (the planet's local +Y), in seconds. */
  rotationPeriod: number;
  /** Tilt of the spin axis, in radians. */
  axialTilt: number;
  /** Surface gravity in m/s^2 (a game parameter, not derived from mass). */
  gravity: number;
  terrain: TerrainShapeConfig;
  colors: TerrainColorConfig;
}

/**
 * The noise layers that add up to the terrain height. "Scale" values are rough feature sizes in
 * metres, "height" values are amplitudes in metres.
 */
export interface TerrainShapeConfig {
  /** Domain warp: offsets the continent lookup to bend coastlines and mountain ranges. */
  warpScale: number;
  warpAmount: number;
  continentScale: number;
  /** Added to the continent noise (about -1..1): positive = more land, negative = more ocean. */
  continentBias: number;
  /** Height of the continent plateau at the top of the noise range. */
  landHeight: number;
  /** Ocean depth at the bottom of the noise range. */
  oceanDepth: number;
  hillScale: number;
  hillHeight: number;
  mountainScale: number;
  mountainHeight: number;
  /** Size of the regions where mountain ranges appear. */
  mountainMaskScale: number;
  detailScale: number;
  detailHeight: number;
}

/** Surface colours as sRGB hex numbers (as in CSS), plus where they apply. */
export interface TerrainColorConfig {
  seabedShallow: number;
  seabedDeep: number;
  beach: number;
  grassLush: number;
  grassDry: number;
  forest: number;
  rock: number;
  snow: number;
  /** Height above which snow appears at the equator; it comes down towards the poles. */
  snowLine: number;
}

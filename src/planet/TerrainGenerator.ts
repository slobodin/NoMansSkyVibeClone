import { SimplexNoise } from '../math/noise';
import type { PlanetConfig, TerrainShapeConfig } from './PlanetConfig';

/**
 * The procedural definition of a planet's surface: height as a pure function of a unit direction
 * in the planet's local frame.
 *
 * "Pure" is the important word. Chunk meshes are generated in Web Workers (chunk.worker.ts) and
 * collision queries run on the main thread; both construct a TerrainGenerator from the same
 * PlanetConfig and therefore agree on every height, with nothing to synchronise.
 *
 * Colours are not decided here but per pixel in the terrain shader (terrainMaterial.ts), from the
 * height, the slope and the latitude - see there for why.
 */
export class TerrainGenerator {
  readonly radius: number;
  private readonly noise: SimplexNoise;
  private readonly shape: TerrainShapeConfig;

  constructor(config: PlanetConfig) {
    this.radius = config.radius;
    this.noise = new SimplexNoise(config.seed);
    this.shape = config.terrain;
  }

  /**
   * Height in metres above sea level for the unit direction (x, y, z).
   *
   * Noise is sampled at dir * radius / featureSize, so one noise unit is about `featureSize` metres
   * on the ground. The layers, from large to small:
   *   continents (domain-warped fBm) -> base height, land vs ocean
   *   hills      (fBm)               -> rolling ground
   *   mountains  (ridged, masked)    -> ranges, only inland where a low-frequency mask allows
   *   detail     (fBm)               -> small bumps for walking scale
   */
  height(x: number, y: number, z: number): number {
    const s = this.shape;
    const n = this.noise;
    const R = this.radius;

    // Domain warp: look the continent noise up at a position displaced by another (smooth)
    // noise field. Coastlines and ranges come out swirled instead of blobby.
    const w = R / s.warpScale;
    const warp = s.warpAmount / s.continentScale;
    const c = R / s.continentScale;
    const cx = x * c + n.fbm(x * w + 31.4, y * w, z * w, 3) * warp;
    const cy = y * c + n.fbm(x * w, y * w + 47.2, z * w, 3) * warp;
    const cz = z * c + n.fbm(x * w, y * w, z * w + 12.9, 3) * warp;
    const continent = n.fbm(cx, cy, cz, 5) + s.continentBias;

    // Base height: a gentle plateau on land, a steeper fall-off under the sea.
    let h = continent >= 0 ? continent * s.landHeight : continent * s.oceanDepth;

    // 0 at the coast, 1 well inland.
    const inland = smoothstep(0, 0.25, continent);

    const hs = R / s.hillScale;
    h += n.fbm(x * hs, y * hs, z * hs, 4) * s.hillHeight * (0.3 + 0.7 * inland);

    const ms = R / s.mountainMaskScale;
    const mask = smoothstep(0.05, 0.45, n.fbm(x * ms + 5.1, y * ms, z * ms, 2) + 0.3 * continent) * inland;
    if (mask > 0) {
      const rs = R / s.mountainScale;
      const ridges = n.ridged(x * rs, y * rs, z * rs, 7);
      h += ridges * ridges * s.mountainHeight * mask;
    }

    const ds = R / s.detailScale;
    h += n.fbm(x * ds, y * ds, z * ds, 3) * s.detailHeight;

    return h;
  }

  /**
   * Low-frequency noise (about -1..1, patches of a few hundred metres) that the shader uses to
   * vary the colours: dry vs lush grass, a jittered snow line, and so on.
   */
  variation(x: number, y: number, z: number): number {
    const vs = this.radius / 350;
    return this.noise.fbm(x * vs + 3.3, y * vs, z * vs, 3);
  }
}

/** Hermite step from 0 (x <= edge0) to 1 (x >= edge1), like GLSL's smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

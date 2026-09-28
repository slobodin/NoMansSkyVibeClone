import { mulberry32 } from './random';

/**
 * Seeded 3D simplex noise (after Stefan Gustavson's public-domain reference implementation) plus
 * the two fractal sums used for terrain: fBm and ridged multifractal.
 *
 * We always sample noise in 3D at points on (a scaled) sphere. Sampling a 2D noise with
 * latitude/longitude would pinch at the poles and seam at the date line; 3D noise has neither.
 *
 * This module has no dependencies on three.js or the DOM so it runs in Web Workers too.
 */

// The 12 gradient directions: midpoints of the edges of a cube.
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1,
  1, 0, 1, -1, 0, -1, -1,
]);
const F3 = 1 / 3; // skew factor: input space -> simplex (skewed cubic) grid
const G3 = 1 / 6; // unskew factor
// Each corner contributes (R2 - d^2)^4 * dot(gradient, d) with radius^2 R2. 0.5 keeps every
// contribution inside its simplex neighbourhood (0.6, used in many copies, leaves tiny seams).
const R2 = 0.5;
// Scales the raw sum to roughly [-1, 1] (measured empirically for R2 = 0.5).
const SCALE = 75;

export class SimplexNoise {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    // A seeded shuffle of 0..255 decides which gradient each lattice point gets.
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    // Doubled so lookups like perm[i + perm[j]] never need a modulo.
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Smooth pseudo-random value in about [-1, 1]; features are roughly 1 unit across. */
  noise(x: number, y: number, z: number): number {
    const perm = this.perm;
    const permMod12 = this.permMod12;

    // Skew the input space to find which simplex cell we are in.
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    // Position relative to the cell origin (unskewed back into input space).
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);

    // A cube cell splits into 6 tetrahedra; the ordering of x0, y0, z0 says which one we are in,
    // i.e. the offsets of the 2nd and 3rd corners (the 1st is (0,0,0), the 4th is (1,1,1)).
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }

    // Offsets of the other three corners.
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    // Gradient index for each corner.
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const g0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
    const g1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
    const g2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
    const g3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;

    // Sum the corner contributions.
    let n = 0;
    let t0 = R2 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g0] * x0 + GRAD3[g0 + 1] * y0 + GRAD3[g0 + 2] * z0);
    }
    let t1 = R2 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g1] * x1 + GRAD3[g1 + 1] * y1 + GRAD3[g1 + 2] * z1);
    }
    let t2 = R2 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g2] * x2 + GRAD3[g2 + 1] * y2 + GRAD3[g2 + 2] * z2);
    }
    let t3 = R2 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g3] * x3 + GRAD3[g3 + 1] * y3 + GRAD3[g3 + 2] * z3);
    }
    return SCALE * n;
  }

  /**
   * Fractional Brownian motion: `octaves` layers of noise, each at `lacunarity` times the
   * frequency and `gain` times the amplitude of the previous one. Result in about [-1, 1].
   */
  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amplitude = 1;
    let frequency = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      // A per-octave offset keeps the octaves from lining up at the origin.
      sum += amplitude * this.noise(x * frequency + o * 19.1, y * frequency, z * frequency - o * 7.3);
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal: 1 - |noise| turns the zero-crossings of the noise into sharp crests
   * (mountain ridges). Each octave is weighted by the previous one, so detail piles up on the
   * ridges while valleys stay smooth. Result in [0, 1].
   */
  ridged(x: number, y: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amplitude = 1;
    let frequency = 1;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x * frequency - o * 11.7, y * frequency + o * 5.9, z * frequency));
      n *= n; // sharpen the crest
      n *= weight;
      weight = Math.min(1, n * 1.5);
      sum += amplitude * n;
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  }
}

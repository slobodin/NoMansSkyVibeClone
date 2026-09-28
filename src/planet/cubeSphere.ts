/**
 * Cube-sphere mapping: the planet surface is the 6 faces of a cube, pushed out onto a sphere.
 *
 * Why not a UV (latitude/longitude) sphere? Its triangles collapse at the poles and its grid is
 * not square. Each cube face, on the other hand, is a plain square grid, so it can be subdivided
 * as a quadtree (see TerrainNode.ts), and there are no poles.
 *
 * A point on a face is addressed by face coordinates (a, b) in [-1, 1]^2. Normalising the cube
 * point directly would crowd vertices towards the face corners (cells there come out ~5x smaller
 * than at the face centre), so we first warp a and b with tan(a * pi/4): equal steps in `a` then
 * cover equal *angles*, and cell sizes stay within ~30% of each other.
 *
 * Pure maths, no three.js: this runs in Web Workers as well as on the main thread.
 */

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

type Vec3 = readonly [number, number, number];

export interface CubeFace {
  /** Outward normal: the face centre is at `normal` on the unit cube. */
  readonly normal: Vec3;
  /** In-face axes for the `a` and `b` coordinates, chosen so that u x v = normal. With that,
   *  a grid laid out along +u then +v is counter-clockwise seen from outside, which is what
   *  three.js treats as the front face. */
  readonly u: Vec3;
  readonly v: Vec3;
}

export const CUBE_FACES: readonly CubeFace[] = [
  { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // +X
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, // -X
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, // +Y
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, // -Y
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, // +Z
  { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }, // -Z
];

const QUARTER_PI = Math.PI / 4;

/** Unit direction (planet-local) for face coordinates (a, b). Writes into and returns `out`. */
export function cubeToSphere<T extends XYZ>(face: number, a: number, b: number, out: T): T {
  const { normal: n, u, v } = CUBE_FACES[face];
  const ta = Math.tan(a * QUARTER_PI);
  const tb = Math.tan(b * QUARTER_PI);
  const x = n[0] + ta * u[0] + tb * v[0];
  const y = n[1] + ta * u[1] + tb * v[1];
  const z = n[2] + ta * u[2] + tb * v[2];
  const invLength = 1 / Math.sqrt(x * x + y * y + z * z);
  out.x = x * invLength;
  out.y = y * invLength;
  out.z = z * invLength;
  return out;
}

/**
 * The square of face coordinates covered by quadtree node (level, x, y): level 0 is the whole
 * face, and every level halves the size. x and y count nodes along +u and +v, from 0.
 */
export function nodeFaceBounds(level: number, x: number, y: number): { a0: number; b0: number; size: number } {
  const size = 2 / 2 ** level;
  return { a0: -1 + x * size, b0: -1 + y * size, size };
}

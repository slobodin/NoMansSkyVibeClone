import { cubeToSphere, nodeFaceBounds, type XYZ } from './cubeSphere';
import type { PlanetConfig } from './PlanetConfig';
import type { TerrainGenerator } from './TerrainGenerator';

/**
 * Builds the vertex data of one terrain chunk (one quadtree node). Runs inside the Web Workers.
 *
 * A chunk is a (N+1) x (N+1) grid of vertices over its patch of a cube face, projected onto the
 * sphere and displaced by the terrain height, plus a "skirt" around the border.
 *
 * SKIRTS: neighbouring chunks can have different LOD levels. Along their shared edge the finer
 * chunk has extra vertices that the coarser one lacks, and wherever those don't lie exactly on
 * the coarse edge a thin crack opens. A skirt is a strip of triangles hanging straight down from
 * each border edge; it fills the crack with terrain-coloured pixels. Cheap and robust.
 *
 * PRECISION: vertex positions are stored relative to the chunk's `center` (planet-local, float64).
 * The positions themselves are float32 but small, so they keep sub-millimetre precision.
 */

/** Quads along each side of a chunk. */
export const CHUNK_RESOLUTION = 32;

const N = CHUNK_RESOLUTION;
/** Vertices along each side of the grid. */
const GRID = N + 1;
/** Samples along each side including a one-sample border, used to get normals right at edges. */
const SAMPLES = N + 3;
/** Grid vertices + one skirt vertex per border vertex. */
export const CHUNK_VERTEX_COUNT = GRID * GRID + 4 * GRID;

export interface ChunkJob {
  id: number;
  planet: PlanetConfig;
  face: number;
  level: number;
  x: number;
  y: number;
}

export interface ChunkMeshData {
  id: number;
  /** Chunk origin in the planet's local frame (a point on the sea-level sphere). */
  center: [number, number, number];
  /** Vertex attributes; positions are relative to `center`. */
  positions: Float32Array;
  normals: Float32Array;
  /** Per vertex: (height above sea level, colour variation, LOD level) - the shader colours from it. */
  surface: Float32Array;
  /** Bounding sphere relative to `center`, for LOD distances and frustum culling. */
  boundsCenter: [number, number, number];
  boundsRadius: number;
}

export function buildChunk(generator: TerrainGenerator, job: ChunkJob): ChunkMeshData {
  const R = generator.radius;
  const { a0, b0, size } = nodeFaceBounds(job.level, job.x, job.y);

  // Chunk origin: the patch centre on the sea-level sphere.
  const dir: XYZ = { x: 0, y: 0, z: 0 };
  cubeToSphere(job.face, a0 + size / 2, b0 + size / 2, dir);
  const cx = dir.x * R;
  const cy = dir.y * R;
  const cz = dir.z * R;

  // 1. Sample the terrain on the grid plus a one-sample border (float64, relative to the centre).
  const sampleCount = SAMPLES * SAMPLES;
  const px = new Float64Array(sampleCount);
  const py = new Float64Array(sampleCount);
  const pz = new Float64Array(sampleCount);
  const dirs = new Float64Array(sampleCount * 3);
  const heights = new Float64Array(sampleCount);
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      const s = j * SAMPLES + i;
      // Sample (i, j) sits at grid position (i - 1, j - 1); the border lies just outside the patch.
      cubeToSphere(job.face, a0 + ((i - 1) / N) * size, b0 + ((j - 1) / N) * size, dir);
      const h = generator.height(dir.x, dir.y, dir.z);
      const r = R + h;
      px[s] = dir.x * r - cx;
      py[s] = dir.y * r - cy;
      pz[s] = dir.z * r - cz;
      dirs[s * 3] = dir.x;
      dirs[s * 3 + 1] = dir.y;
      dirs[s * 3 + 2] = dir.z;
      heights[s] = h;
    }
  }

  const positions = new Float32Array(CHUNK_VERTEX_COUNT * 3);
  const normals = new Float32Array(CHUNK_VERTEX_COUNT * 3);
  const surface = new Float32Array(CHUNK_VERTEX_COUNT * 3);

  // 2. Grid vertices: position, normal (central differences over the neighbouring samples,
  //    which is why we needed the border) and the inputs for the shader's colouring.
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const s = (j + 1) * SAMPLES + (i + 1);
      const v = (j * GRID + i) * 3;
      positions[v] = px[s];
      positions[v + 1] = py[s];
      positions[v + 2] = pz[s];

      // Tangents along +u (s-1 -> s+1) and +v (s-S -> s+S); u x v points outwards.
      const tux = px[s + 1] - px[s - 1];
      const tuy = py[s + 1] - py[s - 1];
      const tuz = pz[s + 1] - pz[s - 1];
      const tvx = px[s + SAMPLES] - px[s - SAMPLES];
      const tvy = py[s + SAMPLES] - py[s - SAMPLES];
      const tvz = pz[s + SAMPLES] - pz[s - SAMPLES];
      let nx = tuy * tvz - tuz * tvy;
      let ny = tuz * tvx - tux * tvz;
      let nz = tux * tvy - tuy * tvx;
      const invLength = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= invLength;
      ny *= invLength;
      nz *= invLength;
      normals[v] = nx;
      normals[v + 1] = ny;
      normals[v + 2] = nz;

      surface[v] = heights[s];
      surface[v + 1] = generator.variation(dirs[s * 3], dirs[s * 3 + 1], dirs[s * 3 + 2]);
      surface[v + 2] = job.level; // only used by the LOD debug view
    }
  }

  // 3. Skirts: a copy of every border vertex, pushed down towards the planet centre.
  //    Deep enough to cover the largest crack a coarser neighbour can leave (a few grid cells).
  const cellSize = (R * (Math.PI / 2) * size) / 2 / N; // approximate arc length of one cell
  const skirtDepth = cellSize * 3 + 2;
  let k = GRID * GRID;
  for (const edge of BORDER_LOOP) {
    for (const g of edge) {
      const v = g * 3;
      const s = (Math.floor(g / GRID) + 1) * SAMPLES + (g % GRID) + 1;
      const o = k * 3;
      positions[o] = positions[v] - dirs[s * 3] * skirtDepth;
      positions[o + 1] = positions[v + 1] - dirs[s * 3 + 1] * skirtDepth;
      positions[o + 2] = positions[v + 2] - dirs[s * 3 + 2] * skirtDepth;
      normals[o] = normals[v];
      normals[o + 1] = normals[v + 1];
      normals[o + 2] = normals[v + 2];
      surface[o] = surface[v];
      surface[o + 1] = surface[v + 1];
      surface[o + 2] = surface[v + 2];
      k++;
    }
  }

  // 4. Bounding sphere (relative to the centre): box midpoint + farthest vertex.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < positions.length; v += 3) {
    minX = Math.min(minX, positions[v]);
    maxX = Math.max(maxX, positions[v]);
    minY = Math.min(minY, positions[v + 1]);
    maxY = Math.max(maxY, positions[v + 1]);
    minZ = Math.min(minZ, positions[v + 2]);
    maxZ = Math.max(maxZ, positions[v + 2]);
  }
  const bx = (minX + maxX) / 2;
  const by = (minY + maxY) / 2;
  const bz = (minZ + maxZ) / 2;
  let radiusSq = 0;
  for (let v = 0; v < positions.length; v += 3) {
    const ex = positions[v] - bx;
    const ey = positions[v + 1] - by;
    const ez = positions[v + 2] - bz;
    radiusSq = Math.max(radiusSq, ex * ex + ey * ey + ez * ez);
  }

  return {
    id: job.id,
    center: [cx, cy, cz],
    positions,
    normals,
    surface,
    boundsCenter: [bx, by, bz],
    boundsRadius: Math.sqrt(radiusSq),
  };
}

/**
 * The border of the grid as four runs of grid-vertex indices, walking counter-clockwise when
 * seen from outside the planet (so the chunk interior is always on the left). Walking every edge
 * the same way lets one triangle pattern give all four skirts outward-facing triangles.
 */
const BORDER_LOOP: number[][] = (() => {
  const bottom: number[] = [];
  const right: number[] = [];
  const top: number[] = [];
  const left: number[] = [];
  for (let t = 0; t < GRID; t++) {
    bottom.push(t); //                         (t, 0)       along +u
    right.push(t * GRID + N); //               (N, t)       along +v
    top.push(N * GRID + (N - t)); //           (N - t, N)   along -u
    left.push((N - t) * GRID); //              (0, N - t)   along -v
  }
  return [bottom, right, top, left];
})();

/**
 * Triangle indices, identical for every chunk (only the vertex data differs), so they are built
 * once and shared. Two triangles per grid quad, then two per skirt segment.
 */
export function buildChunkIndices(): Uint16Array {
  const indices: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v00 = j * GRID + i;
      const v10 = v00 + 1;
      const v01 = v00 + GRID;
      const v11 = v01 + 1;
      // Counter-clockwise seen from outside (u to the right, v up).
      indices.push(v00, v10, v11, v00, v11, v01);
    }
  }
  let skirtStart = GRID * GRID;
  for (const edge of BORDER_LOOP) {
    for (let t = 0; t < N; t++) {
      const top0 = edge[t];
      const top1 = edge[t + 1];
      const bottom0 = skirtStart + t;
      const bottom1 = skirtStart + t + 1;
      // Seen from outside the chunk, top0 is top-left and top1 top-right: counter-clockwise.
      indices.push(top0, bottom0, bottom1, top0, bottom1, top1);
    }
    skirtStart += GRID;
  }
  return new Uint16Array(indices);
}

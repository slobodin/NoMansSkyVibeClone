import * as THREE from 'three';
import type { ChunkRequest } from './ChunkWorkerPool';
import { cubeToSphere, nodeFaceBounds } from './cubeSphere';

/**
 * One node of a cube-face quadtree = one terrain chunk.
 *
 * Level 0 covers a whole cube face; each level splits a node into 4 children covering its
 * quarters, so a level-L node is 1/2^L of a face across. (face, level, x, y) addresses a node.
 *
 * Every node owns a mesh. A node that has children keeps its own mesh (hidden): it is drawn
 * while the children are still being built, and again the instant they are merged away.
 */
export class TerrainNode {
  /** Approximate edge length of the node's patch in metres - the LOD metric. */
  readonly size: number;
  /** Bounding sphere in the planet frame: approximate until the mesh arrives, exact after. */
  readonly boundsCenter = new THREE.Vector3();
  boundsRadius: number;

  children: TerrainNode[] | null = null;
  mesh: THREE.Mesh | null = null;
  /** The in-flight build, if any. */
  request: ChunkRequest | null = null;
  /** Set when the node was removed from the tree (late worker results are then dropped). */
  disposed = false;

  constructor(
    readonly face: number,
    readonly level: number,
    readonly x: number,
    readonly y: number,
    private readonly planetRadius: number,
  ) {
    this.size = (planetRadius * (Math.PI / 2)) / 2 ** level;
    const { a0, b0, size } = nodeFaceBounds(level, x, y);
    cubeToSphere(face, a0 + size / 2, b0 + size / 2, this.boundsCenter).multiplyScalar(planetRadius);
    this.boundsRadius = this.size * 0.75; // about half the patch diagonal
  }

  /** Distance from a planet-local point to the node's bounding sphere (0 inside it). */
  distanceTo(point: THREE.Vector3): number {
    return Math.max(0, point.distanceTo(this.boundsCenter) - this.boundsRadius);
  }

  /** The four quarter-size children, in the order (0,0) (1,0) (0,1) (1,1). */
  createChildren(): TerrainNode[] {
    const level = this.level + 1;
    const x = this.x * 2;
    const y = this.y * 2;
    return [
      new TerrainNode(this.face, level, x, y, this.planetRadius),
      new TerrainNode(this.face, level, x + 1, y, this.planetRadius),
      new TerrainNode(this.face, level, x, y + 1, this.planetRadius),
      new TerrainNode(this.face, level, x + 1, y + 1, this.planetRadius),
    ];
  }
}

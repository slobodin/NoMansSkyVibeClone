import * as THREE from 'three';
import { buildChunkIndices, CHUNK_RESOLUTION, type ChunkMeshData } from './chunkBuilder';
import type { ChunkWorkerPool } from './ChunkWorkerPool';
import type { PlanetConfig } from './PlanetConfig';
import { TerrainNode } from './TerrainNode';

/** Split a node when the camera is closer than this many node sizes... */
const SPLIT_DISTANCE = 1.5;
/** ...and merge its children again only beyond this many (the gap prevents flip-flopping). */
const MERGE_DISTANCE = 1.8;
/** Vertex spacing of the finest level, in metres. Decides how deep the quadtrees go. */
const FINEST_VERTEX_SPACING = 1;
/** At most this many finished chunks become meshes per frame (smooths out upload spikes). */
const MAX_NEW_MESHES_PER_FRAME = 16;

/**
 * Quadtree level-of-detail terrain for one planet: 6 quadtrees, one per cube face.
 *
 * Every frame, given the camera position in the planet's frame:
 *   1. finished worker results become meshes,
 *   2. each tree is walked from the root: a node splits into 4 children when the camera is
 *      closer than SPLIT_DISTANCE x its size, and merges them back when farther than
 *      MERGE_DISTANCE x its size. Nodes without a mesh request one from the worker pool.
 *      So near the camera the chunks get small (dense vertices) and far away they stay big,
 *      keeping the on-screen size of triangles roughly constant.
 *   3. visibility: draw the deepest nodes whose meshes are ready. A node whose children are not
 *      all ready is drawn itself instead, so the surface never has holes while streaming.
 */
export class Terrain {
  readonly group = new THREE.Group();
  readonly maxLevel: number;
  readonly stats = { meshes: 0, visible: 0, deepestVisible: 0, triangles: 0 };

  private readonly roots: TerrainNode[] = [];
  private readonly indices = buildChunkIndices();
  private readonly finished: { node: TerrainNode; data: ChunkMeshData }[] = [];

  constructor(
    private readonly config: PlanetConfig,
    private readonly pool: ChunkWorkerPool,
    private readonly material: THREE.Material,
  ) {
    this.group.name = `${config.name}-terrain`;
    // Level L has 2^L * CHUNK_RESOLUTION cells along a face edge of length radius * pi/2.
    const faceEdge = config.radius * (Math.PI / 2);
    this.maxLevel = Math.ceil(Math.log2(faceEdge / (CHUNK_RESOLUTION * FINEST_VERTEX_SPACING)));
    for (let face = 0; face < 6; face++) {
      this.roots.push(new TerrainNode(face, 0, 0, 0, config.radius));
    }
  }

  /** Is anything still being built or waiting to be turned into a mesh? */
  get busy(): boolean {
    return this.finished.length > 0 || this.pool.queuedCount > 0 || this.pool.runningCount > 0;
  }

  /** Call once per frame with the camera position in the planet's local frame. */
  update(camera: THREE.Vector3): void {
    this.createMeshes();
    for (const root of this.roots) this.updateNode(root, camera);
    for (const root of this.roots) this.updateVisibility(root);
    this.pool.dispatch();
    this.updateStats();
  }

  // --- 1. results -> meshes -----------------------------------------------------------------------

  private createMeshes(): void {
    let budget = MAX_NEW_MESHES_PER_FRAME;
    while (budget > 0 && this.finished.length > 0) {
      const { node, data } = this.finished.shift()!;
      if (node.disposed) continue;
      this.createMesh(node, data);
      budget--;
    }
  }

  private createMesh(node: TerrainNode, data: ChunkMeshData): void {
    const geometry = new THREE.BufferGeometry();
    // All chunks share one index *array*, but each gets its own BufferAttribute: three.js frees
    // an attribute's GPU buffer when a geometry using it is disposed.
    geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('surface', new THREE.BufferAttribute(data.surface, 3));
    const boundsCenter = new THREE.Vector3().fromArray(data.boundsCenter);
    geometry.boundingSphere = new THREE.Sphere(boundsCenter, data.boundsRadius); // for frustum culling

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `chunk ${node.face}/${node.level}/${node.x},${node.y}`;
    mesh.userData.level = node.level;
    mesh.position.fromArray(data.center);
    mesh.matrixAutoUpdate = false; // chunks never move within the planet
    mesh.updateMatrix();
    mesh.visible = false;
    this.group.add(mesh);

    node.mesh = mesh;
    node.request = null;
    node.boundsCenter.fromArray(data.center).add(boundsCenter);
    node.boundsRadius = data.boundsRadius;
  }

  // --- 2. split / merge -----------------------------------------------------------------------------

  private updateNode(node: TerrainNode, camera: THREE.Vector3): void {
    const distance = node.distanceTo(camera);

    if (!node.mesh && !node.request) {
      node.request = this.pool.request(
        { planet: this.config, face: node.face, level: node.level, x: node.x, y: node.y },
        distance,
        (data) => this.finished.push({ node, data }),
      );
    } else if (node.request) {
      node.request.priority = distance; // the camera moved: nearest chunks first
    }

    const threshold = (node.children ? MERGE_DISTANCE : SPLIT_DISTANCE) * node.size;
    const wantsChildren = node.level < this.maxLevel && distance < threshold;

    // Only split nodes whose own mesh exists: it is the fallback while the children build.
    if (wantsChildren && node.mesh) {
      node.children ??= node.createChildren();
      for (const child of node.children) this.updateNode(child, camera);
    } else if (!wantsChildren && node.children) {
      for (const child of node.children) this.dispose(child);
      node.children = null;
    }
  }

  private dispose(node: TerrainNode): void {
    if (node.children) for (const child of node.children) this.dispose(child);
    node.children = null;
    if (node.request) this.pool.cancel(node.request);
    node.request = null;
    if (node.mesh) {
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh = null;
    }
    node.disposed = true;
  }

  // --- 3. visibility ------------------------------------------------------------------------------

  /** Shows the finest ready meshes under `node`. Returns false if its area can't be drawn yet. */
  private updateVisibility(node: TerrainNode): boolean {
    if (node.children) {
      let childrenReady = true;
      for (const child of node.children) {
        childrenReady = this.updateVisibility(child) && childrenReady;
      }
      if (childrenReady) {
        node.mesh!.visible = false;
        return true;
      }
      // Some child is still building: draw this node instead of an incomplete set of children.
      for (const child of node.children) this.hide(child);
    }
    if (!node.mesh) return false;
    node.mesh.visible = true;
    return true;
  }

  private hide(node: TerrainNode): void {
    if (node.mesh) node.mesh.visible = false;
    if (node.children) for (const child of node.children) this.hide(child);
  }

  private updateStats(): void {
    let visible = 0;
    let deepest = 0;
    for (const mesh of this.group.children) {
      if (!mesh.visible) continue;
      visible++;
      deepest = Math.max(deepest, mesh.userData.level as number);
    }
    this.stats.meshes = this.group.children.length;
    this.stats.visible = visible;
    this.stats.deepestVisible = deepest;
    this.stats.triangles = (visible * this.indices.length) / 3;
  }
}

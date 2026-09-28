import * as THREE from 'three';
import type { ChunkWorkerPool } from './ChunkWorkerPool';
import type { PlanetConfig } from './PlanetConfig';
import { Terrain } from './Terrain';
import { TerrainGenerator } from './TerrainGenerator';
import { createTerrainMaterial } from './terrainMaterial';

/**
 * A planet in the scene: its terrain, and conversions between universe space and the planet's
 * own *local frame* (origin at the planet centre, axes fixed to the ground). Terrain chunks,
 * and later the player standing on the surface, live in the local frame; when the planet moves
 * or spins only `group`'s transform changes.
 */
export class Planet {
  /** Origin at the planet centre; position/rotation place the local frame in the universe. */
  readonly group = new THREE.Group();
  readonly generator: TerrainGenerator;
  readonly terrain: Terrain;
  readonly material: THREE.ShaderMaterial;

  private readonly tmp = new THREE.Vector3();
  private readonly inverseRotation = new THREE.Quaternion();
  private readonly rotation = new THREE.Matrix4();

  constructor(
    readonly config: PlanetConfig,
    position: THREE.Vector3,
    pool: ChunkWorkerPool,
  ) {
    this.group.name = config.name;
    this.group.position.copy(position);
    this.generator = new TerrainGenerator(config);
    this.material = createTerrainMaterial(config);
    this.terrain = new Terrain(config, pool, this.material);
    this.group.add(this.terrain.group);
  }

  get radius(): number {
    return this.config.radius;
  }

  /** Planet centre in universe coordinates. */
  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Universe position -> planet-local position. */
  toLocal(universePosition: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    this.inverseRotation.copy(this.group.quaternion).invert();
    return out.copy(universePosition).sub(this.group.position).applyQuaternion(this.inverseRotation);
  }

  /** Planet-local position -> universe position. */
  toUniverse(localPosition: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(localPosition).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  /** Terrain height above sea level straight below (or above) a planet-local position. */
  terrainHeight(localPosition: THREE.Vector3): number {
    const dir = this.tmp.copy(localPosition).normalize();
    return this.generator.height(dir.x, dir.y, dir.z);
  }

  /** Height of a universe position above the terrain surface. */
  altitude(universePosition: THREE.Vector3): number {
    const local = this.toLocal(universePosition, new THREE.Vector3());
    return local.length() - (this.radius + this.terrainHeight(local));
  }

  /** Terrain debug view: 0 = normal, 1 = colour by LOD level, 2 = LOD colours + wireframe. */
  setDebugView(mode: number): void {
    this.material.uniforms.uDebugLod.value = mode >= 1;
    this.material.wireframe = mode === 2;
  }

  /** Once per frame: stream terrain around the camera and refresh shader uniforms. */
  update(cameraPosition: THREE.Vector3, sunDirection: THREE.Vector3): void {
    this.terrain.update(this.toLocal(cameraPosition, this.tmp));
    const uniforms = this.material.uniforms;
    uniforms.uSunDirection.value.copy(sunDirection);
    // World space is camera-relative, so the centre in world space is position - camera.
    uniforms.uPlanetCenter.value.copy(this.group.position).sub(cameraPosition);
    // The inverse of a rotation matrix is its transpose.
    this.rotation.makeRotationFromQuaternion(this.group.quaternion);
    uniforms.uWorldToPlanet.value.setFromMatrix4(this.rotation).transpose();
  }
}

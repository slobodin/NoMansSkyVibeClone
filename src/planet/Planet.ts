import * as THREE from 'three';
import { positionToFrame, positionToUniverse, type ReferenceFrame } from '../core/ReferenceFrame';
import { createAtmosphereUniforms, type AtmosphereUniforms } from '../render/atmosphere';
import { createOceanUniforms, type OceanUniforms } from '../render/ocean';
import type { ChunkWorkerPool } from './ChunkWorkerPool';
import type { PlanetConfig } from './PlanetConfig';
import { Terrain } from './Terrain';
import { TerrainGenerator } from './TerrainGenerator';
import { createTerrainMaterial } from './terrainMaterial';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * A planet in the scene: its terrain, its spin, and its *local frame* (origin at the planet
 * centre, axes fixed to the ground, spin axis = local +Y).
 *
 * Planet is a ReferenceFrame: terrain chunks, the player and a camera hovering near the ground
 * all live in its local frame. Spinning the planet is just updating `group.quaternion`; everything
 * in the frame turns with it, which is what makes the sun rise and set.
 */
export class Planet implements ReferenceFrame {
  /** Origin at the planet centre; position/rotation place the local frame in the universe. */
  readonly group = new THREE.Group();
  readonly generator: TerrainGenerator;
  readonly terrain: Terrain;
  readonly material: THREE.ShaderMaterial;
  /** Shader uniforms describing this planet's atmosphere, shared by the terrain and the sky. */
  readonly atmosphere: AtmosphereUniforms;
  /** Shader uniforms for the ocean (drawn by the composite pass). */
  readonly ocean: OceanUniforms;
  /** Spin angle at time 0 (radians). Chosen at start-up to pick the time of day. */
  spinPhase = 0;

  private readonly tilt: THREE.Quaternion;
  private readonly spin = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly rotation = new THREE.Matrix4();

  constructor(
    readonly config: PlanetConfig,
    position: THREE.Vector3,
    pool: ChunkWorkerPool,
    sunIntensity: THREE.Vector3,
  ) {
    this.group.name = config.name;
    this.group.position.copy(position);
    this.tilt = new THREE.Quaternion().setFromAxisAngle(X_AXIS, config.axialTilt);
    this.generator = new TerrainGenerator(config);
    this.atmosphere = createAtmosphereUniforms(config, sunIntensity);
    this.ocean = createOceanUniforms(config);
    this.material = createTerrainMaterial(config, this.atmosphere);
    this.terrain = new Terrain(config, pool, this.material);
    this.group.add(this.terrain.group);
  }

  get name(): string {
    return this.config.name;
  }

  get radius(): number {
    return this.config.radius;
  }

  /** Planet centre in universe coordinates (ReferenceFrame). */
  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Rotation of the local frame relative to the universe axes (ReferenceFrame). */
  get quaternion(): THREE.Quaternion {
    return this.group.quaternion;
  }

  /**
   * Turns the planet to where it is at game time `time`: first spin about the local +Y axis,
   * then tilt that axis. (Quaternions compose right to left: q = tilt * spin.)
   */
  updateSpin(time: number): void {
    const angle = this.spinPhase + (2 * Math.PI * time) / this.config.rotationPeriod;
    this.spin.setFromAxisAngle(Y_AXIS, angle);
    this.group.quaternion.copy(this.tilt).multiply(this.spin);
  }

  /** Universe position -> planet-local position. */
  toLocal(universePosition: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return positionToFrame(this, universePosition, out);
  }

  /** Planet-local position -> universe position. */
  toUniverse(localPosition: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return positionToUniverse(this, localPosition, out);
  }

  /** Terrain height above sea level straight below (or above) a planet-local position. */
  terrainHeight(localPosition: THREE.Vector3): number {
    const dir = this.tmp.copy(localPosition).normalize();
    return this.generator.height(dir.x, dir.y, dir.z);
  }

  /** Height of a planet-local position above the terrain surface. */
  altitudeOfLocal(localPosition: THREE.Vector3): number {
    return localPosition.length() - (this.radius + this.terrainHeight(localPosition));
  }

  /** Height of a universe position above the terrain surface. */
  altitude(universePosition: THREE.Vector3): number {
    return this.altitudeOfLocal(this.toLocal(universePosition, new THREE.Vector3()));
  }

  /** Terrain debug view: 0 = normal, 1 = colour by LOD level, 2 = LOD colours + wireframe. */
  setDebugView(mode: number): void {
    this.material.uniforms.uDebugLod.value = mode >= 1;
    this.material.wireframe = mode === 2;
  }

  /** Once per frame, after updateSpin: stream terrain around the camera, refresh uniforms. */
  update(cameraPosition: THREE.Vector3, sunDirection: THREE.Vector3): void {
    this.terrain.update(this.toLocal(cameraPosition, this.tmp));
    this.atmosphere.uSunDirection.value.copy(sunDirection);
    // World space is camera-relative, so the centre in world space is position - camera.
    this.atmosphere.uPlanetCenter.value.copy(this.group.position).sub(cameraPosition);
    const uniforms = this.material.uniforms;
    // The inverse of a rotation matrix is its transpose.
    this.rotation.makeRotationFromQuaternion(this.group.quaternion);
    uniforms.uWorldToPlanet.value.setFromMatrix4(this.rotation).transpose();
    this.ocean.uWorldToPlanet.value.copy(uniforms.uWorldToPlanet.value);
  }
}

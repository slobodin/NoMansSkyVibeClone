import * as THREE from 'three';
import { positionToFrame, positionToUniverse, type ReferenceFrame } from '../core/ReferenceFrame';
import { createAtmosphereParams, type AtmosphereParams } from '../render/atmosphere';
import { createOceanUniforms, type OceanUniforms } from '../render/ocean';
import { orbitOffset } from '../world/orbit';
import type { ChunkWorkerPool } from './ChunkWorkerPool';
import type { PlanetConfig } from './PlanetConfig';
import { Terrain } from './Terrain';
import { TerrainGenerator } from './TerrainGenerator';
import { createTerrainMaterial } from './terrainMaterial';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * A planet or moon: its terrain, its orbit and spin, and its *local frame* (origin at the
 * centre, axes fixed to the ground, spin axis = local +Y).
 *
 * Planet is a ReferenceFrame: terrain chunks, the player and a camera hovering near the ground
 * all live in its local frame. Moving and spinning the planet is just updating `group`'s
 * position and quaternion; everything in the frame goes along, which is what makes the sun rise
 * and set. It also offers `inertialFrame`, which follows the planet around its orbit but does
 * not turn with it - the natural frame for flying around a planet in space.
 */
export class Planet implements ReferenceFrame {
  /** Origin at the planet centre; position/rotation place the local frame in the universe. */
  readonly group = new THREE.Group();
  readonly generator: TerrainGenerator;
  readonly terrain: Terrain;
  readonly material: THREE.ShaderMaterial;
  /** This planet's air, as uploaded to shaders (shared by its terrain and the composite pass). */
  readonly atmosphere: AtmosphereParams;
  /** Ocean uniforms; only meaningful if the config has an ocean. */
  readonly ocean: OceanUniforms;
  /** Moves with the planet, but its axes stay parallel to the universe's: no spin. */
  readonly inertialFrame: ReferenceFrame;
  /** The body this one orbits, or null for the star. Set by SolarSystem. */
  parent: Planet | null = null;
  /** Unit vector from the centre towards the star, universe axes. Set by SolarSystem. */
  readonly sunDirection = new THREE.Vector3(1, 0, 0);
  /** Spin angle at time 0 (radians). Chosen at start-up to pick the time of day. */
  spinPhase = 0;

  private readonly tilt: THREE.Quaternion;
  private readonly spin = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly rotation = new THREE.Matrix4();

  constructor(
    readonly config: PlanetConfig,
    pool: ChunkWorkerPool,
    sunIntensity: THREE.Vector3,
  ) {
    this.group.name = config.name;
    this.tilt = new THREE.Quaternion().setFromAxisAngle(X_AXIS, config.axialTilt);
    this.generator = new TerrainGenerator(config);
    this.atmosphere = createAtmosphereParams(config, sunIntensity);
    this.ocean = createOceanUniforms(config, this.atmosphere);
    this.material = createTerrainMaterial(config, this.atmosphere);
    this.terrain = new Terrain(config, pool, this.material);
    this.group.add(this.terrain.group);
    this.inertialFrame = {
      name: `${config.name} orbit`,
      position: this.group.position, // the same Vector3: always where the planet is
      quaternion: new THREE.Quaternion(),
    };
  }

  get name(): string {
    return this.config.name;
  }

  get radius(): number {
    return this.config.radius;
  }

  get hasOcean(): boolean {
    return this.config.ocean !== undefined;
  }

  /** Planet centre in universe coordinates (ReferenceFrame). */
  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Rotation of the local frame relative to the universe axes (ReferenceFrame). */
  get quaternion(): THREE.Quaternion {
    return this.group.quaternion;
  }

  /** Moves the planet to where its orbit puts it at game time `time`. */
  updateOrbit(time: number, parentPosition: THREE.Vector3): void {
    orbitOffset(this.config.orbit, time, this.group.position).add(parentPosition);
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

  /** Once per frame, after orbits and spins: stream terrain around the camera, refresh uniforms. */
  update(cameraPosition: THREE.Vector3): void {
    this.terrain.update(this.toLocal(cameraPosition, this.tmp));
    this.atmosphere.sunDirection.copy(this.sunDirection);
    // World space is camera-relative, so the centre in world space is position - camera.
    this.atmosphere.center.copy(this.group.position).sub(cameraPosition);
    // The inverse of a rotation matrix is its transpose.
    this.rotation.makeRotationFromQuaternion(this.group.quaternion);
    const worldToPlanet = this.material.uniforms.uWorldToPlanet.value as THREE.Matrix3;
    worldToPlanet.setFromMatrix4(this.rotation).transpose();
    this.ocean.uWorldToPlanet.value.copy(worldToPlanet);
  }
}

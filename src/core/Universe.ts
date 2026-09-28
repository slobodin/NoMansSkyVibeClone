import * as THREE from 'three';

/**
 * The scene graph, organised for camera-relative rendering (a.k.a. "floating origin").
 *
 * THE PROBLEM
 * The GPU works in float32, which has a 24-bit mantissa. 500 km from the origin the gap between two
 * representable float32 numbers is ~3 cm. Any large number that reaches the GPU - a vertex position,
 * a model matrix, the camera position, a world-space position computed in a shader - gets rounded
 * to that grid, and things visibly jitter as the camera moves. A star system is a few hundred km
 * across, so this matters.
 *
 * THE FIX
 * All universe positions are JS numbers (float64: ~1e-10 m resolution at 500 km) and they never
 * reach the GPU directly. Every frame:
 *   1. the camera is put at the scene origin; only its rotation is set,
 *   2. `root` - the parent of everything that has a universe position - is moved by -cameraPosition.
 * three.js multiplies the chain root -> planet -> terrain chunk in float64 on the CPU, so every
 * matrix it uploads holds a camera-relative translation: a small number, where float32 is precise.
 * (three.js already builds modelViewMatrix in float64, which alone fixes the vertex projection.
 * The floating origin also makes *world space* camera-relative, so modelMatrix, cameraPosition and
 * all the world-space maths in our shaders - lighting, atmosphere, ocean - stay precise as well.)
 *
 * SCENE LAYOUT
 *   scene
 *   ├── sky    objects at "infinity" that move with the camera (starfield): never offset
 *   ├── root   universe-space objects (planets, test beacons, later ships...), offset by -camera
 *   └── lights directional lights only need a direction, so they live outside `root`
 */
export class Universe {
  readonly scene = new THREE.Scene();
  readonly sky = new THREE.Group();
  readonly root = new THREE.Group();

  /** Where the camera is, in universe coordinates (float64). Updated by `placeCamera`. */
  readonly cameraPosition = new THREE.Vector3();

  constructor() {
    this.sky.name = 'sky';
    this.root.name = 'universe-root';
    this.scene.add(this.sky, this.root);
  }

  /** Puts the camera at universe `position` with world `orientation` - by moving the universe. */
  placeCamera(camera: THREE.Camera, position: THREE.Vector3, orientation: THREE.Quaternion): void {
    this.cameraPosition.copy(position);
    camera.position.set(0, 0, 0);
    camera.quaternion.copy(orientation);
    this.root.position.copy(position).negate();
  }

  /** Converts a universe position to scene (= camera-relative) coordinates. */
  toScene(universePos: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(universePos).sub(this.cameraPosition);
  }
}

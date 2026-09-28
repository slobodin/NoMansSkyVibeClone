import * as THREE from 'three';
import type { Input } from '../core/Input';

const LOOK_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
const ROLL_SPEED = 1.5; // radians per second (Q / E)
const MIN_SPEED = 2; // m/s, so you can still creep along the ground
const MAX_SPEED = 200_000; // m/s
const BOOST = 5; // Shift multiplier
const RESPONSIVENESS = 6; // 1/s, how quickly velocity follows the keys (higher = snappier)

/**
 * Debug "spectator" camera with 6 degrees of freedom - the way we get around until the game has
 * a player and a ship.
 *
 * Its pose is in universe coordinates (float64 via JS numbers). The game copies the pose into the
 * camera through `Universe.placeCamera` every frame.
 *
 * Speed is proportional to the distance to the nearest surface: every second covers the same
 * *fraction* of the remaining distance, so crossing 500 km of space and creeping over grass feel
 * the same, and flying straight at a planet approaches it asymptotically instead of crashing.
 */
export class FreeFlyController {
  readonly position = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  /** Mouse wheel tweak: the automatic speed is multiplied by 2^speedExponent. */
  speedExponent = 0;

  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly wish = new THREE.Vector3();

  update(dt: number, input: Input, surfaceDistance: number): void {
    // Rotation happens in the camera's own frame (there is no "up" in space). Mouse right = yaw
    // right = negative rotation about the camera's +Y; mouse down = pitch down = negative about +X.
    const yaw = -input.mouseDX * LOOK_SENSITIVITY;
    const pitch = -input.mouseDY * LOOK_SENSITIVITY;
    const roll = input.axis('KeyE', 'KeyQ') * ROLL_SPEED * dt;
    this.tmpQuat.setFromEuler(this.tmpEuler.set(pitch, yaw, roll, 'YXZ'));
    this.orientation.multiply(this.tmpQuat).normalize();

    this.speedExponent = THREE.MathUtils.clamp(this.speedExponent - input.wheelSteps, -6, 8);

    // Desired velocity in camera space (three.js cameras look down -Z), then rotated to world.
    const speed = this.cruiseSpeed(surfaceDistance) * (input.isDown('ShiftLeft') ? BOOST : 1);
    this.wish
      .set(input.axis('KeyA', 'KeyD'), input.axis('KeyC', 'Space'), input.axis('KeyW', 'KeyS'))
      .normalize()
      .applyQuaternion(this.orientation)
      .multiplyScalar(speed);

    // Exponential smoothing: frame-rate independent "velocity chases the wish".
    const blend = 1 - Math.exp(-RESPONSIVENESS * dt);
    this.velocity.lerp(this.wish, blend);
    this.position.addScaledVector(this.velocity, dt);
  }

  /** Current top speed (m/s) for a given distance to the nearest surface. */
  cruiseSpeed(surfaceDistance: number): number {
    return THREE.MathUtils.clamp(surfaceDistance, MIN_SPEED, MAX_SPEED) * 2 ** this.speedExponent;
  }

  /** Teleports to `eye`, looking at `target`. */
  set(eye: THREE.Vector3, target: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)): void {
    this.position.copy(eye);
    this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, target, up));
    this.velocity.set(0, 0, 0);
  }
}

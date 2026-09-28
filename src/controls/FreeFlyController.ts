import * as THREE from 'three';
import type { Input } from '../core/Input';

const LOOK_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
const ROLL_SPEED = 1.5; // radians per second (Q / E)
const MIN_SPEED = 2; // m/s, so you can still creep along the ground
const MAX_SPEED = 200_000; // m/s
const BOOST = 5; // Shift multiplier
const RESPONSIVENESS = 6; // 1/s, how quickly velocity follows the keys (higher = snappier)
const LEVELING_RATE = 2; // 1/s, how quickly the horizon is levelled near a planet

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
  private readonly forward = new THREE.Vector3();
  private readonly cameraUp = new THREE.Vector3();
  private readonly levelUp = new THREE.Vector3();
  private readonly cross = new THREE.Vector3();

  /**
   * @param surfaceDistance distance to the nearest surface, sets the speed
   * @param up local vertical when near a planet: the camera then slowly rolls to keep the
   *           horizon level (unless you are rolling with Q/E yourself)
   */
  update(dt: number, input: Input, surfaceDistance: number, up: THREE.Vector3 | null = null): void {
    // Rotation happens in the camera's own frame (there is no "up" in space). Mouse right = yaw
    // right = negative rotation about the camera's +Y; mouse down = pitch down = negative about +X.
    const yaw = -input.mouseDX * LOOK_SENSITIVITY;
    const pitch = -input.mouseDY * LOOK_SENSITIVITY;
    const rollInput = input.axis('KeyE', 'KeyQ');
    const roll = rollInput * ROLL_SPEED * dt;
    this.tmpQuat.setFromEuler(this.tmpEuler.set(pitch, yaw, roll, 'YXZ'));
    this.orientation.multiply(this.tmpQuat).normalize();
    if (up && rollInput === 0) this.levelHorizon(up, dt);

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

  /**
   * Rolls the camera about its view axis so that its up vector leans towards `up`. We only touch
   * roll, never where the camera points, so it feels like a gentle auto-pilot for the horizon.
   */
  private levelHorizon(up: THREE.Vector3, dt: number): void {
    const forward = this.forward.set(0, 0, -1).applyQuaternion(this.orientation);
    const cameraUp = this.cameraUp.set(0, 1, 0).applyQuaternion(this.orientation);
    // Target: the planet's up, with the part along the view direction removed.
    const target = this.levelUp.copy(up).addScaledVector(forward, -up.dot(forward));
    if (target.lengthSq() < 1e-4) return; // looking straight up or down: roll is undefined
    target.normalize();
    // Signed angle from cameraUp to target, measured around the forward axis.
    const angle = Math.atan2(forward.dot(this.cross.crossVectors(cameraUp, target)), cameraUp.dot(target));
    const step = angle * (1 - Math.exp(-LEVELING_RATE * dt));
    // A rotation about a world-space axis is applied from the left (premultiply).
    this.orientation.premultiply(this.tmpQuat.setFromAxisAngle(forward, step)).normalize();
  }

  /** Teleports to `eye`, looking at `target`. */
  set(eye: THREE.Vector3, target: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)): void {
    this.position.copy(eye);
    this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, target, up));
    this.velocity.set(0, 0, 0);
  }
}

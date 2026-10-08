import * as THREE from 'three';

/**
 * A coordinate frame that moves and rotates within the universe.
 *
 * Anything that "belongs to" a planet - the player, a camera hovering over the ground, a landed
 * ship - stores its pose in that planet's frame. When the planet spins, they spin with it
 * without a single extra line of code; we only convert to universe coordinates for rendering.
 * The universe itself is simply the frame with no offset and no rotation.
 *
 * Conversions (p = position, q = orientation, v = velocity; R = frame rotation, O = frame origin,
 * V = velocity of the origin, w = angular velocity):
 *   universe p = O + R * local p
 *   universe q = R * local q
 *   universe v = V + w x (R * local p) + R * local v
 * The velocity rule is the one from mechanics: something at rest in a spinning frame still moves
 * through the universe, faster the farther it is from the axis.
 */
export interface ReferenceFrame {
  readonly name: string;
  /** Frame origin in universe coordinates, at the current time. */
  readonly position: THREE.Vector3;
  /** Frame rotation relative to the universe axes, at the current time. */
  readonly quaternion: THREE.Quaternion;
  /** Velocity of the origin, universe axes, metres per *real* second (includes time speed-up). */
  readonly velocity: THREE.Vector3;
  /** Spin: axis times radians per real second, universe axes. Zero if the frame does not turn. */
  readonly angularVelocity: THREE.Vector3;
}

export const UNIVERSE_FRAME: ReferenceFrame = {
  name: 'space (star frame)',
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  velocity: new THREE.Vector3(),
  angularVelocity: new THREE.Vector3(),
};

const inverse = new THREE.Quaternion();
const lever = new THREE.Vector3();
const spin = new THREE.Vector3();

export function positionToUniverse(frame: ReferenceFrame, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(local).applyQuaternion(frame.quaternion).add(frame.position);
}

export function positionToFrame(frame: ReferenceFrame, universe: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  inverse.copy(frame.quaternion).invert();
  return out.copy(universe).sub(frame.position).applyQuaternion(inverse);
}

// multiplyQuaternions(a, b) reads both inputs before writing, so `out` may be the same object as
// the input quaternion (all helpers here are safe to call in place).

export function orientationToUniverse(frame: ReferenceFrame, local: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  return out.multiplyQuaternions(frame.quaternion, local);
}

export function orientationToFrame(frame: ReferenceFrame, universe: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  inverse.copy(frame.quaternion).invert();
  return out.multiplyQuaternions(inverse, universe);
}

/** Rotates a direction (not a position: no translation) from the frame into universe axes. */
export function directionToUniverse(frame: ReferenceFrame, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(local).applyQuaternion(frame.quaternion);
}

/** Rotates a direction from universe axes into the frame's axes. */
export function directionToFrame(frame: ReferenceFrame, universe: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  inverse.copy(frame.quaternion).invert();
  return out.copy(universe).applyQuaternion(inverse);
}

/**
 * Universe velocity of something at `localPosition` moving with `localVelocity` in the frame:
 * the frame's own motion, plus being carried round by its spin, plus its motion in the frame.
 */
export function velocityToUniverse(
  frame: ReferenceFrame,
  localPosition: THREE.Vector3,
  localVelocity: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  lever.copy(localPosition).applyQuaternion(frame.quaternion);
  spin.crossVectors(frame.angularVelocity, lever);
  return out.copy(localVelocity).applyQuaternion(frame.quaternion).add(frame.velocity).add(spin);
}

/** The inverse of velocityToUniverse, for something at `universePosition`. */
export function velocityToFrame(
  frame: ReferenceFrame,
  universePosition: THREE.Vector3,
  universeVelocity: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  lever.copy(universePosition).sub(frame.position);
  spin.crossVectors(frame.angularVelocity, lever);
  inverse.copy(frame.quaternion).invert();
  return out.copy(universeVelocity).sub(frame.velocity).sub(spin).applyQuaternion(inverse);
}

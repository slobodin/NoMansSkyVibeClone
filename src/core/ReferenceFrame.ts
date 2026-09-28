import * as THREE from 'three';

/**
 * A coordinate frame that moves and rotates within the universe.
 *
 * Anything that "belongs to" a planet - the player, a camera hovering over the ground, later a
 * landed ship - stores its pose in that planet's frame. When the planet spins, they spin with it
 * without a single extra line of code; we only convert to universe coordinates for rendering.
 * The universe itself is simply the frame with no offset and no rotation.
 *
 * Conversions (p = position, q = orientation):
 *   universe p = frame.position + frame.quaternion * local p
 *   universe q = frame.quaternion * local q
 */
export interface ReferenceFrame {
  readonly name: string;
  /** Frame origin in universe coordinates, at the current time. */
  readonly position: THREE.Vector3;
  /** Frame rotation relative to the universe axes, at the current time. */
  readonly quaternion: THREE.Quaternion;
}

export const UNIVERSE_FRAME: ReferenceFrame = {
  name: 'universe',
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
};

const inverse = new THREE.Quaternion();

export function positionToUniverse(frame: ReferenceFrame, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(local).applyQuaternion(frame.quaternion).add(frame.position);
}

export function positionToFrame(frame: ReferenceFrame, universe: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  inverse.copy(frame.quaternion).invert();
  return out.copy(universe).sub(frame.position).applyQuaternion(inverse);
}

export function orientationToUniverse(frame: ReferenceFrame, local: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  return out.copy(frame.quaternion).multiply(local);
}

export function orientationToFrame(frame: ReferenceFrame, universe: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  return out.copy(frame.quaternion).invert().multiply(universe);
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

import * as THREE from 'three';

const forward = new THREE.Vector3();
const ownUp = new THREE.Vector3();
const target = new THREE.Vector3();
const cross = new THREE.Vector3();
const step = new THREE.Quaternion();

/**
 * Rolls `orientation` (something looking down its -Z, like a camera or the ship) about its view
 * axis so that its up vector leans towards `up`: the fraction 1 - exp(-rate * dt) of the way per
 * call. Only the roll changes, never where it points, so it feels like a gentle autopilot for
 * the horizon. Used by the free camera and by the ship in the air.
 */
export function levelRoll(orientation: THREE.Quaternion, up: THREE.Vector3, rate: number, dt: number): void {
  forward.set(0, 0, -1).applyQuaternion(orientation);
  ownUp.set(0, 1, 0).applyQuaternion(orientation);
  // Target: the given up, with the part along the view direction removed.
  target.copy(up).addScaledVector(forward, -up.dot(forward));
  if (target.lengthSq() < 1e-4) return; // looking straight up or down: roll is undefined
  target.normalize();
  // Signed angle from our up to the target, measured around the forward axis.
  const angle = Math.atan2(forward.dot(cross.crossVectors(ownUp, target)), ownUp.dot(target));
  // A rotation about a direction in the parent frame is applied from the left (premultiply).
  orientation.premultiply(step.setFromAxisAngle(forward, angle * (1 - Math.exp(-rate * dt)))).normalize();
}

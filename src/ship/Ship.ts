import * as THREE from 'three';
import {
  orientationToUniverse,
  positionToUniverse,
  UNIVERSE_FRAME,
  type ReferenceFrame,
} from '../core/ReferenceFrame';
import type { Planet } from '../planet/Planet';
import { FEET, GEAR_HEIGHT, ShipModel } from './shipModel';

export type ShipState = 'landed' | 'takeoff' | 'flying' | 'landing';

/**
 * The player's ship: its pose, its state and (in flight) how it moves.
 *
 * Like the free camera, the ship keeps its pose in a reference frame: standing on a planet that
 * is the planet's rotating frame, so a landed ship simply stays put on the spinning ground.
 */
export class Ship {
  readonly model = new ShipModel();
  /** The frame that `position`, `orientation` and `velocity` are expressed in. */
  frame: ReferenceFrame = UNIVERSE_FRAME;
  readonly position = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  state: ShipState = 'landed';

  /** Puts the ship down on `body`, standing at local direction `dir` with its nose towards `heading`. */
  placeLanded(body: Planet, dir: THREE.Vector3, heading: THREE.Vector3): void {
    this.frame = body;
    restingPose(body, dir, heading, this.position, this.orientation);
    this.velocity.set(0, 0, 0);
    this.state = 'landed';
    this.model.setGear(1);
    this.model.setEngines(0, false);
  }

  universePosition(out: THREE.Vector3): THREE.Vector3 {
    return positionToUniverse(this.frame, this.position, out);
  }

  universeOrientation(out: THREE.Quaternion): THREE.Quaternion {
    return orientationToUniverse(this.frame, this.orientation, out);
  }

  /** Copies the universe pose to the 3D model. Call once per frame, after the frames have moved. */
  updateModel(): void {
    this.universePosition(this.model.object.position);
    this.universeOrientation(this.model.object.quaternion);
  }
}

const groundPoints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const up = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const normal = new THREE.Vector3();
const edge1 = new THREE.Vector3();
const edge2 = new THREE.Vector3();
const basis = new THREE.Matrix4();

/**
 * Where the ship stands when its three feet rest on the ground at the spot above `local`
 * (body-local), nose towards `heading`. Returns the tilt from the local vertical, in radians.
 *
 * Why three legs: three points always define a plane, so a tripod stands on any uneven ground
 * without wobbling - no physics needed. We find the ground under each foot, tilt the ship to the
 * plane through those three points, and lift its centre GEAR_HEIGHT above their middle (the
 * feet are laid out so that their middle is straight below the ship's centre).
 */
export function restingPose(
  body: Planet,
  local: THREE.Vector3,
  heading: THREE.Vector3,
  outPosition: THREE.Vector3,
  outOrientation: THREE.Quaternion,
): number {
  up.copy(local).normalize();
  forward.copy(heading).addScaledVector(up, -heading.dot(up)).normalize();
  right.crossVectors(forward, up);

  // The ground under each foot: step sideways from the centre (ship +X = right, -Z = forward),
  // then drop onto the floor (terrain, or the sea surface: you can't park under water).
  const R = body.radius;
  FEET.forEach((foot, i) => {
    const point = groundPoints[i]
      .copy(up)
      .multiplyScalar(R)
      .addScaledVector(right, foot.x)
      .addScaledVector(forward, -foot.z)
      .normalize();
    point.multiplyScalar(R + body.floorHeight(point));
  });

  edge1.subVectors(groundPoints[1], groundPoints[0]);
  edge2.subVectors(groundPoints[2], groundPoints[0]);
  normal.crossVectors(edge1, edge2).normalize();
  if (normal.dot(up) < 0) normal.negate();

  // An orthonormal basis standing on that plane, nose still towards `heading`.
  forward.addScaledVector(normal, -forward.dot(normal)).normalize();
  right.crossVectors(forward, normal);
  basis.makeBasis(right, normal, forward.negate()); // ship space: +X right, +Y up, +Z back
  outOrientation.setFromRotationMatrix(basis);

  outPosition
    .copy(groundPoints[0])
    .add(groundPoints[1])
    .add(groundPoints[2])
    .divideScalar(3)
    .addScaledVector(normal, GEAR_HEIGHT);
  return Math.acos(THREE.MathUtils.clamp(normal.dot(up), -1, 1));
}

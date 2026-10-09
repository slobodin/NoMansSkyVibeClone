import * as THREE from 'three';
import {
  orientationToFrame,
  orientationToUniverse,
  positionToUniverse,
  type ReferenceFrame,
} from '../core/ReferenceFrame';
import type { Planet } from '../planet/Planet';
import type { Ship } from './Ship';
import { COCKPIT_EYE } from './shipModel';

export type ShipView = 'chase' | 'cockpit';

/** Chase camera: behind and above the ship (ship space), tilted down a little to look at it. */
const CHASE_OFFSET = new THREE.Vector3(0, 3.4, 15);
const CHASE_PITCH = THREE.MathUtils.degToRad(-7);
/** 1/s: how quickly the chase camera swings round after the ship (lower = lazier). */
const CHASE_STIFFNESS = 5;
/** The chase camera never goes lower than this above the ground. */
const MIN_CAMERA_ALTITUDE = 1.5;

const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * The camera while flying: a chase view that trails the ship, or the cockpit (C switches).
 *
 * The chase camera is a "spring arm": it is rigidly attached to a *smoothed* copy of the ship's
 * orientation, which lags behind the real one. Turn hard and you see the ship swing round on
 * screen, which is what makes it feel like it has weight. Position is never smoothed, so the
 * camera keeps up at any speed.
 *
 * The smoothing runs in the ship's reference frame: on a spinning planet, smoothing in universe
 * axes would make the camera lag behind the planet's spin itself (badly so with time sped up).
 */
export class ShipCamera {
  view: ShipView = 'chase';

  private readonly smoothed = new THREE.Quaternion();
  private smoothedFrame: ReferenceFrame | null = null;
  private readonly pitch = new THREE.Quaternion().setFromAxisAngle(X_AXIS, CHASE_PITCH);
  private readonly local = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();

  /** Snap to the ship on the next update (after boarding, or a teleport). */
  reset(): void {
    this.smoothedFrame = null;
  }

  /**
   * Computes this frame's camera pose (universe) into `outPosition` / `outOrientation`.
   * `body` is the body nearest to the ship, to keep the camera out of the ground.
   */
  update(dt: number, ship: Ship, body: Planet, outPosition: THREE.Vector3, outOrientation: THREE.Quaternion): void {
    if (this.view === 'cockpit') {
      this.local.copy(COCKPIT_EYE).applyQuaternion(ship.orientation).add(ship.position);
      positionToUniverse(ship.frame, this.local, outPosition);
      ship.universeOrientation(outOrientation);
      return;
    }

    if (this.smoothedFrame === null) {
      this.smoothed.copy(ship.orientation);
    } else if (this.smoothedFrame !== ship.frame) {
      // The ship changed frames: re-express the smoothed orientation in the new one.
      orientationToUniverse(this.smoothedFrame, this.smoothed, this.tmpQuat);
      orientationToFrame(ship.frame, this.tmpQuat, this.smoothed);
    }
    this.smoothedFrame = ship.frame;
    this.smoothed.slerp(ship.orientation, 1 - Math.exp(-CHASE_STIFFNESS * dt));

    this.local.copy(CHASE_OFFSET).applyQuaternion(this.smoothed).add(ship.position);
    positionToUniverse(ship.frame, this.local, outPosition);
    orientationToUniverse(ship.frame, this.tmpQuat.copy(this.smoothed).multiply(this.pitch), outOrientation);

    // Parked on a slope, or skimming the ground: lift the camera out of the terrain.
    const altitude = body.altitude(outPosition);
    if (altitude < MIN_CAMERA_ALTITUDE) {
      const up = this.local.copy(outPosition).sub(body.position).normalize();
      outPosition.addScaledVector(up, MIN_CAMERA_ALTITUDE - altitude);
    }
  }
}

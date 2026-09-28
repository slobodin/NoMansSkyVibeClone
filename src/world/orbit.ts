import * as THREE from 'three';
import type { OrbitConfig } from '../planet/PlanetConfig';

const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Where a body is relative to its parent at game time `time`, for a circular orbit "on rails".
 *
 * On rails means no physics: no n-body simulation, no numerical integration, nothing that can
 * drift or blow up. The position is a pure function of time, so any moment - now, an hour ago,
 * where the planet will be when you arrive - can be computed directly.
 *
 * The body moves counter-clockwise seen from +Y (the same sense as the planets' spin), in a plane
 * tilted by `inclination` about the X axis.
 */
export function orbitOffset(orbit: OrbitConfig, time: number, out: THREE.Vector3): THREE.Vector3 {
  const angle = orbit.phase + (2 * Math.PI * time) / orbit.period;
  return out
    .set(Math.cos(angle), 0, -Math.sin(angle))
    .multiplyScalar(orbit.radius)
    .applyAxisAngle(X_AXIS, orbit.inclination);
}

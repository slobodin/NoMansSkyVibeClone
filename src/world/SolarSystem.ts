import * as THREE from 'three';
import type { ChunkWorkerPool } from '../planet/ChunkWorkerPool';
import { Planet } from '../planet/Planet';
import type { PlanetConfig } from '../planet/PlanetConfig';
import { Star } from './Star';

export interface StarConfig {
  name: string;
  radius: number;
  /** Linear RGB, roughly 0..1. */
  color: [number, number, number];
}

/**
 * The star and every planet and moon, built from config (world/bodies.ts).
 *
 * Each frame `update(time)` puts every body where its orbit says it is at that time, parents
 * before their moons, then spins it. Nothing is simulated: the whole system is a pure function of
 * the game time.
 *
 * `bodyAt` answers which body's *sphere of influence* (SOI) a point is in: the region where the
 * camera should travel along with that body rather than stay put among the stars. Spheres nest -
 * a moon's lies inside its planet's - and the innermost one wins.
 */
export class SolarSystem {
  readonly star: Star;
  readonly bodies: Planet[] = [];

  private readonly byName = new Map<string, Planet>();
  private readonly depth = new Map<Planet, number>();

  constructor(star: StarConfig, bodies: readonly PlanetConfig[], pool: ChunkWorkerPool) {
    // The star sits at the universe origin: the universe frame is "space" around the star.
    this.star = new Star(star.name, new THREE.Vector3(), star.radius, new THREE.Color(...star.color));
    for (const config of bodies) {
      const body = new Planet(config, pool, this.star.intensity);
      if (config.orbit.parent !== star.name) {
        const parent = this.byName.get(config.orbit.parent);
        if (!parent) throw new Error(`${config.name} orbits ${config.orbit.parent}, which must be listed before it`);
        body.parent = parent;
      }
      this.depth.set(body, body.parent ? this.depth.get(body.parent)! + 1 : 1);
      this.bodies.push(body);
      this.byName.set(config.name, body);
    }
  }

  get(name: string): Planet {
    const body = this.byName.get(name);
    if (!body) throw new Error(`no body called ${name}`);
    return body;
  }

  /** Moves everything to where it is at game time `time`. */
  update(time: number): void {
    // Bodies are listed parents-first, so a moon's parent has already moved.
    for (const body of this.bodies) {
      body.updateOrbit(time, body.parent ? body.parent.position : this.star.position);
      body.updateSpin(time);
      this.star.directionFrom(body.position, body.sunDirection);
    }
  }

  /** The innermost body whose sphere of influence contains `position`, or null in open space. */
  bodyAt(position: THREE.Vector3): Planet | null {
    let best: Planet | null = null;
    for (const body of this.bodies) {
      if (position.distanceTo(body.position) > body.config.soiRadius) continue;
      if (!best || this.depth.get(body)! > this.depth.get(best)!) best = body;
    }
    return best;
  }

  /** The body closest to `position`, measured to its sea-level sphere. */
  nearestBody(position: THREE.Vector3): Planet {
    let best = this.bodies[0];
    let bestAltitude = Infinity;
    for (const body of this.bodies) {
      const altitude = position.distanceTo(body.position) - body.radius;
      if (altitude < bestAltitude) {
        best = body;
        bestAltitude = altitude;
      }
    }
    return best;
  }

  /** Distance from `position` to the nearest surface: terrain of any body, or the star. */
  surfaceDistance(position: THREE.Vector3): number {
    let distance = position.distanceTo(this.star.position) - this.star.radius;
    for (const body of this.bodies) {
      // Terrain can rise a few hundred metres above the radius: only evaluate it nearby.
      const sphere = position.distanceTo(body.position) - body.radius;
      if (sphere - 2000 > distance) continue;
      distance = Math.min(distance, body.altitude(position));
    }
    return Math.max(0, distance);
  }
}

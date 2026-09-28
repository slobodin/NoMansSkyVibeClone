import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { Planet } from '../planet/Planet';

const EYE_HEIGHT = 1.7; // m above the feet
const WALK_SPEED = 5; // m/s
const SPRINT_SPEED = 10; // m/s
const SWIM_SPEED = 3; // m/s
const SWIM_ACCELERATION = 10; // m/s^2
const GROUND_ACCELERATION = 40; // m/s^2 towards the wished velocity when standing
const AIR_ACCELERATION = 6; // m/s^2 of steering while airborne
const JUMP_SPEED = 5; // m/s upwards: about a 1.3 m jump
const JETPACK_THRUST = 17; // m/s^2 upwards; more than gravity, so you rise
const JETPACK_PUSH = 7; // m/s^2 towards where you are moving
const JETPACK_DURATION = 3; // s of thrust on a full tank
const JETPACK_RECHARGE = 1.5; // s to refill while standing
const MAX_WALK_SLOPE = THREE.MathUtils.degToRad(45); // steeper ground: you slide back down
const STEP_DOWN = 0.4; // m; walking downhill keeps you on the ground up to this drop per step
const FLOAT_DEPTH = 1.4; // m; swimming, the feet float this far below the water surface
const PHYSICS_STEP = 1 / 120; // s
const LOOK_SENSITIVITY = 0.0022; // radians per pixel
const MAX_PITCH = THREE.MathUtils.degToRad(89);

/**
 * First-person movement on a round planet (or moon).
 *
 * Everything is in the local frame of the body the player is on (`planet`), so the player moves
 * and spins along with it. "Up" is not a constant axis but the direction from the planet centre to
 * the player, re-evaluated every step; gravity pulls along -up, and the look direction (`heading`)
 * is kept perpendicular to up, so walking all the way around the planet just works.
 *
 * Physics runs in fixed steps of PHYSICS_STEP seconds, however long the frame was, which keeps
 * jumps and collisions identical at 30 and 144 FPS.
 *
 * Collision is analytic: the ground under the player is at radius R + height(direction), from the
 * same TerrainGenerator the chunk meshes were built from, so no physics engine or triangle
 * tests are needed. (The rendered mesh interpolates linearly between vertices ~1 m apart, so the
 * two agree to within centimetres.)
 */
export class PlayerController {
  /** Feet position, planet-local. */
  readonly position = new THREE.Vector3();
  /** Velocity relative to the ground, planet-local. */
  readonly velocity = new THREE.Vector3();
  /** Horizontal look direction: a unit vector tangent to the ground. */
  readonly heading = new THREE.Vector3(1, 0, 0);
  /** Look up (+) / down (-) angle in radians. */
  pitch = 0;
  grounded = false;
  swimming = false;
  /** Jetpack tank, 0..1. */
  jetpackFuel = 1;

  private accumulator = 0;
  private jumpRequested = false;
  private readonly up = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();
  private readonly horizontal = new THREE.Vector3();
  private readonly groundNormal = new THREE.Vector3();
  private readonly downhill = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly sample1 = new THREE.Vector3();
  private readonly sample2 = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly basis = new THREE.Matrix4();

  /** The body the player is on: positions and vectors above are in its local frame. */
  planet: Planet;

  constructor(planet: Planet) {
    this.planet = planet;
  }

  /** Stands the player on `planet` at local direction `dir`, facing `heading`. */
  spawn(planet: Planet, dir: THREE.Vector3, heading: THREE.Vector3): void {
    this.planet = planet;
    const up = this.up.copy(dir).normalize();
    this.position.copy(up).multiplyScalar(this.planet.radius + this.planet.terrainHeight(up));
    this.heading.copy(heading).addScaledVector(up, -heading.dot(up)).normalize();
    this.velocity.set(0, 0, 0);
    this.pitch = 0;
    this.grounded = true;
  }

  /** Takes over from another camera: feet under `eye` (local to `planet`), same view direction. */
  placeAtEye(planet: Planet, eye: THREE.Vector3, forward: THREE.Vector3): void {
    this.planet = planet;
    const up = this.up.copy(eye).normalize();
    this.position.copy(eye).addScaledVector(up, -EYE_HEIGHT);
    const vertical = forward.dot(up);
    this.heading.copy(forward).addScaledVector(up, -vertical);
    if (this.heading.lengthSq() < 1e-6) this.heading.set(1, 0, 0).addScaledVector(up, -up.x);
    this.heading.normalize();
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(vertical, -1, 1)), -MAX_PITCH, MAX_PITCH);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
  }

  update(dt: number, input: Input): void {
    this.look(input);
    if (input.wasPressed('Space') && this.grounded && !this.swimming) this.jumpRequested = true;
    this.accumulator += dt;
    while (this.accumulator >= PHYSICS_STEP) {
      this.step(PHYSICS_STEP, input);
      this.accumulator -= PHYSICS_STEP;
    }
  }

  /** Eye position, planet-local. */
  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).addScaledVector(this.up.copy(this.position).normalize(), EYE_HEIGHT);
  }

  /** Camera orientation, planet-local: looking along `heading`, tilted by `pitch`. */
  eyeOrientation(out: THREE.Quaternion): THREE.Quaternion {
    const up = this.up.copy(this.position).normalize();
    const right = this.right.crossVectors(this.heading, up).normalize();
    // A three.js camera looks down its -Z axis with +Y up, so its basis is (right, up, -forward).
    this.basis.makeBasis(right, up, this.tmp.copy(this.heading).negate());
    out.setFromRotationMatrix(this.basis);
    return out.multiply(this.tmpQuat.setFromAxisAngle(this.tmp.set(1, 0, 0), this.pitch));
  }

  /** Speed relative to the ground, m/s. */
  get speed(): number {
    return this.velocity.length();
  }

  // ---------------------------------------------------------------------------------------------

  private look(input: Input): void {
    const up = this.up.copy(this.position).normalize();
    // Mouse right = turn right = negative rotation about up.
    this.heading.applyAxisAngle(up, -input.mouseDX * LOOK_SENSITIVITY);
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.mouseDY * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
  }

  private step(h: number, input: Input): void {
    const planet = this.planet;
    const g = planet.config.gravity;
    const up = this.up.copy(this.position).normalize();

    // Moving over a sphere tilts "up" a little every step; keep the heading perpendicular to it.
    this.heading.addScaledVector(up, -this.heading.dot(up)).normalize();
    const right = this.right.crossVectors(this.heading, up);

    // Water: the sea surface is the sphere of radius R (sea level = height 0). Start swimming
    // when deeper than the floating depth; stop only once clearly shallower (hysteresis, so the
    // bobbing at the surface does not flip the state every step).
    // (Dry planets have no water: their lowlands are just ground.)
    const depth = planet.hasOcean ? planet.radius - this.position.length() : -Infinity;
    if (this.swimming && depth < FLOAT_DEPTH - 0.3) this.swimming = false;
    else if (!this.swimming && depth > FLOAT_DEPTH) this.swimming = true;

    // Split the velocity into a vertical part (along up) and a horizontal part.
    let verticalSpeed = this.velocity.dot(up);
    const horizontal = this.horizontal.copy(this.velocity).addScaledVector(up, -verticalSpeed);

    // What the keys ask for, as a horizontal velocity.
    const wish = this.wish
      .copy(this.heading)
      .multiplyScalar(input.axis('KeyS', 'KeyW'))
      .addScaledVector(right, input.axis('KeyA', 'KeyD'));
    const moving = wish.lengthSq() > 0;
    let topSpeed = this.swimming ? SWIM_SPEED : input.isDown('ShiftLeft') ? SPRINT_SPEED : WALK_SPEED;
    if (!this.swimming && depth > 0.3) topSpeed *= 0.6; // wading through shallow water
    wish.normalize().multiplyScalar(topSpeed);
    let jumped = false;

    if (this.swimming) {
      // Swimming is velocity-controlled in 3D: Space / C swim up / down; otherwise drift to the
      // floating depth, where the head is just above the surface. You cannot swim up out of
      // the water - you get out by walking onto a shore.
      let target = input.axis('KeyC', 'Space') * SWIM_SPEED;
      if (target === 0) target = THREE.MathUtils.clamp((depth - FLOAT_DEPTH) * 2, -2, 2);
      target = Math.min(target, Math.max(0, (depth - FLOAT_DEPTH) * 3));
      verticalSpeed = approach(verticalSpeed, target, SWIM_ACCELERATION * h);
      moveTowards(horizontal, wish, SWIM_ACCELERATION * h);
    } else if (this.grounded) {
      this.slopeAt(up);
      const slope = Math.acos(THREE.MathUtils.clamp(this.groundNormal.dot(up), -1, 1));
      if (slope > MAX_WALK_SLOPE) {
        // Too steep: no walking uphill, and gravity's along-slope part slides us down (with
        // little grip left to brake: the feet lose traction).
        const uphillPart = wish.dot(this.downhill);
        if (uphillPart < 0) wish.addScaledVector(this.downhill, -uphillPart);
        horizontal.addScaledVector(this.downhill, g * Math.sin(slope) * h);
        moveTowards(horizontal, wish, GROUND_ACCELERATION * 0.05 * h);
      } else {
        moveTowards(horizontal, wish, GROUND_ACCELERATION * h);
      }
      if (this.jumpRequested) {
        verticalSpeed = JUMP_SPEED;
        jumped = true;
      }
    } else {
      // In the air: gravity, a little steering, and the jetpack while Space is held.
      verticalSpeed -= g * h;
      if (moving) moveTowards(horizontal, wish, AIR_ACCELERATION * h);
      if (input.isDown('Space') && this.jetpackFuel > 0) {
        verticalSpeed += JETPACK_THRUST * h;
        if (moving) horizontal.addScaledVector(this.tmp.copy(wish).normalize(), JETPACK_PUSH * h);
        this.jetpackFuel = Math.max(0, this.jetpackFuel - h / JETPACK_DURATION);
      }
    }
    this.jumpRequested = false;

    this.velocity.copy(horizontal).addScaledVector(up, verticalSpeed);
    this.position.addScaledVector(this.velocity, h);

    this.collideWithGround(jumped);
    if (this.grounded) this.jetpackFuel = Math.min(1, this.jetpackFuel + h / JETPACK_RECHARGE);
  }

  /** Keeps the feet on or above the terrain and decides whether we are standing. */
  private collideWithGround(jumped: boolean): void {
    const up = this.up.copy(this.position).normalize();
    const groundRadius = this.planet.radius + this.planet.terrainHeight(up);
    const feetRadius = this.position.length();
    const verticalSpeed = this.velocity.dot(up);

    if (feetRadius <= groundRadius) {
      // Below the surface: put the feet back on it and cancel the downward motion.
      this.position.copy(up).multiplyScalar(groundRadius);
      if (verticalSpeed < 0) this.velocity.addScaledVector(up, -verticalSpeed);
      this.grounded = true;
    } else if (this.grounded && !jumped && !this.swimming && feetRadius - groundRadius < STEP_DOWN) {
      // Still standing, and the ground fell away a little (walking downhill - or simply the
      // planet curving away under a straight step): follow it down instead of taking off.
      this.position.copy(up).multiplyScalar(groundRadius);
      this.velocity.addScaledVector(up, -verticalSpeed);
    } else {
      this.grounded = false;
    }
  }

  /**
   * Ground normal under the player, by finite differences of the height function (two extra
   * samples 0.5 m away), and the horizontal direction that points downhill.
   */
  private slopeAt(up: THREE.Vector3): void {
    const planet = this.planet;
    const R = planet.radius;
    const e = 0.5; // m
    const t1 = this.right.crossVectors(this.heading, up).normalize(); // any two tangents will do
    const t2 = this.heading;
    const p0 = this.tmp.copy(up).multiplyScalar(R + planet.terrainHeight(up));
    const d1 = this.sample1.copy(up).multiplyScalar(R).addScaledVector(t1, e).normalize();
    const d2 = this.sample2.copy(up).multiplyScalar(R).addScaledVector(t2, e).normalize();
    const p1 = d1.multiplyScalar(R + planet.terrainHeight(d1)).sub(p0);
    const p2 = d2.multiplyScalar(R + planet.terrainHeight(d2)).sub(p0);
    // t1 x t2 = (heading x up) x heading = up, so p1 x p2 points outwards.
    this.groundNormal.crossVectors(p1, p2).normalize();
    // The normal leans towards downhill: its horizontal part is the downhill direction.
    this.downhill.copy(this.groundNormal).addScaledVector(up, -this.groundNormal.dot(up));
    if (this.downhill.lengthSq() > 1e-10) this.downhill.normalize();
  }
}

/** Moves `current` towards `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  return current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);
}

/** Moves `current` towards `target` by at most `maxDelta` (the vector version of approach). */
function moveTowards(current: THREE.Vector3, target: THREE.Vector3, maxDelta: number): void {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const dz = target.z - current.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance <= maxDelta || distance === 0) {
    current.copy(target);
  } else {
    const s = maxDelta / distance;
    current.x += dx * s;
    current.y += dy * s;
    current.z += dz * s;
  }
}

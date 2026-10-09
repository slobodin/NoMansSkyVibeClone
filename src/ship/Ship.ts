import * as THREE from 'three';
import { levelRoll } from '../controls/leveling';
import type { Input } from '../core/Input';
import {
  directionToFrame,
  orientationToFrame,
  orientationToUniverse,
  positionToFrame,
  positionToUniverse,
  UNIVERSE_FRAME,
  velocityToFrame,
  velocityToUniverse,
  type ReferenceFrame,
} from '../core/ReferenceFrame';
import type { Planet } from '../planet/Planet';
import type { SolarSystem } from '../world/SolarSystem';
import type { Star } from '../world/Star';
import { FEET, GEAR_HEIGHT, ShipModel } from './shipModel';

export type ShipState = 'landed' | 'takeoff' | 'flying' | 'landing';

/**
 * How the ship handles. It blends from PLANET to SPACE as it climbs out of a body's air: low
 * down it flies like a plane (it goes where the nose points, gently levels its wings), up high
 * it drifts and is much faster.
 */
interface Handling {
  /** Top speed with W held, m/s. */
  maxSpeed: number;
  /** Top speed with W + Shift. */
  boostSpeed: number;
  /** Thrust along the nose, m/s^2 (doubled when boosting and when braking). */
  acceleration: number;
  /** 1/s: how fast sideways drift dies out. High = plane-like, low = drifting as in space. */
  grip: number;
  /** 1/s: how fast speed above the current top speed bleeds off (air brakes / flight computer). */
  drag: number;
}
const PLANET: Handling = { maxSpeed: 160, boostSpeed: 400, acceleration: 60, grip: 2.5, drag: 1.2 };
const SPACE: Handling = { maxSpeed: 1000, boostSpeed: 2500, acceleration: 300, grip: 0.4, drag: 0.5 };

/** On a body without air, the "low-altitude" zone where the ship flies like a plane. */
const AIRLESS_CEILING = 1500; // m
const MOUSE_SENSITIVITY = 0.0022; // radians per pixel
/** 1/s: how quickly the ship turns to where the mouse asked (higher = snappier). */
const STEER_RESPONSE = 10;
const MAX_PENDING_TURN = 0.6; // radians of mouse input that can queue up
const ROLL_SPEED = 2; // rad/s (A / D)
const LEVEL_RATE = 1.5; // 1/s, auto-levelling of the wings in the air
/** The hull centre never gets closer to the floor (terrain or sea) than this while flying. */
const CLEARANCE = GEAR_HEIGHT;
const TAKEOFF_TIME = 2.5; // s of vertical lift before you get control
const TAKEOFF_SPEED = 15; // m/s
/** You can land from this high above the ground. */
const LANDING_RANGE = 300; // m
const MAX_LANDING_SLOPE = THREE.MathUtils.degToRad(30);
const MAX_DESCENT_SPEED = 40; // m/s
/** 1/s: how quickly the ship glides over to the landing spot (it covers 1/rate of a second's flight). */
const LANDING_GLIDE_RATE = 2;

/**
 * Pulse drive: in space, cruise at a speed proportional to the distance to the nearest surface
 * (the same trick as the free camera). Open space is crossed at up to 30 km/s, and flying at a
 * moon slows you down by itself - the distance shrinks exponentially, so you arrive instead of
 * crashing - until the drive drops out a few km above the surface.
 */
const PULSE_RATE = 0.5; // 1/s: pulse speed = PULSE_RATE x distance to the nearest surface
const PULSE_MAX = 30_000; // m/s
const PULSE_MIN_DISTANCE = 4000; // m from any surface to engage...
const PULSE_DROP_DISTANCE = 3000; // ...and it drops out when closer than this
const PULSE_SPOOL = 1.2; // 1/s: how fast the speed rises to the pulse speed
const PULSE_STEER_RESPONSE = 2.5; // 1/s: turning is sluggish at pulse speed
const PULSE_GRIP = 3; // 1/s: the velocity follows the nose closely

/**
 * Speed limit right after switching frames. Converting the velocity keeps the ship's momentum,
 * but with time sped up x300 planets move at tens of km/s, and the arcade ship should not
 * inherit that.
 */
const MAX_FRAME_SPEED = 3 * SPACE.boostSpeed;
/** The ship stays this far outside the star's surface. */
const STAR_CLEARANCE = 1000; // m

const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * The player's ship: its pose, its state machine and its flight model.
 *
 *   landed --Space--> takeoff --(2.5 s)--> flying --E (low enough)--> landing --(touchdown)--> landed
 *
 * Like the free camera, the ship keeps its pose and velocity in a reference frame, chosen by
 * SolarSystem.frameAt: near a body that is the body's rotating frame (a landed ship simply stays
 * put on the spinning ground), further out the body's orbit frame, then the star's frame. On a
 * switch the *velocity* is converted too, frame motion included (ReferenceFrame.ts), so crossing
 * from one sphere of influence into another keeps your momentum.
 *
 * The flight model is arcade, not Newtonian: no gravity, and the velocity relative to the
 * current frame is steered towards the nose by `grip`, accelerated by W and bled off by `drag`.
 * Collision is analytic, like the player's: the hull centre stays CLEARANCE above the floor.
 * In space, J engages the pulse drive (see PULSE_RATE) to cross between bodies in seconds.
 */
export class Ship {
  readonly model = new ShipModel();
  /** The frame that `position`, `orientation` and `velocity` are expressed in. */
  frame: ReferenceFrame = UNIVERSE_FRAME;
  readonly position = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  state: ShipState = 'landed';

  /** The body nearest to the ship, its altitude above the floor there, and 0 (air) .. 1 (space). */
  body: Planet | null = null;
  altitude = 0;
  spaceFactor = 1;
  /** Distance to the nearest surface of anything: bodies and the star. */
  surfaceDistance = Infinity;
  /** Pulse drive engaged? And 0..1, eased, for the visuals (engine colour, field of view). */
  pulse = false;
  pulseLevel = 0;
  /** Something the HUD should tell the player (e.g. why the pulse drive dropped out). */
  notice: string | null = null;

  private timer = 0;
  private gear = 1;
  private thrust = 0;
  private pendingPitch = 0;
  private pendingYaw = 0;
  private rollSpeed = 0;

  private readonly universe = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly nose = new THREE.Vector3();
  private readonly lateral = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetOrientation = new THREE.Quaternion();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmp = new THREE.Vector3();

  /** Puts the ship down on `body`, standing at local direction `dir` with its nose towards `heading`. */
  placeLanded(body: Planet, dir: THREE.Vector3, heading: THREE.Vector3): void {
    this.frame = body;
    restingPose(body, dir, heading, this.position, this.orientation);
    this.velocity.set(0, 0, 0);
    this.state = 'landed';
    this.gear = 1;
    this.thrust = 0;
    this.updateModel();
  }

  /** Speed relative to the current frame, m/s. */
  get speed(): number {
    return this.velocity.length();
  }

  /** True when J would engage the pulse drive. */
  get canPulse(): boolean {
    return this.state === 'flying' && !this.pulse && this.spaceFactor >= 1 && this.surfaceDistance > PULSE_MIN_DISTANCE;
  }

  /** J: engages or disengages the pulse drive. Returns why not, if it can't engage. */
  togglePulse(): string | null {
    if (this.pulse) {
      this.dropOutOfPulse();
      return null;
    }
    if (this.state !== 'flying') return null;
    if (this.spaceFactor < 1) return 'pulse drive: climb out of the atmosphere first';
    if (this.surfaceDistance <= PULSE_MIN_DISTANCE) return `pulse drive: too close to ${this.body?.name ?? 'a surface'}`;
    this.pulse = true;
    return null;
  }

  /** True when E would start a landing (low enough, flying). */
  get canLand(): boolean {
    return this.state === 'flying' && this.altitude < LANDING_RANGE;
  }

  /**
   * Starts landing. The spot is picked now, where the ship would come to a stop if it braked
   * smoothly from its current speed - a little ahead - and checked: not water, not too steep.
   * Returns why not, if it can't land there.
   */
  land(): string | null {
    const body = this.body;
    if (!this.canLand || !body) return null;
    this.setFrame(body); // (already is: this close to the ground we fly in the rotating frame)
    const up = this.tmp.copy(this.position).normalize();
    const vertical = this.velocity.dot(up);
    const spot = this.local
      .copy(this.velocity)
      .addScaledVector(up, -vertical)
      .multiplyScalar(1 / LANDING_GLIDE_RATE)
      .add(this.position);
    if (body.hasOcean && body.terrainHeight(spot) < 0) return "can't land on water";
    const slope = restingPose(body, spot, this.noseDirection(), this.targetPosition, this.targetOrientation);
    if (slope > MAX_LANDING_SLOPE) return 'too steep to land here';
    this.state = 'landing';
    return null;
  }

  update(dt: number, input: Input, system: SolarSystem): void {
    // Where are we? The nearest body gives the altitude, "up", and air vs space flight.
    this.universePosition(this.universe);
    const body = system.nearestBody(this.universe);
    this.body = body;
    if (this.state === 'flying') this.setFrame(system.frameAt(this.universe));
    this.measureAltitude(body);
    const ceiling = body.config.atmosphere?.height ?? AIRLESS_CEILING;
    this.spaceFactor = THREE.MathUtils.smoothstep(this.altitude, ceiling, ceiling * 1.5);
    this.surfaceDistance = system.surfaceDistance(this.universe);

    switch (this.state) {
      case 'landed':
        this.velocity.set(0, 0, 0);
        if (input.wasPressed('Space')) {
          this.state = 'takeoff';
          this.timer = 0;
        }
        this.thrust = 0;
        break;
      case 'takeoff':
        this.takeOff(dt);
        break;
      case 'flying':
        this.fly(dt, input);
        break;
      case 'landing':
        this.descend(dt);
        break;
    }

    if (this.state === 'flying' || this.state === 'takeoff') {
      this.position.addScaledVector(this.velocity, dt);
      this.collide(body);
      this.avoidStar(system.star);
    }
    this.pulseLevel += ((this.pulse ? 1 : 0) - this.pulseLevel) * (1 - Math.exp(-3 * dt));
    this.updateModel();
  }

  universePosition(out: THREE.Vector3): THREE.Vector3 {
    return positionToUniverse(this.frame, this.position, out);
  }

  universeOrientation(out: THREE.Quaternion): THREE.Quaternion {
    return orientationToUniverse(this.frame, this.orientation, out);
  }

  /**
   * Switches to another reference frame without changing anything physical: the same universe
   * position, orientation and *velocity* (frame motion included), just expressed differently.
   */
  setFrame(frame: ReferenceFrame): void {
    if (frame === this.frame) return;
    const position = positionToUniverse(this.frame, this.position, new THREE.Vector3());
    const orientation = orientationToUniverse(this.frame, this.orientation, new THREE.Quaternion());
    const velocity = velocityToUniverse(this.frame, this.position, this.velocity, new THREE.Vector3());
    this.frame = frame;
    positionToFrame(frame, position, this.position);
    orientationToFrame(frame, orientation, this.orientation);
    velocityToFrame(frame, position, velocity, this.velocity);
    const limit = this.pulse ? PULSE_MAX : MAX_FRAME_SPEED;
    if (this.velocity.length() > limit) this.velocity.setLength(limit);
  }

  /** Copies the universe pose to the 3D model, plus gear and engine glow. */
  updateModel(): void {
    this.universePosition(this.model.object.position);
    this.universeOrientation(this.model.object.quaternion);
    this.model.setGear(this.gear);
    this.model.setEngines(this.thrust, this.pulseLevel > 0.5);
  }

  // --- States -------------------------------------------------------------------------------------

  /** Straight up for a couple of seconds, tucking the gear away, then hand over to the pilot. */
  private takeOff(dt: number): void {
    this.timer += dt;
    const lift = THREE.MathUtils.smoothstep(this.timer, 0, 0.6) * TAKEOFF_SPEED;
    this.velocity.copy(this.up).multiplyScalar(lift);
    this.gear = 1 - THREE.MathUtils.smoothstep(this.timer, 0.8, 1.8);
    this.thrust = 0.5;
    if (this.timer >= TAKEOFF_TIME) {
      this.state = 'flying';
      this.pendingPitch = this.pendingYaw = this.rollSpeed = 0;
    }
  }

  private fly(dt: number, input: Input): void {
    // The pulse drive cuts out on the brake, in air, and close to anything.
    if (this.pulse) {
      if (input.isDown('KeyS') || this.spaceFactor < 1) this.dropOutOfPulse();
      else if (this.surfaceDistance < PULSE_DROP_DISTANCE) {
        this.dropOutOfPulse();
        this.notice = `pulse drive off: ${this.body?.name ?? 'surface'} ahead`;
      }
    }

    // --- Steering: mouse = pitch and yaw, A / D = roll ---
    // Mouse movement queues up a turn that is played out over a few frames: smooth, but still
    // exactly as far as the mouse moved.
    this.pendingPitch = THREE.MathUtils.clamp(this.pendingPitch - input.mouseDY * MOUSE_SENSITIVITY, -MAX_PENDING_TURN, MAX_PENDING_TURN);
    this.pendingYaw = THREE.MathUtils.clamp(this.pendingYaw - input.mouseDX * MOUSE_SENSITIVITY, -MAX_PENDING_TURN, MAX_PENDING_TURN);
    const take = 1 - Math.exp(-(this.pulse ? PULSE_STEER_RESPONSE : STEER_RESPONSE) * dt);
    const pitch = this.pendingPitch * take;
    const yaw = this.pendingYaw * take;
    this.pendingPitch -= pitch;
    this.pendingYaw -= yaw;
    const rollInput = input.axis('KeyD', 'KeyA'); // A = roll left = +Z rotation
    this.rollSpeed += (rollInput * ROLL_SPEED - this.rollSpeed) * (1 - Math.exp(-6 * dt));
    this.tmpQuat.setFromEuler(this.tmpEuler.set(pitch, yaw, this.rollSpeed * dt, 'YXZ'));
    this.orientation.multiply(this.tmpQuat).normalize();
    // In the air the wings level themselves; in space there is no "level".
    const inAir = 1 - this.spaceFactor;
    if (rollInput === 0 && inAir > 0) levelRoll(this.orientation, this.up, LEVEL_RATE * inAir, dt);

    // --- Thrust: split the velocity into "along the nose" and "sideways" ---
    const h = blendHandling(this.spaceFactor);
    const nose = this.noseDirection();
    let speed = this.velocity.dot(nose);
    const lateral = this.lateral.copy(this.velocity).addScaledVector(nose, -speed);
    if (this.pulse) {
      // Spool up towards the pulse speed; when it falls (something is getting closer), follow
      // it down at once.
      const target = THREE.MathUtils.clamp(PULSE_RATE * this.surfaceDistance, SPACE.boostSpeed, PULSE_MAX);
      speed = speed < target ? speed + (target - speed) * (1 - Math.exp(-PULSE_SPOOL * dt)) : target;
      lateral.multiplyScalar(Math.exp(-PULSE_GRIP * dt));
      this.velocity.copy(nose).multiplyScalar(speed).add(lateral);
      this.thrust = 1;
      return;
    }
    const forward = input.isDown('KeyW');
    const boosting = forward && input.isDown('ShiftLeft');
    const top = boosting ? h.boostSpeed : h.maxSpeed;
    if (forward && speed < top) {
      speed = Math.min(speed + h.acceleration * (boosting ? 2 : 1) * dt, top);
    } else if (input.isDown('KeyS')) {
      speed = approach(speed, 0, 2 * h.acceleration * dt); // brake down to a hover
    }
    // Neither: cruise control, keep the speed. Above the top speed (after a boost, or diving
    // in from space), the excess bleeds off.
    if (speed > top) speed = top + (speed - top) * Math.exp(-h.drag * dt);
    // Sideways drift dies out at the grip rate - and so does moving backwards (after a hard turn).
    lateral.multiplyScalar(Math.exp(-h.grip * dt));
    if (speed < 0) speed *= Math.exp(-h.grip * dt);
    this.velocity.copy(nose).multiplyScalar(speed).add(lateral);

    this.thrust = boosting ? 1 : forward ? 0.6 : 0.12;
    this.gear = Math.max(0, this.gear - dt); // tuck the gear away
  }

  /**
   * Automatic landing onto the pose chosen by land(): glide over to the spot (the remaining
   * horizontal offset shrinks exponentially, which starts at the current speed and eases out),
   * sink onto the gear - slower the closer the ground - and turn to the resting orientation.
   */
  private descend(dt: number): void {
    this.orientation.slerp(this.targetOrientation, 1 - Math.exp(-3 * dt));
    this.gear = Math.min(1, this.gear + dt);
    this.thrust = 0.3;

    const up = this.tmp.copy(this.targetPosition).normalize();
    const offset = this.lateral.copy(this.position).sub(this.targetPosition);
    const height = offset.dot(up);
    offset.addScaledVector(up, -height); // horizontal part only
    const descent = Math.min(THREE.MathUtils.clamp(height * 1.5, 1.5, MAX_DESCENT_SPEED) * dt, height);
    offset.multiplyScalar(Math.exp(-LANDING_GLIDE_RATE * dt));

    const before = this.local.copy(this.position);
    this.position.copy(this.targetPosition).add(offset).addScaledVector(up, height - descent);
    this.velocity.subVectors(this.position, before).divideScalar(Math.max(dt, 1e-6));

    if (height - descent < 0.01 && offset.length() < 0.05) {
      this.position.copy(this.targetPosition);
      this.orientation.copy(this.targetOrientation);
      this.velocity.set(0, 0, 0);
      this.gear = 1;
      this.thrust = 0;
      this.state = 'landed';
    }
  }

  // --- Helpers ------------------------------------------------------------------------------------

  /** Leaving pulse, the ship sheds its speed down to normal space flight. */
  private dropOutOfPulse(): void {
    this.pulse = false;
    if (this.velocity.length() > SPACE.maxSpeed) this.velocity.setLength(SPACE.maxSpeed);
  }

  /** No flying into the sun: push the ship back out to STAR_CLEARANCE above its surface. */
  private avoidStar(star: Star): void {
    this.universePosition(this.universe);
    const outward = this.tmp.copy(this.universe).sub(star.position);
    const distance = outward.length();
    const minimum = star.radius + STAR_CLEARANCE;
    if (distance >= minimum) return;
    outward.divideScalar(distance);
    this.universe.addScaledVector(outward, minimum - distance);
    positionToFrame(this.frame, this.universe, this.position);
    const inward = directionToFrame(this.frame, outward, this.local);
    const into = this.velocity.dot(inward);
    if (into < 0) this.velocity.addScaledVector(inward, -into);
    if (this.pulse) this.dropOutOfPulse();
  }

  private noseDirection(): THREE.Vector3 {
    return this.nose.copy(FORWARD).applyQuaternion(this.orientation);
  }

  /** Altitude above the body's floor, and the local "up" in the ship's frame axes. */
  private measureAltitude(body: Planet): void {
    this.universePosition(this.universe);
    body.toLocal(this.universe, this.local);
    this.altitude = this.local.length() - body.radius - body.floorHeight(this.local);
    this.tmp.copy(this.universe).sub(body.position).normalize();
    directionToFrame(this.frame, this.tmp, this.up);
  }

  /** Keeps the hull CLEARANCE above the floor; moving into the ground, you slide along it. */
  private collide(body: Planet): void {
    this.measureAltitude(body);
    if (this.altitude >= CLEARANCE) return;
    this.position.addScaledVector(this.up, CLEARANCE - this.altitude);
    const into = this.velocity.dot(this.up);
    if (into < 0) this.velocity.addScaledVector(this.up, -into);
    this.altitude = CLEARANCE;
  }
}

function blendHandling(t: number): Handling {
  const mix = (a: number, b: number) => a + (b - a) * t;
  return {
    maxSpeed: mix(PLANET.maxSpeed, SPACE.maxSpeed),
    boostSpeed: mix(PLANET.boostSpeed, SPACE.boostSpeed),
    acceleration: mix(PLANET.acceleration, SPACE.acceleration),
    grip: mix(PLANET.grip, SPACE.grip),
    drag: mix(PLANET.drag, SPACE.drag),
  };
}

/** Moves `current` towards `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  return current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);
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

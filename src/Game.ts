import * as THREE from 'three';
import { FreeFlyController } from './controls/FreeFlyController';
import { PlayerController } from './controls/PlayerController';
import { Input } from './core/Input';
import { directionToFrame, orientationToFrame, orientationToUniverse, UNIVERSE_FRAME } from './core/ReferenceFrame';
import { Universe } from './core/Universe';
import { saveScreenshot } from './dev/DevTools';
import { ChunkWorkerPool } from './planet/ChunkWorkerPool';
import type { Planet } from './planet/Planet';
import { skyIrradiance, sunlightAt } from './render/atmosphere';
import { RenderPipeline } from './render/RenderPipeline';
import { createStarfield } from './render/Starfield';
import { Ship } from './ship/Ship';
import { ShipCamera } from './ship/ShipCamera';
import { DebugHud, formatDistance, formatSpeed } from './ui/DebugHud';
import { BODIES, HOME, SUN } from './world/bodies';
import { SolarSystem } from './world/SolarSystem';
import { TestBeacon } from './world/TestBeacon';

const FOV = 70; // vertical field of view, degrees
const NEAR = 0.1; // m
const FAR = 1e9; // m. The logarithmic depth buffer copes with a huge far/near ratio.

/** The jitter test from M0: a small structure 560 km from the star, beyond the outer planet. */
const BEACON_POSITION = new THREE.Vector3(0, 0, 560_000);
/** Where the player starts on HOME: local direction and facing - flat ground by a bay. */
const SPAWN_DIRECTION = new THREE.Vector3(-0.1205, -0.0173, 0.9926);
const SPAWN_HEADING = new THREE.Vector3(0.9927, 0, 0.1205);
/** Where the ship is parked at the start, relative to the spawn: metres ahead and to the right. */
const SHIP_PARKING = { ahead: 16, right: 9 };
/** How close (m, eye to ship centre) you must be to board. */
const BOARDING_RANGE = 7;
/** How long a message like "can't land on water" stays on screen, seconds. */
const MESSAGE_TIME = 2.5;
/** Starlight and airglow at night, added to the sky light (the same as the terrain's uNightLight). */
const NIGHT_LIGHT = new THREE.Vector3(0.1, 0.14, 0.28);
/** Sun elevation (degrees, rising) at the spawn point when the game starts. */
const START_SUN_ELEVATION = 25;
/** T cycles through these game-time multipliers (the day/night cycle speeds up). */
const TIME_SCALES = [1, 10, 60, 300];
/** Exposure by day and by night: a crude stand-in for the eye adapting to the dark. */
const DAY_EXPOSURE = 0.75;
const NIGHT_EXPOSURE = 3;

const HELP = `ON FOOT  mouse look (click to capture, Esc to release)
W A S D  move          Shift  sprint
Space    jump, hold for jetpack (swim up in water)
C        dive (in water)
E        board the ship (when next to it)
SHIP     mouse pitch/yaw   A/D roll   W/S throttle/brake   Shift boost
Space    take off      E  land / get out      C  chase / cockpit view
V        toggle free-fly camera (Space/C up/down, Q/E roll, wheel speed)
T        time speed x1 / x10 / x60 / x300
1-7      fly to Ember, Verdant, Lull, Rime, Sulfa, Nyx, Shard
0  respawn on foot   9  test beacon
F2 screenshot   F3 debug panel   F4 terrain LOD view   H help`;

type Mode = 'walk' | 'ship' | 'fly';

/**
 * Owns the renderer, the scene and all systems, and runs the frame loop:
 *
 *   frame: dt -> update(dt) [time -> orbits & spins -> controller -> world] -> placeCamera -> render
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
  readonly universe = new Universe();
  readonly input: Input;
  readonly hud: DebugHud;
  readonly workers: ChunkWorkerPool;
  readonly system: SolarSystem;
  /** The starting planet. */
  readonly home: Planet;
  readonly player: PlayerController;
  readonly pipeline: RenderPipeline;
  readonly flyer = new FreeFlyController();
  readonly ship = new Ship();
  readonly shipCamera = new ShipCamera();
  /** Who drives the camera: the player on foot, the ship, or the free-fly debug camera. */
  mode: Mode = 'walk';

  /** Game time in seconds (runs `timeScale` times faster than real time). */
  time = 0;
  timeScale = 1;
  /** Real seconds since start (not scaled by timeScale): animates things like waves. */
  elapsed = 0;

  /** The camera's universe pose this frame. */
  readonly cameraPosition = new THREE.Vector3();
  readonly cameraOrientation = new THREE.Quaternion();
  /** The body whose sphere of influence the camera is in, or null in open space. */
  currentBody: Planet | null = null;

  private lastFrameMs = performance.now();
  private terrainDebugView = 0;
  private readonly sunLight = new THREE.DirectionalLight();
  private readonly skyLight = new THREE.HemisphereLight();
  private readonly beacon: TestBeacon;
  private readonly clickToPlay = document.getElementById('click-to-play')!;
  private readonly help = document.getElementById('help')!;
  private readonly jetpackBar = document.getElementById('jetpack')!;
  private readonly jetpackFill = document.getElementById('jetpack-fill')!;
  private readonly prompt = document.getElementById('prompt')!;
  private message = '';
  private messageTimer = 0;

  constructor(container: HTMLElement) {
    // No canvas antialiasing: the pipeline antialiases the final image with FXAA instead.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(1); // perf target is a weak integrated GPU, see PLAN.md
    // A frame is several render() calls (scene + post passes): count them all for the HUD.
    this.renderer.info.autoReset = false;
    container.prepend(this.renderer.domElement);

    this.input = new Input(container);
    this.hud = new DebugHud(document.getElementById('debug-panel')!, () => this.debugLines());
    this.help.textContent = HELP;

    // Leave a couple of cores for the main thread and the browser.
    const workerCount = THREE.MathUtils.clamp((navigator.hardwareConcurrency || 4) - 2, 1, 4);
    this.workers = new ChunkWorkerPool(workerCount);

    // --- Scene content -------------------------------------------------------------------------
    this.universe.sky.add(createStarfield(1337));

    this.system = new SolarSystem(SUN, BODIES, this.workers);
    this.universe.root.add(this.system.star.object);
    for (const body of this.system.bodies) this.universe.root.add(body.group);
    this.home = this.system.get(HOME);

    // Lights for three's built-in materials (the ship, the beacon); see updateLights.
    this.universe.scene.add(this.sunLight, this.skyLight);

    // One ocean in the system: the composite pass draws the first body that has one.
    const oceanBody = this.system.bodies.find((body) => body.hasOcean) ?? this.home;
    this.pipeline = new RenderPipeline(this.renderer, oceanBody.ocean);

    this.beacon = new TestBeacon(BEACON_POSITION);
    this.universe.root.add(this.beacon.object);
    this.universe.root.add(this.ship.model.object);

    this.system.update(this.time, this.timeScale);
    this.player = new PlayerController(this.home);
    this.chooseStartTime(this.home, SPAWN_DIRECTION, START_SUN_ELEVATION);
    this.respawn();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  start(): void {
    this.lastFrameMs = performance.now();
    this.renderer.setAnimationLoop((nowMs) => this.frame(nowMs));
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
  }

  /** Renders the current state and returns it as a JPEG data URL (used for screenshots). */
  captureFrame(): string {
    this.render();
    // Reading the canvas right after rendering, in the same task, works without
    // preserveDrawingBuffer: the browser has not presented (and cleared) the frame yet.
    return this.renderer.domElement.toDataURL('image/jpeg', 0.92);
  }

  // --- Teleports ----------------------------------------------------------------------------------

  /** Back to the start: on foot at the spawn point, the ship parked next to it. */
  respawn(): void {
    this.mode = 'walk';
    this.player.spawn(this.home, SPAWN_DIRECTION, SPAWN_HEADING);
    const up = SPAWN_DIRECTION.clone().normalize();
    const right = new THREE.Vector3().crossVectors(SPAWN_HEADING, up).normalize();
    const parking = up
      .clone()
      .multiplyScalar(this.home.radius)
      .addScaledVector(SPAWN_HEADING, SHIP_PARKING.ahead)
      .addScaledVector(right, SHIP_PARKING.right);
    // Nose to the left and a little towards the spawn: you see it from the front three-quarters.
    this.ship.placeLanded(this.home, parking, right.clone().negate().addScaledVector(SPAWN_HEADING, -0.4));
  }

  /** On foot, near the landed ship: get in. */
  board(): void {
    this.mode = 'ship';
    this.shipCamera.reset();
  }

  /** In the landed ship: get out, beside the nose on the left (clear of the wing), facing ahead. */
  disembark(): void {
    const ship = this.ship;
    const body = ship.frame as Planet; // a landed ship is always in its body's rotating frame
    const side = new THREE.Vector3(-3.2, 0, -3.8).applyQuaternion(ship.orientation).add(ship.position);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.orientation);
    this.player.spawn(body, side, forward);
    this.mode = 'walk';
  }

  /** Can the player on foot board the ship right now? */
  private canBoard(): boolean {
    if (this.mode !== 'walk' || this.ship.state !== 'landed') return false;
    const eye = this.player.planet.toUniverse(this.player.eyePosition(new THREE.Vector3()));
    return eye.distanceTo(this.ship.universePosition(new THREE.Vector3())) < BOARDING_RANGE;
  }

  /** Free-fly camera in orbit around `body`, on its sunlit side, looking at it. */
  goToBody(body: Planet): void {
    const side = new THREE.Vector3(0, 1, 0).cross(body.sunDirection).normalize();
    const eye = body.sunDirection.clone().multiplyScalar(0.85).addScaledVector(side, 0.5).add(new THREE.Vector3(0, 0.2, 0));
    // Close enough to see detail, but inside its sphere of influence (small moons have small ones).
    eye.setLength(Math.min(body.radius * 3.4, body.config.soiRadius * 0.9)).add(body.position);
    this.mode = 'fly';
    this.flyer.set(eye, body.position);
  }

  goToBeacon(): void {
    const eye = BEACON_POSITION.clone().add(new THREE.Vector3(6, 2.5, 9));
    this.mode = 'fly';
    this.flyer.set(eye, BEACON_POSITION.clone().add(new THREE.Vector3(1, 0.5, -1)));
  }

  /**
   * Free-fly camera `height` metres above the ground of `body` at local direction `dir`, looking
   * horizontally towards `heading` (local; its vertical part is ignored). Handy from the console.
   */
  goToSurface(body: Planet, dir: THREE.Vector3, height: number, heading: THREE.Vector3, pitchDegrees = -8): void {
    const up = dir.clone().normalize();
    const eyeLocal = up.clone().multiplyScalar(body.radius + body.terrainHeight(up) + height);
    const forward = heading.clone().addScaledVector(up, -heading.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    forward.applyAxisAngle(right, THREE.MathUtils.degToRad(pitchDegrees));
    const eye = body.toUniverse(eyeLocal);
    const target = body.toUniverse(eyeLocal.clone().add(forward));
    this.mode = 'fly';
    this.flyer.set(eye, target, up.clone().applyQuaternion(body.quaternion));
  }

  /**
   * Switches between walking and the free-fly camera, keeping the view where it is. Walking
   * needs a body underneath: from open space (outside every sphere of influence) nothing happens.
   */
  toggleFly(): void {
    if (this.mode === 'ship') {
      // Leave the pilot's seat for the debug camera. The ship stays where it is, holding still.
      this.ship.velocity.set(0, 0, 0);
      this.flyer.placeInFrame(UNIVERSE_FRAME, this.cameraPosition, this.cameraOrientation);
      this.mode = 'fly';
      return;
    }
    if (this.mode === 'walk') {
      const eye = this.player.eyePosition(new THREE.Vector3());
      const orientation = this.player.eyeOrientation(new THREE.Quaternion());
      this.flyer.placeInFrame(this.player.planet, eye, orientation);
      this.mode = 'fly';
      return;
    }
    const position = this.flyer.universePosition(new THREE.Vector3());
    const body = this.system.bodyAt(position);
    if (!body) return;
    const eye = body.toLocal(position);
    const orientation = orientationToFrame(body, this.flyer.universeOrientation(new THREE.Quaternion()), new THREE.Quaternion());
    this.player.placeAtEye(body, eye, new THREE.Vector3(0, 0, -1).applyQuaternion(orientation));
    this.mode = 'walk';
  }

  // ---------------------------------------------------------------------------------------------

  private frame(nowMs: number): void {
    // Clamp dt so a stall (tab switch, breakpoint) does not teleport things.
    const dt = Math.min((nowMs - this.lastFrameMs) / 1000, 0.1);
    this.lastFrameMs = nowMs;
    this.tick(dt);
  }

  /** One full frame. Called by the animation loop, or directly by dev tools (see DevTools.ts). */
  tick(dt: number): void {
    this.update(dt);
    this.render();
    this.input.endFrame();
  }

  private update(dt: number): void {
    this.handleKeys();

    // 1. Celestial motion: game time drives every orbit and spin.
    this.time += dt * this.timeScale;
    this.system.update(this.time, this.timeScale);

    // 2. The active controller, in its reference frame -> the camera's universe pose.
    if (this.mode === 'walk') {
      const body = this.player.planet;
      this.player.update(dt, this.input);
      body.toUniverse(this.player.eyePosition(this.cameraPosition), this.cameraPosition);
      orientationToUniverse(body, this.player.eyeOrientation(this.cameraOrientation), this.cameraOrientation);
    } else if (this.mode === 'ship') {
      this.ship.update(dt, this.input, this.system);
      this.shipCamera.update(dt, this.ship, this.ship.body!, this.cameraPosition, this.cameraOrientation);
    } else {
      this.updateFreeFly(dt);
      this.flyer.universePosition(this.cameraPosition);
      this.flyer.universeOrientation(this.cameraOrientation);
    }
    this.ship.updateModel();
    this.currentBody = this.mode === 'walk' ? this.player.planet : this.system.bodyAt(this.cameraPosition);

    // 3. The world reacts to where the camera is now.
    this.elapsed += dt;
    for (const body of this.system.bodies) {
      body.update(this.cameraPosition);
      body.ocean.uTime.value = this.elapsed;
    }
    const daylight = THREE.MathUtils.smoothstep(this.sunHeight(), -0.2, 0.05);
    this.pipeline.exposure = THREE.MathUtils.lerp(NIGHT_EXPOSURE, DAY_EXPOSURE, daylight);
    this.updateLights();
    this.beacon.update(this.time);

    // 4. Last step before rendering: move the universe so the camera sits at the origin.
    this.universe.placeCamera(this.camera, this.cameraPosition, this.cameraOrientation);

    this.updateHud(dt);
  }

  private updateFreeFly(dt: number): void {
    const flyer = this.flyer;
    const position = flyer.universePosition(new THREE.Vector3());
    // The free camera's frame depends on where it is (the sphere-of-influence logic).
    flyer.setFrame(this.system.frameAt(position));

    // Level the horizon when low over a body.
    const body = this.system.nearestBody(position);
    let up: THREE.Vector3 | null = null;
    if (body.altitude(position) < body.radius) {
      const universeUp = position.clone().sub(body.position).normalize();
      up = directionToFrame(flyer.frame, universeUp, universeUp);
    }

    flyer.update(dt, this.input, this.nearestSurfaceDistance(position), up);

    // No collision for the free camera, but never let it sink into the ground.
    if (flyer.frame === body) {
      const altitude = body.altitudeOfLocal(flyer.position);
      if (altitude < 1) flyer.position.addScaledVector(flyer.position.clone().normalize(), 1 - altitude);
    }
  }

  /**
   * Picks the planet's spin phase so that, at time 0, the sun stands `elevationDegrees` above the
   * horizon at `localUp` and is rising: a morning start. Brute force over 720 candidate phases.
   */
  private chooseStartTime(body: Planet, localUp: THREE.Vector3, elevationDegrees: number): void {
    const target = Math.sin(THREE.MathUtils.degToRad(elevationDegrees));
    const up = localUp.clone().normalize();
    const sunHeight = (phase: number) => {
      body.spinPhase = phase;
      body.updateSpin(0);
      return up.clone().applyQuaternion(body.quaternion).dot(body.sunDirection);
    };
    let best = 0;
    let bestError = Infinity;
    for (let i = 0; i < 720; i++) {
      const phase = (i / 720) * Math.PI * 2;
      const height = sunHeight(phase);
      const rising = sunHeight(phase + 0.01) > height;
      const error = Math.abs(height - target);
      if (rising && error < bestError) {
        best = phase;
        bestError = error;
      }
    }
    body.spinPhase = best;
    body.updateSpin(this.time);
  }

  /**
   * Lights for three.js's built-in materials (the ship, the beacon), set to what our shaders
   * compute at the camera: sunlight after its trip through the air (red at sunset, nothing at
   * night) and the sky's glow from above. The terrain does the same maths in its own shader, so
   * the ship sits in the same light as the ground around it.
   */
  private updateLights(): void {
    const body = this.currentBody ?? this.system.nearestBody(this.cameraPosition);
    const air = body.atmosphere; // positions in it are camera-relative: the camera is at 0
    const light = sunlightAt(air, new THREE.Vector3(), new THREE.Vector3());
    this.sunLight.color.setRGB(light.x, light.y, light.z);
    this.sunLight.intensity = 1;
    this.system.star.directionFrom(this.cameraPosition, this.sunLight.position);

    // The sky glows only while you are inside the air: it fades out on the way up to space.
    const up = this.cameraPosition.clone().sub(body.position).normalize();
    const airAbove = 1 - THREE.MathUtils.smoothstep(body.altitude(this.cameraPosition), 0, air.radius - air.planetRadius);
    const sky = skyIrradiance(air, up, new THREE.Vector3()).multiplyScalar(airAbove).add(NIGHT_LIGHT);
    this.skyLight.color.setRGB(sky.x, sky.y, sky.z);
    this.skyLight.groundColor.setRGB(sky.x * 0.3, sky.y * 0.3, sky.z * 0.3);
    this.skyLight.intensity = 1;
    this.skyLight.position.copy(up); // a HemisphereLight's position is its "up" direction
  }

  private render(): void {
    this.renderer.info.reset();
    this.pipeline.render(this.universe.scene, this.camera, this.system.bodies.map((body) => body.atmosphere));
  }

  private handleKeys(): void {
    const input = this.input;
    for (let i = 0; i < this.system.bodies.length && i < 9; i++) {
      if (input.wasPressed(`Digit${i + 1}`)) this.goToBody(this.system.bodies[i]);
    }
    if (input.wasPressed('Digit9')) this.goToBeacon();
    if (input.wasPressed('Digit0')) this.respawn();
    if (input.wasPressed('KeyV')) this.toggleFly();
    if (input.wasPressed('KeyE')) {
      if (this.canBoard()) this.board();
      else if (this.mode === 'ship' && this.ship.state === 'landed') this.disembark();
      else if (this.mode === 'ship' && this.ship.canLand) this.showMessage(this.ship.land());
    }
    if (input.wasPressed('KeyC') && this.mode === 'ship') {
      this.shipCamera.view = this.shipCamera.view === 'chase' ? 'cockpit' : 'chase';
    }
    if (input.wasPressed('KeyT')) {
      this.timeScale = TIME_SCALES[(TIME_SCALES.indexOf(this.timeScale) + 1) % TIME_SCALES.length];
    }
    if (input.wasPressed('F2')) void saveScreenshot(this, 'shot', false);
    if (input.wasPressed('F3')) this.hud.visible = !this.hud.visible;
    if (input.wasPressed('F4')) {
      this.terrainDebugView = (this.terrainDebugView + 1) % 3;
      for (const body of this.system.bodies) body.setDebugView(this.terrainDebugView);
    }
    if (input.wasPressed('KeyH')) this.help.classList.toggle('hidden');
  }

  /** Distance from `p` to the closest thing you could fly into (drives the free-fly speed). */
  private nearestSurfaceDistance(p: THREE.Vector3): number {
    const beaconDistance = p.distanceTo(BEACON_POSITION) - 10;
    return Math.max(0, Math.min(this.system.surfaceDistance(p), beaconDistance));
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.parentElement!.clientWidth;
    const height = canvas.parentElement!.clientHeight;
    this.renderer.setSize(width, height, false);
    this.pipeline.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private updateHud(dt: number): void {
    this.messageTimer = Math.max(0, this.messageTimer - dt);
    this.clickToPlay.classList.toggle('hidden', this.input.pointerLocked);
    this.jetpackBar.classList.toggle('hidden', this.mode !== 'walk');
    this.jetpackFill.style.width = `${(this.player.jetpackFuel * 100).toFixed(1)}%`;
    this.prompt.textContent = this.promptText();
    this.hud.update(dt);
  }

  /** The context hint at the bottom of the screen: which key does what right now. */
  private promptText(): string {
    if (this.messageTimer > 0) return this.message;
    if (this.canBoard()) return '[E] board the ship';
    if (this.mode !== 'ship') return '';
    if (this.ship.state === 'landed') return '[Space] take off    [E] get out    [C] view';
    if (this.ship.canLand) return '[E] land';
    return '';
  }

  /** Shows a short message in place of the prompt (null: nothing to say). */
  private showMessage(text: string | null): void {
    if (!text) return;
    this.message = text;
    this.messageTimer = MESSAGE_TIME;
  }

  /**
   * Sine of the sun's elevation above the horizon at the camera, relative to the body it is at
   * (-1..1). Out in open space the sun is always "up".
   */
  private sunHeight(): number {
    const body = this.currentBody;
    if (!body) return 1;
    const up = this.cameraPosition.clone().sub(body.position).normalize();
    return up.dot(body.sunDirection);
  }

  private debugLines(): string[] {
    const p = this.cameraPosition;
    const info = this.renderer.info.render;
    const body = this.currentBody ?? this.system.nearestBody(p);
    const elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(this.sunHeight(), -1, 1)));
    const player = this.player;
    const frame = this.mode === 'fly' ? this.flyer.frame.name : this.mode === 'ship' ? `${this.ship.frame.name} (ship)` : `${player.planet.name} (on foot)`;
    const motion = this.mode === 'ship'
      ? `ship    ${this.ship.state}  ${formatSpeed(this.ship.speed)}  alt ${formatDistance(this.ship.altitude)}  ${this.ship.spaceFactor < 0.5 ? 'air' : 'space'} flight (${this.ship.spaceFactor.toFixed(2)})`
      : this.mode === 'fly'
      ? `fly     ${formatSpeed(this.flyer.velocity.length())}  (wheel x${2 ** this.flyer.speedExponent})`
      : `walk    ${formatSpeed(player.speed)}  ${player.swimming ? 'swimming' : player.grounded ? 'on ground' : 'in the air'}, jetpack ${(player.jetpackFuel * 100).toFixed(0)}%`;
    const stats = { visible: 0, meshes: 0 };
    for (const b of this.system.bodies) {
      stats.visible += b.terrain.stats.visible;
      stats.meshes += b.terrain.stats.meshes;
    }
    return [
      `pos     x ${p.x.toFixed(0)}  y ${p.y.toFixed(0)}  z ${p.z.toFixed(0)}  (${formatDistance(p.length())} from the star)`,
      `near    ${body.name}: altitude ${formatDistance(body.altitude(p))}, ${formatDistance(p.distanceTo(body.position))} from centre`,
      `frame   ${frame}`,
      motion,
      `time    x${this.timeScale}  sun ${elevation >= 0 ? '+' : ''}${elevation.toFixed(0)}° ${elevation > 0 ? 'day' : 'night'}`,
      `terrain ${stats.visible} chunks drawn / ${stats.meshes} built, deepest here L${body.terrain.stats.deepestVisible} of ${body.terrain.maxLevel}`,
      `workers ${this.workers.runningCount} busy, ${this.workers.queuedCount} queued`,
      `gpu     ${info.calls} draws, ${(info.triangles / 1000).toFixed(0)}k tris`,
    ];
  }
}

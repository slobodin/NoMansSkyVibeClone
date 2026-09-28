import * as THREE from 'three';
import { FreeFlyController } from './controls/FreeFlyController';
import { PlayerController } from './controls/PlayerController';
import { Input } from './core/Input';
import { directionToFrame, orientationToFrame, orientationToUniverse, UNIVERSE_FRAME, type ReferenceFrame } from './core/ReferenceFrame';
import { Universe } from './core/Universe';
import { saveScreenshot } from './dev/DevTools';
import { ChunkWorkerPool } from './planet/ChunkWorkerPool';
import type { Planet } from './planet/Planet';
import { RenderPipeline } from './render/RenderPipeline';
import { createStarfield } from './render/Starfield';
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
/** Sun elevation (degrees, rising) at the spawn point when the game starts. */
const START_SUN_ELEVATION = 25;
/** Within this many radii of a body the free camera turns with it (hovering over the ground). */
const ROTATING_FRAME_RADII = 3;
/** T cycles through these game-time multipliers (the day/night cycle speeds up). */
const TIME_SCALES = [1, 10, 60, 300];
/** Exposure by day and by night: a crude stand-in for the eye adapting to the dark. */
const DAY_EXPOSURE = 0.75;
const NIGHT_EXPOSURE = 3;

const HELP = `mouse    look (click to capture, Esc to release)
W A S D  move          Shift  sprint
Space    jump, hold for jetpack (swim up in water)
C        dive (in water)
V        toggle free-fly camera (Space/C up/down, Q/E roll, wheel speed)
T        time speed x1 / x10 / x60 / x300
1-7      fly to Ember, Verdant, Lull, Rime, Sulfa, Nyx, Shard
0  respawn on foot   9  test beacon
F2 screenshot   F3 debug panel   F4 terrain LOD view   H help`;

type Mode = 'walk' | 'fly';

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
  /** Which controller drives the camera: walking on a body, or the free-fly debug camera. */
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
  private readonly sunLight: THREE.DirectionalLight;
  private readonly beacon: TestBeacon;
  private readonly clickToPlay = document.getElementById('click-to-play')!;
  private readonly help = document.getElementById('help')!;
  private readonly jetpackBar = document.getElementById('jetpack')!;
  private readonly jetpackFill = document.getElementById('jetpack-fill')!;

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

    // Lights for three's built-in materials (the beacon). The terrain has its own shader.
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 3);
    this.universe.scene.add(this.sunLight, new THREE.AmbientLight(0x404a66, 0.6));

    // One ocean in the system: the composite pass draws the first body that has one.
    const oceanBody = this.system.bodies.find((body) => body.hasOcean) ?? this.home;
    this.pipeline = new RenderPipeline(this.renderer, oceanBody.ocean);

    this.beacon = new TestBeacon(BEACON_POSITION);
    this.universe.root.add(this.beacon.object);

    this.system.update(this.time);
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

  respawn(): void {
    this.mode = 'walk';
    this.player.spawn(this.home, SPAWN_DIRECTION, SPAWN_HEADING);
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
    this.system.update(this.time);

    // 2. The active controller, in its reference frame -> the camera's universe pose.
    if (this.mode === 'walk') {
      const body = this.player.planet;
      this.player.update(dt, this.input);
      body.toUniverse(this.player.eyePosition(this.cameraPosition), this.cameraPosition);
      orientationToUniverse(body, this.player.eyeOrientation(this.cameraOrientation), this.cameraOrientation);
    } else {
      this.updateFreeFly(dt);
      this.flyer.universePosition(this.cameraPosition);
      this.flyer.universeOrientation(this.cameraOrientation);
    }
    this.currentBody = this.mode === 'walk' ? this.player.planet : this.system.bodyAt(this.cameraPosition);

    // 3. The world reacts to where the camera is now.
    this.elapsed += dt;
    for (const body of this.system.bodies) {
      body.update(this.cameraPosition);
      body.ocean.uTime.value = this.elapsed;
    }
    const daylight = THREE.MathUtils.smoothstep(this.sunHeight(), -0.2, 0.05);
    this.pipeline.exposure = THREE.MathUtils.lerp(NIGHT_EXPOSURE, DAY_EXPOSURE, daylight);
    this.system.star.directionFrom(this.cameraPosition, this.sunLight.position);
    this.beacon.update(this.time);

    // 4. Last step before rendering: move the universe so the camera sits at the origin.
    this.universe.placeCamera(this.camera, this.cameraPosition, this.cameraOrientation);

    this.updateHud(dt);
  }

  /**
   * The free camera's frame depends on where it is (its "sphere of influence" logic):
   *   close to a body   -> the body's rotating frame: hover over the same spot as it spins
   *   within its SOI    -> the body's inertial frame: follow it around its orbit, no spin
   *   in open space     -> the universe frame: stay put relative to the star
   */
  private freeFlyFrame(position: THREE.Vector3): ReferenceFrame {
    const body = this.system.bodyAt(position);
    if (!body) return UNIVERSE_FRAME;
    const close = position.distanceTo(body.position) < body.radius * ROTATING_FRAME_RADII;
    return close ? body : body.inertialFrame;
  }

  private updateFreeFly(dt: number): void {
    const flyer = this.flyer;
    const position = flyer.universePosition(new THREE.Vector3());
    flyer.setFrame(this.freeFlyFrame(position));

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
    this.clickToPlay.classList.toggle('hidden', this.input.pointerLocked);
    this.jetpackBar.classList.toggle('hidden', this.mode !== 'walk');
    this.jetpackFill.style.width = `${(this.player.jetpackFuel * 100).toFixed(1)}%`;
    this.hud.update(dt);
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
    const frame = this.mode === 'fly' ? this.flyer.frame.name : `${player.planet.name} (on foot)`;
    const motion = this.mode === 'fly'
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

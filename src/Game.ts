import * as THREE from 'three';
import { FreeFlyController } from './controls/FreeFlyController';
import { PlayerController } from './controls/PlayerController';
import { Input } from './core/Input';
import { directionToFrame, orientationToFrame, orientationToUniverse, UNIVERSE_FRAME } from './core/ReferenceFrame';
import { Universe } from './core/Universe';
import { saveScreenshot } from './dev/DevTools';
import { ChunkWorkerPool } from './planet/ChunkWorkerPool';
import { Planet } from './planet/Planet';
import { createStarfield } from './render/Starfield';
import { DebugHud, formatDistance, formatSpeed } from './ui/DebugHud';
import { VERDANT } from './world/bodies';
import { Star } from './world/Star';
import { TestBeacon } from './world/TestBeacon';

const FOV = 70; // vertical field of view, degrees
const NEAR = 0.1; // m
const FAR = 1e9; // m. The logarithmic depth buffer copes with a huge far/near ratio.

// The star sits at the universe origin; Verdant 180 km away (no orbits until M3).
const STAR_POSITION = new THREE.Vector3(0, 0, 0);
const PLANET_POSITION = new THREE.Vector3(-1, -0.35, -0.55).setLength(180_000);
/** The jitter test from M0: a small structure 500 km from the planet. */
const BEACON_POSITION = PLANET_POSITION.clone().add(new THREE.Vector3(500_000, 0, 0));
/** Where the player starts: planet-local direction and facing - flat ground in a valley by a bay. */
const SPAWN_DIRECTION = new THREE.Vector3(-0.1205, -0.0173, 0.9926);
const SPAWN_HEADING = new THREE.Vector3(0.9927, 0, 0.1205);
/** Sun elevation (degrees, rising) at the spawn point when the game starts. */
const START_SUN_ELEVATION = 25;
/** Within this many planet radii the free camera rides along with the planet's rotation. */
const PLANET_FRAME_RADII = 3;
/** T cycles through these game-time multipliers (the day/night cycle speeds up). */
const TIME_SCALES = [1, 10, 60, 300];

const HELP = `mouse    look (click to capture, Esc to release)
W A S D  move          Shift  sprint
Space    jump, hold for jetpack (swim up in water)
C        dive (in water)
V        toggle free-fly camera (Space/C up/down, Q/E roll, wheel speed)
T        time speed x1 / x10 / x60 / x300
1  orbit   2  test beacon (500 km out)   3  respawn on foot
F2 screenshot   F3 debug panel   F4 terrain LOD view   H help`;

type Mode = 'walk' | 'fly';

/**
 * Owns the renderer, the scene and all systems, and runs the frame loop:
 *
 *   frame: dt -> update(dt) [time -> planet spin -> controller -> world] -> placeCamera -> render
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
  readonly universe = new Universe();
  readonly input: Input;
  readonly hud: DebugHud;
  readonly workers: ChunkWorkerPool;
  readonly star: Star;
  readonly planet: Planet;
  readonly player: PlayerController;
  readonly flyer = new FreeFlyController();
  /** Which controller drives the camera: walking on the planet, or the free-fly debug camera. */
  mode: Mode = 'walk';
  /** Unit vector from the planet towards the sun, universe axes. */
  readonly sunDirection = new THREE.Vector3();

  /** Game time in seconds (runs `timeScale` times faster than real time). */
  time = 0;
  timeScale = 1;

  /** The camera's universe pose this frame. */
  readonly cameraPosition = new THREE.Vector3();
  readonly cameraOrientation = new THREE.Quaternion();

  private lastFrameMs = performance.now();
  private terrainDebugView = 0;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly beacon: TestBeacon;
  private readonly clickToPlay = document.getElementById('click-to-play')!;
  private readonly help = document.getElementById('help')!;
  private readonly jetpackBar = document.getElementById('jetpack')!;
  private readonly jetpackFill = document.getElementById('jetpack-fill')!;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(1); // perf target is a weak integrated GPU, see PLAN.md
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.prepend(this.renderer.domElement);

    this.input = new Input(container);
    this.hud = new DebugHud(document.getElementById('debug-panel')!, () => this.debugLines());
    this.help.textContent = HELP;

    // Leave a couple of cores for the main thread and the browser.
    const workerCount = THREE.MathUtils.clamp((navigator.hardwareConcurrency || 4) - 2, 1, 4);
    this.workers = new ChunkWorkerPool(workerCount);

    // --- Scene content -------------------------------------------------------------------------
    this.universe.sky.add(createStarfield(1337));

    this.star = new Star('Sol', STAR_POSITION, 4000, new THREE.Color(1.0, 0.93, 0.82));
    this.universe.root.add(this.star.object);

    // Lights for three's built-in materials (the beacon). The terrain has its own shader.
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 3);
    this.universe.scene.add(this.sunLight, new THREE.AmbientLight(0x404a66, 0.6));

    this.planet = new Planet(VERDANT, PLANET_POSITION, this.workers);
    this.universe.root.add(this.planet.group);
    this.star.directionFrom(this.planet.position, this.sunDirection);

    this.beacon = new TestBeacon(BEACON_POSITION);
    this.universe.root.add(this.beacon.object);

    this.player = new PlayerController(this.planet);
    this.chooseStartTime(SPAWN_DIRECTION, START_SUN_ELEVATION);
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
    this.player.spawn(SPAWN_DIRECTION, SPAWN_HEADING);
  }

  goToOrbit(): void {
    // On the sunlit side, a little off the planet-sun line.
    const eye = new THREE.Vector3(0.2, 0.35, 0.92).setLength(32_000).add(this.planet.position);
    this.mode = 'fly';
    this.flyer.set(eye, this.planet.position);
  }

  goToBeacon(): void {
    const eye = BEACON_POSITION.clone().add(new THREE.Vector3(6, 2.5, 9));
    this.mode = 'fly';
    this.flyer.set(eye, BEACON_POSITION.clone().add(new THREE.Vector3(1, 0.5, -1)));
  }

  /**
   * Free-fly camera `height` metres above the ground at planet-local direction `dir`, looking
   * horizontally towards `heading` (planet-local; its vertical part is ignored).
   */
  goToSurface(dir: THREE.Vector3, height: number, heading: THREE.Vector3, pitchDegrees = -8): void {
    const up = dir.clone().normalize();
    const ground = this.planet.radius + this.planet.terrainHeight(up);
    const eyeLocal = up.clone().multiplyScalar(ground + height);
    const forward = heading.clone().addScaledVector(up, -heading.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    forward.applyAxisAngle(right, THREE.MathUtils.degToRad(pitchDegrees));
    const eye = this.planet.toUniverse(eyeLocal);
    const target = this.planet.toUniverse(eyeLocal.clone().add(forward));
    this.mode = 'fly';
    this.flyer.set(eye, target, up.clone().applyQuaternion(this.planet.quaternion));
  }

  /** Switches between walking and the free-fly camera, keeping the view where it is. */
  toggleFly(): void {
    if (this.mode === 'walk') {
      const eye = this.player.eyePosition(new THREE.Vector3());
      const orientation = this.player.eyeOrientation(new THREE.Quaternion());
      this.flyer.placeInFrame(this.planet, eye, orientation);
      this.mode = 'fly';
    } else {
      const eye = this.planet.toLocal(this.flyer.universePosition(new THREE.Vector3()));
      const orientation = orientationToFrame(this.planet, this.flyer.universeOrientation(new THREE.Quaternion()), new THREE.Quaternion());
      this.player.placeAtEye(eye, new THREE.Vector3(0, 0, -1).applyQuaternion(orientation));
      this.mode = 'walk';
    }
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

    // 1. Celestial motion: game time drives the planet's spin.
    this.time += dt * this.timeScale;
    this.planet.updateSpin(this.time);
    this.star.directionFrom(this.planet.position, this.sunDirection);

    // 2. The active controller, in its reference frame -> the camera's universe pose.
    if (this.mode === 'walk') {
      this.player.update(dt, this.input);
      this.planet.toUniverse(this.player.eyePosition(this.cameraPosition), this.cameraPosition);
      orientationToUniverse(this.planet, this.player.eyeOrientation(this.cameraOrientation), this.cameraOrientation);
    } else {
      this.updateFreeFly(dt);
      this.flyer.universePosition(this.cameraPosition);
      this.flyer.universeOrientation(this.cameraOrientation);
    }

    // 3. The world reacts to where the camera is now.
    this.planet.update(this.cameraPosition, this.sunDirection);
    this.star.directionFrom(this.cameraPosition, this.sunLight.position);
    this.beacon.update(this.time);

    // 4. Last step before rendering: move the universe so the camera sits at the origin.
    this.universe.placeCamera(this.camera, this.cameraPosition, this.cameraOrientation);

    this.updateHud(dt);
  }

  private updateFreeFly(dt: number): void {
    const flyer = this.flyer;
    const position = flyer.universePosition(new THREE.Vector3());

    // Close to the planet the camera rides along with its rotation (it hovers over the same
    // spot while the sun moves); further out it stays put relative to the stars.
    const nearPlanet = position.distanceTo(this.planet.position) < this.planet.radius * PLANET_FRAME_RADII;
    flyer.setFrame(nearPlanet ? this.planet : UNIVERSE_FRAME);

    // Level the horizon when low over the planet.
    let up: THREE.Vector3 | null = null;
    if (this.planet.altitude(position) < this.planet.radius) {
      const universeUp = position.clone().sub(this.planet.position).normalize();
      up = directionToFrame(flyer.frame, universeUp, universeUp);
    }

    flyer.update(dt, this.input, this.nearestSurfaceDistance(position), up);

    // No collision for the free camera, but never let it sink into the ground.
    if (flyer.frame === this.planet) {
      const altitude = this.planet.altitudeOfLocal(flyer.position);
      if (altitude < 1) flyer.position.addScaledVector(flyer.position.clone().normalize(), 1 - altitude);
    }
  }

  /**
   * Picks the planet's spin phase so that, at time 0, the sun stands `elevationDegrees` above the
   * horizon at `localUp` and is rising: a morning start. Brute force over 720 candidate phases.
   */
  private chooseStartTime(localUp: THREE.Vector3, elevationDegrees: number): void {
    const target = Math.sin(THREE.MathUtils.degToRad(elevationDegrees));
    const up = localUp.clone().normalize();
    const sunHeight = (phase: number) => {
      this.planet.spinPhase = phase;
      this.planet.updateSpin(0);
      return up.clone().applyQuaternion(this.planet.quaternion).dot(this.sunDirection);
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
    this.planet.spinPhase = best;
    this.planet.updateSpin(this.time);
  }

  private render(): void {
    this.renderer.render(this.universe.scene, this.camera);
  }

  private handleKeys(): void {
    const input = this.input;
    if (input.wasPressed('Digit1')) this.goToOrbit();
    if (input.wasPressed('Digit2')) this.goToBeacon();
    if (input.wasPressed('Digit3')) this.respawn();
    if (input.wasPressed('KeyV')) this.toggleFly();
    if (input.wasPressed('KeyT')) {
      this.timeScale = TIME_SCALES[(TIME_SCALES.indexOf(this.timeScale) + 1) % TIME_SCALES.length];
    }
    if (input.wasPressed('F2')) void saveScreenshot(this, 'shot', false);
    if (input.wasPressed('F3')) this.hud.visible = !this.hud.visible;
    if (input.wasPressed('F4')) {
      this.terrainDebugView = (this.terrainDebugView + 1) % 3;
      this.planet.setDebugView(this.terrainDebugView);
    }
    if (input.wasPressed('KeyH')) this.help.classList.toggle('hidden');
  }

  /** Distance from `p` to the closest thing you could fly into (drives the free-fly speed). */
  private nearestSurfaceDistance(p: THREE.Vector3): number {
    const beaconDistance = p.distanceTo(BEACON_POSITION) - 10;
    const starDistance = p.distanceTo(STAR_POSITION) - this.star.radius;
    return Math.max(0, Math.min(this.planet.altitude(p), beaconDistance, starDistance));
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.parentElement!.clientWidth;
    const height = canvas.parentElement!.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private updateHud(dt: number): void {
    this.clickToPlay.classList.toggle('hidden', this.input.pointerLocked);
    this.jetpackBar.classList.toggle('hidden', this.mode !== 'walk');
    this.jetpackFill.style.width = `${(this.player.jetpackFuel * 100).toFixed(1)}%`;
    this.hud.update(dt);
  }

  /** Sun elevation above the horizon at the camera, in degrees. */
  private sunElevation(): number {
    const up = this.cameraPosition.clone().sub(this.planet.position).normalize();
    return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(up.dot(this.sunDirection), -1, 1)));
  }

  private debugLines(): string[] {
    const p = this.cameraPosition;
    const info = this.renderer.info.render;
    const terrain = this.planet.terrain.stats;
    const elevation = this.sunElevation();
    const player = this.player;
    const motion = this.mode === 'fly'
      ? `fly     ${formatSpeed(this.flyer.velocity.length())}  (wheel x${2 ** this.flyer.speedExponent}, frame: ${this.flyer.frame.name})`
      : `walk    ${formatSpeed(player.speed)}  ${player.swimming ? 'swimming' : player.grounded ? 'on ground' : 'in the air'}, jetpack ${(player.jetpackFuel * 100).toFixed(0)}%`;
    return [
      `pos     x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}  z ${p.z.toFixed(2)}`,
      `planet  ${formatDistance(p.distanceTo(this.planet.position))} from centre, altitude ${formatDistance(this.planet.altitude(p))}`,
      motion,
      `time    x${this.timeScale}  sun ${elevation >= 0 ? '+' : ''}${elevation.toFixed(0)}° ${elevation > 0 ? 'day' : 'night'}`,
      `terrain ${terrain.visible} chunks drawn / ${terrain.meshes} built, deepest L${terrain.deepestVisible} of ${this.planet.terrain.maxLevel}`,
      `workers ${this.workers.runningCount} busy, ${this.workers.queuedCount} queued`,
      `gpu     ${info.calls} draws, ${(info.triangles / 1000).toFixed(0)}k tris`,
    ];
  }
}

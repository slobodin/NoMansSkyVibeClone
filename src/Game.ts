import * as THREE from 'three';
import { FreeFlyController } from './controls/FreeFlyController';
import { Input } from './core/Input';
import { directionToFrame, UNIVERSE_FRAME } from './core/ReferenceFrame';
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
/** Within this many planet radii the free camera rides along with the planet's rotation. */
const PLANET_FRAME_RADII = 3;
/** T cycles through these game-time multipliers (the day/night cycle speeds up). */
const TIME_SCALES = [1, 10, 60, 300];

const HELP = `mouse    look (click to capture, Esc to release)
W A S D  move        Space / C  up / down
Q / E    roll        Shift      boost
wheel    speed x2 / x0.5
T  time speed x1 / x10 / x60 / x300
1  orbit   2  test beacon (500 km out)   3  surface
F2 screenshot   F3 debug panel   F4 terrain LOD view   H help`;

/**
 * Owns the renderer, the scene and all systems, and runs the frame loop:
 *
 *   frame: dt -> update(dt) [time -> planet spin -> controllers -> world] -> placeCamera -> render
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
  readonly universe = new Universe();
  readonly input: Input;
  readonly flyer = new FreeFlyController();
  readonly hud: DebugHud;
  readonly workers: ChunkWorkerPool;
  readonly star: Star;
  readonly planet: Planet;
  /** Unit vector from the planet towards the sun, universe axes. */
  readonly sunDirection = new THREE.Vector3();

  /** Game time in seconds (runs `timeScale` times faster than real time). */
  time = 0;
  timeScale = 1;

  /** The camera's universe pose this frame. */
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraOrientation = new THREE.Quaternion();

  private lastFrameMs = performance.now();
  private terrainDebugView = 0;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly beacon: TestBeacon;
  private readonly clickToPlay = document.getElementById('click-to-play')!;
  private readonly help = document.getElementById('help')!;

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

    this.beacon = new TestBeacon(BEACON_POSITION);
    this.universe.root.add(this.beacon.object);

    this.planet.updateSpin(this.time);
    this.goToOrbit();

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

  goToOrbit(): void {
    // On the sunlit side, a little off the planet-sun line.
    const eye = new THREE.Vector3(0.2, 0.35, 0.92).setLength(32_000).add(this.planet.position);
    this.flyer.set(eye, this.planet.position);
  }

  goToBeacon(): void {
    const eye = BEACON_POSITION.clone().add(new THREE.Vector3(6, 2.5, 9));
    this.flyer.set(eye, BEACON_POSITION.clone().add(new THREE.Vector3(1, 0.5, -1)));
  }

  /**
   * Puts the camera `height` metres above the ground at planet-local direction `dir`, looking
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
    this.flyer.set(eye, target, up.clone().applyQuaternion(this.planet.quaternion));
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

    // 2. Controllers, in their reference frames.
    this.updateFreeFly(dt);
    this.flyer.universePosition(this.cameraPosition);
    this.flyer.universeOrientation(this.cameraOrientation);

    // 3. The world reacts to where the camera is now.
    this.planet.update(this.cameraPosition, this.sunDirection);
    this.star.directionFrom(this.cameraPosition, this.sunLight.position);
    this.beacon.update(this.time);

    // 4. Last step before rendering: move the universe so the camera sits at the origin.
    this.universe.placeCamera(this.camera, this.cameraPosition, this.cameraOrientation);

    this.clickToPlay.classList.toggle('hidden', this.input.pointerLocked);
    this.hud.update(dt);
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

  private render(): void {
    this.renderer.render(this.universe.scene, this.camera);
  }

  private handleKeys(): void {
    const input = this.input;
    if (input.wasPressed('Digit1')) this.goToOrbit();
    if (input.wasPressed('Digit2')) this.goToBeacon();
    if (input.wasPressed('Digit3')) this.goToSurface(new THREE.Vector3(0.042, 0.468, 0.883), 30, new THREE.Vector3(-1, 0, 0));
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
    return [
      `pos     x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}  z ${p.z.toFixed(2)}`,
      `planet  ${formatDistance(p.distanceTo(this.planet.position))} from centre, altitude ${formatDistance(this.planet.altitude(p))}`,
      `speed   ${formatSpeed(this.flyer.velocity.length())}  (wheel x${2 ** this.flyer.speedExponent}, frame: ${this.flyer.frame.name})`,
      `time    x${this.timeScale}  sun ${elevation >= 0 ? '+' : ''}${elevation.toFixed(0)}° ${elevation > 0 ? 'day' : 'night'}`,
      `terrain ${terrain.visible} chunks drawn / ${terrain.meshes} built, deepest L${terrain.deepestVisible} of ${this.planet.terrain.maxLevel}`,
      `workers ${this.workers.runningCount} busy, ${this.workers.queuedCount} queued`,
      `gpu     ${info.calls} draws, ${(info.triangles / 1000).toFixed(0)}k tris`,
    ];
  }
}

import * as THREE from 'three';
import { FreeFlyController } from './controls/FreeFlyController';
import { Input } from './core/Input';
import { Universe } from './core/Universe';
import { saveScreenshot } from './dev/DevTools';
import { ChunkWorkerPool } from './planet/ChunkWorkerPool';
import { Planet } from './planet/Planet';
import { createStarfield } from './render/Starfield';
import { DebugHud, formatDistance, formatSpeed } from './ui/DebugHud';
import { VERDANT } from './world/bodies';
import { TestBeacon } from './world/TestBeacon';

const FOV = 70; // vertical field of view, degrees
const NEAR = 0.1; // m
const FAR = 1e9; // m. The logarithmic depth buffer copes with a huge far/near ratio.

/** The jitter test from M0: a small structure 500 km from the planet. */
const BEACON_POSITION = new THREE.Vector3(500_000, 0, 0);

const HELP = `mouse    look (click to capture, Esc to release)
W A S D  move        Space / C  up / down
Q / E    roll        Shift      boost
wheel    speed x2 / x0.5
1  orbit   2  test beacon (500 km out)   3  surface
F2 screenshot   F3 debug panel   F4 terrain LOD view   H help`;

/**
 * Owns the renderer, the scene and all systems, and runs the frame loop:
 *
 *   frame: dt -> update(dt) [input -> controllers -> world] -> placeCamera -> render
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
  readonly universe = new Universe();
  readonly input: Input;
  readonly flyer = new FreeFlyController();
  readonly hud: DebugHud;
  readonly workers: ChunkWorkerPool;
  readonly planet: Planet;
  /** Unit vector pointing towards the sun (fixed for now; the star system comes in M3). */
  readonly sunDirection = new THREE.Vector3(1, 0.35, 0.55).normalize();

  /** Game time in seconds since start. */
  time = 0;

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

    // Lights for three's built-in materials (the beacon). The terrain has its own shader.
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 3);
    this.sunLight.position.copy(this.sunDirection); // a directional light only needs a direction
    this.universe.scene.add(this.sunLight, new THREE.AmbientLight(0x404a66, 0.6));

    this.planet = new Planet(VERDANT, new THREE.Vector3(0, 0, 0), this.workers);
    this.universe.root.add(this.planet.group);

    this.beacon = new TestBeacon(BEACON_POSITION);
    this.universe.root.add(this.beacon.object);

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
    const eye = new THREE.Vector3(0.2, 0.35, 0.92).setLength(32_000).add(this.planet.position);
    this.flyer.set(eye, this.planet.position);
  }

  goToBeacon(): void {
    const eye = BEACON_POSITION.clone().add(new THREE.Vector3(6, 2.5, 9));
    this.flyer.set(eye, BEACON_POSITION.clone().add(new THREE.Vector3(1, 0.5, -1)));
  }

  /**
   * Puts the camera `height` metres above the ground in planet-local direction `dir`, looking
   * horizontally towards `heading` (any vector; its vertical part is ignored).
   */
  goToSurface(dir: THREE.Vector3, height: number, heading: THREE.Vector3, pitchDegrees = -8): void {
    const up = dir.clone().normalize();
    const ground = this.planet.radius + this.planet.terrainHeight(up);
    const eyeLocal = up.clone().multiplyScalar(ground + height);
    const forward = heading.clone().addScaledVector(up, -heading.dot(up)).normalize();
    forward.applyAxisAngle(new THREE.Vector3().crossVectors(forward, up).normalize(), THREE.MathUtils.degToRad(pitchDegrees));
    const eye = this.planet.toUniverse(eyeLocal);
    const target = this.planet.toUniverse(eyeLocal.clone().add(forward));
    this.flyer.set(eye, target, up);
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
    this.time += dt;
    this.handleKeys();

    const p = this.flyer.position;
    const altitude = this.planet.altitude(p);
    const up = altitude < this.planet.radius ? p.clone().sub(this.planet.position).normalize() : null;
    this.flyer.update(dt, this.input, this.nearestSurfaceDistance(p), up);
    this.keepAboveGround(this.flyer.position, 1);

    this.beacon.update(this.time);
    this.planet.update(this.flyer.position, this.sunDirection);

    // Last step before rendering: move the universe so the camera sits at the origin.
    this.universe.placeCamera(this.camera, this.flyer.position, this.flyer.orientation);

    this.clickToPlay.classList.toggle('hidden', this.input.pointerLocked);
    this.hud.update(dt);
  }

  private render(): void {
    this.renderer.render(this.universe.scene, this.camera);
  }

  private handleKeys(): void {
    const input = this.input;
    if (input.wasPressed('Digit1')) this.goToOrbit();
    if (input.wasPressed('Digit2')) this.goToBeacon();
    if (input.wasPressed('Digit3')) this.goToSurface(new THREE.Vector3(0.35, 0.3, 0.88), 40, new THREE.Vector3(1, 0, 0));
    if (input.wasPressed('F2')) void saveScreenshot(this, 'shot', false);
    if (input.wasPressed('F3')) this.hud.visible = !this.hud.visible;
    if (input.wasPressed('F4')) {
      this.terrainDebugView = (this.terrainDebugView + 1) % 3;
      this.planet.setDebugView(this.terrainDebugView);
    }
    if (input.wasPressed('KeyH')) this.help.classList.toggle('hidden');
  }

  /** The free-fly camera has no collision, but it should not sink into the ground either. */
  private keepAboveGround(position: THREE.Vector3, clearance: number): void {
    const altitude = this.planet.altitude(position);
    if (altitude >= clearance) return;
    const up = position.clone().sub(this.planet.position).normalize();
    position.addScaledVector(up, clearance - altitude);
  }

  /** Distance from `p` to the closest thing you could fly into (drives the free-fly speed). */
  private nearestSurfaceDistance(p: THREE.Vector3): number {
    const beaconDistance = p.distanceTo(BEACON_POSITION) - 10;
    return Math.max(0, Math.min(this.planet.altitude(p), beaconDistance));
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.parentElement!.clientWidth;
    const height = canvas.parentElement!.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private debugLines(): string[] {
    const p = this.flyer.position;
    const info = this.renderer.info.render;
    const terrain = this.planet.terrain.stats;
    return [
      `pos     x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}  z ${p.z.toFixed(2)}`,
      `planet  ${formatDistance(p.distanceTo(this.planet.position))} from centre, altitude ${formatDistance(this.planet.altitude(p))}`,
      `speed   ${formatSpeed(this.flyer.velocity.length())}  (wheel x${2 ** this.flyer.speedExponent})`,
      `terrain ${terrain.visible} chunks drawn / ${terrain.meshes} built, deepest L${terrain.deepestVisible} of ${this.planet.terrain.maxLevel}`,
      `workers ${this.workers.runningCount} busy, ${this.workers.queuedCount} queued`,
      `gpu     ${info.calls} draws, ${(info.triangles / 1000).toFixed(0)}k tris`,
    ];
  }
}

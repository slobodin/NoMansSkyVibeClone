import * as THREE from 'three';
import { FreeFlyController } from './controls/FreeFlyController';
import { Input } from './core/Input';
import { Universe } from './core/Universe';
import { saveScreenshot } from './dev/DevTools';
import { createStarfield } from './render/Starfield';
import { DebugHud, formatDistance, formatSpeed } from './ui/DebugHud';
import { TestBeacon } from './world/TestBeacon';

const FOV = 70; // vertical field of view, degrees
const NEAR = 0.1; // m
const FAR = 1e9; // m. The logarithmic depth buffer copes with a huge far/near ratio.

/** M0 stand-in for a planet: a plain sphere at the universe origin (real terrain comes in M1). */
const PLACEHOLDER_PLANET_RADIUS = 8000;
/** The jitter test: a small structure 500 km from the origin. */
const BEACON_POSITION = new THREE.Vector3(500_000, 0, 0);

const HELP = `mouse    look (click to capture, Esc to release)
W A S D  move        Space / C  up / down
Q / E    roll        Shift      boost
wheel    speed x2 / x0.5
1        go to planet   2  go to beacon (500 km out)
F2       screenshot     F3 debug panel   H  this help`;

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

  /** Game time in seconds since start. */
  time = 0;

  private lastFrameMs = performance.now();
  private readonly planet: THREE.Mesh;
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

    // --- Scene content -------------------------------------------------------------------------
    this.universe.sky.add(createStarfield(1337));

    const sun = new THREE.DirectionalLight(0xfff4e0, 3);
    sun.position.set(1, 0.4, 0.6); // a directional light only needs a direction
    this.universe.scene.add(sun, new THREE.AmbientLight(0x404a66, 0.6));

    this.planet = new THREE.Mesh(
      new THREE.SphereGeometry(PLACEHOLDER_PLANET_RADIUS, 128, 64),
      new THREE.MeshStandardMaterial({ color: 0x3f8f4f, roughness: 0.95 }),
    );
    this.planet.name = 'placeholder-planet';
    this.universe.root.add(this.planet);

    this.beacon = new TestBeacon(BEACON_POSITION);
    this.universe.root.add(this.beacon.object);

    this.goToPlanet();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  start(): void {
    this.lastFrameMs = performance.now();
    this.renderer.setAnimationLoop((nowMs) => this.frame(nowMs));
  }

  /** Renders the current state and returns it as a JPEG data URL (used for screenshots). */
  captureFrame(): string {
    this.render();
    // Reading the canvas right after rendering, in the same task, works without
    // preserveDrawingBuffer: the browser has not presented (and cleared) the frame yet.
    return this.renderer.domElement.toDataURL('image/jpeg', 0.92);
  }

  // ---------------------------------------------------------------------------------------------

  private frame(nowMs: number): void {
    // Clamp dt so a stall (tab switch, breakpoint) does not teleport things.
    const dt = Math.min((nowMs - this.lastFrameMs) / 1000, 0.1);
    this.lastFrameMs = nowMs;

    this.update(dt);
    this.render();
    this.input.endFrame();
  }

  private update(dt: number): void {
    this.time += dt;
    this.handleKeys();

    this.flyer.update(dt, this.input, this.nearestSurfaceDistance(this.flyer.position));
    this.beacon.update(this.time);

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
    if (input.wasPressed('Digit1')) this.goToPlanet();
    if (input.wasPressed('Digit2')) this.goToBeacon();
    if (input.wasPressed('F2')) void saveScreenshot(this, 'shot', false);
    if (input.wasPressed('F3')) this.hud.visible = !this.hud.visible;
    if (input.wasPressed('KeyH')) this.help.classList.toggle('hidden');
  }

  private goToPlanet(): void {
    this.flyer.set(new THREE.Vector3(9000, 4000, 22000), new THREE.Vector3(0, 0, 0));
  }

  private goToBeacon(): void {
    const eye = BEACON_POSITION.clone().add(new THREE.Vector3(6, 2.5, 9));
    this.flyer.set(eye, BEACON_POSITION.clone().add(new THREE.Vector3(1, 0.5, -1)));
  }

  /** Distance from `p` to the closest thing you could fly into (drives the free-fly speed). */
  private nearestSurfaceDistance(p: THREE.Vector3): number {
    const planetAltitude = p.length() - PLACEHOLDER_PLANET_RADIUS;
    const beaconDistance = p.distanceTo(BEACON_POSITION) - 10;
    return Math.max(0, Math.min(planetAltitude, beaconDistance));
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
    return [
      `pos    x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}  z ${p.z.toFixed(2)}`,
      `origin ${formatDistance(p.length())}   surface ${formatDistance(this.nearestSurfaceDistance(p))}`,
      `speed  ${formatSpeed(this.flyer.velocity.length())}  (wheel x${2 ** this.flyer.speedExponent})`,
      `draws  ${info.calls}   tris ${(info.triangles / 1000).toFixed(1)}k`,
    ];
  }
}

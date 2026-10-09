import * as THREE from 'three';

/** Something to point at: a universe position, a name, and how big it is (0 for a point). */
export interface MarkerTarget {
  label: string;
  position: THREE.Vector3;
  radius: number;
  /** Distance shown: to the surface (bodies) or to the centre (the ship). */
  measureToSurface: boolean;
}

/** A sphere that can hide markers behind it. */
export interface Occluder {
  position: THREE.Vector3;
  radius: number;
}

/** Hide a body's marker once its radius spans more than this angle on screen: you can see it. */
const MAX_ANGULAR_RADIUS = THREE.MathUtils.degToRad(10);
/** Two labels closer than this (CSS pixels) would overlap: the later one is hidden. */
const LABEL_SIZE = { width: 110, height: 14 };

/**
 * HUD markers: a diamond with a name and a distance over every planet, moon and star - and over
 * your ship when you are not in it - so you can find your way around the system.
 *
 * Plain HTML, positioned every frame by projecting each target to the screen with the game's
 * camera. The camera sits at the scene origin (camera-relative rendering), so a target's scene
 * position is just its universe position minus the camera's.
 *
 * A marker is hidden when its target is behind the camera, off screen, big enough on screen
 * to see anyway, behind a planet (a ray-sphere test per planet - there are only seven), or when
 * its label would overlap one placed before it: list targets most important first (a planet
 * before its moons), and a distant moon hides under its planet's marker.
 */
export class Markers {
  private readonly elements: HTMLElement[] = [];
  private readonly scene = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly toOccluder = new THREE.Vector3();

  constructor(private readonly container: HTMLElement) {}

  update(camera: THREE.PerspectiveCamera, cameraPosition: THREE.Vector3, targets: MarkerTarget[], occluders: Occluder[]): void {
    camera.updateMatrixWorld();
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const placed: THREE.Vector2[] = [];
    targets.forEach((target, i) => {
      const element = this.element(i);
      let position = this.place(camera, cameraPosition, target, occluders, width, height);
      const overlaps = (other: THREE.Vector2) =>
        Math.abs(other.x - position!.x) < LABEL_SIZE.width && Math.abs(other.y - position!.y) < LABEL_SIZE.height;
      if (position && placed.some(overlaps)) position = null;
      element.classList.toggle('hidden', position === null);
      if (!position) return;
      placed.push(position);
      element.style.transform = `translate(${position.x.toFixed(1)}px, ${position.y.toFixed(1)}px)`;
      const distance = cameraPosition.distanceTo(target.position) - (target.measureToSurface ? target.radius : 0);
      element.lastElementChild!.textContent = `${target.label}  ${formatRange(distance)}`;
    });
    for (let i = targets.length; i < this.elements.length; i++) this.elements[i].classList.add('hidden');
  }

  /** Screen position (CSS pixels) of the target's marker, or null if it should not be shown. */
  private place(
    camera: THREE.PerspectiveCamera,
    cameraPosition: THREE.Vector3,
    target: MarkerTarget,
    occluders: Occluder[],
    width: number,
    height: number,
  ): THREE.Vector2 | null {
    const scene = this.scene.copy(target.position).sub(cameraPosition);
    const distance = scene.length();
    if (target.radius > 0 && Math.asin(Math.min(target.radius / distance, 1)) > MAX_ANGULAR_RADIUS) return null;

    // Behind the camera? (A camera looks down its -Z axis.)
    this.view.copy(scene).applyMatrix4(camera.matrixWorldInverse);
    if (this.view.z >= 0) return null;

    // Behind a planet? Does the line of sight pass through another sphere before the target?
    const direction = scene.divideScalar(distance);
    for (const occluder of occluders) {
      if (occluder.position === target.position) continue; // a body doesn't hide its own marker
      const toOccluder = this.toOccluder.copy(occluder.position).sub(cameraPosition);
      const along = toOccluder.dot(direction);
      if (along <= 0 || along >= distance) continue;
      const missBy = toOccluder.addScaledVector(direction, -along).length();
      if (missBy < occluder.radius * 0.98) return null; // 0.98: don't hide a ship sitting on the ground
    }

    // Project to normalised device coordinates (-1..1), then to pixels.
    const ndc = scene.multiplyScalar(distance).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
    return new THREE.Vector2(((ndc.x + 1) / 2) * width, ((1 - ndc.y) / 2) * height);
  }

  private element(i: number): HTMLElement {
    while (this.elements.length <= i) {
      const element = document.createElement('div');
      element.className = 'marker hidden';
      element.innerHTML = '<div class="marker-diamond"></div><div class="marker-label"></div>';
      this.container.append(element);
      this.elements.push(element);
    }
    return this.elements[i];
  }
}

/** Distances for the HUD: "45 m", "2.3 km", "128 km". */
export function formatRange(metres: number): string {
  if (metres < 1000) return `${Math.max(0, metres).toFixed(0)} m`;
  if (metres < 100_000) return `${(metres / 1000).toFixed(1)} km`;
  return `${(metres / 1000).toFixed(0)} km`;
}

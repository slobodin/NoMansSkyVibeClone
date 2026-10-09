import * as THREE from 'three';

/**
 * The ship's 3D model, built from three.js primitives (no art assets): a faceted fuselage, a
 * glass canopy, swept wings, two engines with glowing nozzles and flames, tail fins and a
 * tripod landing gear.
 *
 * Ship space: metres, origin at the centre of the hull, +Y up, nose towards -Z (the same
 * convention as a three.js camera, so "forward" is (0, 0, -1) for both). About 11 m long and
 * 11 m across the wings.
 */

/** Height of the hull centre above the ground when standing on the landing gear. */
export const GEAR_HEIGHT = 1.8;
/**
 * Where the three feet touch the ground, in ship space: one under the nose, two under the wings.
 * Their centre is straight below the origin, which keeps the landing maths simple (Ship.ts).
 */
export const FEET: readonly THREE.Vector3[] = [
  new THREE.Vector3(0, -GEAR_HEIGHT, -3.4),
  new THREE.Vector3(-2.3, -GEAR_HEIGHT, 1.7),
  new THREE.Vector3(2.3, -GEAR_HEIGHT, 1.7),
];
/** The pilot's eye inside the canopy (cockpit view). */
export const COCKPIT_EYE = new THREE.Vector3(0, 1.3, -1.4);

/** Engine light colour, linear RGB; multiplied by an HDR brightness. */
const ENGINE_COLOR = new THREE.Color(0.35, 0.75, 1.0);
const PULSE_COLOR = new THREE.Color(0.75, 0.55, 1.0);

export class ShipModel {
  readonly object = new THREE.Group();

  private readonly legs: THREE.Group[] = [];
  private readonly nozzleMaterial = new THREE.MeshBasicMaterial();
  private readonly flameMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  private readonly flames: THREE.Mesh[] = [];

  constructor() {
    this.object.name = 'ship';
    const hull = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.45, metalness: 0.15, flatShading: true });
    const accent = new THREE.MeshStandardMaterial({ color: 0xe8692a, roughness: 0.5, metalness: 0.1, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.3, flatShading: true });
    // Metallic with no environment map reflects almost nothing but the sun: reads as dark glass.
    const glass = new THREE.MeshStandardMaterial({ color: 0x14304a, roughness: 0.08, metalness: 0.7 });

    // Fuselage: a lathe (a profile spun round an axis) with 10 sides, so it looks faceted.
    // The profile runs from the tail (y = -4.3) to the nose (y = 6.6): x = radius.
    const profile = [
      [0, -4.3], [0.85, -4.3], [1.05, -3.6], [1.25, -2], [1.3, 0], [1.15, 2], [0.8, 4.2], [0.35, 5.8], [0, 6.6],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const fuselageGeometry = new THREE.LatheGeometry(profile, 10);
    fuselageGeometry.rotateX(-Math.PI / 2); // the lathe axis +Y becomes the nose direction -Z
    fuselageGeometry.scale(1.15, 0.72, 1);
    this.add(new THREE.Mesh(fuselageGeometry, hull));

    // Canopy: the top half of a stretched sphere.
    const canopyGeometry = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    canopyGeometry.scale(0.72, 0.8, 1.6);
    this.add(new THREE.Mesh(canopyGeometry, glass), 0, 0.62, -1.7);

    // Wings, swept back, with orange tips and navigation lights (red = port/left, green = starboard).
    for (const side of [-1, 1]) {
      this.add(new THREE.Mesh(wingGeometry(side), hull), 0, -0.05, 0);
      this.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 1.3), accent), side * 5.55, -0.12, 2.85);
      const navColor = side < 0 ? new THREE.Color(8, 0.3, 0.2) : new THREE.Color(0.2, 8, 0.6);
      this.add(new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshBasicMaterial({ color: navColor })), side * 5.75, -0.05, 2.4);
    }

    // Engines: two nacelles with glowing nozzles and additive flames behind them.
    const nacelleGeometry = new THREE.CylinderGeometry(0.5, 0.62, 3, 10);
    nacelleGeometry.rotateX(Math.PI / 2);
    const flameGeometry = new THREE.ConeGeometry(0.42, 1, 12, 1, true);
    flameGeometry.translate(0, 0.5, 0); // base at the origin, tip at +Y...
    // Brightest at the nozzle, fading to nothing at the tip (with additive blending, black adds nothing).
    const heights = flameGeometry.getAttribute('position');
    const fade = new Float32Array(heights.count * 3).map((_, i) => (1 - heights.getY(Math.floor(i / 3))) ** 2);
    flameGeometry.setAttribute('color', new THREE.BufferAttribute(fade, 3));
    flameGeometry.rotateX(Math.PI / 2); // ...now pointing backwards (+Z)
    for (const side of [-1, 1]) {
      this.add(new THREE.Mesh(nacelleGeometry, dark), side * 1.25, -0.2, 3);
      this.add(new THREE.Mesh(new THREE.CircleGeometry(0.46, 16), this.nozzleMaterial), side * 1.25, -0.2, 4.52);
      const flame = new THREE.Mesh(flameGeometry, this.flameMaterial);
      flame.position.set(side * 1.25, -0.2, 4.55);
      this.flames.push(flame);
      this.object.add(flame);
    }

    // Tail fins, leaning outwards.
    for (const side of [-1, 1]) {
      const fin = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.5, 1.7), accent), side * 0.7, 0.95, 3.2);
      fin.rotation.z = -side * 0.35;
    }

    // Landing gear: a strut and a pad per foot, hanging from the hull. Retracting = scaling
    // the leg's group to zero height (its origin is at the top of the strut).
    for (const foot of FEET) {
      const top = foot.z < 0 ? -0.62 : -0.25; // underside of the nose / of the wing
      const length = top - foot.y;
      const leg = new THREE.Group();
      leg.position.set(foot.x, top, foot.z);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, length, 8), dark);
      strut.position.y = -length / 2;
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.1, 12), dark);
      pad.position.y = -length + 0.05;
      leg.add(strut, pad);
      this.legs.push(leg);
      this.object.add(leg);
    }

    this.setGear(1);
    this.setEngines(0, false);
  }

  /** Landing gear: 0 = retracted, 1 = down. */
  setGear(deployed: number): void {
    for (const leg of this.legs) {
      leg.visible = deployed > 0.02;
      leg.scale.y = Math.max(deployed, 0.02);
    }
  }

  /** Engine glow and flame length for a thrust level of 0..1; the pulse drive burns brighter. */
  setEngines(thrust: number, pulse: boolean): void {
    const color = pulse ? PULSE_COLOR : ENGINE_COLOR;
    this.nozzleMaterial.color.copy(color).multiplyScalar(pulse ? 60 : 0.03 + 25 * thrust);
    this.flameMaterial.color.copy(color).multiplyScalar(pulse ? 1.2 : 1.5 * thrust);
    const length = pulse ? 4 : 0.3 + 2.5 * thrust;
    for (const flame of this.flames) {
      flame.visible = pulse || thrust > 0.02;
      flame.scale.set(1, 1, length);
    }
  }

  private add(mesh: THREE.Mesh, x = 0, y = 0, z = 0): THREE.Mesh {
    mesh.position.set(x, y, z);
    this.object.add(mesh);
    return mesh;
  }
}

/** A swept wing for one side (-1 = left, +1 = right): a flat outline extruded 0.18 m thick. */
function wingGeometry(side: number): THREE.ExtrudeGeometry {
  // Outline in (x, z) - written as Shape (x, y) - from the root at the fuselage to the tip.
  const outline = [[0.9, -0.6], [5.7, 2.2], [5.7, 3.5], [0.9, 3.5]];
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(side * x, z)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false });
  // Shape space (x, y) with extrusion along +z -> ship space (x, z) with thickness along -y.
  // (Mirroring flips the outline's winding; ExtrudeGeometry normalises it, so both wings face out.)
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

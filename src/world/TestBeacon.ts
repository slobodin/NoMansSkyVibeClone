import * as THREE from 'three';

/**
 * A small test structure for checking camera-relative rendering (milestone M0).
 *
 * It is placed far from the universe origin. Fly up close: the thin rods and the 1 m checkerboard
 * must stay rock steady. Without the floating origin they would visibly snap to a few-cm grid.
 * A blinking fixed-size marker on its mast makes it findable from hundreds of km away.
 */
export class TestBeacon {
  readonly object = new THREE.Group();
  private readonly marker: THREE.Points;

  constructor(universePosition: THREE.Vector3) {
    this.object.name = 'test-beacon';
    this.object.position.copy(universePosition);

    // 20 x 20 m platform with a 1 m checkerboard (a 2x2 texture repeated 10 times).
    const checker = new THREE.DataTexture(
      new Uint8Array([230, 230, 230, 255, 40, 40, 40, 255, 40, 40, 40, 255, 230, 230, 230, 255]),
      2,
      2,
    );
    checker.magFilter = THREE.NearestFilter;
    checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
    checker.repeat.set(10, 10);
    checker.colorSpace = THREE.SRGBColorSpace;
    checker.needsUpdate = true;
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(20, 0.5, 20),
      new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8 }),
    );
    platform.position.y = -0.25;
    this.object.add(platform);

    // A row of 4 cm rods, 50 cm apart: thin features make precision problems obvious.
    const rodMaterial = new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.5 });
    const rodGeometry = new THREE.CylinderGeometry(0.02, 0.02, 3, 8);
    for (let i = 0; i < 9; i++) {
      const rod = new THREE.Mesh(rodGeometry, rodMaterial);
      rod.position.set(-2 + i * 0.5, 1.5, -4);
      this.object.add(rod);
    }

    // Cubes of 1 m, 25 cm and 5 cm.
    const cubeMaterial = new THREE.MeshStandardMaterial({ color: 0x44aaff, roughness: 0.4 });
    for (const [size, x] of [
      [1, 3],
      [0.25, 4.5],
      [0.05, 5.5],
    ] as const) {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), cubeMaterial);
      cube.position.set(x, size / 2, 0);
      this.object.add(cube);
    }

    // Mast with a blinking marker on top.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 6, 8), rodMaterial);
    mast.position.set(-6, 3, 6);
    this.object.add(mast);
    const markerGeometry = new THREE.BufferGeometry();
    markerGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-6, 6.2, 6], 3));
    this.marker = new THREE.Points(
      markerGeometry,
      new THREE.PointsMaterial({ color: 0xff3322, size: 7, sizeAttenuation: false }),
    );
    this.object.add(this.marker);
  }

  update(time: number): void {
    this.marker.visible = time % 1 < 0.6;
  }
}

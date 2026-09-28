import * as THREE from 'three';

/**
 * The system's sun: a light source at a universe position, drawn as a bright sphere plus a soft
 * glow sprite. The sphere is HDR (far brighter than 1.0) so that it stays white-hot after tone
 * mapping, and so that the atmosphere can redden it at sunset without it turning dull.
 */
export class Star {
  readonly object = new THREE.Group();
  /** Sunlight (irradiance, linear RGB) above any atmosphere - what the shaders light with. */
  readonly intensity: THREE.Vector3;

  constructor(
    readonly name: string,
    readonly position: THREE.Vector3,
    readonly radius: number,
    readonly color: THREE.Color,
  ) {
    this.object.name = name;
    this.object.position.copy(position);
    this.intensity = new THREE.Vector3(color.r, color.g, color.b).multiplyScalar(20);

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 48, 24),
      new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(60) }),
    );
    this.object.add(sphere);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: createGlowTexture(),
        color: color.clone().multiplyScalar(1.5),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    glow.scale.setScalar(radius * 14);
    this.object.add(glow);
  }

  /** Unit vector from a universe position towards the star. */
  directionFrom(point: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.position).sub(point).normalize();
  }
}

/** A radial gradient drawn on a canvas: bright centre fading to transparent. */
function createGlowTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.08, 'rgba(255,255,255,0.6)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.12)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

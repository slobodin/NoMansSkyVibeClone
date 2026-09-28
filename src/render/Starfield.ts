import * as THREE from 'three';
import { gaussian, mulberry32 } from '../math/random';

/**
 * Procedural starfield: a few thousand point sprites on a huge sphere around the camera.
 *
 * It lives in `Universe.sky`, which is never offset, so the stars stay put as you fly - they are
 * effectively at infinity. A third of the stars are concentrated in a tilted band to hint at a
 * galactic plane.
 */

const STAR_DISTANCE = 1e8; // m; anything inside the camera far plane works

// Rough stellar colours from cool (red dwarfs) to hot (blue giants), with how common each is.
const STAR_CLASSES: { color: [number, number, number]; weight: number }[] = [
  { color: [1.0, 0.55, 0.38], weight: 0.12 }, // M
  { color: [1.0, 0.78, 0.55], weight: 0.2 }, // K
  { color: [1.0, 0.94, 0.82], weight: 0.24 }, // G
  { color: [1.0, 1.0, 0.97], weight: 0.2 }, // F
  { color: [0.82, 0.88, 1.0], weight: 0.14 }, // A
  { color: [0.62, 0.74, 1.0], weight: 0.1 }, // B
];

const vertexShader = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uBrightness;
  varying vec3 vColor;

  #include <logdepthbuf_pars_fragment>

  void main() {
    // gl_PointCoord spans the sprite 0..1; draw a soft round dot (gaussian falloff).
    vec2 c = gl_PointCoord - 0.5;
    float falloff = exp(-dot(c, c) * 16.0);
    gl_FragColor = vec4(vColor * falloff * uBrightness, 1.0);

    #include <logdepthbuf_fragment>
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createStarfield(seed: number, count = 9000): THREE.Points {
  const rand = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  // Orientation of the "galactic plane" band.
  const bandFrame = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.9, 0.3, 0.4));
  const dir = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    if (rand() < 0.35) {
      // In the band: uniform longitude, gaussian latitude around the band's equator.
      const lon = rand() * Math.PI * 2;
      const lat = gaussian(rand) * 0.12;
      dir.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
      dir.applyMatrix4(bandFrame);
    } else {
      // Uniform on the sphere: uniform z and uniform angle around z.
      const z = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      dir.set(r * Math.cos(phi), r * Math.sin(phi), z);
    }
    dir.multiplyScalar(STAR_DISTANCE).toArray(positions, i * 3);

    // Mostly faint stars, a few bright ones.
    const u = rand();
    const flux = 0.05 + 0.35 * u ** 3 + 2.5 * u ** 40;
    sizes[i] = 2.2 + 2.5 * Math.sqrt(flux);

    let pick = rand();
    let starClass = STAR_CLASSES[0];
    for (const c of STAR_CLASSES) {
      starClass = c;
      pick -= c.weight;
      if (pick <= 0) break;
    }
    colors[i * 3 + 0] = starClass.color[0] * flux;
    colors[i * 3 + 1] = starClass.color[1] * flux;
    colors[i * 3 + 2] = starClass.color[2] * flux;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { uBrightness: { value: 1 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const stars = new THREE.Points(geometry, material);
  stars.name = 'starfield';
  stars.renderOrder = -1; // draw first, everything else draws over it
  stars.frustumCulled = false;
  return stars;
}

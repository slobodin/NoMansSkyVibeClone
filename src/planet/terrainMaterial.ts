import * as THREE from 'three';
import type { PlanetConfig } from './PlanetConfig';

/**
 * Terrain shader.
 *
 * COLOURS ARE CHOSEN PER PIXEL. The vertices only carry (height, variation); the fragment shader
 * turns the interpolated height, the per-pixel slope and the latitude into a colour. Computing
 * colours per vertex instead gives jagged, blurry boundaries on coarse chunks (a triangle is
 * either sand or grass at each corner and gets a smear in between); per pixel, a boundary such as
 * the beach line is where the interpolated height crosses a threshold - a clean line.
 *
 * All vectors are in world space, which - thanks to the floating origin - is camera-relative:
 * small numbers, fine in float32. `local` (planet-local position) is used for anything that must
 * stick to the ground as the planet turns: latitude and the detail noise.
 */

const vertexShader = /* glsl */ `
  attribute vec3 surface; // (height above sea level in m, colour variation -1..1, LOD level)

  varying vec3 vSurface;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    // modelMatrix is rotation + translation only (no scaling), so it can rotate normals directly.
    vNormal = mat3(modelMatrix) * normal;
    vSurface = surface;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uSunDirection; // unit vector towards the sun
  uniform vec3 uSunColor;
  uniform vec3 uAmbientColor;
  uniform vec3 uPlanetCenter; // world space
  uniform mat3 uWorldToPlanet; // rotates world directions into the planet's local frame

  // Palette (linear RGB) and the snow line in metres.
  uniform vec3 uSeabedShallow;
  uniform vec3 uSeabedDeep;
  uniform vec3 uBeach;
  uniform vec3 uGrassLush;
  uniform vec3 uGrassDry;
  uniform vec3 uForest;
  uniform vec3 uRock;
  uniform vec3 uSnow;
  uniform float uSnowLine;
  uniform bool uDebugLod;

  varying vec3 vSurface;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  #include <logdepthbuf_pars_fragment>

  // Cheap value noise for close-up texture ("hash without sine" by Dave Hoskins, MIT).
  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), u.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), u.x), u.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), u.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), u.x), u.y),
      u.z);
  }

  // height: metres above sea level; slope: 0 flat .. 1 vertical; polar: |sin(latitude)|
  vec3 surfaceColor(float height, float slope, float polar, float variation) {
    if (height < 0.0) {
      // Seabed: sandy in the shallows, dark further down.
      return mix(uSeabedDeep, uSeabedShallow, smoothstep(-120.0, -4.0, height));
    }
    // Grass with dry patches, darker forest green on higher ground.
    vec3 color = mix(uGrassLush, uGrassDry, smoothstep(0.05, 0.55, variation));
    color = mix(color, uForest, smoothstep(60.0, 220.0, height + variation * 80.0) * 0.8);
    // Beach along the waterline.
    color = mix(uBeach, color, smoothstep(2.0, 6.0, height + variation * 2.0));
    // Rock on steep slopes and high ground.
    float rock = max(smoothstep(0.16, 0.3, slope + variation * 0.04), smoothstep(450.0, 750.0, height));
    color = mix(color, uRock, rock);
    // Snow above a snow line that comes down to sea level near the poles, except where too steep.
    float snowLine = uSnowLine * clamp((0.92 - polar) / 0.3, 0.0, 1.0);
    float snow = smoothstep(snowLine, snowLine + 60.0, height + variation * 50.0);
    snow *= 1.0 - smoothstep(0.35, 0.5, slope);
    return mix(color, uSnow, snow);
  }

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 fromCenter = vWorldPosition - uPlanetCenter;
    vec3 up = normalize(fromCenter);
    vec3 local = uWorldToPlanet * fromCenter;

    float slope = 1.0 - dot(normal, up);
    float polar = abs(local.y) / length(local); // the spin axis is the planet's +Y
    vec3 albedo = surfaceColor(vSurface.x, slope, polar, vSurface.y);
    if (uDebugLod) {
      // Debug view (F4): one colour per quadtree level; golden-ratio hue steps keep neighbours distinct.
      float hue = fract(vSurface.z * 0.618);
      vec3 rgb = clamp(abs(fract(hue + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
      albedo = mix(vec3(0.5), rgb, 0.7);
    }

    // Close-up texture: three octaves of noise, each faded out before it gets small enough on
    // screen to shimmer.
    float distance = length(vWorldPosition);
    float detail = (valueNoise(local * 0.35) - 0.5) * 0.4 * (1.0 - smoothstep(300.0, 900.0, distance));
    detail += (valueNoise(local * 1.5) - 0.5) * 0.35 * (1.0 - smoothstep(60.0, 200.0, distance));
    detail += (valueNoise(local * 6.0) - 0.5) * 0.3 * (1.0 - smoothstep(15.0, 50.0, distance));
    albedo *= 1.0 + detail;

    // Lambert diffuse from the sun, but only on the day side: past the terminator the planet
    // itself is in the way (without this, slopes facing the sun would glow in the night).
    float diffuse = max(dot(normal, uSunDirection), 0.0);
    float daySide = smoothstep(-0.05, 0.08, dot(up, uSunDirection));
    // Ambient light from the sky, a bit stronger on ground that faces up.
    float skyView = 0.6 + 0.4 * dot(normal, up);

    vec3 light = uSunColor * diffuse * daySide + uAmbientColor * skyView;
    gl_FragColor = vec4(albedo * light, 1.0);

    #include <logdepthbuf_fragment>
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createTerrainMaterial(config: PlanetConfig): THREE.ShaderMaterial {
  const c = config.colors;
  // THREE.Color.setHex treats hex as sRGB and converts to linear, which is what lighting needs.
  const color = (hex: number) => ({ value: new THREE.Color().setHex(hex) });
  return new THREE.ShaderMaterial({
    name: `${config.name}-terrain`,
    vertexShader,
    fragmentShader,
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.88).multiplyScalar(2.3) },
      uAmbientColor: { value: new THREE.Color(0.1, 0.12, 0.16) },
      uPlanetCenter: { value: new THREE.Vector3() },
      uWorldToPlanet: { value: new THREE.Matrix3() },
      uSeabedShallow: color(c.seabedShallow),
      uSeabedDeep: color(c.seabedDeep),
      uBeach: color(c.beach),
      uGrassLush: color(c.grassLush),
      uGrassDry: color(c.grassDry),
      uForest: color(c.forest),
      uRock: color(c.rock),
      uSnow: color(c.snow),
      uSnowLine: { value: c.snowLine },
      uDebugLod: { value: false },
    },
  });
}

import * as THREE from 'three';
import { ATMOSPHERE_GLSL, type AtmosphereParams } from '../render/atmosphere';
import { VALUE_NOISE_GLSL } from '../render/noiseGlsl';
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
  // The Atmosphere struct, sunlightAt(), skyIrradiance(), ... come from here:
  ${ATMOSPHERE_GLSL}

  uniform Atmosphere uAtmosphere; // this planet's air (also its centre and sun direction)
  uniform mat3 uWorldToPlanet;    // rotates world directions into the planet's local frame
  uniform vec3 uNightLight;    // faint ambient so nights are dark but not black

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

  ${VALUE_NOISE_GLSL}

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
    vec3 fromCenter = vWorldPosition - uAtmosphere.center;
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

    // Direct sunlight, reddened and dimmed by its trip through the atmosphere, and zero where
    // the planet is in the way (night). Lambert: proportional to the cosine of the incidence.
    vec3 sunlight = sunlightAt(uAtmosphere, vWorldPosition) * max(dot(normal, uAtmosphere.sunDirection), 0.0);

    // Skylight from the whole sky dome, stronger on ground that faces up at the open sky.
    float skyView = 0.5 + 0.5 * dot(normal, up);
    vec3 skylight = (skyIrradiance(uAtmosphere, up) + uNightLight) * skyView;

    // Diffuse surface: outgoing radiance = albedo / pi * incoming irradiance. The output is linear
    // HDR; the composite pass adds the atmosphere in front of it and tone-maps.
    gl_FragColor = vec4(albedo / PI * (sunlight + skylight), 1.0);

    #include <logdepthbuf_fragment>
  }
`;

export function createTerrainMaterial(config: PlanetConfig, atmosphere: AtmosphereParams): THREE.ShaderMaterial {
  const c = config.colors;
  // THREE.Color.setHex treats hex as sRGB and converts to linear, which is what lighting needs.
  const color = (hex: number) => ({ value: new THREE.Color().setHex(hex) });
  return new THREE.ShaderMaterial({
    name: `${config.name}-terrain`,
    vertexShader,
    fragmentShader,
    uniforms: {
      // A struct uniform: the same object the planet updates and the composite pass reads.
      uAtmosphere: { value: atmosphere },
      uWorldToPlanet: { value: new THREE.Matrix3() },
      uNightLight: { value: new THREE.Vector3(0.1, 0.14, 0.28) },
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

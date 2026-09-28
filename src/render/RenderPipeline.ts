import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from './atmosphere';
import { VALUE_NOISE_GLSL } from './noiseGlsl';
import { OCEAN_GLSL, type OceanUniforms } from './ocean';

/**
 * Rendering in three passes:
 *
 *   1. The scene (stars, sun, terrain, ...) is rendered into an HDR render target: half-float
 *      colour, so values above 1.0 survive (the sun is ~60), plus a depth texture.
 *   2. A full-screen "composite" pass reads colour + depth and, per pixel, adds everything that
 *      is best done knowing how far away the scene is: the ocean (ocean.ts), the atmosphere
 *      (atmosphere.ts: sky, aerial perspective), then exposure, tone mapping and sRGB.
 *   3. FXAA smooths jagged edges in the final image.
 *
 * Doing the atmosphere and the ocean as a post-process means one piece of code handles the sky,
 * the haze in front of distant mountains and the glowing rim of the planet seen from orbit, and
 * the water knows how deep it is everywhere without any extra geometry.
 *
 * Why FXAA and not MSAA? With MSAA, a pixel on a hill's silhouette is resolved to a blend of
 * grass and *black space* (the sky only gets its colour in pass 2), and pass 2 cannot tell - so
 * silhouettes get a dark outline. Antialiasing the finished image avoids that.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0); // already in clip space: no camera involved
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform mat4 uInverseProjection;
  uniform mat3 uCameraRotation;
  uniform float uLogDepthFar; // log2(far + 1), to undo the logarithmic depth encoding
  uniform float uExposure;

  varying vec2 vUv;

  ${ATMOSPHERE_GLSL}
  ${VALUE_NOISE_GLSL}
  ${OCEAN_GLSL}

  // Filmic tone curve (Krzysztof Narkowicz's fit of ACES): compresses HDR into 0..1 with a soft
  // shoulder instead of clipping.
  vec3 acesFilm(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  vec3 linearToSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  void main() {
    vec3 color = texture2D(tColor, vUv).rgb;
    float depth = texture2D(tDepth, vUv).r;

    // The view ray through this pixel, in world space. The camera sits at the origin.
    // Un-project the pixel's point on the *near* plane (z = -1): with far/near = 1e10, the far
    // plane (z = +1) is numerically hopeless in float32. Any point on the ray gives its direction.
    vec4 view = uInverseProjection * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec3 viewDir = normalize(view.xyz / view.w);
    vec3 dir = normalize(uCameraRotation * viewDir);

    // Distance to the scene along the ray. three's log depth stores log2(1 + w) / log2(far + 1)
    // where w is the view-space depth; along this ray the distance is w / cos(angle off-axis).
    // Nothing was drawn where depth is still 1.0: that is sky.
    bool sky = depth >= 1.0;
    float sceneDistance = sky ? 1e30 : (exp2(depth * uLogDepthFar) - 1.0) / -viewDir.z;

    // 1. The ocean. If the camera itself is under water, fog everything with water instead.
    bool underwater = uOceanRadius > 0.0 && length(uPlanetCenter) < uOceanRadius;
    vec2 sea = uOceanRadius > 0.0 ? raySphere(vec3(0.0), dir, uPlanetCenter, uOceanRadius) : vec2(1e30, -1e30);
    if (underwater) {
      color = shadeUnderwater(dir, sea.y, sceneDistance, color);
    } else {
      if (sea.x > 0.0 && sea.x < sceneDistance) {
        color = shadeOcean(dir, sea.x, sceneDistance, color);
        sceneDistance = sea.x; // the atmosphere below only reaches the water surface
        sky = false;
      }

      // 2. The atmosphere between the camera and whatever the ray hit.
      vec2 shell = raySphere(vec3(0.0), dir, uPlanetCenter, uAtmosphereRadius);
      float tStart = max(shell.x, 0.0);
      float tEnd = min(shell.y, sceneDistance);
      if (tEnd > tStart) {
        vec3 transmit;
        vec3 inscatter = scatterAlongRay(vec3(0.0), dir, tStart, tEnd, 16, transmit);
        // Stars vanish behind a bright sky, the way eyes and cameras adapt to daylight.
        if (sky) color *= exp(-40.0 * dot(inscatter, vec3(0.2126, 0.7152, 0.0722)));
        color = color * transmit + inscatter;
      }
    }

    // 3. Exposure, filmic tone mapping, sRGB.
    gl_FragColor = vec4(linearToSrgb(acesFilm(color * uExposure)), 1.0);
  }
`;

export class RenderPipeline {
  readonly sceneTarget: THREE.WebGLRenderTarget;
  readonly composite: THREE.ShaderMaterial;
  exposure = 0.75;

  /** The composited, tone-mapped image (8 bits per channel), input of the FXAA pass. */
  private readonly ldrTarget = new THREE.WebGLRenderTarget(1, 1);
  private readonly fxaa: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly postScene = new THREE.Scene();
  private readonly postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    atmosphere: AtmosphereUniforms,
    ocean: OceanUniforms,
  ) {
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // HDR
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });

    this.composite = new THREE.ShaderMaterial({
      name: 'composite',
      vertexShader,
      fragmentShader,
      uniforms: {
        tColor: { value: this.sceneTarget.texture },
        tDepth: { value: this.sceneTarget.depthTexture },
        uInverseProjection: { value: new THREE.Matrix4() },
        uCameraRotation: { value: new THREE.Matrix3() },
        uLogDepthFar: { value: 1 },
        uExposure: { value: 1 },
        // The same uniform objects as the terrain material: both always see the same planet/sun.
        ...atmosphere,
        ...ocean,
      },
      depthTest: false,
      depthWrite: false,
    });

    // three.js ships NVIDIA's FXAA as a ready-made fragment shader.
    this.fxaa = new THREE.ShaderMaterial({
      name: 'fxaa',
      vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      uniforms: {
        tDiffuse: { value: this.ldrTarget.texture },
        resolution: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });

    // One triangle that covers the whole screen (cheaper and simpler than a two-triangle quad).
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    triangle.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(triangle, this.composite);
    this.quad.frustumCulled = false;
    this.postScene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    this.sceneTarget.setSize(width, height);
    this.ldrTarget.setSize(width, height);
    this.fxaa.uniforms.resolution.value.set(1 / width, 1 / height);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const renderer = this.renderer;

    // 1. Scene -> HDR target.
    renderer.setRenderTarget(this.sceneTarget);
    renderer.render(scene, camera);

    // 2. Composite (atmosphere, tone mapping) -> 8-bit target.
    const u = this.composite.uniforms;
    u.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    u.uCameraRotation.value.setFromMatrix4(camera.matrixWorld);
    u.uLogDepthFar.value = Math.log2(camera.far + 1);
    u.uExposure.value = this.exposure;
    this.quad.material = this.composite;
    renderer.setRenderTarget(this.ldrTarget);
    renderer.render(this.postScene, this.postCamera);

    // 3. FXAA -> screen.
    this.quad.material = this.fxaa;
    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
  }
}

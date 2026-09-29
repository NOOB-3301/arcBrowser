import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LUTPass } from 'three/examples/jsm/postprocessing/LUTPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { N8AOPass } from 'n8ao';
import { Quality, type QualityPreset } from './Quality';
import { FogUniforms, RenderGlobals } from './RenderGlobals';

/** Screen-space sun shafts: march from each pixel towards the sun, accumulating sky (depth = far) samples. */
const GodRaysShader = {
  name: 'RFGodRays',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uColor: { value: new THREE.Color(1, 0.9, 0.7) },
    uIntensity: { value: 0.3 },
    uAspect: { value: 1.0 },
  },
  defines: { SAMPLES: 28 },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uSun;
    uniform vec3 uColor;
    uniform float uIntensity;
    uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (uIntensity <= 0.0) { gl_FragColor = c; return; }
      vec2 delta = uSun - vUv;
      float dist = length(delta * vec2(uAspect, 1.0));
      vec2 stepv = delta / float(SAMPLES) * 0.85;
      float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      vec2 uv = vUv + stepv * jitter;
      float acc = 0.0;
      float w = 1.0;
      float wsum = 0.0;
      for (int i = 0; i < SAMPLES; i++) {
        vec2 cuv = clamp(uv, vec2(0.001), vec2(0.999));
        float d = texture2D(tDepth, cuv).r;
        acc += step(0.99999, d) * w;
        wsum += w;
        w *= 0.97;
        uv += stepv;
      }
      acc /= wsum;
      float fall = pow(max(0.0, 1.0 - dist / 1.1), 2.5);
      c.rgb += uColor * acc * fall * uIntensity;
      gl_FragColor = c;
    }
  `,
};

/** Vignette + radial chromatic aberration + film grain, applied to the final display-referred image. */
const FinalShader = {
  name: 'RFFinal',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.28 },
    uCA: { value: 0.0016 },
    uGrain: { value: 0.028 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uCA, uGrain;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * r2 * uCA * 8.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + off).b;
      col *= 1.0 - uVignette * smoothstep(0.08, 0.55, r2 * 1.6);
      float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime * 7.13) * 91.7, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      col += n * uGrain * (1.0 - col * 0.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * Warm, dusty, slightly desaturated industrial grade baked into a 3D LUT
 * (applied in display space after AgX tone mapping).
 */
function makeGradeLUT(size = 32): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let R = r / (size - 1);
        let G = g / (size - 1);
        let B = b / (size - 1);
        const luma = R * 0.2126 + G * 0.7152 + B * 0.0722;
        // desaturate a touch
        const sat = 0.86;
        R = luma + (R - luma) * sat;
        G = luma + (G - luma) * sat;
        B = luma + (B - luma) * sat;
        // split tone: cool slate shadows, warm dusty highlights
        const sh = 1 - smooth(0.0, 0.45, luma);
        const hi = smooth(0.45, 1.0, luma);
        R += -0.012 * sh + 0.035 * hi;
        G += 0.004 * sh + 0.012 * hi;
        B += 0.018 * sh - 0.04 * hi;
        // gentle S-curve contrast around mid grey + slight black lift (dusty air)
        const curve = (x: number) => {
          const c = x + (x - 0.5) * 0.12 * (1 - Math.abs(2 * x - 1));
          return 0.012 + c * 0.985;
        };
        R = curve(R);
        G = curve(G);
        B = curve(B);
        data[i++] = Math.round(Math.min(1, Math.max(0, R)) * 255);
        data[i++] = Math.round(Math.min(1, Math.max(0, G)) * 255);
        data[i++] = Math.round(Math.min(1, Math.max(0, B)) * 255);
        data[i++] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const _sun = new THREE.Vector3();

/**
 * Post-processing chain: scene (+N8AO) -> sun shafts -> bloom -> AgX tone map ->
 * LUT grade -> SMAA -> vignette / chromatic aberration / grain. Passes are
 * rebuilt when the quality preset changes.
 */
export class PostFX {
  readonly composer: EffectComposer;
  private renderPass: RenderPass;
  private ao: N8AOPass;
  private godRays = new ShaderPass(GodRaysShader);
  private bloom: UnrealBloomPass;
  private output = new OutputPass();
  private lut = new LUTPass({ lut: makeGradeLUT(), intensity: 1 });
  private smaa = new SMAAPass();
  private final = new ShaderPass(FinalShader);
  private width = window.innerWidth;
  private height = window.innerHeight;
  /** Sun-shaft strength; scaled per time of day by the fog in-scatter strength. */
  godRayStrength = 0.25;
  enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.ao = new N8AOPass(scene, camera, this.width, this.height);
    const c = this.ao.configuration;
    c.gammaCorrection = false;
    c.aoRadius = 2.2;
    c.distanceFalloff = 1.0;
    c.intensity = 2.6;
    c.color = new THREE.Color('#15110c');
    c.transparencyAware = false;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.18, 0.5, 1.5);
    this.apply(Quality.current);
    Quality.onChange((q) => this.apply(q));
  }

  private apply(q: QualityPreset): void {
    const pr = Math.min(window.devicePixelRatio * q.pixelRatio, q.maxPixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height);
    this.composer.setPixelRatio(pr);
    this.camera.far = q.drawDistance;
    this.camera.updateProjectionMatrix();

    for (const p of [...this.composer.passes]) this.composer.removePass(p);
    const passes: Pass[] = [];
    if (q.ao) {
      this.ao.setQualityMode(q.aoQuality);
      this.ao.configuration.halfRes = q.aoHalfRes;
      passes.push(this.ao);
      if (q.godRays) {
        this.godRays.material.defines.SAMPLES = q.godRaySamples;
        this.godRays.material.needsUpdate = true;
        passes.push(this.godRays);
      }
    } else {
      passes.push(this.renderPass);
    }
    if (q.bloom) passes.push(this.bloom);
    passes.push(this.output, this.lut);
    if (q.smaa) passes.push(this.smaa);
    if (q.filmFx) passes.push(this.final);
    for (const p of passes) this.composer.addPass(p);
    this.composer.setSize(this.width, this.height);
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    RenderGlobals.time.value += dt;
    if (!this.enabled) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const q = Quality.current;
    if (q.ao && q.godRays) {
      const u = this.godRays.material.uniforms;
      u.tDepth.value = this.ao.beautyRenderTarget.depthTexture;
      _sun.copy(RenderGlobals.sunDir).multiplyScalar(1000).add(this.camera.position).project(this.camera);
      const facing = this.camera.getWorldDirection(new THREE.Vector3()).dot(RenderGlobals.sunDir);
      u.uSun.value.set(_sun.x * 0.5 + 0.5, _sun.y * 0.5 + 0.5);
      u.uAspect.value = this.width / this.height;
      const sunUp = THREE.MathUtils.smoothstep(RenderGlobals.sunDir.y, -0.02, 0.08);
      u.uIntensity.value = this.godRayStrength * FogUniforms.sun.w * THREE.MathUtils.smoothstep(facing, 0.0, 0.5) * sunUp;
      u.uColor.value.copy(RenderGlobals.sunColor).multiplyScalar(0.25);
    }
    this.final.material.uniforms.uTime.value = RenderGlobals.time.value;
    this.composer.render(dt);
  }
}

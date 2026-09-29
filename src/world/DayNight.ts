import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { CascadedSunShadow } from '../render/SunShadow';
import { FogUniforms, RenderGlobals } from '../render/RenderGlobals';
import { Quality, type QualityPreset } from '../render/Quality';

export type TimeOfDay = 'morning' | 'noon' | 'dusk' | 'overcast';

interface Preset {
  elevation: number; // degrees above horizon
  azimuth: number;
  sun: string;
  sunIntensity: number;
  turbidity: number;
  rayleigh: number;
  mie: number;
  mieG: number;
  clouds: number; // coverage 0..1
  cloudDensity: number;
  exposure: number;
  /** Scales image-based (sky) lighting. */
  env: number;
  fogNear: number;
  fogFar: number;
  /** Height-fog falloff (1/m): higher = fog hugs the valley floor. */
  fogFalloff: number;
  /** Tint mixed into the captured horizon colour for fog (dust/haze). */
  fogTint: string;
  fogTintAmt: number;
  /** Sun in-scatter strength in fog. */
  scatter: number;
  shadow: number; // shadow intensity (overcast = soft/weak)
  groundAlbedo: string;
  /** Target horizon luminance: normalises Sky.js radiance against the sun's intensity. */
  skyLum: number;
}

const PRESETS: Record<TimeOfDay, Preset> = {
  morning: {
    elevation: 13, azimuth: 110, sun: '#ffc690', sunIntensity: 3.2, turbidity: 6, rayleigh: 1.6, mie: 0.006, mieG: 0.86,
    clouds: 0.35, cloudDensity: 0.45, exposure: 1.0, env: 1.0, fogNear: 30, fogFar: 1500, fogFalloff: 0.022,
    fogTint: '#d9c2a2', fogTintAmt: 0.25, scatter: 0.6, shadow: 1, groundAlbedo: '#4a4232', skyLum: 0.5,
  },
  noon: {
    elevation: 55, azimuth: 150, sun: '#fff0dc', sunIntensity: 3.6, turbidity: 4.5, rayleigh: 1.2, mie: 0.005, mieG: 0.82,
    clouds: 0.38, cloudDensity: 0.5, exposure: 0.95, env: 1.0, fogNear: 60, fogFar: 2200, fogFalloff: 0.012,
    fogTint: '#cfc4b0', fogTintAmt: 0.2, scatter: 0.45, shadow: 1, groundAlbedo: '#4d4636', skyLum: 0.6,
  },
  dusk: {
    elevation: 7, azimuth: 250, sun: '#ff9a58', sunIntensity: 2.3, turbidity: 6, rayleigh: 2.2, mie: 0.005, mieG: 0.8,
    clouds: 0.42, cloudDensity: 0.5, exposure: 0.95, env: 1.0, fogNear: 90, fogFar: 1700, fogFalloff: 0.013,
    fogTint: '#b98a6e', fogTintAmt: 0.25, scatter: 0.5, shadow: 1, groundAlbedo: '#3d3228', skyLum: 0.32,
  },
  overcast: {
    elevation: 42, azimuth: 180, sun: '#dfe3e8', sunIntensity: 0.9, turbidity: 10, rayleigh: 0.7, mie: 0.004, mieG: 0.6,
    clouds: 0.95, cloudDensity: 0.9, exposure: 0.95, env: 1.1, fogNear: 15, fogFar: 1250, fogFalloff: 0.016,
    fogTint: '#a4a8aa', fogTintAmt: 0.45, scatter: 0.2, shadow: 0.55, groundAlbedo: '#48463e', skyLum: 0.42,
  },
};

const SKY_SCALE = 5000;

/**
 * Sky, sun (cascaded shadows), image-based lighting and atmosphere.
 *
 * On every preset change the sky is re-captured into a cubemap: that feeds a
 * PMREM for `scene.environment` (PBR ambient + reflections), water reflections,
 * and a few CPU readbacks that pick matching fog / ambient colours so the
 * terrain dissolves into the real horizon colour.
 */
export class DayNight {
  readonly sun: SunLight;
  readonly shadow: CascadedSunShadow;
  /** Kept for API compatibility; not added to the scene (IBL replaces it). */
  readonly hemi = new THREE.HemisphereLight();
  /** Kept for API compatibility; not added to the scene (IBL replaces it). */
  readonly fill = new THREE.DirectionalLight();
  readonly sky = new Sky();
  readonly sunDir = new THREE.Vector3();
  readonly fog = new THREE.Fog('#bfc3c2', 160, 1300);
  current: TimeOfDay = 'noon';
  /** Linear colours derived from the sky capture. */
  readonly horizonColor = new THREE.Color();
  readonly zenithColor = new THREE.Color();
  readonly sunHorizonColor = new THREE.Color();

  private envScene = new THREE.Scene();
  private envSky = new Sky();
  private ground: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private probeRT: THREE.WebGLRenderTarget | null = null;
  private probeCam = new THREE.PerspectiveCamera(4, 1, 0.1, 1000);
  private preset = PRESETS.noon;
  private t0 = performance.now();
  /** Shared multiplier on Sky.js output (both the visible dome and the env capture). */
  private skyScale = { value: 1 };
  private unsub: () => void;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(SKY_SCALE);
    this.sky.frustumCulled = false;
    for (const s of [this.sky, this.envSky]) {
      s.material.onBeforeCompile = (shader) => {
        shader.uniforms.uSkyScale = this.skyScale;
        shader.fragmentShader = shader.fragmentShader
          .replace('void main()', 'uniform float uSkyScale;\nvoid main()')
          .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb *= uSkyScale;\n#include <tonemapping_fragment>');
      };
    }
    this.sun = new SunLight('#ffffff', 3);
    this.shadow = new CascadedSunShadow();
    this.sun.shadow = this.shadow;
    this.sun.castShadow = true;
    this.shadow.bias = -0.0002;
    this.shadow.normalBias = 0.05;
    scene.add(this.sky, this.sun);
    scene.fog = this.fog;

    // Env capture scene: sky + a ground hemisphere with the bounce colour
    this.envSky.scale.setScalar(100);
    this.envSky.material.uniforms.showSunDisc.value = 0;
    this.ground = new THREE.Mesh(
      new THREE.SphereGeometry(40, 32, 8, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2 - 0.02),
      new THREE.MeshBasicMaterial({ color: '#444', side: THREE.BackSide, fog: false }),
    );
    this.envScene.add(this.envSky, this.ground);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.cubeCam = new THREE.CubeCamera(0.1, 500, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    RenderGlobals.skyCube.value = this.cubeRT.texture;

    this.applyQuality(Quality.current);
    this.unsub = Quality.onChange((q) => {
      this.applyQuality(q);
      this.captureSky();
    });
    this.set('noon');
  }

  private applyQuality(q: QualityPreset): void {
    this.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    this.shadow.radius = q.shadowRadius;
    this.shadow.setCascades(q.shadowSplits);
  }

  set(tod: TimeOfDay): void {
    this.current = tod;
    const p = (this.preset = PRESETS[tod]);
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - p.elevation), THREE.MathUtils.degToRad(p.azimuth));
    for (const sky of [this.sky, this.envSky]) {
      const u = sky.material.uniforms;
      u.turbidity.value = p.turbidity;
      u.rayleigh.value = p.rayleigh;
      u.mieCoefficient.value = p.mie;
      u.mieDirectionalG.value = p.mieG;
      u.sunPosition.value.copy(this.sunDir);
      u.cloudCoverage.value = p.clouds;
      u.cloudDensity.value = p.cloudDensity;
      u.cloudScale.value = 0.00022;
      u.cloudSpeed.value = 0.00003;
      u.cloudElevation.value = 0.55;
    }
    this.sun.color.set(p.sun);
    this.sun.intensity = p.sunIntensity;
    this.sun.position.copy(this.sunDir);
    RenderGlobals.sunDir.copy(this.sunDir);
    this.shadow.intensity = p.shadow;
    RenderGlobals.sunColor.set(p.sun).multiplyScalar(p.sunIntensity);
    this.fog.near = p.fogNear;
    this.fog.far = p.fogFar;
    this.renderer.toneMappingExposure = p.exposure;
    this.scene.environmentIntensity = p.env;
    // legacy mirrors for any code reading them
    this.hemi.color.set('#c9d8e8');
    this.hemi.intensity = 0;
    this.fill.intensity = 0;
    this.captureSky();
  }

  /** Re-render the sky into the environment cubemap + PMREM and derive fog/ambient colours. */
  captureSky(): void {
    const p = this.preset;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevTone = r.toneMapping;
    this.envSky.material.uniforms.time.value = this.sky.material.uniforms.time.value;

    // 1) CPU probes of the bare sky (no ground) for fog + ambient colours
    this.ground.visible = false;
    this.readSkyColors();

    // 2) ground bounce: albedo * (sun + sky irradiance) / pi, in the sky's radiance units
    const sunE = this.sun.color.clone().multiplyScalar(this.sun.intensity * Math.max(this.sunDir.y, 0) * p.shadow);
    const skyAvg = this.horizonColor.clone().lerp(this.zenithColor, 0.5);
    const bounce = new THREE.Color(p.groundAlbedo);
    const g = sunE.multiplyScalar(1 / Math.PI).add(skyAvg).multiply(bounce);
    this.ground.material.color.copy(g);
    this.ground.visible = true;

    // 3) cubemap for reflections, then PMREM for scene.environment
    r.toneMapping = THREE.NoToneMapping;
    this.cubeCam.update(r, this.envScene);
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 500, { size: Quality.current.envSize });
    old?.dispose();
    this.scene.environment = this.envRT.texture;
    r.toneMapping = prevTone;
    r.setRenderTarget(prevTarget);

    // Ambient approximations for non-PBR shaders (grass, water)
    RenderGlobals.ambientUp.copy(skyAvg).multiplyScalar(Math.PI * p.env);
    RenderGlobals.ambientDown.copy(g).multiplyScalar(Math.PI * p.env);
    this.updateFog();
  }

  private readSkyColors(): void {
    const r = this.renderer;
    const p = this.preset;
    if (!this.probeRT) {
      this.probeRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType, depthBuffer: false });
    }
    const buf = new Float32Array(4 * 4 * 4);
    const sample = (dir: THREE.Vector3, out: THREE.Color) => {
      this.probeCam.position.set(0, 0, 0);
      this.probeCam.lookAt(dir);
      this.probeCam.updateMatrixWorld();
      r.setRenderTarget(this.probeRT);
      r.render(this.envScene, this.probeCam);
      try {
        r.readRenderTargetPixels(this.probeRT!, 0, 0, 4, 4, buf);
      } catch {
        return false;
      }
      let rr = 0, gg = 0, bb = 0;
      for (let i = 0; i < 16; i++) {
        rr += buf[i * 4];
        gg += buf[i * 4 + 1];
        bb += buf[i * 4 + 2];
      }
      out.setRGB(rr / 16, gg / 16, bb / 16);
      return Number.isFinite(rr) && rr + gg + bb > 0;
    };
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    this.skyScale.value = 1;
    const tmp = new THREE.Color();
    const acc = new THREE.Color(0, 0, 0);
    let ok = true;
    const el = Math.sin(THREE.MathUtils.degToRad(4));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ok = sample(new THREE.Vector3(Math.cos(a), el, Math.sin(a)).normalize(), tmp) && ok;
      acc.add(tmp);
    }
    this.horizonColor.copy(acc.multiplyScalar(1 / 8));
    ok = sample(new THREE.Vector3(0.001, 1, 0), this.zenithColor) && ok;
    ok = sample(new THREE.Vector3(this.sunDir.x, el, this.sunDir.z).normalize(), this.sunHorizonColor) && ok;
    r.toneMapping = prevTone;
    const lum = this.horizonColor.r * 0.2126 + this.horizonColor.g * 0.7152 + this.horizonColor.b * 0.0722;
    const k = ok && lum > 0 ? p.skyLum / lum : 0.1;
    this.skyScale.value = k;
    this.horizonColor.multiplyScalar(k);
    this.zenithColor.multiplyScalar(k);
    this.sunHorizonColor.multiplyScalar(k);
    if (!ok) {
      // Fallback when float readback is unavailable
      this.horizonColor.set(p.fogTint);
      this.zenithColor.set('#6f8fb5');
      this.sunHorizonColor.set(p.sun);
    }
  }

  private updateFog(): void {
    const p = this.preset;
    const lum = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    // Fog colour = real horizon colour, nudged toward a dusty tint of the same brightness
    const tint = new THREE.Color(p.fogTint);
    tint.multiplyScalar(lum(this.horizonColor) / Math.max(lum(tint), 1e-4));
    this.fog.color.copy(this.horizonColor).lerp(tint, p.fogTintAmt);
    const s = FogUniforms.sun;
    s.x = this.sunDir.x;
    s.y = this.sunDir.y;
    s.z = this.sunDir.z;
    s.w = p.scatter;
    const sc = FogUniforms.sunColor;
    // Mie glow at the horizon can be extremely bright; cap it relative to the fog so it reads as haze, not glare
    const sunTint = this.sunHorizonColor.clone();
    const cap = lum(this.fog.color) * 1.15;
    if (lum(sunTint) > cap) sunTint.multiplyScalar(cap / lum(sunTint));
    sc.x = sunTint.r;
    sc.y = sunTint.g;
    sc.z = sunTint.b;
    sc.w = p.fogFalloff;
    FogUniforms.params.x = 20; // valley floor / reservoir level
  }

  /** Per frame: drift clouds. `focus` kept for API compatibility (cascades follow the camera). */
  update(_focus?: THREE.Vector3): void {
    const t = (performance.now() - this.t0) / 1000;
    this.sky.material.uniforms.time.value = t;
  }

  get skyColor(): THREE.Color {
    return this.fog.color;
  }
  get ambientColor(): THREE.Color {
    return RenderGlobals.ambientUp.clone();
  }

  dispose(): void {
    this.unsub();
    this.cubeRT.dispose();
    this.envRT?.dispose();
    this.probeRT?.dispose();
    this.pmrem.dispose();
  }
}

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export type TimeOfDay = 'morning' | 'noon' | 'dusk' | 'overcast';

interface Preset {
  elevation: number; // degrees above horizon
  azimuth: number;
  sun: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  fog: string;
  fogNear: number;
  fogFar: number;
  turbidity: number;
  rayleigh: number;
  exposure: number;
}

const PRESETS: Record<TimeOfDay, Preset> = {
  morning: { elevation: 14, azimuth: 110, sun: '#ffd2a0', sunIntensity: 2.3, hemiSky: '#c9d8e8', hemiGround: '#4a4032', hemiIntensity: 0.8, fog: '#c8bca8', fogNear: 120, fogFar: 1150, turbidity: 8, rayleigh: 2.2, exposure: 0.85 },
  noon: { elevation: 58, azimuth: 150, sun: '#fff1dc', sunIntensity: 2.8, hemiSky: '#dfe8f0', hemiGround: '#4a4436', hemiIntensity: 0.9, fog: '#bfc3c2', fogNear: 160, fogFar: 1300, turbidity: 6, rayleigh: 1.4, exposure: 0.9 },
  dusk: { elevation: 6, azimuth: 250, sun: '#ff9a5a', sunIntensity: 2.0, hemiSky: '#8a8fb0', hemiGround: '#3a2e28', hemiIntensity: 0.6, fog: '#a88470', fogNear: 90, fogFar: 950, turbidity: 10, rayleigh: 3.0, exposure: 0.95 },
  overcast: { elevation: 40, azimuth: 180, sun: '#d8dde2', sunIntensity: 0.9, hemiSky: '#aab4bd', hemiGround: '#4d4b44', hemiIntensity: 1.5, fog: '#9ea4a6', fogNear: 60, fogFar: 700, turbidity: 20, rayleigh: 0.6, exposure: 0.95 },
};

const SHADOW_EXTENT = 85;
const SHADOW_MAP = 4096;

/** Sky, sun, ambient and fog. The sun's shadow frustum follows the player, snapped to texels. */
export class DayNight {
  readonly sun = new THREE.DirectionalLight();
  readonly hemi = new THREE.HemisphereLight();
  /** Shadowless bounce light opposite the sun so shaded walls keep form. */
  readonly fill = new THREE.DirectionalLight();
  readonly sky = new Sky();
  readonly sunDir = new THREE.Vector3();
  readonly fog = new THREE.Fog('#bfc3c2', 160, 1300);
  current: TimeOfDay = 'noon';
  private texel = (SHADOW_EXTENT * 2) / SHADOW_MAP;

  constructor(scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(5000);
    scene.add(this.sky, this.hemi, this.sun, this.sun.target, this.fill, this.fill.target);
    scene.fog = this.fog;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -SHADOW_EXTENT;
    s.right = s.top = SHADOW_EXTENT;
    s.near = 1;
    s.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.set('noon');
  }

  set(tod: TimeOfDay): void {
    this.current = tod;
    const p = PRESETS[tod];
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - p.elevation), THREE.MathUtils.degToRad(p.azimuth));
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.85;
    u.sunPosition.value.copy(this.sunDir);
    this.sun.color.set(p.sun);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.fill.color.set(p.hemiSky);
    this.fill.intensity = p.hemiIntensity * 0.7;
    this.fill.position.set(-this.sunDir.x, 0.35, -this.sunDir.z).normalize().multiplyScalar(100);
    this.fog.color.set(p.fog);
    this.fog.near = p.fogNear;
    this.fog.far = p.fogFar;
    this.renderer.toneMappingExposure = p.exposure;
  }

  /** Centre the shadow frustum on `focus`, snapped to shadow texels to stop shimmering. */
  update(focus: THREE.Vector3): void {
    const snap = (v: number) => Math.round(v / this.texel) * this.texel;
    const f = new THREE.Vector3(snap(focus.x), snap(focus.y), snap(focus.z));
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(this.sunDir, 300);
    this.sun.target.updateMatrixWorld();
  }

  get skyColor(): THREE.Color {
    return this.fog.color;
  }
  get ambientColor(): THREE.Color {
    return this.hemi.color.clone().multiplyScalar(this.hemi.intensity * 0.55);
  }
}

import * as THREE from 'three';
import { Events } from '../core/Events';
import { SenseMods } from '../ai/SenseMods';
import { Sfx } from '../audio/Sfx';

export type WeatherState = 'clear' | 'rain' | 'storm' | 'fog';
export const WEATHER_STATES: WeatherState[] = ['clear', 'rain', 'storm', 'fog'];

interface Profile {
  fogNear: number;
  fogFar: number;
  sun: number;
  hemi: number;
  tint: string;
  tintK: number;
  cover: number;
  rain: number;
  wet: number;
  vision: number;
  hearing: number;
  exposure: number;
}

const PROFILES: Record<WeatherState, Profile> = {
  clear: { fogNear: 1, fogFar: 1, sun: 1, hemi: 1, tint: '#9aa0a4', tintK: 0, cover: 0, rain: 0, wet: 0, vision: 1, hearing: 1, exposure: 1 },
  rain: { fogNear: 0.45, fogFar: 0.5, sun: 0.4, hemi: 0.85, tint: '#7f878c', tintK: 0.6, cover: 0.8, rain: 0.55, wet: 0.8, vision: 0.85, hearing: 0.75, exposure: 0.95 },
  storm: { fogNear: 0.25, fogFar: 0.32, sun: 0.15, hemi: 0.6, tint: '#4c535a', tintK: 0.85, cover: 0.95, rain: 1, wet: 1, vision: 0.7, hearing: 0.6, exposure: 0.9 },
  fog: { fogNear: 0.02, fogFar: 0.08, sun: 0.55, hemi: 1.05, tint: '#b3b7b6', tintK: 0.8, cover: 0.85, rain: 0, wet: 0.3, vision: 0.45, hearing: 1, exposure: 1 },
};

/** Something the weather multiplies. Detects when its owner (DayNight) rewrites the value and rebases. */
class Tracked {
  private base: number;
  private written: number;
  constructor(private get: () => number, private set: (v: number) => void) {
    this.base = this.written = get();
  }
  apply(mult: number): void {
    const cur = this.get();
    if (Math.abs(cur - this.written) > 1e-4) this.base = cur;
    this.written = this.base * mult;
    this.set(this.written);
  }
}

const RAIN_N = 16000;

/**
 * W4 — weather: clear | rain | storm | fog. Runs beside DayNight without editing it:
 * multiplies fog distances / light intensities / exposure (rebasing whenever DayNight
 * changes them), draws GPU rain streaks around the camera, an overcast dome, storm
 * lightning + distance-delayed thunder, and feeds the AI (SenseMods vision/hearing).
 *
 * API for W1: `weather.wetness` (0..1, eased) and `Events.on('weather:changed', {state, wetness})`
 * (emitted on state change and whenever wetness moves by ≥ 0.05). `weather.set(state)`.
 */
export class Weather {
  state: WeatherState = 'clear';
  /** 0..1 surface wetness (eases in over ~20 s of rain, dries over ~60 s). */
  wetness = 0;
  private lastEmitWet = 0;
  private cur: Profile = { ...PROFILES.clear };
  private tracked: Tracked[] = [];
  private fogColorBase = new THREE.Color();
  private fogColorWritten = new THREE.Color();
  private tint = new THREE.Color();
  private rain: THREE.LineSegments;
  private rainMat: THREE.ShaderMaterial;
  private dome: THREE.Mesh;
  private domeMat: THREE.MeshBasicMaterial;
  private flash: THREE.HemisphereLight;
  private flashT = 0;
  private nextStrike = 5;
  private bolt: THREE.LineSegments;
  private boltT = 0;
  private time = 0;
  private gust = 0;

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private dn: { fog: THREE.Fog; sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight },
  ) {
    const fog = dn.fog;
    this.tracked = [
      new Tracked(() => fog.near, (v) => (fog.near = v)),
      new Tracked(() => fog.far, (v) => (fog.far = v)),
      new Tracked(() => dn.sun.intensity, (v) => (dn.sun.intensity = v)),
      new Tracked(() => dn.hemi.intensity, (v) => (dn.hemi.intensity = v)),
      new Tracked(() => renderer.toneMappingExposure, (v) => (renderer.toneMappingExposure = v)),
    ];
    this.fogColorBase.copy(fog.color);
    this.fogColorWritten.copy(fog.color);
    this.tint.copy(fog.color);

    // Rain streaks
    const seeds = new Float32Array(RAIN_N * 2 * 4);
    const ends = new Float32Array(RAIN_N * 2);
    for (let i = 0; i < RAIN_N; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let e = 0; e < 2; e++) {
        seeds.set(s, (i * 2 + e) * 4);
        ends[i * 2 + e] = e;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_N * 2 * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    this.rainMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(60, 32, 60) },
        uWind: { value: new THREE.Vector3(2, 0, 1) },
        uSpeed: { value: 22 },
        uLen: { value: 0.9 },
        uDensity: { value: 0 },
        uColor: { value: new THREE.Color('#c8d2dc') },
      },
      vertexShader: /* glsl */ `
        uniform float uTime, uSpeed, uLen, uDensity;
        uniform vec3 uCam, uBox, uWind;
        attribute vec4 aSeed;
        attribute float aEnd;
        varying float vA;
        void main() {
          vec3 b = uBox;
          float fall = uTime * uSpeed * (0.85 + aSeed.w * 0.3);
          vec3 p;
          p.x = uCam.x + mod(aSeed.x * b.x - uCam.x + uWind.x * uTime, b.x) - b.x * 0.5;
          p.z = uCam.z + mod(aSeed.z * b.z - uCam.z + uWind.z * uTime, b.z) - b.z * 0.5;
          p.y = uCam.y + mod(aSeed.y * b.y - fall - uCam.y, b.y) - b.y * 0.5;
          vec3 vel = normalize(vec3(uWind.x, -uSpeed, uWind.z));
          p -= vel * uLen * aEnd;
          vA = (aSeed.w < uDensity ? 1.0 : 0.0) * (1.0 - aEnd * 0.8);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vA *= smoothstep(0.5, 3.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          if (vA < 0.01) discard;
          gl_FragColor = vec4(uColor, vA * 0.38);
        }`,
    });
    this.rain = new THREE.LineSegments(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.renderOrder = 6;
    scene.add(this.rain);

    // Overcast dome (inside the sky, fades the blue sky into cloud cover)
    this.domeMat = new THREE.MeshBasicMaterial({ color: '#888', side: THREE.BackSide, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(2300, 32, 16), this.domeMat);
    this.dome.renderOrder = -1;
    this.dome.frustumCulled = false;
    this.dome.visible = false;
    scene.add(this.dome);

    this.flash = new THREE.HemisphereLight('#dfe8ff', '#556070', 0);
    scene.add(this.flash);
    this.bolt = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#eef4ff', transparent: true, fog: false }));
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    scene.add(this.bolt);
  }

  set(state: WeatherState): void {
    this.state = state;
    this.nextStrike = 2 + Math.random() * 4;
    Events.emit('weather:changed', { state, wetness: this.wetness });
  }

  /** Instantly jump to the target look (tests / map load). */
  snap(): void {
    this.cur = { ...PROFILES[this.state] };
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.time += dt;
    const target = PROFILES[this.state];
    const k = 1 - Math.exp(-dt / 2.5);
    const c = this.cur;
    for (const key of ['fogNear', 'fogFar', 'sun', 'hemi', 'tintK', 'cover', 'rain', 'vision', 'hearing', 'exposure'] as const) {
      c[key] += (target[key] - c[key]) * k;
    }
    this.tint.lerp(new THREE.Color(target.tint), k);
    const wetRate = target.wet > this.wetness ? 1 / 20 : 1 / 60;
    this.wetness += THREE.MathUtils.clamp(target.wet - this.wetness, -wetRate * dt, wetRate * dt);
    if (Math.abs(this.wetness - this.lastEmitWet) >= 0.05) {
      this.lastEmitWet = this.wetness;
      Events.emit('weather:changed', { state: this.state, wetness: this.wetness });
    }

    // Lighting/fog multipliers (rebased whenever DayNight rewrites them)
    const [near, far, sun, hemi, exposure] = this.tracked;
    near.apply(c.fogNear);
    far.apply(c.fogFar);
    sun.apply(c.sun);
    hemi.apply(c.hemi);
    exposure.apply(c.exposure);
    const fog = this.dn.fog;
    if (!fog.color.equals(this.fogColorWritten)) this.fogColorBase.copy(fog.color);
    fog.color.copy(this.fogColorBase).lerp(this.tint, c.tintK);
    // Lightning brightens fog/dome for a moment
    const fl = Math.max(0, this.flash.intensity / 3);
    fog.color.lerp(new THREE.Color('#c8d4ea'), fl * 0.5);
    this.fogColorWritten.copy(fog.color);

    this.dome.visible = c.cover > 0.01;
    this.dome.position.copy(camPos);
    this.domeMat.color.copy(fog.color);
    this.domeMat.opacity = c.cover;

    // AI senses
    SenseMods.vision = c.vision;
    SenseMods.hearing = c.hearing;

    // Rain
    this.rain.visible = c.rain > 0.01;
    const u = this.rainMat.uniforms;
    u.uTime.value = this.time;
    u.uCam.value.copy(camPos);
    u.uDensity.value = c.rain;
    this.gust += (Math.sin(this.time * 0.37) * Math.sin(this.time * 1.13) - this.gust) * Math.min(1, dt);
    const wind = this.state === 'storm' ? 5 + this.gust * 6 : 1.5;
    u.uWind.value.set(wind, 0, wind * 0.4);
    Sfx.setRain(c.rain);

    // Storm lightning
    if (this.state === 'storm') {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = 5 + Math.random() * 9;
        this.strike(camPos);
      }
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      // Double flicker
      const t = this.flashT;
      this.flash.intensity = t > 0.18 ? 3.2 : t > 0.12 ? 0.4 : t > 0 ? 2.4 * (t / 0.12) : 0;
    } else this.flash.intensity = 0;
    if (this.boltT > 0) {
      this.boltT -= dt;
      this.bolt.visible = this.boltT > 0 && (this.boltT > 0.15 || this.boltT % 0.06 < 0.03);
    }
  }

  /** Lightning strike somewhere around the camera: flash, bolt, delayed thunder. */
  strike(camPos: THREE.Vector3, dist = 250 + Math.random() * 700): void {
    this.flashT = 0.3;
    this.boltT = 0.3;
    const a = Math.random() * Math.PI * 2;
    const base = new THREE.Vector3(camPos.x + Math.cos(a) * dist, camPos.y - 20, camPos.z + Math.sin(a) * dist);
    const pts: THREE.Vector3[] = [];
    let p = base.clone().add(new THREE.Vector3(0, 420, 0));
    for (let i = 0; i < 14; i++) {
      const q = p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 40, -30, (Math.random() - 0.5) * 40));
      pts.push(p, q);
      if (Math.random() < 0.3) pts.push(q.clone(), q.clone().add(new THREE.Vector3((Math.random() - 0.5) * 60, -35, (Math.random() - 0.5) * 60)));
      p = q;
    }
    this.bolt.geometry.dispose();
    this.bolt.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.bolt.visible = true;
    Sfx.thunder(dist);
  }

  dispose(): void {
    this.scene.remove(this.rain, this.dome, this.flash, this.bolt);
  }
}

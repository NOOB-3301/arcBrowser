import * as THREE from 'three';
import type { Heightmap } from './Heightmap';
import type { GenResult } from './MapGen';
import { Quality, type QualityPreset } from '../render/Quality';
import { RenderGlobals, setTerrainHeight } from '../render/RenderGlobals';

const vert = /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D tHeight;
  uniform sampler2D tGrass;
  uniform float uHalf;
  uniform float uCell;
  uniform float uN;
  uniform vec2 uCenter;
  uniform vec3 uCam;
  uniform float uRadius;
  uniform float uSpacing;
  uniform float uTime;
  attribute vec2 aOffset;
  attribute vec3 aBlade; // x = height fraction (0 base .. 1 tip), y = side (-1..1), z = blade index
  varying float vTip;
  varying vec3 vColorVar;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  #include <shadowmap_pars_vertex>
  #include <fog_pars_vertex>

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  float heightAt(vec2 w) {
    vec2 f = (w + uHalf) / uCell;
    vec2 i = floor(f);
    vec2 t = f - i;
    ivec2 c = ivec2(clamp(i, vec2(0.0), vec2(uN - 2.0)));
    float h00 = texelFetch(tHeight, c, 0).r;
    float h10 = texelFetch(tHeight, c + ivec2(1, 0), 0).r;
    float h01 = texelFetch(tHeight, c + ivec2(0, 1), 0).r;
    float h11 = texelFetch(tHeight, c + ivec2(1, 1), 0).r;
    return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  }

  void main() {
    vec2 world = uCenter + aOffset;
    vec2 id = floor(world / uSpacing + 0.5);
    float r1 = hash(id);
    float r2 = hash(id + 17.3);
    float r3 = hash(id + 41.9);
    world += (vec2(r1, r2) - 0.5) * uSpacing * 1.4;

    vec2 uv = (world + uHalf) / (uHalf * 2.0);
    float g = texture(tGrass, uv).r;
    float dist = length(world - uCam.xz);
    float fade = 1.0 - smoothstep(uRadius * 0.6, uRadius, dist);
    float s = smoothstep(0.25, 0.7, g) * fade * (0.55 + r3 * 0.6);

    // Per-blade randomisation within the tuft
    float bi = aBlade.z;
    float rb = hash(id + bi * 3.17);
    float ang = r1 * 6.2831 + bi * 2.39996 + rb * 0.6;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 side = vec2(-dir.y, dir.x);
    float h = aBlade.x;
    float height = (0.32 + 0.35 * rb + 0.18 * r2) * s;
    float width = 0.035 * (1.0 - h * 0.85) * s;
    // Blades lean outward from the tuft centre and curve over
    float lean = (0.25 + 0.45 * rb) * h * h;
    // Wind: large gusts + flutter
    float gust = vnoise(world * 0.08 + vec2(uTime * 0.35, uTime * 0.2));
    float wind = (gust * 1.4 - 0.4) * 0.35 + sin(uTime * 3.1 + world.x * 0.9 + bi) * 0.05;
    vec3 p = vec3(0.0);
    p.xz = dir * (0.03 + lean * height) + side * aBlade.y * width + vec2(0.8, 0.5) * wind * h * h * height;
    p.y = h * height * (1.0 - 0.25 * lean);
    vec3 wp = vec3(world.x, heightAt(world) - 0.03, world.y) + p;

    // Normal: across-blade normal tilted by the curl, blended towards up for soft shading
    vec3 bn = normalize(vec3(dir.x, 0.0, dir.y) * 0.6 + vec3(side.x, 0.0, side.y) * aBlade.y * 0.5 + vec3(0.0, 0.4, 0.0));
    vNormalW = normalize(mix(bn, vec3(0.0, 1.0, 0.0), 0.45));
    vTip = h;
    // Colour variation: dry/lush patches + per-tuft jitter
    float patchN = vnoise(world * 0.05);
    float dry = smoothstep(0.35, 0.8, vnoise(world * 0.012 + 3.1) * 0.7 + patchN * 0.3);
    vColorVar = mix(vec3(0.85, 1.0, 0.8), vec3(1.25, 1.08, 0.62), dry) * (0.85 + r3 * 0.3);
    vWorldPos = wp;

    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
      vSunShadowWorldPosition = vec4(wp, -mvPosition.z);
      vSunShadowWorldNormal = vec3(0.0, 1.0, 0.0);
    #endif
    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uTipCol;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform vec3 uAmbient;
  uniform vec3 uAmbientDown;
  varying float vTip;
  varying vec3 vColorVar;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <fog_pars_fragment>
  void main() {
    vec3 albedo = mix(uBase, uTipCol, smoothstep(0.0, 1.0, vTip)) * vColorVar;
    vec3 v = normalize(cameraPosition - vWorldPos);
    vec3 n = vNormalW;
    if (dot(n, v) < 0.0) n = normalize(n + v * 0.8);
    float shadow = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
      shadow = getSunShadow( sunShadowMap[ 0 ], sunLightShadows[ 0 ], 0 );
    #endif
    float ao = mix(0.3, 1.0, smoothstep(0.0, 0.8, vTip));
    float ndl = max(dot(n, uSunDir) * 0.7 + 0.3, 0.0);
    vec3 amb = mix(uAmbientDown, uAmbient, 0.5 + 0.5 * vTip) * ao;
    vec3 direct = uSunColor * ndl * shadow * mix(0.55, 1.0, vTip);
    // Translucency: blades glow when backlit by the sun
    float back = pow(max(dot(-v, uSunDir), 0.0), 4.0);
    vec3 trans = uSunColor * back * vTip * shadow * 0.9 * vec3(1.0, 1.05, 0.6);
    vec3 col = albedo * (amb + direct + trans) * RECIPROCAL_PI;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** Blade tuft: 4 tapered blades, 3 segments each (7 triangles per blade). */
function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const blade: number[] = [];
  const SEG = 3;
  const push = (h: number, s: number, b: number) => {
    pos.push(0, 0, 0);
    blade.push(h, s, b);
  };
  for (let b = 0; b < 4; b++) {
    for (let i = 0; i < SEG; i++) {
      const h0 = i / SEG;
      const h1 = (i + 1) / SEG;
      if (i < SEG - 1) {
        push(h0, -1, b); push(h0, 1, b); push(h1, 1, b);
        push(h0, -1, b); push(h1, 1, b); push(h1, -1, b);
      } else {
        push(h0, -1, b); push(h0, 1, b); push(1, 0, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 3));
  return g;
}

/**
 * GPU grass: a fixed grid of tufts that follows the camera; the vertex shader
 * snaps them to world cells, reads terrain height + grass mask from textures,
 * shapes individual curved blades and fades by distance. Receives cascaded sun
 * shadows. Zero per-frame CPU cost beyond a uniform update.
 */
export class Foliage {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private base = tuftGeometry();
  private spacing = 0.42;
  private unsub: () => void;

  constructor(scene: THREE.Scene, hm: Heightmap, gen: GenResult) {
    // Grass mask texture: grass splat weight, zeroed where clear (roads, pads, water)
    const n = hm.n;
    const mask = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) mask[i] = gen.clear[i] ? 0 : hm.splat[i * 6];
    const grassTex = new THREE.DataTexture(mask, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    grassTex.magFilter = grassTex.minFilter = THREE.LinearFilter;
    grassTex.needsUpdate = true;
    const heightTex = hm.toTexture();
    setTerrainHeight(heightTex, hm.half, hm.cell, n);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      fog: true,
      lights: true,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        THREE.UniformsLib.lights,
        {
          tHeight: { value: null },
          tGrass: { value: null },
          uHalf: { value: hm.half },
          uCell: { value: hm.cell },
          uN: { value: n },
          uCenter: { value: new THREE.Vector2() },
          uCam: { value: new THREE.Vector3() },
          uRadius: { value: 32 },
          uSpacing: { value: 0.42 },
          uTime: { value: 0 },
          uBase: { value: new THREE.Color('#3a3a1c') },
          uTipCol: { value: new THREE.Color('#aea062') },
          uSunColor: { value: new THREE.Color('#fff1dc') },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uAmbient: { value: new THREE.Color('#5a6470') },
          uAmbientDown: { value: new THREE.Color('#2a2620') },
        },
      ]),
    });
    // Textures must not be cloned by UniformsUtils.merge
    this.mat.uniforms.tHeight.value = heightTex;
    this.mat.uniforms.tGrass.value = grassTex;

    this.geo = new THREE.InstancedBufferGeometry();
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.rebuild(Quality.current);
    this.unsub = Quality.onChange((q) => this.rebuild(q));
    scene.add(this.mesh);
  }

  private rebuild(q: QualityPreset): void {
    this.spacing = q.grassSpacing;
    const offsets: number[] = [];
    const r = Math.ceil(q.grassRadius / q.grassSpacing);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) offsets.push(i * q.grassSpacing, j * q.grassSpacing);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', this.base.attributes.position);
    geo.setAttribute('aBlade', this.base.attributes.aBlade);
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 2));
    geo.instanceCount = offsets.length / 2;
    const old = this.geo;
    this.geo = geo;
    this.mesh.geometry = geo;
    if (old !== geo) old.dispose();
    this.mat.uniforms.uRadius.value = q.grassRadius;
    this.mat.uniforms.uSpacing.value = q.grassSpacing;
  }

  /** Lighting comes from RenderGlobals (DayNight); the extra params are kept for API compatibility. */
  update(dt: number, camPos: THREE.Vector3, _sunColor?: THREE.Color, _ambient?: THREE.Color, _sunUp?: number): void {
    const u = this.mat.uniforms;
    u.uTime.value += dt;
    u.uCenter.value.set(Math.floor(camPos.x / this.spacing) * this.spacing, Math.floor(camPos.z / this.spacing) * this.spacing);
    u.uCam.value.copy(camPos);
    u.uSunColor.value.copy(RenderGlobals.sunColor);
    u.uSunDir.value.copy(RenderGlobals.sunDir);
    u.uAmbient.value.copy(RenderGlobals.ambientUp);
    u.uAmbientDown.value.copy(RenderGlobals.ambientDown);
  }

  dispose(): void {
    this.unsub();
    this.geo.dispose();
    this.mat.dispose();
  }
}

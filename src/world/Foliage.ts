import * as THREE from 'three';
import type { Heightmap } from './Heightmap';
import type { GenResult } from './MapGen';

const SPACING = 0.42;
const RADIUS = 32;

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
  attribute float aTip;
  varying float vTip;
  varying float vShade;
  #include <fog_pars_vertex>

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

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
    float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius, dist);
    float s = smoothstep(0.25, 0.7, g) * fade * (0.5 + r3 * 0.6);

    float a = r1 * 6.2831;
    mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
    vec3 p = position;
    p.xz = rot * p.xz;
    p *= vec3(s, s * (0.8 + r2 * 0.6), s);
    // Wind: sway tips
    float wind = sin(uTime * 1.6 + world.x * 0.21 + world.y * 0.13) + 0.5 * sin(uTime * 2.7 + world.x * 0.5);
    p.xz += aTip * vec2(wind * 0.09, wind * 0.05) * s;

    vec3 wp = vec3(world.x, heightAt(world) - 0.05, world.y) + p;
    vTip = aTip;
    vShade = 0.8 + r3 * 0.35;
    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uTipCol;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uSunUp;
  varying float vTip;
  varying float vShade;
  #include <fog_pars_fragment>
  void main() {
    vec3 col = mix(uBase, uTipCol, vTip) * vShade;
    col *= uAmbient + uSunColor * (0.35 + 0.65 * uSunUp) * (0.5 + 0.5 * vTip);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * GPU grass: a fixed grid of tufts that follows the camera; the vertex shader
 * snaps them to world cells, reads terrain height + grass mask from textures,
 * and fades by distance. Zero per-frame CPU cost beyond a uniform update.
 */
export class Foliage {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, hm: Heightmap, gen: GenResult) {
    // Tuft: three crossed quads
    const pos: number[] = [];
    const tip: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      const cx = Math.cos(a) * 0.13;
      const cz = Math.sin(a) * 0.13;
      const quad = [
        [-cx, 0, -cz, 0], [cx, 0, cz, 0], [cx * 0.25, 0.42, cz * 0.25, 1],
        [-cx, 0, -cz, 0], [cx * 0.25, 0.42, cz * 0.25, 1], [-cx * 0.25, 0.42, -cz * 0.25, 1],
      ];
      for (const [x, y, z, t] of quad) {
        pos.push(x, y, z);
        tip.push(t);
      }
    }
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    base.setAttribute('aTip', new THREE.Float32BufferAttribute(tip, 1));

    const offsets: number[] = [];
    const r = Math.ceil(RADIUS / SPACING);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) offsets.push(i * SPACING, j * SPACING);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = null;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('aTip', base.attributes.aTip);
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 2));
    geo.instanceCount = offsets.length / 2;

    // Grass mask texture: grass splat weight, zeroed where clear (roads, pads, water)
    const n = hm.n;
    const mask = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) mask[i] = gen.clear[i] ? 0 : hm.splat[i * 6];
    const grassTex = new THREE.DataTexture(mask, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    grassTex.magFilter = grassTex.minFilter = THREE.LinearFilter;
    grassTex.needsUpdate = true;
    const heightTex = hm.toTexture();

    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      fog: true,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          tHeight: { value: null },
          tGrass: { value: null },
          uHalf: { value: hm.half },
          uCell: { value: hm.cell },
          uN: { value: n },
          uCenter: { value: new THREE.Vector2() },
          uCam: { value: new THREE.Vector3() },
          uRadius: { value: RADIUS },
          uSpacing: { value: SPACING },
          uTime: { value: 0 },
          uBase: { value: new THREE.Color('#2f3d1e') },
          uTipCol: { value: new THREE.Color('#8a9a52') },
          uSunColor: { value: new THREE.Color('#fff1dc') },
          uAmbient: { value: new THREE.Color('#5a6470') },
          uSunUp: { value: 0.8 },
        },
      ]),
    });
    // Textures must not be cloned by UniformsUtils.merge
    this.mat.uniforms.tHeight.value = heightTex;
    this.mat.uniforms.tGrass.value = grassTex;

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(dt: number, camPos: THREE.Vector3, sunColor: THREE.Color, ambient: THREE.Color, sunUp: number): void {
    const u = this.mat.uniforms;
    u.uTime.value += dt;
    u.uCenter.value.set(Math.floor(camPos.x / SPACING) * SPACING, Math.floor(camPos.z / SPACING) * SPACING);
    u.uCam.value.copy(camPos);
    u.uSunColor.value.copy(sunColor);
    u.uAmbient.value.copy(ambient);
    u.uSunUp.value = sunUp;
  }
}

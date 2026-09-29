import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { Quality } from '../render/Quality';
import { HEIGHT_FN, RenderGlobals, heightUniforms } from '../render/RenderGlobals';

const TEX_BASE = '/assets/textures/';
const PBR_BASE = '/assets/textures/pbr/';
const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();
const pending: Promise<unknown>[] = [];

/** Materials with a PBR set available as KTX2 (albedo+height, normal/rough/AO). */
const PBR_NAMES = new Set([
  'aerial_grass_rock', 'forrest_ground_01', 'rock_face', 'coast_sand_01', 'asphalt_02', 'concrete_floor_worn_001',
  'rusty_metal_02', 'corrugated_iron', 'concrete_wall_008', 'plastered_wall_02', 'red_brick_03',
]);

let ktx2: KTX2Loader | null = null;

/** Must be called once with the renderer before any PBR texture is requested (Game constructor). */
export function initTextures(renderer: THREE.WebGLRenderer): void {
  if (ktx2) return;
  ktx2 = new KTX2Loader().setTranscoderPath('/assets/basis/').detectSupport(renderer);
}

/** Repeat-wrapped sRGB texture from public/assets/textures (cached). Legacy JPG path. */
export function tex(name: string): THREE.Texture {
  let t = cache.get(name);
  if (t) return t;
  t = new THREE.Texture();
  const target = t;
  pending.push(
    loader.loadAsync(`${TEX_BASE}${name}.jpg`).then((img) => {
      target.image = img.image;
      target.needsUpdate = true;
    }),
  );
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Quality.current.anisotropy;
  cache.set(name, t);
  return t;
}

/** A PBR texture pair exposed as shared uniform holders (value swapped in when loaded). */
export interface PBRSet {
  /** RGB albedo (sRGB) + A height. */
  color: { value: THREE.Texture };
  /** R,G normal XY (GL), B roughness, A AO (linear). */
  data: { value: THREE.Texture };
}

function solid(r: number, g: number, b: number, a: number, srgb: boolean): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
const FLAT_DATA = solid(128, 128, 210, 255, false);
const pbrCache = new Map<string, PBRSet>();
const loadedTextures: THREE.Texture[] = [];

function loadKtx2(url: string, holder: { value: THREE.Texture }, drop: number): void {
  if (!ktx2) throw new Error('initTextures(renderer) must be called before loading PBR textures');
  pending.push(
    ktx2
      .loadAsync(url)
      .then((t) => {
        const ct = t as THREE.CompressedTexture;
        // Lower presets drop top mips = half/quarter resolution for free
        const d = Math.min(drop, Math.max(0, ct.mipmaps.length - 4));
        if (d > 0) {
          ct.mipmaps = ct.mipmaps.slice(d);
          const m0 = ct.mipmaps[0] as unknown as { width: number; height: number };
          (ct.image as { width: number; height: number }).width = m0.width;
          (ct.image as { width: number; height: number }).height = m0.height;
        }
        ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
        ct.anisotropy = Quality.current.anisotropy;
        ct.needsUpdate = true;
        holder.value = ct;
        loadedTextures.push(ct);
      })
      .catch((e) => console.warn('texture load failed', url, e)),
  );
}

/** PBR set for a Poly Haven material (falls back to the legacy JPG albedo + flat data). */
export function pbr(name: string): PBRSet {
  let s = pbrCache.get(name);
  if (s) return s;
  if (PBR_NAMES.has(name)) {
    s = { color: { value: solid(128, 120, 110, 255, true) }, data: { value: FLAT_DATA } };
    const drop = Quality.current.textureDrop;
    loadKtx2(`${PBR_BASE}${name}_c.ktx2`, s.color, drop);
    loadKtx2(`${PBR_BASE}${name}_n.ktx2`, s.data, drop);
  } else {
    s = { color: { value: tex(name) }, data: { value: FLAT_DATA } };
  }
  pbrCache.set(name, s);
  return s;
}

/** Approximate GPU bytes of loaded PBR textures (for the debug readout). */
export function pbrTextureBytes(): number {
  let b = 0;
  for (const t of loadedTextures) {
    for (const m of (t as THREE.CompressedTexture).mipmaps as unknown as { data: ArrayBufferView }[]) b += m.data.byteLength;
  }
  return b;
}

/** Resolves when every texture requested so far has loaded. */
export function texturesReady(): Promise<unknown> {
  return Promise.all(pending);
}

// Materials that honour live quality changes (normal maps on/off, anisotropy)
const pbrMaterials = new Set<THREE.Material>();
export function registerPbrMaterial(m: THREE.Material): void {
  pbrMaterials.add(m);
  applyNormalDefine(m);
}
function applyNormalDefine(m: THREE.Material): void {
  m.defines = m.defines ?? {};
  if (Quality.current.normalMaps) delete m.defines.RF_NO_NORMALMAP;
  else m.defines.RF_NO_NORMALMAP = '';
}
Quality.onChange((q) => {
  for (const m of pbrMaterials) {
    applyNormalDefine(m);
    m.needsUpdate = true;
  }
  for (const t of loadedTextures) {
    if (t.anisotropy !== q.anisotropy) {
      t.anisotropy = q.anisotropy;
      t.needsUpdate = true;
    }
  }
});

/** GLSL: world position/normal varyings computed in the vertex stage (instancing-aware). */
export const WORLD_VARYINGS_VERT = /* glsl */ `
  vec4 twp = vec4(transformed, 1.0);
  vec3 twn = objectNormal;
  #ifdef USE_INSTANCING
    twp = instanceMatrix * twp;
    twn = mat3(instanceMatrix) * twn;
  #endif
  twp = modelMatrix * twp;
  vTriPos = twp.xyz;
  vTriNormal = normalize(mat3(modelMatrix) * twn);
`;

/** GLSL: legacy albedo-only triplanar. */
export const TRIPLANAR_FN = /* glsl */ `
  vec3 triplanar(sampler2D t, vec3 p, vec3 n, float scale) {
    vec3 b = pow(abs(n), vec3(4.0));
    b /= (b.x + b.y + b.z + 1e-5);
    vec3 x = texture(t, p.zy / scale).rgb;
    vec3 y = texture(t, p.xz / scale).rgb;
    vec3 z = texture(t, p.xy / scale).rgb;
    return x * b.x + y * b.y + z * b.z;
  }
`;

/**
 * GLSL helpers shared by terrain + kit:
 *  - rfUnpackN: data texel -> tangent-space normal (reconstructed Z)
 *  - rfTnWorld: whiteout-blend a tangent normal onto the geometric normal for a
 *    world-projected plane with tangent T, bitangent B (image-up) and plane normal Np
 *  - rfNoise / rfFbm: cheap value noise for macro variation and grime
 */
export const PBR_COMMON_FN = /* glsl */ `
  vec3 rfUnpackN( vec4 d, float strength ) {
    vec2 xy = ( d.xy * 2.0 - 1.0 ) * strength;
    return vec3( xy, sqrt( max( 1.0 - dot( xy, xy ), 0.0 ) ) );
  }
  vec3 rfTnWorld( vec3 tn, vec3 N, vec3 T, vec3 B, vec3 Np ) {
    vec3 g = vec3( dot( N, T ), dot( N, B ), abs( dot( N, Np ) ) );
    vec3 r = vec3( tn.xy + g.xy, tn.z * g.z );
    return r.x * T + r.y * B + r.z * Np;
  }
  float rfHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
  float rfNoise( vec2 p ) {
    vec2 i = floor( p ); vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( rfHash( i ), rfHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( rfHash( i + vec2( 0.0, 1.0 ) ), rfHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
  float rfFbm( vec2 p ) { return rfNoise( p ) * 0.55 + rfNoise( p * 2.13 + 7.1 ) * 0.3 + rfNoise( p * 4.7 + 3.3 ) * 0.15; }
`;

/** GLSL: full PBR triplanar sample (albedo+height, normal, roughness, AO). */
export const PBR_TRIPLANAR_FN = /* glsl */ `
  void rfTriplanar( sampler2D tc, sampler2D td, vec3 p, vec3 N, float scale, float nStrength,
                    out vec4 albedo, out vec3 nW, out float rough, out float ao ) {
    vec3 w = pow( abs( N ), vec3( 4.0 ) );
    w /= ( w.x + w.y + w.z + 1e-5 );
    vec2 uvX = p.zy / scale;
    vec2 uvY = p.xz / scale;
    vec2 uvZ = p.xy / scale;
    albedo = texture( tc, uvX ) * w.x + texture( tc, uvY ) * w.y + texture( tc, uvZ ) * w.z;
    vec4 dX = texture( td, uvX );
    vec4 dY = texture( td, uvY );
    vec4 dZ = texture( td, uvZ );
    vec4 d = dX * w.x + dY * w.y + dZ * w.z;
    rough = d.b;
    ao = d.a;
    #ifdef RF_NO_NORMALMAP
      nW = N;
    #else
      vec3 s = vec3( N.x < 0.0 ? -1.0 : 1.0, N.y < 0.0 ? -1.0 : 1.0, N.z < 0.0 ? -1.0 : 1.0 );
      vec3 nx = rfTnWorld( rfUnpackN( dX, nStrength ), N, vec3( 0.0, 0.0, s.x ), vec3( 0.0, -1.0, 0.0 ), vec3( s.x, 0.0, 0.0 ) );
      vec3 ny = rfTnWorld( rfUnpackN( dY, nStrength ), N, vec3( s.y, 0.0, 0.0 ), vec3( 0.0, 0.0, -1.0 ), vec3( 0.0, s.y, 0.0 ) );
      vec3 nz = rfTnWorld( rfUnpackN( dZ, nStrength ), N, vec3( -s.z, 0.0, 0.0 ), vec3( 0.0, -1.0, 0.0 ), vec3( 0.0, 0.0, s.z ) );
      nW = normalize( nx * w.x + ny * w.y + nz * w.z );
    #endif
  }
`;

export interface TriplanarOpts {
  scale?: number;
  color?: THREE.ColorRepresentation;
  /** Multiplies the texture roughness. */
  roughness?: number;
  metalness?: number;
  /** Albedo gain (legacy name). */
  gain?: number;
  normalStrength?: number;
  /** 0..1: dust on upward faces, ground-contact grime, streaks. */
  grime?: number;
  /** 0..1: how much rain wetness darkens this surface (porosity). */
  porosity?: number;
}

/**
 * PBR MeshStandardMaterial textured by world-space triplanar projection, so merged
 * kit geometry and instanced props need no UVs and never stretch. Adds normal +
 * roughness + AO maps, dust/grime driven by world position and the terrain
 * height field, and responds to RenderGlobals.wetness.
 */
export function triplanarMaterial(texName: string, opts: TriplanarOpts = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: opts.color ?? '#ffffff',
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 0.0,
  });
  const set = pbr(texName);
  const scale = opts.scale ?? 3;
  const u = {
    tTriC: set.color,
    tTriD: set.data,
    uTriScale: { value: scale },
    uTriGain: { value: opts.gain ?? 1 },
    uTriNormal: { value: opts.normalStrength ?? 1 },
    uTriGrime: { value: opts.grime ?? 0.6 },
    uTriPorosity: { value: opts.porosity ?? 0.7 },
    uWetness: RenderGlobals.wetness,
    ...heightUniforms(),
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VARYINGS_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTriPos;
        varying vec3 vTriNormal;
        uniform sampler2D tTriC;
        uniform sampler2D tTriD;
        uniform float uTriScale, uTriGain, uTriNormal, uTriGrime, uTriPorosity, uWetness;
        ${HEIGHT_FN}
        ${PBR_COMMON_FN}
        ${PBR_TRIPLANAR_FN}`,
      )
      .replace(
        '#include <map_fragment>',
        `
        vec3 rfN0 = normalize( vTriNormal );
        vec4 rfAlb; vec3 rfN; float rfRough; float rfAO;
        rfTriplanar( tTriC, tTriD, vTriPos, rfN0, uTriScale, uTriNormal, rfAlb, rfN, rfRough, rfAO );
        vec3 rfCol = min( rfAlb.rgb * uTriGain, vec3( 1.0 ) );
        // macro variation so repeated panels don't read as copies
        float rfMacro = rfFbm( vTriPos.xz * 0.045 + vTriPos.y * 0.03 );
        rfCol *= mix( 0.82, 1.12, rfMacro );
        // grime: ground contact, rain streaks down walls, dust settling on top faces
        float rfAbove = vTriPos.y - rfTerrainHeight( vTriPos.xz );
        float rfContact = 1.0 - smoothstep( 0.0, 1.6, rfAbove + rfNoise( vTriPos.xz * 1.7 ) * 0.5 );
        float rfStreak = smoothstep( 0.45, 0.85, rfNoise( vec2( dot( vTriPos.xz, vec2( 0.7071 ) ) * 2.3, vTriPos.y * 0.12 ) ) ) * ( 1.0 - abs( rfN0.y ) );
        float rfDust = smoothstep( 0.55, 0.95, rfN0.y ) * smoothstep( 0.3, 0.8, rfFbm( vTriPos.xz * 0.6 ) );
        rfCol *= 1.0 - uTriGrime * ( 0.45 * rfContact + 0.22 * rfStreak );
        rfCol = mix( rfCol, vec3( 0.36, 0.31, 0.24 ), uTriGrime * 0.35 * rfDust );
        rfRough = clamp( rfRough + uTriGrime * ( 0.15 * rfContact + 0.2 * rfDust ), 0.04, 1.0 );
        // wetness: darker, glossier, strongest on up-facing surfaces
        float rfWet = uWetness * mix( 0.6, 1.0, max( rfN0.y, 0.0 ) );
        rfCol *= 1.0 - 0.45 * uTriPorosity * rfWet;
        rfRough = mix( rfRough, 0.1, rfWet * 0.85 );
        rfN = normalize( mix( rfN, rfN0, rfWet * 0.5 ) );
        diffuseColor.rgb *= rfCol;
        `,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp( rfRough * roughnessFactor, 0.04, 1.0 );')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( rfN, 0.0 ) ).xyz );')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= rfAO;
        reflectedLight.indirectSpecular *= rfAO * rfAO;
        reflectedLight.directDiffuse *= mix( 1.0, rfAO, 0.4 );`,
      );
  };
  m.customProgramCacheKey = () => 'rf-triplanar-pbr';
  registerPbrMaterial(m);
  return m;
}

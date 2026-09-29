import * as THREE from 'three';

const TEX_BASE = '/assets/textures/';
const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();
const pending: Promise<unknown>[] = [];

/** Repeat-wrapped sRGB texture from public/assets/textures (cached). */
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
  t.anisotropy = 8;
  cache.set(name, t);
  return t;
}

/** Resolves when every texture requested so far has loaded. */
export function texturesReady(): Promise<unknown> {
  return Promise.all(pending);
}

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
 * MeshStandardMaterial textured by world-space triplanar projection, so merged
 * kit geometry and instanced props need no UVs and never stretch.
 */
export function triplanarMaterial(texName: string, opts: { scale?: number; color?: THREE.ColorRepresentation; roughness?: number; metalness?: number; gain?: number } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: opts.color ?? '#ffffff',
    roughness: opts.roughness ?? 0.9,
    metalness: opts.metalness ?? 0.05,
  });
  const t = tex(texName);
  const scale = opts.scale ?? 3;
  // Photo albedos are dark; gain lifts them so tints read as the intended colour
  const gain = opts.gain ?? 1.8;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.tTri = { value: t };
    shader.uniforms.uTriScale = { value: scale };
    shader.uniforms.uTriGain = { value: gain };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VARYINGS_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;\nuniform sampler2D tTri;\nuniform float uTriScale;\nuniform float uTriGain;\n${TRIPLANAR_FN}`,
      )
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= min(triplanar(tTri, vTriPos, normalize(vTriNormal), uTriScale) * uTriGain, vec3(1.0));');
  };
  m.customProgramCacheKey = () => `tri-${texName}-${scale}`;
  return m;
}

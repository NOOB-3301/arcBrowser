import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MANIFEST, type AssetKey } from './manifest';

const base = import.meta.env.BASE_URL;

let loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (loader) return loader;
  const draco = new DRACOLoader();
  draco.setDecoderPath(`${base}draco/`);
  loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

const cache = new Map<AssetKey, GLTF>();
const pending = new Map<AssetKey, Promise<GLTF | null>>();

/** GLB model cache. Call `Assets.load()` once before building characters, ARC units, weapons or vegetation. */
export const Assets = {
  /** Loads the given keys (default: the whole manifest) in parallel. Failed loads are logged and skipped. */
  async load(keys: readonly AssetKey[] = Object.keys(MANIFEST) as AssetKey[], progress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    await Promise.all(
      keys.map((k) => {
        let p = pending.get(k);
        if (!p) {
          p = getLoader()
            .loadAsync(`${base}${MANIFEST[k]}`)
            .then((g) => {
              prepare(g);
              cache.set(k, g);
              return g;
            })
            .catch((err) => {
              console.warn(`[Assets] failed to load ${k}`, err);
              return null;
            });
          pending.set(k, p);
        }
        return p.then(() => progress?.(++done, keys.length));
      }),
    );
  },

  has(key: AssetKey): boolean {
    return cache.has(key);
  },

  gltf(key: AssetKey): GLTF | undefined {
    return cache.get(key);
  },

  /** Deep clone of the asset's scene (skeleton-aware). Materials are shared; clone them if you tint per instance. */
  clone(key: AssetKey): THREE.Group {
    const g = cache.get(key);
    if (!g) throw new Error(`[Assets] ${key} not loaded`);
    return skeletonClone(g.scene) as THREE.Group;
  },

  /** A named node from the asset's (uncloned) scene, e.g. a single mesh for instancing. */
  node(key: AssetKey, name: string): THREE.Object3D | undefined {
    return cache.get(key)?.scene.getObjectByName(name);
  },
};

function prepare(g: GLTF): void {
  g.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
  });
}

/** Clones every mesh material under `root` (so per-instance tint / hit-flash don't leak) and returns them. */
export function cloneMaterials(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  const seen = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const swap = (mat: THREE.Material) => {
      let c = seen.get(mat);
      if (!c) {
        c = (mat as THREE.MeshStandardMaterial).clone();
        seen.set(mat, c);
        out.push(c);
      }
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
  });
  return out;
}

import * as THREE from 'three';
import { SunLightShadow } from 'three/examples/jsm/lights/SunLightShadow.js';

/**
 * Cascaded sun shadows on top of three's built-in SunLight (r186), which natively
 * supports cascade atlases in every built-in material (so custom onBeforeCompile
 * materials need no per-material CSM setup). Three ships it with 2 cascades; we
 * raise the shader's cascade count to MAX_CASCADES and let quality presets use
 * 1..MAX_CASCADES of them with hand-picked split distances. Unused cascades get
 * an empty depth range (never sampled), an empty culling frustum and a
 * zero-size viewport, so switching presets never recompiles shaders.
 */
export const MAX_CASCADES = 4;

let chunkPatched = false;
function patchChunk(): void {
  if (chunkPatched) return;
  chunkPatched = true;
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  const patched = src.replace(/#define SUN_LIGHT_CASCADES \d+/, `#define SUN_LIGHT_CASCADES ${MAX_CASCADES}`);
  if (patched === src) console.warn('SunShadow: could not patch SUN_LIGHT_CASCADES');
  THREE.ShaderChunk.shadowmap_pars_fragment = patched;
}
patchChunk();

const _lightOrientation = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _lightDir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _far = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const FADE = 0.12;

/** Internal fields of LightShadow / SunLightShadow that three's typings don't expose. */
interface ShadowInternals {
  _cameras: THREE.OrthographicCamera[];
  _matrices: THREE.Matrix4[];
  _frustums: THREE.Frustum[];
  _cascadeData: THREE.Vector4[];
  _cascadeSplits: number[];
  _viewports: THREE.Vector4[];
  _viewportCount: number;
  _frameExtents: THREE.Vector2;
  _updateMatrix(cam: THREE.Camera, m: THREE.Matrix4, f: THREE.Frustum, vp?: THREE.Vector4): void;
}

export class CascadedSunShadow extends SunLightShadow {
  /** Far edge of each active cascade (metres of view depth). */
  splits: number[] = [22, 80, 260];

  constructor() {
    super();
    const s = this as unknown as ShadowInternals;
    s._cameras.length = s._matrices.length = s._frustums.length = s._cascadeData.length = 0;
    for (let i = 0; i < MAX_CASCADES; i++) {
      s._cameras.push(new THREE.OrthographicCamera());
      s._matrices.push(new THREE.Matrix4());
      s._frustums.push(new THREE.Frustum());
      s._cascadeData.push(new THREE.Vector4());
    }
    while (s._viewports.length < MAX_CASCADES) s._viewports.push(new THREE.Vector4());
    s._viewportCount = MAX_CASCADES;
    this.setCascades(this.splits);
  }

  get activeCascades(): number {
    return this.splits.length;
  }

  setCascades(splits: number[]): void {
    this.splits = splits.slice(0, MAX_CASCADES);
    const s = this as unknown as ShadowInternals;
    s._frameExtents.set(this.splits.length, 1);
    this.camera.far = this.splits[this.splits.length - 1];
    // Force the renderer to reallocate the atlas at the new size
    if (this.map) {
      this.map.dispose();
      this.map = null;
    }
  }

  override updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
    if (!viewCamera || !(viewCamera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    const view = viewCamera as THREE.PerspectiveCamera;
    const s = this as unknown as ShadowInternals;
    const n = this.splits.length;
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    const resX = this.mapSize.x * (1 - 2 * insetX);
    const resY = this.mapSize.y * (1 - 2 * insetY);

    const camNear = view.near;
    const camFar = Math.max(camNear + 1e-3, Math.min(this.splits[n - 1], view.far));

    _lightDir.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDir)) > 0.99) _up.set(0, 0, 1);
    _lightOrientation.lookAt(_center.set(0, 0, 0), _lightDir, _up);
    _viewToLight.copy(_lightOrientation).transpose().multiply(view.matrixWorld);

    let globalMaxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const nc = _near[i].set(x, y, -1).applyMatrix4(view.projectionMatrixInverse);
      _far[i].copy(nc).multiplyScalar(camFar / camNear);
      nc.applyMatrix4(_viewToLight);
      _far[i].applyMatrix4(_viewToLight);
      globalMaxZ = Math.max(globalMaxZ, nc.z, _far[i].z);
    }
    // Raise the caster ceiling so tall things outside the view still cast in
    globalMaxZ += Math.min(camFar, 400);
    const shadowNear = 0.5;

    for (let i = 0; i < MAX_CASCADES; i++) {
      const cam = s._cameras[i];
      if (i >= n) {
        // Inactive: never sampled, culls everything, draws into nothing
        s._cascadeData[i].set(1e9, 1e9, 1e9, 0);
        s._viewports[i].set(0, 0, 0, 0);
        const f = s._frustums[i];
        f.planes[0].set(new THREE.Vector3(1, 0, 0), -1e9);
        f.planes[1].set(new THREE.Vector3(-1, 0, 0), -1e9);
        continue;
      }
      s._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
      const splitStart = i === 0 ? camNear : this.splits[i - 1];
      const cascadeFar = Math.min(this.splits[i], camFar);
      // Each cascade also covers the previous one's fade band so both can be sampled while blending
      const cascadeNear = i === 0 ? camNear : s._cascadeData[i - 1].z;
      const fadeStart = cascadeFar - FADE * (cascadeFar - splitStart);
      s._cascadeData[i].set(i === 0 ? -1e10 : cascadeNear, cascadeFar, fadeStart, 0);

      const a0 = (cascadeNear - camNear) / (camFar - camNear);
      const a1 = (cascadeFar - camNear) / (camFar - camNear);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].lerpVectors(_near[j], _far[j], a0);
        _corners[j * 2 + 1].lerpVectors(_near[j], _far[j], a1);
        _center.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let r2 = 0;
      let minZ = Infinity;
      for (const c of _corners) {
        r2 = Math.max(r2, c.distanceToSquared(_center));
        minZ = Math.min(minZ, c.z);
      }
      // Quantise the radius so the projection size is stable frame to frame, then snap to texels
      let radius = Math.ceil(Math.sqrt(r2) * 2) / 2;
      radius /= 1 - 1 / Math.min(resX, resY);
      const tx = (2 * radius) / resX;
      const ty = (2 * radius) / resY;
      _center.x = Math.round(_center.x / tx) * tx;
      _center.y = Math.round(_center.y / ty) * ty;
      _center.z = globalMaxZ + shadowNear;
      _center.applyMatrix4(_lightOrientation);

      cam.position.copy(_center);
      cam.quaternion.setFromRotationMatrix(_lightOrientation);
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = shadowNear;
      cam.far = globalMaxZ - minZ + 2 * shadowNear;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      s._updateMatrix(cam, s._matrices[i], s._frustums[i], s._viewports[i]);
    }
  }
}

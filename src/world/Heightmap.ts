import * as THREE from 'three';

/** Splat channels. A: grass, dirt, rock, sand. B: asphalt, concrete. */
export const SPLAT = { grass: 0, dirt: 1, rock: 2, sand: 3, asphalt: 4, concrete: 5 } as const;

/**
 * Regular height grid covering [-size/2, size/2]² with `n` vertices per side.
 * Row-major: index = iz * n + ix.
 */
export class Heightmap {
  readonly n: number;
  readonly half: number;
  readonly heights: Float32Array;
  /** 6 splat weights per vertex (0..255). */
  readonly splat: Uint8Array;
  /** Mask of water influence (0..255) for shoreline + foliage. */
  readonly wet: Uint8Array;

  constructor(readonly size: number, readonly cell: number) {
    this.n = Math.round(size / cell) + 1;
    this.half = size / 2;
    this.heights = new Float32Array(this.n * this.n);
    this.splat = new Uint8Array(this.n * this.n * 6);
    this.wet = new Uint8Array(this.n * this.n);
  }

  /** World x/z of grid vertex. */
  wx(ix: number): number {
    return ix * this.cell - this.half;
  }
  wz(iz: number): number {
    return iz * this.cell - this.half;
  }

  idx(ix: number, iz: number): number {
    return iz * this.n + ix;
  }

  at(ix: number, iz: number): number {
    ix = Math.max(0, Math.min(this.n - 1, ix));
    iz = Math.max(0, Math.min(this.n - 1, iz));
    return this.heights[iz * this.n + ix];
  }

  /** Bilinear height at world x/z. */
  sample(x: number, z: number): number {
    const fx = (x + this.half) / this.cell;
    const fz = (z + this.half) / this.cell;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h00 = this.at(ix, iz);
    const h10 = this.at(ix + 1, iz);
    const h01 = this.at(ix, iz + 1);
    const h11 = this.at(ix + 1, iz + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Surface normal at grid vertex (central differences). */
  normalAt(ix: number, iz: number, out = new THREE.Vector3()): THREE.Vector3 {
    const dx = this.at(ix + 1, iz) - this.at(ix - 1, iz);
    const dz = this.at(ix, iz + 1) - this.at(ix, iz - 1);
    return out.set(-dx, 2 * this.cell, -dz).normalize();
  }

  normal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = this.cell;
    const dx = this.sample(x + e, z) - this.sample(x - e, z);
    const dz = this.sample(x, z + e) - this.sample(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /** Nearest-vertex splat weight (0..1) for a channel. */
  splatAt(x: number, z: number, channel: number): number {
    const ix = Math.round((x + this.half) / this.cell);
    const iz = Math.round((z + this.half) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return 0;
    return this.splat[(iz * this.n + ix) * 6 + channel] / 255;
  }

  inside(x: number, z: number, margin = 0): boolean {
    return Math.abs(x) < this.half - margin && Math.abs(z) < this.half - margin;
  }

  /** Heights transposed to Rapier's column-major layout (column = x). */
  rapierHeights(): Float32Array {
    const n = this.n;
    const out = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) out[ix * n + iz] = this.heights[iz * n + ix];
    return out;
  }

  /** R32F texture of heights for GPU foliage placement. */
  toTexture(): THREE.DataTexture {
    const tex = new THREE.DataTexture(this.heights, this.n, this.n, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }
}

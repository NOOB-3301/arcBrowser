import * as THREE from 'three';
import type { Heightmap } from './Heightmap';
import { tex, TRIPLANAR_FN, WORLD_VARYINGS_VERT } from './Materials';

const CHUNK = 128; // metres
const LOD_STEPS = [1, 2, 4, 8];
const LOD_DIST = [170, 380, 720];
const SKIRT = 6;

interface Chunk {
  mesh: THREE.Mesh;
  cx: number;
  cz: number;
  center: THREE.Vector3;
  lods: (THREE.BufferGeometry | undefined)[];
  lod: number;
}

/** Splat-blended terrain material: grass/dirt/rock/sand/asphalt/concrete. */
function terrainMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0 });
  const t = {
    tGrass: tex('aerial_grass_rock'),
    tDirt: tex('forrest_ground_01'),
    tRock: tex('rock_face'),
    tSand: tex('coast_sand_01'),
    tAsphalt: tex('asphalt_02'),
    tConcrete: tex('concrete_floor_worn_001'),
  };
  m.onBeforeCompile = (shader) => {
    for (const [k, v] of Object.entries(t)) shader.uniforms[k] = { value: v };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aSplatA;
        attribute vec2 aSplatB;
        varying vec4 vSplatA;
        varying vec2 vSplatB;
        varying vec3 vTriPos;
        varying vec3 vTriNormal;`,
      )
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VARYINGS_VERT}\nvSplatA = aSplatA; vSplatB = aSplatB;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec4 vSplatA;
        varying vec2 vSplatB;
        varying vec3 vTriPos;
        varying vec3 vTriNormal;
        uniform sampler2D tGrass, tDirt, tRock, tSand, tAsphalt, tConcrete;
        ${TRIPLANAR_FN}`,
      )
      .replace(
        '#include <map_fragment>',
        `
        vec2 uv = vTriPos.xz;
        // Two-scale sampling breaks up tiling on the big grass layer
        vec3 grass = texture(tGrass, uv / 28.0).rgb * mix(0.8, 1.2, texture(tGrass, uv / 173.0).g);
        grass *= vec3(0.92, 1.0, 0.86);
        vec3 dirt = texture(tDirt, uv / 7.0).rgb;
        vec3 rock = triplanar(tRock, vTriPos, normalize(vTriNormal), 11.0);
        vec3 sand = texture(tSand, uv / 9.0).rgb;
        vec3 asph = texture(tAsphalt, uv / 7.0).rgb;
        vec3 conc = texture(tConcrete, uv / 6.0).rgb;
        vec4 a = vSplatA;
        vec2 b = vSplatB;
        float sum = a.x + a.y + a.z + a.w + b.x + b.y + 1e-4;
        vec3 col = (grass * a.x + dirt * a.y + rock * a.z + sand * a.w + asph * b.x + conc * b.y) / sum;
        diffuseColor.rgb *= col;
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.78, vSplatB.x);`,
      );
  };
  m.customProgramCacheKey = () => 'terrain-splat';
  return m;
}

/**
 * Terrain split into 128 m chunks, each with 4 cached LODs (2/4/8/16 m spacing).
 * Skirts hide cracks between neighbouring LODs.
 */
export class Terrain {
  readonly material = terrainMaterial();
  private chunks: Chunk[] = [];
  private tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, private hm: Heightmap) {
    const count = Math.round(hm.size / CHUNK);
    for (let cz = 0; cz < count; cz++) {
      for (let cx = 0; cx < count; cx++) {
        const mesh = new THREE.Mesh(undefined, this.material);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        const center = new THREE.Vector3(
          -hm.half + (cx + 0.5) * CHUNK,
          hm.sample(-hm.half + (cx + 0.5) * CHUNK, -hm.half + (cz + 0.5) * CHUNK),
          -hm.half + (cz + 0.5) * CHUNK,
        );
        const chunk: Chunk = { mesh, cx, cz, center, lods: [], lod: -1 };
        this.setLod(chunk, 3);
        scene.add(mesh);
        this.chunks.push(chunk);
      }
    }
  }

  /** Choose LODs by camera distance. Cheap enough to run every frame. */
  update(camPos: THREE.Vector3): void {
    for (const c of this.chunks) {
      this.tmp.set(c.center.x, camPos.y, c.center.z);
      const d = Math.max(0, this.tmp.distanceTo(camPos) - CHUNK * 0.5);
      const lod = d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : d < LOD_DIST[2] ? 2 : 3;
      if (lod !== c.lod) this.setLod(c, lod);
    }
  }

  /** Force full detail around a point (spawn) so first frames aren't blocky. */
  prewarm(pos: THREE.Vector3): void {
    this.update(pos);
  }

  get triangleEstimate(): number {
    let t = 0;
    for (const c of this.chunks) {
      const s = CHUNK / this.hm.cell / LOD_STEPS[c.lod];
      t += s * s * 2;
    }
    return t;
  }

  private setLod(c: Chunk, lod: number): void {
    if (!c.lods[lod]) c.lods[lod] = this.buildGeometry(c.cx, c.cz, LOD_STEPS[lod]);
    c.mesh.geometry = c.lods[lod]!;
    c.lod = lod;
  }

  private buildGeometry(cx: number, cz: number, step: number): THREE.BufferGeometry {
    const hm = this.hm;
    const cells = CHUNK / hm.cell;
    const seg = cells / step;
    const m = seg + 1;
    const ix0 = cx * cells;
    const iz0 = cz * cells;
    const vcount = m * m + 4 * m;
    const pos = new Float32Array(vcount * 3);
    const nrm = new Float32Array(vcount * 3);
    const sa = new Uint8Array(vcount * 4);
    const sb = new Uint8Array(vcount * 2);
    const n = new THREE.Vector3();

    const writeVertex = (v: number, ix: number, iz: number, drop: number) => {
      const gi = hm.idx(Math.min(ix, hm.n - 1), Math.min(iz, hm.n - 1));
      pos[v * 3] = hm.wx(ix);
      pos[v * 3 + 1] = hm.heights[gi] - drop;
      pos[v * 3 + 2] = hm.wz(iz);
      hm.normalAt(ix, iz, n);
      nrm[v * 3] = n.x;
      nrm[v * 3 + 1] = n.y;
      nrm[v * 3 + 2] = n.z;
      const s = gi * 6;
      sa[v * 4] = hm.splat[s];
      sa[v * 4 + 1] = hm.splat[s + 1];
      sa[v * 4 + 2] = hm.splat[s + 2];
      sa[v * 4 + 3] = hm.splat[s + 3];
      sb[v * 2] = hm.splat[s + 4];
      sb[v * 2 + 1] = hm.splat[s + 5];
    };

    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) writeVertex(j * m + i, ix0 + i * step, iz0 + j * step, 0);

    const idx: number[] = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * m + i;
        const b = a + 1;
        const c = a + m;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    // Skirts: duplicate each edge row lowered by SKIRT, double-sided strips
    const edges: number[][] = [[], [], [], []];
    for (let k = 0; k < m; k++) {
      edges[0].push(k); // north row
      edges[1].push((m - 1) * m + k); // south row
      edges[2].push(k * m); // west col
      edges[3].push(k * m + m - 1); // east col
    }
    let v = m * m;
    for (const edge of edges) {
      const start = v;
      for (const top of edge) {
        const ix = ix0 + (top % m) * step;
        const iz = iz0 + Math.floor(top / m) * step;
        writeVertex(v++, ix, iz, SKIRT);
      }
      for (let k = 0; k < m - 1; k++) {
        const t0 = edge[k];
        const t1 = edge[k + 1];
        const b0 = start + k;
        const b1 = start + k + 1;
        idx.push(t0, b0, t1, t1, b0, b1, t0, t1, b0, t1, b1, b0);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aSplatA', new THREE.BufferAttribute(sa, 4, true));
    g.setAttribute('aSplatB', new THREE.BufferAttribute(sb, 2, true));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

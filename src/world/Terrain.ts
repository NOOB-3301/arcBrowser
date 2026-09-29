import * as THREE from 'three';
import type { Heightmap } from './Heightmap';
import { pbr, registerPbrMaterial, PBR_COMMON_FN, PBR_TRIPLANAR_FN, WORLD_VARYINGS_VERT } from './Materials';
import { RenderGlobals } from '../render/RenderGlobals';
import { Quality } from '../render/Quality';

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

/** Terrain layers: PBR set, world-space tile size (m), anti-tiling, rain porosity. */
const LAYERS = [
  { key: 'Grass', tex: 'aerial_grass_rock', scale: 16.0, noTile: true },
  { key: 'Dirt', tex: 'forrest_ground_01', scale: 6.0, noTile: true },
  { key: 'Rock', tex: 'rock_face', scale: 9.0, noTile: false },
  { key: 'Sand', tex: 'coast_sand_01', scale: 7.0, noTile: true },
  { key: 'Asphalt', tex: 'asphalt_02', scale: 6.0, noTile: false },
  { key: 'Concrete', tex: 'concrete_floor_worn_001', scale: 5.0, noTile: false },
] as const;

const TERRAIN_FRAG_PARS = /* glsl */ `
  varying vec4 vSplatA;
  varying vec2 vSplatB;
  varying vec3 vTriPos;
  varying vec3 vTriNormal;
  uniform sampler2D tGrassC, tGrassD, tDirtC, tDirtD, tRockC, tRockD, tSandC, tSandD, tAsphaltC, tAsphaltD, tConcreteC, tConcreteD;
  uniform float uWetness;
  ${PBR_COMMON_FN}
  ${PBR_TRIPLANAR_FN}

  // Top-down layer sample. With RF_NOTILE it blends two randomly offset copies
  // (IQ's "texture no-tile" v3) so the repeat pattern disappears; offsets are
  // pure translations, so the normal map stays valid.
  void rfLayer( sampler2D tc, sampler2D td, vec2 uv, bool noTile, out vec4 c, out vec4 d ) {
    vec2 dx = dFdx( uv ), dy = dFdy( uv );
    if ( noTile ) {
      float l = rfNoise( uv * 0.37 ) * 8.0;
      float ia = floor( l );
      float f = fract( l );
      vec2 oa = sin( vec2( 3.0, 7.0 ) * ia );
      vec2 ob = sin( vec2( 3.0, 7.0 ) * ( ia + 1.0 ) );
      vec4 ca = textureGrad( tc, uv + oa, dx, dy );
      vec4 cb = textureGrad( tc, uv + ob, dx, dy );
      float b = smoothstep( 0.2, 0.8, f - 0.1 * dot( ca.rgb - cb.rgb, vec3( 1.0 ) ) );
      c = mix( ca, cb, b );
      d = mix( textureGrad( td, uv + oa, dx, dy ), textureGrad( td, uv + ob, dx, dy ), b );
    } else {
      c = textureGrad( tc, uv, dx, dy );
      d = textureGrad( td, uv, dx, dy );
    }
  }
`;

const TERRAIN_FRAG_MAIN = /* glsl */ `
  vec3 N0 = normalize( vTriNormal );
  vec2 wxz = vTriPos.xz;
  vec4 cG, dG, cD, dD, cS, dS, cA, dA, cC, dC;
  rfLayer( tGrassC, tGrassD, wxz / ${LAYERS[0].scale.toFixed(1)}, ${LAYERS[0].noTile}, cG, dG );
  rfLayer( tDirtC, tDirtD, wxz / ${LAYERS[1].scale.toFixed(1)}, ${LAYERS[1].noTile}, cD, dD );
  rfLayer( tSandC, tSandD, wxz / ${LAYERS[3].scale.toFixed(1)}, ${LAYERS[3].noTile}, cS, dS );
  rfLayer( tAsphaltC, tAsphaltD, wxz / ${LAYERS[4].scale.toFixed(1)}, false, cA, dA );
  rfLayer( tConcreteC, tConcreteD, wxz / ${LAYERS[5].scale.toFixed(1)}, false, cC, dC );
  vec4 cR; vec3 nR; float rR; float aoR;
  rfTriplanar( tRockC, tRockD, vTriPos, N0, ${LAYERS[2].scale.toFixed(1)}, 1.2, cR, nR, rR, aoR );

  // Large-scale variation: brightness + dry/lush patches, so distant terrain isn't a flat average
  float macro = rfFbm( wxz * 0.011 );
  float dry = smoothstep( 0.35, 0.75, rfFbm( wxz * 0.004 + 3.7 ) );
  cG.rgb *= mix( vec3( 0.95, 1.02, 0.9 ), vec3( 1.18, 1.06, 0.78 ), dry );
  cD.rgb *= mix( 0.9, 1.1, macro );
  cC.rgb *= 0.72; // the worn-concrete scan is very bright
  cS.rgb *= 0.85;

  // Height-aware splat blend: the taller layer's texels poke through at transitions
  float wG = vSplatA.x, wD = vSplatA.y, wR = vSplatA.z, wS = vSplatA.w, wA = vSplatB.x, wC = vSplatB.y;
  float sum = wG + wD + wR + wS + wA + wC + 1e-4;
  wG /= sum; wD /= sum; wR /= sum; wS /= sum; wA /= sum; wC /= sum;
  float sG = wG + cG.a * min( wG * 4.0, 1.0 ) * 0.5;
  float sD = wD + cD.a * min( wD * 4.0, 1.0 ) * 0.5;
  float sR = wR + cR.a * min( wR * 4.0, 1.0 ) * 0.6;
  float sS = wS + cS.a * min( wS * 4.0, 1.0 ) * 0.4;
  float sA = wA + cA.a * min( wA * 4.0, 1.0 ) * 0.25;
  float sC = wC + cC.a * min( wC * 4.0, 1.0 ) * 0.25;
  float ma = max( max( max( sG, sD ), max( sR, sS ) ), max( sA, sC ) ) - 0.18;
  float bG = max( sG - ma, 0.0 ), bD = max( sD - ma, 0.0 ), bR = max( sR - ma, 0.0 );
  float bS = max( sS - ma, 0.0 ), bA = max( sA - ma, 0.0 ), bC = max( sC - ma, 0.0 );
  float bSum = bG + bD + bR + bS + bA + bC + 1e-5;
  bG /= bSum; bD /= bSum; bR /= bSum; bS /= bSum; bA /= bSum; bC /= bSum;

  vec3 tCol = cG.rgb * bG + cD.rgb * bD + cR.rgb * bR + cS.rgb * bS + cA.rgb * bA + cC.rgb * bC;
  vec4 dTop = ( dG * bG + dD * bD + dS * bS + dA * bA + dC * bC ) / max( 1.0 - bR, 1e-4 );
  float tRough = mix( dTop.b, rR, bR );
  float tAO = mix( dTop.a, aoR, bR );
  tCol *= mix( 0.86, 1.12, macro );

  #ifdef RF_NO_NORMALMAP
    vec3 tN = N0;
  #else
    // top-down layers share one projection frame (T = +X, image-up = -Z)
    vec3 nTop = rfTnWorld( rfUnpackN( dTop, 1.0 ), N0, vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 0.0, -1.0 ), vec3( 0.0, 1.0, 0.0 ) );
    vec3 tN = normalize( mix( normalize( nTop ), nR, bR ) );
  #endif

  // Rain: porous layers darken, everything gets glossier, puddles gather on flat low spots
  float wet = uWetness;
  float porosity = bG * 0.8 + bD * 0.9 + bR * 0.35 + bS * 0.9 + bA * 0.55 + bC * 0.6;
  tCol *= 1.0 - 0.45 * wet * porosity;
  tRough = mix( tRough, 0.18, wet * 0.75 );
  float flatness = smoothstep( 0.94, 0.995, N0.y );
  float puddle = flatness * smoothstep( 0.62, 0.72, rfFbm( wxz * 0.13 ) + ( 1.0 - dot( vec4( cG.a, cD.a, cS.a, cA.a ), vec4( bG, bD, bS, bA ) ) ) * 0.25 ) * smoothstep( 0.35, 0.85, wet );
  tCol *= 1.0 - 0.3 * puddle;
  tRough = mix( tRough, 0.03, puddle );
  tN = normalize( mix( tN, N0, puddle ) );

  diffuseColor.rgb *= tCol;
`;

/** Splat-blended PBR terrain material: grass/dirt/rock/sand/asphalt/concrete. */
function terrainMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 });
  const uniforms: Record<string, THREE.IUniform> = { uWetness: RenderGlobals.wetness };
  for (const l of LAYERS) {
    const s = pbr(l.tex);
    uniforms[`t${l.key}C`] = s.color;
    uniforms[`t${l.key}D`] = s.data;
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
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
      .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_PARS}`)
      .replace('#include <map_fragment>', TERRAIN_FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp( tRough, 0.03, 1.0 );')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( tN, 0.0 ) ).xyz );')
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= tAO;
        reflectedLight.indirectSpecular *= tAO * tAO;
        reflectedLight.directDiffuse *= mix( 1.0, tAO, 0.35 );`,
      );
  };
  m.customProgramCacheKey = () => 'rf-terrain-pbr';
  registerPbrMaterial(m);
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
      const k = Quality.current.lodScale;
      const lod = d < LOD_DIST[0] * k ? 0 : d < LOD_DIST[1] * k ? 1 : d < LOD_DIST[2] * k ? 2 : 3;
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

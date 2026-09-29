import * as THREE from 'three';
import { Heightmap } from './Heightmap';
import { Simplex } from './Noise';
import type { MapDef, PadDef, Vec2 } from './MapDef';

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface RoadProfile {
  points: THREE.Vector3[];
  width: number;
  surface: 'asphalt' | 'gravel';
}

export interface GenResult {
  hm: Heightmap;
  roads: RoadProfile[];
  /** Resolved pad heights (same order as def.pads). */
  padHeights: number[];
  /** 1 where vegetation must not spawn (roads, pads, water). */
  clear: Uint8Array;
  /** Distance to nearest road centre (m), capped. */
  roadDist: Float32Array;
  ms: number;
}

/**
 * Builds the terrain: noise base → rim → hills → lakes → river valleys → pads →
 * roads → river channels (so rivers cut under bridges) → splat weights.
 */
export function generateTerrain(def: MapDef): GenResult {
  const t0 = performance.now();
  const hm = new Heightmap(def.size, def.cell);
  const n = hm.n;
  const N = n * n;
  const H = hm.heights;
  const noise = new Simplex(def.seed);
  const detail = new Simplex(def.seed + 7);
  const b = def.base;

  const padMask = new Float32Array(N); // surface weight of pads
  const padKind = new Uint8Array(N); // 1 concrete, 2 dirt, 3 gravel
  const roadDist = new Float32Array(N).fill(1e9);
  const roadAsphalt = new Float32Array(N);
  const roadGravel = new Float32Array(N);
  const clear = new Uint8Array(N);
  const riverD = new Float32Array(N).fill(1e9);
  const riverBed = new Float32Array(N);
  const coastSand = new Float32Array(N); // W4: beach/dune sand weight
  const shoreAt = def.coast ? makeShore(def) : null; // W4

  // ---------------------------------------------------------------- base + rim + hills
  for (let iz = 0; iz < n; iz++) {
    const z = hm.wz(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = hm.wx(ix);
      let h = b.baseHeight + noise.fbm(x / b.hillScale, z / b.hillScale, 5) * b.hillAmp;
      h += (noise.ridged(x / 700 + 11, z / 700 - 7, 4) - 0.35) * b.ridgeAmp;
      h += detail.fbm(x / 40, z / 40, 3) * 0.8;
      // W4: coast maps have no rim on the sea side, and the rim fades out toward the sea
      const edge = hm.half - (shoreAt ? Math.max(-x, Math.abs(z)) : Math.max(Math.abs(x), Math.abs(z)));
      let r = smooth(b.rimWidth, 0, edge);
      if (shoreAt) r *= smooth(shoreAt(z) + 40, shoreAt(z) - 160, x);
      h += b.rimHeight * r * r * (0.7 + 0.3 * noise.noise(x / 160, z / 160));
      for (const hill of def.hills) {
        const d = Math.hypot(x - hill.center[0], z - hill.center[1]);
        if (d < hill.radius) h += hill.height * (0.5 + 0.5 * Math.cos((Math.PI * d) / hill.radius));
      }
      H[iz * n + ix] = h;
    }
  }

  // ---------------------------------------------------------------- W4: coast (beach, dunes, cliffs, sea floor)
  if (def.coast && shoreAt) {
    const c = def.coast;
    const sea = def.waterLevel;
    for (let iz = 0; iz < n; iz++) {
      const z = hm.wz(iz);
      const s = shoreAt(z);
      let cliff = 0;
      for (const cl of c.cliffs) cliff = Math.max(cliff, smooth(cl.z0 - 40, cl.z0 + 20, z) * smooth(cl.z1 + 40, cl.z1 - 20, z));
      const cliffH = c.cliffs.reduce((m, cl) => Math.max(m, cl.height), 0);
      for (let ix = 0; ix < n; ix++) {
        const x = hm.wx(ix);
        const u = x - s; // + = seaward
        if (u < -c.beach - 260) continue;
        const i = iz * n + ix;
        const land = H[i];
        const seaT = lerp(sea - 0.8, c.seaFloor, smooth(0, c.shelf, u));
        // Beach profile: land eases down to a gentle sand slope at the waterline
        let beachH: number;
        if (u >= 0) beachH = seaT;
        else {
          const sandH = sea + 0.4 + -u * 0.05 + detail.fbm(x / 25, z / 25, 2) * 0.3;
          beachH = lerp(land, Math.min(land, sandH), smooth(-c.beach * 1.6, -c.beach * 0.35, u));
          // Dunes behind the beach
          const band = smooth(-c.beach - 200, -c.beach - 60, u) * smooth(-c.beach * 0.2, -c.beach * 0.7, u);
          beachH += band * c.dunes * Math.max(0, noise.ridged(x / 55 + 3, z / 38 - 5, 3) - 0.25);
        }
        // Cliff profile: raised plateau that drops sharply into the sea
        const plateau = land + cliffH * smooth(-240, -70, u);
        const cliffProfile = u < -10 ? plateau : lerp(plateau, Math.min(seaT, sea - 2.5), smooth(-10, 7, u));
        H[i] = lerp(beachH, cliffProfile, cliff);
        if (u > -8 && H[i] < sea + 0.4) hm.wet[i] = 255;
        coastSand[i] = (1 - cliff) * smooth(-c.beach - 200, -c.beach * 0.7, u);
      }
    }
    // Sandy areas inland (buried city): sand splat + drifts
    for (const a of c.sandy) {
      const [cx, cz] = a.center;
      forBox(hm, cx - a.radius, cz - a.radius, cx + a.radius, cz + a.radius, (i, x, z) => {
        const d = Math.hypot(x - cx, z - cz) / a.radius + noise.noise(x / 50, z / 50) * 0.2;
        coastSand[i] = Math.max(coastSand[i], smooth(1, 0.6, d));
      });
    }
  }

  // ---------------------------------------------------------------- lakes
  for (const lake of def.lakes) {
    const [cx, cz] = lake.center;
    const [rx, rz] = lake.radius;
    forBox(hm, cx - rx * 1.3, cz - rz * 1.3, cx + rx * 1.3, cz + rz * 1.3, (i, x, z) => {
      const e = Math.hypot((x - cx) / rx, (z - cz) / rz) + noise.fbm(x / 130, z / 130, 3) * 0.12;
      if (e > 1.3) return;
      const target = lake.bottom + (def.waterLevel + 3 - lake.bottom) * smooth(0.15, 1.15, e);
      H[i] = lerp(H[i], Math.min(H[i], target), smooth(1.3, 0.85, e));
      if (e < 1.08) hm.wet[i] = Math.max(hm.wet[i], 255);
    });
  }

  // ---------------------------------------------------------------- rivers (distance field)
  for (const river of def.rivers) {
    const reach = river.valleyWidth;
    for (let s = 0; s < river.points.length - 1; s++) {
      const [ax, az, ay] = river.points[s];
      const [bx, bz, by] = river.points[s + 1];
      forBox(hm, Math.min(ax, bx) - reach, Math.min(az, bz) - reach, Math.max(ax, bx) + reach, Math.max(az, bz) + reach, (i, x, z) => {
        const { d, t } = segDist(x, z, ax, az, bx, bz);
        // Meander the channel a little with noise
        const dn = d + noise.noise(x / 60, z / 60) * 4;
        if (dn < riverD[i]) {
          riverD[i] = dn;
          riverBed[i] = lerp(ay, by, t);
        }
      });
    }
    carveRivers(river.width, river.valleyWidth, true);
  }

  function carveRivers(width: number, valley: number, withValley: boolean): void {
    const w = width / 2;
    for (let i = 0; i < N; i++) {
      const d = riverD[i];
      if (d > valley) continue;
      const bed = riverBed[i];
      if (withValley) {
        const target = d < w ? bed : bed + 1.6 + (d - w) * 0.14;
        H[i] = lerp(H[i], Math.min(H[i], target), smooth(valley, w, d));
      } else if (d < w + 3) {
        H[i] = lerp(H[i], Math.min(H[i], bed), smooth(w + 3, w - 1, d));
      }
      if (d < w + 5) hm.wet[i] = Math.max(hm.wet[i], Math.round(255 * smooth(w + 5, w, d)));
    }
  }

  // ---------------------------------------------------------------- pads
  const padHeights = def.pads.map((p) => (p.height === 'auto' ? padMean(hm, p) : p.height));
  def.pads.forEach((p, k) => {
    const target = padHeights[k];
    const ext = (p.radius ?? Math.max(p.half![0], p.half![1])) * 1.5 + p.falloff;
    forBox(hm, p.center[0] - ext, p.center[1] - ext, p.center[0] + ext, p.center[1] + ext, (i, x, z) => {
      const sd = padSdf(p, x, z);
      if (sd > p.falloff) return;
      const w = 1 - smooth(0, p.falloff, sd);
      H[i] = lerp(H[i], target, w);
      if (sd < 0) clear[i] = 1;
      if (p.surface !== 'none') {
        const sw = 1 - smooth(-3, 1.5, sd + noise.noise(x / 9, z / 9) * 1.5);
        if (sw > padMask[i]) {
          padMask[i] = sw;
          padKind[i] = p.surface === 'concrete' ? 1 : p.surface === 'dirt' ? 2 : 3;
        }
      }
    });
  });

  // ---------------------------------------------------------------- roads
  const roads: RoadProfile[] = def.roads.map((r) => {
    const pts = densify(r.points, 4).map(([x, z]) => new THREE.Vector3(x, hm.sample(x, z), z));
    // Smooth the vertical profile (and limit grade) so roads read as engineered
    for (let pass = 0; pass < 4; pass++) {
      const ys = pts.map((p) => p.y);
      for (let i = 0; i < pts.length; i++) {
        let sum = 0;
        let c = 0;
        for (let k = -8; k <= 8; k++) {
          const j = i + k;
          if (j >= 0 && j < pts.length) {
            sum += ys[j];
            c++;
          }
        }
        pts[i].y = sum / c;
      }
    }
    return { points: pts, width: r.width, surface: r.surface };
  });
  const roadH = new Float32Array(N);
  for (const road of roads) {
    const reach = road.width / 2 + 10;
    for (let s = 0; s < road.points.length - 1; s++) {
      const a = road.points[s];
      const c = road.points[s + 1];
      forBox(hm, Math.min(a.x, c.x) - reach, Math.min(a.z, c.z) - reach, Math.max(a.x, c.x) + reach, Math.max(a.z, c.z) + reach, (i, x, z) => {
        const { d, t } = segDist(x, z, a.x, a.z, c.x, c.z);
        if (d < roadDist[i]) {
          roadDist[i] = d;
          roadH[i] = lerp(a.y, c.y, t);
          const edge = 1 - smooth(road.width / 2 - 1, road.width / 2 + 0.6, d + noise.noise(x / 5, z / 5) * 0.6);
          if (road.surface === 'asphalt') roadAsphalt[i] = Math.max(roadAsphalt[i], edge);
          else roadGravel[i] = Math.max(roadGravel[i], edge);
        }
      });
    }
    for (let i = 0; i < N; i++) {
      const d = roadDist[i];
      if (d > road.width / 2 + 10) continue;
      H[i] = lerp(H[i], roadH[i], 1 - smooth(road.width / 2, road.width / 2 + 10, d));
      if (d < road.width / 2 + 1.5) clear[i] = 1;
    }
  }

  // Re-cut river channels through road fills (bridges span them)
  carveRivers(def.rivers[0]?.width ?? 0, 20, false);

  // ---------------------------------------------------------------- water clear + splat
  const nrm = new THREE.Vector3();
  const S = hm.splat;
  for (let iz = 0; iz < n; iz++) {
    const z = hm.wz(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = hm.wx(ix);
      const i = iz * n + ix;
      const h = H[i];
      hm.normalAt(ix, iz, nrm);
      const slope = 1 - nrm.y;
      const wet = hm.wet[i] / 255;
      if (wet > 0.3 && h < def.waterLevel + 1) clear[i] = 1;
      if (riverD[i] < (def.rivers[0]?.width ?? 0) / 2 + 2) clear[i] = 1;

      let rock = smooth(0.14, 0.3, slope) + smooth(70, 110, h) * 0.5;
      let sand = wet * smooth(def.waterLevel + 3.5, def.waterLevel + 0.5, h) + wet * (riverD[i] < 30 ? 0.8 : 0);
      sand += coastSand[i] * 2.5; // W4: beaches, dunes, buried city
      let dirt = Math.max(0, noise.fbm(x / 70 + 3, z / 70, 3) * 1.4 - 0.15) * 0.7;
      let asphalt = roadAsphalt[i];
      let concrete = 0;
      const pm = padMask[i];
      if (pm > 0) {
        if (padKind[i] === 1) concrete = pm;
        else if (padKind[i] === 2) dirt += pm * 1.5;
        else {
          concrete += pm * 0.45;
          dirt += pm;
        }
      }
      if (roadGravel[i] > 0) {
        dirt += roadGravel[i] * 1.4;
        concrete += roadGravel[i] * 0.25;
      }
      const paved = Math.max(asphalt, concrete);
      rock *= 1 - paved;
      sand *= 1 - paved;
      dirt *= 1 - paved * 0.8;
      const grass = Math.max(0, 1 - rock - sand - dirt - asphalt - concrete);
      const total = grass + dirt + rock + sand + asphalt + concrete || 1;
      const o = i * 6;
      S[o] = (grass / total) * 255;
      S[o + 1] = (dirt / total) * 255;
      S[o + 2] = (rock / total) * 255;
      S[o + 3] = (sand / total) * 255;
      S[o + 4] = (asphalt / total) * 255;
      S[o + 5] = (concrete / total) * 255;
      if (slope > 0.35) clear[i] = 1;
      if (coastSand[i] > 0.8 && hash01(ix, iz) > 0.02) clear[i] = 1; // W4: almost no trees on open sand
    }
  }

  return { hm, roads, padHeights, clear, roadDist, ms: performance.now() - t0 };
}

// -------------------------------------------------------------------- helpers

/** W4: shoreline x at z for a coast map (sea on +x). */
export function makeShore(def: MapDef): (z: number) => number {
  const c = def.coast!;
  const nz = new Simplex(def.seed + 31);
  return (z: number) => {
    let s = c.shore + nz.fbm(z / 220, 0.5, 3) * c.wobble;
    for (const h of c.headlands) s += h.reach * Math.exp(-(((z - h.z) / h.width) ** 2));
    return s;
  };
}

function hash01(x: number, z: number): number {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function forBox(hm: Heightmap, x0: number, z0: number, x1: number, z1: number, fn: (i: number, x: number, z: number) => void): void {
  const n = hm.n;
  const ix0 = Math.max(0, Math.floor((x0 + hm.half) / hm.cell));
  const iz0 = Math.max(0, Math.floor((z0 + hm.half) / hm.cell));
  const ix1 = Math.min(n - 1, Math.ceil((x1 + hm.half) / hm.cell));
  const iz1 = Math.min(n - 1, Math.ceil((z1 + hm.half) / hm.cell));
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = hm.wz(iz);
    for (let ix = ix0; ix <= ix1; ix++) fn(iz * n + ix, hm.wx(ix), z);
  }
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return { d: Math.hypot(px - (ax + dx * t), pz - (az + dz * t)), t };
}

/** Signed distance to a pad (negative inside). */
export function padSdf(p: PadDef, x: number, z: number): number {
  const dx = x - p.center[0];
  const dz = z - p.center[1];
  if (p.radius !== undefined) return Math.hypot(dx, dz) - p.radius;
  const c = Math.cos(-(p.rot ?? 0));
  const s = Math.sin(-(p.rot ?? 0));
  const lx = Math.abs(dx * c - dz * s) - p.half![0];
  const lz = Math.abs(dx * s + dz * c) - p.half![1];
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
}

function padMean(hm: Heightmap, p: PadDef): number {
  const r = p.radius ?? Math.max(p.half![0], p.half![1]);
  let sum = 0;
  let c = 0;
  for (let a = 0; a < 5; a++) {
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2;
      const rr = (a / 4) * r;
      sum += hm.sample(p.center[0] + Math.cos(ang) * rr, p.center[1] + Math.sin(ang) * rr);
      c++;
    }
  }
  return sum / c;
}

function densify(points: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < k; j++) out.push([ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k]);
  }
  out.push(points[points.length - 1]);
  return out;
}

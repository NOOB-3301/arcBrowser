import * as THREE from 'three';
import { Kit, type KitMat } from './BuildingKit';
import type { Heightmap } from './Heightmap';
import type { MapDef, PoiDef } from './MapDef';
import type { GenResult } from './MapGen';

const E = (x = 0, y = 0, z = 0) => new THREE.Euler(x, y, z);

/** Highest terrain point under a rotated footprint (buildings sit on it; foundations bury the rest). */
export function groundMax(hm: Heightmap, x: number, z: number, w: number, d: number, rot = 0): number {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  let h = hm.sample(x, z);
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    h = Math.max(h, hm.sample(x + lx * c + lz * s, z - lx * s + lz * c));
  }
  return h;
}

// ------------------------------------------------------------------ dam

export function buildDam(kit: Kit, def: MapDef, hm: Heightmap): void {
  const dam = def.dam!;
  const { z, x0, x1, top } = dam;
  const [b0, b1] = dam.breach;
  let bottom = top;
  for (let x = x0; x <= x1; x += 8) bottom = Math.min(bottom, hm.sample(x, z - 8), hm.sample(x, z + 20));
  bottom -= 3;

  const span = (a: number, b: number, y0: number, y1: number, zc: number, thick: number, mat: KitMat = 'concrete') => {
    kit.box((a + b) / 2, (y0 + y1) / 2, zc, b - a, y1 - y0, thick, mat);
  };
  // Main wall + two downstream buttress tiers, split at the breach
  for (const [a, b] of [[x0, b0], [b1, x1]] as const) {
    span(a, b, bottom, top, z, 10);
    span(a, b, bottom, top - 9, z + 8, 6);
    span(a, b, bottom, top - 18, z + 13, 5);
    // Railings
    kit.box((a + b) / 2, top + 0.55, z - 4.7, b - a, 1.1, 0.12, 'dark');
    kit.box((a + b) / 2, top + 0.55, z + 4.7, b - a, 1.1, 0.12, 'dark');
    for (let x = a + 6; x < b - 3; x += 24) {
      kit.box(x, top + 3, z + 4.5, 0.2, 6, 0.2, 'dark', false);
      kit.box(x, top + 6, z + 4, 0.2, 0.2, 1.2, 'dark', false);
    }
  }
  // Breach: stub of wall + rubble fan downstream
  span(b0, b1, bottom, bottom + 7, z, 10);
  const r = kit.random;
  for (let i = 0; i < 26; i++) {
    const x = b0 + r() * (b1 - b0) + (r() - 0.5) * 12;
    const zz = z + 6 + r() * 30;
    const s = 1.5 + r() * 4;
    kit.box(x, hm.sample(x, zz) + s * 0.3, zz, s, s * 0.8, s * 1.2, 'concrete', true, E(r(), r() * 3, r()));
  }
  // Exposed rebar spikes at the breach edges
  for (const x of [b0, b1]) {
    for (let k = 0; k < 6; k++) kit.box(x + (x === b0 ? 0.3 : -0.3), top - 2 - k * 3, z + (r() - 0.5) * 8, 0.08, 3, 0.08, 'rust', false, E(r() * 0.5, 0, r() * 0.8));
  }

  // Control tower (east, extraction elevator) and gatehouse (west)
  kit.push(150, top, z, 0);
  kit.building({ w: 11, d: 9.5, floors: 3, roof: 'flat', wall: 'concrete', doors: [1, 3] });
  kit.pop();
  kit.push(-152, top, z, 0);
  kit.building({ w: 9, d: 9, floors: 1, roof: 'flat', wall: 'concrete', doors: [1, 3] });
  kit.pop();
  // Outflow pipes through the wall
  for (const x of [-90, -60, 60, 90]) kit.cylinder(x, bottom + 8, z + 14, 1.4, 12, 'rust', true, E(Math.PI / 2, 0, 0));
}

// ------------------------------------------------------------------ pumping station

export function buildPumping(kit: Kit, poi: PoiDef, y: number): void {
  const [cx, cz] = poi.center;
  kit.push(cx, y, cz, poi.rot ?? 0);
  const W = 44;
  const D = 26;
  const H = 12;
  const big = (at: number): { at: number; w: number; y0: number; y1: number } => ({ at, w: 7, y0: 0, y1: 7 });
  kit.wall(-W / 2, -D / 2, W / 2, -D / 2, 0, H, 0.3, 'metal', [big(W / 2), { at: 6, w: 1.4, y0: 0, y1: 2.4 }]);
  kit.wall(W / 2, D / 2, -W / 2, D / 2, 0, H, 0.3, 'metal', [big(W / 2)]);
  kit.wall(W / 2, -D / 2, W / 2, D / 2, 0, H, 0.3, 'metal', [{ at: D / 2, w: 1.4, y0: 0, y1: 2.4 }]);
  kit.wall(-W / 2, D / 2, -W / 2, -D / 2, 0, H, 0.3, 'metal');
  // Clerestory gap then roof
  kit.box(0, H + 0.2, 0, W + 1, 0.4, D + 1, 'roof');
  kit.box(0, 0.05, 0, W, 0.1, D, 'concrete');
  // Interior catwalk along the west wall with stairs
  // Stairs run 9 m along +z up to where the catwalk begins
  kit.stairs(-W / 2 + 1.8, 0, -D / 2 + 1, 1.4, 6, 'rust');
  kit.box(-W / 2 + 1.8, 5.9, 4.5, 3, 0.25, 15, 'rust');
  kit.box(-W / 2 + 3.35, 6.6, 4.5, 0.08, 1.1, 15, 'dark');
  // Pump machinery
  for (let i = -1; i <= 1; i++) {
    kit.cylinder(i * 11 + 4, 2, 0, 2.2, 4, 'rust', true, E(0, 0, Math.PI / 2));
    kit.box(i * 11 + 4, 1, 3.5, 3, 2, 2, 'dark');
  }
  // Tanks outside
  for (const [tx, tz] of [[-36, -12], [-36, 2], [-36, 16]]) {
    kit.cylinder(tx, 5, tz, 5, 10, 'metal', true, undefined, 16);
    kit.cylinder(tx, 10.2, tz, 5.2, 0.4, 'rust', false, undefined, 16);
  }
  // Pipes to the dam
  for (const pz of [-6, 6]) kit.cylinder(-W / 2 - 25, 2.2, pz, 0.9, 50, 'rust', true, E(0, 0, Math.PI / 2));
  // Office
  kit.push(32, 0, -24, 0);
  kit.building({ w: 11, d: 8, floors: 2, roof: 'flat', wall: 'concrete', doors: [2] });
  kit.pop();
  // Jersey barriers
  for (let i = 0; i < 8; i++) kit.box(-20 + i * 6, 0.45, D / 2 + 9, 3, 0.9, 0.6, 'concrete');
  kit.pop();
}

// ------------------------------------------------------------------ radio hill

export function buildRadio(kit: Kit, poi: PoiDef, y: number): void {
  const [cx, cz] = poi.center;
  kit.push(cx, y, cz, 0.3);
  const H = 52;
  for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) kit.box(lx, H / 2, lz, 0.35, H, 0.35, 'rust');
  for (let h = 4; h < H; h += 4) {
    kit.box(0, h, -1.6, 3.2, 0.12, 0.12, 'rust', false);
    kit.box(0, h, 1.6, 3.2, 0.12, 0.12, 'rust', false);
    kit.box(-1.6, h, 0, 0.12, 0.12, 3.2, 'rust', false);
    kit.box(1.6, h, 0, 0.12, 0.12, 3.2, 'rust', false);
  }
  kit.cylinder(0, 30, -2.4, 2.6, 0.4, 'metal', false, E(Math.PI / 2 - 0.3, 0, 0), 16);
  kit.box(0, H + 1.5, 0, 0.3, 3, 0.3, 'hazard', false);
  kit.push(12, 0, 6, 0);
  kit.building({ w: 12, d: 8, floors: 1, roof: 'flat', wall: 'concrete', doors: [2], windows: false });
  kit.pop();
  kit.push(-12, 0, 8, 0.4);
  kit.building({ w: 6, d: 5, floors: 1, roof: 'flat', wall: 'metal', doors: [2] });
  kit.pop();
  // Perimeter fence (posts + low rail)
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
    const x = Math.cos(a) * 24;
    const z = Math.sin(a) * 24;
    kit.box(x, 1.2, z, 0.12, 2.4, 0.12, 'dark', false);
  }
  kit.pop();
}

// ------------------------------------------------------------------ village

export function buildVillage(kit: Kit, poi: PoiDef, hm: Heightmap, gen: GenResult): void {
  const r = kit.random;
  const [cx, cz] = poi.center;
  const placed: { x: number; z: number; rad: number }[] = [];
  let tries = 0;
  while (placed.length < 11 && tries++ < 300) {
    const ang = r() * Math.PI * 2;
    const dist = 22 + r() * (poi.radius - 30);
    const x = cx + Math.cos(ang) * dist;
    const z = cz + Math.sin(ang) * dist;
    const w = 7 + r() * 3.5;
    const d = 7 + r() * 2.5;
    const rad = Math.max(w, d) * 0.8 + 3;
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.rad + rad)) continue;
    if (roadDistAt(hm, gen, x, z) < rad + 3) continue;
    const rot = Math.atan2(cx - x, cz - z);
    const y = groundMax(hm, x, z, w, d, rot);
    kit.push(x, y, z, rot);
    kit.building({ w, d, floors: r() < 0.45 ? 2 : 1, roof: 'gable', wall: r() < 0.5 ? 'plaster' : 'brick', doors: [2, 0], ruined: r() < 0.15 });
    kit.pop();
    placed.push({ x, z, rad });
  }
  // Water tower
  const wx = cx + 12;
  const wz = cz - 18;
  const wy = hm.sample(wx, wz);
  for (const [lx, lz] of [[-2, -2], [2, -2], [2, 2], [-2, 2]]) kit.box(wx + lx, wy + 6, wz + lz, 0.3, 12, 0.3, 'rust');
  kit.cylinder(wx, wy + 14, wz, 3.4, 5, 'rust', true, undefined, 14);
  // Low stone walls
  for (let i = 0; i < 10; i++) {
    const a = r() * Math.PI * 2;
    const d = 30 + r() * (poi.radius - 20);
    const x = cx + Math.cos(a) * d;
    const z = cz + Math.sin(a) * d;
    if (roadDistAt(hm, gen, x, z) < 6 || placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.rad)) continue;
    kit.box(x, hm.sample(x, z) + 0.45, z, 8 + r() * 6, 1.1, 0.5, 'concrete', true, E(0, r() * 3, 0));
  }
}

// ------------------------------------------------------------------ town

export function buildTown(kit: Kit, poi: PoiDef, hm: Heightmap, gen: GenResult): void {
  const r = kit.random;
  const [cx, cz] = poi.center;
  const lot = 24;
  for (let gx = -4; gx <= 4; gx++) {
    for (let gz = -3; gz <= 3; gz++) {
      if (gx === 0 || gz === 0) continue; // main streets
      if (Math.abs(gx) <= 1 && Math.abs(gz) <= 1) continue; // square
      if (r() < 0.12) continue;
      const x = cx + gx * lot + (r() - 0.5) * 3;
      const z = cz + gz * lot + (r() - 0.5) * 3;
      const w = 11 + r() * 7;
      const d = 10 + r() * 6;
      if (roadDistAt(hm, gen, x, z) < Math.max(w, d) / 2 + 3) continue;
      const rot = (Math.round(r() * 3) * Math.PI) / 2;
      const y = groundMax(hm, x, z, w, d, rot);
      kit.push(x, y, z, rot);
      kit.building({
        w, d, floors: 2 + Math.floor(r() * 2), roof: 'flat',
        wall: (['plaster', 'brick', 'concrete'] as const)[Math.floor(r() * 3)],
        doors: [0, 2], ruined: r() < 0.3,
      });
      kit.pop();
    }
  }
  // Town square: fountain + planters + a bus wreck
  const y = hm.sample(cx, cz);
  kit.cylinder(cx, y + 0.4, cz, 4, 0.8, 'concrete', true, undefined, 20);
  kit.cylinder(cx, y + 1.6, cz, 0.6, 2.4, 'concrete', true);
  for (const [px, pz] of [[-14, -14], [14, -14], [14, 14], [-14, 14]]) kit.box(cx + px, y + 0.5, cz + pz, 3, 1, 3, 'concrete');
  kit.box(cx + 22, y + 1.6, cz - 6, 2.6, 3.2, 11, 'cYellow', true, E(0, 0.3, 0.05));
}

// ------------------------------------------------------------------ farm

export function buildFarm(kit: Kit, poi: PoiDef, hm: Heightmap): void {
  const r = kit.random;
  const [cx, cz] = poi.center;
  const place = (dx: number, dz: number, w: number, d: number, rot: number, fn: () => void) => {
    const x = cx + dx;
    const z = cz + dz;
    kit.push(x, groundMax(hm, x, z, w, d, rot), z, rot);
    fn();
    kit.pop();
  };
  place(0, -10, 20, 13, 0.1, () => kit.building({ w: 20, d: 13, floors: 1, floorH: 6.5, roof: 'gable', wall: 'rust', doors: [0, 2, 1] }));
  place(-32, 18, 9, 8, 0.6, () => kit.building({ w: 9, d: 8, floors: 2, roof: 'gable', wall: 'plaster', doors: [2] }));
  place(30, 22, 8, 7, -0.4, () => kit.building({ w: 8, d: 7, floors: 1, roof: 'gable', wall: 'brick', doors: [2], ruined: true }));
  for (const [sx, sz] of [[18, -28], [26, -24]]) {
    const y = hm.sample(cx + sx, cz + sz);
    kit.cylinder(cx + sx, y + 7, cz + sz, 3.5, 14, 'metal', true, undefined, 16);
  }
  for (let i = 0; i < 12; i++) {
    const x = cx - 10 + r() * 40;
    const z = cz + 20 + r() * 30;
    kit.cylinder(x, hm.sample(x, z) + 0.7, z, 0.75, 1.3, 'crate', true, E(Math.PI / 2, r() * 3, 0), 10);
  }
  // Fence lines
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const x = cx + Math.cos(a) * 70;
    const z = cz + Math.sin(a) * 70;
    kit.box(x, hm.sample(x, z) + 0.6, z, 0.15, 1.2, 12, 'wood', true, E(0, -a, 0));
  }
}

// ------------------------------------------------------------------ container yard

export function buildContainers(kit: Kit, poi: PoiDef, y: number): void {
  const r = kit.random;
  const [cx, cz] = poi.center;
  const colors: KitMat[] = ['cRed', 'cBlue', 'cGreen', 'cYellow', 'cGrey', 'rust'];
  kit.push(cx, y, cz, poi.rot ?? 0);
  const L = 12.2;
  const W = 2.44;
  const Hc = 2.6;
  for (let row = -2; row <= 2; row++) {
    const z = row * 18;
    for (let col = -22; col <= 22; col++) {
      if (col % 6 === 0) continue; // aisles
      if (r() < 0.18) continue;
      const x = col * (W + 0.25);
      const stack = 1 + Math.floor(r() * r() * 3.5);
      for (let k = 0; k < stack; k++) {
        const jitter = (r() - 0.5) * 0.3;
        kit.box(x + jitter, Hc * (k + 0.5), z + (r() - 0.5) * 0.6, W, Hc, L, colors[Math.floor(r() * colors.length)]);
      }
    }
  }
  // Gantry cranes
  for (const gz of [-27, 27]) {
    for (const [lx, lz] of [[-58, -4], [58, -4], [58, 4], [-58, 4]]) kit.box(lx, 12, gz + lz, 1.4, 24, 1.4, 'hazard');
    kit.box(0, 24.5, gz, 120, 2, 9, 'hazard');
    kit.box(12, 22, gz, 5, 3, 5, 'dark');
  }
  // Office
  kit.push(70, 0, 40, Math.PI);
  kit.building({ w: 12, d: 9, floors: 2, roof: 'flat', wall: 'concrete', doors: [0, 2] });
  kit.pop();
  // Cargo lift (extract)
  kit.push(78, 0, -52, 0);
  kit.box(0, 0.2, 0, 8, 0.4, 8, 'hazard');
  for (const [lx, lz] of [[-4, -4], [4, -4], [4, 4], [-4, 4]]) kit.box(lx, 9, lz, 0.5, 18, 0.5, 'rust');
  kit.box(0, 18, 0, 9, 0.6, 9, 'rust');
  kit.pop();
  kit.pop();
}

// ------------------------------------------------------------------ pylons, bridges, wrecks

export function buildPylons(kit: Kit, def: MapDef, hm: Heightmap): THREE.Line {
  const tips: THREE.Vector3[][] = [];
  const H = 28;
  for (let i = 0; i < def.pylons.length; i++) {
    const [x, z] = def.pylons[i];
    const next = def.pylons[Math.min(i + 1, def.pylons.length - 1)];
    const prev = def.pylons[Math.max(i - 1, 0)];
    const rot = Math.atan2(-(next[1] - prev[1]), next[0] - prev[0]) + Math.PI / 2;
    const y = hm.sample(x, z);
    kit.push(x, y, z, rot);
    const lean = 0.09;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      kit.box(sx * 1.8, H / 2 - 0.5, sz * 1.8, 0.35, H + 1, 0.35, 'dark', true, E(-sz * lean, 0, sx * lean));
    }
    for (let h = 5; h < H; h += 5) kit.box(0, h, 0, 3.6 - h * 0.08, 0.15, 3.6 - h * 0.08, 'dark', false);
    kit.box(0, H - 4, 0, 0.3, 0.4, 13, 'dark', false);
    kit.box(0, H, 0, 0.3, 0.4, 9, 'dark', false);
    kit.pop();
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const tip = (lz: number, ly: number) => new THREE.Vector3(x + lz * s, y + ly, z + lz * c);
    tips.push([tip(-6.3, H - 4.3), tip(6.3, H - 4.3), tip(0, H - 0.3)]);
  }
  // Sagging cables
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < tips.length - 1; i++) {
    for (let k = 0; k < 3; k++) {
      const a = tips[i][k];
      const b = tips[i + 1][k];
      const segs = 12;
      for (let j = 0; j < segs; j++) {
        const t0 = j / segs;
        const t1 = (j + 1) / segs;
        const sag = (t: number) => Math.sin(Math.PI * t) * 4;
        pts.push(a.clone().lerp(b, t0).setY(a.y + (b.y - a.y) * t0 - sag(t0)), a.clone().lerp(b, t1).setY(a.y + (b.y - a.y) * t1 - sag(t1)));
      }
    }
  }
  return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#1d1d1d' }));
}

export function buildBridges(kit: Kit, def: MapDef, hm: Heightmap, gen: GenResult): void {
  for (const b of def.bridges) {
    const [x, z] = b.center;
    const y = nearestRoadHeight(gen, x, z) + 0.35;
    kit.push(x, y, z, b.rot);
    kit.box(0, -0.35, 0, b.width, 0.7, b.length, 'concrete');
    kit.box(-b.width / 2 + 0.2, 0.55, 0, 0.3, 1.1, b.length, 'concrete');
    kit.box(b.width / 2 - 0.2, 0.55, 0, 0.3, 1.1, b.length, 'concrete');
    for (const pz of [-b.length / 4, b.length / 4]) {
      const ground = hm.sample(x, z + pz);
      const h = y - ground + 3;
      kit.box(0, -h / 2, pz, 2.2, h, 2.2, 'concrete');
    }
    kit.pop();
  }
}

export function buildWrecks(kit: Kit, gen: GenResult): void {
  const r = kit.random;
  const cols: KitMat[] = ['cRed', 'cBlue', 'cGrey', 'rust', 'cGreen'];
  for (const road of gen.roads) {
    for (let i = 10; i < road.points.length - 10; i += 18 + Math.floor(r() * 20)) {
      if (r() < 0.4) continue;
      const p = road.points[i];
      const q = road.points[i + 1];
      const rot = Math.atan2(q.x - p.x, q.z - p.z) + (r() - 0.5) * 0.8;
      const off = (r() - 0.5) * road.width * 0.6;
      const x = p.x + Math.cos(rot) * off;
      const z = p.z - Math.sin(rot) * off;
      const c = cols[Math.floor(r() * cols.length)];
      kit.push(x, p.y, z, rot);
      kit.box(0, 0.65, 0, 1.8, 0.8, 4.3, c);
      kit.box(0, 1.35, -0.2, 1.6, 0.65, 2.2, c);
      kit.box(0, 1.35, 0.95, 1.5, 0.5, 0.05, 'dark', false);
      kit.pop();
    }
  }
}

// ------------------------------------------------------------------ helpers

function roadDistAt(hm: Heightmap, gen: GenResult, x: number, z: number): number {
  const ix = Math.round((x + hm.half) / hm.cell);
  const iz = Math.round((z + hm.half) / hm.cell);
  if (ix < 0 || iz < 0 || ix >= hm.n || iz >= hm.n) return 1e9;
  return gen.roadDist[iz * hm.n + ix];
}

function nearestRoadHeight(gen: GenResult, x: number, z: number): number {
  let best = 1e9;
  let h = 0;
  for (const road of gen.roads) {
    for (const p of road.points) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) {
        best = d;
        h = p.y;
      }
    }
  }
  return h;
}

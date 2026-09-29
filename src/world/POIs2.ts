import * as THREE from 'three';
import { RAPIER, Groups, interactionGroups, type Physics } from '../physics/Physics';
import { NavObstacles } from '../ai/NavObstacles';
import type { Kit, KitMat } from './BuildingKit';
import type { Heightmap } from './Heightmap';
import type { MapDef, PoiDef } from './MapDef';
import type { GenResult } from './MapGen';
import type { Traversal } from './Traversal';

/**
 * W4 — Shardcoast POIs: buried coastal city, rusted spaceport with a climbable
 * launch gantry, lighthouse, broken highway overpass and a beached shipwreck.
 */

const E = (x = 0, y = 0, z = 0) => new THREE.Euler(x, y, z);

export interface Poi2Env {
  def: MapDef;
  hm: Heightmap;
  gen: GenResult;
  traversal: Traversal;
  extras: Extras;
  /** Resolved pad height at the POI centre (or terrain height). */
  y: number;
}

// ------------------------------------------------------------------ extras (sand + custom meshes)

/**
 * Things the building kit can't express: sand drifts (own material, convex
 * colliders), glowing lamps and small animated props.
 */
export class Extras {
  private sand: THREE.BufferGeometry[] = [];
  private hulls: Float32Array[] = [];
  private objects: THREE.Object3D[] = [];
  private updaters: ((dt: number) => void)[] = [];

  /** Wedge drift: rises from 0 at local -z to `h` at local +z (against a wall). */
  drift(x: number, y: number, z: number, w: number, h: number, d: number, rotY: number): void {
    const hw = w / 2;
    const hd = d / 2;
    const local = [
      [-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd],
      [-hw * 0.85, h, hd], [hw * 0.85, h, hd], [-hw * 0.6, h * 0.55, 0], [hw * 0.6, h * 0.55, 0],
    ];
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(1, 1, 1));
    const pts = local.map(([a, b, c]) => new THREE.Vector3(a, b, c).applyMatrix4(m));
    // Hull triangles (convex): bottom, sides, slope, back
    const tri = (i: number, j: number, k: number) => [pts[i], pts[j], pts[k]];
    const faces = [
      tri(0, 2, 1), tri(0, 3, 2), // bottom
      tri(0, 1, 7), tri(0, 7, 6), tri(6, 7, 5), tri(6, 5, 4), // slope (two facets)
      tri(3, 4, 5), tri(3, 5, 2), // back
      tri(0, 6, 4), tri(0, 4, 3), // left
      tri(1, 2, 5), tri(1, 5, 7), // right
    ];
    const pos: number[] = [];
    for (const f of faces) for (const p of f) pos.push(p.x, p.y, p.z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    this.sand.push(g);
    this.hulls.push(new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z])));
    NavObstacles.addBox(new THREE.Vector3(x, y + h / 2, z), new THREE.Vector3(hw, h / 2, hd), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY));
  }

  add(o: THREE.Object3D, update?: (dt: number) => void): void {
    this.objects.push(o);
    if (update) this.updaters.push(update);
  }

  build(scene: THREE.Scene, physics: Physics): void {
    if (this.sand.length) {
      const g = mergeNonIndexed(this.sand);
      const mat = new THREE.MeshStandardMaterial({ color: '#c9b287', roughness: 1, metalness: 0 });
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      scene.add(mesh);
      const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const groups = interactionGroups(Groups.WORLD, 0xffff);
      for (const h of this.hulls) {
        const desc = RAPIER.ColliderDesc.convexHull(h);
        if (desc) physics.world.createCollider(desc.setCollisionGroups(groups), body);
      }
    }
    for (const o of this.objects) scene.add(o);
    this.sand = [];
    this.hulls = [];
  }

  update(dt: number): void {
    for (const u of this.updaters) u(dt);
  }
}

function mergeNonIndexed(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nrm.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}

// ------------------------------------------------------------------ kit helpers

/** Push a tilted frame (the kit's own push only yaws). */
function pushTilt(kit: Kit, x: number, y: number, z: number, rotY: number, tiltX: number, tiltZ: number): THREE.Matrix4 {
  const stack = (kit as unknown as { stack: THREE.Matrix4[] }).stack;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, rotY, tiltZ, 'YXZ')), new THREE.Vector3(1, 1, 1));
  const top = stack[stack.length - 1].clone().multiply(m);
  stack.push(top);
  return top;
}

/** Slab with a rectangular hole (local, centred at origin). */
function slabHole(kit: Kit, cx: number, y: number, cz: number, w: number, d: number, hole: { x0: number; x1: number; z0: number; z1: number }, mat: KitMat): void {
  const th = 0.3;
  const X0 = cx - w / 2;
  const X1 = cx + w / 2;
  const Z0 = cz - d / 2;
  const Z1 = cz + d / 2;
  const cy = y - th / 2;
  kit.box((X0 + hole.x0) / 2, cy, cz, hole.x0 - X0, th, d, mat);
  kit.box((hole.x1 + X1) / 2, cy, cz, X1 - hole.x1, th, d, mat);
  kit.box((hole.x0 + hole.x1) / 2, cy, (Z0 + hole.z0) / 2, hole.x1 - hole.x0, th, hole.z0 - Z0, mat);
  kit.box((hole.x0 + hole.x1) / 2, cy, (hole.z1 + Z1) / 2, hole.x1 - hole.x0, th, Z1 - hole.z1, mat);
}

function roadDist(env: Poi2Env, x: number, z: number): number {
  const { hm, gen } = env;
  const ix = Math.round((x + hm.half) / hm.cell);
  const iz = Math.round((z + hm.half) / hm.cell);
  if (ix < 0 || iz < 0 || ix >= hm.n || iz >= hm.n) return 1e9;
  return gen.roadDist[iz * hm.n + ix];
}

/** Register a ladder (base on the wall face, normal pointing out) + visible rails/rungs. */
function ladder(kit: Kit, traversal: Traversal, world: THREE.Matrix4, lx: number, ly: number, lz: number, nx: number, nz: number, height: number): void {
  const rot = Math.atan2(nx, nz); // local frame whose +z is the normal
  kit.push(lx, ly, lz, rot);
  for (const s of [-0.35, 0.35]) kit.box(s, height / 2 + 0.4, 0.1, 0.06, height + 0.8, 0.06, 'hazard', false);
  for (let y = 0.3; y < height + 0.6; y += 0.4) kit.box(0, y, 0.1, 0.7, 0.04, 0.04, 'hazard', false);
  kit.pop();
  const base = new THREE.Vector3(lx, ly, lz).applyMatrix4(world);
  const n = new THREE.Vector3(nx, 0, nz).transformDirection(world).setY(0).normalize();
  traversal.ladders.push({ base, height, normal: n, halfWidth: 0.4 });
}

function frameOf(x: number, y: number, z: number, rot: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(1, 1, 1));
}

// ------------------------------------------------------------------ dispatcher

export function buildPoi2(kit: Kit, poi: PoiDef, env: Poi2Env): void {
  switch (poi.kind) {
    case 'city':
      return buildCity(kit, poi, env);
    case 'spaceport':
      return buildSpaceport(kit, poi, env);
    case 'lighthouse':
      return buildLighthouse(kit, poi, env);
    case 'overpass':
      return buildOverpass(kit, poi, env);
    case 'shipwreck':
      return buildShipwreck(kit, poi, env);
    default:
      return;
  }
}

// ------------------------------------------------------------------ Saltmere: collapsed city half-buried in sand

export function buildCity(kit: Kit, poi: PoiDef, env: Poi2Env): void {
  const r = kit.random;
  const [cx, cz] = poi.center;
  const walls: KitMat[] = ['plaster', 'concrete', 'brick', 'plaster'];
  const SP = 30;
  const n = Math.floor(poi.radius / SP);
  for (let gz = -n; gz <= n; gz++) {
    for (let gx = -n; gx <= n; gx++) {
      const landmark = gx === 0 && gz === -1;
      const x = cx + gx * SP + (r() - 0.5) * 6;
      const z = cz + gz * SP + (r() - 0.5) * 6;
      const d = Math.hypot(x - cx, z - cz);
      if (d > poi.radius - 12) continue;
      const w = landmark ? 14 : 9 + r() * 7;
      const dd = landmark ? 12 : 8 + r() * 6;
      const clearance = Math.hypot(w, dd) / 2 + 6;
      if (roadDist(env, x, z) < clearance) continue;
      if (!landmark && r() < 0.14) continue; // open lots
      const deep = r() < 0.3;
      const seaward = Math.max(0, (x - cx) / 70);
      const sink = landmark ? 1.2 : deep ? 1.8 + r() * 1.0 : 0.2 + r() * 0.6 + seaward * 0.4;
      const lean = landmark ? 0.12 : r() < 0.2 ? 0.16 + r() * 0.12 : r() * 0.07;
      const leanDir = r() * Math.PI * 2;
      const rotY = (r() - 0.5) * 0.5 + Math.round(r() * 3) * (Math.PI / 2);
      const floors = landmark ? 8 : 1 + Math.floor(r() * 3) + (d < 60 ? 2 : 0);
      const y = env.hm.sample(x, z) - sink;
      const m = pushTilt(kit, x, y, z, rotY, Math.cos(leanDir) * lean, Math.sin(leanDir) * lean);
      kit.building({
        w, d: dd, floors, roof: 'flat', wall: walls[Math.floor(r() * walls.length)], doors: [0, 1, 2, 3].filter(() => r() < 0.6).concat([2]),
        ruined: landmark || r() < 0.45, windows: true, seed: Math.floor(r() * 1e6),
      });
      kit.pop();
      // Sand inside (against one wall) and piled against the seaward side
      const inside = new THREE.Vector3((r() - 0.5) * w * 0.3, 0, dd / 2 - 1.6).applyMatrix4(m);
      env.extras.drift(inside.x, env.hm.sample(inside.x, inside.z) - 0.3, inside.z, w * 0.6, 1 + r() * 1.2, 3, rotY);
      const out = new THREE.Vector3(w / 2 + 2.2, 0, 0).applyMatrix4(m);
      env.extras.drift(out.x, env.hm.sample(out.x, out.z) - 0.4, out.z, dd * 0.8, 1.5 + r() * 2 + seaward, 4.5, rotY - Math.PI / 2);
    }
  }
  // Toppled lamp posts + concrete debris along the streets
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2;
    const rr = r() * poi.radius;
    const x = cx + Math.cos(a) * rr;
    const z = cz + Math.sin(a) * rr;
    const g = env.hm.sample(x, z);
    if (r() < 0.5) kit.box(x, g + 0.3, z, 0.2, 0.2, 6, 'dark', false, E(0.1, r() * 3, 1.45));
    else kit.box(x, g + 0.2, z, 1 + r() * 2, 0.6 + r(), 1 + r() * 2, 'concrete', true, E(r() * 0.4, r() * 3, r() * 0.4));
  }
}

// ------------------------------------------------------------------ Kestrel launch complex

export function buildSpaceport(kit: Kit, poi: PoiDef, env: Poi2Env): void {
  const [cx, cz] = poi.center;
  const y = env.y;
  const rot = poi.rot ?? 0;
  const world = frameOf(cx, y, cz, rot);
  kit.push(cx, y, cz, rot);

  // Launch mount with flame trench + access ramp
  kit.box(40, 3, -51, 34, 6, 12, 'concrete');
  kit.box(40, 3, -29, 34, 6, 12, 'concrete');
  kit.box(40, 0.1, -40, 34, 0.2, 10, 'dark', false);
  kit.box(40, 3, -14, 8, 0.5, 19, 'concrete', true, E(0.32, 0, 0));
  for (const x of [26, 54]) kit.box(x, 7, -40, 1.2, 2, 22, 'rust'); // hold-down arms
  // Blast walls
  kit.box(0, 2.5, -40, 1.4, 5, 46, 'concrete');
  kit.box(40, 2.5, -104, 56, 5, 1.4, 'concrete');
  kit.box(80, 2.5, -95, 1.4, 5, 20, 'concrete', true, E(0, 0.4, 0));
  // Toppled rocket: long rusted stack lying beyond the mount
  kit.cylinder(40, 4.2, -80, 4, 52, 'cGrey', true, E(0, 0, Math.PI / 2), 18);
  kit.cylinder(40 - 20, 4.25, -80, 4.1, 3, 'rust', false, E(0, 0, Math.PI / 2), 18);
  kit.cylinder(40 + 8, 4.25, -80, 4.1, 3, 'cRed', false, E(0, 0, Math.PI / 2), 18);
  kit.cylinder(40 + 29, 4, -80, 2.5, 6, 'rust', true, E(0, 0, Math.PI / 2), 14);
  for (const dz of [-2.5, 2.5]) kit.cylinder(40 - 28, 3, -80 + dz, 1.4, 5, 'dark', true, E(0, 0, Math.PI / 2 - 0.3), 10);
  for (const s of [-1, 1]) kit.box(40 - 22, 4.2 + s * 5, -80, 6, 3, 0.4, 'cGrey', false);

  // Launch gantry: 5 levels × 12 m, climbed by ladders on service cabins through slab hatches
  const G = new THREE.Vector3(72, 0, -40);
  const LV = 12;
  const LEVELS = 5;
  const S = 11;
  kit.push(G.x, 0, G.z, 0);
  const gantryWorld = world.clone().multiply(frameOf(G.x, 0, G.z, 0));
  const corners: [number, number][] = [[-3, -3], [3, -3], [3, 3], [-3, 3]];
  const holes: { x0: number; x1: number; z0: number; z1: number }[] = [];
  for (let k = 0; k < LEVELS; k++) {
    const [qx, qz] = corners[k % 4];
    const nx = qx < 0 ? 1 : -1; // ladder faces the tower centre line
    const faceX = qx + nx * 2;
    // Service cabin 4×4×12 whose roof is the next level
    kit.box(qx, k * LV + LV / 2, qz, 4, LV, 4, k % 2 ? 'rust' : 'metal');
    ladder(kit, env.traversal, gantryWorld, faceX, k * LV, qz, nx, 0, LV);
    holes.push({ x0: Math.min(faceX, faceX + nx * 1.6), x1: Math.max(faceX, faceX + nx * 1.6), z0: qz - 0.9, z1: qz + 0.9 });
  }
  for (let k = 1; k <= LEVELS; k++) {
    const yy = k * LV;
    slabHole(kit, 0, yy, 0, S, S, holes[k - 1], 'rust');
    // Railings (low, colliding) around the grating
    for (const [x, z, w, d] of [[0, -S / 2, S, 0.1], [0, S / 2, S, 0.1], [-S / 2, 0, 0.1, S], [S / 2, 0, 0.1, S]]) kit.box(x, yy + 0.55, z, w, 1.1, d, 'dark');
  }
  // Lattice columns + bracing
  for (const [x, z] of [[-S / 2, -S / 2], [S / 2, -S / 2], [S / 2, S / 2], [-S / 2, S / 2]]) kit.box(x, (LEVELS * LV + 8) / 2, z, 0.6, LEVELS * LV + 8, 0.6, 'rust');
  for (let h = 3; h < LEVELS * LV; h += 6) {
    kit.box(0, h, -S / 2, S, 0.25, 0.25, 'rust', false, E(0, 0, h % 12 < 6 ? 0.9 : -0.9));
    kit.box(0, h, S / 2, S, 0.25, 0.25, 'rust', false, E(0, 0, h % 12 < 6 ? -0.9 : 0.9));
  }
  // Umbilical arms reaching to the (fallen) rocket's mount
  for (const k of [2, 3]) kit.box(-S / 2 - 9, k * LV + 0.5, 0, 18, 1.2, 2.2, 'hazard');
  kit.box(0, LEVELS * LV + 8.3, 0, 1.2, 0.6, 1.2, 'hazard', false);
  kit.pop();
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: '#ff3020' }));
  beacon.position.set(G.x, LEVELS * LV + 9, G.z).applyMatrix4(world);
  let bt = 0;
  env.extras.add(beacon, (dt) => {
    bt += dt;
    beacon.visible = bt % 1.4 < 0.7;
  });

  // Fuel farm: three big tanks + pipes to the mount
  for (let i = 0; i < 3; i++) {
    const tx = -110 + i * 20;
    kit.cylinder(tx, 10, -72, 7.5, 20, i === 1 ? 'cGrey' : 'metal', true, undefined, 20);
    kit.cylinder(tx, 20.4, -72, 7.7, 0.8, 'rust', false, undefined, 20);
    kit.cylinder(tx, 21.5, -72, 5, 1.6, 'rust', false, undefined, 20);
    kit.box(tx + 7.8, 10, -72, 0.5, 20, 0.9, 'hazard', false); // ladder stripe
  }
  kit.cylinder(-30, 1.4, -72, 0.9, 110, 'rust', true, E(0, 0, Math.PI / 2));
  kit.cylinder(-30, 1.4, -66, 0.6, 110, 'rust', true, E(0, 0, Math.PI / 2));
  for (let i = 0; i < 6; i++) kit.box(-100 + i * 22, 0.6, -69, 1.2, 1.2, 8, 'concrete');
  // Tank blast berm
  kit.box(-80, 1.5, -52, 70, 3, 2.5, 'concrete');

  // Hangar: big open-front shed with a mock shuttle inside
  kit.push(-90, 0, 60, 0);
  const HW = 60;
  const HD = 40;
  const HH = 18;
  kit.wall(-HW / 2, HD / 2, HW / 2, HD / 2, 0, HH, 0.4, 'metal', [{ at: HW / 2, w: 26, y0: 0, y1: 14 }]);
  kit.wall(HW / 2, -HD / 2, -HW / 2, -HD / 2, 0, HH, 0.4, 'metal', [{ at: 12, w: 1.6, y0: 0, y1: 2.5 }]);
  kit.wall(HW / 2, HD / 2, HW / 2, -HD / 2, 0, HH, 0.4, 'metal', [{ at: HD / 2, w: 1.6, y0: 0, y1: 2.5 }]);
  kit.wall(-HW / 2, -HD / 2, -HW / 2, HD / 2, 0, HH, 0.4, 'metal', [{ at: 10, w: 6, y0: 0, y1: 5 }]);
  kit.box(0, HH + 0.3, 0, HW + 1, 0.6, HD + 1, 'roof');
  for (let x = -HW / 2 + 6; x < HW / 2; x += 12) kit.box(x, HH - 0.6, 0, 0.5, 1.2, HD, 'rust', false);
  kit.box(0, 0.05, 0, HW, 0.1, HD, 'concrete');
  // Shuttle mock-up
  kit.box(0, 3.2, 2, 8, 4, 22, 'cGrey');
  kit.box(0, 3.2, -10.5, 5, 3, 4, 'cGrey', true, E(0.3, 0, 0));
  kit.box(0, 1.8, 6, 20, 0.6, 8, 'cGrey');
  kit.box(0, 6.5, 10, 0.6, 4.5, 5, 'cGrey');
  // Catwalk with stairs along the back wall
  kit.stairs(HW / 2 - 2, 0, -HD / 2 + 1.5, 1.4, 6, 'rust');
  kit.box(0, 5.9, -HD / 2 + 12, HW - 2, 0.25, 2, 'rust');
  for (let i = 0; i < 10; i++) kit.box(-24 + (i % 5) * 3, 0.75, 12 + Math.floor(i / 5) * 3, 1.5, 1.5, 1.5, 'crate');
  kit.pop();

  // Control bunker + floodlight masts
  kit.push(-20, 0, 92, 0);
  kit.building({ w: 16, d: 10, floors: 2, roof: 'flat', wall: 'concrete', doors: [0, 2], seed: 3 });
  kit.pop();
  for (const [x, z] of [[-150, -110], [150, -110], [150, 110], [-150, 110]]) {
    kit.box(x, 12, z, 0.8, 24, 0.8, 'dark');
    kit.box(x, 24, z, 4, 1.2, 1, 'dark', false);
  }
  // Launch pad lift (extract) platform
  kit.push(140, 0, -110, 0);
  kit.box(0, 0.2, 0, 8, 0.4, 8, 'hazard');
  for (const [lx, lz] of [[-4, -4], [4, -4], [4, 4], [-4, 4]]) kit.box(lx, 9, lz, 0.5, 18, 0.5, 'rust');
  kit.box(0, 18, 0, 9, 0.6, 9, 'rust');
  kit.pop();
  // Jersey barriers + rust debris scattered over the apron
  const r = kit.random;
  for (let i = 0; i < 26; i++) {
    const x = (r() - 0.5) * 300;
    const z = (r() - 0.5) * 200;
    if (Math.abs(x - 40) < 50 && Math.abs(z + 50) < 60) continue;
    if (Math.abs(x + 90) < 40 && Math.abs(z - 60) < 30) continue;
    if (x < -60 && x > -135 && z < -55 && z > -90) continue;
    if (r() < 0.6) kit.box(x, 0.45, z, 3, 0.9, 0.6, 'concrete', true, E(0, r() * 3, 0));
    else kit.box(x, 0.8, z, 2.4, 1.6, 6, r() < 0.5 ? 'cRed' : 'cGrey', true, E(0, r() * 3, 0));
  }
  kit.pop();
}

// ------------------------------------------------------------------ Gull Point lighthouse

export function buildLighthouse(kit: Kit, poi: PoiDef, env: Poi2Env): void {
  const [cx, cz] = poi.center;
  const y = env.y;
  const world = frameOf(cx, y, cz, 0);
  kit.push(cx, y, cz, 0);
  const H = 24;
  kit.box(0, -2, 0, 8, 4, 8, 'concrete'); // plinth into the rock
  kit.box(0, H / 2, 0, 6, H, 6, 'plaster');
  for (const h of [5, 11, 17]) kit.box(0, h, 0, 6.12, 1.4, 6.12, 'cRed', false);
  // Gallery (tower top) + rails; open on the ladder side (west)
  kit.box(0, H + 0.1, 0, 6.8, 0.2, 6.8, 'dark', false);
  for (const [x, z, w, d] of [[0, -3.35, 6.8, 0.08], [0, 3.35, 6.8, 0.08], [3.35, 0, 0.08, 6.8]]) kit.box(x, H + 0.6, z, w, 1, d, 'dark');
  kit.cylinder(0.8, H + 1.6, 0, 1.3, 3, 'dark', true, undefined, 10);
  kit.cylinder(0.8, H + 3.4, 0, 1.6, 0.5, 'cRed', false, undefined, 10);
  ladder(kit, env.traversal, world, -3, 0, 0, -1, 0, H);
  // Keeper's cottage
  kit.push(-14, 0, 10, 0.2);
  kit.building({ w: 8, d: 7, floors: 1, roof: 'gable', wall: 'plaster', doors: [2, 3], seed: 9 });
  kit.pop();
  // Low stone wall around the yard
  for (let a = 0.6; a < Math.PI * 2 - 0.3; a += 0.26) kit.box(Math.cos(a) * 22, 0.5, Math.sin(a) * 22, 5.5, 1, 0.6, 'concrete', true, E(0, -a + Math.PI / 2, 0));
  kit.pop();
  // Lamp + rotating beams
  const lamp = new THREE.Group();
  lamp.position.set(0.8, H + 1.8, 0).applyMatrix4(world);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), new THREE.MeshBasicMaterial({ color: '#fff4c8' }));
  lamp.add(bulb);
  const beamMat = new THREE.MeshBasicMaterial({ color: '#fff0b0', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const s of [1, -1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(6, 90, 16, 1, true), beamMat);
    cone.rotation.z = (s * Math.PI) / 2;
    cone.position.x = s * -45;
    lamp.add(cone);
  }
  env.extras.add(lamp, (dt) => (lamp.rotation.y += dt * 0.6));
}

// ------------------------------------------------------------------ broken highway overpass

export function buildOverpass(kit: Kit, poi: PoiDef, env: Poi2Env): void {
  const [cx, cz] = poi.center;
  const rot = poi.rot ?? 0;
  const L = 240;
  const W = 12;
  const dir = new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot));
  const at = (s: number) => new THREE.Vector3(cx, 0, cz).addScaledVector(dir, s);
  const hm = env.hm;
  let top = -1e9;
  for (let s = -L / 2 + 40; s <= L / 2 - 40; s += 10) {
    const p = at(s);
    top = Math.max(top, hm.sample(p.x, p.z));
  }
  const Y = top + 9;
  const SEG = 20;
  const gap = [-10, 10]; // collapsed span
  for (let s0 = -L / 2; s0 < L / 2; s0 += SEG) {
    const s1 = s0 + SEG;
    if (s0 >= gap[0] && s1 <= gap[1]) continue;
    const ramp = s0 < -L / 2 + 40 || s1 > L / 2 - 40;
    const hAt = (s: number) => {
      if (s <= -L / 2 + 40) {
        const p = at(-L / 2);
        return THREE.MathUtils.lerp(hm.sample(p.x, p.z) + 0.2, Y, (s + L / 2) / 40);
      }
      if (s >= L / 2 - 40) {
        const p = at(L / 2);
        return THREE.MathUtils.lerp(Y, hm.sample(p.x, p.z) + 0.2, (s - (L / 2 - 40)) / 40);
      }
      return Y;
    };
    const ya = hAt(s0);
    const yb = hAt(s1);
    const mid = at((s0 + s1) / 2);
    const pitch = -Math.atan2(yb - ya, SEG);
    const len = Math.hypot(SEG, yb - ya) + 0.05;
    kit.push(mid.x, (ya + yb) / 2, mid.z, rot);
    kit.box(0, -0.4, 0, W, 0.8, len, 'asphalt', true, E(pitch, 0, 0));
    for (const side of [-1, 1]) kit.box(side * (W / 2 - 0.3), 0.45, 0, 0.5, 1, len, 'concrete', true, E(pitch, 0, 0));
    kit.pop();
    if (!ramp) {
      const p = at(s0 + (s0 < 0 ? 0 : SEG));
      const g = hm.sample(p.x, p.z);
      const h = Y - g + 3;
      kit.push(p.x, 0, p.z, rot);
      kit.box(0, Y - 0.8 - h / 2, 0, 2.4, h, 2.4, 'concrete');
      kit.box(0, Y - 1.2, 0, W - 1, 0.8, 1.8, 'concrete', false);
      kit.pop();
    }
  }
  // Fallen span: one end still on the deck lip, the other in the dirt
  const a = at(gap[0]);
  const b = at(gap[1]);
  const gb = hm.sample(b.x, b.z);
  const mid = a.clone().lerp(b, 0.5);
  const drop = Y - gb;
  kit.push(mid.x, (Y + gb) / 2 - 0.6, mid.z, rot);
  kit.box(0, 0, 0, W - 1, 0.8, Math.hypot(gap[1] - gap[0], drop) - 0.5, 'asphalt', true, E(Math.atan2(drop, gap[1] - gap[0]), 0, 0.08));
  kit.pop();
  const r = kit.random;
  for (let i = 0; i < 10; i++) {
    const p = mid.clone().add(new THREE.Vector3((r() - 0.5) * 16, 0, (r() - 0.5) * 16));
    const s = 1 + r() * 2.5;
    kit.box(p.x, hm.sample(p.x, p.z) + s * 0.3, p.z, s, s * 0.7, s * 1.3, 'concrete', true, E(r(), r() * 3, r()));
  }
  // Abandoned cars on the deck
  for (const s of [-70, -36, 34, 62]) {
    const p = at(s);
    kit.push(p.x, Y, p.z, rot + (r() - 0.5) * 0.6);
    kit.box((r() - 0.5) * 5, 0.65, 0, 1.8, 0.8, 4.3, r() < 0.5 ? 'cRed' : 'cBlue');
    kit.pop();
  }
}

// ------------------------------------------------------------------ The Leviathan: beached cargo ship

export function buildShipwreck(kit: Kit, poi: PoiDef, env: Poi2Env): void {
  const [cx, cz] = poi.center;
  const y = env.def.waterLevel - 2.5;
  const rot = poi.rot ?? 0;
  const L = 84;
  const B = 15;
  const H = 12;
  pushTilt(kit, cx, y, cz, rot, 0.03, 0.26);
  kit.box(0, 0.5, 0, B, 1, L, 'rust');
  const holes = (len: number) => [
    { at: len * 0.22, w: 3.5, y0: 2.2, y1: 6.5 },
    { at: len * 0.5, w: 5, y0: 1.5, y1: 7.5 },
    { at: len * 0.78, w: 3, y0: 3, y1: 6 },
  ];
  kit.wall(-B / 2, -L / 2, -B / 2, L / 2, 0, H, 0.5, 'rust', holes(L));
  kit.wall(B / 2, L / 2, B / 2, -L / 2, 0, H, 0.5, 'rust', holes(L).slice(1));
  // Bow: two plates converging
  for (const s of [-1, 1]) {
    const ax = s * B / 2;
    const az = -L / 2;
    const len = Math.hypot(B / 2, 14);
    kit.box(ax / 2, H / 2, az - 7, 0.5, H, len, 'rust', true, E(0, s * Math.atan2(B / 2, 14), 0));
  }
  kit.wall(B / 2, L / 2, -B / 2, L / 2, 0, H, 0.5, 'rust', [{ at: B / 2, w: 3, y0: 1, y1: 5 }]);
  // Interior bulkheads with doorways
  for (const bz of [-20, 5, 24]) kit.wall(-B / 2, bz, B / 2, bz, 1, H - 1, 0.3, 'rust', [{ at: B / 2 + (bz % 2 ? 3 : -3), w: 2, y0: 0, y1: 3 }]);
  // Main deck, torn open amidships
  kit.box(0, H, -27, B, 0.4, 30, 'rust');
  kit.box(0, H, 28, B, 0.4, 28, 'rust');
  kit.box(-4, H - 1.5, -6, 6, 0.4, 10, 'rust', true, E(0.4, 0, 0.3));
  // Superstructure aft
  kit.push(0, H, 30, 0);
  kit.building({ w: 12, d: 9, floors: 2, roof: 'flat', wall: 'metal', doors: [0, 2], ruined: true, seed: 17 });
  kit.pop();
  kit.cylinder(0, H + 10, 24, 1.8, 8, 'cRed', true, undefined, 12);
  // Mast + cargo crane
  kit.box(0, H + 9, -30, 0.6, 18, 0.6, 'rust');
  kit.box(0, H + 16, -24, 0.4, 0.4, 14, 'rust', false, E(0.4, 0, 0));
  // Spilled containers on the sand
  const cols: KitMat[] = ['cRed', 'cBlue', 'cGreen', 'cYellow'];
  const r = kit.random;
  for (let i = 0; i < 7; i++) kit.box(-16 - r() * 14, 1.3, -30 + i * 9 + r() * 3, 2.44, 2.6, 6.1, cols[i % 4], true, E(r() * 0.3, r() * 1.2, r() * 0.4));
  kit.pop();
}

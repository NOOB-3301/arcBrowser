import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import type { NavGrid } from '../ai/NavGrid';
import type { Bot } from '../ai/Bot';
import type { MapInfo } from '../world/World';
import type { PoiDef } from '../world/MapDef';
import { Grid } from './Inventory';
import type { ItemStack } from './Items';
import { ARC_TABLES, containerTable, raiderDrop, rollTable, type ContainerType } from './LootTables';

// ================================================================ meshes

const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(key: string, color: string, rough = 0.7, metal = 0.2, emissive?: string): THREE.MeshStandardMaterial {
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    if (emissive) {
      m.emissive.set(emissive);
      m.emissiveIntensity = 1.6;
    }
    mats.set(key, m);
  }
  return m;
}

function box(g: THREE.Group, w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

/** Footprint half extents (x, y, z) for colliders, per type. */
const SIZE: Record<ContainerType, [number, number, number]> = {
  crate: [0.55, 0.33, 0.4],
  locker: [0.42, 0.95, 0.3],
  medcab: [0.35, 0.55, 0.22],
  toolbox: [0.4, 0.4, 0.3],
  wreck: [0.8, 0.35, 0.7],
  body: [0.4, 0.2, 0.4],
  cache: [0.5, 0.9, 0.35],
  drop: [0.35, 0.2, 0.25],
};

/**
 * Placeholder PBR meshes for every container type. Single factory so final
 * art can be swapped in one place. Origin = floor centre, front faces +Z.
 * `userData.status` is the indicator light material (per instance).
 */
export function containerMesh(type: ContainerType): THREE.Group {
  const g = new THREE.Group();
  g.name = `container-${type}`;
  const light = new THREE.MeshStandardMaterial({ color: '#221a10', emissive: '#ff9a2a', emissiveIntensity: 2.2 });
  g.userData.status = light;
  switch (type) {
    case 'crate': {
      const body = mat('crate', '#5d6b3c', 0.8, 0.15);
      const trim = mat('crate-trim', '#2d3222', 0.6, 0.5);
      box(g, 1.1, 0.56, 0.8, body);
      box(g, 1.14, 0.1, 0.84, trim, 0, 0.56);
      box(g, 0.08, 0.5, 0.82, trim, -0.35, 0.03);
      box(g, 0.08, 0.5, 0.82, trim, 0.35, 0.03);
      box(g, 0.14, 0.05, 0.06, light, 0, 0.46, 0.41);
      break;
    }
    case 'locker': {
      const body = mat('locker', '#4b5a66', 0.45, 0.7);
      const dark = mat('locker-dark', '#232a30', 0.5, 0.6);
      box(g, 0.84, 1.9, 0.6, body);
      box(g, 0.02, 1.7, 0.02, dark, 0, 0.1, 0.305);
      for (let i = 0; i < 4; i++) box(g, 0.3, 0.02, 0.02, dark, -0.2, 1.5 + i * 0.06, 0.305);
      box(g, 0.05, 0.12, 0.04, light, 0.3, 1.0, 0.31);
      break;
    }
    case 'medcab': {
      const body = mat('medcab', '#d8d8d2', 0.5, 0.1);
      const red = mat('medcab-red', '#c42a22', 0.5, 0.1);
      box(g, 0.7, 1.1, 0.44, body);
      box(g, 0.3, 0.08, 0.02, red, 0, 0.72, 0.225);
      box(g, 0.08, 0.3, 0.02, red, 0, 0.61, 0.225);
      box(g, 0.1, 0.05, 0.03, light, 0.25, 1.0, 0.23);
      break;
    }
    case 'toolbox': {
      const bench = mat('bench', '#5a4632', 0.85, 0.05);
      const red = mat('toolbox', '#a8321f', 0.4, 0.5);
      box(g, 0.8, 0.5, 0.6, bench);
      box(g, 0.6, 0.26, 0.32, red, 0, 0.5);
      box(g, 0.3, 0.06, 0.04, mat('toolbox-h', '#222', 0.4, 0.8), 0, 0.76);
      box(g, 0.1, 0.05, 0.03, light, 0.22, 0.6, 0.17);
      break;
    }
    case 'wreck': {
      const hull = mat('arc-hull', '#3a3d42', 0.35, 0.85);
      const burnt = mat('arc-burnt', '#1c1c1e', 0.9, 0.4);
      const b1 = box(g, 1.2, 0.45, 0.8, hull);
      b1.rotation.set(0.15, 0.3, -0.12);
      const b2 = box(g, 0.6, 0.3, 0.5, burnt, 0.7, 0, -0.3);
      b2.rotation.set(0, -0.6, 0.3);
      const b3 = box(g, 0.12, 0.12, 0.9, hull, -0.5, 0.05, 0.4);
      b3.rotation.set(0.4, 0.8, 0);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), light);
      eye.position.set(-0.25, 0.5, 0.25);
      g.add(eye);
      break;
    }
    case 'cache': {
      const body = mat('cache', '#26292c', 0.4, 0.8);
      const stripe = mat('cache-stripe', '#e0b12a', 0.5, 0.2);
      box(g, 1.0, 1.8, 0.7, body);
      box(g, 1.02, 0.1, 0.72, stripe, 0, 1.45);
      box(g, 1.02, 0.1, 0.72, stripe, 0, 0.3);
      box(g, 0.16, 0.22, 0.04, light, 0.3, 0.95, 0.36);
      break;
    }
    case 'drop': {
      const bag = mat('bag', '#39402e', 0.95, 0);
      box(g, 0.7, 0.36, 0.45, bag);
      box(g, 0.5, 0.06, 0.3, mat('bag-strap', '#1d2016', 0.9, 0), 0, 0.36);
      box(g, 0.06, 0.06, 0.06, light, 0, 0.42);
      break;
    }
    case 'body':
      // Corpses use the bot's own model; only an indicator light.
      box(g, 0.1, 0.1, 0.1, light, 0, 1.0);
      break;
  }
  return g;
}

// ================================================================ containers

const NAMES: Record<ContainerType, string> = {
  crate: 'Supply Crate', locker: 'Weapon Locker', medcab: 'Med Cabinet', toolbox: 'Tool Box',
  wreck: 'ARC Wreck', body: 'Body', cache: 'Security Locker', drop: 'Dropped Bag',
};
const GRID: Record<ContainerType, [number, number]> = {
  crate: [5, 4], locker: [6, 4], medcab: [4, 3], toolbox: [4, 3], wreck: [5, 4], body: [6, 4], cache: [6, 4], drop: [6, 5],
};
const SEARCH_TIME: Record<ContainerType, number> = {
  crate: 1.6, locker: 2.4, medcab: 1.2, toolbox: 1.8, wreck: 2.2, body: 1.4, cache: 3, drop: 0.5,
};

let nextId = 1;

export class LootContainer {
  readonly id = nextId++;
  readonly grid: Grid;
  searched = false;
  name: string;
  /** Required key item to open (security lockers). */
  lockedBy: string | null = null;
  collider: RAPIER.Collider | null = null;
  private pending: (() => ItemStack[]) | null;

  constructor(
    readonly type: ContainerType,
    readonly pos: THREE.Vector3,
    loot: () => ItemStack[],
    readonly mesh: THREE.Group | null,
    readonly bot: Bot | null = null,
  ) {
    this.name = NAMES[type];
    const [w, h] = GRID[type];
    this.grid = new Grid(w, h, this.name);
    this.pending = loot;
  }

  get searchTime(): number {
    return SEARCH_TIME[this.type];
  }

  /** Radius used for look-at picking. */
  get radius(): number {
    const s = SIZE[this.type];
    return Math.max(0.45, Math.hypot(s[0], s[2]));
  }

  /** Point used for aim picking (a bit above the floor). */
  focus(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos).setY(this.pos.y + Math.min(0.9, SIZE[this.type][1] * 1.4));
  }

  /** Roll loot the first time the container is opened. */
  open(): void {
    if (this.pending) {
      for (const s of this.pending()) this.grid.add(s);
      this.pending = null;
    }
    this.searched = true;
    this.refreshLight();
  }

  refreshLight(): void {
    const m = this.mesh?.userData.status as THREE.MeshStandardMaterial | undefined;
    if (!m) return;
    const empty = this.searched && this.grid.items.length === 0;
    m.emissive.set(!this.searched ? (this.lockedBy ? '#ff3a2a' : '#ff9a2a') : empty ? '#000000' : '#5cffb0');
    m.emissiveIntensity = empty ? 0 : 2.2;
  }
}

// ================================================================ manager

const UP = new THREE.Vector3(0, 1, 0);
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Owns every lootable container in the raid: world placements, bodies, drops. */
export class ContainerManager {
  readonly list: LootContainer[] = [];

  constructor(private scene: THREE.Scene, private physics: Physics) {}

  /** Procedural placement around every POI (count by tier) plus scattered ARC wrecks. */
  populate(map: MapInfo, nav: NavGrid): void {
    const placed: THREE.Vector3[] = [];
    for (const poi of map.def.pois) this.placeForPoi(poi, nav, placed);
    // A few lone ARC wrecks along the valley floor
    const half = map.hm.half * 0.8;
    let wrecks = 0;
    for (let i = 0; i < 80 && wrecks < 8; i++) {
      const x = (Math.random() * 2 - 1) * half;
      const z = (Math.random() * 2 - 1) * half;
      if (map.def.pois.some((p) => Math.hypot(p.center[0] - x, p.center[1] - z) < p.radius)) continue;
      const p = nav.nearestWalkable(x, z, 4);
      if (!p || placed.some((q) => q.distanceTo(p) < 30)) continue;
      this.add('wreck', p, Math.random() * Math.PI * 2, 2);
      placed.push(p);
      wrecks++;
    }
  }

  private placeForPoi(poi: PoiDef, nav: NavGrid, placed: THREE.Vector3[]): void {
    const tier = poi.tier;
    const [lo, hi] = tier >= 3 ? [11, 15] : tier === 2 ? [8, 11] : [6, 8];
    const want = lo + Math.floor(Math.random() * (hi - lo + 1));
    const r = Math.min(poi.radius * 0.85, 110);
    const cands: { p: THREE.Vector3; score: number; yaw: number }[] = [];
    for (let i = 0; i < want * 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r;
      const p = nav.nearestWalkable(poi.center[0] + Math.cos(a) * d, poi.center[1] + Math.sin(a) * d, 3);
      if (!p) continue;
      // Open side = direction with walkable room; wall = a blocked neighbour
      let wall: [number, number] | null = null;
      let openCount = 0;
      for (const [dx, dz] of DIRS) {
        const blocked = !nav.walkable(p.x + dx * 1.1, p.z + dz * 1.1) || Math.abs(nav.floorAt(p.x + dx * 1.1, p.z + dz * 1.1) - p.y) > 0.6;
        if (blocked) wall = [dx, dz];
        else if (nav.walkable(p.x + dx * 2.2, p.z + dz * 2.2)) openCount++;
      }
      if (openCount < 2) continue; // don't plug corridors / doorways
      const indoor = this.physics.raycast(p.clone().addScaledVector(UP, 0.4), UP, 14) !== null;
      const score = (indoor ? 2 : 0) + (wall ? 1.5 : 0) + Math.random();
      const yaw = wall ? Math.atan2(-wall[0], -wall[1]) : Math.random() * Math.PI * 2;
      if (wall) p.add(new THREE.Vector3(wall[0] * 0.25, 0, wall[1] * 0.25));
      cands.push({ p, score, yaw });
    }
    cands.sort((a, b) => b.score - a.score);
    let n = 0;
    for (const c of cands) {
      if (n >= want) break;
      if (placed.some((q) => q.distanceTo(c.p) < 4)) continue;
      const roll = Math.random();
      const type: ContainerType =
        roll < 0.42 ? 'crate' : roll < 0.6 ? 'toolbox' : roll < 0.76 ? 'medcab' : roll < 0.93 ? 'locker' : tier >= 2 ? 'cache' : 'crate';
      const cont = this.add(type, c.p, c.yaw, tier);
      if (type === 'cache') cont.lockedBy = 'keycard';
      cont.refreshLight();
      placed.push(c.p);
      n++;
    }
  }

  /** World container with a mesh + static collider. */
  add(type: ContainerType, pos: THREE.Vector3, yaw: number, tier: number, loot?: () => ItemStack[]): LootContainer {
    const mesh = containerMesh(type);
    mesh.position.copy(pos);
    mesh.rotation.y = yaw;
    this.scene.add(mesh);
    const c = new LootContainer(type, pos.clone(), loot ?? (() => rollTable(containerTable(type, tier))), mesh);
    if (type !== 'drop' && type !== 'wreck') {
      const s = SIZE[type];
      const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
      c.collider = this.physics.addStaticBox(pos.clone().setY(pos.y + s[1]), new THREE.Vector3(s[0], s[1], s[2]), q);
    }
    c.refreshLight();
    this.list.push(c);
    return c;
  }

  /** A dead bot becomes a lootable body / wreck. */
  addBody(bot: Bot, heightAt: (x: number, z: number) => number): LootContainer {
    let loot: () => ItemStack[];
    let name: string;
    if (bot.kind === 'raider') {
      const w = (bot as unknown as { weapon?: { def: { id: string }; rarity: import('../weapons/WeaponDefs').Rarity } }).weapon;
      loot = () => raiderDrop(w?.def.id, w?.rarity);
      name = 'Raider';
    } else {
      const table = ARC_TABLES[bot.kind] ?? ARC_TABLES.tick;
      loot = () => rollTable(table);
      name = `${bot.kind[0].toUpperCase()}${bot.kind.slice(1)} Wreck`;
    }
    const ground = bot.pos.clone();
    if (bot.kind === 'tick') ground.y = heightAt(ground.x, ground.z);
    let c: LootContainer;
    if (bot.kind === 'tick') {
      // Ticks are cleaned up quickly; leave a wreck mesh instead
      c = this.add('wreck', ground, Math.random() * 6, 1, loot);
    } else {
      const mesh = containerMesh('body');
      this.scene.add(mesh);
      c = new LootContainer('body', ground, loot, mesh, bot);
      (bot as { lootPinned?: boolean }).lootPinned = true; // AIDirector keeps the corpse
      this.list.push(c);
    }
    c.name = name;
    c.refreshLight();
    return c;
  }

  /** Items dropped from the inventory mid-raid. */
  drop(pos: THREE.Vector3, items: ItemStack[]): LootContainer {
    // Merge into an existing nearby bag
    const near = this.list.find((c) => c.type === 'drop' && c.pos.distanceTo(pos) < 1.5);
    const c = near ?? this.add('drop', pos, Math.random() * 6, 1, () => []);
    c.open();
    for (const s of items) c.grid.add(s);
    c.refreshLight();
    return c;
  }

  /** Bodies follow their (falling) corpse. */
  update(): void {
    for (const c of this.list) {
      if (!c.bot) continue;
      if (!c.bot.removed) c.pos.copy(c.bot.pos);
      if (c.mesh) c.mesh.position.copy(c.pos);
    }
  }

  /**
   * Container the player is looking at: within reach of the player and closest
   * to the camera's view ray.
   */
  pick(feet: THREE.Vector3, camPos: THREE.Vector3, camDir: THREE.Vector3, reach = 2.5): LootContainer | null {
    let best: LootContainer | null = null;
    let bestScore = Infinity;
    const f = new THREE.Vector3();
    const to = new THREE.Vector3();
    for (const c of this.list) {
      const flat = Math.hypot(c.pos.x - feet.x, c.pos.z - feet.z);
      if (flat > reach + c.radius * 0.5 || Math.abs(c.pos.y - feet.y) > 2) continue;
      c.focus(f);
      to.copy(f).sub(camPos);
      const along = to.dot(camDir);
      if (along < 0) continue;
      const perp = Math.sqrt(Math.max(0, to.lengthSq() - along * along));
      // Accept if the ray passes near it, or the player is right on top of it
      if (perp > c.radius + 0.9 && flat > 1.2) continue;
      const score = perp + flat * 0.3;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  remove(c: LootContainer): void {
    const i = this.list.indexOf(c);
    if (i >= 0) this.list.splice(i, 1);
    if (c.mesh) this.scene.remove(c.mesh);
    if (c.collider) this.physics.world.removeRigidBody(c.collider.parent()!);
    if (c.bot) (c.bot as { lootPinned?: boolean }).lootPinned = false;
  }

  clear(): void {
    for (const c of [...this.list]) this.remove(c);
  }
}

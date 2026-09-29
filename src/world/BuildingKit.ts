import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, Groups, interactionGroups, type Physics } from '../physics/Physics';
import { triplanarMaterial } from './Materials';

export type KitMat =
  | 'concrete' | 'plaster' | 'brick' | 'metal' | 'rust' | 'roof' | 'wood' | 'dark' | 'asphalt'
  | 'crate' | 'cRed' | 'cBlue' | 'cGreen' | 'cYellow' | 'cGrey' | 'hazard';

let MATS: Record<KitMat, THREE.Material> | null = null;
function mats(): Record<KitMat, THREE.Material> {
  if (MATS) return MATS;
  MATS = {
    concrete: triplanarMaterial('concrete_wall_008', { scale: 5, color: '#ffffff', gain: 1.25 }),
    plaster: triplanarMaterial('plastered_wall_02', { scale: 4, color: '#f2e6d0', gain: 1.15 }),
    brick: triplanarMaterial('red_brick_03', { scale: 2.5, color: '#ffffff', gain: 1.2 }),
    metal: triplanarMaterial('corrugated_iron', { scale: 2.5, color: '#b9bcbf', metalness: 0.4, roughness: 0.6 }),
    rust: triplanarMaterial('rusty_metal_02', { scale: 3, color: '#ffffff', metalness: 0.3, roughness: 0.75 }),
    roof: triplanarMaterial('corrugated_iron', { scale: 2, color: '#8a4b3a', metalness: 0.3, roughness: 0.7 }),
    wood: new THREE.MeshStandardMaterial({ color: '#6d5238', roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: '#2d2f31', roughness: 0.7, metalness: 0.4 }),
    asphalt: triplanarMaterial('asphalt_02', { scale: 5, color: '#9a9a9a' }),
    crate: new THREE.MeshStandardMaterial({ color: '#7c6a3e', roughness: 0.85 }),
    cRed: triplanarMaterial('rusty_metal_02', { scale: 3, color: '#c0503a', metalness: 0.3, roughness: 0.7 }),
    cBlue: triplanarMaterial('rusty_metal_02', { scale: 3, color: '#4f7aa8', metalness: 0.3, roughness: 0.7 }),
    cGreen: triplanarMaterial('rusty_metal_02', { scale: 3, color: '#5e8a55', metalness: 0.3, roughness: 0.7 }),
    cYellow: triplanarMaterial('rusty_metal_02', { scale: 3, color: '#d6a93a', metalness: 0.3, roughness: 0.7 }),
    cGrey: triplanarMaterial('rusty_metal_02', { scale: 3, color: '#9aa0a4', metalness: 0.3, roughness: 0.7 }),
    hazard: new THREE.MeshStandardMaterial({ color: '#e0b020', roughness: 0.6 }),
  };
  return MATS;
}

export interface Opening {
  /** Centre along the wall (m from wall start). */
  at: number;
  w: number;
  y0: number;
  y1: number;
}

export interface BuildingSpec {
  w: number;
  d: number;
  floors: number;
  floorH?: number;
  wall?: KitMat;
  roof?: 'flat' | 'gable' | 'none';
  /** Sides with a ground-floor door: 0 N(-z) 1 E(+x) 2 S(+z) 3 W(-x). */
  doors?: number[];
  windows?: boolean;
  stairs?: boolean;
  /** Missing roof + wall chunks + rubble. */
  ruined?: boolean;
  seed?: number;
}

const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Accumulates boxes/cylinders in a transform stack, then merges geometry per
 * material (a handful of draw calls per POI) and creates static cuboid colliders.
 */
export class Kit {
  private parts = new Map<KitMat, THREE.BufferGeometry[]>();
  private colliders: { pos: THREE.Vector3; half: THREE.Vector3; rot: THREE.Quaternion; cyl?: { r: number; h: number } }[] = [];
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private rand: () => number;

  constructor(seed = 1) {
    let a = seed >>> 0 || 1;
    this.rand = () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
  }

  get random(): () => number {
    return this.rand;
  }

  // ---------------------------------------------------------------- transforms

  push(x: number, y: number, z: number, rotY = 0): void {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(1, 1, 1));
    this.stack.push(this.top.clone().multiply(m));
  }
  pop(): void {
    if (this.stack.length > 1) this.stack.pop();
  }
  private get top(): THREE.Matrix4 {
    return this.stack[this.stack.length - 1];
  }

  // ---------------------------------------------------------------- primitives

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: KitMat, collide = true, rot?: THREE.Euler): void {
    if (sx <= 0.01 || sy <= 0.01 || sz <= 0.01) return;
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const local = new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), rot ? new THREE.Quaternion().setFromEuler(rot) : new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    const world = this.top.clone().multiply(local);
    g.applyMatrix4(world);
    this.add(mat, g);
    if (collide) {
      world.decompose(_p, _q, _s);
      this.colliders.push({ pos: _p.clone(), half: new THREE.Vector3(sx / 2, sy / 2, sz / 2), rot: _q.clone() });
    }
  }

  cylinder(cx: number, cy: number, cz: number, r: number, h: number, mat: KitMat, collide = true, rot?: THREE.Euler, segs = 12): void {
    const g = new THREE.CylinderGeometry(r, r, h, segs);
    const local = new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), rot ? new THREE.Quaternion().setFromEuler(rot) : new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    const world = this.top.clone().multiply(local);
    g.applyMatrix4(world);
    // Drop UVs so cylinders merge with boxes (triplanar materials don't need them)
    this.add(mat, g);
    if (collide) {
      world.decompose(_p, _q, _s);
      this.colliders.push({ pos: _p.clone(), half: new THREE.Vector3(), rot: _q.clone(), cyl: { r, h } });
    }
  }

  /**
   * Wall from local (x0,z0) to (x1,z1) starting at height y, split around openings.
   */
  wall(x0: number, z0: number, x1: number, z1: number, y: number, h: number, t: number, mat: KitMat, openings: Opening[] = []): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ang = Math.atan2(-(z1 - z0), x1 - x0);
    this.push((x0 + x1) / 2, y, (z0 + z1) / 2, ang);
    const ops = [...openings].sort((a, b) => a.at - b.at);
    let cursor = -len / 2;
    for (const o of ops) {
      const a = o.at - len / 2 - o.w / 2;
      const b = o.at - len / 2 + o.w / 2;
      if (a > cursor) this.box((cursor + a) / 2, h / 2, 0, a - cursor, h, t, mat);
      if (o.y0 > 0) this.box((a + b) / 2, o.y0 / 2, 0, b - a, o.y0, t, mat);
      if (o.y1 < h) this.box((a + b) / 2, (o.y1 + h) / 2, 0, b - a, h - o.y1, t, mat);
      cursor = Math.max(cursor, b);
    }
    if (cursor < len / 2) this.box((cursor + len / 2) / 2, h / 2, 0, len / 2 - cursor, h, t, mat);
    this.pop();
  }

  /** Straight flight of steps rising along +z from (x, y, z). */
  stairs(x: number, y: number, z: number, width: number, rise: number, mat: KitMat): void {
    const steps = Math.round(rise / 0.2);
    const sh = rise / steps;
    const run = 0.3;
    for (let i = 0; i < steps; i++) this.box(x, y + sh * (i + 0.5), z + run * (i + 0.5), width, sh, run, mat);
    // Solid stringer underneath for silhouette
    this.box(x, y + rise / 4, z + (steps * run) / 2, width * 0.98, rise / 2, steps * run * 0.98, mat, false);
  }

  /** Multi-storey enterable building centred on local origin, ground at y=0. */
  building(s: BuildingSpec): void {
    const r = this.rand;
    const fh = s.floorH ?? 3.2;
    const t = 0.25;
    const wall = s.wall ?? 'plaster';
    const { w, d } = s;
    const doors = s.doors ?? [2];
    const stairsOn = (s.stairs ?? true) && s.floors > 1 && d >= 6.5;
    const stairW = 1.2;
    const run = (fh / 0.2) * 0.3;
    const sx = w / 2 - t - stairW / 2 - 0.05; // stair column x
    const sz0 = -d / 2 + t + 0.4; // stair start z

    // Foundation sinks into slopes
    this.box(0, -1.2, 0, w + 0.5, 2.6, d + 0.5, 'concrete');

    for (let f = 0; f < s.floors; f++) {
      const y = f * fh;
      const ruinedTop = s.ruined && f === s.floors - 1;
      const sides: [number, number, number, number, number][] = [
        [-w / 2, -d / 2, w / 2, -d / 2, 0],
        [w / 2, -d / 2, w / 2, d / 2, 1],
        [w / 2, d / 2, -w / 2, d / 2, 2],
        [-w / 2, d / 2, -w / 2, -d / 2, 3],
      ];
      for (const [x0, z0, x1, z1, side] of sides) {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const ops: Opening[] = [];
        if (f === 0 && doors.includes(side)) ops.push({ at: len / 2, w: 1.4, y0: 0, y1: 2.4 });
        if (s.windows !== false) {
          const count = Math.floor(len / 3.2);
          for (let k = 0; k < count; k++) {
            const at = (len / count) * (k + 0.5);
            if (ops.some((o) => Math.abs(o.at - at) < 1.6)) continue;
            ops.push({ at, w: 1.1, y0: 1.0, y1: 2.2 });
          }
        }
        let h = fh;
        if (ruinedTop && r() < 0.5) {
          h = fh * (0.3 + r() * 0.5);
          ops.forEach((o) => (o.y1 = Math.min(o.y1, h)));
        }
        this.wall(x0, z0, x1, z1, y, h, t, wall, ops.filter((o) => o.y0 < h));
      }

      // Floor slab (upper floors) with stairwell hole over the flight from below
      if (f > 0) this.slabWithHole(w, d, y, stairsOn ? { x0: sx - stairW / 2 - 0.1, x1: sx + stairW / 2 + 0.1, z0: sz0 - 0.1, z1: sz0 + run + 0.2 } : null);
      else this.box(0, 0.05, 0, w - 0.1, 0.1, d - 0.1, 'concrete');

      if (stairsOn && f < s.floors - 1) this.stairs(sx, y, sz0, stairW, fh, 'concrete');
      if (stairsOn && f < s.floors - 1) {
        // Railing along the open side of the stairwell above
        this.box(sx - stairW / 2 - 0.12, y + fh + 0.5, sz0 + run / 2, 0.06, 1, run, 'dark');
      }
    }

    const top = s.floors * fh;
    if (s.ruined) {
      // Partial roof + rubble
      this.box(-w / 4, top + 0.1, -d / 4, w / 2, 0.2, d / 2, 'concrete');
      for (let i = 0; i < 6; i++) {
        this.box((r() - 0.5) * w * 0.8, 0.3 + r() * 0.4, (r() - 0.5) * d * 0.8, 0.6 + r() * 1.2, 0.5 + r() * 0.6, 0.6 + r() * 1.2, 'concrete', true, new THREE.Euler(r(), r() * 3, r()));
      }
    } else if (s.roof === 'gable') {
      const pitch = 0.5;
      const half = d / 2 + 0.4;
      const len = half / Math.cos(pitch);
      const rise = Math.tan(pitch) * half;
      this.box(0, top + rise / 2, -half / 2, w + 0.6, 0.18, len, 'roof', true, new THREE.Euler(pitch, 0, 0));
      this.box(0, top + rise / 2, half / 2, w + 0.6, 0.18, len, 'roof', true, new THREE.Euler(-pitch, 0, 0));
      // Gable ends: stepped triangle
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          this.box(side * (w / 2 - t / 2), top + (rise * (k + 0.5)) / 4, 0, t, rise / 4, d * (1 - (k + 0.5) / 4), wall, false);
        }
      }
      this.box(0, top + 0.05, 0, w, 0.1, d, 'concrete');
    } else if (s.roof !== 'none') {
      this.slabWithHole(w, d, top, stairsOn ? { x0: sx - stairW / 2 - 0.1, x1: sx + stairW / 2 + 0.1, z0: sz0 - 0.1, z1: sz0 + run + 0.2 } : null);
      // Parapet
      for (const [x0, z0, x1, z1] of [[-w / 2, -d / 2, w / 2, -d / 2], [w / 2, -d / 2, w / 2, d / 2], [w / 2, d / 2, -w / 2, d / 2], [-w / 2, d / 2, -w / 2, -d / 2]]) {
        this.wall(x0, z0, x1, z1, top, 0.9, 0.2, wall);
      }
    }
    // Roof access stairs from the top floor
    if (stairsOn && s.roof === 'flat' && !s.ruined) this.stairs(sx, top - fh, sz0, stairW, fh, 'concrete');
  }

  private slabWithHole(w: number, d: number, y: number, hole: { x0: number; x1: number; z0: number; z1: number } | null): void {
    const th = 0.25;
    const cy = y - th / 2 + 0.02;
    if (!hole) {
      this.box(0, cy, 0, w, th, d, 'concrete');
      return;
    }
    const X0 = -w / 2;
    const X1 = w / 2;
    const Z0 = -d / 2;
    const Z1 = d / 2;
    // Four rectangles around the hole
    this.box((X0 + hole.x0) / 2, cy, 0, hole.x0 - X0, th, d, 'concrete');
    this.box((hole.x1 + X1) / 2, cy, 0, X1 - hole.x1, th, d, 'concrete');
    this.box((hole.x0 + hole.x1) / 2, cy, (Z0 + hole.z0) / 2, hole.x1 - hole.x0, th, hole.z0 - Z0, 'concrete');
    this.box((hole.x0 + hole.x1) / 2, cy, (hole.z1 + Z1) / 2, hole.x1 - hole.x0, th, Z1 - hole.z1, 'concrete');
  }

  // ---------------------------------------------------------------- finalize

  private add(mat: KitMat, g: THREE.BufferGeometry): void {
    g.deleteAttribute('uv');
    const ng = g.index ? g.toNonIndexed() : g;
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(ng);
  }

  /** Merge into meshes + build colliders. Returns the group for culling. */
  build(scene: THREE.Scene, physics: Physics, castShadow = true): THREE.Group {
    const group = new THREE.Group();
    const M = mats();
    for (const [mat, geos] of this.parts) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, M[mat]);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    scene.add(group);

    if (this.colliders.length) {
      const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const groups = interactionGroups(Groups.WORLD, 0xffff);
      for (const c of this.colliders) {
        const desc = c.cyl ? RAPIER.ColliderDesc.cylinder(c.cyl.h / 2, c.cyl.r) : RAPIER.ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z);
        desc.setTranslation(c.pos.x, c.pos.y, c.pos.z).setRotation({ x: c.rot.x, y: c.rot.y, z: c.rot.z, w: c.rot.w }).setCollisionGroups(groups);
        physics.world.createCollider(desc, body);
      }
    }
    this.parts.clear();
    this.colliders = [];
    return group;
  }
}

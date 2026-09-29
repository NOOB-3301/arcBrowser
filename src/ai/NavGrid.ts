import * as THREE from 'three';
import { NavObstacles } from './NavObstacles';

const COARSE = 8; // fine cells per coarse cell
const AGENT_PAD = 0.3;
const STEP_UP = 0.5;
const HEAD = 1.8;
const MAX_WINDOW = 320;

export interface NavSource {
  size: number;
  heightAt(x: number, z: number): number;
  /** True where terrain is too steep or deep water. */
  blockedTerrain?(x: number, z: number): boolean;
}

/** Binary min-heap keyed by f-score. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  clear(): void {
    this.items.length = 0;
    this.keys.length = 0;
  }
  push(item: number, key: number): void {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const lastI = a.pop()!;
    const lastK = k.pop()!;
    if (a.length) {
      a[0] = lastI;
      k[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Walkability grid (1 m cells) for ground AI. Floors are the highest steppable
 * surface per cell; walls/trees/rocks that intersect the body band block.
 * Short paths: windowed A* on the fine grid. Long paths: A* on an 8 m coarse grid.
 */
export class NavGrid {
  readonly n: number;
  readonly half: number;
  readonly walk: Uint8Array;
  readonly floor: Float32Array;
  private cn: number;
  private coarse: Uint8Array;
  private heap = new Heap();
  private g = new Float32Array(MAX_WINDOW * MAX_WINDOW);
  private parent = new Int32Array(MAX_WINDOW * MAX_WINDOW);
  private stamp = new Uint32Array(MAX_WINDOW * MAX_WINDOW);
  private closed = new Uint32Array(MAX_WINDOW * MAX_WINDOW);
  private gen = 1;
  buildMs = 0;

  constructor(private src: NavSource) {
    const t0 = performance.now();
    this.n = Math.round(src.size);
    this.half = src.size / 2;
    const N = this.n * this.n;
    this.walk = new Uint8Array(N);
    this.floor = new Float32Array(N);
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) {
        const x = ix + 0.5 - this.half;
        const z = iz + 0.5 - this.half;
        const i = iz * this.n + ix;
        this.floor[i] = src.heightAt(x, z);
        const edge = ix < 12 || iz < 12 || ix >= this.n - 12 || iz >= this.n - 12;
        this.walk[i] = edge || src.blockedTerrain?.(x, z) ? 0 : 1;
      }
    }
    this.rasterize();
    this.cn = Math.ceil(this.n / COARSE);
    this.coarse = new Uint8Array(this.cn * this.cn);
    for (let cz = 0; cz < this.cn; cz++) {
      for (let cx = 0; cx < this.cn; cx++) {
        let w = 0;
        let t = 0;
        for (let z = cz * COARSE; z < Math.min(this.n, (cz + 1) * COARSE); z++) {
          for (let x = cx * COARSE; x < Math.min(this.n, (cx + 1) * COARSE); x++) {
            w += this.walk[z * this.n + x];
            t++;
          }
        }
        this.coarse[cz * this.cn + cx] = w / t > 0.45 ? 1 : 0;
      }
    }
    this.buildMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- build

  private rasterize(): void {
    const n = this.n;
    const m = new THREE.Matrix4();
    const inv = new THREE.Matrix4();
    const local = new THREE.Vector3();
    // Pass 1: raise floors onto low, flat-topped boxes (foundations, slabs, pads)
    // Pass 2: block cells whose body band intersects a box/cylinder
    for (const pass of [1, 2]) {
      for (const o of NavObstacles.list) {
        if (o.kind === 'cyl') {
          if (pass === 1) continue;
          const r = o.r + AGENT_PAD;
          for (let iz = Math.floor(o.z - r + this.half); iz <= Math.ceil(o.z + r + this.half); iz++) {
            for (let ix = Math.floor(o.x - r + this.half); ix <= Math.ceil(o.x + r + this.half); ix++) {
              if (ix < 0 || iz < 0 || ix >= n || iz >= n) continue;
              const cx = ix + 0.5 - this.half;
              const cz = iz + 0.5 - this.half;
              if ((cx - o.x) ** 2 + (cz - o.z) ** 2 > r * r) continue;
              const i = iz * n + ix;
              const f = this.floor[i];
              if (o.y1 > f + STEP_UP && o.y0 < f + HEAD) this.walk[i] = 0;
            }
          }
          continue;
        }
        m.compose(o.pos, o.rot, new THREE.Vector3(1, 1, 1));
        inv.copy(m).invert();
        const e = m.elements;
        // World-space half extents (AABB of the OBB)
        const ex = Math.abs(e[0]) * o.half.x + Math.abs(e[4]) * o.half.y + Math.abs(e[8]) * o.half.z;
        const ey = Math.abs(e[1]) * o.half.x + Math.abs(e[5]) * o.half.y + Math.abs(e[9]) * o.half.z;
        const ez = Math.abs(e[2]) * o.half.x + Math.abs(e[6]) * o.half.y + Math.abs(e[10]) * o.half.z;
        const top = o.pos.y + ey;
        const bottom = o.pos.y - ey;
        const flat = Math.abs(e[5]) > 0.97; // box's local Y is up → walkable top
        const pad = pass === 2 ? AGENT_PAD : 0;
        const x0 = Math.max(0, Math.floor(o.pos.x - ex - pad + this.half));
        const x1 = Math.min(n - 1, Math.ceil(o.pos.x + ex + pad + this.half));
        const z0 = Math.max(0, Math.floor(o.pos.z - ez - pad + this.half));
        const z1 = Math.min(n - 1, Math.ceil(o.pos.z + ez + pad + this.half));
        for (let iz = z0; iz <= z1; iz++) {
          for (let ix = x0; ix <= x1; ix++) {
            local.set(ix + 0.5 - this.half, o.pos.y, iz + 0.5 - this.half).applyMatrix4(inv);
            if (Math.abs(local.x) > o.half.x + pad || Math.abs(local.z) > o.half.z + pad) continue;
            const i = iz * n + ix;
            const f = this.floor[i];
            if (pass === 1) {
              if (flat && top > f && top < f + STEP_UP + 0.9 && o.half.x > 0.6 && o.half.z > 0.6) this.floor[i] = top;
            } else if (top > f + STEP_UP && bottom < f + HEAD) {
              this.walk[i] = 0;
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- queries

  cellOf(x: number, z: number): [number, number] {
    return [Math.floor(x + this.half), Math.floor(z + this.half)];
  }

  walkable(x: number, z: number): boolean {
    const [ix, iz] = this.cellOf(x, z);
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return false;
    return this.walk[iz * this.n + ix] === 1;
  }

  floorAt(x: number, z: number): number {
    const [ix, iz] = this.cellOf(x, z);
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return this.src.heightAt(x, z);
    return this.floor[iz * this.n + ix];
  }

  /** Nearest walkable point within `radius` metres (spiral search), or null. */
  nearestWalkable(x: number, z: number, radius = 8): THREE.Vector3 | null {
    const [cx, cz] = this.cellOf(x, z);
    for (let r = 0; r <= radius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx;
          const iz = cz + dz;
          if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) continue;
          const i = iz * this.n + ix;
          if (this.walk[i]) return new THREE.Vector3(ix + 0.5 - this.half, this.floor[i], iz + 0.5 - this.half);
        }
      }
    }
    return null;
  }

  /** Grid line of sight over walkable cells (supercover DDA). */
  lineWalkable(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / 0.5);
    let prevFloor = this.floorAt(ax, az);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + dx * t;
      const z = az + dz * t;
      if (!this.walkable(x, z)) return false;
      const f = this.floorAt(x, z);
      if (Math.abs(f - prevFloor) > 0.9) return false; // ledge
      prevFloor = f;
    }
    return true;
  }

  /**
   * Path from a to b as world waypoints (smoothed), or null if unreachable.
   * Long trips route over the coarse grid; followers refine legs as they go.
   */
  findPath(a: THREE.Vector3, b: THREE.Vector3, maxExpand = 60000): THREE.Vector3[] | null {
    const start = this.walkable(a.x, a.z) ? a.clone() : this.nearestWalkable(a.x, a.z, 4);
    const goal = this.walkable(b.x, b.z) ? b.clone() : this.nearestWalkable(b.x, b.z, 10);
    if (!start || !goal) return null;
    const dist = Math.hypot(goal.x - start.x, goal.z - start.z);
    if (dist < 1.5) return [goal];
    if (this.lineWalkable(start.x, start.z, goal.x, goal.z)) return [this.withFloor(goal)];
    if (dist < MAX_WINDOW / 2 - 30) {
      const fine = this.fineAStar(start, goal, maxExpand);
      if (fine) return fine;
    }
    return this.coarseAStar(start, goal);
  }

  private withFloor(p: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(p.x, this.floorAt(p.x, p.z), p.z);
  }

  private fineAStar(a: THREE.Vector3, b: THREE.Vector3, maxExpand: number): THREE.Vector3[] | null {
    const n = this.n;
    const [sx, sz] = this.cellOf(a.x, a.z);
    const [gx, gz] = this.cellOf(b.x, b.z);
    const margin = 30;
    const wx0 = Math.max(0, Math.min(sx, gx) - margin);
    const wz0 = Math.max(0, Math.min(sz, gz) - margin);
    const W = Math.min(MAX_WINDOW, Math.min(n, Math.max(sx, gx) + margin + 1) - wx0);
    const H = Math.min(MAX_WINDOW, Math.min(n, Math.max(sz, gz) + margin + 1) - wz0);
    const toW = (ix: number, iz: number) => (iz - wz0) * W + (ix - wx0);
    const inW = (ix: number, iz: number) => ix >= wx0 && iz >= wz0 && ix < wx0 + W && iz < wz0 + H;
    if (!inW(gx, gz) || !inW(sx, sz)) return null;

    const gen = ++this.gen;
    const heap = this.heap;
    heap.clear();
    const hfn = (ix: number, iz: number) => {
      const dx = Math.abs(ix - gx);
      const dz = Math.abs(iz - gz);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    const s = toW(sx, sz);
    this.g[s] = 0;
    this.stamp[s] = gen;
    this.parent[s] = -1;
    heap.push(s, hfn(sx, sz));
    const goalW = toW(gx, gz);
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (cur === goalW) return this.reconstruct(cur, W, wx0, wz0, b);
      if (++expanded > maxExpand) return null;
      const cx = (cur % W) + wx0;
      const cz = Math.floor(cur / W) + wz0;
      const cf = this.floor[cz * n + cx];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (!inW(nx, nz)) continue;
          const gi = nz * n + nx;
          if (!this.walk[gi]) continue;
          if (Math.abs(this.floor[gi] - cf) > 0.9) continue;
          // No corner cutting
          if (dx && dz && (!this.walk[cz * n + nx] || !this.walk[nz * n + cx])) continue;
          const ni = toW(nx, nz);
          if (this.closed[ni] === gen) continue;
          const cost = this.g[cur] + (dx && dz ? Math.SQRT2 : 1);
          if (this.stamp[ni] !== gen || cost < this.g[ni]) {
            this.stamp[ni] = gen;
            this.g[ni] = cost;
            this.parent[ni] = cur;
            heap.push(ni, cost + hfn(nx, nz) * 1.05);
          }
        }
      }
    }
    return null;
  }

  private reconstruct(end: number, W: number, wx0: number, wz0: number, goal: THREE.Vector3): THREE.Vector3[] {
    const cells: THREE.Vector3[] = [];
    for (let c = end; c !== -1; c = this.parent[c]) {
      const ix = (c % W) + wx0;
      const iz = Math.floor(c / W) + wz0;
      cells.push(new THREE.Vector3(ix + 0.5 - this.half, this.floor[iz * this.n + ix], iz + 0.5 - this.half));
    }
    cells.reverse();
    cells[cells.length - 1] = this.withFloor(goal);
    return this.smooth(cells);
  }

  private coarseAStar(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3[] | null {
    const cn = this.cn;
    const cc = (x: number, z: number) => [Math.floor((x + this.half) / COARSE), Math.floor((z + this.half) / COARSE)];
    const [sx, sz] = cc(a.x, a.z);
    const [gx, gz] = cc(b.x, b.z);
    const N = cn * cn;
    const g = new Float32Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new Heap();
    const s = sz * cn + sx;
    const goal = gz * cn + gx;
    g[s] = 0;
    heap.push(s, 0);
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;
      const cx = cur % cn;
      const cz = Math.floor(cur / cn);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= cn || nz >= cn) continue;
          const ni = nz * cn + nx;
          if (!this.coarse[ni] && ni !== goal) continue;
          const cost = g[cur] + (dx && dz ? Math.SQRT2 : 1);
          if (cost < g[ni]) {
            g[ni] = cost;
            parent[ni] = cur;
            heap.push(ni, cost + Math.hypot(nx - gx, nz - gz));
          }
        }
      }
    }
    if (parent[goal] === -1 && goal !== s) return null;
    const pts: THREE.Vector3[] = [];
    for (let c = goal; c !== -1; c = parent[c]) {
      const x = (c % cn + 0.5) * COARSE - this.half;
      const z = (Math.floor(c / cn) + 0.5) * COARSE - this.half;
      const w = this.nearestWalkable(x, z, 4);
      if (w) pts.push(w);
    }
    pts.reverse();
    if (pts.length) pts[pts.length - 1] = this.withFloor(b);
    return this.smooth([a.clone(), ...pts]);
  }

  /** Greedy string-pulling: skip waypoints while the straight line stays walkable. */
  private smooth(pts: THREE.Vector3[]): THREE.Vector3[] {
    if (pts.length <= 1) return pts;
    if (pts.length === 2) return [pts[1]];
    const out: THREE.Vector3[] = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.lineWalkable(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /** Debug: walkability points in a square around a centre. */
  debugPoints(center: THREE.Vector3, radius: number): THREE.Points {
    const pos: number[] = [];
    const col: number[] = [];
    const [cx, cz] = this.cellOf(center.x, center.z);
    for (let iz = cz - radius; iz <= cz + radius; iz++) {
      for (let ix = cx - radius; ix <= cx + radius; ix++) {
        if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) continue;
        const i = iz * this.n + ix;
        pos.push(ix + 0.5 - this.half, this.floor[i] + 0.15, iz + 0.5 - this.half);
        if (this.walk[i]) col.push(0.2, 0.9, 0.3);
        else col.push(1, 0.2, 0.2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.25, vertexColors: true, depthTest: true }));
  }
}

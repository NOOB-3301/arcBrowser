import * as THREE from 'three';
import type { NavGrid } from './NavGrid';

/** Global per-frame pathfinding budget so many bots can't spike a frame. */
export const PathBudget = { perFrame: 6, left: 6, requests: 0 };

/** Follows a nav-grid path, repathing when the goal moves or progress stalls. */
export class PathFollower {
  path: THREE.Vector3[] = [];
  goal: THREE.Vector3 | null = null;
  private lastRepath = -99;
  failed = false;

  /** Request a path; returns false if deferred (budget) or unreachable. */
  setGoal(nav: NavGrid, from: THREE.Vector3, goal: THREE.Vector3, time: number, force = false): boolean {
    if (!force && this.goal && this.goal.distanceTo(goal) < 2 && this.path.length) return true;
    if (!force && time - this.lastRepath < 0.5) return false;
    if (PathBudget.left <= 0) return false;
    PathBudget.left--;
    PathBudget.requests++;
    this.lastRepath = time;
    const p = nav.findPath(from, goal);
    this.goal = goal.clone();
    this.failed = !p;
    this.path = p ?? [];
    return !!p;
  }

  clear(): void {
    this.path = [];
    this.goal = null;
  }

  get done(): boolean {
    return this.path.length === 0;
  }

  /** Current waypoint after advancing past reached ones. */
  current(pos: THREE.Vector3, reach = 1.2): THREE.Vector3 | null {
    while (this.path.length && Math.hypot(this.path[0].x - pos.x, this.path[0].z - pos.z) < (this.path.length === 1 ? reach * 0.6 : reach)) {
      this.path.shift();
    }
    return this.path[0] ?? null;
  }

  /** Straight-line distance left along the path. */
  remaining(pos: THREE.Vector3): number {
    let d = 0;
    let prev = pos;
    for (const p of this.path) {
      d += Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    return d;
  }
}

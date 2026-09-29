import * as THREE from 'three';

/** Ladder: climbable strip on a wall. `base` is the ground point in front of it. */
export interface Ladder {
  base: THREE.Vector3;
  height: number;
  /** Outward wall normal (horizontal, unit). Climber faces -normal. */
  normal: THREE.Vector3;
  halfWidth: number;
}

/** Zipline: straight cable between two anchors; ride toward the lower end. */
export interface Zipline {
  a: THREE.Vector3;
  b: THREE.Vector3;
}

/** Registry of traversal features queried by the player controller. */
export class Traversal {
  readonly ladders: Ladder[] = [];
  readonly ziplines: Zipline[] = [];

  /** Ladder whose grab volume contains feet position `p`, if any. */
  ladderAt(p: THREE.Vector3): Ladder | null {
    const d = new THREE.Vector3();
    for (const l of this.ladders) {
      d.subVectors(p, l.base);
      const out = d.x * l.normal.x + d.z * l.normal.z;
      const side = Math.abs(d.x * -l.normal.z + d.z * l.normal.x);
      if (out > -0.2 && out < 0.9 && side < l.halfWidth + 0.3 && d.y > -0.5 && d.y < l.height - 0.3) return l;
    }
    return null;
  }

  /** Nearest zipline anchor within `radius` of point p (chest height). */
  ziplineNear(p: THREE.Vector3, radius = 2.2): { line: Zipline; from: THREE.Vector3; to: THREE.Vector3 } | null {
    for (const line of this.ziplines) {
      if (p.distanceTo(line.a) < radius) return { line, from: line.a, to: line.b };
      if (p.distanceTo(line.b) < radius) return { line, from: line.b, to: line.a };
    }
    return null;
  }
}

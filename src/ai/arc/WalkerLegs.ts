import * as THREE from 'three';

export interface WalkerLegOpts {
  /** Foot rest positions relative to the body root (x/z, y ignored). */
  rest: THREE.Vector3[];
  upper: number;
  lower: number;
  /** Distance a foot may lag its target before it steps. */
  stride: number;
  stepTime: number;
  stepHeight: number;
  /** Groups that step together (diagonal pairs). */
  groups: number[][];
}

interface Step {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

const _t = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _y = new THREE.Vector3(0, 1, 0);

/**
 * W4: procedural leg gait for multi-legged walkers. Feet stay planted in world
 * space until they lag too far behind their rest target, then step in diagonal
 * groups along an arc; knees are solved with two-bone IK bent outward.
 */
export class WalkerLegs {
  readonly feet: THREE.Vector3[];
  readonly knees: THREE.Vector3[];
  readonly alive: boolean[];
  private steps: (Step | null)[];
  private group = 0;
  onStep: (leg: number, pos: THREE.Vector3) => void = () => {};

  constructor(private o: WalkerLegOpts, private ground: (x: number, z: number, y: number) => number, root: THREE.Vector3, yaw: number) {
    const n = o.rest.length;
    this.feet = [];
    this.knees = [];
    this.alive = new Array(n).fill(true);
    this.steps = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const p = this.target(i, root, yaw, new THREE.Vector3(), new THREE.Vector3());
      this.feet.push(p);
      this.knees.push(p.clone());
    }
  }

  /** Ideal foot position for leg i (world). */
  private target(i: number, root: THREE.Vector3, yaw: number, vel: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _q.setFromAxisAngle(_y, yaw);
    out.copy(this.o.rest[i]).setY(0).applyQuaternion(_q).add(root).addScaledVector(vel, this.o.stepTime * 0.9);
    out.y = this.ground(out.x, out.z, root.y);
    return out;
  }

  get stepping(): boolean {
    return this.steps.some((s) => s !== null);
  }

  /**
   * Advance the gait. `hips` are world-space hip anchors. `speedMult` shortens
   * steps (crippled walkers shuffle).
   */
  update(dt: number, root: THREE.Vector3, yaw: number, vel: THREE.Vector3, hips: THREE.Vector3[], stepSpeed = 1): void {
    const o = this.o;
    const n = this.feet.length;
    // Advance active steps
    let anyActive = false;
    for (let i = 0; i < n; i++) {
      const s = this.steps[i];
      if (!s) continue;
      s.t += (dt / o.stepTime) * stepSpeed;
      if (s.t >= 1) {
        this.feet[i].copy(s.to);
        this.steps[i] = null;
        this.onStep(i, this.feet[i]);
      } else {
        const k = s.t * s.t * (3 - 2 * s.t);
        this.feet[i].lerpVectors(s.from, s.to, k);
        this.feet[i].y += Math.sin(Math.PI * s.t) * o.stepHeight;
        anyActive = true;
      }
    }
    // Start the next group's steps when the previous group has landed
    if (!anyActive) {
      for (let tries = 0; tries < o.groups.length; tries++) {
        const g = o.groups[this.group];
        let need = false;
        for (const i of g) {
          if (!this.alive[i]) continue;
          this.target(i, root, yaw, vel, _t);
          if (_t.distanceTo(this.feet[i]) > o.stride || Math.abs(_t.y - this.feet[i].y) > o.stride * 0.8) need = true;
        }
        if (need) {
          for (const i of g) {
            if (!this.alive[i]) continue;
            this.steps[i] = { from: this.feet[i].clone(), to: this.target(i, root, yaw, vel, new THREE.Vector3()), t: 0 };
          }
          this.group = (this.group + 1) % o.groups.length;
          break;
        }
        this.group = (this.group + 1) % o.groups.length;
      }
    }
    // Dead legs dangle under their hip
    for (let i = 0; i < n; i++) {
      if (this.alive[i]) continue;
      this.steps[i] = null;
      const hang = _t.copy(hips[i]).add(new THREE.Vector3(0, -(o.upper + o.lower) * 0.55, 0));
      this.feet[i].lerp(hang, Math.min(1, dt * 4));
    }
    // Two-bone IK, knee bent outward + up
    for (let i = 0; i < n; i++) {
      const hip = hips[i];
      const foot = this.feet[i];
      _dir.subVectors(foot, hip);
      let d = _dir.length();
      const reach = (o.upper + o.lower) * 0.999;
      if (d > reach) {
        _dir.multiplyScalar(reach / d);
        foot.copy(hip).add(_dir);
        d = reach;
      }
      _dir.divideScalar(d || 1);
      const a = (o.upper * o.upper - o.lower * o.lower + d * d) / (2 * d || 1);
      const h = Math.sqrt(Math.max(0, o.upper * o.upper - a * a));
      _pole.set(hip.x - root.x, 0, hip.z - root.z).normalize().multiplyScalar(0.6).add(_y);
      _pole.addScaledVector(_dir, -_pole.dot(_dir)).normalize();
      this.knees[i].copy(hip).addScaledVector(_dir, a).addScaledVector(_pole, h);
    }
  }

  /** Mean height of planted feet (for body height). */
  meanFootY(): number {
    let s = 0;
    let c = 0;
    for (let i = 0; i < this.feet.length; i++) {
      if (!this.alive[i]) continue;
      s += this.steps[i] ? this.steps[i]!.from.y : this.feet[i].y;
      c++;
    }
    return c ? s / c : this.feet[0].y;
  }
}

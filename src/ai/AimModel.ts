import * as THREE from 'three';
import type { Difficulty } from './Difficulty';

/**
 * Human-ish bot aim: large error on first sighting that shrinks while the
 * target is tracked, plus imperfect leading of moving targets.
 */
export class AimModel {
  /** 0..1 how "settled" on the current target. */
  settle = 0;
  private target: unknown = null;
  private headThisBurst = false;

  update(dt: number, target: unknown, visible: boolean, d: Difficulty): void {
    if (target !== this.target) {
      this.target = target;
      this.settle = 0;
    }
    if (visible) this.settle = Math.min(1, this.settle + dt / d.settleTime);
    else this.settle = Math.max(0, this.settle - dt * 0.5);
  }

  /** Start of a burst: decide head vs chest. */
  newBurst(d: Difficulty): void {
    this.headThisBurst = Math.random() < d.headBias * (0.5 + this.settle);
  }

  /**
   * Direction to fire from `from` at a target with chest/head points and velocity.
   * `extraDeg` adds situational error (shooter moving, suppressed…).
   */
  direction(from: THREE.Vector3, chest: THREE.Vector3, head: THREE.Vector3 | undefined, vel: THREE.Vector3, speed: number, d: Difficulty, extraDeg = 0): THREE.Vector3 {
    const aim = (this.headThisBurst && head ? head : chest).clone();
    const dist = aim.distanceTo(from);
    aim.addScaledVector(vel, (dist / Math.max(speed, 1)) * d.lead);
    const dir = aim.sub(from).normalize();
    const err = THREE.MathUtils.degToRad(d.aimErrorDeg * (1 - 0.85 * this.settle) + extraDeg);
    return cone(dir, err * 0.5);
  }
}

function cone(dir: THREE.Vector3, half: number): THREE.Vector3 {
  if (half <= 0) return dir;
  // Gaussian-ish: most shots near centre, some wide
  const r = half * Math.sqrt(-2 * Math.log(Math.max(1e-6, Math.random()))) * 0.6;
  const phi = Math.random() * Math.PI * 2;
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3().crossVectors(dir, up).normalize();
  const b = new THREE.Vector3().crossVectors(dir, a);
  return dir.clone().addScaledVector(a, Math.cos(phi) * Math.tan(r)).addScaledVector(b, Math.sin(phi) * Math.tan(r)).normalize();
}

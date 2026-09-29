import * as THREE from 'three';
import type { DamageRegistry } from './Damage';
import type { Physics } from '../physics/Physics';
import type RAPIER from '@dimforge/rapier3d-compat';

const SLOW_CONE = THREE.MathUtils.degToRad(4.5);
const PULL_CONE = THREE.MathUtils.degToRad(3);
const MAX_RANGE = 120;

export interface AssistResult {
  sensScale: number;
  yaw: number;
  pitch: number;
}

/**
 * Controller aim assist: look slowdown near targets plus gentle rotational
 * pull while aiming down sights. Strength 0..1 from settings.
 */
export class AimAssist {
  private pts: THREE.Vector3[] = [];
  private fwd = new THREE.Vector3();
  private to = new THREE.Vector3();

  constructor(private registry: DamageRegistry, private physics: Physics) {}

  compute(camera: THREE.Camera, strength: number, ads: number, moving: boolean, dt: number, exclude?: RAPIER.Collider): AssistResult {
    const res: AssistResult = { sensScale: 1, yaw: 0, pitch: 0 };
    if (strength <= 0) return res;
    camera.getWorldDirection(this.fwd);
    const camPos = camera.position;

    let best: THREE.Vector3 | null = null;
    let bestTarget: unknown = null;
    let bestAngle = SLOW_CONE;
    for (const t of this.registry.targets) {
      if (t.faction === 'player' || t.faction === 'neutral' || !t.health.alive) continue;
      this.pts.length = 0;
      t.aimPoints(this.pts);
      for (const p of this.pts) {
        this.to.subVectors(p, camPos);
        const d = this.to.length();
        if (d > MAX_RANGE || d < 1) continue;
        // Cone widens a little up close so near targets stay sticky
        const angle = this.to.divideScalar(d).angleTo(this.fwd) * Math.min(1, d / 12 + 0.5);
        if (angle < bestAngle) {
          bestAngle = angle;
          best = p;
          bestTarget = t;
        }
      }
    }
    if (!best) return res;

    // Line of sight check on the best candidate only
    this.to.subVectors(best, camPos);
    const dist = this.to.length();
    const hit = this.physics.raycast(camPos.clone(), this.to.clone().divideScalar(dist), dist + 0.5, exclude);
    if (hit && this.registry.lookup(hit.collider) !== bestTarget) return res; // occluded

    const k = 1 - bestAngle / SLOW_CONE;
    res.sensScale = 1 - strength * 0.55 * k;

    if (ads > 0.5 && bestAngle < PULL_CONE && moving) {
      // Rotational pull toward the target, proportional to error
      const dir = this.to.normalize();
      const targetYaw = Math.atan2(-dir.x, -dir.z);
      const camYaw = Math.atan2(-this.fwd.x, -this.fwd.z);
      let dy = targetYaw - camYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const dp = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) - Math.asin(THREE.MathUtils.clamp(this.fwd.y, -1, 1));
      const rate = strength * 6 * dt;
      res.yaw = dy * Math.min(1, rate);
      res.pitch = dp * Math.min(1, rate);
    }
    return res;
  }
}

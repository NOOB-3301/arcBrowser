import { RARITY } from './WeaponDefs';
import type { Weapon } from './Weapon';
import type { CameraRig } from '../camera/CameraRig';

/**
 * Recoil moves the real aim (camera pitch/yaw). When firing stops, part of the
 * climb is recovered — but never more than the player didn't already pull down.
 */
export class Recoil {
  private accumPitch = 0;
  private startPitch = 0;
  private recovering = 0;
  private recoveryFrac = 0.6;
  private sinceShot = 99;

  onShot(w: Weapon, rig: CameraRig, ads: number, crouched: boolean): void {
    const r = w.def.recoil;
    const rar = RARITY[w.rarity].recoil;
    if (this.sinceShot > 0.3 && this.recovering <= 1e-4) {
      this.accumPitch = 0;
      this.startPitch = rig.pitch;
    }
    const control = rar * (1 - 0.25 * ads) * (crouched ? 0.85 : 1);
    const v = r.vertical * control * (0.9 + Math.random() * 0.2);
    // Sideways: consistent drift that grows through a spray, plus noise
    const drift = r.horizontalBias * (w.shotIndex > 4 ? 1.4 : 1);
    const h = (drift + (Math.random() * 2 - 1) * r.horizontalRandom) * control;
    rig.kick(v, -h);
    rig.addTrauma(r.shake * (1 - 0.5 * ads));
    this.accumPitch += v;
    this.recoveryFrac = r.recovery;
    this.recovering = 0;
    this.sinceShot = 0;
  }

  update(dt: number, rig: CameraRig): void {
    this.sinceShot += dt;
    if (this.sinceShot > 0.1 && this.accumPitch > 0) {
      // Recover up to recovery% of the kick, clamped to what's still above the start pitch
      this.recovering = Math.max(0, Math.min(this.accumPitch * this.recoveryFrac, rig.pitch - this.startPitch));
      this.accumPitch = 0;
    }
    if (this.recovering > 1e-4) {
      const step = this.recovering * (1 - Math.exp(-14 * dt));
      rig.pitch -= step;
      this.recovering -= step;
    }
  }
}

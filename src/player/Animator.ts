import * as THREE from 'three';
import type { PlayerController } from './PlayerController';

/** Weapon-driven pose inputs. reload: -1 idle or 0..1 progress; swap/kick 0..1. */
export interface CombatPose {
  reload: number;
  swap: number;
  kick: number;
}
const NO_POSE: CombatPose = { reload: -1, swap: 0, kick: 0 };

/**
 * Blocky raider mannequin with procedural animation. Stand-in until the rigged
 * GLB character lands in M7; the controller-facing API (update) stays the same.
 */
export class Animator {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private foreL = new THREE.Group();
  private foreR = new THREE.Group();
  private thighL = new THREE.Group();
  private thighR = new THREE.Group();
  private shinL = new THREE.Group();
  private shinR = new THREE.Group();
  private tumble = new THREE.Group();

  private phase = 0;
  private lean = 0;
  private crouch = 0;
  private aimBlend = 0;
  private yaw = 0;
  private gunMount = new THREE.Group();
  private weapon: THREE.Object3D | null = null;
  private _m = new THREE.Vector3();

  /** Materials that flash when hit (bots). */
  readonly materials: THREE.MeshStandardMaterial[];

  constructor(scene: THREE.Scene, palette: { suit: string; dark: string; accent: string } = { suit: '#c9a36a', dark: '#3b3a36', accent: '#e0662a' }) {
    const suit = new THREE.MeshStandardMaterial({ color: palette.suit, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: palette.dark, roughness: 0.9 });
    const accent = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.6 });
    this.materials = [suit, dark, accent];
    const visor = new THREE.MeshStandardMaterial({ color: '#1a2226', roughness: 0.2, metalness: 0.6 });

    const box = (w: number, h: number, d: number, m: THREE.Material, y = 0, z = 0, x = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      return mesh;
    };

    // Hierarchy: root(feet) → tumble (roll pivot at hip height) → hips → torso/legs
    this.root.add(this.tumble);
    this.tumble.position.y = 0.55;
    this.tumble.add(this.hips);
    this.hips.position.y = 0.95 - 0.55;

    this.hips.add(box(0.36, 0.18, 0.22, dark));
    this.hips.add(this.torso);
    this.torso.add(box(0.44, 0.56, 0.26, suit, 0.33));
    this.torso.add(box(0.46, 0.14, 0.28, accent, 0.5)); // chest band
    this.torso.add(box(0.36, 0.46, 0.2, dark, 0.34, 0.22)); // backpack
    this.torso.add(box(0.1, 0.2, 0.08, accent, 0.55, 0.3, 0.12)); // pack light

    this.torso.add(this.head);
    this.head.position.y = 0.68;
    this.head.add(box(0.24, 0.26, 0.26, suit, 0.1));
    this.head.add(box(0.2, 0.1, 0.04, visor, 0.12, -0.13));

    for (const [arm, fore, x] of [[this.armL, this.foreL, -0.28], [this.armR, this.foreR, 0.28]] as const) {
      this.torso.add(arm);
      arm.position.set(x, 0.56, 0);
      arm.add(box(0.12, 0.32, 0.12, suit, -0.16));
      arm.add(fore);
      fore.position.y = -0.32;
      fore.add(box(0.11, 0.3, 0.11, dark, -0.15));
    }
    // Weapon mount in right hand: models are built along -Z, mount aligns that with the forearm
    this.gunMount.position.set(0, -0.3, 0);
    this.gunMount.rotation.x = -Math.PI / 2;
    this.foreR.add(this.gunMount);

    for (const [thigh, shin, x] of [[this.thighL, this.shinL, -0.11], [this.thighR, this.shinR, 0.11]] as const) {
      this.hips.add(thigh);
      thigh.position.set(x, -0.06, 0);
      thigh.add(box(0.15, 0.44, 0.16, dark, -0.22));
      thigh.add(shin);
      shin.position.y = -0.44;
      shin.add(box(0.13, 0.44, 0.14, dark, -0.22));
      shin.add(box(0.15, 0.08, 0.24, suit, -0.42, -0.04)); // boot
    }

    scene.add(this.root);
  }

  setWeapon(model: THREE.Object3D | null): void {
    if (this.weapon) this.gunMount.remove(this.weapon);
    this.weapon = model;
    if (model) this.gunMount.add(model);
  }

  /** World-space muzzle position of the held weapon (falls back to chest). */
  muzzleWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const m = this.weapon?.userData.muzzle as THREE.Object3D | undefined;
    if (m) {
      this.root.updateMatrixWorld(true);
      return m.getWorldPosition(out);
    }
    return out.copy(this.root.position).add(this._m.set(0, 1.4, 0));
  }

  update(dt: number, p: PlayerController, camPitch: number, pose: CombatPose = NO_POSE): void {
    const damp = (r: number) => 1 - Math.exp(-r * dt);
    const feet = p.renderFeet();
    this.root.position.copy(feet);

    // Smooth yaw
    let dy = p.facingYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * damp(20);
    this.root.rotation.y = this.yaw;

    const speed = p.horizontalSpeed;
    const state = p.state;
    const crouchTarget = p.crouched && state !== 'roll' && state !== 'mantle' ? 1 : 0;
    this.crouch += (crouchTarget - this.crouch) * damp(12);
    const canAim = state === 'ground' || state === 'air' || state === 'slide';
    this.aimBlend += ((p.aiming && canAim && pose.reload < 0 ? 1 : 0) - this.aimBlend) * damp(16);
    // Sign convention: +X rotation swings a limb forward (toward -Z); torso lean forward is -X.
    const leanTarget = state === 'slide' ? 0.45 : p.locomotion === 'sprint' ? -0.32 : p.locomotion === 'jog' ? -0.12 : 0;
    this.lean += (leanTarget - this.lean) * damp(8);

    // Gait phase advances with distance travelled
    const stride = p.locomotion === 'sprint' ? 2.3 : p.locomotion === 'crouch' ? 1.2 : 1.7;
    this.phase += (speed / stride) * Math.PI * dt;
    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);
    const amp = Math.min(speed / 7, 1) * (p.locomotion === 'sprint' ? 1.0 : 0.7);

    // Reset
    this.tumble.rotation.set(0, 0, 0);
    this.hips.position.y = 0.4;
    this.torso.rotation.set(this.lean, 0, 0);
    this.head.rotation.set(0, 0, 0);

    // Legs (walk cycle + crouch pose)
    const crouchThigh = 1.1 * this.crouch;
    const crouchShin = -1.7 * this.crouch;
    this.hips.position.y -= 0.38 * this.crouch;
    this.thighL.rotation.x = crouchThigh + s * amp;
    this.thighR.rotation.x = crouchThigh - s * amp;
    this.shinL.rotation.x = crouchShin - Math.max(0, -c) * amp * 1.2;
    this.shinR.rotation.x = crouchShin - Math.max(0, c) * amp * 1.2;
    this.hips.position.y += Math.abs(c) * 0.04 * amp;

    // Arms: carry rifle low, or shoulder it when aiming
    const swing = s * amp * 0.9;
    const aimPitch = THREE.MathUtils.clamp(camPitch, -1.1, 1.1);
    const torsoX = this.lean + aimPitch * 0.3 * this.aimBlend;
    this.torso.rotation.x = torsoX;
    const aimArm = Math.PI / 2 + aimPitch - torsoX;
    this.armR.rotation.set(THREE.MathUtils.lerp(0.25 + swing * 0.2, aimArm, this.aimBlend), 0, THREE.MathUtils.lerp(0, 0.1, this.aimBlend));
    this.armL.rotation.set(THREE.MathUtils.lerp(-swing + 0.1, aimArm - 0.1, this.aimBlend), 0, THREE.MathUtils.lerp(-0.05, 0.55, this.aimBlend));
    this.foreR.rotation.set(THREE.MathUtils.lerp(1.0, 0, this.aimBlend), 0, 0);
    this.foreL.rotation.set(THREE.MathUtils.lerp(0.5, 0.35, this.aimBlend), 0, 0);

    switch (state) {
      case 'air': {
        const tuck = p.velocity.y > 0 ? 0.5 : 0.2;
        this.thighL.rotation.x = tuck + 0.3;
        this.thighR.rotation.x = tuck - 0.2;
        this.shinL.rotation.x = -tuck * 1.6;
        this.shinR.rotation.x = -tuck;
        this.armL.rotation.x = 0.6;
        break;
      }
      case 'slide':
        this.hips.position.y = 0.05;
        this.thighL.rotation.x = 1.3;
        this.shinL.rotation.x = -0.2;
        this.thighR.rotation.x = 0.4;
        this.shinR.rotation.x = -1.6;
        this.armL.rotation.set(0.3, 0, -0.9);
        break;
      case 'roll':
        this.tumble.rotation.x = -p.actionT * Math.PI * 2;
        this.hips.position.y = 0.15;
        this.thighL.rotation.x = this.thighR.rotation.x = 2.0;
        this.shinL.rotation.x = this.shinR.rotation.x = -2.3;
        this.torso.rotation.x = -0.9;
        this.armL.rotation.x = this.armR.rotation.x = 1.2;
        break;
      case 'mantle': {
        const k = p.actionT;
        const reach = Math.sin(Math.min(k * 1.4, 1) * Math.PI);
        this.armL.rotation.x = this.armR.rotation.x = 2.6 - k * 2.2;
        this.foreL.rotation.x = this.foreR.rotation.x = 0.2;
        this.thighL.rotation.x = 1.4 * reach;
        this.shinL.rotation.x = -1.6 * reach;
        this.thighR.rotation.x = 0.6 * reach;
        this.shinR.rotation.x = -1.0 * reach;
        this.torso.rotation.x = -0.5 * reach;
        break;
      }
      case 'ladder': {
        const cy = p.center.y * 3.2;
        this.armL.rotation.set(2.5 + Math.sin(cy) * 0.35, 0, 0);
        this.armR.rotation.set(2.5 - Math.sin(cy) * 0.35, 0, 0);
        this.foreL.rotation.x = this.foreR.rotation.x = 0.4;
        this.thighL.rotation.x = 0.7 + Math.sin(cy) * 0.5;
        this.thighR.rotation.x = 0.7 - Math.sin(cy) * 0.5;
        this.shinL.rotation.x = this.shinR.rotation.x = -1.1;
        break;
      }
      case 'zipline':
        this.armL.rotation.set(3.0, 0, -0.1);
        this.armR.rotation.set(3.0, 0, 0.1);
        this.foreL.rotation.x = this.foreR.rotation.x = 0;
        this.thighL.rotation.x = 0.5 + Math.sin(this.phase * 0.3) * 0.1;
        this.thighR.rotation.x = 0.2;
        this.shinL.rotation.x = -0.8;
        this.shinR.rotation.x = -0.4;
        break;
    }

    // Combat overlays: reload, swap, recoil kick
    if (pose.reload >= 0 && canAim) {
      const wob = Math.sin(pose.reload * Math.PI * 4) * 0.15;
      this.armR.rotation.x = 0.6;
      this.foreR.rotation.x = 0.9;
      this.armL.rotation.set(0.9 + wob, 0, 0.5);
      this.foreL.rotation.x = 1.3;
    }
    this.gunMount.rotation.x = -Math.PI / 2 + pose.swap * 1.3;
    if (this.weapon) this.weapon.position.z = pose.kick * 0.09;
  }
}

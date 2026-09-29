import * as THREE from 'three';
import type { PlayerController } from './PlayerController';
import { Assets, cloneMaterials } from '../assets/Assets';

/** Weapon-driven pose inputs. reload: -1 idle or 0..1 progress; swap/kick 0..1. */
export interface CombatPose {
  reload: number;
  swap: number;
  kick: number;
}
const NO_POSE: CombatPose = { reload: -1, swap: 0, kick: 0 };

export interface Palette {
  suit: string;
  dark: string;
  accent: string;
}

/** Bones driven by the weapon (upper-body) layer. Everything else belongs to the locomotion layer. */
const UPPER = /^(spine_02|spine_03|neck_01|Head|clavicle_|upperarm_|lowerarm_|hand_|index_|middle_|ring_|pinky_|thumb_)/;

/** Natural ground speed (m/s) of each locomotion clip, used to scale playback so feet don't slide. */
const CLIP_SPEED: Record<string, number> = {
  Walk_Loop: 1.5,
  Jog_Fwd_Loop: 3.9,
  Sprint_Loop: 6.4,
  Crouch_Fwd_Loop: 1.6,
};

type Layer = 'full' | 'lower' | 'upper';

interface Slot {
  clip: THREE.AnimationClip;
  actions: Partial<Record<Layer, THREE.AnimationAction>>;
  time: number;
  weight: number;
  target: number;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
/** Bones the procedural layer rotates (hip twist, aim pitch, recoil). */
const PROC_BONES = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'Head'];
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();

/**
 * Skinned character rig (RUSTFALL raider, Quaternius UAL skeleton). Two animation layers on one
 * AnimationMixer: a locomotion layer (lower body, or full body for roll/mantle/ladder/death) and a
 * weapon layer (upper body rifle/pistol poses), blended with per-slot weights and manually driven
 * clip time so gait speed matches the controller. Camera pitch bends the spine; the weapon rides a
 * socket on the right hand. Public API matches the old procedural mannequin.
 */
export class Animator {
  readonly root = new THREE.Group();
  /** Materials that flash when hit (bots). */
  readonly materials: THREE.MeshStandardMaterial[];
  /** Set by the owner when the character dies (plays the death clip once). */
  dead = false;

  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private slots = new Map<string, Slot>();
  private socket: THREE.Object3D;
  private gunMount = new THREE.Group();
  private weapon: THREE.Object3D | null = null;
  private pistol = false;
  private bones: Record<string, THREE.Bone> = {};
  /**
   * Animated pose of the bones we twist procedurally, captured right after the mixer writes.
   * Restored before the next mixer pass so procedural offsets never accumulate. (We can't just
   * reset to rest: three's PropertyMixer only writes a bone when its animated value changes, so
   * static poses like Rifle_Idle would never be re-applied.)
   */
  private animQ = new Map<THREE.Bone, THREE.Quaternion>();
  private yaw = 0;
  private hipYaw = 0;
  private upperK = 1;
  private prevState = '';
  private landT = 0;
  private deathT = 0;
  private aimBlend = 0;
  private _m = new THREE.Vector3();

  constructor(scene: THREE.Scene, palette?: Palette) {
    const gltf = Assets.gltf('raider');
    if (!gltf) throw new Error('Animator: raider.glb not loaded (call Assets.load() first)');
    this.model = Assets.clone('raider');
    // Asset faces +Z (Blender -Y); the game's forward is -Z.
    this.model.rotation.y = Math.PI;
    this.root.add(this.model);
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones[o.name] = o as THREE.Bone;
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.frustumCulled = false; // animated bounds exceed the bind-pose sphere
      }
    });
    this.materials = cloneMaterials(this.model);
    for (const m of this.materials) {
      m.emissive.setRGB(0, 0, 0);
      if (palette) tint(m, palette);
    }
    this.socket = this.model.getObjectByName('socket_r') ?? this.bones.hand_r;
    this.socket.add(this.gunMount);

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const lower = new THREE.AnimationClip(clip.name + '#lower', clip.duration, clip.tracks.filter((t) => !UPPER.test(t.name)));
      const upper = new THREE.AnimationClip(clip.name + '#upper', clip.duration, clip.tracks.filter((t) => UPPER.test(t.name)));
      const mk = (c: THREE.AnimationClip) => {
        const a = this.mixer.clipAction(c);
        a.setEffectiveTimeScale(0);
        a.setEffectiveWeight(0);
        return a;
      };
      this.slots.set(clip.name, { clip, actions: { full: mk(clip), lower: mk(lower), upper: mk(upper) }, time: 0, weight: 0, target: 0 });
    }
    scene.add(this.root);
  }

  setWeapon(model: THREE.Object3D | null): void {
    if (this.weapon) this.gunMount.remove(this.weapon);
    this.weapon = model;
    this.pistol = !!model && (model.userData.cls === 'pistol' || model.userData.cls === 'revolver');
    if (model) this.gunMount.add(model);
  }

  /** World-space muzzle position of the held weapon (falls back to chest). */
  muzzleWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const m = this.weapon?.userData.muzzle as THREE.Object3D | undefined;
    if (m && this.weapon?.visible) {
      this.root.updateMatrixWorld(true);
      return m.getWorldPosition(out);
    }
    return out.copy(this.root.position).add(this._m.set(0, 1.4, 0));
  }

  update(dt: number, p: PlayerController, camPitch: number, pose: CombatPose = NO_POSE): void {
    const damp = (r: number) => 1 - Math.exp(-r * dt);
    this.root.position.copy(p.renderFeet());
    let dy = p.facingYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * damp(this.dead ? 0 : 18);
    this.root.rotation.y = this.yaw;

    const state = p.state;
    if (this.prevState === 'air' && state === 'ground' && p.horizontalSpeed < 2.5) this.landT = 0.3;
    this.prevState = state;
    this.landT = Math.max(0, this.landT - dt);

    // ---- choose base (locomotion) clip + playback rate --------------------------------------
    let base = 'Idle_Loop';
    let rate = 1;
    let fullBody = false;
    let scrub = -1; // 0..1 → drive clip time directly
    const speed = p.horizontalSpeed;
    // Movement direction relative to facing, for hip twist / backpedal
    const vx = p.velocity.x, vz = p.velocity.z;
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const rel = speed > 0.4 ? Math.atan2(fwdX * vz - fwdZ * vx, fwdX * vx + fwdZ * vz) : 0; // + = to the right
    const back = Math.abs(rel) > 1.9;
    let hipTarget = 0;

    if (this.dead) {
      base = 'Death01';
      fullBody = true;
      this.deathT += dt;
      scrub = Math.min(1, this.deathT / this.clipDur('Death01'));
    } else {
      switch (state) {
        case 'ground': {
          const loco = p.locomotion;
          if (this.landT > 0 && speed < 2.5) {
            base = 'Jump_Land';
            scrub = 1 - this.landT / 0.3;
          } else if (loco === 'crouch' || p.crouched) {
            base = speed > 0.3 ? 'Crouch_Fwd_Loop' : 'Crouch_Idle_Loop';
          } else if (loco === 'idle' || speed < 0.3) base = 'Idle_Loop';
          else if (loco === 'sprint') base = 'Sprint_Loop';
          else if (loco === 'walk' || speed < 2.6) base = 'Walk_Loop';
          else base = 'Jog_Fwd_Loop';
          const cs = CLIP_SPEED[base];
          if (cs) {
            rate = THREE.MathUtils.clamp(speed / cs, 0.55, 1.8) * (back ? -1 : 1);
            hipTarget = back ? Math.atan2(Math.sin(rel - Math.PI), Math.cos(rel - Math.PI)) : rel;
            hipTarget = THREE.MathUtils.clamp(hipTarget, -1.1, 1.1);
          }
          break;
        }
        case 'air':
          base = p.velocity.y > 2 ? 'Jump_Start' : 'Jump_Loop';
          if (base === 'Jump_Start') scrub = 0.55;
          break;
        case 'slide':
          base = 'Slide_Loop';
          break;
        case 'roll':
          base = 'Roll';
          fullBody = true;
          scrub = p.actionT;
          break;
        case 'mantle':
          base = 'ClimbUp_1m';
          fullBody = true;
          scrub = 0.1 + p.actionT * 0.85;
          break;
        case 'ladder':
          base = 'Ladder_Climb_Loop';
          fullBody = true;
          scrub = (((p.center.y / 1.1) % 1) + 1) % 1;
          break;
        case 'zipline':
          base = 'Ladder_Climb_Loop';
          fullBody = true;
          scrub = 0.25;
          break;
      }
    }

    // ---- weapon layer ----------------------------------------------------------------------
    const hasGun = !!this.weapon;
    const canAim = !fullBody && hasGun;
    this.upperK += ((canAim ? 1 : 0) - this.upperK) * damp(14);
    const aiming = p.aiming && canAim && pose.reload < 0;
    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * damp(16);
    let upperClip: string;
    let upperScrub = -1;
    if (pose.reload >= 0) {
      upperClip = this.pistol ? 'Pistol_Reload' : 'Rifle_Reload';
      upperScrub = pose.reload;
    } else if (this.pistol) upperClip = aiming ? 'Pistol_Aim_Neutral' : 'Pistol_Idle_Loop';
    else upperClip = aiming ? 'Rifle_Aim' : 'Rifle_Idle';
    if (this.weapon) this.weapon.visible = !(state === 'ladder' || state === 'zipline' || state === 'mantle') || this.dead;

    // ---- drive slots -----------------------------------------------------------------------
    for (const [name, s] of this.slots) {
      s.target = name === base ? 1 : 0;
      const isUpper = name === upperClip;
      const speedUp = name === base && (scrub >= 0 || name === 'Death01') ? 40 : 10;
      s.weight += (s.target - s.weight) * damp(speedUp);
      if (s.weight < 0.002 && !isUpper) s.weight = 0;
      // time
      if (name === base) {
        if (scrub >= 0) s.time = scrub * s.clip.duration;
        else s.time = wrap(s.time + dt * rate, s.clip.duration);
      }
      const k = this.upperK;
      this.setW(s, 'full', s.weight * (1 - k));
      this.setW(s, 'lower', s.weight * k);
    }
    // Upper layer: its own weights (reuse slot weights via a second map would be overkill; crossfade via uw)
    this.driveUpper(upperClip, upperScrub, dt, damp);
    for (const s of this.slots.values()) for (const a of Object.values(s.actions)) if (a && a.enabled) a.time = s.time;
    for (const s of this.slots.values()) {
      const a = s.actions.upper!;
      if (a.enabled) a.time = s.upperTime ?? s.time;
    }
    // Undo last frame's procedural twist, then let the mixer write, then snapshot the clean pose
    for (const [b, q] of this.animQ) b.quaternion.copy(q);
    this.mixer.update(0);
    for (const name of PROC_BONES) {
      const b = this.bones[name];
      if (!b) continue;
      let q = this.animQ.get(b);
      if (!q) this.animQ.set(b, (q = new THREE.Quaternion()));
      q.copy(b.quaternion);
    }

    // ---- procedural layer: hip twist, aim pitch, recoil --------------------------------------
    this.hipYaw += (hipTarget - this.hipYaw) * damp(8);
    this.model.updateMatrixWorld(true);
    if (Math.abs(this.hipYaw) > 0.01) {
      this.rotateBoneWorld('pelvis', _up, -this.hipYaw);
      this.rotateBoneWorld('spine_01', _up, this.hipYaw * 0.6);
      this.rotateBoneWorld('spine_02', _up, this.hipYaw * 0.4);
    }
    if (canAim && !this.dead) {
      const right = _v.set(1, 0, 0).applyQuaternion(this.root.getWorldQuaternion(_q2));
      const pitch = THREE.MathUtils.clamp(camPitch, -1.1, 1.1) * this.upperK * (0.35 + 0.65 * this.aimBlend);
      const kick = pose.kick * 0.06;
      this.rotateBoneWorld('spine_02', right, pitch * 0.45 + kick);
      this.rotateBoneWorld('spine_03', right, pitch * 0.45);
      this.rotateBoneWorld('Head', right, pitch * 0.1);
    }
    // Weapon offsets: swap dips the gun, kick pushes it back along the barrel
    if (this.pistol) {
      // UAL pistol clips hold the hand differently from the rifle socket: point the barrel along the aim
      // direction (lowered when not aiming) in world space, then express it in the socket frame.
      const pitch = THREE.MathUtils.lerp(-0.9, THREE.MathUtils.clamp(camPitch, -1.1, 1.1), this.aimBlend) - pose.swap * 1.2 + pose.kick * 0.25;
      _q2.setFromEuler(_e.set(pitch, this.yaw, 0, 'YXZ'));
      this.socket.getWorldQuaternion(_q).invert();
      this.gunMount.quaternion.copy(_q.multiply(_q2));
    } else {
      // Rifles: the authored Rifle_* clips put the socket right when aiming, but the unarmed UAL
      // locomotion clips (jog/sprint/crouch) swing the hand so the barrel points at the sky.
      // Outside ADS, hold the rifle at low-ready in world space (forward, angled down) and blend
      // back to the socket's own orientation as aim comes in.
      const lowReady = -0.55 - pose.swap * 1.2;
      _q2.setFromEuler(_e.set(lowReady, this.yaw, 0, 'YXZ'));
      this.socket.getWorldQuaternion(_q).invert();
      const world = _q.multiply(_q2);
      const aimed = _q3.setFromEuler(_e.set(-pose.swap * 1.2, 0, 0));
      this.gunMount.quaternion.copy(world).slerp(aimed, this.aimBlend);
    }
    this.gunMount.position.z = pose.kick * 0.06;
  }

  private upperW = new Map<string, number>();
  private driveUpper(clip: string, scrub: number, dt: number, damp: (r: number) => number): void {
    for (const [name, s] of this.slots) {
      const target = name === clip ? 1 : 0;
      let w = this.upperW.get(name) ?? 0;
      w += (target - w) * damp(12);
      if (w < 0.002) w = 0;
      this.upperW.set(name, w);
      if (name === clip) s.upperTime = scrub >= 0 ? scrub * s.clip.duration : wrap((s.upperTime ?? 0) + dt, s.clip.duration);
      this.setW(s, 'upper', w * this.upperK);
    }
  }

  private setW(s: Slot, layer: Layer, w: number): void {
    const a = s.actions[layer]!;
    if (w > 0.001) {
      if (!a.enabled || !a.isRunning()) a.play();
      a.enabled = true;
      a.setEffectiveWeight(w);
    } else if (a.enabled && a.isRunning()) {
      a.stop();
    }
  }

  private clipDur(name: string): number {
    return this.slots.get(name)?.clip.duration ?? 1;
  }

  /** Rotates a bone about a world-space axis (post-mixer). */
  private rotateBoneWorld(name: string, axisWorld: THREE.Vector3, angle: number): void {
    const b = this.bones[name];
    if (!b) return;
    b.getWorldQuaternion(_q).invert();
    const axisLocal = _v.copy(axisWorld).applyQuaternion(_q).normalize();
    b.quaternion.multiply(_q2.setFromAxisAngle(axisLocal, angle));
    b.updateMatrixWorld(true);
  }
}

interface Slot {
  upperTime?: number;
}

function wrap(t: number, d: number): number {
  return ((t % d) + d) % d;
}

/** Tints the textured suit toward the raider palette (keeps texture detail by blending with white). */
function tint(m: THREE.MeshStandardMaterial, pal: Palette): void {
  const n = m.name.toLowerCase();
  const white = new THREE.Color(1, 1, 1);
  const pick = n.includes('torso') || n.includes('pants') ? [pal.suit, 0.6] : n.includes('helmet') ? [pal.accent, 0.35] : [pal.dark, 0.45];
  m.color.copy(white).lerp(new THREE.Color(pick[0] as string).multiplyScalar(1.6), pick[1] as number);
}

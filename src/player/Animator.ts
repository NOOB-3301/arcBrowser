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
const PROC_BONES = [
  'pelvis', 'spine_01', 'spine_02', 'spine_03', 'Head',
  // two-hand weapon IK writes these
  'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r',
];
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p3 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
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
  // ---- two-hand rifle IK (calibrated from the authored Rifle_Aim pose) ----
  /** Hands in weapon space (weapon space = socket frame in the authored aim pose). */
  private gripR: THREE.Matrix4 | null = null;
  private gripL: THREE.Matrix4 | null = null;
  /** Weapon transform in spine_03 space for the authored aim pose. */
  private aimRel: THREE.Matrix4 | null = null;
  private ikK = 0;
  private sprintK = 0;

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
        if (m.isSkinnedMesh) fixFingerWeights(m);
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
    this.calibrateGrips();
    scene.add(this.root);
  }

  /**
   * Sample the authored Rifle_Aim pose once and record where both hands sit relative to the
   * rifle, and where the rifle sits relative to the chest. Every held pose (low-ready, sprint,
   * aim) is then placed procedurally and the arms are solved to those grips, so the hands are
   * always on the gun whatever the legs are doing.
   */
  private calibrateGrips(): void {
    const s = this.slots.get('Rifle_Aim');
    const chest = this.bones.spine_03;
    const hl = this.bones.hand_l;
    const hr = this.bones.hand_r;
    if (!s || !chest || !hl || !hr) return;
    const a = s.actions.full!;
    a.play(); // actions only affect the pose while playing
    a.setEffectiveWeight(1);
    a.time = 0;
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
    const weaponInv = _m1.copy(this.socket.matrixWorld).invert();
    this.gripL = new THREE.Matrix4().multiplyMatrices(weaponInv, hl.matrixWorld);
    this.gripR = new THREE.Matrix4().multiplyMatrices(weaponInv, hr.matrixWorld);
    this.aimRel = new THREE.Matrix4().multiplyMatrices(_m2.copy(chest.matrixWorld).invert(), this.socket.matrixWorld);
    a.stop();
    this.mixer.update(0);
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
    // Weapon arm pose only while aiming / hip-firing (p.aiming) or reloading. Otherwise the
    // locomotion clip drives the whole body so arms hang and swing naturally (the authored
    // Rifle_Idle tucks the arms into the chest on this mesh); the rifle is held at low-ready.
    const rifleIK = hasGun && !this.pistol && !!this.gripR;
    const wantUpper = canAim && (rifleIK ? pose.reload >= 0 : p.aiming || pose.reload >= 0);
    const ikTarget = rifleIK && !fullBody && !this.dead && pose.reload < 0 ? 1 : 0;
    this.ikK += (ikTarget - this.ikK) * damp(12);
    this.sprintK += ((p.locomotion === 'sprint' && !p.aiming ? 1 : 0) - this.sprintK) * damp(8);
    this.upperK += ((wantUpper ? 1 : 0) - this.upperK) * damp(10);
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
      const pitch = THREE.MathUtils.clamp(camPitch, -1.1, 1.1) * (0.05 + 0.95 * this.aimBlend);
      const kick = pose.kick * 0.06;
      this.rotateBoneWorld('spine_02', right, pitch * 0.45 + kick);
      this.rotateBoneWorld('spine_03', right, pitch * 0.45);
      this.rotateBoneWorld('Head', right, pitch * 0.1);
    }
    // Arms driven by the locomotion clip (unarmed / pistol at rest): the clip's arms clip into the bulky
    // armoured torso, so hold the upper arms out a little and soften the elbows.
    const relaxW = (fullBody || this.dead ? 0 : 1) * (1 - this.ikK) * (1 - this.upperK);
    if (relaxW > 0.01) this.relaxArms(relaxW);
    // Weapon offsets: swap dips the gun, kick pushes it back along the barrel
    if (this.pistol) {
      // UAL pistol clips hold the hand differently from the rifle socket: point the barrel along the aim
      // direction (lowered when not aiming) in world space, then express it in the socket frame.
      const pitch = THREE.MathUtils.lerp(-0.9, THREE.MathUtils.clamp(camPitch, -1.1, 1.1), this.aimBlend) - pose.swap * 1.2 + pose.kick * 0.25;
      _q2.setFromEuler(_e.set(pitch, this.yaw, 0, 'YXZ'));
      this.socket.getWorldQuaternion(_q).invert();
      this.gunMount.quaternion.copy(_q.multiply(_q2));
    } else if (this.ikK > 0.001 && this.gripR && this.gripL && this.aimRel) {
      this.solveRifle(camPitch, pose);
    } else {
      this.gunMount.quaternion.identity();
      this.gunMount.position.set(0, 0, 0);
    }
    if (this.pistol) this.gunMount.position.z = pose.kick * 0.06;
  }

  /** Place the rifle (aim / low-ready / sprint port-arms blend) and solve both arms onto it. */
  private solveRifle(camPitch: number, pose: CombatPose): void {
    const chest = this.bones.spine_03;
    this.root.updateMatrixWorld(true);
    const up = _up;
    const rootQ = this.root.getWorldQuaternion(_q3);
    const right = _p3.set(1, 0, 0).applyQuaternion(rootQ);

    // Authored aim pose, following the (procedurally pitched) chest
    const W = _m1.multiplyMatrices(chest.matrixWorld, this.aimRel!);
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    W.decompose(pos, q, _s1);
    // Make the barrel (-Z) point exactly along the aim direction when aiming
    const aimDir = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(camPitch), Math.sin(camPitch), -Math.cos(this.yaw) * Math.cos(camPitch));
    const barrel = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const qAim = new THREE.Quaternion().setFromUnitVectors(barrel, aimDir).multiply(q);

    // Held poses are built in the character's frame (not from the aim pose): the reference
    // "patrol carry" has the grip at the right hip and the rifle level across the body, barrel
    // pointing forward-left; the left hand lands on the handguard via the calibrated grip.
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    // Upright rifle pointing straight ahead (roll from the authored grip is kept)
    const qFlat = new THREE.Quaternion().setFromUnitVectors(barrel.clone(), fwd).multiply(q);
    const hips = (this.bones.pelvis ?? chest).getWorldPosition(new THREE.Vector3());
    const carry = (yawA: number, pitchA: number, height: number, out: number, side: number) => {
      const qy = new THREE.Quaternion().setFromAxisAngle(up, yawA);
      const r2 = right.clone().applyQuaternion(qy);
      const qp = new THREE.Quaternion().setFromAxisAngle(r2, pitchA);
      return {
        p: hips.clone().addScaledVector(up, height).addScaledVector(fwd, out).addScaledVector(right, side),
        q: qp.multiply(qy).multiply(qFlat),
      };
    };
    const low = carry(0.75, -0.2, 0.06, 0.16, 0.2); // patrol carry: grip at right hip, barrel level forward-left
    const port = carry(0.85, 0.55, 0.32, 0.18, 0.12); // sprint: raised across the chest, barrel up
    const held = { p: low.p.clone().lerp(port.p, this.sprintK), q: low.q.clone().slerp(port.q, this.sprintK) };
    const fp = held.p.clone().lerp(pos, this.aimBlend);
    const fq = held.q.clone().slerp(qAim, this.aimBlend);
    // Swap dips the gun, kick pushes it back along the barrel
    if (pose.swap > 0) fq.premultiply(new THREE.Quaternion().setFromAxisAngle(right, -pose.swap * 1.1));
    fp.addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(fq), pose.kick * 0.05);
    const target = _m2.compose(fp, fq, _s1.set(1, 1, 1));

    // Hands: blend from the animated pose to the grips by ikK
    const k = this.ikK;
    this.solveArm('r', new THREE.Matrix4().multiplyMatrices(target, this.gripR!), k, right);
    this.solveArm('l', new THREE.Matrix4().multiplyMatrices(target, this.gripL!), k, right);

    // Weapon follows the target (expressed in the post-IK socket frame)
    this.socket.updateMatrixWorld(true);
    const local = new THREE.Matrix4().multiplyMatrices(_m1.copy(this.socket.matrixWorld).invert(), target);
    local.decompose(this.gunMount.position, this.gunMount.quaternion, _s1);
    if (k < 0.999) {
      this.gunMount.position.multiplyScalar(k);
      this.gunMount.quaternion.slerp(_q.identity(), 1 - k);
    }
  }

  /** Analytic two-bone IK (upperarm → lowerarm → hand) with an elbow pole down/outward. */
  private solveArm(side: 'l' | 'r', target: THREE.Matrix4, k: number, right: THREE.Vector3): void {
    const upper = this.bones[`upperarm_${side}`];
    const lower = this.bones[`lowerarm_${side}`];
    const hand = this.bones[`hand_${side}`];
    if (!upper || !lower || !hand) return;
    const tPos = new THREE.Vector3();
    const tQ = new THREE.Quaternion();
    target.decompose(tPos, tQ, _s1);
    const h0 = hand.getWorldPosition(new THREE.Vector3());
    const handQ0 = hand.getWorldQuaternion(new THREE.Quaternion());
    tPos.lerpVectors(h0, tPos, k);
    tQ.slerpQuaternions(handQ0, tQ, k);

    const S = upper.getWorldPosition(new THREE.Vector3());
    const E0 = lower.getWorldPosition(new THREE.Vector3());
    const a = E0.distanceTo(S);
    const b = h0.distanceTo(E0);
    const toT = tPos.clone().sub(S);
    const d = THREE.MathUtils.clamp(toT.length(), 0.05, a + b - 0.002);
    const dir = toT.normalize();
    const sgn = side === 'r' ? 1 : -1;
    // Elbows down and well out from the body (avoid arms tucking into the torso)
    const pole = new THREE.Vector3(0, -0.7, 0).addScaledVector(right, 1.0 * sgn);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const E = S.clone().addScaledVector(dir, a * cosA).addScaledVector(pole, a * sinA);

    this.aimBone(upper, E0.clone().sub(S), E.clone().sub(S));
    const E1 = lower.getWorldPosition(new THREE.Vector3());
    const H1 = hand.getWorldPosition(new THREE.Vector3());
    this.aimBone(lower, H1.sub(E1), tPos.clone().sub(E1));
    // Hand orientation from the calibrated grip
    const parentQ = hand.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    hand.quaternion.copy(parentQ.multiply(tQ));
    hand.updateMatrixWorld(true);
  }

  /** Keep the arms clear of the bulky torso (keeps fore/aft swing) with a slight elbow bend. */
  private relaxArms(w: number): void {
    this.model.updateMatrixWorld(true);
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rootQ);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rootQ);
    for (const side of ['l', 'r'] as const) {
      const upper = this.bones[`upperarm_${side}`];
      const lower = this.bones[`lowerarm_${side}`];
      const hand = this.bones[`hand_${side}`];
      if (!upper || !lower || !hand) continue;
      const out = right.clone().multiplyScalar(side === 'r' ? 1 : -1);
      const S = upper.getWorldPosition(new THREE.Vector3());
      const E = lower.getWorldPosition(new THREE.Vector3());
      const d = E.clone().sub(S).normalize();
      // This mesh's armour is much bulkier than the UAL skeleton it was skinned to, so the clip's
      // arms sink into the torso. Hold the upper arm at least ~25° out from the body (keeps swing).
      const lat = d.dot(out);
      const want = d.clone();
      if (lat < 0.42) want.addScaledVector(out, (0.42 - lat) * w);
      want.normalize();
      this.aimBone(upper, d, want);
      // Forearm: hang along the upper arm, bent ~20° forward, hands close to the thighs
      const E1 = lower.getWorldPosition(new THREE.Vector3());
      const H1 = hand.getWorldPosition(new THREE.Vector3());
      const f = H1.clone().sub(E1).normalize();
      const fWant = want.clone().addScaledVector(fwd, 0.35).addScaledVector(out, -0.12).normalize();
      this.aimBone(lower, f, f.clone().lerp(fWant, 0.8 * w));
    }
  }

  /** Rotate a bone (in world space) so its child direction `from` points along `to`. */
  private aimBone(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3): void {
    if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
    const dq = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const worldQ = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(dq);
    const parentQ = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    bone.quaternion.copy(parentQ.multiply(worldQ));
    bone.updateMatrixWorld(true);
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
/**
 * The glove mesh has a few vertex islands skinned rigidly to finger bones that don't match its
 * shape; the UAL clips curl those bones and fling the verts out as a blade-like spike. Rebind any
 * finger influence to the hand. Geometry is shared between clones, so this runs once per asset.
 */
function fixFingerWeights(m: THREE.SkinnedMesh): void {
  const g = m.geometry;
  if (g.userData.fingersFixed) return;
  g.userData.fingersFixed = true;
  const bones = m.skeleton.bones;
  const remap = bones.map((b, i) => {
    const hit = /^(thumb|index|middle|ring|pinky)_\d+(?:_leaf)?_([lr])$/.exec(b.name);
    if (!hit || hit[1] === 'thumb') return i;
    const hand = bones.findIndex((x) => x.name === `hand_${hit[2]}`);
    return hand >= 0 ? hand : i;
  });
  const si = g.attributes.skinIndex;
  if (!si) return;
  for (let v = 0; v < si.count; v++) {
    for (let k = 0; k < 4; k++) {
      const b = si.getComponent(v, k);
      if (remap[b] !== b) si.setComponent(v, k, remap[b]);
    }
  }
  si.needsUpdate = true;
}

function tint(m: THREE.MeshStandardMaterial, pal: Palette): void {
  const n = m.name.toLowerCase();
  const white = new THREE.Color(1, 1, 1);
  const pick = n.includes('torso') || n.includes('pants') ? [pal.suit, 0.6] : n.includes('helmet') ? [pal.accent, 0.35] : [pal.dark, 0.45];
  m.color.copy(white).lerp(new THREE.Color(pick[0] as string).multiplyScalar(1.6), pick[1] as number);
}

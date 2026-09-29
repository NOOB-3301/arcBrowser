import * as THREE from 'three';
import type { Input } from '../core/Input';
import { Events } from '../core/Events';
import { Settings } from '../core/Settings';
import type { Physics } from '../physics/Physics';
import type { PlayerController } from '../player/PlayerController';

/** Spring-arm framing presets. dist = boom length, side = shoulder offset, up = extra height. */
const FRAME = {
  hip: { dist: 2.6, side: 0.78, up: 0.16 },
  ads: { dist: 1.9, side: 1.0, up: 0.22 },
  sprint: { dist: 3.0, side: 0.65, up: 0.12 },
  crouch: { dist: 2.3, side: 0.75, up: 0.25 },
};
const EYE_STAND = 1.58;
const EYE_CROUCH = 1.02;
const PROBE_RADIUS = 0.22;
const PITCH_MIN = -1.35;
const PITCH_MAX = 1.2;

/**
 * Arc-style over-the-shoulder camera: spring arm with collision, shoulder swap,
 * ADS zoom, sprint FOV kick, landing dip, trauma shake and free-look.
 */
export class CameraRig {
  /** Look direction (camera), radians. */
  yaw = 0;
  pitch = -0.12;
  /** 1 = right shoulder, -1 = left. */
  shoulder = 1;
  firstPerson = false;
  /** 0..1 ADS blend. */
  ads = 0;
  readonly aimPoint = new THREE.Vector3();

  private shoulderBlend = 1;
  private freeLookYaw = 0;
  private freeLookPitch = 0;
  private freeLooking = false;
  private armLength = FRAME.hip.dist;
  private pivot = new THREE.Vector3();
  private pivotY = 0;
  private eyeHeight = EYE_STAND;
  private fov = 75;
  private trauma = 0;
  private dip = 0;
  private dipVel = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private time = 0;
  private sprintBlend = 0;
  private crouchBlend = 0;
  private initialised = false;
  /** Current weapon magnification and ADS time (set by combat). */
  zoom = 1.3;
  adsTime = 0.25;
  /** True while looking through a high-magnification scope. */
  scoped = false;

  constructor(private camera: THREE.PerspectiveCamera, private physics: Physics) {
    this.fov = Settings.get('fov');
    Events.on('player:land', ({ speed }: { speed: number }) => {
      if (speed > 3) this.dipVel -= Math.min(speed * 0.12, 1.6);
      if (speed > 9) this.addTrauma(Math.min((speed - 9) * 0.06, 0.5));
    });
  }

  /** Movement reference yaw (frozen while free-looking). */
  get moveYaw(): number {
    return this.yaw;
  }

  /** Per-frame look + mode input. Call before player.frameInput. */
  handleInput(input: Input, dt: number, aiming: boolean, assist?: { sensScale: number; yaw: number; pitch: number }): void {
    if (input.pressed('swapShoulder')) this.shoulder *= -1;
    if (input.pressed('toggleView')) this.firstPerson = !this.firstPerson;

    // Higher zoom → proportionally slower look so aim feels consistent
    const zoomSens = 1 / Math.max(1, Math.pow(this.zoom, 0.6 * this.ads));
    const sens = (1 - this.ads * (1 - Settings.get('adsSensitivityMultiplier'))) * zoomSens * (assist?.sensScale ?? 1);
    const lx = input.lookX * sens;
    const ly = input.lookY * sens;

    this.freeLooking = input.down('freeLook') && !aiming;
    if (this.freeLooking) {
      this.freeLookYaw -= lx;
      this.freeLookPitch = THREE.MathUtils.clamp(this.freeLookPitch - ly, PITCH_MIN - this.pitch, PITCH_MAX - this.pitch);
      this.freeLookYaw = THREE.MathUtils.clamp(this.freeLookYaw, -2.4, 2.4);
    } else {
      this.yaw -= lx;
      this.pitch = THREE.MathUtils.clamp(this.pitch - ly, PITCH_MIN, PITCH_MAX);
      if (assist) {
        this.yaw += assist.yaw;
        this.pitch = THREE.MathUtils.clamp(this.pitch + assist.pitch, PITCH_MIN, PITCH_MAX);
      }
      // Ease free-look back to centre
      const k = 1 - Math.exp(-10 * dt);
      this.freeLookYaw -= this.freeLookYaw * k;
      this.freeLookPitch -= this.freeLookPitch * k;
    }
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Weapon recoil kick (radians), recovers over time. Applied to real aim. */
  kick(pitch: number, yaw: number): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch, PITCH_MIN, PITCH_MAX);
    this.yaw += yaw;
    this.recoilPitch += pitch * 0.5;
    this.recoilYaw += yaw * 0.5;
  }

  update(dt: number, player: PlayerController, aimingInput: boolean, playerMesh?: THREE.Object3D): void {
    this.time += dt;
    const damp = (rate: number) => 1 - Math.exp(-rate * dt);

    // --- blends
    const canAds = aimingInput && player.state !== 'roll' && player.state !== 'ladder' && player.state !== 'zipline' && player.state !== 'mantle';
    // ADS speed from weapon handling: ~95% blended after adsTime
    this.ads += ((canAds ? 1 : 0) - this.ads) * damp(3 / Math.max(0.08, this.adsTime));
    this.scoped = this.zoom >= 3 && this.ads > 0.85 && !this.firstPerson;
    this.sprintBlend += ((player.locomotion === 'sprint' ? 1 : 0) - this.sprintBlend) * damp(5);
    this.crouchBlend += ((player.crouched && player.state !== 'roll' ? 1 : 0) - this.crouchBlend) * damp(9);
    this.shoulderBlend += (this.shoulder - this.shoulderBlend) * damp(10);

    // --- pivot (smoothed vertically to hide stair steps)
    const feet = player.renderFeet();
    const eyeTarget = THREE.MathUtils.lerp(EYE_STAND, EYE_CROUCH, this.crouchBlend);
    this.eyeHeight += (eyeTarget - this.eyeHeight) * damp(12);
    if (!this.initialised) {
      this.pivotY = feet.y;
      this.initialised = true;
    }
    this.pivotY += (feet.y - this.pivotY) * damp(player.grounded ? 18 : 30);
    if (Math.abs(feet.y - this.pivotY) > 1.5) this.pivotY = feet.y;

    // Landing dip spring: fixed sub-steps (semi-implicit) so frame hitches can't blow it up
    for (let rem = Math.min(dt, 0.1); rem > 1e-6; rem -= 1 / 240) {
      const h = Math.min(rem, 1 / 240);
      this.dipVel += (-this.dip * 120 - this.dipVel * 14) * h;
      this.dip += this.dipVel * h;
    }
    this.dip = THREE.MathUtils.clamp(this.dip, -2, 2);
    this.pivot.set(feet.x, this.pivotY + this.eyeHeight + this.dip * 0.12, feet.z);

    // --- orientation
    const shakeAmt = this.trauma * this.trauma;
    const shakeYaw = shakeAmt * 0.06 * Math.sin(this.time * 37.1 + 1.3) * Math.sin(this.time * 13.7);
    const shakePitch = shakeAmt * 0.05 * Math.sin(this.time * 31.3) * Math.cos(this.time * 17.9);
    const shakeRoll = shakeAmt * 0.04 * Math.sin(this.time * 23.5 + 0.7);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    this.recoilPitch -= this.recoilPitch * damp(10);
    this.recoilYaw -= this.recoilYaw * damp(10);

    const yaw = this.yaw + this.freeLookYaw + shakeYaw;
    const pitch = this.pitch + this.freeLookPitch + shakePitch + this.recoilPitch * 0.3;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, shakeRoll, 'YXZ'));
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

    if (this.firstPerson) {
      this.camera.position.copy(this.pivot).addScaledVector(forward, 0.25);
      this.camera.quaternion.copy(q);
      if (playerMesh) playerMesh.visible = false;
    } else {
      if (playerMesh) playerMesh.visible = true;
      // --- spring arm framing
      const base = this.lerpFrame(FRAME.hip, FRAME.crouch, this.crouchBlend);
      const withSprint = this.lerpFrame(base, FRAME.sprint, this.sprintBlend * (1 - this.ads));
      const frame = this.lerpFrame(withSprint, FRAME.ads, this.ads);

      // Shoulder point (collision-checked sideways first so we never clip into a wall beside us)
      const sideDir = right.clone().setY(0).normalize().multiplyScalar(this.shoulderBlend);
      const origin = this.pivot.clone().addScaledVector(new THREE.Vector3(0, 1, 0), frame.up);
      let side = frame.side;
      const sideHit = this.physics.sphereCast(origin, sideDir, PROBE_RADIUS, side, player.collider);
      if (sideHit !== null) side = Math.max(0, sideHit - 0.05);
      const shoulderPt = origin.clone().addScaledVector(sideDir, side);

      // Boom back
      const back = forward.clone().negate();
      let dist = frame.dist;
      const hit = this.physics.sphereCast(shoulderPt, back, PROBE_RADIUS, dist, player.collider);
      if (hit !== null) dist = Math.max(0.2, hit - 0.05);
      // Snap in instantly, ease out slowly
      // Pull in quickly but smoothly (instant snaps judder on slopes/grass edges); only hard-snap
      // when the obstacle is right on top of the camera. Ease back out slowly.
      if (dist < this.armLength) {
        this.armLength = this.armLength - dist > 0.8 && dist < 0.9 ? dist : this.armLength + (dist - this.armLength) * damp(28);
      } else {
        this.armLength += (dist - this.armLength) * damp(5);
      }

      this.camera.position.copy(shoulderPt).addScaledVector(back, this.armLength);
      this.camera.quaternion.copy(q);

      // Hide the character if the camera is inside it, or when scoped in
      if (playerMesh) playerMesh.visible = this.armLength > 0.55 && !this.scoped;
    }

    // --- FOV
    const baseFov = Settings.get('fov');
    const adsFov = baseFov / this.zoom;
    const targetFov = THREE.MathUtils.lerp(baseFov, adsFov, this.ads) + 7 * this.sprintBlend * (1 - this.ads);
    this.fov += (targetFov - this.fov) * damp(10);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // --- aim point: what the crosshair is over (weapons converge here from the muzzle)
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const aimHit = this.physics.raycast(this.camera.position, camFwd, 800, player.collider);
    this.aimPoint.copy(aimHit ? aimHit.point : this.camera.position.clone().addScaledVector(camFwd, 800));
  }

  private lerpFrame(a: typeof FRAME.hip, b: typeof FRAME.hip, t: number): typeof FRAME.hip {
    return {
      dist: THREE.MathUtils.lerp(a.dist, b.dist, t),
      side: THREE.MathUtils.lerp(a.side, b.side, t),
      up: THREE.MathUtils.lerp(a.up, b.up, t),
    };
  }
}

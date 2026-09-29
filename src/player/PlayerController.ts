import * as THREE from 'three';
import { RAPIER, Groups, interactionGroups, type Physics } from '../physics/Physics';
import type { Input } from '../core/Input';
import { Events } from '../core/Events';
import { FIXED_DT } from '../core/Time';
import type { Ladder, Traversal } from '../world/Traversal';
import { Stamina } from './Stamina';
import { NoiseRadius, Tuning as T, type MoveState } from './MovementStates';

export type Locomotion = 'idle' | 'walk' | 'jog' | 'sprint' | 'crouch';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function yawToDir(yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}
function dirToYaw(d: THREE.Vector3): number {
  return Math.atan2(-d.x, -d.z);
}
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function approach(cur: number, target: number, maxDelta: number): number {
  return cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target);
}

interface MantlePath {
  points: THREE.Vector3[];
  durations: number[];
  t: number;
  seg: number;
  exitVel: THREE.Vector3;
  endCrouched: boolean;
  vault: boolean;
}

/**
 * Third-person raider movement on a Rapier kinematic character controller.
 * Frame input is buffered in frameInput(); simulation runs in step() at FIXED_DT.
 */
export class PlayerController {
  readonly stamina = new Stamina();
  state: MoveState = 'air';
  locomotion: Locomotion = 'idle';
  crouched = false;
  grounded = false;
  aiming = false;
  /** Character body yaw (visual + aim), radians. */
  facingYaw = 0;
  readonly velocity = new THREE.Vector3();
  /** 0..1 progress of timed actions, for animation. */
  actionT = 0;
  ladder: Ladder | null = null;
  /** Encumbrance 0..1 — scales speeds and regen (loot tension, M6). */
  encumbrance = 0;
  /** Weapon-weight speed multiplier (set by combat). */
  speedMult = 1;

  // Capsule centre, current and previous fixed step (for render interpolation)
  readonly center = new THREE.Vector3();
  private prevCenter = new THREE.Vector3();
  readonly renderCenter = new THREE.Vector3();
  halfHeight = T.standHalfHeight;

  readonly collider: RAPIER.Collider;
  private body: RAPIER.RigidBody;
  private cc: RAPIER.KinematicCharacterController;

  // Buffered frame input
  private moveInput = new THREE.Vector2();
  private moveYaw = 0;
  private aimYaw = 0;
  private sprintHeld = false;
  private jumpHeld = false;
  private padSprintLatch = false;
  private jumpBufferT = 0;
  /** Longer buffer so an early jump press still mantles/vaults on reaching the wall. */
  private mantleBufferT = 0;
  private crouchPressed = false;
  private dodgeBufferT = 0;
  private interactPressed = false;

  // Timers
  private coyoteT = 0;
  private rollT = 0;
  private rollCooldownT = 0;
  private slideT = 0;
  private slideAirT = 0;
  private snapDisabled = false;
  private slideCooldownT = 0;
  private ladderCooldownT = 0;
  private noiseT = 0;
  private airPeakFallSpeed = 0;

  private rollDir = new THREE.Vector3();
  private mantle: MantlePath | null = null;
  private zip: { from: THREE.Vector3; to: THREE.Vector3; s: number; len: number; speed: number } | null = null;

  constructor(private physics: Physics, private traversal: Traversal, spawnFeet: THREE.Vector3) {
    const world = physics.world;
    this.center.copy(spawnFeet).y += this.halfHeight + T.capsuleRadius;
    this.prevCenter.copy(this.center);
    this.renderCenter.copy(this.center);

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.center.x, this.center.y, this.center.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(this.halfHeight, T.capsuleRadius).setCollisionGroups(
        interactionGroups(Groups.PLAYER, 0xffff),
      ),
      this.body,
    );
    this.cc = world.createCharacterController(0.02);
    this.cc.enableAutostep(0.45, 0.25, false);
    this.cc.enableSnapToGround(0.35);
    this.cc.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(48));
    this.cc.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(55));
    this.cc.setApplyImpulsesToDynamicBodies(true);
    this.cc.setCharacterMass(80);
  }

  // =================================================================== frame

  /** Buffer this frame's input. moveYaw = camera yaw movement is relative to. */
  frameInput(input: Input, moveYaw: number, aimYaw: number, aiming: boolean, dt: number): void {
    this.moveInput.set(input.moveX, input.moveY);
    this.moveYaw = moveYaw;
    this.aimYaw = aimYaw;
    this.aiming = aiming;

    // KB: hold to sprint. Pad: click L3 to latch sprint until stopping.
    if (input.activeDevice === 'gamepad') {
      if (input.pressed('sprint')) this.padSprintLatch = !this.padSprintLatch;
      if (this.moveInput.length() < 0.3 || aiming) this.padSprintLatch = false;
      this.sprintHeld = this.padSprintLatch;
    } else {
      this.sprintHeld = input.down('sprint');
      this.padSprintLatch = false;
    }

    this.jumpHeld = input.down('jump');
    this.mantleBufferT = input.pressed('jump') ? 0.45 : Math.max(0, this.mantleBufferT - dt);
    this.jumpBufferT = input.pressed('jump') ? T.jumpBuffer : Math.max(0, this.jumpBufferT - dt);
    this.dodgeBufferT = input.pressed('dodge') ? 0.15 : Math.max(0, this.dodgeBufferT - dt);
    if (input.pressed('crouch')) this.crouchPressed = true;
    if (input.pressed('interact')) this.interactPressed = true;
  }

  /** Cancel sprint latch externally (e.g. firing). */
  breakSprint(): void {
    this.padSprintLatch = false;
    this.sprintHeld = false;
  }

  // =================================================================== fixed step

  step(): void {
    const dt = FIXED_DT;
    this.prevCenter.copy(this.center);
    this.tickTimers(dt);

    switch (this.state) {
      case 'mantle':
        this.stepMantle(dt);
        break;
      case 'ladder':
        this.stepLadder(dt);
        break;
      case 'zipline':
        this.stepZipline(dt);
        break;
      case 'roll':
        this.stepRoll(dt);
        break;
      case 'slide':
        this.stepSlide(dt);
        break;
      default:
        this.stepLocomotion(dt);
    }

    this.updateFacing(dt);
    this.stamina.regenMultiplier = 1 - this.encumbrance * 0.5;
    this.stamina.update(dt);
    this.emitFootsteps(dt);

    // One-shot inputs are consumed per step
    this.crouchPressed = false;
    this.interactPressed = false;
  }

  private tickTimers(dt: number): void {
    this.coyoteT = Math.max(0, this.coyoteT - dt);
    this.rollCooldownT = Math.max(0, this.rollCooldownT - dt);
    this.slideCooldownT = Math.max(0, this.slideCooldownT - dt);
    this.ladderCooldownT = Math.max(0, this.ladderCooldownT - dt);
  }

  // ------------------------------------------------------------------- ground + air

  private wishDir(out: THREE.Vector3): number {
    const fwd = yawToDir(this.moveYaw, _w);
    const right = _v.set(-fwd.z, 0, fwd.x);
    out.copy(fwd).multiplyScalar(this.moveInput.y).addScaledVector(right, this.moveInput.x);
    const mag = Math.min(out.length(), 1);
    if (mag > 1e-3) out.normalize();
    return mag;
  }

  private stepLocomotion(dt: number): void {
    const wish = new THREE.Vector3();
    const mag = this.wishDir(wish);
    const moving = mag > 0.1;

    // --- transitions available from ground/air
    if (this.interactPressed && this.tryZipline()) return;
    if (this.ladderCooldownT <= 0 && this.tryLadder(wish, moving)) return;
    const wantsMantle = this.jumpBufferT > 0 || this.mantleBufferT > 0 || (!this.grounded && this.jumpHeld && moving);
    if (wantsMantle && this.tryMantle(wish, moving)) return;

    if (this.grounded) {
      if (this.dodgeBufferT > 0 && this.tryRoll(wish, moving)) return;
      if (this.crouchPressed) {
        const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        if (!this.crouched && hSpeed >= T.slideMinSpeed && this.slideCooldownT <= 0 && this.tryStartSlide()) return;
        this.setCrouched(!this.crouched);
      }
    }

    // --- speed selection
    const enc = 1 - this.encumbrance * 0.35;
    let target = T.jogSpeed * mag;
    let sprinting = false;
    if (this.crouched) target = T.crouchSpeed * mag;
    else if (this.aiming) target = T.walkSpeed * mag;
    else if (this.sprintHeld && moving && this.grounded && !this.stamina.exhausted) {
      target = T.sprintSpeed;
      sprinting = true;
    }
    if (this.aiming && moving) {
      // Moving against aim direction is slower
      const back = -wish.dot(yawToDir(this.aimYaw, _v));
      if (back > 0.3) target *= T.backwardMultiplier;
    }
    target *= enc * this.speedMult;

    // --- horizontal velocity
    const hv = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    if (this.grounded) {
      if (sprinting && hv.lengthSq() > 1) {
        // Weighty sprint: heading turns at a limited rate
        const cur = dirToYaw(hv);
        const want = dirToYaw(wish);
        const turned = cur + THREE.MathUtils.clamp(angleDelta(cur, want), -T.sprintTurnRate * dt, T.sprintTurnRate * dt);
        const speed = approach(hv.length(), target, T.groundAccel * dt);
        yawToDir(turned, hv).multiplyScalar(speed);
      } else {
        const desired = wish.clone().multiplyScalar(target);
        const diff = desired.sub(hv);
        const rate = (moving ? T.groundAccel : T.groundDecel) * dt;
        if (diff.length() > rate) diff.setLength(rate);
        hv.add(diff);
      }
      if (sprinting) this.stamina.drain(T.staminaSprint, dt);
    } else if (moving) {
      // Low air control: nudge toward wish, never exceeding current/jog speed
      const cap = Math.max(hv.length(), T.jogSpeed * 0.8);
      hv.addScaledVector(wish, T.airAccel * dt);
      if (hv.length() > cap) hv.setLength(cap);
    }
    this.velocity.x = hv.x;
    this.velocity.z = hv.z;

    // --- vertical
    if (this.grounded) {
      this.coyoteT = T.coyoteTime;
      if (this.velocity.y < 0) this.velocity.y = -2;
    }
    if (this.jumpBufferT > 0 && (this.grounded || this.coyoteT > 0)) {
      if (this.crouched) {
        if (this.canStand()) this.setCrouched(false);
      } else {
        this.stamina.spend(T.staminaJump);
        this.velocity.y = T.jumpVelocity * (1 - this.encumbrance * 0.2);
        this.grounded = false;
        this.coyoteT = 0;
        Events.emit('noise', { pos: this.feet(), radius: NoiseRadius.jog });
      }
      this.jumpBufferT = 0;
    }
    if (!this.grounded) this.velocity.y = Math.max(this.velocity.y - T.gravity * dt, -T.terminalVelocity);

    this.move(dt);

    this.locomotion = !moving || hv.length() < 0.3
      ? this.crouched ? 'crouch' : 'idle'
      : this.crouched ? 'crouch' : sprinting ? 'sprint' : this.aiming || target < 3 ? 'walk' : 'jog';
  }

  /** Apply velocity through the character controller and update grounded/landing. */
  private move(dt: number): void {
    const desired = this.velocity.clone().multiplyScalar(dt);
    // Ground snapping would eat the first frames of a jump; only snap when not rising
    const rising = this.velocity.y > 0;
    if (rising !== this.snapDisabled) {
      if (rising) this.cc.disableSnapToGround();
      else this.cc.enableSnapToGround(0.35);
      this.snapDisabled = rising;
    }
    this.cc.computeColliderMovement(this.collider, desired, undefined, interactionGroups(0xffff, ~Groups.PLAYER & 0xffff));
    const m = this.cc.computedMovement();
    this.center.x += m.x;
    this.center.y += m.y;
    this.center.z += m.z;
    this.body.setNextKinematicTranslation(this.center);

    // Blocked horizontally → bleed velocity so we don't "charge" into walls
    const dh = Math.hypot(desired.x, desired.z);
    const mh = Math.hypot(m.x, m.z);
    if (dh > 1e-4 && mh < dh * 0.6) {
      this.velocity.x = m.x / dt;
      this.velocity.z = m.z / dt;
    }
    if (this.velocity.y > 0 && m.y < desired.y * 0.5) this.velocity.y = 0; // head bump

    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded() && !rising;
    if (!this.grounded) this.airPeakFallSpeed = Math.max(this.airPeakFallSpeed, -this.velocity.y);
    if (this.grounded && !wasGrounded) this.onLand();
    if (this.state === 'air' || this.state === 'ground') this.state = this.grounded ? 'ground' : 'air';
  }

  private onLand(): void {
    const speed = this.airPeakFallSpeed;
    this.airPeakFallSpeed = 0;
    this.velocity.y = -2;
    Events.emit('player:land', { speed });
    if (speed > 6) Events.emit('noise', { pos: this.feet(), radius: NoiseRadius.land });
    if (speed > T.fallDamageSpeed) {
      Events.emit('player:fallDamage', { amount: (speed - T.fallDamageSpeed) * T.fallDamagePerMs });
    }
  }

  // ------------------------------------------------------------------- crouch

  private canStand(): boolean {
    const c = this.feet().addScaledVector(UP, T.standHalfHeight + T.capsuleRadius + 0.02);
    return this.physics.capsuleFree(c, T.standHalfHeight, T.capsuleRadius - 0.02, this.collider);
  }

  /** Resize the capsule keeping feet planted. Returns false if blocked. */
  setCrouched(on: boolean): boolean {
    if (on === this.crouched) return true;
    if (!on && !this.canStand()) return false;
    const h = on ? T.crouchHalfHeight : T.standHalfHeight;
    const dy = h - this.halfHeight;
    this.halfHeight = h;
    this.crouched = on;
    this.collider.setHalfHeight(h);
    this.center.y += dy;
    this.prevCenter.y += dy;
    this.renderCenter.y += dy;
    this.body.setTranslation(this.center, true);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
    return true;
  }

  // ------------------------------------------------------------------- slide

  private tryStartSlide(): boolean {
    if (!this.stamina.spend(T.staminaSlide)) return false;
    this.setCrouched(true);
    const hv = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    hv.setLength(hv.length() + T.slideBoost);
    this.velocity.x = hv.x;
    this.velocity.z = hv.z;
    this.state = 'slide';
    this.slideT = 0;
    this.slideAirT = 0;
    Events.emit('noise', { pos: this.feet(), radius: NoiseRadius.jog });
    return true;
  }

  private stepSlide(dt: number): void {
    this.slideT += dt;
    this.actionT = Math.min(this.slideT / T.slideMaxTime, 1);
    const hv = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    let speed = hv.length();
    const dir = speed > 1e-3 ? hv.clone().divideScalar(speed) : yawToDir(this.facingYaw);

    // Slope: accelerate downhill
    let downhill = 0;
    const hit = this.physics.raycast(this.center, new THREE.Vector3(0, -1, 0), this.halfHeight + T.capsuleRadius + 0.4, this.collider);
    if (hit && hit.normal.y < 0.995) {
      const n = hit.normal;
      downhill = new THREE.Vector3(n.x, 0, n.z).dot(dir); // >0 when heading downhill
    }
    speed += (downhill * T.slideSlopeAccel - T.slideFriction) * dt;

    // Light steering
    const wish = new THREE.Vector3();
    if (this.wishDir(wish) > 0.1) {
      const cur = dirToYaw(dir);
      const turned = cur + THREE.MathUtils.clamp(angleDelta(cur, dirToYaw(wish)), -1.2 * dt, 1.2 * dt);
      yawToDir(turned, dir);
    }
    hv.copy(dir).multiplyScalar(Math.max(speed, 0));
    this.velocity.x = hv.x;
    this.velocity.z = hv.z;
    if (!this.grounded) this.velocity.y -= T.gravity * dt;
    else if (this.velocity.y < 0) this.velocity.y = -2;

    this.move(dt);
    this.locomotion = 'crouch';

    const timeUp = this.slideT > T.slideMaxTime && downhill < 0.15;
    if (this.jumpBufferT > 0 && this.grounded) {
      // Slide-jump keeps momentum
      this.jumpBufferT = 0;
      this.endSlide();
      if (this.setCrouched(false)) {
        this.velocity.y = T.jumpVelocity;
        this.grounded = false;
        this.state = 'air';
        this.stamina.spend(T.staminaJump);
      }
    } else if (this.crouchPressed || speed < T.slideEndSpeed || timeUp) {
      this.endSlide();
      if (this.crouchPressed || this.sprintHeld) this.setCrouched(false);
    } else if (!this.grounded) {
      this.slideAirT += dt;
      if (this.slideAirT > 0.15) this.endSlide();
    } else {
      this.slideAirT = 0;
    }
  }

  private endSlide(): void {
    this.state = this.grounded ? 'ground' : 'air';
    this.slideCooldownT = T.slideCooldown;
    this.actionT = 0;
  }

  // ------------------------------------------------------------------- roll

  private tryRoll(wish: THREE.Vector3, moving: boolean): boolean {
    if (this.rollCooldownT > 0 || !this.stamina.spend(T.staminaRoll)) return false;
    this.dodgeBufferT = 0;
    this.rollDir.copy(moving ? wish : yawToDir(this.facingYaw));
    this.wasCrouchedBeforeRoll = this.crouched;
    this.setCrouched(true);
    this.state = 'roll';
    this.rollT = 0;
    this.facingYaw = dirToYaw(this.rollDir);
    Events.emit('noise', { pos: this.feet(), radius: NoiseRadius.jog });
    return true;
  }
  private wasCrouchedBeforeRoll = false;

  private stepRoll(dt: number): void {
    this.rollT += dt;
    const k = Math.min(this.rollT / T.rollTime, 1);
    this.actionT = k;
    const speed = T.rollSpeed * (1 - 0.65 * k * k) * (1 - this.encumbrance * 0.3);
    this.velocity.x = this.rollDir.x * speed;
    this.velocity.z = this.rollDir.z * speed;
    if (!this.grounded) this.velocity.y -= T.gravity * dt;
    this.move(dt);
    this.locomotion = 'crouch';
    if (k >= 1) {
      this.state = this.grounded ? 'ground' : 'air';
      this.rollCooldownT = T.rollCooldown;
      this.actionT = 0;
      if (!this.wasCrouchedBeforeRoll) this.setCrouched(false);
    }
  }

  // ------------------------------------------------------------------- mantle / vault

  /**
   * Probe for a climbable ledge ahead. Vault if the obstacle is low + thin and
   * we're moving fast; otherwise mantle up onto it.
   */
  private tryMantle(wish: THREE.Vector3, moving: boolean): boolean {
    const dir = moving ? wish.clone() : yawToDir(this.facingYaw);
    const feet = this.feet();
    const r = T.capsuleRadius;

    // Wall in front at knee..head height? Reach grows with speed so sprint-vaults feel generous.
    const reach = r + T.mantleReach + Math.min(this.horizontalSpeed * 0.12, 0.9);
    let wallDist = Infinity;
    for (const h of [0.45, 0.9, 1.4, 1.9]) {
      const hit = this.physics.raycast(feet.clone().setY(feet.y + h), dir, reach, this.collider);
      if (hit && Math.abs(hit.normal.y) < 0.5) wallDist = Math.min(wallDist, hit.distance);
    }
    if (!isFinite(wallDist)) return false;

    // Top surface: cast down just past the wall face
    const probe = feet.clone().addScaledVector(dir, wallDist + 0.25);
    probe.y += T.mantleMaxHeight + 0.4;
    const top = this.physics.raycast(probe, new THREE.Vector3(0, -1, 0), T.mantleMaxHeight + 0.4 - T.mantleMinHeight + 0.05, this.collider);
    if (!top || top.normal.y < 0.7) return false;
    const h = top.point.y - feet.y;
    if (h < T.mantleMinHeight || h > T.mantleMaxHeight) return false;
    if (h < 0.5 && this.grounded) return false; // autostep handles tiny lips

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    // Vault: low obstacle, fast, and ground drops away within vaultMaxDepth
    if (h <= T.vaultMaxHeight && hSpeed > 3.2 && !this.crouched) {
      const far = top.point.clone().addScaledVector(dir, T.vaultMaxDepth + r);
      far.y = top.point.y + 0.3;
      const land = this.physics.raycast(far, new THREE.Vector3(0, -1, 0), h + 1.5, this.collider);
      if (land && land.point.y < top.point.y - 0.4 && land.normal.y > 0.7) {
        const endC = land.point.clone().addScaledVector(UP, this.halfHeight + r + 0.02);
        const overC = top.point.clone().addScaledVector(dir, 0.25).addScaledVector(UP, this.halfHeight + r + 0.12);
        if (this.physics.capsuleFree(endC, this.halfHeight, r - 0.02, this.collider) &&
            this.physics.capsuleFree(overC, this.halfHeight, r - 0.05, this.collider)) {
          const exit = dir.clone().multiplyScalar(Math.max(hSpeed, T.jogSpeed));
          this.beginMantle([this.center.clone(), overC, endC], [0.16 + h * 0.08, 0.22], exit, false, true);
          return true;
        }
      }
    }

    // Mantle needs to be at the wall (a long reach only makes sense for vaults)
    if (wallDist > r + T.mantleReach) return false;

    // Mantle: need room to stand (or crouch) on top
    const onTop = top.point.clone().addScaledVector(dir, r + 0.1);
    const standC = onTop.clone().addScaledVector(UP, T.standHalfHeight + r + 0.03);
    const crouchC = onTop.clone().addScaledVector(UP, T.crouchHalfHeight + r + 0.03);
    let endCrouched = this.crouched;
    if (!this.physics.capsuleFree(standC, T.standHalfHeight, r - 0.02, this.collider)) {
      if (!this.physics.capsuleFree(crouchC, T.crouchHalfHeight, r - 0.02, this.collider)) return false;
      endCrouched = true;
    }
    // Path is in terms of the current capsule; crouch state resolves at the end
    const endC = onTop.clone().addScaledVector(UP, this.halfHeight + r + 0.03);
    if (!this.stamina.spend(T.staminaMantle) && h > 1.2) return false;
    const upC = this.center.clone();
    upC.y = endC.y + 0.05;
    this.beginMantle([this.center.clone(), upC, endC], [0.14 + h * 0.13, 0.2], new THREE.Vector3(), endCrouched, false);
    return true;
  }

  private beginMantle(points: THREE.Vector3[], durations: number[], exitVel: THREE.Vector3, endCrouched: boolean, vault: boolean): void {
    this.jumpBufferT = 0;
    this.mantleBufferT = 0;
    this.state = 'mantle';
    this.mantle = { points, durations, t: 0, seg: 0, exitVel, endCrouched, vault };
    this.velocity.set(0, 0, 0);
    this.airPeakFallSpeed = 0;
    const dir = points[points.length - 1].clone().sub(points[0]).setY(0);
    if (dir.lengthSq() > 1e-4) this.facingYaw = dirToYaw(dir.normalize());
    Events.emit('player:mantle', { vault });
  }

  private stepMantle(dt: number): void {
    const m = this.mantle!;
    m.t += dt;
    let d = m.durations[m.seg];
    while (m.t >= d && m.seg < m.durations.length - 1) {
      m.t -= d;
      m.seg++;
      d = m.durations[m.seg];
    }
    const k = Math.min(m.t / d, 1);
    const eased = 1 - (1 - k) * (1 - k);
    this.center.lerpVectors(m.points[m.seg], m.points[m.seg + 1], eased);
    this.body.setNextKinematicTranslation(this.center);
    const total = m.durations.reduce((a, b) => a + b, 0);
    const done = m.durations.slice(0, m.seg).reduce((a, b) => a + b, 0) + m.t;
    this.actionT = Math.min(done / total, 1);

    if (m.seg === m.durations.length - 1 && k >= 1) {
      this.mantle = null;
      this.actionT = 0;
      this.state = 'ground';
      this.grounded = true;
      this.velocity.copy(m.exitVel);
      this.body.setTranslation(this.center, true);
      this.setCrouched(m.endCrouched);
    }
  }

  // ------------------------------------------------------------------- ladder

  private tryLadder(wish: THREE.Vector3, moving: boolean): boolean {
    const l = this.traversal.ladderAt(this.feet());
    if (!l) return false;
    const toward = moving && wish.dot(l.normal) < -0.5;
    if (!toward && !this.interactPressed) return false;
    if (this.crouched && !this.setCrouched(false)) return false;
    this.ladder = l;
    this.state = 'ladder';
    this.velocity.set(0, 0, 0);
    this.facingYaw = dirToYaw(l.normal.clone().negate());
    // Snap onto ladder line
    const f = this.feet();
    const along = new THREE.Vector3(-l.normal.z, 0, l.normal.x);
    const side = THREE.MathUtils.clamp(f.clone().sub(l.base).dot(along), -l.halfWidth * 0.3, l.halfWidth * 0.3);
    this.center.x = l.base.x + l.normal.x * (T.capsuleRadius + 0.08) + along.x * side;
    this.center.z = l.base.z + l.normal.z * (T.capsuleRadius + 0.08) + along.z * side;
    this.body.setNextKinematicTranslation(this.center);
    return true;
  }

  private stepLadder(dt: number): void {
    const l = this.ladder!;
    const climb = this.moveInput.y;
    this.velocity.set(0, climb * T.ladderSpeed, 0);
    const feetY = this.center.y - this.halfHeight - T.capsuleRadius;
    this.actionT = (feetY - l.base.y) / l.height;
    this.locomotion = Math.abs(climb) > 0.1 ? 'walk' : 'idle';

    const detach = (vel: THREE.Vector3) => {
      this.ladder = null;
      this.state = 'air';
      this.grounded = false;
      this.velocity.copy(vel);
      this.ladderCooldownT = 0.4;
      this.actionT = 0;
    };

    if (this.jumpBufferT > 0) {
      this.jumpBufferT = 0;
      detach(l.normal.clone().multiplyScalar(3.5).setY(3.5));
      return;
    }
    if (this.crouchPressed) {
      detach(new THREE.Vector3(0, -1, 0));
      return;
    }
    // Reached top → climb over the lip
    if (climb > 0 && feetY + this.halfHeight * 2 + T.capsuleRadius * 2 >= l.base.y + l.height + 0.3) {
      const into = l.normal.clone().negate();
      const top = l.base.clone().addScaledVector(into, T.capsuleRadius + 0.6);
      top.y = l.base.y + l.height;
      const endC = top.clone().addScaledVector(UP, this.halfHeight + T.capsuleRadius + 0.05);
      if (this.physics.capsuleFree(endC, this.halfHeight, T.capsuleRadius - 0.02, this.collider)) {
        this.ladder = null;
        const upC = this.center.clone();
        upC.y = endC.y;
        this.beginMantle([this.center.clone(), upC, endC], [0.3, 0.25], new THREE.Vector3(), false, false);
        return;
      }
      this.velocity.y = 0;
    }

    this.move(dt);
    this.state = 'ladder';
    if (climb < 0 && this.grounded) detach(new THREE.Vector3());
  }

  // ------------------------------------------------------------------- zipline

  private tryZipline(): boolean {
    const chest = this.feet().addScaledVector(UP, 1.9);
    const z = this.traversal.ziplineNear(chest);
    if (!z) return false;
    if (this.crouched && !this.setCrouched(false)) return false;
    const len = z.from.distanceTo(z.to);
    this.zip = { from: z.from, to: z.to, s: 0, len, speed: Math.max(3, Math.hypot(this.velocity.x, this.velocity.z)) };
    this.state = 'zipline';
    this.velocity.set(0, 0, 0);
    Events.emit('player:zipline', { attached: true });
    return true;
  }

  private stepZipline(dt: number): void {
    const z = this.zip!;
    const dir = z.to.clone().sub(z.from).normalize();
    // Gravity along cable drives speed; clamp to rail speed
    z.speed = Math.min(T.ziplineSpeed, z.speed + (6 - dir.y * 9.81) * dt);
    z.s += z.speed * dt;
    const hang = z.from.clone().addScaledVector(dir, Math.min(z.s, z.len));
    // Hands on cable ≈ 2.05m above feet
    this.center.copy(hang).addScaledVector(UP, -2.05 + this.halfHeight + T.capsuleRadius);
    this.body.setNextKinematicTranslation(this.center);
    this.facingYaw = dirToYaw(dir.clone().setY(0).normalize());
    this.actionT = z.s / z.len;
    this.locomotion = 'idle';

    const release = () => {
      this.zip = null;
      this.state = 'air';
      this.grounded = false;
      this.velocity.copy(dir).multiplyScalar(z.speed * 0.8);
      this.velocity.y = Math.max(this.velocity.y, 0);
      this.actionT = 0;
      this.ladderCooldownT = 0.3;
      Events.emit('player:zipline', { attached: false });
    };
    if (this.jumpBufferT > 0 || this.crouchPressed || this.interactPressed) {
      this.jumpBufferT = 0;
      release();
      if (this.velocity.y < 2) this.velocity.y = 2;
    } else if (z.s >= z.len - 0.6) {
      release();
    }
  }

  // ------------------------------------------------------------------- facing / noise

  private updateFacing(dt: number): void {
    if (this.state === 'ladder' || this.state === 'mantle' || this.state === 'roll' || this.state === 'zipline') return;
    let target: number | null = null;
    if (this.aiming) target = this.aimYaw;
    else {
      const hv = _v.set(this.velocity.x, 0, this.velocity.z);
      if (hv.lengthSq() > 0.25) target = dirToYaw(hv);
    }
    if (target === null) return;
    const rate = (this.aiming ? 25 : T.faceTurnRate) * dt;
    this.facingYaw += THREE.MathUtils.clamp(angleDelta(this.facingYaw, target), -rate, rate);
  }

  private emitFootsteps(dt: number): void {
    if (this.state !== 'ground' || this.locomotion === 'idle') return;
    this.noiseT -= dt;
    if (this.noiseT > 0) return;
    const radius = NoiseRadius[this.locomotion as keyof typeof NoiseRadius] ?? NoiseRadius.walk;
    this.noiseT = this.locomotion === 'sprint' ? 0.28 : this.locomotion === 'jog' ? 0.36 : 0.5;
    Events.emit('noise', { pos: this.feet(), radius, source: 'footstep' });
  }

  // ------------------------------------------------------------------- render helpers

  feet(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.center).addScaledVector(UP, -(this.halfHeight + T.capsuleRadius));
  }

  /** Interpolated centre for rendering. */
  interpolate(alpha: number): void {
    this.renderCenter.lerpVectors(this.prevCenter, this.center, alpha);
  }

  renderFeet(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.renderCenter).addScaledVector(UP, -(this.halfHeight + T.capsuleRadius));
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Teleport (debug / respawn). */
  teleport(feet: THREE.Vector3): void {
    this.center.copy(feet).addScaledVector(UP, this.halfHeight + T.capsuleRadius);
    this.prevCenter.copy(this.center);
    this.renderCenter.copy(this.center);
    this.velocity.set(0, 0, 0);
    this.body.setTranslation(this.center, true);
    this.state = 'air';
    this.mantle = null;
    this.zip = null;
    this.ladder = null;
  }
}

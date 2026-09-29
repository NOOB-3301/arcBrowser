import * as THREE from 'three';
import { RAPIER, Groups, interactionGroups, type Physics } from '../physics/Physics';
import type { Input } from '../core/Input';
import { FIXED_DT } from '../core/Time';

/**
 * M1 placeholder: capsule + simple follow camera to exercise input/physics.
 * Replaced in M2 by PlayerController + CameraRig.
 */
export class DebugPlayer {
  readonly mesh: THREE.Mesh;
  yaw = 0;
  pitch = -0.15;
  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private velY = 0;
  private prev = new THREE.Vector3();
  private curr = new THREE.Vector3();

  constructor(scene: THREE.Scene, physics: Physics, spawn: THREE.Vector3) {
    const world = physics.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(0.55, 0.35).setCollisionGroups(interactionGroups(Groups.PLAYER, 0xffff)),
      this.body,
    );
    this.controller = world.createCharacterController(0.02);
    this.controller.enableAutostep(0.4, 0.2, true);
    this.controller.enableSnapToGround(0.3);
    this.controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(46));
    this.controller.setApplyImpulsesToDynamicBodies(true);

    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 1.1, 6, 12),
      new THREE.MeshStandardMaterial({ color: '#e0c060', roughness: 0.5 }),
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.curr.copy(spawn);
    this.prev.copy(spawn);
  }

  /** Per render frame: look. */
  look(input: Input): void {
    this.yaw -= input.lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.lookY, -1.3, 1.1);
  }

  /** Per fixed step: move. */
  step(input: Input, jump: boolean): void {
    const speed = input.down('sprint') ? 6.5 : 3.8;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = fwd.multiplyScalar(input.moveY).addScaledVector(right, input.moveX).multiplyScalar(speed * FIXED_DT);

    const grounded = this.controller.computedGrounded();
    if (grounded && this.velY < 0) this.velY = -1;
    if (grounded && jump) this.velY = 5.2;
    this.velY -= 9.81 * 1.6 * FIXED_DT;
    move.y = this.velY * FIXED_DT;

    this.controller.computeColliderMovement(this.collider, move);
    const m = this.controller.computedMovement();
    const t = this.body.translation();
    this.prev.copy(this.curr);
    this.curr.set(t.x + m.x, t.y + m.y, t.z + m.z);
    this.body.setNextKinematicTranslation(this.curr);
    if (this.controller.computedGrounded() && this.velY > 0 && m.y < move.y * 0.5) this.velY = 0;
  }

  /** Interpolate render position and place follow camera. */
  render(camera: THREE.PerspectiveCamera, alpha: number): void {
    this.mesh.position.lerpVectors(this.prev, this.curr, alpha);
    this.mesh.rotation.y = this.yaw;
    const pivot = this.mesh.position.clone().add(new THREE.Vector3(0, 0.9, 0));
    const dir = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    camera.position.copy(pivot).addScaledVector(dir, -3.2).addScaledVector(right, 0.6);
    camera.lookAt(camera.position.clone().add(dir));
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  get physicsCollider(): RAPIER.Collider {
    return this.collider;
  }
}

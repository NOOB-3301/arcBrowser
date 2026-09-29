export type MoveState =
  | 'ground' // idle / walk / jog / sprint / crouch, resolved by speed + flags
  | 'air'
  | 'slide'
  | 'roll'
  | 'mantle'
  | 'ladder'
  | 'zipline';

/** All movement tuning in one place. Speeds m/s, times s, accel m/s². */
export const Tuning = {
  capsuleRadius: 0.35,
  standHalfHeight: 0.55, // total height 1.8
  crouchHalfHeight: 0.2, // total height 1.1

  walkSpeed: 2.2, // while aiming
  jogSpeed: 4.3,
  sprintSpeed: 6.9,
  crouchSpeed: 2.0,
  backwardMultiplier: 0.75,

  groundAccel: 28,
  groundDecel: 22,
  airAccel: 4,
  /** Sprint heading turn limit, rad/s (weighty sprint). */
  sprintTurnRate: 4.5,
  /** Character facing turn rate when not aiming, rad/s. */
  faceTurnRate: 12,

  gravity: 9.81 * 1.8,
  jumpVelocity: 5.4,
  coyoteTime: 0.12,
  jumpBuffer: 0.15,
  terminalVelocity: 40,
  fallDamageSpeed: 11,
  fallDamagePerMs: 6,

  slideMinSpeed: 5.2,
  slideBoost: 1.5,
  slideFriction: 5.5,
  slideSlopeAccel: 12,
  slideEndSpeed: 2.4,
  slideMaxTime: 1.4,
  slideCooldown: 0.6,

  rollSpeed: 7.6,
  rollTime: 0.55,
  rollCooldown: 0.75,

  mantleMinHeight: 0.35,
  mantleMaxHeight: 2.3,
  mantleReach: 0.75,
  vaultMaxHeight: 1.25,
  vaultMaxDepth: 1.1,

  ladderSpeed: 2.6,
  ziplineSpeed: 13,

  staminaSprint: 11,
  staminaJump: 8,
  staminaRoll: 22,
  staminaMantle: 6,
  staminaSlide: 10,
};

/** AI-hearing radius (m) of footsteps per locomotion mode. */
export const NoiseRadius = {
  crouch: 3,
  walk: 7,
  jog: 14,
  sprint: 26,
  land: 18,
};

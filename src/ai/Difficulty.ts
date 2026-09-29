export type DifficultyId = 'recruit' | 'veteran' | 'elite' | 'nightmare';

export interface Difficulty {
  id: DifficultyId;
  label: string;
  /** Seconds between first sighting and first shot. */
  reactionTime: number;
  /** Base aim error cone (degrees) before settling. */
  aimErrorDeg: number;
  /** Seconds of continuous tracking to reach best accuracy. */
  settleTime: number;
  /** 0..1 how well bots lead moving targets. */
  lead: number;
  /** Chance a shot is aimed at the head. */
  headBias: number;
  visionRange: number;
  visionFovDeg: number;
  hearingMult: number;
  /** Detection meter fill speed multiplier. */
  detectSpeed: number;
  /** Damage bots deal (multiplier). */
  damageMult: number;
  /** Bot health multiplier. */
  healthMult: number;
  /** 0..1 willingness to push/flank vs hold cover. */
  aggression: number;
  /** Bot trigger discipline: max burst length in shots. */
  burstMax: number;
  /** Spawn scaling. */
  arcDensity: number;
  raiders: number;
}

export const DIFFICULTIES: Record<DifficultyId, Difficulty> = {
  recruit: {
    id: 'recruit', label: 'Recruit', reactionTime: 0.9, aimErrorDeg: 6, settleTime: 2.6, lead: 0.2, headBias: 0.05,
    visionRange: 60, visionFovDeg: 100, hearingMult: 0.6, detectSpeed: 0.55, damageMult: 0.55, healthMult: 0.8,
    aggression: 0.3, burstMax: 4, arcDensity: 0.6, raiders: 2,
  },
  veteran: {
    id: 'veteran', label: 'Veteran', reactionTime: 0.55, aimErrorDeg: 3.6, settleTime: 1.8, lead: 0.5, headBias: 0.12,
    visionRange: 90, visionFovDeg: 110, hearingMult: 0.85, detectSpeed: 0.85, damageMult: 0.8, healthMult: 1,
    aggression: 0.5, burstMax: 6, arcDensity: 1, raiders: 3,
  },
  elite: {
    id: 'elite', label: 'Elite', reactionTime: 0.35, aimErrorDeg: 2.2, settleTime: 1.2, lead: 0.8, headBias: 0.22,
    visionRange: 120, visionFovDeg: 120, hearingMult: 1, detectSpeed: 1.3, damageMult: 1, healthMult: 1.15,
    aggression: 0.7, burstMax: 8, arcDensity: 1.3, raiders: 4,
  },
  nightmare: {
    id: 'nightmare', label: 'Nightmare', reactionTime: 0.2, aimErrorDeg: 1.3, settleTime: 0.8, lead: 1, headBias: 0.35,
    visionRange: 150, visionFovDeg: 130, hearingMult: 1.25, detectSpeed: 1.9, damageMult: 1.2, healthMult: 1.35,
    aggression: 0.9, burstMax: 12, arcDensity: 1.6, raiders: 5,
  },
};

import type * as THREE from 'three';

/**
 * W4: global modifiers every Perception consults. Weather writes the multipliers,
 * Throwables registers the smoke line-of-sight test. Kept dependency-free so the
 * AI layer doesn't import world/weapon code.
 */
export const SenseMods = {
  /** Vision range multiplier (fog / storm). */
  vision: 1,
  /** Hearing radius multiplier (rain / storm). */
  hearing: 1,
  /** True if a smoke volume blocks the segment a→b. */
  smokeBlocks: (_a: THREE.Vector3, _b: THREE.Vector3): boolean => false,
};

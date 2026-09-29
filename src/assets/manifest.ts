/** Every GLB the game loads, relative to the public root. See CREDITS.md / credits.ts for sources. */
export const MANIFEST = {
  raider: 'assets/models/raider.glb',
} as const;

export type AssetKey = keyof typeof MANIFEST;

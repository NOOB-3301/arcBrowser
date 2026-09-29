/** Every GLB the game loads, relative to the public root. See CREDITS.md / credits.ts for sources. */
export const MANIFEST = {
  raider: 'assets/models/raider.glb',
  weapons: 'assets/models/weapons.glb',
  arc_tick: 'assets/models/arc_tick.glb',
  arc_wasp: 'assets/models/arc_wasp.glb',
  arc_sentinel: 'assets/models/arc_sentinel.glb',
  arc_stalker: 'assets/models/arc_stalker.glb',
  arc_colossus: 'assets/models/arc_colossus.glb',
} as const;

export type AssetKey = keyof typeof MANIFEST;

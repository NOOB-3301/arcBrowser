/** Declarative map description consumed by MapGen + MapWorld. Coordinates in metres, -Z = north. */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type PadSurface = 'concrete' | 'dirt' | 'gravel' | 'none';

export interface PadDef {
  center: Vec2;
  /** Rectangle half extents; omit for circular pad with `radius`. */
  half?: Vec2;
  radius?: number;
  rot?: number;
  /** Target height, or 'auto' (mean of terrain under the pad). */
  height: number | 'auto';
  falloff: number;
  surface: PadSurface;
}

export interface RoadDef {
  points: Vec2[];
  width: number;
  surface: 'asphalt' | 'gravel';
}

export interface RiverDef {
  /** x, z, bed height. */
  points: Vec3[];
  width: number;
  valleyWidth: number;
}

export interface LakeDef {
  center: Vec2;
  radius: Vec2;
  bottom: number;
}

export interface HillDef {
  center: Vec2;
  radius: number;
  height: number;
}

export type PoiKind = 'dam' | 'pumping' | 'village' | 'town' | 'farm' | 'containers' | 'radio'
  // W4: Shardcoast POIs (built by POIs2)
  | 'city' | 'spaceport' | 'lighthouse' | 'shipwreck' | 'overpass';

export interface PoiDef {
  id: string;
  name: string;
  kind: PoiKind;
  center: Vec2;
  rot?: number;
  /** Loot density tier 1..3 (M6). */
  tier: number;
  radius: number;
  seed?: number;
}

export type ExtractKind = 'elevator' | 'tunnel' | 'chopper' | 'lift' | 'hatch';

export interface ExtractDef {
  id: string;
  name: string;
  kind: ExtractKind;
  pos: Vec3 | Vec2;
}

export interface ForestDef {
  center: Vec2;
  radius: number;
  density: number; // trees per 1000 m²
  kind: 'pine' | 'dead' | 'mixed';
}

export interface MapDef {
  id: string;
  name: string;
  size: number;
  cell: number;
  seed: number;
  waterLevel: number;
  base: { hillAmp: number; hillScale: number; ridgeAmp: number; baseHeight: number; rimHeight: number; rimWidth: number };
  lakes: LakeDef[];
  hills: HillDef[];
  rivers: RiverDef[];
  pads: PadDef[];
  roads: RoadDef[];
  pois: PoiDef[];
  extracts: ExtractDef[];
  spawns: Vec2[];
  forests: ForestDef[];
  /** Global sparse trees per 1000 m² on grass. */
  sparseTrees: number;
  pylons: Vec2[];
  bridges: { center: Vec2; rot: number; length: number; width: number }[];
  dam?: { z: number; x0: number; x1: number; top: number; breach: [number, number] };
  /** W4: sea coast. Sea lies on the +x side at `waterLevel` (sea level). */
  coast?: CoastDef;
}

/** W4: coastline description (sea on the +x side of the map). */
export interface CoastDef {
  /** Mean shoreline x. */
  shore: number;
  /** Shoreline meander amplitude (m). */
  wobble: number;
  /** Beach width inland of the shoreline. */
  beach: number;
  /** Sea floor height far offshore, and the width of the shelf reaching it. */
  seaFloor: number;
  shelf: number;
  /** Stretches of coast (z ranges) that end in cliffs of the given height above the land. */
  cliffs: { z0: number; z1: number; height: number }[];
  /** Headlands pushing the shoreline seaward (gaussian bump). */
  headlands: { z: number; width: number; reach: number }[];
  /** Dune height in the band behind the beach. */
  dunes: number;
  /** Extra sandy areas inland (sand splat + drifts). */
  sandy: { center: Vec2; radius: number }[];
}

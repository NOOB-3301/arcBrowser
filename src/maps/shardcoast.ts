import type { MapDef } from '../world/MapDef';

/**
 * W4 — SHARDCOAST: 1.5 km² strip of coast. The sea lies east; cliffs run along
 * the northern shore up to a lighthouse headland, beaches and dunes to the south.
 * A collapsed city (Saltmere) sinks into the sand behind the beach; the rusted
 * Kestrel launch complex dominates the north-west, where a Colossus patrols.
 */
export const SHARDCOAST: MapDef = {
  id: 'shardcoast',
  name: 'Shardcoast',
  size: 1536,
  cell: 2,
  seed: 4242,
  waterLevel: 2,
  base: { hillAmp: 10, hillScale: 340, ridgeAmp: 8, baseHeight: 13, rimHeight: 80, rimWidth: 170 },

  coast: {
    shore: 440,
    wobble: 28,
    beach: 70,
    seaFloor: -16,
    shelf: 140,
    cliffs: [{ z0: -800, z1: -170, height: 16 }],
    headlands: [{ z: -330, width: 95, reach: 120 }],
    dunes: 7,
    sandy: [{ center: [250, 110], radius: 190 }],
  },

  lakes: [],
  rivers: [],

  hills: [
    { center: [520, -330], radius: 120, height: 8 }, // lighthouse headland
    { center: [-560, -40], radius: 150, height: 24 }, // relay hill
    { center: [-470, -560], radius: 200, height: 18 },
    { center: [-120, 480], radius: 170, height: 10 },
  ],

  pads: [
    // Kestrel launch complex
    { center: [-260, -330], half: [175, 120], height: 'auto', falloff: 70, surface: 'concrete' },
    // Saltmere (buried city) — levelled, the sand does the rest
    { center: [250, 110], radius: 150, height: 'auto', falloff: 60, surface: 'none' },
    // Dunmore village
    { center: [-380, 330], radius: 90, height: 'auto', falloff: 55, surface: 'none' },
    // Relay hill top
    { center: [-560, -40], half: [28, 28], height: 'auto', falloff: 30, surface: 'gravel' },
    // Lighthouse yard
    { center: [520, -335], radius: 26, height: 'auto', falloff: 25, surface: 'gravel' },
    // Helipad extract
    { center: [-420, 560], half: [14, 14], height: 'auto', falloff: 20, surface: 'concrete' },
  ],

  roads: [
    // Launch complex → Saltmere highway
    { points: [[-240, -205], [-120, -150], [40, -60], [180, 40], [250, 110]], width: 10, surface: 'asphalt' },
    // Coast road north to the lighthouse
    { points: [[250, 110], [330, -40], [360, -200], [400, -300], [490, -330]], width: 7, surface: 'asphalt' },
    // West road: highway → Dunmore → helipad
    { points: [[-120, -150], [-260, 60], [-380, 330], [-420, 560]], width: 8, surface: 'asphalt' },
    // Saltmere south along the dunes
    { points: [[250, 110], [300, 390], [340, 640]], width: 7, surface: 'gravel' },
    // Relay hill track
    { points: [[-260, 60], [-450, 20], [-560, -40]], width: 6, surface: 'gravel' },
  ],

  bridges: [],

  pois: [
    { id: 'kestrel', name: 'Kestrel Launch Complex', kind: 'spaceport', center: [-260, -330], tier: 3, radius: 190, seed: 71 },
    { id: 'saltmere', name: 'Saltmere', kind: 'city', center: [250, 110], tier: 3, radius: 160, seed: 5 },
    { id: 'lighthouse', name: 'Gull Point Light', kind: 'lighthouse', center: [520, -335], tier: 2, radius: 40 },
    { id: 'overpass', name: 'Broken Overpass', kind: 'overpass', center: [40, -60], rot: -0.56, tier: 1, radius: 120 },
    { id: 'wreck', name: 'The Leviathan', kind: 'shipwreck', center: [455, 360], rot: 0.35, tier: 2, radius: 60 },
    { id: 'dunmore', name: 'Dunmore', kind: 'village', center: [-380, 330], tier: 1, radius: 90, seed: 19 },
    { id: 'relay', name: 'Relay Hill', kind: 'radio', center: [-560, -40], tier: 2, radius: 50 },
  ],

  extracts: [
    { id: 'x-launch', name: 'Launch Pad Lift', kind: 'lift', pos: [-120, -440] },
    { id: 'x-light', name: 'Gull Point Cellar', kind: 'hatch', pos: [505, -318] },
    { id: 'x-metro', name: 'Saltmere Metro', kind: 'tunnel', pos: [170, 230] },
    { id: 'x-heli', name: 'Dunmore Helipad', kind: 'chopper', pos: [-420, 560] },
    { id: 'x-relay', name: 'Relay Bunker', kind: 'hatch', pos: [-540, -20] },
  ],

  spawns: [[-690, -300], [-690, 200], [-520, 690], [20, 690], [240, 680], [-300, -690], [120, -690]],

  forests: [
    { center: [-520, 180], radius: 180, density: 6, kind: 'mixed' },
    { center: [-560, -500], radius: 190, density: 7, kind: 'pine' },
    { center: [-60, 360], radius: 150, density: 4, kind: 'mixed' },
    { center: [60, -330], radius: 110, density: 3, kind: 'dead' },
    { center: [240, -500], radius: 150, density: 3, kind: 'dead' },
  ],
  sparseTrees: 0.15,

  pylons: [[-700, -200], [-560, -200], [-420, -210], [-300, -200]],
};

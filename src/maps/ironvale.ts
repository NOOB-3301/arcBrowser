import type { MapDef } from '../world/MapDef';

/**
 * IRONVALE BASIN — 1.5 km² bowl. A breached dam holds back the northern reservoir;
 * a river valley runs south past villages, a container yard and the town of Lowgate.
 */
export const IRONVALE: MapDef = {
  id: 'ironvale',
  name: 'Ironvale Basin',
  size: 1536,
  cell: 2,
  seed: 1337,
  waterLevel: 22,
  base: { hillAmp: 16, hillScale: 380, ridgeAmp: 14, baseHeight: 24, rimHeight: 95, rimWidth: 190 },

  lakes: [{ center: [0, -440], radius: [330, 185], bottom: 6 }],

  hills: [
    { center: [-520, -480], radius: 170, height: 34 }, // Radio Hill
    { center: [520, -380], radius: 200, height: 22 },
    { center: [-600, 330], radius: 160, height: 18 },
    { center: [250, 330], radius: 110, height: 12 },
  ],

  rivers: [
    {
      points: [
        [0, -250, 4], [15, -120, 3.4], [-10, 40, 2.8], [40, 250, 2.2], [-10, 450, 1.6], [50, 620, 1], [30, 780, 0.5],
      ],
      width: 16,
      valleyWidth: 150,
    },
  ],

  pads: [
    // Dam abutments
    { center: [-185, -250], radius: 34, height: 30, falloff: 40, surface: 'concrete' },
    { center: [185, -250], radius: 34, height: 30, falloff: 40, surface: 'concrete' },
    // POIs
    { center: [235, -205], half: [55, 42], height: 30, falloff: 45, surface: 'concrete' },
    { center: [-520, -480], half: [28, 28], height: 'auto', falloff: 30, surface: 'gravel' },
    { center: [-430, 120], radius: 115, height: 'auto', falloff: 60, surface: 'none' },
    { center: [360, 140], half: [85, 60], height: 'auto', falloff: 50, surface: 'concrete' },
    { center: [420, 470], radius: 90, height: 'auto', falloff: 55, surface: 'dirt' },
    { center: [-160, 480], half: [115, 85], height: 'auto', falloff: 60, surface: 'none' },
    // Extract pads
    { center: [-560, 165], half: [14, 14], height: 'auto', falloff: 20, surface: 'concrete' },
    { center: [-300, 690], half: [18, 30], height: 'auto', falloff: 25, surface: 'gravel' },
  ],

  roads: [
    { points: [[-150, 480], [-60, 300], [-40, 100], [-140, -60], [-185, -250]], width: 9, surface: 'asphalt' },
    { points: [[185, -250], [235, -205]], width: 9, surface: 'asphalt' },
    { points: [[-40, 100], [-250, 135], [-430, 120], [-560, 165]], width: 8, surface: 'asphalt' },
    { points: [[-40, 100], [150, 130], [360, 140], [430, 300], [420, 470]], width: 8, surface: 'asphalt' },
    { points: [[-430, 120], [-500, -150], [-520, -480]], width: 6, surface: 'gravel' },
    { points: [[-150, 480], [-240, 600], [-300, 690]], width: 7, surface: 'gravel' },
  ],

  bridges: [{ center: [-2, 115], rot: 0.13, length: 60, width: 9 }],

  dam: { z: -250, x0: -170, x1: 170, top: 30, breach: [-14, 16] },

  pois: [
    { id: 'dam', name: 'Ironvale Dam', kind: 'dam', center: [0, -250], tier: 3, radius: 180 },
    { id: 'pumping', name: 'Pumping Station', kind: 'pumping', center: [235, -205], tier: 3, radius: 70 },
    { id: 'radio', name: 'Radio Hill', kind: 'radio', center: [-520, -480], tier: 2, radius: 50 },
    { id: 'millbrook', name: 'Millbrook', kind: 'village', center: [-430, 120], tier: 2, radius: 110, seed: 11 },
    { id: 'yard', name: 'Container Yard', kind: 'containers', center: [360, 140], tier: 2, radius: 100 },
    { id: 'harrow', name: 'Harrow Farm', kind: 'farm', center: [420, 470], tier: 1, radius: 90, seed: 7 },
    { id: 'lowgate', name: 'Lowgate', kind: 'town', center: [-160, 480], tier: 3, radius: 130, seed: 23 },
  ],

  extracts: [
    { id: 'x-dam', name: 'Dam Service Elevator', kind: 'elevator', pos: [158, 30, -250] },
    { id: 'x-tunnel', name: 'Lowgate Rail Tunnel', kind: 'tunnel', pos: [-300, 700] },
    { id: 'x-chopper', name: 'Millbrook Helipad', kind: 'chopper', pos: [-560, 165] },
    { id: 'x-lift', name: 'Yard Cargo Lift', kind: 'lift', pos: [438, 88] },
    { id: 'x-hatch', name: 'Radio Hill Hatch', kind: 'hatch', pos: [-535, -462] },
  ],

  spawns: [[-690, 300], [690, -250], [60, 700], [-620, -640], [640, 640], [-700, -120], [300, -640]],

  forests: [
    { center: [-330, -260], radius: 190, density: 9, kind: 'pine' },
    { center: [460, -440], radius: 210, density: 10, kind: 'pine' },
    { center: [-520, 440], radius: 170, density: 8, kind: 'mixed' },
    { center: [620, 120], radius: 140, density: 7, kind: 'pine' },
    { center: [60, -110], radius: 90, density: 4, kind: 'dead' },
    { center: [120, 380], radius: 120, density: 5, kind: 'mixed' },
  ],
  sparseTrees: 0.45,

  pylons: [[-740, -40], [-560, -30], [-380, -20], [-200, -10], [-20, 0], [160, 10], [340, 20], [520, 30], [700, 40]],
};

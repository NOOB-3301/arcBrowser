import * as THREE from 'three';
import type { AIDirector } from './AIDirector';
import type { MapInfo } from '../world/World';

/**
 * W4 — Shardcoast population table: Colossus roaming the launch complex,
 * Stalkers in Saltmere, sentinels on landmarks, wasp loops, tick nests, raiders.
 */
export function populateShardcoast(ai: AIDirector, map: MapInfo, playerSpawn?: THREE.Vector3): void {
  const d = ai.ctx.difficulty;
  const hm = map.hm;
  const count = (n: number) => Math.max(1, Math.round(n * d.arcDensity));
  const v = (x: number, z: number, dy = 0) => new THREE.Vector3(x, hm.sample(x, z) + dy, z);

  // Colossus: slow loop around the launch apron
  const route = [[-300, -290], [-200, -262], [-140, -300], [-190, -360], [-300, -372]].map(([x, z]) => v(x, z));
  ai.spawn('colossus', route[0].clone(), { route, facing: Math.PI / 2 });

  // Stalkers prowling Saltmere's streets
  const stalkers: [number, number][] = [[250, 60], [200, 160], [310, 150]];
  stalkers.slice(0, count(2)).forEach(([x, z]) => ai.spawn('stalker', v(x, z)));

  // Sentinels on landmarks
  const sentinels: [number, number, number, number][] = [
    [72 - 260, 60, -40 - 330, 1.2], // gantry level 5, facing the apron
    [520, -1, -310, 1.6], // lighthouse yard, facing inland
    [250, -1, 20, 0.6], // Saltmere north gate
    [450, -1, 330, 1.4], // wreck
    [-300, -1, -200, 0], // spaceport south fence
  ];
  sentinels.slice(0, count(4)).forEach(([x, sy, z, f]) => ai.spawn('sentinel', new THREE.Vector3(x, sy >= 0 ? hm.sample(x, z) + sy : hm.sample(x, z), z), { facing: f }));

  // Wasp patrols
  const loops: [number, number][][] = [
    [[-380, -420], [-120, -420], [-140, -240], [-380, -240]],
    [[150, 0], [360, 60], [320, 240], [160, 220]],
    [[380, -200], [520, -330], [440, 380]],
    [[-400, 300], [-200, 440], [-460, 520]],
  ];
  loops.slice(0, count(3)).forEach((loop) => {
    const r = loop.map(([x, z]) => new THREE.Vector3(x, 0, z));
    ai.spawn('wasp', r[0].clone(), { route: r });
  });

  // Tick nests: city blocks, wreck, hangar, village
  const nests: [number, number, number][] = [[240, 110, 5], [300, 60, 4], [440, 360, 4], [-350, -270, 4], [-380, 330, 3]];
  for (const [x, z, n] of nests) {
    for (let i = 0; i < count(n); i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = 4 + Math.random() * 18;
      ai.spawn('tick', v(x + Math.cos(a) * rr, z + Math.sin(a) * rr), { dormant: true });
    }
  }

  // Raiders from far spawn points
  const spawns = map.def.spawns
    .map(([x, z]) => v(x, z))
    .filter((p) => !playerSpawn || p.distanceTo(playerSpawn) > 250)
    .sort(() => Math.random() - 0.5);
  for (let i = 0; i < d.raiders && i < spawns.length; i++) ai.spawn('raider', spawns[i]);
}

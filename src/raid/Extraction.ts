import type * as THREE from 'three';
import { Events } from '../core/Events';
import type { Extracts, ExtractPoint } from '../world/Extracts';
import { ITEMS } from '../loot/Items';
import { Sfx } from '../audio/Sfx';
import type { RaidManager } from './RaidManager';

export type ExtractStatus = 'open' | 'closed' | 'locked' | 'power';

export interface ExtractState {
  index: number;
  point: ExtractPoint;
  status: ExtractStatus;
  /** Raid-elapsed seconds when a closed extract opens (null = never on its own). */
  opensAt: number | null;
  /** Key item that opens it early. */
  key: string | null;
}

export const EXTRACT_RADIUS = 5;
const NOISE_EVERY = 2;

const COLORS: Record<ExtractStatus | 'active', [string, number]> = {
  open: ['#5cffb0', 1],
  closed: ['#7d858e', 0.25],
  locked: ['#ff4b3a', 0.45],
  power: ['#ffb02a', 0.45],
  active: ['#ffe14a', 1.8],
};

/** Which extracts are open, the hold-in-zone countdown, and beacon colours. */
export class ExtractionSystem {
  states: ExtractState[] = [];
  active: ExtractState | null = null;
  progress = 0;
  /** Seconds to stand in the zone (tests may shorten it). */
  holdTime = 10;
  private noiseT = 0;
  private lastColor: string[] = [];

  constructor(
    private raid: RaidManager,
    private beacons: Extracts | null,
  ) {}

  private get points(): ExtractPoint[] {
    return this.raid.game.world.map?.extracts ?? [];
  }

  byId(id: string): ExtractState | undefined {
    return this.states.find((s) => s.point.def.id === id);
  }

  openCount(): number {
    return this.states.filter((s) => s.status === 'open').length;
  }

  reset(): void {
    this.states = this.points.map((point, index) => ({ index, point, status: 'open', opensAt: null, key: null }));
    this.active = null;
    this.progress = 0;
    this.lastColor = [];
    this.paint();
  }

  /** New raid: 2–3 random extracts open, the rest open later / need a key / need power. */
  setup(): void {
    this.reset();
    const keyFor = (id: string) => Object.values(ITEMS).find((d) => d.opens === id)?.id ?? null;
    const pool: ExtractState[] = [];
    for (const s of this.states) {
      const id = s.point.def.id;
      s.key = keyFor(id);
      if (id === 'x-dam') s.status = 'power';
      else if (id === 'x-hatch') s.status = 'locked';
      else pool.push(s);
    }
    pool.sort(() => Math.random() - 0.5);
    const openN = Math.min(pool.length, 2 + (Math.random() < 0.5 ? 1 : 0));
    pool.forEach((s, i) => {
      if (i < openN) s.status = 'open';
      else {
        s.status = 'closed';
        s.opensAt = (8 + Math.random() * 10) * 60;
      }
    });
    // Guarantee at least two ways out even on tiny maps
    if (this.openCount() < 2) for (const s of this.states) if (this.openCount() < 2 && s.status !== 'open') s.status = 'open';
    this.paint();
  }

  powerUp(id: string): void {
    const s = this.byId(id);
    if (!s || s.status === 'open') return;
    s.status = 'open';
    Events.emit('toast', `Power restored · ${s.point.def.name} online`);
    this.paint();
  }

  private open(s: ExtractState, why: string): void {
    s.status = 'open';
    Events.emit('toast', `${s.point.def.name} ${why}`);
    this.paint();
  }

  update(dt: number, feet: THREE.Vector3): void {
    const raid = this.raid;
    // Timed openings
    for (const s of this.states) if (s.status === 'closed' && s.opensAt !== null && raid.elapsed >= s.opensAt) this.open(s, 'is now open');

    // Zone check
    let zone: ExtractState | null = null;
    for (const s of this.states) {
      const p = s.point.pos;
      if (Math.hypot(p.x - feet.x, p.z - feet.z) < EXTRACT_RADIUS && Math.abs(p.y - feet.y) < 4) zone = s;
    }
    if (zone && zone.status !== 'open' && zone.key && raid.inv.has(zone.key) && raid.game.combat.health.alive) {
      raid.inv.consume(zone.key, 1);
      this.open(zone, `unlocked with ${ITEMS[zone.key].name}`);
    }
    const canExtract = zone !== null && zone.status === 'open' && raid.game.combat.health.alive && !raid.paused;
    if (canExtract) {
      if (this.active !== zone) {
        this.active = zone;
        this.progress = 0;
        this.noiseT = 0;
        Events.emit('toast', 'Extraction started — hold the zone');
        Sfx.swap();
      }
      this.progress += dt;
      this.noiseT -= dt;
      if (this.noiseT <= 0) {
        this.noiseT = NOISE_EVERY;
        // Loud: every bot in earshot converges on the beacon
        Events.emit('noise', { pos: zone!.point.pos.clone(), radius: 90, emitter: raid.game.combat, source: 'extract' });
      }
      if (this.progress >= this.holdTime) {
        this.active = null;
        this.paint();
        raid.endRaid('extracted');
        return;
      }
    } else if (this.active) {
      if (this.progress > 0.5) Events.emit('toast', 'Extraction interrupted');
      this.active = null;
      this.progress = 0;
    }
    this.paint();
  }

  private paint(): void {
    if (!this.beacons) return;
    const pulse = 0.75 + Math.sin(performance.now() / 120) * 0.25;
    for (const s of this.states) {
      const key = this.active === s ? 'active' : s.status;
      const [color, k] = COLORS[key];
      const tag = `${color}${key === 'active' ? pulse.toFixed(2) : ''}`;
      if (this.lastColor[s.index] === tag) continue;
      this.lastColor[s.index] = tag;
      this.beacons.setColor(s.index, color, key === 'active' ? k * pulse : k);
    }
  }
}

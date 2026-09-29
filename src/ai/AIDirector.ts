import * as THREE from 'three';
import { Events } from '../core/Events';
import type { Damageable } from '../combat/Damage';
import type { AIContext } from './AIContext';
import type { Bot, BotKind } from './Bot';
import { DIFFICULTIES, type DifficultyId } from './Difficulty';
import { NavGrid } from './NavGrid';
import { PathBudget } from './PathFollower';
import { Tick } from './arc/Tick';
import { Wasp } from './arc/Wasp';
import { Sentinel } from './arc/Sentinel';
import { RaiderBot } from './raider/RaiderBot';
import { Stalker } from './arc/Stalker'; // W4
import { Colossus } from './arc/Colossus'; // W4
import { populateShardcoast } from './Population2'; // W4
import type { GameWorld } from '../world/World';
import type { Physics } from '../physics/Physics';
import type { DamageRegistry } from '../combat/Damage';
import type { Ballistics } from '../weapons/Ballistics';
import type { Effects } from '../combat/Effects';

const CORPSE_TIME = 25;
const SLEEP_DIST = 420;

/**
 * Owns every bot: spawns per map + difficulty, routes noise/alarm events,
 * runs AI at LOD-dependent rates, cleans up corpses.
 */
export class AIDirector {
  readonly bots: Bot[] = [];
  readonly ctx: AIContext;
  enabled = true;
  private raiderIndex = 0;
  private debugPoints: THREE.Points | null = null;

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    registry: DamageRegistry,
    ballistics: Ballistics,
    effects: Effects,
    private world: GameWorld,
    difficulty: DifficultyId,
  ) {
    const heightAt = world.heightAt ? (x: number, z: number) => world.heightAt!(x, z) : () => 0;
    const hm = world.map?.hm;
    const nav = new NavGrid({
      size: hm ? hm.size : 400,
      heightAt,
      blockedTerrain: hm
        ? (x, z) => {
            const n = hm.normal(x, z);
            if (n.y < 0.74) return true; // > ~42°
            const wet = hm.wet[Math.round((z + hm.half) / hm.cell) * hm.n + Math.round((x + hm.half) / hm.cell)];
            return wet > 128 && hm.sample(x, z) < world.map!.def.waterLevel - 0.8;
          }
        : undefined,
    });
    const roam = world.map ? world.map.def.pois.map((p) => new THREE.Vector3(p.center[0], 0, p.center[1])) : [new THREE.Vector3(0, 0, 0), new THREE.Vector3(60, 0, -40)];
    this.ctx = {
      scene, physics, registry, ballistics, effects, nav,
      traversal: world.traversal,
      difficulty: DIFFICULTIES[difficulty],
      heightAt,
      time: 0,
      focus: new THREE.Vector3(),
      roamPoints: roam,
      extracts: world.map ? world.map.extracts.map((e) => e.pos.clone()) : [],
    };

    Events.on('noise', (n: { pos: THREE.Vector3; radius: number; emitter?: Damageable }) => {
      if (!this.enabled) return;
      for (const b of this.bots) {
        if (b === n.emitter || !b.health.alive) continue;
        if (b.pos.distanceTo(n.pos) < n.radius * 1.3) b.hear(n.pos, n.radius, n.emitter);
      }
    });
    Events.on('arc:alarm', ({ pos, target }: { pos: THREE.Vector3; target: THREE.Vector3 }) => {
      for (const b of this.bots) {
        if (b.faction !== 'arc' || !b.health.alive || b.kind === 'sentinel') continue;
        if (b.pos.distanceTo(pos) < 170) b.perception.setInvestigate(target, this.ctx.time);
      }
      Events.emit('toast', 'ARC alarm triggered');
    });
    // W4: loot hook — every ARC kill (the Colossus emits its own) announces a drop
    Events.on('kill', (r: { target: Damageable }) => {
      const b = r.target as Bot;
      if (!this.bots.includes(b) || b.faction !== 'arc' || b.kind === 'colossus') return;
      Events.emit('arc:drop', { kind: b.kind, pos: b.pos.clone() });
    });
  }

  get difficultyId(): DifficultyId {
    return this.ctx.difficulty.id;
  }

  get navBuildMs(): number {
    return this.ctx.nav.buildMs;
  }

  setDifficulty(id: DifficultyId, respawn = true): void {
    this.ctx.difficulty = DIFFICULTIES[id];
    if (respawn) {
      this.clear();
      this.populate();
    }
  }

  // ---------------------------------------------------------------- spawning

  spawn(kind: BotKind, pos: THREE.Vector3, opts: { facing?: number; dormant?: boolean; route?: THREE.Vector3[] } = {}): Bot | null {
    const ctx = this.ctx;
    let bot: Bot;
    switch (kind) {
      case 'tick': {
        const p = ctx.nav.nearestWalkable(pos.x, pos.z, 6);
        if (!p) return null;
        bot = new Tick(ctx, p, opts.dormant ?? true);
        break;
      }
      case 'wasp':
        bot = new Wasp(ctx, pos.clone().setY(ctx.heightAt(pos.x, pos.z) + 14), opts.route ?? []);
        break;
      case 'sentinel':
        bot = new Sentinel(ctx, pos, opts.facing ?? 0);
        break;
      case 'raider': {
        const p = ctx.nav.nearestWalkable(pos.x, pos.z, 10);
        if (!p) return null;
        bot = new RaiderBot(ctx, p.add(new THREE.Vector3(0, 0.1, 0)), this.raiderIndex++);
        break;
      }
      // W4: new ARC kinds
      case 'stalker': {
        const p = ctx.nav.nearestWalkable(pos.x, pos.z, 10);
        if (!p) return null;
        bot = new Stalker(ctx, p, opts.facing ?? Math.random() * Math.PI * 2);
        break;
      }
      case 'colossus':
        bot = new Colossus(ctx, pos.clone().setY(ctx.heightAt(pos.x, pos.z)), opts.route ?? [], opts.facing ?? 0);
        break;
    }
    this.bots.push(bot);
    return bot;
  }

  /** Default population for the current world + difficulty. */
  populate(playerSpawn?: THREE.Vector3): void {
    const map = this.world.map;
    if (!map) return; // arena: spawn from the debug menu
    if (map.def.id === 'shardcoast') return populateShardcoast(this, map, playerSpawn); // W4: per-map tables
    const d = this.ctx.difficulty;
    const def = map.def;
    const hm = map.hm;
    const count = (n: number) => Math.max(1, Math.round(n * d.arcDensity));
    const y = (x: number, z: number) => hm.sample(x, z);
    const v = (x: number, z: number, dy = 0) => new THREE.Vector3(x, y(x, z) + dy, z);

    // Sentinels overlooking key areas
    const sentinels: [number, number, number, number][] = [
      [-60, 30, -250, 0], // dam top, facing south over the valley
      [60, 30, -250, 0.4],
      [330, -1, 100, -0.8], // container yard edge
      [-505, -1, -470, 2.5], // radio hill
      [-160, -1, 455, 3.1], // Lowgate
      [260, -1, -175, 2.8], // pumping station
    ];
    sentinels.slice(0, count(4)).forEach(([x, sy, z, f]) => this.spawn('sentinel', new THREE.Vector3(x, sy >= 0 ? sy : y(x, z), z), { facing: f }));

    // Wasp patrol loops
    const loops: [number, number][][] = [
      [[-200, -380], [200, -380], [240, -200], [-200, -200]],
      [[-260, 380], [-40, 560], [-60, 380]],
      [[300, 120], [440, 300], [420, 480], [260, 330]],
      [[-460, 100], [-520, -300], [-400, -120]],
      [[0, 0], [150, 130], [-40, 100]],
    ];
    loops.slice(0, count(3)).forEach((loop) => {
      const route = loop.map(([x, z]) => new THREE.Vector3(x, 0, z));
      this.spawn('wasp', route[0].clone(), { route });
    });

    // Tick nests in built-up POIs
    const nests: [number, number, number][] = [
      [-160, 480, 6], [-430, 120, 4], [420, 470, 4], [235, -205, 4], [360, 140, 5], [0, -210, 3],
    ];
    for (const [x, z, n] of nests) {
      for (let i = 0; i < count(n); i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 4 + Math.random() * 20;
        this.spawn('tick', v(x + Math.cos(a) * r, z + Math.sin(a) * r), { dormant: true });
      }
    }

    // Lone raiders from spawn points away from the player
    const spawns = def.spawns
      .map(([x, z]) => v(x, z))
      .filter((p) => !playerSpawn || p.distanceTo(playerSpawn) > 250)
      .sort(() => Math.random() - 0.5);
    for (let i = 0; i < d.raiders && i < spawns.length; i++) this.spawn('raider', spawns[i]);
  }

  clear(): void {
    for (const b of this.bots) b.dispose();
    this.bots.length = 0;
  }

  // ---------------------------------------------------------------- update

  /** Per render frame. */
  update(dt: number, focus: THREE.Vector3, alpha: number): void {
    const ctx = this.ctx;
    ctx.time += dt;
    ctx.focus.copy(focus);
    PathBudget.left = PathBudget.perFrame;
    for (let i = this.bots.length - 1; i >= 0; i--) {
      const b = this.bots[i];
      b.focusDist = b.pos.distanceTo(focus);
      if (!b.health.alive) {
        b.deadT += dt;
        // W3: lootable corpses (flagged by the loot system) persist for the raid
        const pinned = (b as { lootPinned?: boolean }).lootPinned === true;
        if (!pinned && (b.deadT > CORPSE_TIME || (b.kind === 'tick' && b.deadT > 4))) {
          b.dispose();
          this.bots.splice(i, 1);
          continue;
        }
      } else if (b.stunT > 0) {
        // W4: EMP stun — no thinking, crackling arcs
        b.stunT -= dt;
        if (Math.random() < dt * 12) {
          const pts: THREE.Vector3[] = [];
          b.aimPoints(pts);
          const c = pts[0] ?? b.pos;
          const r = () => new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
          ctx.effects.lightning(c.clone().add(r()), c.clone().add(r()), 0x8fd8ff);
        }
      } else if (this.enabled && (b.focusDist < SLEEP_DIST || b.kind === 'raider')) {
        b.think(dt);
      }
      // Visual LOD: bots past the fog line aren't drawn at all, and only nearby bots cast
      // shadows (each shadow cascade re-draws every caster). This was ~60% of all draw calls.
      const visDist = b.kind === 'wasp' || b.kind === 'colossus' ? 520 : 300;
      const visible = b.focusDist < visDist;
      b.setVisualLOD(visible, b.focusDist < 45);
      if (visible) (b as { render(dt: number, alpha?: number): void }).render(dt, alpha);
    }
  }

  /** Fixed step (movement integration). */
  step(dt: number): void {
    if (!this.enabled) return;
    for (const b of this.bots) if (b.stunT <= 0) b.fixedStep(dt); // W4: stunned units freeze
  }

  // ---------------------------------------------------------------- debug

  toggleNavDebug(center: THREE.Vector3): void {
    if (this.debugPoints) {
      this.ctx.scene.remove(this.debugPoints);
      this.debugPoints.geometry.dispose();
      this.debugPoints = null;
      return;
    }
    this.debugPoints = this.ctx.nav.debugPoints(center, 40);
    this.ctx.scene.add(this.debugPoints);
  }

  stats(): Record<string, number> {
    const s: Record<string, number> = { tick: 0, wasp: 0, sentinel: 0, raider: 0, stalker: 0, colossus: 0 }; // W4
    for (const b of this.bots) if (b.health.alive) s[b.kind]++;
    return s;
  }
}

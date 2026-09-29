import * as THREE from 'three';
import type { Game } from '../core/Game';
import { Events } from '../core/Events';
import { RAPIER, Groups, interactionGroups } from '../physics/Physics';
import type { Bot } from '../ai/Bot';
import type { DamageResult } from '../combat/Damage';
import type { Voice } from './AudioEngine';
import type { SfxEngine, Surface, Gait } from './Sfx';

/**
 * W6a — polls game state each frame to drive sounds that have no discrete call site:
 * player + raider footsteps (surface/gait), slides/rolls/landings, ARC loops (Wasp rotor with
 * doppler, Colossus engine), Tick skitter, Sentinel servo sweeps, ambience beds by time of day
 * and weather, indoor detection (roof raycast → reverb), extraction/raid timer alarms,
 * container search, low-health heartbeat, and the combat intensity that drives the music.
 */

export type GameLike = Game;

const WORLD_ONLY = interactionGroups(0xffff, Groups.WORLD);
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const DOWN = { x: 0, y: -1, z: 0 };
const UP = { x: 0, y: 1, z: 0 };

interface BotTrack {
  last: THREE.Vector3;
  vel: THREE.Vector3;
  phase: number;
  timer: number;
  alive: boolean;
  loop: Voice | null;
}

export class AudioDirector {
  /** 0..1 combat intensity (music tension). */
  combat = 0;
  private lastCombatT = -99;
  private time = 0;
  // player
  private stepPhase = 0;
  private surface: Surface = 'grass';
  private surfaceT = 0;
  private prevState = '';
  // indoor
  private roofT = 0;
  private roofHit = false;
  // bots
  private tracks = new Map<Bot, BotTrack>();
  // ambience
  private amb: Record<'wind' | 'birds' | 'crickets' | 'rain', Voice | null> = { wind: null, birds: null, crickets: null, rain: null };
  private ambSet = { wind: { g: -1, cut: -1 }, birds: { g: -1, cut: -1 }, crickets: { g: -1, cut: -1 }, rain: { g: -1, cut: -1 } };
  // raid
  private extractBeepT = 0;
  private lastTimeLeft = Infinity;
  private searchT = 0;
  private invOpen = false;
  private lastSearch = -99;
  private heartT = 0;

  constructor(
    private sfx: SfxEngine,
    private game: GameLike,
  ) {
    const E = sfx.E;
    // Segment test used by the engine for occlusion
    E.segmentTest = (from, to) => {
      const w = this.game.physics.world;
      if (!w) return false;
      v1.subVectors(to, from);
      const len = v1.length();
      if (len < 0.5) return false;
      v1.divideScalar(len);
      const ray = new RAPIER.Ray(from, v1);
      return w.castRay(ray, len - 0.3, true, undefined, WORLD_ONLY) !== null;
    };
    Events.on('player:land', ({ speed }: { speed: number }) => {
      if (speed > 2.5) this.sfx.land(this.surface, speed);
    });
    Events.on('player:mantle', () => {
      this.sfx.cloth(undefined, 0.5);
      this.sfx.footstep(this.surface, 'jog', undefined, 0.6);
    });
    Events.on('player:zipline', () => this.sfx.latch());
    Events.on('impact', (e: { point: THREE.Vector3; surface: string; target: boolean }) => {
      if (!e.target) this.sfx.impact(e.point, e.surface);
    });
    Events.on('damage', (r: DamageResult) => {
      const t = r.target as unknown as { faction?: string };
      if (r.target === (this.game.combat as unknown)) this.bumpCombat(1);
      else if (r.source.byPlayer || r.source.attacker === (this.game.combat as unknown)) {
        this.sfx.targetHit(r.point, r.zone.kind, t.faction === 'arc');
        this.bumpCombat(0.8);
      }
    });
    Events.on('kill', (r: DamageResult) => {
      const b = r.target as unknown as Bot;
      if (b.faction === 'arc') this.sfx.arcDestroyed(b.pos ?? r.point, b.kind === 'stalker' || b.kind === 'colossus');
    });
    Events.on('player:shot', () => this.bumpCombat(0.7));
    Events.on('player:hurt', () => this.bumpCombat(1));
    Events.on('arc:alarm', () => this.bumpCombat(0.8));
    Events.on('inv:changed', () => {
      if (this.game.raid?.invUI.open) this.sfx.lootPick();
    });
    Events.on('raid:start', () => {
      this.sfx.ui('confirm');
      this.lastTimeLeft = Infinity;
    });
    Events.on('raid:end', () => this.sfx.ui('confirm'));
    Events.on('player:died', () => this.sfx.hurt());
  }

  private bumpCombat(k: number): void {
    this.lastCombatT = this.time;
    this.combatTarget = Math.max(this.combatTarget, k);
  }
  private combatTarget = 0;

  update(dt: number, paused: boolean): void {
    this.time += dt;
    const g = this.game;
    if (!g.player) return;
    this.updateAmbience(dt, paused);
    if (paused) return;
    this.updateIndoor(dt);
    this.updatePlayer(dt);
    this.updateBots(dt);
    this.updateRaid(dt);
    // combat intensity: recent events + any hostile currently targeting the player nearby
    const since = this.time - this.lastCombatT;
    let hunted = 0;
    for (const b of g.ai?.bots ?? []) {
      if (!b.health.alive || b.focusDist > 90) continue;
      if (b.perception.target === (g.combat as unknown)) hunted = Math.max(hunted, b.perception.targetVisible ? 0.8 : 0.5);
    }
    if (since > 8) this.combatTarget = 0;
    this.combat = Math.max(hunted, since < 8 ? this.combatTarget * (1 - since / 12) : 0);
  }

  // ---------------------------------------------------------------- surfaces / indoor

  /** Classify the surface under a point: heightfield terrain → grass/dirt, thin slabs → metal, crates → wood, else concrete. */
  surfaceAt(p: THREE.Vector3): Surface {
    const w = this.game.physics.world;
    const ray = new RAPIER.Ray({ x: p.x, y: p.y + 0.5, z: p.z }, DOWN);
    const hit = w.castRayAndGetNormal(ray, 3, true, undefined, WORLD_ONLY);
    if (!hit) return this.surface;
    const c = hit.collider;
    const st = c.shapeType();
    if (st === RAPIER.ShapeType.HeightField) {
      if (hit.normal.y < 0.86) return 'dirt';
      // patchy: deterministic dirt patches every ~12 m
      const h = Math.sin(p.x * 0.21 + Math.cos(p.z * 0.17) * 2.1) * Math.cos(p.z * 0.23 - p.x * 0.05);
      return h > 0.55 ? 'dirt' : 'grass';
    }
    if (st === RAPIER.ShapeType.Cuboid) {
      const he = c.halfExtents();
      if (he) {
        if (he.y < 0.16) return 'metal';
        if (Math.max(he.x, he.y, he.z) < 1.3) return 'wood';
      }
    }
    return 'concrete';
  }

  private updateIndoor(dt: number): void {
    this.roofT -= dt;
    const g = this.game;
    if (this.roofT <= 0) {
      this.roofT = 0.25;
      const w = g.physics.world;
      const c = g.player.renderCenter;
      const ray = new RAPIER.Ray({ x: c.x, y: c.y + 1.0, z: c.z }, UP);
      this.roofHit = w.castRay(ray, 25, true, undefined, WORLD_ONLY) !== null;
      this.sfx.E.stats.raycasts++;
    }
    const E = this.sfx.E;
    E.indoor += ((this.roofHit ? 1 : 0) - E.indoor) * Math.min(1, dt * 3);
  }

  // ---------------------------------------------------------------- player

  private updatePlayer(dt: number): void {
    const p = this.game.player;
    const alive = this.game.combat.health.alive;
    this.surfaceT -= dt;
    if (this.surfaceT <= 0) {
      this.surfaceT = 0.2;
      this.surface = this.surfaceAt(p.feet(v2));
    }
    const state = p.state;
    if (state !== this.prevState) {
      if (state === 'slide') this.sfx.slide(this.surface);
      else if (state === 'roll') this.sfx.roll(this.surface);
      else if (state === 'air' && this.prevState === 'ground' && p.velocity.y > 2) this.sfx.cloth(undefined, 0.35);
      else if (state === 'ladder') this.sfx.latch();
      this.prevState = state;
    }
    if (state === 'ground' && p.grounded && alive) {
      const speed = Math.hypot(p.velocity.x, p.velocity.z);
      if (speed > 0.6) {
        const gait: Gait = p.crouched ? 'crouch' : p.locomotion === 'sprint' ? 'sprint' : p.locomotion === 'walk' || speed < 2.8 ? 'walk' : 'jog';
        const interval = { crouch: 0.6, walk: 0.52, jog: 0.35, sprint: 0.28 }[gait];
        this.stepPhase += dt / interval;
        if (this.stepPhase >= 1) {
          this.stepPhase -= 1;
          this.sfx.footstep(this.surface, gait);
        }
      } else this.stepPhase = 0.6; // next step comes quickly after starting to move
    }
    // low-health heartbeat
    const h = this.game.combat.health;
    const frac = h.hp / Math.max(1, h.maxHp);
    if (alive && frac < 0.35) {
      const k = 1 - frac / 0.35;
      this.heartT -= dt;
      if (this.heartT <= 0) {
        this.heartT = 1.05 - k * 0.45;
        this.sfx.heartbeat(k);
      }
    } else this.heartT = 0;
  }

  // ---------------------------------------------------------------- bots

  private updateBots(dt: number): void {
    const bots = this.game.ai?.bots ?? [];
    const L = this.sfx.E.listener;
    const E = this.sfx.E;
    const seen = new Set<Bot>();
    for (const b of bots) {
      seen.add(b);
      let tr = this.tracks.get(b);
      if (!tr) this.tracks.set(b, (tr = { last: b.pos.clone(), vel: new THREE.Vector3(), phase: Math.random(), timer: Math.random(), alive: true, loop: null }));
      if (dt > 0) tr.vel.lerp(v1.subVectors(b.pos, tr.last).divideScalar(dt), Math.min(1, dt * 8));
      tr.last.copy(b.pos);
      const d = b.pos.distanceTo(L);
      const alive = b.health.alive && !b.removed;
      const speed = Math.hypot(tr.vel.x, tr.vel.z);
      const stunned = b.stunT > 0;
      switch (b.kind) {
        case 'raider': {
          if (!alive || d > 45) break;
          const st = (b as unknown as { stance?: () => { speed: number; crouched: boolean } }).stance?.();
          const sp = st?.speed ?? speed;
          if (sp < 0.6) break;
          const crouched = st?.crouched ?? false;
          const gait: Gait = crouched ? 'crouch' : sp > 5.5 ? 'sprint' : sp < 2.8 ? 'walk' : 'jog';
          tr.phase += dt / { crouch: 0.6, walk: 0.52, jog: 0.35, sprint: 0.28 }[gait];
          if (tr.phase >= 1) {
            tr.phase -= 1;
            this.sfx.footstep(this.surfaceAt(b.pos), gait, b.pos, 1.1);
          }
          break;
        }
        case 'tick': {
          if (!alive || stunned || d > 35 || speed < 0.5) break;
          tr.timer -= dt;
          if (tr.timer <= 0) {
            tr.timer = 0.07 + Math.random() * 0.08;
            this.sfx.skitter(b.pos);
          }
          break;
        }
        case 'sentinel': {
          if (!alive || stunned || d > 60 || !b.perception.alerted) break;
          tr.timer -= dt;
          if (tr.timer <= 0) {
            tr.timer = 1.1 + Math.random() * 1.2;
            this.sfx.servo(b.pos);
          }
          break;
        }
        case 'stalker': {
          if (!alive || stunned || d > 60 || speed < 0.4) break;
          tr.timer -= dt;
          if (tr.timer <= 0) {
            tr.timer = 0.9 + Math.random() * 0.8;
            this.sfx.servo(b.pos);
          }
          break;
        }
      }
      // continuous loops: Wasp rotor (doppler), Colossus engine hum
      const loopGroup = b.kind === 'wasp' ? 'arc_rotor' : b.kind === 'colossus' ? 'arc_engine_big' : null;
      const range = b.kind === 'colossus' ? 220 : 90;
      if (loopGroup) {
        const want = alive && d < range && E.ok;
        if (want && !tr.loop) {
          tr.loop = E.play(loopGroup, { pos: b.pos, loop: true, gain: b.kind === 'wasp' ? 0.55 : 0.8, ref: b.kind === 'wasp' ? 5 : 18, rolloff: 1.2, maxDist: range + 10, rate: b.kind === 'wasp' ? 1 : 0.55, rateVar: 0.04 });
        } else if (!want && tr.loop) {
          E.kill(tr.loop, 0.4);
          tr.loop = null;
        }
        if (tr.loop) {
          E.setVoicePos(tr.loop, b.pos);
          const src = tr.loop.src as AudioBufferSourceNode | null;
          if (src) {
            // doppler-ish: radial speed toward the listener raises pitch (exaggerated c)
            v2.subVectors(L, b.pos).normalize();
            const vr = tr.vel.dot(v2);
            const dop = 1 / (1 - Math.max(-0.35, Math.min(0.35, vr / 120)));
            const base = b.kind === 'wasp' ? (stunned ? 0.55 : 0.95 + Math.min(0.35, tr.vel.length() * 0.03)) : 0.55 + Math.min(0.15, speed * 0.05);
            src.playbackRate.setTargetAtTime(base * dop, E.now, 0.08);
          }
        }
      }
      tr.alive = alive;
    }
    for (const [b, tr] of this.tracks) {
      if (seen.has(b)) continue;
      if (tr.loop) E.kill(tr.loop, 0.3);
      this.tracks.delete(b);
    }
  }

  // ---------------------------------------------------------------- ambience

  private updateAmbience(dt: number, paused: boolean): void {
    const E = this.sfx.E;
    if (!E.ok) return;
    const t = E.now;
    const tod = this.game.world?.dayNight?.current ?? 'noon';
    const indoor = E.indoor;
    const rain = this.sfx.rainLevel;
    const outdoor = 1 - indoor * 0.75;
    const targets = {
      wind: (0.32 + rain * 0.2) * outdoor,
      birds: (tod === 'morning' ? 0.4 : tod === 'noon' ? 0.28 : tod === 'dusk' ? 0.12 : 0.06) * (1 - rain) * (1 - indoor * 0.85) * (1 - this.combat * 0.6),
      crickets: (tod === 'dusk' ? 0.3 : tod === 'overcast' ? 0.12 : 0.04) * (1 - rain * 0.8) * (1 - indoor * 0.8),
      rain: rain * 0.55 * (1 - indoor * 0.35),
    };
    const groups = { wind: 'amb_wind', birds: 'amb_birds', crickets: 'amb_crickets', rain: 'amb_rain' } as const;
    for (const k of Object.keys(groups) as (keyof typeof groups)[]) {
      const want = targets[k];
      let v = this.amb[k];
      if (!v && want > 0.01 && E.has(groups[k])) {
        v = this.amb[k] = E.play(groups[k], { bus: 'amb', loop: true, gain: 0.0001, gainVar: 0, rateVar: 0, reverb: 0, occlude: false });
        if (v) v.gain.gain.setValueAtTime(0.0001, t);
      }
      if (!v) continue;
      const prev = this.ambSet[k];
      const cut = indoor > 0.5 ? (k === 'rain' ? 1400 : 900) : 18000;
      if (Math.abs(prev.g - want) > 0.004) {
        prev.g = want;
        v.gain.gain.setTargetAtTime(Math.max(0.0001, want), t, 1.2);
      }
      if (prev.cut !== cut) {
        prev.cut = cut;
        // indoors: muffled weather through the roof
        v.filter.frequency.setTargetAtTime(cut, t, 0.4);
      }
    }
    void dt;
    void paused;
  }

  // ---------------------------------------------------------------- raid

  private updateRaid(dt: number): void {
    const raid = this.game.raid;
    if (!raid || raid.phase !== 'raid') {
      this.lastTimeLeft = Infinity;
      return;
    }
    // extraction countdown: beacon blips, faster + urgent in the last 3 s, alarm on start
    const ex = raid.extraction;
    if (ex.active) {
      const left = ex.holdTime - ex.progress;
      const pos = ex.active.point.pos;
      if (ex.progress < dt * 1.5) this.sfx.alarm(pos);
      this.extractBeepT -= dt;
      if (this.extractBeepT <= 0) {
        this.extractBeepT = left < 3 ? 0.25 : 1;
        this.sfx.extractBeep(undefined, left < 3);
      }
      if (Math.floor(ex.progress / 4) !== Math.floor((ex.progress - dt) / 4)) this.sfx.alarm(pos);
    } else this.extractBeepT = 0;
    // raid timer warnings
    const tl = raid.timeLeft;
    if ([300, 120, 60, 30].some((mark) => this.lastTimeLeft > mark && tl <= mark)) this.sfx.raidWarning(false);
    if (tl <= 10 && Math.ceil(tl) !== Math.ceil(this.lastTimeLeft) && tl > 0) this.sfx.raidWarning(true);
    this.lastTimeLeft = tl;
    // container search rummage + open
    if (raid.searchT >= 0) {
      this.lastSearch = this.time;
      this.searchT -= dt;
      if (this.searchT <= 0) {
        this.searchT = 0.28 + Math.random() * 0.15;
        this.sfx.rummage();
      }
    } else this.searchT = 0;
    const open = raid.invUI.open;
    if (open && !this.invOpen) {
      if (this.time - this.lastSearch < 0.6) this.sfx.containerOpen();
      else this.sfx.ui('open');
    } else if (!open && this.invOpen) this.sfx.ui('close');
    this.invOpen = open;
  }
}

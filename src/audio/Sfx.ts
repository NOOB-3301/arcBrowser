import * as THREE from 'three';
import type { WeaponClass } from '../weapons/WeaponDefs';
import { Settings } from '../core/Settings';
import { Events } from '../core/Events';
import { AudioEngine, type BusName, type PlayOpts } from './AudioEngine';
import { renderLayers, N, T, type Layer } from './Synth';
import { Music } from './Music';
import { AudioDirector, type GameLike } from './AudioDirector';

/**
 * W6a — sample-based spatial SFX facade. Public method names/signatures are unchanged from the
 * procedural placeholder so every call site keeps compiling; each method now layers CC0 samples
 * (public/assets/audio) through the AudioEngine (HRTF, occlusion, reverb, voice cap), with the
 * old synthesis kept as a sub layer and as the fallback when a sample group is unavailable.
 */

export type Surface = 'grass' | 'dirt' | 'concrete' | 'wood' | 'metal';
export type Gait = 'walk' | 'jog' | 'sprint' | 'crouch';

interface GunProfile {
  body: [group: string, gain: number, rate: number][];
  /** Synth sub thump (Hz, gain). */
  sub: [number, number];
  tail: number;
  fallback: Layer[];
}

const heavyFallback = [N({ freq: 700, decay: 0.35, gain: 0.9 }), N({ freq: 4000, type: 'highpass', decay: 0.05, gain: 0.35 }), T({ freq: 90, to: 40, decay: 0.25, gain: 0.6 })];
const lightFallback = [N({ freq: 1400, decay: 0.16, gain: 0.6 }), N({ freq: 4000, type: 'highpass', decay: 0.05, gain: 0.35 }), T({ freq: 140, to: 40, decay: 0.1, gain: 0.3 })];

const GUNS: Record<WeaponClass, GunProfile> = {
  pistol: { body: [['gun_pistol', 1, 1]], sub: [130, 0.25], tail: 0.25, fallback: lightFallback },
  smg: { body: [['gun_pistol', 0.85, 1.12], ['gun_rifle', 0.35, 1.25]], sub: [120, 0.25], tail: 0.28, fallback: lightFallback },
  ar: { body: [['gun_rifle', 1, 1], ['gun_crack', 0.35, 1.1]], sub: [100, 0.35], tail: 0.4, fallback: lightFallback },
  battle: { body: [['gun_heavy', 1, 1.05], ['gun_rifle', 0.45, 0.9]], sub: [80, 0.5], tail: 0.5, fallback: heavyFallback },
  marksman: { body: [['gun_heavy', 1, 0.92], ['gun_crack', 0.5, 0.85]], sub: [70, 0.6], tail: 0.65, fallback: heavyFallback },
  dmr: { body: [['gun_rifle', 1, 0.9], ['gun_heavy', 0.5, 1.1]], sub: [85, 0.45], tail: 0.5, fallback: heavyFallback },
  shotgun: { body: [['gun_shotgun', 1, 1]], sub: [65, 0.6], tail: 0.6, fallback: heavyFallback },
  lmg: { body: [['gun_rifle', 1, 0.86], ['gun_crack', 0.45, 0.9]], sub: [85, 0.45], tail: 0.5, fallback: lightFallback },
  energy: { body: [['gun_energy', 0.8, 1]], sub: [180, 0.2], tail: 0.12, fallback: [T({ freq: 1400, to: 180, type: 'sawtooth', decay: 0.18, gain: 0.18 }), N({ freq: 3000, type: 'highpass', decay: 0.08, gain: 0.15 })] },
  revolver: { body: [['gun_revolver', 1, 1], ['gun_heavy', 0.4, 1.25]], sub: [75, 0.55], tail: 0.55, fallback: heavyFallback },
};

const STEP_GAIN: Record<Gait, number> = { crouch: 0.22, walk: 0.38, jog: 0.55, sprint: 0.8 };
const SURF_RATE: Record<Surface, number> = { grass: 1, dirt: 1, concrete: 1, wood: 1, metal: 0.85 };

function vol(key: string, def: number): number {
  // Keys added by a parallel workstream; read defensively so this compiles before and after.
  const v = (Settings as unknown as { get?: (k: string) => unknown }).get?.(key);
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1.5, v)) : def;
}

class SfxEngine {
  readonly E = new AudioEngine();
  /** Legacy master volume (kept for API compatibility; volMaster setting drives the bus). */
  volume = 0.5;
  private music: Music | null = null;
  private director: AudioDirector | null = null;
  private game: GameLike | null = null;
  private pausedDuck = 1;
  private uiBound = false;

  /** Listener position (camera). Game copies into this each frame. */
  get listener(): THREE.Vector3 {
    return this.E.listener;
  }

  constructor() {
    this.E.prefetch();
    this.bindUi();
    if (import.meta.env.DEV) (window as unknown as { __audioStats: unknown; __sfx: unknown }).__audioStats = this.E.stats;
    if (import.meta.env.DEV) (window as unknown as { __sfx: unknown }).__sfx = this;
  }

  unlock(): void {
    const fresh = !this.E.ctx;
    this.E.unlock();
    if (fresh && this.E.ctx) {
      this.music = new Music(this.E.ctx, this.E.bus.music);
      this.applyVolumes();
    }
  }

  /** W6a: wire game state (physics raycasts, per-frame polling for footsteps, ARC loops, ambience…). */
  attach(game: GameLike): void {
    this.game = game;
    this.director = new AudioDirector(this, game);
  }

  private applyVolumes(): void {
    this.E.setVolumes(this.volumes(), true);
  }

  volumes(): Record<BusName | 'master', number> {
    const sfx = vol('volSfx', 1);
    return {
      master: vol('volMaster', 0.8),
      sfx: sfx * this.pausedDuck,
      amb: sfx * 0.9 * this.pausedDuck,
      music: vol('volMusic', 0.6),
      ui: vol('volUi', 0.8),
    };
  }

  /** Per-frame: listener, buses (live vol* settings), occlusion, director polling, music. */
  update(dt: number, paused = false): void {
    this.pausedDuck += ((paused ? 0.3 : 1) - this.pausedDuck) * Math.min(1, dt * 6);
    if (!this.E.ctx || !this.game) return;
    this.E.update(this.game.camera, dt, this.volumes());
    this.director?.update(dt, paused);
    this.music?.update(dt, this.director?.combat ?? 0);
  }

  // ---------------------------------------------------------------- helpers

  /** Play a sample group; fall back to synthesis layers when the group isn't available. */
  layer(group: string, opts: PlayOpts = {}, fallback?: Layer[]): void {
    if (!this.E.ok) return;
    if (this.E.has(group)) this.E.play(group, opts);
    else if (fallback) this.synth(group, opts, fallback);
  }

  synth(key: string, opts: PlayOpts, layers: Layer[]): void {
    if (!this.E.ok) return;
    this.E.synth(key, { gainVar: 0, ...opts }, (ctx, out, t) => ({ dur: renderLayers(ctx, this.E.noise, out, t, layers), src: null }));
  }

  private dist(pos?: THREE.Vector3): number {
    return pos ? pos.distanceTo(this.E.listener) : 0;
  }

  private bindUi(): void {
    if (this.uiBound || typeof document === 'undefined') return;
    this.uiBound = true;
    const SEL = 'button, [data-nav], [data-act], [role="button"], .m-tab, select, input[type="checkbox"]';
    let hoverEl: Element | null = null;
    document.addEventListener(
      'pointerdown',
      (e) => {
        const el = (e.target as Element | null)?.closest?.(SEL);
        if (!el) return;
        this.unlock();
        const back = /back|close|cancel/i.test((el as HTMLElement).dataset?.act ?? '') || /\b(back|close|cancel)\b/i.test(el.textContent ?? '');
        this.ui(back ? 'back' : 'click');
      },
      true,
    );
    document.addEventListener(
      'pointerover',
      (e) => {
        const el = (e.target as Element | null)?.closest?.(SEL) ?? null;
        if (el && el !== hoverEl) this.ui('hover');
        hoverEl = el;
      },
      true,
    );
    document.addEventListener(
      'input',
      (e) => {
        if ((e.target as HTMLInputElement | null)?.type === 'range') this.ui('tick');
      },
      true,
    );
    // settings sliders apply immediately even while paused / before the next frame
    Events.on('settings:changed', () => this.applyVolumes());
  }

  // ---------------------------------------------------------------- UI / raid

  ui(kind: 'click' | 'hover' | 'back' | 'confirm' | 'error' | 'open' | 'close' | 'tick'): void {
    const map = { click: 'ui_click', hover: 'ui_hover', back: 'ui_back', confirm: 'ui_confirm', error: 'ui_error', open: 'ui_open', close: 'ui_close', tick: 'tick' };
    const g = kind === 'hover' ? 0.35 : kind === 'tick' ? 0.3 : 0.7;
    this.layer(map[kind], { bus: 'ui', gain: g, priority: 8, reverb: 0, cooldown: kind === 'hover' || kind === 'tick' ? 0.05 : 0.03 }, [T({ freq: kind === 'back' ? 600 : 1200, type: 'square', decay: 0.03, gain: 0.06 })]);
  }

  lootPick(): void {
    this.layer('loot_pick', { bus: 'ui', gain: 0.55, priority: 7, reverb: 0, cooldown: 0.08 }, [N({ freq: 2500, type: 'bandpass', q: 3, decay: 0.05, gain: 0.25 })]);
  }
  lootDrop(): void {
    this.layer('loot_drop', { bus: 'ui', gain: 0.5, priority: 7, reverb: 0, cooldown: 0.08 });
  }
  containerOpen(pos?: THREE.Vector3): void {
    this.layer(Math.random() < 0.5 ? 'box_open' : 'box_open_1', { pos, gain: 0.7, ref: 3, priority: 6, cooldown: 0.3, cooldownKey: 'box' });
  }
  rummage(pos?: THREE.Vector3): void {
    this.layer(Math.random() < 0.6 ? 'rummage' : 'cloth', { pos, gain: 0.45, ref: 3, rateVar: 0.12, priority: 5 }, [N({ freq: 1800, type: 'bandpass', q: 1, decay: 0.12, gain: 0.2 })]);
  }
  /** Extraction beacon countdown blip; urgent = last seconds. */
  extractBeep(pos: THREE.Vector3 | undefined, urgent: boolean): void {
    this.layer(urgent ? 'arc_beep' : 'beep', { pos, bus: pos ? 'sfx' : 'ui', gain: urgent ? 0.6 : 0.45, ref: 10, rate: urgent ? 1.3 : 1, priority: 8 }, [T({ freq: urgent ? 1800 : 1200, type: 'square', decay: 0.1, gain: 0.12 })]);
  }
  alarm(pos?: THREE.Vector3): void {
    this.layer('alarm', { pos, gain: 0.55, ref: 14, maxDist: 400, priority: 8, cooldown: 1.5 }, [T({ freq: 900, to: 600, type: 'sawtooth', decay: 0.8, gain: 0.12 })]);
  }
  raidWarning(final: boolean): void {
    this.layer(final ? 'tick' : 'beep', { bus: 'ui', gain: final ? 0.6 : 0.7, priority: 9, reverb: 0 }, [T({ freq: 1000, type: 'square', decay: 0.12, gain: 0.1 })]);
  }
  heartbeat(intensity: number): void {
    this.layer('heartbeat', { gain: 0.35 + intensity * 0.5, rate: 0.95 + intensity * 0.1, lowpass: 900, reverb: 0, priority: 9, gainVar: 0 }, [T({ freq: 60, to: 40, decay: 0.12, gain: 0.5 }), T({ freq: 55, to: 38, decay: 0.12, gain: 0.35, delay: 0.25 })]);
  }

  // ---------------------------------------------------------------- movement

  footstep(surface: Surface, gait: Gait, pos?: THREE.Vector3, gainMul = 1): void {
    const g = STEP_GAIN[gait] * gainMul;
    const rate = SURF_RATE[surface] * (gait === 'sprint' ? 1.05 : gait === 'crouch' ? 0.92 : 1);
    this.layer(`step_${surface}`, { pos, gain: g, rate, rateVar: 0.08, gainVar: 0.15, ref: 3, rolloff: 1.4, maxDist: 60, priority: pos ? 3 : 6, lowpass: gait === 'crouch' ? 3500 : undefined, reverb: 0.6 }, [N({ freq: surface === 'metal' ? 2600 : 600, type: 'bandpass', q: 1.2, decay: 0.06, gain: 0.3 * g })]);
    if (gait === 'sprint' && Math.random() < 0.35) this.layer('belt', { pos, gain: 0.15 * gainMul, ref: 2, maxDist: 25, priority: 2, rateVar: 0.1 });
  }
  land(surface: Surface, speed: number, pos?: THREE.Vector3): void {
    const k = Math.min(1, speed / 12);
    this.layer('land', { pos, gain: 0.35 + k * 0.6, ref: 3, priority: 6 }, [N({ freq: 300, decay: 0.2, gain: 0.5 })]);
    this.footstep(surface, 'sprint', pos, 0.8 + k);
    if (k > 0.5) this.layer('cloth', { pos, gain: 0.4, ref: 2, priority: 4 });
  }
  slide(surface: Surface, pos?: THREE.Vector3): void {
    this.layer('thud', { pos, gain: 0.35, ref: 3, priority: 5 });
    const base = surface === 'metal' ? 2400 : surface === 'concrete' ? 1600 : 900;
    this.synth('slide', { pos, ref: 3, priority: 5 }, [N({ freq: base, type: 'bandpass', q: 0.8, decay: 0.7, gain: 0.35, attack: 0.04 }), N({ freq: 300, decay: 0.5, gain: 0.2 })]);
    this.layer('cloth', { pos, gain: 0.35, ref: 2, priority: 3, delay: 0.05 });
  }
  roll(surface: Surface, pos?: THREE.Vector3): void {
    this.layer('cloth', { pos, gain: 0.5, ref: 2, priority: 4 });
    this.layer('land', { pos, gain: 0.35, ref: 3, priority: 4, delay: 0.18, rate: 1.15 });
    this.footstep(surface, 'jog', pos, 0.7);
  }
  cloth(pos?: THREE.Vector3, gain = 0.4): void {
    this.layer('cloth', { pos, gain, ref: 2, priority: 3, cooldown: 0.08, cooldownKey: pos ? undefined : 'cloth-self' });
  }
  latch(pos?: THREE.Vector3): void {
    this.layer('mech_latch', { pos, gain: 0.5, ref: 3, priority: 5 });
  }

  // ---------------------------------------------------------------- weapons

  shot(cls: WeaponClass, suppressed = false, energy = false, pos?: THREE.Vector3): void {
    if (!this.E.ok) return;
    const p = GUNS[cls] ?? GUNS.ar;
    const d = this.dist(pos);
    const own = !pos;
    if (energy || cls === 'energy') return this.energyShot(pos, d);
    if (d > 450) return;
    const delay = pos ? Math.min(d / 343, 1.2) : 0;
    if (suppressed) {
      if (pos && d > 140) return;
      for (const [g, gain, rate] of p.body) this.layer(g, { pos, gain: gain * 0.35, rate: rate * 1.1, lowpass: 1600, ref: 5, priority: own ? 9 : 6, delay }, p.fallback);
      this.layer('mech_click', { pos, gain: own ? 0.4 : 0.3, rate: 1.4, ref: 3, priority: own ? 8 : 4 });
      this.synth('shot-sup', { pos, ref: 5, priority: 4, delay }, [N({ freq: 1800, type: 'bandpass', q: 1.2, decay: 0.07, gain: 0.3 })]);
      return;
    }
    if (d < 90) {
      for (const [g, gain, rate] of p.body) this.layer(g, { pos, gain: gain * (own ? 0.9 : 1), rate, rateVar: 0.04, ref: 14, priority: own ? 9 : 7, delay, maxDist: 450 }, p.fallback);
      this.synth('shot-sub', { pos, ref: 14, priority: own ? 8 : 4, delay, reverb: 0.3 }, [T({ freq: p.sub[0], to: 38, decay: 0.16, gain: p.sub[1] })]);
      if (own) this.layer('mech_click', { gain: 0.12, rate: 0.8, priority: 5 });
    }
    // distant tail: reflections; grows relatively louder and darker with distance
    const far = Math.max(0, d - 90);
    const lp = pos ? Math.max(350, 6500 * Math.exp(-far / 160)) : 7000;
    this.layer('gun_tail', { pos, gain: p.tail * (d < 90 ? 0.8 : 1.6), rate: 0.95, rateVar: 0.06, lowpass: lp, ref: 25, maxDist: 450, priority: own ? 5 : 3, delay: delay + 0.02, cooldown: own ? 0.09 : 0.05, cooldownKey: own ? 'tail-own' : undefined, occlude: true, reverb: 0.4 });
  }

  private energyShot(pos: THREE.Vector3 | undefined, d: number): void {
    if (d > 250) return;
    const own = !pos;
    this.layer(own ? 'gun_energy' : 'gun_energy_small', { pos, gain: own ? 0.6 : 0.7, rate: own ? 1 : 0.85, rateVar: 0.06, ref: 12, maxDist: 250, priority: own ? 9 : 6 }, GUNS.energy.fallback);
    this.synth('energy-zap', { pos, ref: 12, priority: 3, maxDist: 150 }, [T({ freq: own ? 1400 : 900, to: 180, type: 'sawtooth', decay: 0.14, gain: 0.07 }), N({ freq: 3000, type: 'highpass', decay: 0.06, gain: 0.08 })]);
  }

  dry(): void {
    this.layer('mech_click', { gain: 0.5, rate: 1.6, priority: 8, cooldown: 0.08 }, [T({ freq: 2200, type: 'square', decay: 0.03, gain: 0.08 })]);
  }
  reloadStart(): void {
    this.layer('cloth', { gain: 0.3, priority: 6 });
    this.layer('reload_magout', { gain: 0.7, priority: 8, delay: 0.1 }, [N({ freq: 2500, type: 'bandpass', q: 3, decay: 0.05, gain: 0.25 })]);
  }
  reloadEnd(): void {
    this.layer('reload_magin', { gain: 0.75, priority: 8 }, [N({ freq: 1800, type: 'bandpass', q: 4, decay: 0.05, gain: 0.3 })]);
    this.layer(Math.random() < 0.5 ? 'reload_bolt' : 'reload_slide', { gain: 0.65, priority: 8, delay: 0.14 }, [N({ freq: 2600, type: 'bandpass', q: 4, decay: 0.05, gain: 0.3, delay: 0.08 })]);
  }
  shell(): void {
    // pump/shell insert on shotguns + a brass tinkle landing a moment later
    this.layer('reload_pump', { gain: 0.3, rate: 1.1, priority: 5, cooldown: 0.15 }, [N({ freq: 1500, type: 'bandpass', q: 3, decay: 0.06, gain: 0.25 })]);
    this.layer('brass', { gain: 0.18, rate: 1.6, rateVar: 0.15, priority: 2, delay: 0.35 + Math.random() * 0.15, lowpass: 7000, cooldown: 0.1, cooldownKey: 'brass' });
  }
  /** Ejected casing tinkle for rapid-fire weapons (optional). */
  brass(pos?: THREE.Vector3): void {
    this.layer('brass', { pos, gain: 0.12, rate: 1.7, rateVar: 0.2, ref: 2, priority: 1, delay: 0.3 + Math.random() * 0.2, cooldown: 0.12, cooldownKey: 'brass' });
  }
  hit(head: boolean): void {
    if (head) this.synth('hit-head', { bus: 'ui', priority: 9, reverb: 0 }, [T({ freq: 1500, to: 1300, decay: 0.12, gain: 0.16 }), T({ freq: 2250, to: 2000, decay: 0.08, gain: 0.06 })]);
    else this.synth('hit', { bus: 'ui', priority: 8, reverb: 0, cooldown: 0.03 }, [N({ freq: 3500, type: 'bandpass', q: 5, decay: 0.03, gain: 0.2 })]);
  }
  kill(): void {
    this.synth('kill', { bus: 'ui', priority: 9, reverb: 0 }, [T({ freq: 700, decay: 0.12, gain: 0.14 }), T({ freq: 1050, decay: 0.2, gain: 0.14, delay: 0.07 })]);
  }
  plate(dist: number): void {
    const delay = Math.min(dist / 343, 1);
    this.layer('imp_metal_med', { gain: 0.5, rate: 1.3, priority: 7, delay, lowpass: 9000 - Math.min(dist, 300) * 20 }, [T({ freq: 880, decay: 0.8, gain: 0.25, delay })]);
    this.synth('plate-ring', { priority: 5, delay, reverb: 0.5 }, [T({ freq: 880, decay: 0.8, gain: 0.08 }), T({ freq: 1320, decay: 0.5, gain: 0.04 })]);
  }
  overheat(): void {
    this.layer('hiss', { gain: 0.35, rate: 1.4, priority: 7, duration: 0.9 }, [N({ freq: 5000, type: 'highpass', decay: 0.9, gain: 0.2 })]);
  }
  hurt(): void {
    this.layer('flesh', { gain: 0.5, priority: 9, reverb: 0.2, cooldown: 0.06 }, [T({ freq: 160, to: 70, type: 'triangle', decay: 0.25, gain: 0.35 })]);
    this.synth('hurt-sub', { priority: 7, reverb: 0 }, [T({ freq: 110, to: 55, type: 'triangle', decay: 0.2, gain: 0.25 })]);
  }
  swap(): void {
    this.layer('cloth', { gain: 0.35, priority: 6 });
    this.layer('handle', { gain: 0.45, priority: 7, delay: 0.06 }, [N({ freq: 1200, type: 'bandpass', q: 2, decay: 0.08, gain: 0.2 })]);
    this.layer('mech_click', { gain: 0.35, priority: 7, delay: 0.22, rate: 0.9 });
  }
  /** Bullet impact on world geometry. */
  impact(point: THREE.Vector3, surface: string): void {
    const d = this.dist(point);
    if (d > 45) return;
    const g = surface === 'dirt' ? 'imp_dirt' : surface === 'metal' ? 'imp_metal' : surface === 'machine' ? 'imp_metal_med' : surface === 'flesh' ? 'flesh' : 'imp_concrete';
    this.layer(g, { pos: point, gain: 0.45, ref: 3, rateVar: 0.12, maxDist: 45, priority: 2, cooldown: 0.025, cooldownKey: 'impact' });
  }
  /** Bullet hit on a target (ARC armour ping vs weak-point crunch, flesh thud). */
  targetHit(point: THREE.Vector3, zone: string, arc: boolean): void {
    if (arc) {
      if (zone === 'weakpoint') {
        this.layer('imp_glass', { pos: point, gain: 0.6, ref: 6, priority: 6, cooldown: 0.04, cooldownKey: 'wp' });
        this.layer('imp_metal_heavy', { pos: point, gain: 0.55, ref: 6, rate: 1.1, priority: 6, cooldown: 0.04, cooldownKey: 'wp2' });
      } else {
        this.layer('imp_metal', { pos: point, gain: 0.6, ref: 6, rate: 1.25, rateVar: 0.1, priority: 5, cooldown: 0.03, cooldownKey: 'armor' }, [N({ freq: 2800, type: 'bandpass', q: 3, decay: 0.05, gain: 0.3 })]);
        this.synth('armor-ping', { pos: point, ref: 6, priority: 3, cooldown: 0.05 }, [T({ freq: 2400 + Math.random() * 900, to: 2100, decay: 0.12, gain: 0.05 })]);
      }
    } else this.layer('flesh', { pos: point, gain: 0.35, ref: 4, priority: 4, cooldown: 0.04, cooldownKey: 'flesh' });
  }

  // ---------------------------------------------------------------- explosions / ARC / throwables

  explosion(pos: THREE.Vector3, size = 1): void {
    const d = this.dist(pos);
    if (d > 900) return;
    const delay = Math.min(d / 343, 2.5);
    if (d < 110 * Math.sqrt(size)) {
      this.layer('expl_near', { pos, gain: Math.min(1.2, 0.8 * size), rate: 1 / Math.sqrt(Math.max(0.4, size)) * 0.95, ref: 18 * size, maxDist: 900, priority: 9, delay }, [N({ freq: 400, decay: 0.9 * size, gain: 1 }), T({ freq: 70, to: 25, decay: 0.8, gain: 0.9 }), N({ freq: 2500, type: 'highpass', decay: 0.15, gain: 0.4 })]);
      this.layer('expl_low', { pos, gain: 0.8, ref: 25 * size, maxDist: 900, priority: 8, delay, rate: 0.9 });
      this.synth('expl-sub', { pos, ref: 20 * size, priority: 7, delay, maxDist: 600 }, [T({ freq: 60, to: 24, decay: 0.9 * Math.sqrt(size), gain: 0.7 })]);
      if (size >= 1.5) this.layer('expl_big', { pos, gain: 0.8, ref: 30, maxDist: 900, priority: 8, delay: delay + 0.03 });
      if (size >= 0.6) this.layer('arc_debris', { pos, gain: 0.35, ref: 8, maxDist: 60, priority: 3, delay: delay + 0.25 });
    } else {
      this.layer('expl_far', { pos, gain: Math.min(1.4, 0.9 * size + 0.3), ref: 60 * size, maxDist: 900, priority: 7, delay, lowpass: Math.max(300, 3000 * Math.exp(-(d - 110) / 300)) }, [N({ freq: 200, decay: 1.4, gain: 0.8 }), T({ freq: 45, to: 25, decay: 1.2, gain: 0.6 })]);
    }
  }
  beep(pos: THREE.Vector3, high = false): void {
    this.layer('arc_beep', { pos, gain: 0.45, rate: high ? 1.35 : 1, rateVar: 0, ref: 8, maxDist: 80, priority: 7, cooldown: 0.12, duration: 0.25 }, [T({ freq: high ? 1800 : 1200, type: 'square', decay: 0.08, gain: 0.12 })]);
  }
  chitter(pos: THREE.Vector3): void {
    const layers = [0, 1, 2].map((i) => N({ freq: 3000 + i * 400, type: 'bandpass', q: 8, decay: 0.03, gain: 0.25, delay: i * 0.05 }));
    for (let i = 0; i < 3; i++) this.layer('arc_skitter', { pos, gain: 0.3, rate: 1.6 + Math.random() * 0.5, ref: 3, maxDist: 40, priority: 5, delay: i * 0.05 }, i === 0 ? layers : undefined);
    this.layer('arc_servo', { pos, gain: 0.25, rate: 2.2, ref: 3, maxDist: 40, priority: 4, duration: 0.18, offset: Math.random() * 0.5 });
  }
  /** Tick leg skitter while moving (director). */
  skitter(pos: THREE.Vector3): void {
    this.layer('arc_skitter', { pos, gain: 0.18, rate: 1.8 + Math.random() * 0.6, rateVar: 0.1, ref: 2.5, maxDist: 35, priority: 2 }, [N({ freq: 3400, type: 'bandpass', q: 8, decay: 0.025, gain: 0.15 })]);
  }
  arcHit(pos: THREE.Vector3): void {
    this.targetHit(pos, 'armor', true);
  }
  /** ARC unit destroyed. */
  arcDestroyed(pos: THREE.Vector3, big: boolean): void {
    this.layer('arc_debris', { pos, gain: 0.7, ref: big ? 14 : 6, maxDist: 250, priority: 7 });
    this.layer('imp_metal_heavy', { pos, gain: 0.6, ref: big ? 14 : 6, rate: 0.8, maxDist: 250, priority: 6, delay: 0.1 });
    this.synth('arc-die', { pos, ref: 8, maxDist: 200, priority: 5 }, [T({ freq: 900, to: 90, type: 'sawtooth', decay: 0.5, gain: 0.08 })]);
  }
  laserCharge(pos: THREE.Vector3, dur = 1): void {
    this.layer('arc_charge', { pos, gain: 0.6, rate: Math.max(0.5, Math.min(1.6, 1 / dur)), ref: 14, maxDist: 250, priority: 7 }, [T({ freq: 220, to: 1400, type: 'sawtooth', decay: dur, gain: 0.12 })]);
    this.synth('laser-rise', { pos, ref: 14, maxDist: 200, priority: 6 }, [T({ freq: 220, to: 1400, type: 'sawtooth', decay: dur, gain: 0.05, attack: dur * 0.6 })]);
  }
  laserFire(pos: THREE.Vector3, dur = 1.4): void {
    this.layer('arc_laser', { pos, gain: 0.8, rate: 0.7, ref: 18, maxDist: 300, priority: 8 });
    this.synth('laser-beam', { pos, ref: 18, maxDist: 300, priority: 8 }, [T({ freq: 90, to: 70, type: 'sawtooth', decay: dur, gain: 0.2 }), N({ freq: 2400, type: 'bandpass', q: 2, decay: dur, gain: 0.2 })]);
  }
  stomp(pos: THREE.Vector3, size = 1): void {
    const d = this.dist(pos);
    this.layer('arc_stomp', { pos, gain: Math.min(1, 0.35 + size * 0.25), rate: 1.1 / Math.sqrt(size), ref: 8 * size, maxDist: 120 * size, priority: size > 1.5 ? 7 : 4, delay: Math.min(d / 343, 0.6) }, [N({ freq: 300, decay: 0.35 * size, gain: 0.5 })]);
    this.synth('stomp-sub', { pos, ref: 10 * size, maxDist: 150 * size, priority: 5 }, [T({ freq: 60 / Math.sqrt(size), to: 25, decay: 0.5 * size, gain: 0.6 })]);
    if (size >= 2) this.layer('arc_debris', { pos, gain: 0.25, ref: 10, maxDist: 80, priority: 2, delay: 0.15 });
  }
  servo(pos: THREE.Vector3): void {
    this.layer('arc_servo', { pos, gain: 0.4, rate: 1.3 + Math.random() * 0.3, ref: 5, maxDist: 60, priority: 4, duration: 0.35, offset: Math.random() * 1.5 }, [T({ freq: 380, to: 520, type: 'square', decay: 0.12, gain: 0.05 })]);
  }
  mortar(pos: THREE.Vector3): void {
    this.layer('arc_rocket', { pos, gain: 0.9, ref: 25, maxDist: 500, priority: 8 }, [T({ freq: 140, to: 50, decay: 0.3, gain: 0.6 }), N({ freq: 900, decay: 0.25, gain: 0.5 })]);
    this.synth('mortar-thump', { pos, ref: 25, maxDist: 500, priority: 7 }, [T({ freq: 110, to: 45, decay: 0.3, gain: 0.5 })]);
  }
  incoming(pos: THREE.Vector3): void {
    this.synth('incoming', { pos, ref: 30, maxDist: 200, priority: 8 }, [T({ freq: 2200, to: 500, type: 'sine', decay: 0.9, gain: 0.14 })]);
  }
  throwItem(): void {
    this.layer('cloth', { gain: 0.4, priority: 6 }, [N({ freq: 900, type: 'bandpass', q: 1.5, decay: 0.12, gain: 0.25 })]);
    this.layer('pin', { gain: 0.35, priority: 6, rate: 1.3 });
  }
  bounce(pos: THREE.Vector3): void {
    this.layer('imp_metal', { pos, gain: 0.4, rate: 1.4, rateVar: 0.15, ref: 3, maxDist: 40, priority: 4, cooldown: 0.06 }, [N({ freq: 1600, type: 'bandpass', q: 4, decay: 0.05, gain: 0.3 })]);
  }
  emp(pos: THREE.Vector3): void {
    this.layer('emp', { pos, gain: 0.8, ref: 15, maxDist: 200, priority: 8 }, [T({ freq: 1800, to: 60, type: 'sawtooth', decay: 0.7, gain: 0.35 })]);
    this.synth('emp-sweep', { pos, ref: 15, maxDist: 200, priority: 7 }, [T({ freq: 1800, to: 60, type: 'sawtooth', decay: 0.7, gain: 0.12 }), N({ freq: 5000, type: 'highpass', decay: 0.4, gain: 0.2 })]);
  }
  smokePop(pos: THREE.Vector3): void {
    this.layer('imp_metal', { pos, gain: 0.4, rate: 0.7, ref: 4, maxDist: 60, priority: 5 });
    this.layer('hiss', { pos, gain: 0.55, rate: 0.8, ref: 5, maxDist: 60, priority: 5, duration: 3.5 }, [N({ freq: 700, decay: 1.2, gain: 0.35 })]);
    this.synth('smoke-hiss', { pos, ref: 5, maxDist: 60, priority: 4 }, [N({ freq: 4500, type: 'highpass', decay: 3.5, gain: 0.12, attack: 0.1 })]);
  }
  decoyPing(pos: THREE.Vector3): void {
    this.layer('gun_pistol', { pos, gain: 0.7, ref: 14, maxDist: 250, priority: 6, rate: 1.1 }, [T({ freq: 1300, type: 'square', decay: 0.1, gain: 0.12 })]);
    this.layer('gun_tail', { pos, gain: 0.3, ref: 25, maxDist: 250, priority: 3, delay: 0.03 });
  }
  mineArm(pos: THREE.Vector3): void {
    this.layer('arc_beep', { pos, gain: 0.35, rate: 1.6, ref: 4, maxDist: 40, priority: 5, duration: 0.15 }, [T({ freq: 2600, type: 'square', decay: 0.05, gain: 0.1 })]);
  }
  /** Thunder clap, delayed by distance (speed of sound). */
  thunder(dist: number): void {
    const delay = Math.min(dist / 343, 6);
    const g = Math.max(0.25, 1 - dist / 2500);
    this.layer('thunder', { bus: 'amb', gain: 0.9 * g, delay, rate: 0.85 + Math.random() * 0.3, lowpass: Math.max(400, 5000 - dist * 2), priority: 8, reverb: 0 }, [N({ freq: 180, decay: 2.6, gain: 0.9 * g, delay }), T({ freq: 55, to: 30, decay: 2.2, gain: 0.6 * g, delay })]);
    if (dist < 600) this.synth('thunder-crack', { bus: 'amb', priority: 8, delay, reverb: 0 }, [N({ freq: 900, decay: 0.6, gain: 0.4 * g }), T({ freq: 45, to: 25, decay: 2, gain: 0.5 * g })]);
  }
  /** Continuous rain bed, 0 = off (director owns the loop). */
  setRain(level: number): void {
    this.rainLevel = level;
  }
  rainLevel = 0;
}

export const Sfx = new SfxEngine();
export type { SfxEngine };

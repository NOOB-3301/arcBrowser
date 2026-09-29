import * as THREE from 'three';
import type { WeaponClass } from '../weapons/WeaponDefs';

/**
 * Procedurally synthesised placeholder SFX via WebAudio (real samples in M7).
 * AudioContext is created lazily on the first user gesture.
 */
class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.5;
  /** Listener position (player) for distance attenuation. */
  readonly listener = new THREE.Vector3();
  /** Gain multiplier applied to the sound currently being built. */
  private vol = 1;

  /** Set attenuation for a sound emitted at `pos`; returns false if inaudible. */
  private at(pos?: THREE.Vector3, ref = 12): boolean {
    if (!pos) {
      this.vol = 1;
      return true;
    }
    const d = pos.distanceTo(this.listener);
    this.vol = 1 / (1 + Math.pow(d / ref, 1.6));
    return this.vol > 0.01;
  }

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  private get ok(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Filtered noise burst with exponential decay. */
  private burst(opts: { freq: number; q?: number; type?: BiquadFilterType; decay: number; gain: number; delay?: number }): void {
    if (!this.ok) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'lowpass';
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0011, opts.gain * this.vol), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.decay);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + opts.decay + 0.05);
  }

  private tone(opts: { freq: number; to?: number; type?: OscillatorType; decay: number; gain: number; delay?: number }): void {
    if (!this.ok) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + opts.decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0011, opts.gain * this.vol), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.decay);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + opts.decay + 0.05);
  }

  shot(cls: WeaponClass, suppressed = false, energy = false, pos?: THREE.Vector3): void {
    if (!this.at(pos, 25)) return;
    if (energy) {
      this.tone({ freq: cls === 'energy' ? 1400 : 900, to: 180, type: 'sawtooth', decay: 0.18, gain: 0.18 });
      this.burst({ freq: 3000, type: 'highpass', decay: 0.08, gain: 0.15 });
      return;
    }
    if (suppressed) {
      this.burst({ freq: 1800, type: 'bandpass', q: 1.2, decay: 0.07, gain: 0.35 });
      return;
    }
    const heavy = cls === 'marksman' || cls === 'battle' || cls === 'dmr' || cls === 'shotgun' || cls === 'revolver';
    const body = heavy ? 700 : cls === 'lmg' ? 1000 : 1400;
    this.burst({ freq: body, decay: heavy ? 0.35 : 0.16, gain: heavy ? 0.9 : 0.6 });
    this.burst({ freq: 4000, type: 'highpass', decay: 0.05, gain: 0.35 });
    this.tone({ freq: heavy ? 90 : 140, to: 40, decay: heavy ? 0.25 : 0.1, gain: heavy ? 0.6 : 0.3 });
  }

  explosion(pos: THREE.Vector3, size = 1): void {
    if (!this.at(pos, 30 * size)) return;
    this.burst({ freq: 400, decay: 0.9 * size, gain: 1 });
    this.tone({ freq: 70, to: 25, decay: 0.8, gain: 0.9 });
    this.burst({ freq: 2500, type: 'highpass', decay: 0.15, gain: 0.4 });
  }
  beep(pos: THREE.Vector3, high = false): void {
    if (!this.at(pos, 20)) return;
    this.tone({ freq: high ? 1800 : 1200, type: 'square', decay: 0.08, gain: 0.12 });
  }
  chitter(pos: THREE.Vector3): void {
    if (!this.at(pos, 8)) return;
    for (let i = 0; i < 3; i++) this.burst({ freq: 3000 + i * 400, type: 'bandpass', q: 8, decay: 0.03, gain: 0.25, delay: i * 0.05 });
  }
  arcHit(pos: THREE.Vector3): void {
    if (!this.at(pos, 15)) return;
    this.burst({ freq: 2800, type: 'bandpass', q: 3, decay: 0.05, gain: 0.3 });
  }
  dry(): void {
    this.vol = 1;
    this.tone({ freq: 2200, type: 'square', decay: 0.03, gain: 0.08 });
  }
  reloadStart(): void {
    this.vol = 1;
    this.burst({ freq: 2500, type: 'bandpass', q: 3, decay: 0.05, gain: 0.25 });
  }
  reloadEnd(): void {
    this.vol = 1;
    this.burst({ freq: 1800, type: 'bandpass', q: 4, decay: 0.05, gain: 0.3 });
    this.burst({ freq: 2600, type: 'bandpass', q: 4, decay: 0.05, gain: 0.3, delay: 0.08 });
  }
  shell(): void {
    this.vol = 1;
    this.burst({ freq: 1500, type: 'bandpass', q: 3, decay: 0.06, gain: 0.25 });
  }
  hit(head: boolean): void {
    this.vol = 1;
    if (head) this.tone({ freq: 1500, to: 1300, decay: 0.12, gain: 0.2 });
    else this.burst({ freq: 3500, type: 'bandpass', q: 5, decay: 0.03, gain: 0.25 });
  }
  kill(): void {
    this.vol = 1;
    this.tone({ freq: 700, decay: 0.12, gain: 0.18 });
    this.tone({ freq: 1050, decay: 0.2, gain: 0.18, delay: 0.07 });
  }
  plate(dist: number): void {
    this.vol = 1;
    this.tone({ freq: 880, decay: 0.8, gain: 0.25, delay: Math.min(dist / 343, 1) });
  }
  overheat(): void {
    this.vol = 1;
    this.burst({ freq: 5000, type: 'highpass', decay: 0.9, gain: 0.2 });
  }
  hurt(): void {
    this.vol = 1;
    this.tone({ freq: 160, to: 70, type: 'triangle', decay: 0.25, gain: 0.35 });
  }
  swap(): void {
    this.vol = 1;
    this.burst({ freq: 1200, type: 'bandpass', q: 2, decay: 0.08, gain: 0.2 });
  }
}

export const Sfx = new SfxEngine();

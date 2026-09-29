import * as THREE from 'three';
import { SAMPLE_FILES, groupOf, sampleUrl } from './Bank';

/**
 * W6a — WebAudio core: buses, sample bank, voice pool (cap + priority stealing + cooldowns),
 * HRTF spatialisation, occlusion low-pass, indoor convolution reverb.
 *
 *   voice:  src → filter(lowpass: distance air + occlusion) → gain → [panner] → bus
 *                                                       └→ send → convolver → reverbOut → sfx bus
 *   buses:  sfx / amb / music / ui → master → limiter → destination
 */

export type BusName = 'sfx' | 'amb' | 'music' | 'ui';

export interface PlayOpts {
  /** World position; omit for 2D (player-own / UI) sounds. */
  pos?: THREE.Vector3;
  gain?: number;
  /** Random ± fraction applied to gain. */
  gainVar?: number;
  rate?: number;
  /** Random ± fraction applied to playback rate. */
  rateVar?: number;
  bus?: BusName;
  /** Inverse-distance reference distance (m). */
  ref?: number;
  rolloff?: number;
  /** Cull beyond this distance (m). */
  maxDist?: number;
  /** 0..10; higher survives voice stealing. */
  priority?: number;
  delay?: number;
  /** Extra low-pass cutoff (Hz). */
  lowpass?: number;
  /** Raycast occlusion for positional voices (default true). */
  occlude?: boolean;
  /** Reverb send multiplier (default 1). */
  reverb?: number;
  offset?: number;
  /** Hard stop after n seconds (with fade). */
  duration?: number;
  loop?: boolean;
  /** Per-key minimum retrigger interval (s). */
  cooldown?: number;
  cooldownKey?: string;
}

export interface Voice {
  src: AudioScheduledSourceNode | null;
  filter: BiquadFilterNode;
  occ: GainNode;
  gain: GainNode;
  panner: PannerNode | null;
  send: GainNode;
  pos: THREE.Vector3 | null;
  priority: number;
  base: number;
  start: number;
  end: number;
  loop: boolean;
  baseCut: number;
  occluded: number;
  occlT: number;
  done: boolean;
  bus: BusName;
}

export interface AudioStats {
  unlocked: boolean;
  frames: number;
  state: string;
  loaded: number;
  failed: number;
  total: number;
  voices: number;
  loops: number;
  peakVoices: number;
  maxVoices: number;
  played: number;
  synth: number;
  stolen: number;
  rejected: number;
  culled: number;
  cooldownSkips: number;
  occludedVoices: number;
  raycasts: number;
  indoor: number;
  reverbWet: number;
  buses: Record<BusName | 'master', number>;
  byKey: Record<string, number>;
}

/** Raycaster used for occlusion / roof checks: returns true if the segment hits world geometry. */
export type SegmentTest = (from: THREE.Vector3, to: THREE.Vector3) => boolean;

const MAX_VOICES = 40;
const tmp = new THREE.Vector3();

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  readonly bus = {} as Record<BusName, GainNode>;
  private reverbIn!: GainNode;
  private reverbOut!: GainNode;
  noise!: AudioBuffer;
  readonly listener = new THREE.Vector3();
  private readonly buffers = new Map<string, AudioBuffer[]>();
  private readonly lastPick = new Map<string, number>();
  private readonly cooldowns = new Map<string, number>();
  private readonly raw = new Map<string, Promise<ArrayBuffer | null>>();
  readonly voices: Voice[] = [];
  /** Long-lived loops (not subject to stealing). */
  readonly loops = new Set<Voice>();
  segmentTest: SegmentTest | null = null;
  /** 0..1 indoor factor (drives reverb wet). */
  indoor = 0;
  private rayBudget = 0;
  readonly stats: AudioStats = {
    unlocked: false, frames: 0, state: 'none', loaded: 0, failed: 0, total: SAMPLE_FILES.length,
    voices: 0, loops: 0, peakVoices: 0, maxVoices: MAX_VOICES, played: 0, synth: 0, stolen: 0, rejected: 0, culled: 0,
    cooldownSkips: 0, occludedVoices: 0, raycasts: 0, indoor: 0, reverbWet: 0,
    buses: { master: 0, sfx: 0, amb: 0, music: 0, ui: 0 }, byKey: {},
  };

  /** Start downloading sample bytes early (no AudioContext needed). */
  prefetch(): void {
    if (this.raw.size) return;
    for (const f of SAMPLE_FILES) {
      this.raw.set(
        f,
        fetch(sampleUrl(f))
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null),
      );
    }
  }

  get ok(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
      this.master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      this.master.connect(limiter).connect(ctx.destination);
      for (const b of ['sfx', 'amb', 'music', 'ui'] as BusName[]) {
        const g = ctx.createGain();
        g.connect(this.master);
        this.bus[b] = g;
      }
      // Reverb: per-voice sends → convolver → wet gain → sfx bus
      this.reverbIn = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.buffer = this.impulse(1.8, 2.6);
      this.reverbOut = ctx.createGain();
      this.reverbOut.gain.value = 0.1;
      this.reverbIn.connect(conv).connect(this.reverbOut).connect(this.bus.sfx);
      // Shared white noise for synthesis
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.stats.unlocked = true;
      if (ctx.state === 'suspended') void ctx.resume();
      this.prefetch();
      void this.decodeAll();
    } catch {
      this.ctx = null;
    }
  }

  private async decodeAll(): Promise<void> {
    const ctx = this.ctx!;
    await Promise.all(
      SAMPLE_FILES.map(async (f) => {
        const bytes = await this.raw.get(f);
        if (!bytes) {
          this.stats.failed++;
          return;
        }
        try {
          const buf = await ctx.decodeAudioData(bytes.slice(0));
          const g = groupOf(f);
          let list = this.buffers.get(g);
          if (!list) this.buffers.set(g, (list = []));
          list.push(buf);
          this.stats.loaded++;
        } catch {
          this.stats.failed++;
        }
      }),
    );
  }

  has(group: string): boolean {
    return this.buffers.has(group);
  }

  /** Random variant of a group, avoiding an immediate repeat. */
  pick(group: string): AudioBuffer | null {
    const list = this.buffers.get(group);
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    let i = Math.floor(Math.random() * list.length);
    if (i === this.lastPick.get(group)) i = (i + 1) % list.length;
    this.lastPick.set(group, i);
    return list[i];
  }

  /** Generated stereo impulse response: early reflections + exponentially decaying, darkening tail. */
  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // one-pole low-pass whose coefficient drops over time → high frequencies die first
        const k = 0.9 - 0.8 * t;
        lp = lp + k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.pow(1 - t, decay);
      }
      // a few discrete early reflections (small room)
      for (let r = 0; r < 6; r++) {
        const at = Math.floor(ctx.sampleRate * (0.007 + r * 0.011 + Math.random() * 0.006));
        if (at < n) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.6 - r * 0.08);
      }
    }
    return ir;
  }

  // ---------------------------------------------------------------- voices

  private cooldownOk(key: string | undefined, cd: number | undefined): boolean {
    if (!key || !cd) return true;
    const t = performance.now() / 1000;
    const last = this.cooldowns.get(key) ?? -1e9;
    if (t - last < cd) {
      this.stats.cooldownSkips++;
      return false;
    }
    this.cooldowns.set(key, t);
    return true;
  }

  /** Expected inverse-distance gain (for culling / stealing scores). */
  private distGain(d: number, ref: number, rolloff: number): number {
    return d <= ref ? 1 : ref / (ref + rolloff * (d - ref));
  }

  /** Make room for a voice of the given score; false if it should be rejected. */
  private admit(score: number): boolean {
    this.reap();
    if (this.voices.length < MAX_VOICES) return true;
    let worst: Voice | null = null;
    let worstScore = Infinity;
    const now = this.now;
    for (const v of this.voices) {
      const age = now - v.start;
      const s = v.priority + v.base * 4 - age * 0.5;
      if (s < worstScore) {
        worstScore = s;
        worst = v;
      }
    }
    if (!worst || worstScore > score) {
      this.stats.rejected++;
      return false;
    }
    this.kill(worst, 0.03);
    this.stats.stolen++;
    return true;
  }

  kill(v: Voice, fade = 0.05): void {
    if (v.done) return;
    v.done = true;
    const t = this.now;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + fade);
    try {
      v.src?.stop(t + fade + 0.01);
    } catch {
      /* already stopped */
    }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    this.loops.delete(v);
    setTimeout(() => this.disconnect(v), (fade + 0.1) * 1000);
  }

  private disconnect(v: Voice): void {
    try {
      v.src?.disconnect();
      v.filter.disconnect();
      v.occ.disconnect();
      v.gain.disconnect();
      v.panner?.disconnect();
      v.send.disconnect();
    } catch {
      /* ignore */
    }
  }

  private reap(): void {
    const now = this.now;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (!v.loop && now > v.end) {
        v.done = true;
        this.voices.splice(i, 1);
        this.disconnect(v);
      }
    }
  }

  /**
   * Build the voice chain. `feed` connects a source (buffer or synth graph) into `input` and
   * returns the source's length in seconds (or Infinity for loops) + the scheduled source, if any.
   */
  private voice(
    opts: PlayOpts,
    key: string,
    feed: (input: AudioNode, t: number) => { dur: number; src: AudioScheduledSourceNode | null },
  ): Voice | null {
    if (!this.ok) return null;
    if (!this.cooldownOk(opts.cooldownKey ?? key, opts.cooldown)) return null;
    const ctx = this.ctx!;
    const pos = opts.pos ?? null;
    const ref = opts.ref ?? 6;
    const rolloff = opts.rolloff ?? 1;
    let dist = 0;
    let dg = 1;
    if (pos) {
      dist = pos.distanceTo(this.listener);
      if (dist > (opts.maxDist ?? 200)) {
        this.stats.culled++;
        return null;
      }
      dg = this.distGain(dist, ref, rolloff);
      if (dg * (opts.gain ?? 1) < 0.004) {
        this.stats.culled++;
        return null;
      }
    }
    const priority = opts.priority ?? 5;
    if (!opts.loop && !this.admit(priority + dg * 4)) return null;

    const t = ctx.currentTime + (opts.delay ?? 0);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    // air absorption: distant sounds lose their top end
    const air = pos ? Math.max(700, 20000 * Math.exp(-dist / 180)) : 20000;
    const baseCut = Math.min(air, opts.lowpass ?? 20000);
    filter.frequency.value = baseCut;
    const occ = ctx.createGain();
    const gain = ctx.createGain();
    const gv = opts.gainVar ?? 0.1;
    gain.gain.value = (opts.gain ?? 1) * (1 + (Math.random() * 2 - 1) * gv);
    filter.connect(occ).connect(gain);
    const bus = opts.bus ?? 'sfx';
    let panner: PannerNode | null = null;
    if (pos) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = ref;
      panner.rolloffFactor = rolloff;
      panner.maxDistance = 10000;
      setPannerPos(panner, pos, t);
      gain.connect(panner).connect(this.bus[bus]);
    } else gain.connect(this.bus[bus]);
    const send = ctx.createGain();
    send.gain.value = (opts.reverb ?? 1) * (bus === 'sfx' ? 1 : 0);
    (panner ?? gain).connect(send).connect(this.reverbIn);

    const { dur, src } = feed(filter, t);
    if (opts.duration !== undefined && Number.isFinite(dur)) {
      const g0 = gain.gain.value;
      gain.gain.setValueAtTime(g0, t + Math.max(0, dur - 0.06));
      gain.gain.linearRampToValueAtTime(0, t + dur);
    }
    const v: Voice = {
      src, filter, occ, gain, panner, send, pos: pos ? pos.clone() : null, priority, base: dg,
      start: t, end: t + dur + 0.05, loop: !!opts.loop, baseCut, occluded: 0, occlT: 0, done: false, bus,
    };
    if (pos && opts.occlude !== false) this.applyOcclusion(v, true);
    if (opts.loop) this.loops.add(v);
    else this.voices.push(v);
    this.stats.played++;
    this.stats.byKey[key] = (this.stats.byKey[key] ?? 0) + 1;
    this.stats.peakVoices = Math.max(this.stats.peakVoices, this.voices.length);
    return v;
  }

  /** Play a random variant of a sample group. Returns null if missing / culled / rejected. */
  play(group: string, opts: PlayOpts = {}): Voice | null {
    if (!this.ok) return null;
    const buf = this.pick(group);
    if (!buf) return null;
    return this.voice(opts, group, (input, t) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      const rv = opts.rateVar ?? 0.05;
      const rate = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * rv);
      src.playbackRate.value = rate;
      src.loop = !!opts.loop;
      if (src.loop) {
        // skip codec priming at the edges so the loop seam is clean
        src.loopStart = Math.min(0.01, buf.duration * 0.1);
        src.loopEnd = buf.duration - 0.005;
      }
      src.connect(input);
      const off = opts.offset ?? (src.loop ? Math.random() * buf.duration * 0.9 : 0);
      let dur = (buf.duration - (src.loop ? 0 : off)) / rate;
      if (opts.duration !== undefined) {
        dur = Math.min(dur, opts.duration);
        src.start(t, off);
        src.stop(t + dur + 0.06);
      } else if (src.loop) {
        src.start(t, off);
        dur = Infinity;
      } else src.start(t, off);
      return { dur, src };
    });
  }

  /** Voice around a synthesised graph (procedural fallback, music-style layers). */
  synth(key: string, opts: PlayOpts, build: (ctx: AudioContext, out: AudioNode, t: number) => { dur: number; src: AudioScheduledSourceNode | null }): Voice | null {
    const v = this.voice(opts, key, (input, t) => build(this.ctx!, input, t));
    if (v) this.stats.synth++;
    return v;
  }

  // ---------------------------------------------------------------- per-frame

  /** Occlusion: raycast listener → source through world geometry; smooth low-pass + gain cut. */
  private applyOcclusion(v: Voice, initial: boolean): void {
    if (!v.pos || !this.segmentTest) return;
    if (this.rayBudget <= 0 && !initial) return;
    if (initial && this.rayBudget <= -12) return; // hard cap per frame even for new voices
    this.rayBudget--;
    this.stats.raycasts++;
    tmp.copy(v.pos);
    tmp.y += 0.4; // lift ground-level sources (footsteps) off the terrain
    const hit = this.segmentTest(this.listener, tmp) ? 1 : 0;
    v.occlT = this.now;
    if (hit === v.occluded && !initial) return;
    v.occluded = hit;
    const cut = hit ? Math.min(v.baseCut, 900) : v.baseCut;
    const tt = this.now;
    if (initial) {
      v.filter.frequency.setValueAtTime(cut, tt);
      v.occ.gain.setValueAtTime(hit ? 0.45 : 1, tt);
    } else {
      v.filter.frequency.setTargetAtTime(cut, tt, 0.08);
      v.occ.gain.setTargetAtTime(hit ? 0.45 : 1, tt, 0.08);
    }
  }

  setVoicePos(v: Voice, pos: THREE.Vector3): void {
    if (!v.panner || v.done) return;
    (v.pos ??= new THREE.Vector3()).copy(pos);
    setPannerPos(v.panner, pos, this.now);
  }

  private lastVols: Record<string, number> = {};

  /** Apply bus gains; `snap` jumps immediately (settings change), else glides. Only touches changed buses. */
  setVolumes(vols: Record<BusName | 'master', number>, snap: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const k of ['master', 'sfx', 'amb', 'music', 'ui'] as const) {
      const v = vols[k];
      if (!snap && Math.abs((this.lastVols[k] ?? -1) - v) < 1e-4) continue;
      this.lastVols[k] = v;
      const p = (k === 'master' ? this.master : this.bus[k]).gain;
      p.cancelScheduledValues(t);
      if (snap) p.setValueAtTime(v, t);
      else {
        p.setValueAtTime(p.value, t);
        p.setTargetAtTime(v, t, 0.05);
      }
    }
    this.stats.buses = { ...vols };
  }

  update(camera: THREE.Camera, dt: number, vols: Record<BusName | 'master', number>): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.stats.state = ctx.state;
    this.stats.frames++;
    // listener pose
    const l = ctx.listener;
    this.listener.copy(camera.position);
    const fwd = tmp.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      l.positionX.setTargetAtTime(camera.position.x, t, 0.01);
      l.positionY.setTargetAtTime(camera.position.y, t, 0.01);
      l.positionZ.setTargetAtTime(camera.position.z, t, 0.01);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.01);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.01);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.01);
      l.upX.setTargetAtTime(up.x, t, 0.01);
      l.upY.setTargetAtTime(up.y, t, 0.01);
      l.upZ.setTargetAtTime(up.z, t, 0.01);
    } else {
      l.setPosition(camera.position.x, camera.position.y, camera.position.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
    // buses
    this.setVolumes(vols, false);
    // reverb wet follows the indoor factor (automation only when it moves)
    const wet = 0.1 + 0.55 * this.indoor;
    if (Math.abs(wet - this.stats.reverbWet) > 0.002) this.reverbOut.gain.setTargetAtTime(wet, t, 0.2);
    this.stats.reverbWet = wet;
    this.stats.indoor = this.indoor;
    // occlusion refresh: small ray budget per frame, oldest checks first
    this.rayBudget = 6;
    this.reap();
    let occl = 0;
    const refresh = (v: Voice) => {
      if (v.pos && t - v.occlT > 0.3 && v.end - t > 0.25) this.applyOcclusion(v, false);
      occl += v.occluded;
    };
    for (const v of this.loops) refresh(v);
    for (const v of this.voices) refresh(v);
    this.stats.occludedVoices = occl;
    this.stats.voices = this.voices.length;
    this.stats.loops = this.loops.size;
    void dt;
  }
}

function setPannerPos(p: PannerNode, pos: THREE.Vector3, t: number): void {
  if (p.positionX) {
    p.positionX.setValueAtTime(pos.x, t);
    p.positionY.setValueAtTime(pos.y, t);
    p.positionZ.setValueAtTime(pos.z, t);
  } else p.setPosition(pos.x, pos.y, pos.z);
}

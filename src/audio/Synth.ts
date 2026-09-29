/**
 * W6a — procedural synthesis layers (the old placeholder synth, now routed through the voice
 * chain so it is spatialised, occluded and voice-limited). Used as sub/body layers under samples
 * and as the fallback when a sample group failed to load.
 */

export interface BurstP {
  freq: number;
  q?: number;
  type?: BiquadFilterType;
  decay: number;
  gain: number;
  delay?: number;
  attack?: number;
}
export interface ToneP {
  freq: number;
  to?: number;
  type?: OscillatorType;
  decay: number;
  gain: number;
  delay?: number;
  attack?: number;
}

export type Layer = { k: 'n'; p: BurstP } | { k: 't'; p: ToneP };
export const N = (p: BurstP): Layer => ({ k: 'n', p });
export const T = (p: ToneP): Layer => ({ k: 't', p });

/** Render layers into `out` starting at t; returns total duration (s). */
export function renderLayers(ctx: AudioContext, noise: AudioBuffer, out: AudioNode, t0: number, layers: Layer[]): number {
  let end = 0;
  for (const l of layers) {
    const p = l.p;
    const t = t0 + (p.delay ?? 0);
    const g = ctx.createGain();
    const a = p.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0011, p.gain), t + a);
    g.gain.exponentialRampToValueAtTime(0.0008, t + a + p.decay);
    g.connect(out);
    if (l.k === 'n') {
      const bp = l.p;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = ctx.createBiquadFilter();
      f.type = bp.type ?? 'lowpass';
      f.frequency.value = bp.freq;
      f.Q.value = bp.q ?? 0.7;
      src.connect(f).connect(g);
      src.start(t, Math.random() * 1.2);
      src.stop(t + a + bp.decay + 0.05);
    } else {
      const tp = l.p;
      const o = ctx.createOscillator();
      o.type = tp.type ?? 'sine';
      o.frequency.setValueAtTime(tp.freq, t);
      if (tp.to) o.frequency.exponentialRampToValueAtTime(tp.to, t + a + tp.decay);
      o.connect(g);
      o.start(t);
      o.stop(t + a + tp.decay + 0.05);
    }
    end = Math.max(end, t - t0 + a + p.decay + 0.05);
  }
  return end;
}

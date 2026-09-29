/**
 * W6a — low-volume generative music bed on the music bus.
 *  - calm layer: slowly moving minor-key pad (detuned saws through a breathing low-pass)
 *  - tension layer: pulsing low drone + high cluster shimmer, faded in by combat intensity
 * No assets: all oscillators, a handful of nodes, no per-frame scheduling beyond chord changes.
 */

// D minor-ish progression (Hz): Dm, Bb, F/C, C sus
const CHORDS: number[][] = [
  [146.83, 174.61, 220.0],
  [116.54, 146.83, 174.61],
  [130.81, 174.61, 220.0],
  [130.81, 164.81, 196.0],
];

export class Music {
  private out: GainNode;
  private calm: GainNode;
  private tension: GainNode;
  private voices: OscillatorNode[][] = [];
  private chord = 0;
  private chordT = 0;
  /** 0..1 smoothed intensity. */
  level = 0;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    const t = ctx.currentTime;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(1, t + 6);
    this.out.connect(dest);

    // --- calm pad
    this.calm = ctx.createGain();
    this.calm.gain.value = 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 320;
    lfo.connect(lfoAmt).connect(lp.frequency);
    lfo.start();
    lp.connect(this.calm).connect(this.out);
    for (const f of CHORDS[0]) {
      const pair: OscillatorNode[] = [];
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0.22;
        o.connect(g).connect(lp);
        o.start();
        pair.push(o);
      }
      this.voices.push(pair);
    }

    // --- tension: pulsing drone + shimmer
    this.tension = ctx.createGain();
    this.tension.gain.value = 0;
    this.tension.connect(this.out);
    const drone = ctx.createOscillator();
    drone.type = 'square';
    drone.frequency.value = 73.42;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 240;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    const pl = ctx.createOscillator();
    pl.frequency.value = 2.2; // ~132 bpm pulse
    const plAmt = ctx.createGain();
    plAmt.gain.value = 0.5;
    pl.connect(plAmt).connect(pulse.gain);
    drone.connect(dlp).connect(pulse).connect(this.tension);
    drone.start();
    pl.start();
    const shimmer = ctx.createBiquadFilter();
    shimmer.type = 'bandpass';
    shimmer.frequency.value = 1800;
    shimmer.Q.value = 6;
    const sg = ctx.createGain();
    sg.gain.value = 0.18;
    for (const f of [587.3, 622.3, 880]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(shimmer);
      o.start();
    }
    const trem = ctx.createOscillator();
    trem.frequency.value = 6.5;
    const tremAmt = ctx.createGain();
    tremAmt.gain.value = 0.12;
    trem.connect(tremAmt).connect(sg.gain);
    trem.start();
    shimmer.connect(sg).connect(this.tension);
  }

  /** combat 0..1 (instantaneous target); called each frame. */
  update(dt: number, combat: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const k = combat > this.level ? 1.5 : 0.12; // rise fast, fall slowly
    this.level += (combat - this.level) * Math.min(1, dt * k);
    this.tension.gain.setTargetAtTime(this.level * 0.09, t, 0.3);
    this.calm.gain.setTargetAtTime(0.05 * (1 - this.level * 0.5), t, 0.5);
    this.chordT -= dt;
    if (this.chordT <= 0) {
      this.chordT = 12 + Math.random() * 6;
      this.chord = (this.chord + 1) % CHORDS.length;
      const c = CHORDS[this.chord];
      this.voices.forEach((pair, i) => pair.forEach((o) => o.frequency.setTargetAtTime(c[i], t, 2.5)));
    }
  }
}

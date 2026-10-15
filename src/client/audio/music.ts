// Dynamic, procedural score. One beat-locked sequencer drives layers that fade in with the
// intensity of the fight:
//   calm    (always)  warm pad, slow arpeggio, a sparse lead motif, sonar pings
//   tension (> 0.3)   pulsing bass ostinato, ticking hats, the filter opens
//   combat  (> 0.6)   taiko drums, 16th-note string ostinato, brass stabs, faster tempo
// Harmony is D minor; each theatre colours the melody with its own scale.
// Notes are scheduled slightly ahead on the audio clock (lookahead scheduler), so timing
// stays tight even when the frame rate drops.

type Theme = 'desert' | 'jungle' | 'arctic';

const ROOT = 146.83; // D3
const hz = (semi: number) => ROOT * Math.pow(2, semi / 12);

/** Chords as semitones from D. Calm: i VI III VII. Tense: i iv VI V (harmonic minor). */
const CALM = [
  [0, 3, 7],
  [-4, 0, 3],
  [3, 7, 10],
  [-2, 2, 5],
];
const TENSE = [
  [0, 3, 7],
  [5, 8, 12],
  [-4, 0, 3],
  [-5, -1, 2],
];
/** Melody scales per theatre (semitones from D). */
const SCALES: Record<Theme, number[]> = {
  desert: [0, 1, 4, 5, 7, 8, 10], // Phrygian dominant
  jungle: [0, 3, 5, 7, 10], // minor pentatonic
  arctic: [0, 2, 3, 7, 10], // sparse, open
};

export class Music {
  private gains: Record<'pad' | 'arp' | 'lead' | 'bass' | 'hats' | 'drums' | 'strings' | 'brass', GainNode>;
  private delay: DelayNode;
  private noise: AudioBuffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private next = 0;
  private step = 0;
  private bar = 0;
  private bpm = 92;
  private filter: BiquadFilterNode;
  private theme: Theme = 'desert';
  /** Smoothed intensity 0..1 and the value the game asks for. */
  level = 0;
  private target = 0;
  private motif: number[] = [];

  constructor(
    private ctx: AudioContext,
    out: AudioNode,
    reverb: AudioNode,
  ) {
    // Master music filter: dark when calm, opens up in combat.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2200;
    this.filter.Q.value = 0.4;
    this.filter.connect(out);
    const mk = (send: number) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.filter);
      if (send > 0) {
        const s = ctx.createGain();
        s.gain.value = send;
        g.connect(s).connect(reverb);
      }
      return g;
    };
    this.gains = {
      pad: mk(0.7),
      arp: mk(0.5),
      lead: mk(0.6),
      bass: mk(0.08),
      hats: mk(0.15),
      drums: mk(0.25),
      strings: mk(0.3),
      brass: mk(0.35),
    };
    // Dotted-eighth echo on the arpeggio and lead.
    this.delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const dl = ctx.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 1800;
    this.delay.connect(dl).connect(fb).connect(this.delay);
    const dOut = ctx.createGain();
    dOut.gain.value = 0.45;
    dl.connect(dOut).connect(this.filter);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.newMotif();
  }

  setTheme(t: string) {
    if (t === 'desert' || t === 'jungle' || t === 'arctic') this.theme = t;
    this.newMotif();
  }

  /** 0 = quiet patrol, 1 = full battle. Rises fast, falls slowly (see update). */
  setIntensity(v: number) {
    this.target = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  start() {
    if (this.timer) return;
    this.next = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 40);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const t = this.ctx.currentTime;
    for (const g of Object.values(this.gains)) g.gain.setTargetAtTime(0, t, 0.6);
  }

  /** Short phrase over the top for big moments. */
  stinger(kind: 'victory' | 'defeat' | 'capture') {
    const t = this.ctx.currentTime + 0.05;
    const notes = kind === 'victory' ? [0, 7, 12, 15, 19, 24] : kind === 'defeat' ? [12, 10, 8, 7, 3, 0] : [7, 12, 15];
    const len = kind === 'capture' ? 0.14 : 0.32;
    notes.forEach((n, i) => this.brassNote(hz(n), t + i * len, kind === 'capture' ? 0.5 : 1.4, 0.16, this.gains.lead));
    if (kind !== 'capture') this.padChord(kind === 'victory' ? [0, 4, 7] : [0, 3, 6], t + notes.length * len, 4, 0.12, this.gains.lead);
  }

  private newMotif() {
    // A short motif from the theatre scale, repeated and varied every few bars.
    const sc = SCALES[this.theme];
    this.motif = [];
    let idx = 2;
    for (let i = 0; i < 6; i++) {
      idx = Math.max(0, Math.min(sc.length * 2 - 1, idx + [-2, -1, 1, 1, 2][Math.floor(Math.random() * 5)]));
      this.motif.push(sc[idx % sc.length] + 12 * Math.floor(idx / sc.length) + 12);
    }
  }

  private schedule() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      this.next = ctx.currentTime + 0.1;
      return;
    }
    // Ease intensity: quick to rise (about 2 s), slow to fall (about 25 s).
    const tau = this.target > this.level ? 2 : 25;
    this.level += (this.target - this.level) * Math.min(1, 0.04 / tau);
    if (this.next < ctx.currentTime - 0.5) this.next = ctx.currentTime + 0.05; // tab was hidden
    while (this.next < ctx.currentTime + 0.25) {
      this.playStep(this.step, this.next);
      this.next += 60 / this.bpm / 4;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }

  private mix(t: number) {
    const L = this.level;
    const s = (a: number, b: number) => Math.max(0, Math.min(1, (L - a) / (b - a)));
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, t, 1.2);
    set(this.gains.pad, 0.11 * (1 - 0.35 * s(0.6, 1)));
    set(this.gains.arp, 0.07 * (1 - 0.6 * s(0.5, 0.9)));
    set(this.gains.lead, 0.06 * (1 - s(0.55, 0.85)) + 0.02);
    set(this.gains.bass, 0.16 * s(0.2, 0.45));
    set(this.gains.hats, 0.05 * s(0.3, 0.55));
    set(this.gains.drums, 0.32 * s(0.55, 0.8));
    set(this.gains.strings, 0.07 * s(0.6, 0.85));
    set(this.gains.brass, 0.09 * s(0.7, 0.95));
    this.filter.frequency.setTargetAtTime(1300 + 4200 * L, t, 1.5);
  }

  private playStep(step: number, t: number) {
    const L = this.level;
    const prog = L > 0.45 ? TENSE : CALM;
    const chord = prog[Math.floor(this.bar / 2) % 4];
    const beat = 60 / this.bpm;
    const six = beat / 4;
    if (step === 0) {
      // Tempo follows the fight (only on bar lines, so the grid never wobbles).
      this.bpm = 88 + Math.round(L * 30);
      this.mix(t);
      if (this.bar % 2 === 0) this.padChord(chord, t, beat * 8.4, 1, this.gains.pad);
      if (this.bar % 8 === 0 && this.bar > 0) this.newMotif();
      // Sonar ping in quiet passages.
      if (L < 0.35 && Math.random() < 0.3) this.ping(t + beat * (1 + Math.floor(Math.random() * 2)));
    }
    // Arpeggio: eighths when calm (quarters in the arctic).
    const arpEvery = this.theme === 'arctic' ? 4 : 2;
    if (step % arpEvery === 0) {
      const order = [0, 1, 2, 1, 2, 0, 2, 1];
      const n = chord[order[(step / arpEvery + this.bar) % order.length]] + 12 + (step >= 8 && this.theme !== 'arctic' ? 12 : 0);
      this.pluck(hz(n), t, 0.6, 0.5, this.gains.arp);
    }
    // Lead motif, every other bar, quarter notes.
    if (this.bar % 2 === 1 && step % 4 === 0 && step / 4 < this.motif.length) {
      const m = this.motif[(step / 4 + (this.bar % 4 === 3 ? 2 : 0)) % this.motif.length];
      this.leadNote(hz(m), t, beat * 0.95, this.gains.lead);
    }
    // Bass ostinato: driving eighths with accents.
    if (step % 2 === 0) {
      const acc = step === 0 || step === 6 || step === 12;
      const n = chord[0] - 12 + (step === 14 ? 7 : 0);
      this.bassNote(hz(n), t, six * 1.6, acc ? 1 : 0.6, this.gains.bass);
    }
    // Hats.
    if (L > 0.25) this.hat(t, step % 4 === 2 ? 0.9 : step % 2 ? 0.35 : 0.55, this.gains.hats);
    // Drums: taiko pattern.
    if (L > 0.5) {
      const kick = [0, 3, 6, 8, 11, 14];
      if (kick.includes(step)) this.taiko(t, step === 0 || step === 8 ? 1 : 0.65, this.gains.drums);
      if (step === 4 || step === 12) this.snare(t, this.gains.drums);
      if (this.bar % 4 === 3 && step >= 12) this.tom(t, 0.5 + (step - 12) * 0.15, this.gains.drums);
    }
    // String ostinato: sixteenths over root, fifth, octave.
    if (L > 0.55) {
      const pat = [0, 12, 7, 12, 0, 12, 7, 15];
      this.stringNote(hz(chord[0] + pat[step % 8]), t, six * 0.8, this.gains.strings);
    }
    // Brass stabs.
    if (L > 0.65 && (step === 0 || (step === 10 && this.bar % 2 === 1))) {
      for (const n of chord) this.brassNote(hz(n), t, beat * (step === 0 ? 1.6 : 0.8), 0.33, this.gains.brass);
    }
  }

  // ---------------------------------------------------------------- instruments

  private osc(type: OscillatorType, f: number, t: number, dur: number, dest: AudioNode, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private envGain(t: number, a: number, peak: number, hold: number, rel: number, dest: AudioNode) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
    g.connect(dest);
    return g;
  }

  private padChord(chord: number[], t: number, dur: number, vol: number, dest: AudioNode) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.linearRampToValueAtTime(1100, t + dur * 0.5);
    f.frequency.linearRampToValueAtTime(600, t + dur);
    const g = this.envGain(t, dur * 0.3, 0.22 * vol, dur * 0.35, dur * 0.35, dest);
    f.connect(g);
    for (const n of [...chord, chord[0] - 12]) {
      this.osc('sawtooth', hz(n), t, dur, f, -7);
      this.osc('sawtooth', hz(n), t, dur, f, 7);
    }
  }

  private pluck(f: number, t: number, dur: number, vol: number, dest: AudioNode) {
    const g = this.envGain(t, 0.005, 0.3 * vol, 0, dur, dest);
    const send = this.ctx.createGain();
    send.gain.value = 0.6;
    g.connect(send).connect(this.delay);
    this.delay.delayTime.setValueAtTime((60 / this.bpm) * 0.75, t);
    this.osc('triangle', f, t, dur, g);
    this.osc('sine', f * 2, t, dur * 0.5, g);
  }

  private leadNote(f: number, t: number, dur: number, dest: AudioNode) {
    const g = this.envGain(t, 0.08, 0.22, dur * 0.5, dur * 0.8, dest);
    const send = this.ctx.createGain();
    send.gain.value = 0.4;
    g.connect(send).connect(this.delay);
    const o = this.osc('sine', f, t, dur * 1.4, g);
    // Gentle vibrato that grows into the note.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lg = this.ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(f * 0.006, t + dur * 0.6);
    lfo.connect(lg).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + dur * 1.4);
    this.osc('triangle', f * 0.5, t, dur * 1.4, g);
  }

  private bassNote(f: number, t: number, dur: number, vol: number, dest: AudioNode) {
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 6;
    flt.frequency.setValueAtTime(180 + 900 * vol * (0.4 + this.level), t);
    flt.frequency.exponentialRampToValueAtTime(140, t + dur);
    const g = this.envGain(t, 0.004, 0.5 * vol, 0, dur, dest);
    flt.connect(g);
    this.osc('sawtooth', f, t, dur, flt);
    this.osc('square', f * 0.5, t, dur, flt);
  }

  private stringNote(f: number, t: number, dur: number, dest: AudioNode) {
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = f * 3;
    flt.Q.value = 0.7;
    const g = this.envGain(t, 0.01, 0.35, 0, dur, dest);
    flt.connect(g);
    this.osc('sawtooth', f, t, dur, flt, -5);
    this.osc('sawtooth', f, t, dur, flt, 5);
  }

  private brassNote(f: number, t: number, dur: number, vol: number, dest: AudioNode) {
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 2;
    flt.frequency.setValueAtTime(300, t);
    flt.frequency.exponentialRampToValueAtTime(2600, t + 0.06);
    flt.frequency.exponentialRampToValueAtTime(700, t + dur);
    const g = this.envGain(t, 0.03, vol, dur * 0.3, dur * 0.7, dest);
    flt.connect(g);
    this.osc('sawtooth', f, t, dur, flt, -6);
    this.osc('sawtooth', f, t, dur, flt, 6);
    this.osc('sawtooth', f * 0.5, t, dur, flt);
  }

  private noiseHit(t: number, dur: number, type: BiquadFilterType, freq: number, vol: number, dest: AudioNode) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.envGain(t, 0.002, vol, 0, dur, dest);
    s.connect(f).connect(g);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  private hat(t: number, vol: number, dest: AudioNode) {
    this.noiseHit(t, 0.035 + vol * 0.02, 'highpass', 7500, 0.25 * vol, dest);
  }

  private taiko(t: number, vol: number, dest: AudioNode) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.35);
    const g = this.envGain(t, 0.003, 0.9 * vol, 0, 0.55, dest);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.6);
    this.noiseHit(t, 0.06, 'lowpass', 900, 0.35 * vol, dest);
  }

  private tom(t: number, vol: number, dest: AudioNode) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.25);
    const g = this.envGain(t, 0.003, 0.5 * vol, 0, 0.3, dest);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.35);
  }

  private snare(t: number, dest: AudioNode) {
    this.noiseHit(t, 0.18, 'bandpass', 1900, 0.45, dest);
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    const g = this.envGain(t, 0.002, 0.25, 0, 0.1, dest);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.15);
  }

  private ping(t: number) {
    const f = hz(SCALES[this.theme][Math.floor(Math.random() * 3)] + 36);
    const g = this.envGain(t, 0.01, 0.5, 0, 3, this.gains.arp);
    this.osc('sine', f, t, 3, g);
  }
}

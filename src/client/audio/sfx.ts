// Procedural sound: every effect is synthesised with WebAudio, so the game ships no SFX files.

export type Sfx =
  | 'hover'
  | 'click'
  | 'select'
  | 'order'
  | 'deny'
  | 'gun'
  | 'bigGun'
  | 'launch'
  | 'sam'
  | 'ciws'
  | 'torpedo'
  | 'boom_s'
  | 'boom_l'
  | 'splash'
  | 'intercept'
  | 'thunder'
  | 'sonar'
  | 'radar'
  | 'vampire'
  | 'capture'
  | 'lost'
  | 'cash'
  | 'built'
  | 'bombDrop'
  | 'squelch';

export class Audio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  amb!: GainNode;
  voice!: GainNode;
  music!: GainNode;
  private reverb!: ConvolverNode;
  private wet!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private ocean: GainNode | null = null;
  private wind: GainNode | null = null;
  private rain: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private lastPlay = new Map<string, number>();
  volumes = { master: 0.8, sfx: 0.9, amb: 0.7, voice: 1, music: 0.45 };
  listener = { x: 40, y: 40, dist: 40, yaw: 0 };

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    const mk = () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.sfx = mk();
    this.amb = mk();
    this.voice = mk();
    this.music = mk();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.6, 2.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.35;
    this.reverb.connect(this.wet).connect(this.master);
    this.noise = this.makeNoise(2, false);
    this.brown = this.makeNoise(4, true);
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.sfx.gain.value = this.volumes.sfx;
    this.amb.gain.value = this.volumes.amb;
    this.voice.gain.value = this.volumes.voice;
    this.music.gain.value = this.volumes.music * 0.5;
  }

  private makeNoise(sec: number, brown: boolean): AudioBuffer {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return b;
  }

  private makeImpulse(sec: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  /** Distance attenuation and stereo pan relative to the camera. */
  private spatial(x?: number, y?: number): { vol: number; pan: number } {
    if (x === undefined || y === undefined) return { vol: 1, pan: 0 };
    const L = this.listener;
    const dx = x - L.x;
    const dy = y - L.y;
    const d = Math.hypot(dx, dy);
    const hear = L.dist * 0.9 + 6;
    const vol = Math.max(0, 1 - d / (hear * 1.6)) ** 1.5 * Math.max(0.25, Math.min(1, 30 / (L.dist + 10)));
    const c = Math.cos(L.yaw);
    const s = Math.sin(L.yaw);
    const sx = dx * c + dy * s;
    const pan = Math.max(-0.9, Math.min(0.9, sx / hear));
    return { vol, pan };
  }

  private out(vol: number, pan: number, reverb = 0.2, bus?: GainNode): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(bus ?? this.sfx);
    if (reverb > 0) {
      const r = ctx.createGain();
      r.gain.value = reverb;
      p.connect(r).connect(this.reverb);
    }
    return g;
  }

  private noiseSrc(brown = false, rate = 1): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = brown ? this.brown : this.noise;
    s.loop = true;
    s.playbackRate.value = rate;
    s.loopStart = Math.random();
    return s;
  }

  private env(g: AudioParam, t: number, a: number, peak: number, d: number) {
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + a);
    g.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private tone(type: OscillatorType, f0: number, f1: number, t: number, dur: number, vol: number, dest: AudioNode, a = 0.005) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    this.env(g.gain, t, a, vol, dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + a + dur + 0.05);
  }

  private burst(t: number, dur: number, vol: number, filter: BiquadFilterType, f0: number, f1: number, dest: AudioNode, q = 1, brown = false, a = 0.003) {
    const ctx = this.ctx!;
    const s = this.noiseSrc(brown);
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g.gain, t, a, vol, dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t);
    s.stop(t + a + dur + 0.05);
  }

  play(name: Sfx, x?: number, y?: number, volume = 1) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // Rate limit identical sounds.
    const now = ctx.currentTime;
    const minGap = name === 'ciws' ? 0.12 : name === 'gun' ? 0.05 : name === 'hover' ? 0.03 : 0.02;
    if ((this.lastPlay.get(name) ?? -1) > now - minGap) return;
    this.lastPlay.set(name, now);
    const { vol, pan } = this.spatial(x, y);
    const v = vol * volume;
    if (v < 0.01) return;
    const t = now + 0.005;
    const ui = x === undefined;
    switch (name) {
      case 'hover': {
        const o = this.out(0.05 * v, 0, 0);
        this.tone('sine', 2400, 2400, t, 0.03, 1, o);
        break;
      }
      case 'click': {
        const o = this.out(0.12 * v, 0, 0.05);
        this.tone('square', 1300, 1300, t, 0.03, 0.5, o);
        this.tone('sine', 1950, 1950, t + 0.035, 0.05, 0.8, o);
        break;
      }
      case 'deny': {
        const o = this.out(0.12 * v, 0, 0);
        this.tone('square', 220, 200, t, 0.08, 0.6, o);
        this.tone('square', 180, 160, t + 0.1, 0.12, 0.6, o);
        break;
      }
      case 'select':
      case 'squelch': {
        const o = this.out(0.16 * v, 0, 0.05);
        this.burst(t, 0.05, 0.7, 'bandpass', 2500, 1800, o, 1.2);
        this.tone('sine', 1650, 1650, t + 0.03, 0.06, 0.6, o);
        break;
      }
      case 'order': {
        const o = this.out(0.14 * v, 0, 0.08);
        this.tone('triangle', 880, 880, t, 0.05, 0.8, o);
        this.tone('triangle', 1320, 1320, t + 0.06, 0.09, 0.8, o);
        break;
      }
      case 'gun': {
        const o = this.out(0.5 * v, pan, 0.3);
        this.burst(t, 0.25, 0.9, 'lowpass', 1800, 200, o, 0.7);
        this.tone('sine', 130, 45, t, 0.25, 0.9, o);
        break;
      }
      case 'bigGun': {
        const o = this.out(0.9 * v, pan, 0.5);
        this.burst(t, 0.9, 1, 'lowpass', 1200, 80, o, 0.7, true);
        this.burst(t, 0.12, 0.6, 'highpass', 2000, 2000, o, 0.7);
        this.tone('sine', 90, 28, t, 0.9, 1, o);
        break;
      }
      case 'launch': {
        const o = this.out(0.55 * v, pan, 0.4);
        const s = this.noiseSrc();
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 1.4;
        f.frequency.setValueAtTime(300, t);
        f.frequency.exponentialRampToValueAtTime(2200, t + 0.5);
        f.frequency.exponentialRampToValueAtTime(900, t + 2.2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(1, t + 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
        s.connect(f).connect(g).connect(o);
        s.start(t);
        s.stop(t + 2.5);
        this.burst(t, 0.6, 0.8, 'lowpass', 400, 60, o, 0.7, true);
        break;
      }
      case 'sam': {
        const o = this.out(0.4 * v, pan, 0.3);
        this.burst(t, 1.1, 1, 'bandpass', 1800, 3200, o, 1.6, false, 0.03);
        this.burst(t, 0.3, 0.6, 'lowpass', 500, 80, o, 0.7, true);
        break;
      }
      case 'ciws': {
        const o = this.out(0.3 * v, pan, 0.15);
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 75;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 2400;
        const g = ctx.createGain();
        this.env(g.gain, t, 0.01, 0.8, 0.45);
        osc.connect(f).connect(g).connect(o);
        osc.start(t);
        osc.stop(t + 0.5);
        break;
      }
      case 'torpedo': {
        const o = this.out(0.4 * v, pan, 0.5);
        this.burst(t, 0.4, 0.8, 'lowpass', 900, 200, o, 0.8);
        for (let i = 0; i < 5; i++) this.tone('sine', 300 + Math.random() * 300, 150, t + 0.2 + i * 0.07, 0.08, 0.3, o);
        break;
      }
      case 'boom_s': {
        const o = this.out(0.6 * v, pan, 0.4);
        this.burst(t, 0.7, 1, 'lowpass', 2400, 120, o, 0.7, true);
        this.tone('sine', 110, 35, t, 0.5, 0.9, o);
        break;
      }
      case 'boom_l': {
        const o = this.out(1 * v, pan, 0.6);
        this.burst(t, 2.2, 1, 'lowpass', 1600, 50, o, 0.6, true, 0.005);
        this.burst(t, 0.2, 0.6, 'bandpass', 3000, 900, o, 0.8);
        this.tone('sine', 85, 22, t, 1.6, 1, o);
        break;
      }
      case 'splash': {
        const o = this.out(0.35 * v, pan, 0.3);
        this.burst(t, 0.6, 0.8, 'highpass', 800, 3000, o, 0.5, false, 0.01);
        this.burst(t, 0.3, 0.5, 'lowpass', 600, 100, o, 0.7, true);
        break;
      }
      case 'intercept': {
        const o = this.out(0.45 * v, pan, 0.5);
        this.burst(t, 0.35, 1, 'bandpass', 3000, 600, o, 0.9);
        this.tone('sine', 2200, 900, t, 0.25, 0.4, o);
        break;
      }
      case 'thunder': {
        const d = Math.hypot((x ?? 0) - this.listener.x, (y ?? 0) - this.listener.y);
        const delay = Math.min(4, d * 0.08);
        const o = this.out(Math.max(0.15, 0.7 * v), pan, 0.8, this.amb);
        this.burst(t + delay, 3.5, 1, 'lowpass', 500, 60, o, 0.5, true, 0.08);
        this.burst(t + delay, 0.6, 0.5, 'lowpass', 2500, 300, o, 0.5, false, 0.01);
        break;
      }
      case 'sonar': {
        const o = this.out(0.25 * v, 0, 1.2);
        this.tone('sine', 1250, 1250, t, 0.6, 0.7, o, 0.01);
        this.tone('sine', 1250, 1240, t + 0.9, 0.5, 0.15, o, 0.01);
        break;
      }
      case 'radar': {
        const o = this.out(0.1 * v, 0, 0.3);
        this.tone('sine', 1500, 1500, t, 0.08, 0.6, o);
        break;
      }
      case 'vampire': {
        const o = this.out(0.18, 0, 0.1);
        for (let i = 0; i < 3; i++) {
          this.tone('square', 960, 960, t + i * 0.32, 0.13, 0.4, o);
          this.tone('square', 720, 720, t + i * 0.32 + 0.15, 0.13, 0.4, o);
        }
        break;
      }
      case 'capture': {
        const o = this.out(0.22, 0, 0.8, this.sfx);
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone('triangle', f, f, t + i * 0.09, 0.5, 0.5, o, 0.01));
        break;
      }
      case 'lost': {
        const o = this.out(0.22, 0, 0.8);
        [440, 349.23, 293.66].forEach((f, i) => this.tone('triangle', f, f, t + i * 0.14, 0.6, 0.5, o, 0.01));
        break;
      }
      case 'cash': {
        const o = this.out(0.14 * (ui ? 1 : Math.max(0.5, v)), 0, 0.4);
        this.tone('sine', 1318.5, 1318.5, t, 0.12, 0.6, o);
        this.tone('sine', 1975.5, 1975.5, t + 0.07, 0.25, 0.6, o);
        break;
      }
      case 'built': {
        const o = this.out(0.2, 0, 0.7);
        this.tone('triangle', 659.25, 659.25, t, 0.25, 0.6, o, 0.01);
        this.tone('triangle', 987.77, 987.77, t + 0.12, 0.4, 0.6, o, 0.01);
        break;
      }
      case 'bombDrop': {
        const o = this.out(0.25 * v, pan, 0.3);
        this.tone('sine', 1800, 500, t, 1.1, 0.3, o, 0.05);
        break;
      }
    }
  }

  /** Looping ambient beds: ocean, wind and rain, plus a sparse generative pad. */
  startAmbient() {
    const ctx = this.ctx;
    if (!ctx || this.ocean) return;
    const bed = (filter: BiquadFilterType, freq: number, q: number, brown: boolean) => {
      const s = this.noiseSrc(brown, 1);
      const f = ctx.createBiquadFilter();
      f.type = filter;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      s.connect(f).connect(g).connect(this.amb);
      s.start();
      // Slow swell.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.08 + Math.random() * 0.05;
      const lg = ctx.createGain();
      lg.gain.value = freq * 0.35;
      lfo.connect(lg).connect(f.frequency);
      lfo.start();
      return g;
    };
    this.ocean = bed('lowpass', 420, 0.6, true);
    this.wind = bed('bandpass', 700, 0.9, false);
    this.rain = bed('highpass', 4000, 0.4, false);
    this.ocean.gain.value = 0.35;
    this.startMusic();
  }

  setWeather(storm: number, zoom: number) {
    if (!this.ctx || !this.ocean) return;
    if (!Number.isFinite(storm)) storm = 0;
    if (!Number.isFinite(zoom)) zoom = 30;
    const t = this.ctx.currentTime;
    const close = Math.max(0.2, Math.min(1, 30 / (zoom + 8)));
    this.ocean.gain.setTargetAtTime(0.25 * close + 0.08, t, 0.5);
    this.wind!.gain.setTargetAtTime(storm * 0.25 + 0.015, t, 0.8);
    this.rain!.gain.setTargetAtTime(storm * 0.12 * close, t, 0.8);
  }

  private startMusic() {
    const ctx = this.ctx!;
    // Sparse minor-key pad: Am - F - C - G (as dark drones), very quiet.
    const chords = [
      [110, 164.81, 220, 261.63],
      [87.31, 130.81, 174.61, 220],
      [98, 146.83, 196, 246.94],
      [82.41, 123.47, 164.81, 207.65],
    ];
    let i = 0;
    const play = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime + 0.05;
      const ch = chords[i++ % chords.length];
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 11);
      f.connect(g);
      g.connect(this.music);
      const r = ctx.createGain();
      r.gain.value = 0.6;
      g.connect(r).connect(this.reverb);
      for (const fr of ch) {
        for (const det of [-4, 4]) {
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = fr;
          o.detune.value = det;
          o.connect(f);
          o.start(t);
          o.stop(t + 11.5);
        }
      }
      // Occasional high sonar-like note.
      if (Math.random() < 0.5) this.tone('sine', ch[3] * 4, ch[3] * 4, t + 2 + Math.random() * 4, 2.5, 0.02, this.music, 0.4);
    };
    play();
    this.musicTimer = setInterval(play, 9000);
  }

  stopMusic() {
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.musicTimer = null;
  }
}

export const audio = new Audio();

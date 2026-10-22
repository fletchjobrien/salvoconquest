// Procedural sound: every effect is synthesised with WebAudio, so the game ships no SFX files.
import { Music } from './music';

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
  | 'rifle'
  | 'autocannon'
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
    // A match that started before the first click or key press (e.g. rejoined after a page reload)
    // asked for the ambience and music while audio was still locked: start them now.
    if (this.ambientWanted) this.startAmbient();
  }

  /** startAmbient() was called; it runs once audio is unlocked. */
  private ambientWanted = false;

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

  /** Distance attenuation, stereo pan and muffling (low-pass cutoff, Hz) relative to the camera. */
  private spatial(x?: number, y?: number): { vol: number; pan: number; lp: number } {
    if (x === undefined || y === undefined) return { vol: 1, pan: 0, lp: 20000 };
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
    // Far blasts arrive muffled, as in Salvo (distance from the camera itself, not its aim point).
    const d3 = Math.hypot(d, L.dist * 0.6);
    const lp = Math.max(400, 18000 / (1 + d3 / 12));
    return { vol, pan, lp };
  }

  /** Low-pass for the sound being built (set by play() from the source's distance). */
  private curLp = 20000;

  private out(vol: number, pan: number, reverb = 0.2, bus?: GainNode): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    if (this.curLp < 19000 && !bus) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = this.curLp;
      g.connect(lp).connect(p).connect(this.sfx);
    } else g.connect(p).connect(bus ?? this.sfx);
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

  /**
   * Salvo's explosion: a white-noise blast whose low-pass falls from 5 kHz to 90 Hz, a sub-bass
   * thump, and debris crackling down for a second and a half. Bigger blasts last longer.
   */
  private explosion(t: number, size: number, v: number, pan: number) {
    const ctx = this.ctx!;
    const s = Math.max(0.3, Math.min(2.4, size));
    const o = this.out(Math.min(1.4, 0.55 + 0.45 * s) * v, pan, 0.7);
    t += 0.02;
    const n = this.noiseSrc();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(5000, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 1.8 * s);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4 * s);
    n.connect(f).connect(g).connect(o);
    n.start(t);
    n.stop(t + 2.6 * s);
    this.tone('sine', 90, 28, t, 1.0, 1.4, o, 0.003);
    const c = this.noiseSrc();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    for (let i = 0; i < 14; i++) {
      const tt = t + 0.15 + Math.random() * 1.3;
      cg.gain.setValueAtTime(0.25 * Math.random(), tt);
      cg.gain.setTargetAtTime(0, tt + 0.01, 0.02);
    }
    c.connect(hp).connect(cg).connect(o);
    c.start(t);
    c.stop(t + 1.8);
  }

  /** size: scale of a blast (boom_s / boom_l): 0.35 SAM burst ... 1.3 missile hit ... 2.2 ship lost; longer and deeper when bigger. */
  play(name: Sfx, x?: number, y?: number, volume = 1, size = 1) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // Rate limit identical sounds from the same place (2 km cells), so separate impacts all sound.
    const now = ctx.currentTime;
    const minGap = name === 'ciws' ? 0.09 : name === 'gun' ? 0.03 : name === 'hover' ? 0.03 : name === 'launch' ? 0.12 : name === 'splash' ? 0.04 : 0.05;
    const key = x === undefined || y === undefined ? name : `${name}${Math.round(x / 2)},${Math.round(y / 2)}`;
    if ((this.lastPlay.get(key) ?? -1) > now - minGap) return;
    this.lastPlay.set(key, now);
    if (this.lastPlay.size > 400) for (const [k, t0] of this.lastPlay) if (t0 < now - 2) this.lastPlay.delete(k);
    const { vol, pan, lp } = this.spatial(x, y);
    this.curLp = lp;
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
        // Salvo's gun: a hard crack whose filter slams shut, over a short low punch.
        const o = this.out(0.8 * v, pan, 0.5);
        this.burst(t, 0.6, 1, 'lowpass', 1800, 120, o, 0.7, false, 0.002);
        this.tone('sine', 110, 40, t, 0.3, 1, o, 0.002);
        break;
      }
      case 'bigGun': {
        const o = this.out(1 * v, pan, 0.6);
        this.burst(t, 1.1, 1, 'lowpass', 1500, 70, o, 0.7, false, 0.002);
        this.burst(t, 0.9, 0.8, 'lowpass', 600, 50, o, 0.7, true);
        this.tone('sine', 80, 26, t, 0.9, 1.2, o, 0.002);
        break;
      }
      case 'launch':
      case 'sam': {
        // Salvo's launch: a roaring motor that rises and then trails off, over raw rumble.
        const sam = name === 'sam';
        const o = this.out((sam ? 1.1 : 1.6) * v, pan, 0.6);
        const s = this.noiseSrc();
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 0.8;
        f.frequency.setValueAtTime(sam ? 600 : 300, t);
        f.frequency.exponentialRampToValueAtTime(sam ? 3000 : 1800, t + 0.6);
        f.frequency.exponentialRampToValueAtTime(500, t + 3);
        const g = ctx.createGain();
        const len = sam ? 2 : 3.5;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(1.4, t + 0.08);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        s.connect(f).connect(g).connect(o);
        s.start(t);
        s.stop(t + len + 0.1);
        const rb = this.noiseSrc(true);
        const rg = ctx.createGain();
        rg.gain.setValueAtTime(sam ? 0.8 : 1.3, t);
        rg.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
        rb.connect(rg).connect(o);
        rb.start(t);
        rb.stop(t + 1.6);
        break;
      }
      case 'rifle': {
        // A ragged burst of small-arms cracks.
        const o = this.out(0.22 * v, pan, 0.2);
        const n = 4 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) this.burst(t + i * 0.11 + Math.random() * 0.04, 0.05, 0.9, 'bandpass', 2600, 900, o, 1.2);
        break;
      }
      case 'autocannon': {
        // Heavy, evenly spaced thumps.
        const o = this.out(0.3 * v, pan, 0.25);
        for (let i = 0; i < 7; i++) {
          this.burst(t + i * 0.07, 0.08, 0.9, 'lowpass', 1400, 200, o, 0.8);
          this.tone('sine', 110, 50, t + i * 0.07, 0.08, 0.6, o);
        }
        break;
      }
      case 'ciws': {
        // Salvo's CIWS "BRRRT": noise chopped by a 72 Hz square wave, so it sounds like single rounds.
        const o = this.out(1.6 * v, pan, 0.2);
        const s = this.noiseSrc();
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1400;
        f.Q.value = 0.5;
        const vca = ctx.createGain();
        vca.gain.value = 0;
        const lfo = ctx.createOscillator();
        lfo.type = 'square';
        lfo.frequency.value = 72;
        const depth = ctx.createGain();
        depth.gain.value = 0.6;
        lfo.connect(depth).connect(vca.gain);
        const g = ctx.createGain();
        g.gain.setValueAtTime(1, t);
        g.gain.setValueAtTime(1, t + 0.1);
        g.gain.setTargetAtTime(0, t + 0.1, 0.03);
        s.connect(f).connect(vca).connect(g).connect(o);
        s.start(t);
        lfo.start(t);
        s.stop(t + 0.35);
        lfo.stop(t + 0.35);
        break;
      }
      case 'torpedo': {
        const o = this.out(0.4 * v, pan, 0.5);
        this.burst(t, 0.4, 0.8, 'lowpass', 900, 200, o, 0.8);
        for (let i = 0; i < 5; i++) this.tone('sine', 300 + Math.random() * 300, 150, t + 0.2 + i * 0.07, 0.08, 0.3, o);
        break;
      }
      case 'boom_s':
      case 'boom_l':
        this.explosion(t, size, v, pan);
        break;
      case 'splash': {
        // Salvo's splash: a wash of water noise around 900 Hz.
        const o = this.out(1.4 * v, pan, 0.2);
        this.burst(t, 0.9, 1, 'bandpass', 900, 700, o, 0.6, false, 0.03);
        this.burst(t, 0.25, 0.4, 'lowpass', 500, 90, o, 0.7, true);
        break;
      }
      case 'intercept':
        // A missile killed in the air is an explosion, not a zap.
        this.explosion(t, 0.6, v, pan);
        break;
      case 'thunder': {
        const d = Math.hypot((x ?? 0) - this.listener.x, (y ?? 0) - this.listener.y);
        const delay = Math.min(4, d * 0.08);
        const o = this.out(Math.max(0.06, 0.3 * v), pan, 0.8, this.amb);
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
    this.ambientWanted = true;
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

  private weatherAt = 0;

  setWeather(storm: number, zoom: number) {
    if (!this.ctx || !this.ocean) return;
    // Called every frame: re-aim the fades 4 times a second at most, or the audio thread piles
    // up thousands of scheduled ramps.
    if (this.ctx.currentTime - this.weatherAt < 0.25) return;
    this.weatherAt = this.ctx.currentTime;
    if (!Number.isFinite(storm)) storm = 0;
    if (!Number.isFinite(zoom)) zoom = 30;
    const t = this.ctx.currentTime;
    const close = Math.max(0.2, Math.min(1, 30 / (zoom + 8)));
    this.ocean.gain.setTargetAtTime(0.25 * close + 0.08, t, 0.5);
    this.wind!.gain.setTargetAtTime(storm * 0.1 + 0.01, t, 0.8);
    this.rain!.gain.setTargetAtTime(storm * 0.05 * close, t, 0.8);
  }

  private score: Music | null = null;
  private musicTheme = 'desert';

  private startMusic() {
    if (!this.ctx) return;
    if (!this.score) this.score = new Music(this.ctx, this.music, this.reverb);
    this.score.setTheme(this.musicTheme);
    this.score.start();
  }

  /** 0 = calm, 1 = full battle. The score follows smoothly. */
  setMusicIntensity(v: number) {
    this.score?.setIntensity(v);
  }

  get musicLevel(): number {
    return this.score?.level ?? 0;
  }

  setMusicTheme(theme: string) {
    this.musicTheme = theme;
    this.score?.setTheme(theme);
  }

  stinger(kind: 'victory' | 'defeat' | 'capture') {
    this.score?.stinger(kind);
  }

  stopMusic() {
    this.score?.stop();
  }
}

export const audio = new Audio();

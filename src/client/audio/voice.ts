// Unit voice lines. Drop recordings into public/audio/voice/<category>/<event>_<n>.mp3 and rebuild.
// Faction-specific overrides: public/audio/voice/<faction>/<category>/<event>_<n>.mp3
// Every line is passed through a radio filter (band-pass + light drive) with squelch clicks.
import { audio } from './sfx';
import type { Faction } from '../../shared/defs';

export type VoiceCat = 'naval' | 'ground' | 'air';
export type VoiceEvent = 'select' | 'move' | 'attack' | 'ready' | 'lost' | 'retreat' | 'board' | 'unload' | 'capture' | 'vampire' | 'rtb' | 'underfire';

/** Subtitles, and the script for whoever records the voices. */
export const LINES: Record<VoiceCat, Partial<Record<VoiceEvent, string[]>>> = {
  naval: {
    select: ['Bridge, go ahead.', 'Captain on deck.', 'Standing by.', 'Helm ready.'],
    move: ['Aye, coming about.', 'All ahead full.', 'Underway.', 'Making turns.'],
    attack: ['Weapons free!', 'Firing solution set.', 'Engaging target.', 'Birds away!'],
    ready: ['Ship commissioned. Ready for tasking.', 'New hull in the water.'],
    lost: ["We've lost the ship!", 'Hull breach — abandon ship!'],
    retreat: ['Heavy damage, returning to port!', 'Breaking off!'],
    vampire: ['Vampire, vampire!', 'Missiles inbound!'],
    underfire: ['Taking fire!'],
  },
  ground: {
    select: ['Yes sir?', 'Marines ready.', 'Go ahead.', 'Awaiting orders.'],
    move: ['Moving out!', 'Oscar Mike.', 'On our way.', 'Roger, moving.'],
    attack: ['Contact front!', 'Engaging!', 'Light them up!'],
    ready: ['Company formed up.', 'Ready to deploy.'],
    lost: ["We're overrun!", 'Unit lost.'],
    retreat: ['Falling back!', 'Pull back, pull back!'],
    board: ['Boarding now.', 'Mount up!'],
    unload: ['Hitting the beach!', 'Boats away!'],
    capture: ['Objective secured.', 'Site is ours.'],
  },
  air: {
    select: ['Flight lead here.', 'Go ahead, control.', 'On frequency.'],
    move: ['On station shortly.', 'Copy, en route.', 'Wilco.'],
    attack: ['Tally, engaging.', 'Fox three!', 'Rifle, rifle!'],
    ready: ['Wheels up.', 'Flight airborne.'],
    lost: ["I'm hit — ejecting!", 'Flight lost.'],
    rtb: ['Winchester, RTB.', 'Bingo fuel, heading home.'],
  },
};

type Manifest = Record<string, string[]>;

class VoiceBank {
  private manifest: Manifest = {};
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private busyUntil = 0;
  onSubtitle: (cat: VoiceCat, text: string, who: string) => void = () => {};

  async load() {
    try {
      const r = await fetch('/audio/voice/manifest.json', { cache: 'no-cache' });
      if (r.ok) this.manifest = await r.json();
    } catch {
      /* no recordings yet: subtitles + radio chirps only */
    }
  }

  private files(faction: Faction, cat: VoiceCat, ev: VoiceEvent): string[] {
    return this.manifest[`${faction}/${cat}/${ev}`] ?? this.manifest[`${cat}/${ev}`] ?? [];
  }

  private buffer(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p) {
      p = fetch('/audio/voice/' + path)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then((b) => audio.ctx!.decodeAudioData(b))
        .catch(() => null);
      this.buffers.set(path, p);
    }
    return p;
  }

  /** Play a line. `priority` lines interrupt the cooldown. */
  async say(faction: Faction, cat: VoiceCat, ev: VoiceEvent, who: string, priority = false) {
    const ctx = audio.ctx;
    const now = performance.now();
    if (!priority && now < this.busyUntil) return;
    const lines = LINES[cat][ev];
    const files = this.files(faction, cat, ev);
    const idx = Math.floor(Math.random() * Math.max(files.length, lines?.length ?? 1));
    // A recording's number names its line (select_2 is the second select line), so the subtitle matches.
    const num = files.length ? Number(/_(\d+)\.\w+$/.exec(files[idx % files.length])?.[1]) : NaN;
    const text = lines?.[num >= 1 && num <= lines.length ? num - 1 : idx % (lines?.length || 1)] ?? '';
    if (text) this.onSubtitle(cat, text, who);
    this.busyUntil = now + 1400;
    if (!ctx) return;
    if (!files.length) {
      audio.play('squelch');
      return;
    }
    const buf = await this.buffer(files[idx % files.length]);
    if (!buf) {
      audio.play('squelch');
      return;
    }
    this.busyUntil = performance.now() + buf.duration * 1000 + 300;
    const t = ctx.currentTime + 0.06;
    audio.play('squelch');
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 320;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    drive.curve = curve;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(hp).connect(lp).connect(drive).connect(g).connect(audio.voice);
    src.start(t);
    src.onended = () => audio.play('squelch');
  }
}

export const voices = new VoiceBank();

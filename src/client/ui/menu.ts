// Menu screens: title, skirmish setup, online rooms + lobby, settings, end of match, pause.
import { FACTIONS, FACTION_MOD, Faction } from '../../shared/defs';
import { THEMES, THEME_INFO, Theme } from '../../shared/map';
import type { LobbyState, ServerMsg } from '../../shared/protocol';
import { FACTION_STYLE, PALETTES, hex } from '../theme';
import { settings, saveSettings } from '../settings';
import { audio } from '../audio/sfx';

const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

function sfxBind(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.btn, .card').forEach((b) => {
    b.addEventListener('mouseenter', () => audio.play('hover'));
    b.addEventListener('mousedown', () => {
      audio.unlock();
      audio.play('click');
    });
  });
}

const FACTION_DESC: Record<Faction, string> = {
  coalition: 'US-pattern fleet. Stealthier hulls and aircraft, better radar and sonar, long-reach SM-6 and stealthy NSM missiles, a 16-inch gun battleship, a 5-flight carrier.',
  union: 'PLAN-pattern fleet. Tougher, faster hulls, supersonic YJ-18 and YJ-12 missiles that outrange the enemy, deep HQ-9 magazines, a missile strike cruiser.',
};

export function titleScreen(ui: HTMLElement, a: { skirmish(): void; create(): void; join(code: string): void; loadouts(): void; settings(): void }) {
  const el = h(`<div id="menu">
    <div class="title">SALVO<br><b>CONQUEST</b></div>
    <div class="subtitle">Littoral warfare · 2041</div>
    <div class="menu-col">
      <div class="label">Callsign</div>
      <input class="field" id="nm" maxlength="16" value="">
      <div style="height:10px"></div>
      <button class="btn primary" data-a="skirmish">Skirmish vs AI <span class="hint">offline</span></button>
      <button class="btn" data-a="create">Create online room <span class="hint">invite friends</span></button>
      <div class="menu-row"><input class="field" id="code" placeholder="ROOM CODE" maxlength="8" style="flex:1"><button class="btn" data-a="join">Join</button></div>
      <button class="btn" data-a="loadouts">Fleet Comp <span class="hint">pick your variants</span></button>
      <button class="btn" data-a="settings">Settings</button>
      <div class="err" id="err"></div>
    </div>
    <div class="footer-note">WASD pan · wheel zoom · RMB orders · F1 field manual</div>
  </div>`);
  const nm = el.querySelector<HTMLInputElement>('#nm')!;
  nm.value = settings.name;
  nm.addEventListener('input', () => {
    settings.name = nm.value.toUpperCase().replace(/[^\w .\-]/g, '').slice(0, 16) || 'COMMANDER';
    saveSettings();
  });
  const code = el.querySelector<HTMLInputElement>('#code')!;
  const q = new URLSearchParams(location.search).get('room');
  if (q) code.value = q.toUpperCase();
  el.querySelectorAll<HTMLElement>('[data-a]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.a!;
      if (k === 'join') {
        if (code.value.trim().length < 4) {
          el.querySelector('#err')!.textContent = 'Enter a room code.';
          audio.play('deny');
          return;
        }
        a.join(code.value.trim().toUpperCase());
      } else (a as any)[k]();
    }),
  );
  sfxBind(el);
  ui.appendChild(el);
  return el;
}

function factionCards(sel: Faction, onPick: (f: Faction) => void): HTMLElement {
  const wrap = h(`<div class="cards"></div>`);
  for (const f of FACTIONS) {
    const c = h(`<div class="card ${f === sel ? 'sel' : ''}"><div class="h">${FACTION_STYLE[f].emblem} ${FACTION_MOD[f].name}</div><div class="d">${FACTION_DESC[f]}</div><div class="sw" style="background:${FACTION_STYLE[f].accent}"></div></div>`);
    c.addEventListener('click', () => {
      wrap.querySelectorAll('.card').forEach((x) => x.classList.remove('sel'));
      c.classList.add('sel');
      onPick(f);
    });
    wrap.appendChild(c);
  }
  return wrap;
}

function themeCards(sel: Theme, onPick: (t: Theme) => void, disabled = false): HTMLElement {
  const wrap = h(`<div class="cards"></div>`);
  for (const t of THEMES) {
    const i = THEME_INFO[t];
    const p = PALETTES[t];
    const c = h(`<div class="card ${t === sel ? 'sel' : ''}" style="${disabled ? 'pointer-events:none' : ''}"><div class="h">${i.name}</div><div class="d">${i.region}</div><div class="sw" style="background:linear-gradient(90deg,${hex(p.deep)},${hex(p.shallow)},${hex(p.sand)},${hex(p.low)})"></div></div>`);
    c.addEventListener('click', () => {
      wrap.querySelectorAll('.card').forEach((x) => x.classList.remove('sel'));
      c.classList.add('sel');
      onPick(t);
    });
    wrap.appendChild(c);
  }
  return wrap;
}

export function skirmishScreen(ui: HTMLElement, a: { start(): void; back(): void }) {
  const el = h(`<div class="screen"><div class="dialog panel">
    <h2>Skirmish</h2>
    <section><div class="label">Your side</div><div id="fac"></div></section>
    <section><div class="label">Theatre</div><div id="thm"></div></section>
    <section><div class="label">Opponents</div><div class="menu-row" id="opp"></div></section>
    <div class="foot"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="start">Deploy ▸</button></div>
  </div></div>`);
  el.querySelector('#fac')!.appendChild(
    factionCards(settings.faction, (f) => {
      settings.faction = f;
      saveSettings();
    }),
  );
  el.querySelector('#thm')!.appendChild(
    themeCards(settings.theme, (t) => {
      settings.theme = t;
      saveSettings();
    }),
  );
  const opp = el.querySelector('#opp')!;
  const opts: [number, 'ffa' | '2v2', string][] = [
    [1, 'ffa', '1 v 1'],
    [2, 'ffa', '3-way FFA'],
    [3, 'ffa', '4-way FFA'],
    [3, '2v2', '2 v 2 (AI ally)'],
  ];
  for (const [n, teams, label] of opts) {
    const c = h(`<div class="card ${settings.bots === n && settings.teams === teams ? 'sel' : ''}" style="min-width:110px"><div class="h">${label}</div></div>`);
    c.addEventListener('click', () => {
      opp.querySelectorAll('.card').forEach((x) => x.classList.remove('sel'));
      c.classList.add('sel');
      settings.bots = n;
      settings.teams = teams;
      saveSettings();
    });
    opp.appendChild(c);
  }
  el.querySelector('[data-a="back"]')!.addEventListener('click', a.back);
  el.querySelector('[data-a="start"]')!.addEventListener('click', a.start);
  sfxBind(el);
  ui.appendChild(el);
  return el;
}

export class LobbyScreen {
  el: HTMLElement;
  private state: LobbyState | null = null;
  constructor(
    ui: HTMLElement,
    private a: { send(m: any): void; leave(): void },
  ) {
    this.el = h(`<div class="screen"><div class="dialog panel">
      <h2>Online room</h2>
      <section style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div><div class="label">Room code</div><div class="code" id="code">·····</div></div>
        <button class="btn" id="copy">Copy invite link</button>
      </section>
      <section><div class="label">Commanders</div><div class="slots" id="slots"></div>
        <div class="menu-row" style="margin-top:8px" id="hostrow"><button class="btn small" id="addbot">+ Add AI</button><button class="btn small" id="teams">Teams: FFA</button></div></section>
      <section><div class="label">Your side</div><div id="fac"></div></section>
      <section><div class="label">Theatre</div><div id="thm"></div></section>
      <div class="err" id="err"></div>
      <div class="foot"><button class="btn" id="leave">Leave</button><button class="btn primary" id="start">Start ▸</button></div>
    </div></div>`);
    this.el.querySelector('#leave')!.addEventListener('click', a.leave);
    this.el.querySelector('#start')!.addEventListener('click', () => a.send({ t: 'start' }));
    this.el.querySelector('#addbot')!.addEventListener('click', () => a.send({ t: 'lobby', addBot: true }));
    this.el.querySelector('#teams')!.addEventListener('click', () => a.send({ t: 'lobby', teams: this.state?.teams === 'ffa' ? '2v2' : 'ffa' }));
    this.el.querySelector('#copy')!.addEventListener('click', () => {
      const url = `${location.origin}/?room=${this.state?.code ?? ''}`;
      void navigator.clipboard?.writeText(url);
      (this.el.querySelector('#copy') as HTMLElement).textContent = 'Copied ✓';
    });
    this.el.querySelector('#fac')!.appendChild(
      factionCards(settings.faction, (f) => {
        settings.faction = f;
        saveSettings();
        a.send({ t: 'lobby', faction: f });
      }),
    );
    sfxBind(this.el);
    ui.appendChild(this.el);
  }

  update(s: LobbyState) {
    this.state = s;
    const me = s.slots.find((x) => x.you);
    const host = !!me?.host;
    this.el.querySelector('#code')!.textContent = s.code;
    const slots = this.el.querySelector('#slots')!;
    slots.innerHTML = '';
    for (const sl of s.slots) {
      const row = h(`<div class="slot"><span class="dot" style="background:${FACTION_STYLE[sl.faction].accent};color:${FACTION_STYLE[sl.faction].accent}"></span>
        <span>${sl.name}${sl.you ? ' <span style="color:var(--dim)">(you)</span>' : ''}${sl.host ? ' <span style="color:var(--warn)">HOST</span>' : ''}</span>
        <span style="color:var(--dim)">${FACTION_MOD[sl.faction].tag}</span>
        <span style="color:var(--dim)">${s.teams === '2v2' ? 'TEAM ' + (sl.team + 1) : 'SLOT ' + (sl.slot + 1)}</span>
        <span></span></div>`);
      if (sl.bot && host) {
        const last = row.lastElementChild!;
        const sw = h(`<button class="btn small">⇄</button>`);
        sw.addEventListener('click', () => this.a.send({ t: 'lobby', botFaction: { slot: sl.slot, faction: sl.faction === 'coalition' ? 'union' : 'coalition' } }));
        const rm = h(`<button class="btn small">✕</button>`);
        rm.addEventListener('click', () => this.a.send({ t: 'lobby', removeSlot: sl.slot }));
        last.append(sw, rm);
      }
      slots.appendChild(row);
    }
    (this.el.querySelector('#hostrow') as HTMLElement).classList.toggle('hidden', !host);
    (this.el.querySelector('#teams') as HTMLElement).textContent = `Teams: ${s.teams === 'ffa' ? 'FFA' : '2 v 2'}`;
    const thm = this.el.querySelector('#thm')!;
    thm.innerHTML = '';
    thm.appendChild(themeCards(s.theme, (t) => this.a.send({ t: 'lobby', theme: t }), !host));
    const start = this.el.querySelector('#start') as HTMLButtonElement;
    start.disabled = !host || s.slots.length < 2;
    start.textContent = host ? (s.slots.length < 2 ? 'Need 2+ players' : 'Start ▸') : 'Waiting for host…';
    sfxBind(this.el);
  }

  error(msg: string) {
    this.el.querySelector('#err')!.textContent = msg;
  }
}

export function settingsScreen(ui: HTMLElement, a: { back(): void; apply(): void }) {
  const row = (label: string, key: keyof typeof settings, min: number, max: number, step: number) =>
    `<div class="menu-row" style="justify-content:space-between;margin-bottom:8px"><span class="label" style="margin:0">${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}" style="width:220px"></div>`;
  const el = h(`<div class="screen"><div class="dialog panel" style="width:min(520px,94vw)">
    <h2>Settings</h2>
    <section>
      ${row('Pixel size', 'pixel', 1, 5, 1)}
      ${row('Master volume', 'master', 0, 1, 0.05)}
      ${row('Effects', 'sfx', 0, 1, 0.05)}
      ${row('Ambience', 'amb', 0, 1, 0.05)}
      ${row('Music', 'music', 0, 1, 0.05)}
      ${row('Voices', 'voice', 0, 1, 0.05)}
      <div class="menu-row" style="justify-content:space-between"><span class="label" style="margin:0">Edge scrolling</span><button class="btn small ${settings.edgeScroll ? 'on' : ''}" id="edge">${settings.edgeScroll ? 'ON' : 'OFF'}</button></div>
    </section>
    <div class="foot"><span></span><button class="btn primary" data-a="back">Done</button></div>
  </div></div>`);
  el.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((i) =>
    i.addEventListener('input', () => {
      (settings as any)[i.dataset.k!] = Number(i.value);
      saveSettings();
      a.apply();
    }),
  );
  const edge = el.querySelector('#edge') as HTMLElement;
  edge.addEventListener('click', () => {
    settings.edgeScroll = !settings.edgeScroll;
    edge.textContent = settings.edgeScroll ? 'ON' : 'OFF';
    edge.classList.toggle('on', settings.edgeScroll);
    saveSettings();
    a.apply();
  });
  el.querySelector('[data-a="back"]')!.addEventListener('click', a.back);
  sfxBind(el);
  ui.appendChild(el);
  return el;
}

export function endScreen(ui: HTMLElement, m: ServerMsg & { t: 'end' }, me: number, a: { menu(): void }) {
  const won = m.winners.includes(me);
  const rows = m.stats.map((s) => `<tr><td>${s.name}${s.id === me ? ' ◂' : ''}</td><td>${s.kills}</td><td>${s.losses}</td><td>$${s.earned.toLocaleString('en-US')}</td><td>${m.winners.includes(s.id) ? 'VICTORY' : 'DEFEAT'}</td></tr>`).join('');
  const el = h(`<div class="screen"><div class="dialog panel" style="width:min(620px,94vw)">
    <div class="title" style="font-size:40px;letter-spacing:.4em;color:${won ? 'var(--good)' : 'var(--hostile)'}">${won ? 'VICTORY' : 'DEFEAT'}</div>
    <div class="subtitle" style="margin-bottom:16px">${won ? 'The archipelago is yours' : 'Your fleet has been driven from the sea'}</div>
    <table class="endstats"><tr><th>COMMANDER</th><th>KILLS</th><th>LOSSES</th><th>EARNED</th><th>RESULT</th></tr>${rows}</table>
    <div class="foot"><span></span><button class="btn primary" data-a="menu">Return to menu</button></div>
  </div></div>`);
  el.querySelector('[data-a="menu"]')!.addEventListener('click', a.menu);
  sfxBind(el);
  ui.appendChild(el);
  audio.play(won ? 'capture' : 'lost');
  return el;
}

export function pauseScreen(ui: HTMLElement, local: boolean, a: { resume(): void; settings(): void; quit(): void; help(): void }) {
  const el = h(`<div class="screen"><div class="dialog panel" style="width:min(380px,94vw)">
    <h2>${local ? 'Paused' : 'Menu'}</h2>
    <div class="menu-col" style="width:100%">
      <button class="btn primary" data-a="resume">Resume</button>
      <button class="btn" data-a="help">Field manual</button>
      <button class="btn" data-a="settings">Settings</button>
      <button class="btn" data-a="quit">${local ? 'Abandon battle' : 'Leave game'}</button>
    </div>
  </div></div>`);
  el.querySelectorAll<HTMLElement>('[data-a]').forEach((b) => b.addEventListener('click', () => (a as any)[b.dataset.a!]()));
  sfxBind(el);
  ui.appendChild(el);
  return el;
}

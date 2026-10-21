// DOM heads-up display: top bar, radio log, build bar, selection panel, tooltips, banners.
import { BUILDABLE, BUILDINGS, CRIT, MODULES, UNITS, UnitType, unitBuildTime, unitCost, counterOf, unitDef, deriveStats, FACTION_MOD } from '../../shared/defs';
import { ORDER_CODES, F_ABOARD, F_DARK, F_PAINTED, F_HOLD, F_FREE } from '../../shared/protocol';
import type { World, UView } from '../state';
import { FACTION_STYLE, SIDE, unitName } from '../theme';
import { SymDomain, glyphFor, symbolDataUrl, SITE_GLYPH } from '../render/symbols';
import { matchLoadoutOf } from '../loadouts';
import { audio } from '../audio/sfx';

type Cat = 'naval' | 'ground' | 'air';

export interface HudActions {
  build(cat: Cat, type: UnitType): void;
  cancel(cat: Cat, type: UnitType): void;
  selectOnly(ids: number[]): void;
  unloadMode(ship: number, ids: number[]): void;
  toggleCargo(id: number): void;
  ability(name: 'mines' | 'rtb' | 'retreat' | 'stop' | 'refund' | 'counter' | 'radar' | 'firemode' | 'launch'): void;
  ready(on: boolean): void;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export function fmtMoney(v: number): string {
  return '$' + Math.floor(v).toLocaleString('en-US');
}

export class Hud {
  readonly root: HTMLDivElement;
  private cashEl: HTMLDivElement;
  private clockEl: HTMLDivElement;
  private wxEl: HTMLDivElement;
  private playersEl: HTMLDivElement;
  private logEl: HTMLDivElement;
  private buildEl: HTMLDivElement;
  private selEl: HTMLDivElement;
  private tipEl: HTMLDivElement;
  private bannerEl: HTMLDivElement;
  private helpEl: HTMLDivElement;
  private setupEl: HTMLDivElement;
  private setupKey = '';
  private buttons = new Map<UnitType, HTMLDivElement>();
  private factoryLabels = new Map<Cat, HTMLSpanElement>();
  private selKey = '';
  private lastHud = 0;
  private lastCash = '';
  cargoSel = new Set<number>();
  /** Module id of the weapon row under the mouse (its range ring is highlighted). */
  hoverMod: string | null = null;

  private setHoverMod(id: string | null) {
    if (id === this.hoverMod) return;
    this.hoverMod = id;
    this.selEl.querySelectorAll<HTMLElement>('[data-mod]').forEach((r) => r.classList.toggle('hl', r.dataset.mod === id));
  }
  siteSel: number | null = null;

  constructor(
    private world: World,
    private act: HudActions,
  ) {
    const fac = world.myFaction;
    document.documentElement.style.setProperty('--accent', FACTION_STYLE[fac].accent);
    this.root = h('div');
    this.root.id = 'hud';
    // top bar
    const top = h('div');
    top.id = 'topbar';
    const left = h('div', 'grp');
    left.appendChild(h('div', 'fac', `${FACTION_STYLE[fac].emblem} ${FACTION_MOD[fac].tag}`));
    this.cashEl = h('div', 'cash');
    left.appendChild(this.cashEl);
    const mid = h('div', 'grp');
    this.clockEl = h('div', 'clock');
    this.wxEl = h('div', 'wx');
    mid.append(this.clockEl, this.wxEl);
    this.playersEl = h('div', 'players');
    top.append(left, mid, this.playersEl);
    this.logEl = h('div');
    this.logEl.id = 'log';
    this.buildEl = h('div', 'panel hp');
    this.buildEl.id = 'buildbar';
    this.selEl = h('div', 'panel hp empty');
    this.selEl.id = 'selpanel';
    // Hovering a weapon row highlights that weapon's range ring on the map.
    this.selEl.addEventListener('mouseover', (e) => {
      const row = (e.target as HTMLElement).closest('[data-mod]') as HTMLElement | null;
      this.setHoverMod(row?.dataset.mod ?? null);
    });
    this.selEl.addEventListener('mouseleave', () => this.setHoverMod(null));
    this.tipEl = h('div', 'panel hidden');
    this.tipEl.id = 'tooltip';
    this.bannerEl = h('div');
    this.bannerEl.id = 'banner';
    this.helpEl = h('div', 'panel hp');
    this.helpEl.id = 'help';
    this.helpEl.innerHTML = HELP;
    this.setupEl = h('div', 'panel hp hidden');
    this.setupEl.id = 'setup';
    this.setupEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const b = (e.target as HTMLElement).closest('[data-ready]') as HTMLElement | null;
      if (b) this.act.ready(b.dataset.ready === '1');
    });
    this.root.append(top, this.logEl, this.buildEl, this.selEl, this.tipEl, this.bannerEl, this.helpEl, this.setupEl);
    this.buildBuildBar();
    this.helpEl.addEventListener('click', () => this.helpEl.classList.add('hidden'));
  }

  toggleHelp(force?: boolean) {
    this.helpEl.classList.toggle('hidden', force === undefined ? undefined : !force);
  }

  private buildBuildBar() {
    const w = this.world;
    const fac = w.myFaction;
    for (const cat of ['naval', 'ground', 'air'] as Cat[]) {
      const g = h('div', 'bgroup');
      const head = h('div', 'bh', cat.toUpperCase());
      const fl = h('span');
      head.appendChild(fl);
      this.factoryLabels.set(cat, fl);
      const row = h('div', 'bb');
      for (const type of BUILDABLE[cat]) {
        const d = UNITS[type];
        const b = h('div', 'bbtn');
        const img = h('img');
        img.src = symbolDataUrl('own', d.domain as SymDomain, glyphFor(type), 11);
        b.append(img, h('div', 'n', d.short), h('div', 'c', fmtMoney(unitCost(type, fac))));
        b.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          if (e.button === 0) {
            this.act.build(cat, type);
            b.classList.remove('flash');
            void b.offsetWidth;
            b.classList.add('flash');
          } else if (e.button === 2) this.act.cancel(cat, type);
        });
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        b.addEventListener('mouseenter', () => {
          audio.play('hover');
          this.showTip(b, this.unitTip(type));
        });
        b.addEventListener('mouseleave', () => this.hideTip());
        row.appendChild(b);
        this.buttons.set(type, b);
      }
      g.append(head, row);
      this.buildEl.appendChild(g);
    }
  }

  unitTip(type: UnitType): string {
    const w = this.world;
    const fac = w.myFaction;
    const d = unitDef(type, fac);
    const lo = matchLoadoutOf(type);
    const st = deriveStats(type, fac, lo);
    const weapons = lo
      .map((id) => MODULES[id])
      .filter(Boolean)
      .map((m) => m.short)
      .join(' · ');
    const hold = st.hold;
    return `<div class="tt-h">${d.names[fac]}</div><div class="tt-r">${d.role}</div>
      <div class="tt-s"><span>COST</span><span>${fmtMoney(unitCost(type, fac))} · ${Math.round(unitBuildTime(type, fac))}s</span>
      <span>HULL</span><span>${st.hp} · speed ${Math.round(st.speed * 100)}</span>
      <span>FIT</span><span>${weapons}</span>
      ${hold ? `<span>HOLD</span><span>${hold} units</span>` : ''}
      ${d.deck ? `<span>DECK</span><span>${d.deck} air flights</span>` : ''}
      ${d.fuel ? `<span>FUEL</span><span>${d.fuel}s · ${Math.round((d.fuel * d.speed) / 2)} km radius</span>` : ''}
      ${st.radarAir || st.radarSurf ? `<span>RADAR</span><span>${Math.round(Math.max(st.radarAir, st.radarSurf))} km</span>` : ''}
      ${st.sonar ? `<span>SONAR</span><span>${Math.round(st.sonar)} km</span>` : ''}
      ${d.domain !== 'land' ? `<span>SIGNATURE</span><span>${d.domain === 'sub' ? `noise ${Math.round(st.quiet * 100)}%` : `radar ${Math.round(st.signature * 100)}%`}</span>` : ''}</div>
      <div class="tt-r" style="margin:6px 0 0">LMB: place on the map (Shift: several) · RMB: cancel last</div>`;
  }

  showTip(anchor: HTMLElement | { x: number; y: number }, html: string) {
    this.tipEl.innerHTML = html;
    this.tipEl.classList.remove('hidden');
    const tw = this.tipEl.offsetWidth;
    const th = this.tipEl.offsetHeight;
    let x: number;
    let y: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      x = r.left + r.width / 2 - tw / 2;
      y = r.top - th - 10;
    } else {
      x = anchor.x + 16;
      y = anchor.y + 16;
    }
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - th - 8, y));
    this.tipEl.style.left = x + 'px';
    this.tipEl.style.top = y + 'px';
  }
  hideTip() {
    this.tipEl.classList.add('hidden');
  }

  log(who: string, text: string, kind: '' | 'warn' | 'bad' | 'good' = '') {
    const m = h('div', 'm ' + kind);
    m.innerHTML = `<span class="who">${esc(who)}</span>${esc(text)}`;
    this.logEl.appendChild(m);
    while (this.logEl.children.length > 7) this.logEl.firstChild!.remove();
    setTimeout(() => m.classList.add('old'), 7000);
    setTimeout(() => m.remove(), 8200);
  }

  banner(text: string, sub = '') {
    this.bannerEl.innerHTML = '';
    const b = h('div', 'b', `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`);
    this.bannerEl.appendChild(b);
  }

  alert() {
    const v = h('div', 'vignette-alert');
    this.root.appendChild(v);
    setTimeout(() => v.remove(), 1300);
  }

  /** Called every frame; heavy DOM work is throttled. */
  update(selected: UView[], clock: number) {
    const w = this.world;
    // The DOM changes at most 10 times a second, not every frame: layout and style work is costly.
    if (clock - this.lastHud < 0.1 && clock >= this.lastHud) return;
    this.lastHud = clock;
    const cashHtml = `${fmtMoney(w.displayCash)}<small>+${w.income.toFixed(1)}/s</small>`;
    if (cashHtml !== this.lastCash) {
      this.cashEl.innerHTML = cashHtml;
      this.lastCash = cashHtml;
    }
    const t = Math.floor(w.serverTime);
    this.clockEl.textContent = `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    this.updateWeatherLabel();
    this.updatePlayers();
    this.updateSetup();
    this.updateBuild();
    this.updateSelection(selected);
  }

  /** Deployment banner: timer, budget, how to place, and the launch button (built once, then only its text changes). */
  private setupParts: { timer: HTMLElement; cash: HTMLElement; btn: HTMLButtonElement } | null = null;
  private updateSetup() {
    const w = this.world;
    const s = w.setup;
    this.setupEl.classList.toggle('hidden', !s);
    if (!s) return;
    if (!this.setupParts) {
      this.setupEl.innerHTML = `<div class="st">DEPLOYMENT PHASE <b></b></div>
        <div class="sh">Pick a unit below, then click inside your zone to place it (hold Shift to place several).
        Right-click moves placed units · troops right-click a ship to embark · Del refunds.
        Unspent <span class="cs"></span> carries into the battle.</div>
        <button class="btn"></button>`;
      this.setupParts = {
        timer: this.setupEl.querySelector('.st b')!,
        cash: this.setupEl.querySelector('.cs')!,
        btn: this.setupEl.querySelector('button')!,
      };
    }
    const ready = s.ready.includes(w.me);
    const waiting = w.players.filter((p) => p.id !== w.me && !p.bot && !s.ready.includes(p.id)).length;
    const key = `${s.left}|${ready}|${waiting}|${Math.floor(w.cash)}`;
    if (key === this.setupKey) return;
    this.setupKey = key;
    const { timer, cash, btn } = this.setupParts;
    timer.textContent = `${Math.floor(s.left / 60)}:${String(s.left % 60).padStart(2, '0')}`;
    cash.textContent = fmtMoney(w.cash);
    btn.dataset.ready = ready ? '0' : '1';
    btn.classList.toggle('on', ready);
    btn.textContent = ready ? `READY ✓${waiting ? ` · WAITING FOR ${waiting}` : ''} · CLICK TO EDIT` : 'LAUNCH BATTLE ▸';
  }

  private updateWeatherLabel() {
    const w = this.world;
    const storms = w.weather.filter((c) => c[0] === 0 && c[4] > 20).length;
    const fogs = w.weather.filter((c) => c[0] === 1 && c[4] > 20).length;
    const parts = [];
    if (storms) parts.push(`${storms} STORM${storms > 1 ? 'S' : ''}`);
    if (fogs) parts.push(`${fogs} FOG BANK${fogs > 1 ? 'S' : ''}`);
    this.wxEl.textContent = parts.length ? parts.join(' · ') : 'CLEAR · VIS GOOD';
    this.wxEl.className = 'wx' + (storms ? ' storm' : '');
    this.wxEl.title = storms
      ? 'Inside a storm (at full strength): radar -45%, eyesight -70%; ships 40% slower and turn 40% slower; aircraft 25% slower and burn fuel twice as fast; troops 50% slower; guns and bombs 35% less accurate from a storm, missiles 10%; anything in a storm 25% harder to hit. Subs and sonar do not feel it.'
      : '';
  }

  private updatePlayers() {
    const w = this.world;
    const total = w.map.sites.filter((s) => s.type === 'resource').length;
    const html = w.players
      .map((p) => {
        const col = p.id === w.me ? SIDE.own : p.team === w.myTeam ? SIDE.ally : SIDE.hostile;
        const dom = p.dom > 0 ? `<span class="domin">DOM ${Math.max(0, 180 - p.dom)}s</span>` : '';
        return `<div class="p ${p.defeated ? 'dead' : ''}"><i style="background:${col}"></i>${esc(p.name)} <b>${p.res}/${total}</b>${dom}</div>`;
      })
      .join('');
    if (this.playersEl.innerHTML !== html) this.playersEl.innerHTML = html;
  }

  private updateBuild() {
    const w = this.world;
    const fac = w.myFaction;
    for (const cat of ['naval', 'ground', 'air'] as Cat[]) {
      this.factoryLabels.get(cat)!.textContent = w.setup ? 'DEPLOY' : '';
      // Units are built at the nearest of our sites that produce them: none held, none built.
      const canBuild = w.map.sites.some((s) => BUILDINGS[s.type].produces === cat && w.sites[s.id].owner === w.me);
      const q = w.queues[cat];
      for (const type of BUILDABLE[cat]) {
        const b = this.buttons.get(type)!;
        const n = q.filter((i) => i.type === type).length;
        const cost = unitCost(type, fac);
        b.classList.toggle('poor', w.cash < cost || (!canBuild && !w.setup));
        let qe = b.querySelector('.q') as HTMLElement | null;
        if (n) {
          if (!qe) {
            qe = h('div', 'q');
            b.appendChild(qe);
          }
          qe.textContent = String(n);
        } else qe?.remove();
        let pr = b.querySelector('.pr') as HTMLElement | null;
        const front = q[0]?.type === type ? q[0].progress : -1;
        if (front >= 0) {
          if (!pr) {
            pr = h('div', 'pr');
            b.appendChild(pr);
          }
          pr.style.width = `${front * 100}%`;
        } else pr?.remove();
      }
    }
  }

  private updateSelection(sel: UView[]) {
    const w = this.world;
    const el = this.selEl;
    if (this.siteSel !== null && !sel.length) {
      const key = `site:${this.siteSel}:${w.sites[this.siteSel].owner}:${Math.round(w.sites[this.siteSel].cap * 20)}`;
      if (key !== this.selKey) {
        this.selKey = key;
        el.classList.remove('empty');
        el.innerHTML = this.siteHtml(this.siteSel);
      }
      return;
    }
    if (!sel.length) {
      if (this.selKey !== '') {
        this.selKey = '';
        el.classList.add('empty');
      }
      return;
    }
    el.classList.remove('empty');
    if (sel.length === 1) {
      const u = sel[0];
      const d = w.details.get(u.id);
      const key = `u:${u.id}:${u.hp}:${u.flags & (F_DARK | F_PAINTED | F_HOLD | F_FREE)}:${JSON.stringify(d)}:${[...this.cargoSel].join(',')}`;
      if (key === this.selKey) return;
      this.selKey = key;
      el.innerHTML = this.unitHtml(u);
      this.bindSel();
      return;
    }
    const groups = new Map<UnitType, UView[]>();
    for (const u of sel) {
      const a = groups.get(u.type) ?? [];
      a.push(u);
      groups.set(u.type, a);
    }
    const key = 'm:' + [...groups.entries()].map(([t, a]) => `${t}${a.length}`).join(',') + sel.map((u) => `${u.hp}/${u.flags & (F_DARK | F_HOLD | F_FREE)}`).join(',');
    if (key === this.selKey) return;
    this.selKey = key;
    const avg = sel.reduce((s, u) => s + u.hp, 0) / sel.length;
    el.innerHTML =
      `<div class="status">${sel.length} UNITS SELECTED · AVG HULL ${Math.round(avg)}%</div><div class="multi">` +
      [...groups.entries()]
        .map(([t, a]) => `<div class="mi" data-type="${t}"><img src="${symbolDataUrl('own', UNITS[t].domain as SymDomain, glyphFor(t), 10)}">${UNITS[t].short} ×${a.length}</div>`)
        .join('') +
      `</div><div class="acts">${this.actButtons(sel)}</div>`;
    el.querySelectorAll<HTMLElement>('.mi').forEach((m) =>
      m.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        const t = m.dataset.type as UnitType;
        this.act.selectOnly(sel.filter((u) => u.type === t).map((u) => u.id));
      }),
    );
    this.bindActs();
  }

  private siteHtml(id: number): string {
    const w = this.world;
    const s = w.map.sites[id];
    const sv = w.sites[id];
    const b = BUILDINGS[s.type];
    const affil = sv.owner === -2 ? 'unknown' : sv.owner < 0 ? 'neutral' : sv.owner === w.me ? 'own' : w.teamOf(sv.owner) === w.myTeam ? 'ally' : 'hostile';
    const owner = sv.owner === -2 ? 'UNKNOWN · NOT SCOUTED' : sv.owner < 0 ? 'NEUTRAL' : w.players[sv.owner].name;
    const isl = w.map.islands[s.island];
    return `<div class="sp-head"><img src="${symbolDataUrl(affil, 'site', SITE_GLYPH[s.type], 13)}"><div><div class="nm">${b.name.toUpperCase()}</div><div class="ty">${esc(isl.home >= 0 ? (w.players.some((p) => p.slot === isl.home) ? 'HOME ISLAND' : 'UNCLAIMED ISLAND') : isl.name)} · ${esc(owner)}</div></div></div>
      <div class="tt-r" style="color:var(--dim);font-size:10px;line-height:1.5">${b.desc}</div>
      ${sv.cap > 0 ? `<div class="status">CAPTURE ${Math.round(sv.cap * 100)}%</div><div class="bar"><i style="width:${sv.cap * 100}%;background:var(--warn)"></i></div>` : ''}`;
  }

  private unitHtml(u: UView): string {
    const w = this.world;
    const def = unitDef(u.type, this.world.myFaction);
    const fac = w.myFaction;
    const d = w.details.get(u.id);
    const lo = matchLoadoutOf(u.type);
    const col = u.hp > 60 ? 'var(--good)' : u.hp > 30 ? 'var(--warn)' : 'var(--bad)';
    const order = d ? ORDER_CODES[d[4]] : 'idle';
    const statusTxt: Record<string, string> = {
      idle: 'HOLDING POSITION',
      move: 'UNDERWAY',
      attack: 'ENGAGING',
      board: 'BOARDING',
      patrol: 'ON STATION',
      rtb: 'RETURNING TO BASE',
      retreat: 'RETREATING',
      unload: 'UNLOADING TROOPS',
      merchant: 'HAULING CARGO',
      lander: 'FERRYING',
      escort: 'ESCORTING',
    };
    const kills = d?.[15] ?? 0;
    let html = `<div class="sp-head"><img src="${symbolDataUrl('own', def.domain as SymDomain, glyphFor(u.type), 13)}"><div><div class="nm">${esc(unitName(fac, u.type, u.id))}</div><div class="ty">${def.names[fac]}</div></div><div class="kc${kills ? '' : ' z'}" title="Enemy units destroyed">${kills}<span>KILLS</span></div></div>`;
    const portFlags = d ? d[7] : 0;
    const where = def.domain === 'land' ? 'AT BASE' : 'IN PORT';
    const port = portFlags & 8 ? ` · <span style="color:var(--bad)">${where} · IN COMBAT, REPAIRS HELD</span>` : portFlags & 4 ? ` · <span style="color:var(--good)">${where} · REPAIRING &amp; REARMING</span>` : '';
    html += `<div class="status">${statusTxt[order] ?? order.toUpperCase()}${u.flags & 8 ? ' · REARMING' : ''}${port}</div>`;
    html += `<div class="bar"><i style="width:${u.hp}%;background:${col}"></i></div>`;
    if (d) {
      let wi = 0;
      for (const id of lo) {
        const m = MODULES[id];
        if (!m) continue;
        if (!m.proj) {
          html += `<div class="wrow"><span>${m.name}</span><span class="pips" style="color:var(--faint)">PASSIVE</span></div>`;
          continue;
        }
        const out = d[13][6] === wi;
        const ammo = d[1][wi++] ?? -1;
        const max = m.ammo ?? -1;
        if (out) {
          html += `<div class="wrow${this.hoverMod === m.id ? ' hl' : ''}" data-mod="${m.id}"><span>${m.name}</span><span class="pips" style="color:var(--bad)">KNOCKED OUT ${d[13][7]}s</span></div>`;
          continue;
        }
        let pips = '∞';
        if (max > 0) {
          const n = Math.max(0, ammo);
          pips = '▮'.repeat(Math.min(n, 16)) + `<span class="e">${'▮'.repeat(Math.max(0, Math.min(max, 16) - Math.min(n, 16)))}</span>`;
        }
        html += `<div class="wrow${this.hoverMod === m.id ? ' hl' : ''}" data-mod="${m.id}"><span>${m.name}${m.ability ? '<span class="kbd">M</span>' : ''}</span><span class="pips">${pips}</span></div>`;
      }
      if (def.domain === 'sea' || def.domain === 'sub') html += this.damageHtml(d[13]);
      if (this.hasRadar(u.type)) {
        const dark = (u.flags & F_DARK) !== 0;
        const painted = (u.flags & F_PAINTED) !== 0;
        html += `<div class="wrow"><span>RADAR<span class="kbd">G</span></span><span class="pips" style="color:${dark ? 'var(--faint)' : 'var(--good)'}">${dark ? 'OFF · SILENT' : 'ACTIVE · EMITTING'}</span></div>`;
        if (painted) html += lockRow(d?.[16]);
      } else if (u.flags & F_PAINTED) html += lockRow(d?.[16]);
      const cmk = counterOf(u.type);
      if (cmk) {
        const left = d[14] ?? 0;
        html += `<div class="wrow"><span>${cmk === 'chaff' ? 'CHAFF' : 'SMOKE'}<span class="kbd">C</span></span><span class="pips" style="color:${left > 0 ? 'var(--good)' : 'var(--faint)'}">${left > 0 ? 'READY' : 'USED · REARM'}</span></div>`;
      }
      if (def.domain === 'air') {
        html += `<div class="wrow"><span>FUEL</span><span>${d[3]}%</span></div><div class="bar"><i style="width:${d[3]}%;background:var(--accent)"></i></div>`;
      }
      const hold = def.hold + lo.reduce((s, id) => s + (MODULES[id]?.mods?.hold ?? 0), 0);
      if (hold > 0) {
        html += `<div class="status" style="margin-top:8px">HOLD ${d[2].length}/${hold} · CLICK TROOPS TO PICK</div><div class="cargo">`;
        for (let i = 0; i < hold; i++) {
          const cid = d[2][i];
          if (cid !== undefined) {
            const sel = this.cargoSel.has(cid);
            html += `<div class="cs full ${sel ? 'sel' : ''}" data-cargo="${cid}"><img src="${symbolDataUrl('own', 'land', glyphFor(this.cargoType(cid)), 9)}"></div>`;
          } else html += `<div class="cs"></div>`;
        }
        html += `</div>`;
      }
      const deck = def.deck ?? 0;
      if (deck > 0) {
        const stowed = d[12].filter((id) => (w.units.get(id)?.flags ?? 0) & F_ABOARD).length;
        html += `<div class="status" style="margin-top:8px">AIR WING ${d[12].length}/${deck} · ${stowed} ON DECK${stowed ? ' · L TO LAUNCH' : ''} · RMB SHIP WITH AIRCRAFT TO BASE THEM</div><div class="cargo">`;
        for (let i = 0; i < deck; i++) {
          const a = d[12][i] !== undefined ? w.units.get(d[12][i]) : undefined;
          const t = a?.type ?? this.world.cargoTypes.get(d[12][i] ?? -1);
          const below = !!a && (a.flags & F_ABOARD) !== 0;
          if (d[12][i] !== undefined && t) html += `<div class="cs full" style="${below ? '' : 'opacity:.45'}" title="${below ? 'On deck' : 'Airborne'}"><img src="${symbolDataUrl('own', 'air', glyphFor(t), 9)}"></div>`;
          else html += `<div class="cs"></div>`;
        }
        html += `</div>`;
      }
    }
    html += `<div class="acts">${this.actButtons([u])}</div>`;
    return html;
  }

  /** Ship systems panel: every knocked-out system with the seconds until it is repaired. */
  private damageHtml(s: number[]): string {
    const rows: [string, string, string][] = [];
    if (s[0] > CRIT.engineSlow) rows.push(['ENGINE', `DEAD IN THE WATER ${s[0] - CRIT.engineSlow}s`, 'var(--bad)']);
    else if (s[0] > 0) rows.push(['ENGINE', `DAMAGED · 55% SPEED ${s[0]}s`, 'var(--warn)']);
    if (s[1] > 0) rows.push(['STEERING', `JAMMED ${s[1]}s`, 'var(--warn)']);
    if (s[2] > 0) rows.push(['RADAR', `DOWN · 35% RANGE ${s[2]}s`, 'var(--warn)']);
    if (s[3] > 0) rows.push(['FIRE', `BURNING ${s[3]}s`, 'var(--bad)']);
    if (s[4] > 0) rows.push(['HULL', `FLOODING ${s[4]}s`, 'var(--bad)']);
    if (s[5] > 0) rows.push(['CREW', `STUNNED ${s[5]}s`, 'var(--warn)']);
    if (!rows.length) return `<div class="wrow"><span>SYSTEMS</span><span class="pips" style="color:var(--good)">NOMINAL</span></div>`;
    return rows.map(([a, b, c]) => `<div class="wrow"><span>${a}</span><span class="pips" style="color:${c}">${b}</span></div>`).join('');
  }

  private cargoType(id: number): UnitType {
    return this.world.cargoTypes.get(id) ?? 'infantry';
  }

  private actButtons(sel: UView[]): string {
    const w = this.world;
    const b: string[] = [];
    const any = (f: (u: UView) => boolean) => sel.some(f);
    const ships = sel.filter((u) => (w.details.get(u.id)?.[2].length ?? 0) > 0);
    if (ships.length >= 1) b.push(`<button class="btn small" data-act="unload">UNLOAD${ships.length > 1 ? ` ×${ships.length}` : ''}<span class="kbd">U</span></button>`);
    if (any((u) => matchLoadoutOf(u.type).includes('mines'))) b.push(`<button class="btn small" data-act="mines">DROP MINES<span class="kbd">M</span></button>`);
    if (any((u) => matchLoadoutOf(u.type).includes('sonobuoy'))) b.push(`<button class="btn small" data-act="mines">DROP BUOY<span class="kbd">M</span></button>`);
    if (any((u) => UNITS[u.type].domain === 'air')) b.push(`<button class="btn small" data-act="rtb">RTB<span class="kbd">R</span></button>`);
    // Carriers with flights on deck: launch them at a point.
    if (any((u) => (w.details.get(u.id)?.[12] ?? []).some((a) => (w.units.get(a)?.flags ?? 0) & F_ABOARD))) b.push(`<button class="btn small" data-act="launch">LAUNCH<span class="kbd">L</span></button>`);
    if (any((u) => UNITS[u.type].category === 'naval' || UNITS[u.type].category === 'ground')) {
      const on = sel.every((u) => ((w.details.get(u.id)?.[7] ?? 1) & 1) === 1);
      b.push(`<button class="btn small ${on ? 'on' : ''}" data-act="retreat">AUTO-RETREAT<span class="kbd">T</span></button>`);
    }
    if (w.setup) {
      b.push(`<button class="btn small" data-act="refund">REFUND<span class="kbd">DEL</span></button>`);
      return b.join('');
    }
    // Fire control: hold fire / weapons tight / weapons free (the button shows the current state).
    if (sel.some((u) => matchLoadoutOf(u.type).some((id) => MODULES[id]?.proj))) {
      const modes = new Set(sel.map((u) => fireModeOf(u.flags)));
      const m = modes.size === 1 ? [...modes][0] : -1;
      const label = m === 0 ? 'HOLD FIRE' : m === 2 ? 'WEAPONS FREE' : m === 1 ? 'WEAPONS TIGHT' : 'FIRE: MIXED';
      b.push(`<button class="btn small ${m === 0 ? '' : m === 2 ? 'on' : ''}" data-act="firemode" title="Hold fire: only self-defence against missiles · Weapons tight: at most 2 guided rounds in flight per target · Weapons free: fire everything that bears">${label}<span class="kbd">F</span></button>`);
    }
    // Radar on/off (only units that have a radar of their own).
    const radars = sel.filter((u) => this.hasRadar(u.type));
    if (radars.length) {
      const anyOn = radars.some((u) => !(u.flags & F_DARK));
      b.push(`<button class="btn small ${anyOn ? '' : 'on'}" data-act="radar">${anyOn ? 'RADAR OFF' : 'RADAR ON'}<span class="kbd">G</span></button>`);
    }
    // Countermeasures: chaff (warships, aircraft), smoke (ground units).
    const cms = new Set(sel.map((u) => counterOf(u.type)).filter(Boolean));
    if (cms.size) b.push(`<button class="btn small" data-act="counter">${cms.size === 1 ? [...cms][0]!.toUpperCase() : 'CHAFF / SMOKE'}<span class="kbd">C</span></button>`);
    b.push(`<button class="btn small" data-act="stop">STOP<span class="kbd">X</span></button>`);
    return b.join('');
  }

  private bindSel() {
    this.selEl.querySelectorAll<HTMLElement>('[data-cargo]').forEach((c) =>
      c.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.act.toggleCargo(Number(c.dataset.cargo));
      }),
    );
    this.bindActs();
  }

  private bindActs() {
    this.selEl.querySelectorAll<HTMLElement>('[data-act]').forEach((b) =>
      b.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        audio.play('click');
        const a = b.dataset.act!;
        if (a === 'unload') this.act.unloadMode(-1, []);
        else this.act.ability(a as any);
      }),
    );
  }

  /** Does this unit type carry a radar of its own (hull radar, radar pod or radar truck)? */
  private hasRadar(type: UnitType): boolean {
    if (UNITS[type].radarAir > 0 || UNITS[type].radarSurf > 0) return true;
    return matchLoadoutOf(type).some((id) => !!(MODULES[id]?.mods?.radarAir || MODULES[id]?.mods?.radarSurf));
  }

  invalidate() {
    this.selKey = '#';
  }
}

const HELP = `<b>FIELD MANUAL</b> <span style="float:right;color:var(--faint)">[F1] hide</span><br>
<span class="k">LMB</span> select · drag box · dbl-click same type<br>
<span class="k">RMB</span> move / attack / board ship<br>
<span class="k">CTRL+RMB</span> force move (no fighting)<br>
<span class="k">WASD · MMB drag</span> pan · <span class="k">Q/E</span> rotate · <span class="k">wheel</span> zoom<br>
<span class="k">U</span> unload troops, then click land in the ring<br>
<span class="k">C</span> chaff / smoke · <span class="k">G</span> radar on/off · <span class="k">F</span> fire control · <span class="k">M</span> mines / sonobuoy · <span class="k">R</span> aircraft RTB · <span class="k">L</span> carrier launch · <span class="k">X</span> stop<br>
<span class="k">CTRL+1-9</span> group · <span class="k">1-9</span> recall · <span class="k">SPACE</span> last alert<br>
<span class="k">TAB</span> weapon ranges · <span class="k">V</span> sensor coverage<br>
<span class="k">ENTER</span> chat · <span class="k">ESC</span> menu<br>
<b>SSN</b> beats <b>BB/CV</b> · <b>BB</b> beats <b>DDG</b> · <b>DDG</b> beats <b>SSN</b>: escort your big ships.<br>
Troops board ships by RMB on a ship. Capture <b>$</b> sites — merchants haul cash home. Take the enemy <b>HQ</b> to win.`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** 0 hold fire, 1 weapons tight, 2 weapons free (from the unit flags). */
export function fireModeOf(flags: number): number {
  return flags & F_HOLD ? 0 : flags & F_FREE ? 2 : 1;
}

/** A quiet line for an enemy radar lock, with the compass bearing to the radar. */
function lockRow(b: number | undefined): string {
  // Map frame: +x east, +y south, so compass = 90° + the map angle.
  const deg = b === undefined || b === 999 ? null : Math.round((((b / 100) * 180) / Math.PI + 90 + 360) % 360);
  return `<div class="wrow"><span style="color:rgba(255,186,92,0.85)">◜ RADAR LOCK</span><span class="pips" style="color:rgba(255,186,92,0.85)">${deg === null ? '' : String(deg).padStart(3, '0') + '°'}</span></div>`;
}

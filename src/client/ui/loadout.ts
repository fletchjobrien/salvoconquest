// Loadout editor: rotating pixelated 3D preview, drag modules into slots. Defaults are recommended.
import * as THREE from 'three';
import { BUILDABLE, MODULES, ModuleDef, SLOT_LABEL, UNITS, UnitType, deriveStats, moduleFits, modulesFor, unitDef, Faction } from '../../shared/defs';
import { loadoutOf, setLoadout } from '../loadouts';
import { makeUnitModel } from '../render/models';
import { PALETTES } from '../theme';
import { glyphFor, symbolDataUrl, SymDomain } from '../render/symbols';
import { audio } from '../audio/sfx';
import { settings } from '../settings';

const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

export class LoadoutEditor {
  el: HTMLElement;
  private type: UnitType = 'destroyer';
  private slot = 0;
  private gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  private model: THREE.Object3D | null = null;
  private stage = new THREE.Group();
  private raf = 0;
  private t = 0;
  private faction: Faction;

  constructor(
    ui: HTMLElement,
    private onClose: () => void,
  ) {
    this.faction = settings.faction;
    this.el = h(`<div class="screen"><div class="lo-wrap panel">
      <div class="lo-list" id="list"></div>
      <div class="lo-center">
        <div class="lo-title"><div class="nm" id="nm"></div><div class="ro" id="ro"></div></div>
        <canvas id="pv"></canvas>
        <div class="lo-stats" id="stats"></div>
        <div class="lo-slots" id="slots"></div>
      </div>
      <div class="lo-mods"><div class="lo-note">★ DEFAULT FITS ARE THE RECOMMENDED SETUP · EACH FACTION HAS ITS OWN WEAPONS</div><div id="mods"></div>
        <div class="menu-row" style="margin-top:12px"><button class="btn small" id="reset">Reset unit</button><button class="btn small" id="fac">Faction: ${this.faction.toUpperCase()}</button><button class="btn small primary" id="close" style="margin-left:auto">Done</button></div></div>
    </div></div>`);
    ui.appendChild(this.el);
    const canvas = this.el.querySelector('#pv') as HTMLCanvasElement;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
    this.gl.setPixelRatio(1);
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.add(new THREE.HemisphereLight(0xcfe3ef, 0x3a4a52, 1.6));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-2, 4, 3);
    this.scene.add(sun);
    this.scene.add(this.stage);
    const water = new THREE.Mesh(new THREE.CircleGeometry(1.4, 40), new THREE.MeshLambertMaterial({ color: 0x0f4a63 }));
    water.rotation.x = -Math.PI / 2;
    water.name = 'water';
    this.scene.add(water);
    this.el.querySelector('#close')!.addEventListener('click', () => this.close());
    this.el.querySelector('#reset')!.addEventListener('click', () => {
      setLoadout(this.type, this.faction, null);
      audio.play('click');
      this.refresh();
    });
    this.el.querySelector('#fac')!.addEventListener('click', (e) => {
      this.faction = this.faction === 'coalition' ? 'union' : 'coalition';
      (e.target as HTMLElement).textContent = `Faction: ${this.faction.toUpperCase()}`;
      this.select(this.type);
    });
    this.buildList();
    this.select('destroyer');
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.render();
    };
    loop();
  }

  private buildList() {
    const list = this.el.querySelector('#list')!;
    list.innerHTML = '';
    for (const cat of ['naval', 'ground', 'air'] as const) {
      list.appendChild(h(`<div class="cat">${cat.toUpperCase()}</div>`));
      for (const t of BUILDABLE[cat]) {
        const changed = loadoutOf(t, this.faction).join() !== unitDef(t, this.faction).defaults.join();
        const it = h(`<div class="it ${t === this.type ? 'sel' : ''}" data-t="${t}"><img src="${symbolDataUrl('own', UNITS[t].domain as SymDomain, glyphFor(t), 9)}">${UNITS[t].short}${changed ? '<span class="mod">CUSTOM</span>' : ''}</div>`);
        it.addEventListener('click', () => {
          audio.play('click');
          this.select(t);
        });
        list.appendChild(it);
      }
    }
  }

  private select(t: UnitType) {
    this.type = t;
    this.slot = 0;
    this.buildList();
    if (this.model) this.stage.remove(this.model);
    const m = makeUnitModel(t, this.faction, PALETTES.jungle);
    this.model = m.root;
    const s = 1.6 / m.baseLen;
    m.root.scale.setScalar(s);
    const dom = UNITS[t].domain;
    m.root.position.y = dom === 'air' ? 0.35 : dom === 'sub' ? -0.01 : 0;
    this.stage.add(m.root);
    const water = this.scene.getObjectByName('water') as THREE.Mesh;
    (water.material as THREE.MeshLambertMaterial).color.setHex(dom === 'land' ? 0x5b6b4a : 0x0f4a63);
    this.refresh();
  }

  private refresh() {
    const t = this.type;
    const def = unitDef(t, this.faction);
    const lo = loadoutOf(t, this.faction);
    this.el.querySelector('#nm')!.textContent = def.names[this.faction].toUpperCase();
    this.el.querySelector('#ro')!.textContent = def.role;
    const st = deriveStats(t, this.faction, lo);
    const weapons = lo.map((id) => MODULES[id]).filter((m) => m?.proj);
    const maxR = Math.max(0, ...weapons.map((m) => m.range ?? 0));
    const cells: [string, string][] = [
      ['HULL', String(st.hp)],
      ['SPEED', (st.speed * 100).toFixed(0)],
      ['RADAR', `${Math.round(Math.max(st.radarAir, st.radarSurf))} km`],
      ['SONAR', st.sonar ? `${Math.round(st.sonar)} km` : '—'],
      ['REACH', `${maxR} km`],
      ['HOLD', st.hold ? `${st.hold}` : '—'],
      ['ECM', st.ecm ? `${Math.round(st.ecm * 100)}%` : '—'],
      [def.fuel ? 'ENDURANCE' : 'STEALTH', def.fuel ? `${Math.round(st.fuel)} s` : st.quiet < 1 ? `${Math.round((1 - st.quiet) * 100)}%` : '—'],
    ];
    this.el.querySelector('#stats')!.innerHTML = cells.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
    const slots = this.el.querySelector('#slots')!;
    slots.innerHTML = '';
    def.slots.forEach((kind, i) => {
      const m = MODULES[lo[i]];
      const changed = lo[i] !== def.defaults[i];
      const el = h(`<div class="lo-slot ${i === this.slot ? 'sel' : ''} ${changed ? 'changed' : ''}"><div class="k">${SLOT_LABEL[kind]}</div><div class="v">${m?.name ?? '—'}</div></div>`);
      el.addEventListener('click', () => {
        this.slot = i;
        audio.play('click');
        this.refresh();
      });
      el.addEventListener('dragover', (e) => {
        const id = (e.dataTransfer?.types.includes('text/mod') && this.dragging) || '';
        if (id && moduleFits(id, kind, this.faction)) {
          e.preventDefault();
          el.classList.add('drop');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drop');
        const id = e.dataTransfer?.getData('text/mod') ?? '';
        this.assign(i, id);
      });
      slots.appendChild(el);
    });
    this.renderMods();
  }

  private dragging = '';

  private renderMods() {
    const t = this.type;
    const def = unitDef(t, this.faction);
    const kind = def.slots[this.slot];
    const box = this.el.querySelector('#mods')!;
    box.innerHTML = `<div class="label">${kind ? SLOT_LABEL[kind] : ''} — click or drag</div>`;
    const mods = modulesFor(t, this.faction).sort((a, b) => Number(moduleFits(b.id, kind, this.faction)) - Number(moduleFits(a.id, kind, this.faction)));
    for (const m of mods) {
      const fits = moduleFits(m.id, kind, this.faction);
      const isDefault = def.defaults[this.slot] === m.id;
      const el = h(`<div class="lo-mod ${fits ? '' : 'na'}" draggable="true"><div class="h">${m.name}<span>${isDefault ? '★ DEFAULT' : m.slots.map((s) => SLOT_LABEL[s]).join(' / ')}</span></div><div class="d">${m.desc}</div>${statLine(m)}</div>`);
      el.addEventListener('click', () => {
        if (fits) this.assign(this.slot, m.id);
        else audio.play('deny');
      });
      el.addEventListener('dragstart', (e) => {
        this.dragging = m.id;
        e.dataTransfer?.setData('text/mod', m.id);
        audio.play('hover');
      });
      el.addEventListener('dragend', () => (this.dragging = ''));
      box.appendChild(el);
    }
  }

  private assign(i: number, id: string) {
    const kind = unitDef(this.type, this.faction).slots[i];
    if (!moduleFits(id, kind, this.faction)) {
      audio.play('deny');
      return;
    }
    const lo = loadoutOf(this.type, this.faction);
    lo[i] = id;
    setLoadout(this.type, this.faction, lo);
    audio.play('order');
    this.slot = i;
    this.buildList();
    this.refresh();
  }

  private render() {
    const c = this.gl.domElement;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    const px = 3;
    if (c.width !== Math.floor(w / px) || c.height !== Math.floor(hh / px)) {
      this.gl.setSize(Math.max(1, Math.floor(w / px)), Math.max(1, Math.floor(hh / px)), false);
      this.cam.aspect = w / Math.max(1, hh);
      this.cam.updateProjectionMatrix();
    }
    this.t += 1 / 60;
    this.stage.rotation.y = this.t * 0.35;
    if (this.model) this.model.rotation.z = Math.sin(this.t * 1.1) * 0.02;
    this.cam.position.set(0, 1.05, 2.9);
    this.cam.lookAt(0, 0.1, 0);
    this.gl.render(this.scene, this.cam);
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.gl.dispose();
    this.el.remove();
    this.onClose();
  }
}

function statLine(m: ModuleDef): string {
  if (!m.proj) return '';
  const dmg = Object.entries(m.dmg ?? {})
    .filter(([, v]) => (v ?? 0) > 1)
    .map(([k, v]) => `${k.toUpperCase()} ${v}`)
    .join(' · ');
  const parts = [`${m.range ?? 0} km`, dmg, m.ammo && m.ammo > 0 ? `${m.ammo} rds` : '∞', m.intercept ? `intercept ${Math.round(m.intercept * 100)}%` : '', m.evade ? `${Math.round((1 - m.evade) * 100)}% harder to intercept` : ''].filter(Boolean);
  return `<div class="st">${parts.join(' · ')}</div>`;
}

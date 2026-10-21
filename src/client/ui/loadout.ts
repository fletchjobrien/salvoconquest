// Fleet comp: pick one of three variants for every class, with a rotating pixelated 3D preview.
// Defaults are the recommended picks. The capital class is a choice between three ships.
import * as THREE from 'three';
import { CLASSES, CLASS_IDS, ClassId, Faction, MODULES, ModuleDef, UNITS, VariantDef, deriveStats, unitCost, unitDef, variantLoadout } from '../../shared/defs';
import { getFleet, resetFleet, setVariant } from '../loadouts';
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

const money = (v: number) => '$' + v.toLocaleString('en-US');

export class FleetBuilder {
  el: HTMLElement;
  private cls: ClassId = 'corvette';
  /** Variant shown in the preview (the picked one, or the card under the mouse). */
  private shown = 0;
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
      </div>
      <div class="lo-mods"><div class="lo-note">★ PICK ONE VARIANT PER CLASS · DEFAULTS ARE RECOMMENDED · EACH FACTION HAS ITS OWN WEAPONS</div><div id="vars"></div>
        <div class="menu-row" style="margin-top:12px"><button class="btn small" id="reset">Reset all</button><button class="btn small" id="fac">Faction: ${this.faction.toUpperCase()}</button><button class="btn small primary" id="close" style="margin-left:auto">Done</button></div></div>
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
      resetFleet(this.faction);
      audio.play('click');
      this.select(this.cls);
    });
    this.el.querySelector('#fac')!.addEventListener('click', (e) => {
      this.faction = this.faction === 'coalition' ? 'union' : 'coalition';
      (e.target as HTMLElement).textContent = `Faction: ${this.faction.toUpperCase()}`;
      this.select(this.cls);
    });
    this.select('corvette');
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.render();
    };
    loop();
  }

  private picked(c: ClassId): number {
    return getFleet(this.faction)[c];
  }

  private buildList() {
    const list = this.el.querySelector('#list')!;
    list.innerHTML = '';
    for (const cat of ['naval', 'ground', 'air'] as const) {
      list.appendChild(h(`<div class="cat">${cat.toUpperCase()}</div>`));
      for (const c of CLASS_IDS.filter((k) => CLASSES[k].cat === cat)) {
        const def = CLASSES[c];
        const v = def.variants[this.picked(c)];
        const custom = this.picked(c) !== def.def;
        const it = h(`<div class="it ${c === this.cls ? 'sel' : ''}"><img src="${symbolDataUrl('own', UNITS[v.type].domain as SymDomain, glyphFor(v.type), 9)}"><span>${def.name}<span class="vn">${v.name}</span></span>${custom ? '<span class="mod">CHANGED</span>' : ''}</div>`);
        it.addEventListener('click', () => {
          audio.play('click');
          this.select(c);
        });
        list.appendChild(it);
      }
    }
  }

  private select(c: ClassId) {
    this.cls = c;
    this.shown = this.picked(c);
    this.buildList();
    this.renderVariants();
    this.showVariant(this.shown);
  }

  /** Put this variant's model in the preview and its numbers under it. */
  private showVariant(i: number) {
    this.shown = i;
    const v = CLASSES[this.cls].variants[i];
    if (this.model) this.stage.remove(this.model);
    const m = makeUnitModel(v.type, this.faction, PALETTES.jungle, i);
    this.model = m.root;
    m.root.scale.setScalar(1.6 / m.baseLen);
    const dom = UNITS[v.type].domain;
    m.root.position.y = dom === 'air' ? 0.35 : dom === 'sub' ? -0.01 : 0;
    this.stage.add(m.root);
    const water = this.scene.getObjectByName('water') as THREE.Mesh;
    (water.material as THREE.MeshLambertMaterial).color.setHex(dom === 'land' ? 0x5b6b4a : 0x0f4a63);
    const def = unitDef(v.type, this.faction);
    const full = def.names[this.faction].toUpperCase();
    this.el.querySelector('#nm')!.textContent = full.includes(v.name.toUpperCase()) ? full : `${full} · ${v.name.toUpperCase()}`;
    this.el.querySelector('#ro')!.textContent = def.role;
    const lo = variantLoadout(v, this.faction);
    const st = deriveStats(v.type, this.faction, lo, v);
    const weapons = lo.map((id) => MODULES[id]).filter((m) => m?.proj);
    const maxR = Math.max(0, ...weapons.map((m) => m.range ?? 0));
    const cells: [string, string][] = [
      ['COST', money(unitCost(v.type, this.faction))],
      ['HULL', String(st.hp)],
      ['SPEED', (st.speed * 100).toFixed(0)],
      ['RADAR', st.radarAir || st.radarSurf ? `${Math.round(Math.max(st.radarAir, st.radarSurf))} km` : '—'],
      ['SONAR', st.sonar ? `${Math.round(st.sonar)} km` : '—'],
      ['REACH', `${maxR} km`],
      ['TROOPS', st.hold ? `${st.hold}` : '—'],
      [def.fuel ? 'ENDURANCE' : 'STEALTH', def.fuel ? `${Math.round(st.fuel)} s` : st.quiet < 1 ? `${Math.round((1 - st.quiet) * 100)}%` : '—'],
    ];
    this.el.querySelector('#stats')!.innerHTML = cells.map(([k, val]) => `<div>${k}<b>${val}</b></div>`).join('');
  }

  private renderVariants() {
    const box = this.el.querySelector('#vars')!;
    const def = CLASSES[this.cls];
    box.innerHTML = `<div class="label">${def.name.toUpperCase()} — ${def.role}</div>`;
    def.variants.forEach((v: VariantDef, i: number) => {
      const lo = variantLoadout(v, this.faction);
      const sel = i === this.picked(this.cls);
      // Repeated launchers read as one line: "3× Naval Strike Missile".
      const counts = new Map<string, number>();
      for (const id of lo) if (MODULES[id]) counts.set(id, (counts.get(id) ?? 0) + 1);
      const kit = [...counts]
        .map(([id, n]) => `<div class="w"><span>${n > 1 ? `${n}× ` : ''}${MODULES[id].name}</span>${statLine(MODULES[id])}</div>`)
        .join('');
      const cost = v.type !== def.variants[0].type || this.cls === 'capital' ? ` · ${money(unitCost(v.type, this.faction))}` : '';
      const el = h(`<div class="lo-mod lo-var ${sel ? 'sel' : ''}"><div class="h">${v.name}${cost}<span>${sel ? '✓ IN YOUR FLEET' : i === def.def ? '★ RECOMMENDED' : ''}</span></div><div class="d">${v.desc}</div><div class="kit">${kit}</div></div>`);
      el.addEventListener('mouseenter', () => this.showVariant(i));
      el.addEventListener('mouseleave', () => this.showVariant(this.picked(this.cls)));
      el.addEventListener('click', () => {
        setVariant(this.faction, this.cls, i);
        audio.play('order');
        this.buildList();
        this.renderVariants();
        this.showVariant(i);
      });
      box.appendChild(el);
    });
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
  if (!m.proj) return m.ability ? '<span class="st">ability [M]</span>' : '';
  const dmg = Object.entries(m.dmg ?? {})
    .filter(([, v]) => (v ?? 0) > 1)
    .map(([k, v]) => `${k.toUpperCase()} ${v}`)
    .join(' · ');
  const parts = [m.range ? `${m.range} km` : '', dmg, m.ammo && m.ammo > 0 ? `${m.ammo} rds` : m.ammo === -1 ? '∞' : '', m.intercept ? `intercept ${Math.round(m.intercept * 100)}%` : ''].filter(Boolean);
  return `<span class="st">${parts.join(' · ')}</span>`;
}

// App shell: menu ⇄ lobby ⇄ match. One renderer for everything.
import './ui/style.css';
import { Renderer, CameraRig } from './render/renderer';
import { GameScene } from './render/scene';
import { World } from './state';
import { Match } from './match';
import { LocalConn, OnlineConn, Conn } from './net';
import { titleScreen, skirmishScreen, LobbyScreen, settingsScreen, endScreen, pauseScreen } from './ui/menu';
import { styleProfile } from './training';
import { LoadoutEditor } from './ui/loadout';
import { settings } from './settings';
import { audio } from './audio/sfx';
import { voices } from './audio/voice';
import { getLoadouts } from './loadouts';
import type { ServerMsg, StartInfo } from '../shared/protocol';
import { FACTIONS, Faction } from '../shared/defs';
import { THEMES } from '../shared/map';

const ui = document.getElementById('ui')!;
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const r = new Renderer(canvas);
r.pixelSize = settings.pixel;
r.resize();

let match: Match | null = null;
let conn: Conn | null = null;
let menuScene: { scene: GameScene; rig: CameraRig; world: World } | null = null;
let overlayEl: HTMLElement | null = null;
let lobby: LobbyScreen | null = null;
let paused: HTMLElement | null = null;

function applySettings() {
  if (r.pixelSize !== settings.pixel) {
    r.pixelSize = settings.pixel;
    r.resize();
  }
  audio.volumes = { master: settings.master, sfx: settings.sfx, amb: settings.amb, voice: settings.voice, music: settings.music };
  audio.applyVolumes();
  if (match) match.edgeScroll = settings.edgeScroll;
}
applySettings();
void voices.load();

function clearUi() {
  ui.innerHTML = '';
  overlayEl = null;
  lobby = null;
  paused = null;
}

// ---------- menu background: a quiet archipelago with a slow orbit ----------
function startMenuScene() {
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const info: StartInfo = { seed: (Math.random() * 1e9) | 0, theme, you: 0, players: [] };
  const world = new World(info);
  const scene = new GameScene(r, world);
  const rig = new CameraRig(r.camera);
  rig.flyTo(world.map.size / 2 + 6, world.map.size / 2 + 4);
  rig.setDist(34, true);
  menuScene = { scene, rig, world };
}

/** Training games stored after the last match (0: none recorded). */
let trained = 0;

function showTitle() {
  clearUi();
  if (match) {
    match.dispose();
    match = null;
  }
  conn?.close();
  conn = null;
  if (!menuScene) startMenuScene();
  overlayEl = titleScreen(ui, {
    skirmish: showSkirmish,
    create: createRoom,
    join: joinRoom,
    loadouts: () => {
      overlayEl?.classList.add('hidden');
      new LoadoutEditor(ui, () => overlayEl?.classList.remove('hidden'));
    },
    settings: () => {
      overlayEl?.classList.add('hidden');
      const s = settingsScreen(ui, {
        back: () => {
          s.remove();
          overlayEl?.classList.remove('hidden');
        },
        apply: applySettings,
      });
    },
  });
}

function showSkirmish() {
  overlayEl?.classList.add('hidden');
  const s = skirmishScreen(ui, {
    back: () => {
      s.remove();
      overlayEl?.classList.remove('hidden');
    },
    start: () => {
      s.remove();
      const other: Faction = settings.faction === 'coalition' ? 'union' : 'coalition';
      const bots: { faction: Faction }[] = [];
      for (let i = 0; i < settings.bots; i++) {
        // In 2v2 the AI ally (slot 1) shares your faction.
        const f = settings.teams === '2v2' && i === 1 ? settings.faction : i % 2 === 0 ? other : FACTIONS[Math.floor(Math.random() * 2)];
        bots.push({ faction: f });
      }
      const lc = new LocalConn({
        name: settings.name,
        faction: settings.faction,
        theme: settings.theme,
        bots,
        teams: settings.teams,
        loadouts: getLoadouts(settings.faction),
        record: settings.train,
        style: settings.mimic ? styleProfile(settings.faction) : null,
      });
      trained = 0;
      lc.onRecorded = (n) => (trained = n);
      conn = lc;
      lc.onMessage = onServer;
      lc.start();
    },
  });
}

async function createRoom() {
  try {
    const res = await fetch('/api/room', { method: 'POST' });
    if (!res.ok) throw new Error();
    const { code } = await res.json();
    joinRoom(code);
  } catch {
    const err = document.getElementById('err');
    if (err) err.textContent = 'Could not reach the server. Online play needs the Cloudflare Worker (npm run local).';
    audio.play('deny');
  }
}

function joinRoom(code: string) {
  conn?.close();
  const oc = new OnlineConn(code);
  conn = oc;
  history.replaceState(null, '', `?room=${code}`);
  oc.onMessage = onServer;
  oc.onClose = (reason) => {
    if (match && !match.isEnded) {
      match.hud.banner('CONNECTION LOST', reason);
      setTimeout(showTitle, 2500);
    } else if (lobby) {
      showTitle();
      const err = document.getElementById('err');
      if (err) err.textContent = reason;
    }
  };
  oc.send({ t: 'hello', name: settings.name, faction: settings.faction, loadouts: getLoadouts(settings.faction) });
  clearUi();
  lobby = new LobbyScreen(ui, {
    send: (m) => oc.send(m),
    leave: () => {
      history.replaceState(null, '', location.pathname);
      showTitle();
    },
  });
}

function onServer(m: ServerMsg) {
  switch (m.t) {
    case 'lobby':
      lobby?.update(m.lobby);
      break;
    case 'error':
      if (lobby) lobby.error(m.msg);
      else {
        const err = document.getElementById('err');
        if (err) err.textContent = m.msg;
      }
      break;
    case 'start':
      startMatch(m.info);
      break;
    default:
      match?.onServer(m);
      if (m.t === 'end' && match) {
        const me = match.world.me;
        setTimeout(() => {
          endScreen(
            ui,
            m,
            me,
            {
              menu: () => {
                history.replaceState(null, '', location.pathname);
                showTitle();
              },
            },
            trained,
          );
        }, 1800);
      }
  }
}

function startMatch(info: StartInfo) {
  clearUi();
  if (menuScene) {
    menuScene.scene.dispose();
    menuScene = null;
  }
  if (match) match.dispose();
  match = new Match(r, conn!, info, ui);
  match.edgeScroll = settings.edgeScroll;
  match.onExit = togglePause;
}

function togglePause() {
  if (!match) return;
  if (paused) {
    paused.remove();
    paused = null;
    if (conn?.local) (conn as LocalConn).paused = false;
    return;
  }
  if (conn?.local) (conn as LocalConn).paused = true;
  paused = pauseScreen(ui, !!conn?.local, {
    resume: togglePause,
    help: () => {
      togglePause();
      match?.hud.toggleHelp(true);
    },
    settings: () => {
      paused?.classList.add('hidden');
      const s = settingsScreen(ui, {
        back: () => {
          s.remove();
          paused?.classList.remove('hidden');
        },
        apply: applySettings,
      });
    },
    quit: () => {
      history.replaceState(null, '', location.pathname);
      showTitle();
    },
  });
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && paused) {
    e.stopImmediatePropagation();
    togglePause();
  }
}, true);

window.addEventListener('resize', () => {
  if (!match) r.resize();
});
window.addEventListener('pointerdown', () => audio.unlock(), { once: false });

// ---------- main loop ----------
let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (match) {
    match.frame(dt);
  } else if (menuScene) {
    const { scene, rig, world } = menuScene;
    world.clock += dt;
    rig.rotate(dt * 0.04);
    rig.update(dt, world.map.size, world.clock);
    scene.update(dt, rig);
    r.render(world.clock);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

showTitle();
const q = new URLSearchParams(location.search).get('room');
if (q && q.length >= 4) joinRoom(q.toUpperCase());

// Debug hook for automated screenshots.
(window as any).__salvo = { get match() { return match; }, get conn() { return conn; }, r, audio, voices };

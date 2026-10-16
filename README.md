# Salvo Conquest

A minimalist,a multiplayer, browser-based RTS about near-future littoral combat in an archipelago.
It mixes a casual take on *Sea Power* naval warfare with *WARNO*-style ground and air support,
drawn as pixelated low-poly 3D under a crisp NATO-symbol overlay.

![Fleet engagement](docs/battle.png)

- **Runs on one Cloudflare Worker.** Static client from Workers Static Assets, one Durable Object per room runs the authoritative simulation.
- **Play offline vs AI** in the browser (the same simulation runs locally), or **create a room** and send the link to friends.

## How to play

| Input | Action |
| --- | --- |
| LMB / drag | Select / box select · double-click selects all of a type |
| RMB | Move · attack (on enemy or radar contact) · board (troops on a ship) |
| Ctrl + RMB | Move without stopping to fight |
| WASD / MMB drag / screen edge | Pan · Q/E rotate · wheel zoom |
| U | Unload troops: a ring shows the landing range, click land inside it (every selected ship with troops lands there) |
| C / G / M / R / T / X | Chaff or smoke · radar on/off · drop mines · aircraft return to base · toggle auto-retreat · stop |
| Ctrl+1–9 / 1–9 | Save / recall group (press twice to jump the camera) |
| Tab / V | Show weapon ranges / sensor view (darkens what you cannot see) |
| Space · Enter · F1 · Esc | Jump to last alert · chat (online) · field manual · menu |

**Goal:** capture the enemy **HQ**, or hold 75% of all resource sites for 3 minutes.

- Each player starts on a home island with an HQ, a naval base, an airbase and barracks, and no units.
- **Deployment phase** (like WARNO): the clock stands still for up to 2 minutes while you buy your opening
  force from the build bar and place it inside your deployment zone (ships on open water, troops on the home
  island, aircraft anywhere in the zone). Right-click moves placed units, troops can embark on ships, Del refunds.
  Money you don't spend carries into the battle. The battle starts when every player presses **Launch battle**
  (or the timer runs out).
- **Building:** pick a unit in the build bar, then click the map where it should go (Shift: place several). A ghost
  shows which building will make it (the nearest one that can reach the spot) and stays there until the unit is
  built; then the unit moves out to that spot. Ships can only go to water connected to one of your naval bases or
  dockyards, troops only to an island with one of your barracks; aircraft can be sent anywhere.
- Units are expensive (prices ×3): forces are small and every hull counts. Ships carry few missiles
  (destroyer: 4 anti-ship, 8 SAM) and rearm at a naval base or dockyard, but only while not under attack (no hit in
  the last 15 s and nothing homing on them). Missile batteries (buildings and trucks) fire at half their old rate.
- Ground units capture buildings by standing next to them. Captured **resource sites** spawn merchant
  ships that sail cargo home and turn it into cash. Enemy subs love merchants.
- Other buildings give bonuses: radar stations (huge radar bubble), airbases, barracks and dockyards (forward production, repair, rearm),
  missile batteries (fire for whoever owns them).
- Ships carry troops (destroyer 2, battleship 3; a Troop Bay module adds 2). Carriers carry up to 4 air flights instead: right-click a carrier with aircraft selected to base them there. Aircraft are built at airbases only.
  RMB a ship with troops selected and they walk to the shore and ride landing craft out to it.
- **Ship damage** (like WARNO tank combat): hits can knock out systems, not just hull points. An **engine** hit
  stops the ship dead for 8 s, then leaves it at 55% speed; **steering** jams (quarter turn rate), **radar** drops
  to 35% range, a **weapon** mount goes silent, **fires** and **flooding** keep hurting, and heavy hits **stun** the
  crew (no firing for a few seconds). Torpedoes and mines flood and wreck engines; shells hit mounts; missiles start
  fires. Systems repair over time, three times faster at a friendly naval base. Damaged systems show as tags under
  the unit (DIW, RUD, RAD, WPN, FIRE, FLD, STUN) and in the selection panel with the seconds left.
- **Countermeasures (C):** every warship and air flight carries one load of **chaff**, every ground unit one load of
  **smoke**. Chaff throws a cloud of foil that pulls each enemy missile or SAM homing on the unit off course
  (60% chance each, 40% for hypersonic missiles), while the unit stays within 2.5 km of the cloud (8 s). Smoke hides
  ground units inside it from everything further than 350 m, makes shots already on the way hit less than half as
  often, and keeps laying more smoke behind the unit for 12 s so it can run. Loads refill when the unit rearms.
- **Automation:** ground units attack-move by default, idle troops engage enemies on their island, damaged units
  retreat to friendly buildings and come back when repaired, aircraft fly their mission, return to rearm and
  go back on station. Ships close the distance on their own when you order an unload out of range.

### Ship counters

The navy works as a rock-paper-scissors triangle. Each counter wins its 1-vs-1 duel clearly (tested in 30
duels per pair, both factions):

| Ship | Beats | Loses to | Why |
|---|---|---|---|
| Submarine ($1,140) | Battleship, carrier | Destroyer | Passive sonar hears ships at 1.3× its sonar range, so it finds them first and stays hidden. Heavy torpedoes explode under the keel: ×1.6 damage to battleships and carriers. Those two ships are nearly deaf to subs (sonar 2 km) and have no anti-sub weapons. |
| Destroyer ($1,200) | Submarine | Battleship | Bow and towed sonar (15–18 km) and ASW rockets that reach 11–12 km, further than a sub's 9.5–10 km torpedoes. Towed torpedo decoys halve torpedo hits. |
| Battleship ($2,700) | Destroyer | Submarine | 16 km main guns, a thick hull and its own air defence. Two destroyers (about the same price) are an even fight. |

Escort battleships and carriers with destroyers. Hunt destroyers with battleships and aircraft.

### Sensors and fog of war

![Strategic view with radar contacts, storms and fog](docs/strategic.png)

Radar (surface and air), sonar and eyesight. Sonar is the only way to find submarines; passive sonar also hears
surface ships (a submarine far better than a noisy surface ship). Far-away or poor-quality detections show as a
**radar contact**: one calm marker per track, placed somewhere within the error radius of the true position (the
error shows on hover). As you close in, the estimate glides toward the truth until the contact becomes an identified
track. **Unidentified contacts cannot be targeted**: they mark a position only (right-click there is a move);
once a contact is classified you can attack it. Ground contacts use a square marker, surface contacts a quatrefoil.
The minimap outlines your sensor coverage (surface radar and eyes, air radar, sonar). On the main map, water and land
outside your surface picture are always shaded with a light, hatched veil, with a thin line where coverage ends. Press
**V** (or the SENSORS button above the minimap) for the full sensor view: everything your sensors cannot see goes dark. At most two weather systems are on the map at once. Storms cut radar range and eyesight; fog banks cut eyesight. Submarines are
invisible until a sonar hears them, and they reveal themselves briefly when they fire.

**Radar on/off (G).** Every unit with a radar (warships, AEW, radar trucks) can switch it off. Radar on: you see
far, but enemy electronic support measures (ESM) hear your radar out to 1.5× its range and get a rough,
unidentified position for you (marker only, cannot be targeted). Radar off (tag **DARK**): your unit sees only by
eye (about 6 km) and sonar, and cannot be heard; your team's other sensors still feed it targets. When an enemy
radar is tracking one of your units, a soft amber glow breathes behind its marker and the selection panel shows
**ENEMY RADAR LOCK**.

![Storm cell and fog bank](docs/weather.png)

### Factions

Both sides pay the same price and build time for each unit. There are no special abilities: the factions differ
in **hull stats** and in **which weapons they can fit** (each side has its own missiles, SAMs, guns and torpedoes;
utility kit such as CIWS, ECM, mines, sonar and armour is shared). See `HULLS` and `MODULES` in `src/shared/defs.ts`.

| Unit | Atlantic Coalition (US pattern) | Pacific Union (PLAN / Russian pattern) |
|---|---|---|
| Destroyer | Hull 100, sonar 18 km, air radar 24 km, radar signature 1.0. Mk 45 5-inch (10 km), **NSM** (30 km, stealthy: 30% harder to intercept), **SM-6** (24 km, best interceptor), VL-ASROC (12 km) | Hull 102, sonar 15 km, air radar 22 km, signature 1.15. 130mm gun (12 km), **YJ-18** (31 km, supersonic sprint: 25% harder to intercept), **HQ-9B** (20 km, 10 rounds), CY-5 ASW (11 km) |
| Submarine | Hull 70, quieter hull (noise 80%), sonar 12 km. Mk 48 ADCAP (10 km, wide seeker), Sub Harpoon (24 km) | Hull 75, faster (0.28), sonar 10 km. Yu-6 (9.5 km, bigger warhead), sub-launched YJ-18 (26 km, supersonic) |
| Battleship | Iowa: hull 265, two **16-inch triple turrets** (17 km, never run dry), NSM, SM-6 | Kirov-type: hull 230, faster, better radar. **Heavy anti-ship missiles** (36 km, 55 damage, 3 rounds, hard to stop), AK-130 twin gun (13 km), YJ-18, HQ-9B |
| Carrier | Ford: hull 210, **5 flights** on deck, SM-6 | Hull 200, 4 flights, bigger radar (32 km), HQ-9B |
| Infantry | ACV: hull 60, faster, Javelin (stronger) | ZBD-05: hull 70, slower, HJ-12 (longer reach) |
| Coastal / SAM | NMESIS (NSM, 28 km, stealthy), Patriot PAC-3 (16 km, best vs missiles) | YJ-12 (32 km, supersonic, bigger warhead), HQ-9 (20 km) |
| Fighter | F-22: stealthiest (signature 0.3), faster, AIM-120D (16 km, accurate) | J-20: signature 0.4, PL-15 (20 km, less accurate) |
| Strike | F-35: stealthy (0.35), JSM (12 km, stealthy), guided bombs | J-15: tougher (36), less stealthy (0.7), shorter range, two YJ-83K (24 km) and KD-88 |

Aircraft stealth is real in the sim: radar sees a stealthy jet at down to 0.6× its normal range.

Each side has its own models, after real equipment of the type:

| Unit | Coalition | Union |
|---|---|---|
| Destroyer | Arleigh Burke (four SPY-1 faces, two funnels) | Type 055 (integrated mast, one funnel) |
| Submarine | Virginia (pump-jet, no sail planes) | Type 09x (hull hump, sail planes, X tail) |
| Battleship | Iowa (three triple 16-inch turrets) | Kirov-type strike cruiser (missile hatch grid) |
| Carrier | Ford (catapults, small island aft) | Ski-jump carrier (big island amidships) |
| Infantry | ACV 8x8, theatre camouflage | ZBD-05 tracked amphibious IFV, blue-grey camouflage |
| Coastal / SAM | NMESIS, Patriot | YJ-12 TEL, HQ-9 (upright tubes) |
| Aircraft | F-22, F-35, E-2 Hawkeye | J-20 (canards), J-15 (Flanker), KJ-600 |

### Loadouts

![Loadout editor](docs/loadout.png)

Every unit has slots (deck mount, VLS, torpedo room, auxiliary, hardpoints, pods, arms, kit). Open **Loadouts** from the
menu, pick the faction, and drag modules into slots: e.g. give destroyers **Mine Rails**, swap a VLS for land-attack missiles, add a Troop Bay,
or put sonobuoys on the AEW. The defaults are the recommended fit.

### Theatres

- **Operation Sandglass:** desert, Strait of Hormuz / Eastern Mediterranean
- **Operation Monsoon:** jungle, Spratly Islands / South China Sea (frequent storms)
- **Operation Williwaw:** arctic, Aleutian Islands (frequent fog)

## Voice lines (record your friends!)

Put audio files in `public/audio/voice/` and rebuild. Every line gets a radio filter with squelch clicks.

```
public/audio/voice/<category>/<event>_<n>.mp3            # e.g. naval/select_1.mp3
public/audio/voice/<faction>/<category>/<event>_<n>.mp3  # optional per-faction override (coalition|union)
```

Categories: `naval`, `ground`, `air`. Events and suggested lines are listed in
[`public/audio/voice/README.md`](public/audio/voice/README.md). `npm run build` generates `manifest.json`.
Lines without recordings appear as subtitles in the radio log.

## Development

```bash
npm install
npm run dev        # client only at http://localhost:5173 (skirmish vs AI works)
npm run local      # wrangler dev (builds first): full game incl. online rooms at http://localhost:8787
npm test           # headless bot-vs-bot simulation on all three maps
npm run typecheck
```

## Deploy to Cloudflare from GitHub

**Option A: Workers Builds (no secrets in GitHub).**
In the Cloudflare dashboard, go to *Workers & Pages → Create → Import a repository* and pick this repo.
Keep the default settings:

- Build command: *(empty)*. Do **not** use `npm run dev` or `npm run local`: they start a server that never exits, so the build never finishes.
- Deploy command: `npx wrangler deploy`. It runs `npm run build` itself (see `build` in `wrangler.jsonc`).
- Production branch: the branch you push to.

Every push to the production branch then builds and deploys.
See [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

**Option B: GitHub Actions.** `.github/workflows/deploy.yml` typechecks, runs the simulation test, builds and deploys on
every push to `main`. It is off by default so it does not clash with Option A. To use it:

1. Add repository secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`.
2. Add the repository variable `DEPLOY_WITH_ACTIONS` = `true`.

Durable Objects with the SQLite storage backend are available on the Workers Free plan
([docs](https://developers.cloudflare.com/durable-objects/platform/pricing/)). The room loop uses about 1–3 ms of CPU per
100 ms tick. Clients ping every 2 s, which keeps each Durable Object event well inside the default CPU limit.

## Architecture

```
src/shared/   simulation (runs on the server and in the browser)
  defs.ts       units, modules (weapons/utilities), buildings, factions
  map.ts        procedural 4-fold-symmetric archipelago, nav grid, A* pathfinding
  game.ts       authoritative sim: movement, sensors + fuzzy contacts, combat, capture, economy, transport, weather
  ai.ts         computer opponent
  protocol.ts   messages and compact snapshots
src/server/   Cloudflare Worker + GameRoom Durable Object (lobby, 10 Hz loop, per-player fog-of-war snapshots)
src/client/   Three.js renderer (low-res pass + depth outlines + dither), NATO overlay, HUD, menus, WebAudio synth
```

Fog of war is resolved on the server: clients only receive what their team can detect.

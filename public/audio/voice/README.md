# Voice recordings

Drop audio files here and run `npm run build` (it regenerates `manifest.json`).
Supported: `.mp3 .ogg .wav .m4a .webm`; prefer `.mp3` (every browser decodes it; `.m4a`/AAC fails in some Chromium builds). Air pilots have their own folders: see the main README, "Pilots". Keep each line short (0.5–2 s) and record with a little energy.
The game adds the radio band-pass, light distortion and squelch clicks, so record clean audio.

Naming: `<category>/<event>_<n>.<ext>`. Add as many variants as you like (`_1`, `_2`, …); one is picked at random. The number picks the subtitle: `select_2` shows the second `select` line below.
For a faction-specific voice, put the files under `coalition/` or `union/`, for example `union/naval/select_1.mp3`.

## naval/

| event | example lines |
| --- | --- |
| select | "Bridge, go ahead." · "Captain on deck." · "Standing by." · "Helm ready." |
| move | "Aye, coming about." · "All ahead full." · "Underway." · "Making turns." |
| attack | "Weapons free!" · "Firing solution set." · "Engaging target." · "Birds away!" |
| ready | "Ship commissioned. Ready for tasking." · "New hull in the water." |
| lost | "We've lost the ship!" · "Hull breach, abandon ship!" |
| retreat | "Heavy damage, returning to port!" · "Breaking off!" |
| vampire | "Vampire, vampire!" · "Missiles inbound!" |
| underfire | "Taking fire!" |

## ground/

| event | example lines |
| --- | --- |
| select | "Yes sir?" · "Marines ready." · "Go ahead." · "Awaiting orders." |
| move | "Moving out!" · "Oscar Mike." · "On our way." · "Roger, moving." |
| attack | "Contact front!" · "Engaging!" · "Light them up!" |
| ready | "Company formed up." · "Ready to deploy." |
| lost | "We're overrun!" · "Unit lost." |
| retreat | "Falling back!" · "Pull back, pull back!" |
| board | "Boarding now." · "Mount up!" |
| unload | "Hitting the beach!" · "Boats away!" |
| capture | "Objective secured." · "Site is ours." |

## air/

| event | example lines |
| --- | --- |
| select | "Flight lead here." · "Go ahead, control." · "On frequency." |
| move | "On station shortly." · "Copy, en route." · "Wilco." |
| attack | "Tally, engaging." · "Fox three!" · "Rifle, rifle!" |
| ready | "Wheels up." · "Flight airborne." |
| lost | "I'm hit, ejecting!" · "Flight lost." |
| rtb | "Winchester, RTB." · "Bingo fuel, heading home." |

The subtitle text shown in game comes from `src/client/audio/voice.ts` (`LINES`). Edit it to match what your friends said.

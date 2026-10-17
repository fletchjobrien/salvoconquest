// Training recordings kept in the browser: the last games recorded in training mode, a download
// for sending them on, and the style profile the AI follows when "AI copies my style" is on.
import { deriveProfile, type Recording, type StyleProfile } from '../shared/style';
import type { Faction } from '../shared/defs';

const KEY = 'salvo.training.v1';
/** Keep the last games only; one game is roughly 50-200 KB. */
const MAX_GAMES = 12;

export function loadRecordings(): Recording[] {
  try {
    const xs = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(xs) ? xs : [];
  } catch {
    return [];
  }
}

export function saveRecording(r: Recording): number {
  const all = [...loadRecordings(), r].slice(-MAX_GAMES);
  // Drop the oldest games until it fits the browser's storage.
  while (all.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
      return all.length;
    } catch {
      all.shift();
    }
  }
  return 0;
}

export function clearRecordings() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Download every recording as one JSON file (with the profile derived from them). */
export function downloadRecordings() {
  const recs = loadRecordings();
  const body = JSON.stringify({ kind: 'salvo-training', profile: deriveProfile(recs), games: recs }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = `salvo-training-${new Date().toISOString().slice(0, 10)}-${recs.length}games.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function styleProfile(faction: Faction): StyleProfile | null {
  return deriveProfile(loadRecordings(), faction);
}

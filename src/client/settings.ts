// Persisted player settings.
import type { Faction } from '../shared/defs';
import type { Theme } from '../shared/map';

export interface Settings {
  name: string;
  faction: Faction;
  theme: Theme;
  pixel: number;
  master: number;
  sfx: number;
  music: number;
  voice: number;
  amb: number;
  edgeScroll: boolean;
  bots: number;
  teams: 'ffa' | '2v2';
  /** Training mode: record skirmishes for the AI to learn from. */
  train: boolean;
  /** AI players follow the style learned from recorded games. */
  mimic: boolean;
}

const KEY = 'salvo.settings.v1';
const DEFAULTS: Settings = {
  name: 'COMMANDER',
  faction: 'coalition',
  theme: 'jungle',
  pixel: 3,
  master: 0.8,
  sfx: 0.9,
  music: 0.45,
  voice: 1,
  amb: 0.7,
  edgeScroll: true,
  bots: 1,
  teams: 'ffa',
  train: false,
  mimic: false,
};

export const settings: Settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
})();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

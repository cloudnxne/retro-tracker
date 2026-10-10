import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getSetting, setSetting } from '../db/repo';

export type ThemePref = 'auto' | 'light' | 'dark';

/** Mirror of the Dexie setting, read synchronously by index.html to avoid a flash of the wrong theme. */
const LS_KEY = 'rt-theme';
const META: Record<'light' | 'dark', string> = { light: '#F5F6F8', dark: '#16131A' };

const systemLight = () => window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'auto' ? (systemLight() ? 'light' : 'dark') : pref;
}

export function applyTheme(pref: ThemePref) {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[theme]);
  try {
    localStorage.setItem(LS_KEY, pref);
  } catch {
    /* storage blocked: the Dexie setting is still the source of truth */
  }
}

export async function setThemePref(pref: ThemePref) {
  await setSetting('theme', pref);
  applyTheme(pref);
}

/** Keeps <html data-theme> in sync with the setting and, in Auto, with the phone's setting. */
export function useThemeSync() {
  const pref = useLiveQuery(() => getSetting<ThemePref>('theme', 'auto'), []);
  useEffect(() => {
    if (!pref) return;
    applyTheme(pref);
    if (pref !== 'auto') return;
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    const onChange = () => applyTheme('auto');
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, [pref]);
  return pref ?? 'auto';
}

/** Light/dark theme: persisted per browser, defaulting to the operating system. */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_KEY = 'talentscreen.theme';

/** Browser chrome colour for each palette (matches the shell green). */
const THEME_COLOR: Record<Theme, string> = { light: '#1E4634', dark: '#0C1712' };

export function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The choice this browser remembers, or null when it is still following the OS. */
export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

export function resolveTheme(): Theme {
  const stored = storedTheme();
  if (stored) return stored;
  // The inline script in index.html has normally set this already.
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return systemTheme();
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
}

/** Current theme plus a toggle that pins the choice for this browser. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme());
  const [pinned, setPinned] = useState<boolean>(() => storedTheme() !== null);

  useEffect(() => { applyTheme(theme); }, [theme]);

  // Keep following the operating system until the user chooses for themselves.
  useEffect(() => {
    if (pinned) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pinned]);

  const toggle = useCallback(() => {
    setPinned(true);
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  return { theme, toggle, pinned };
}

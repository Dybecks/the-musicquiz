import { useSyncExternalStore } from 'react';
import { en, type Messages } from './en';
import { sv } from './sv';

/**
 * The site's languages. Every text a player can see lives in en.ts and sv.ts;
 * components read it with `useT()`, other code with `msg()`. TypeScript checks
 * that sv.ts has every text en.ts has, and i18n.test.ts checks that no
 * component or error message has English written straight into it.
 */
export type Lang = 'en' | 'sv';
export type { Messages };

export const LANGS: { id: Lang; label: string; name: string }[] = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'sv', label: 'SV', name: 'Svenska' },
];

const MESSAGES: Record<Lang, Messages> = { en, sv };
const LANG_KEY = 'mq.lang';

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'sv';

/** The saved choice, else the browser's language. Only in a browser: tests run in English. */
function initialLang(): Lang {
  if (typeof document === 'undefined') return 'en';
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* not available */
  }
  const wanted = navigator.languages?.length ? navigator.languages : [navigator.language];
  return wanted.some((l) => /^sv\b/i.test(l ?? '')) ? 'sv' : 'en';
}

let current: Lang = initialLang();
const listeners = new Set<() => void>();

function applyToPage(lang: Lang) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.querySelector('meta[name="description"]')?.setAttribute('content', MESSAGES[lang].app.description);
}
applyToPage(current);

export const getLang = (): Lang => current;

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* not remembered */
  }
  applyToPage(lang);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The texts in the current language, for code outside components (errors, labels). */
export const msg = (): Messages => MESSAGES[current];

/** The current language; the component shows again when it changes. */
export const useLang = (): Lang => useSyncExternalStore(subscribe, getLang, getLang);

/** The texts in the current language; the component shows again when it changes. */
export const useT = (): Messages => MESSAGES[useLang()];

/** For dates and times in the current language. */
export const locale = (): string => (current === 'sv' ? 'sv-SE' : 'en-GB');

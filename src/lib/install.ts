import { useEffect, useState } from 'react';

/**
 * Add to Home Screen.
 * Android/Chrome fires `beforeinstallprompt`, which we hold on to so a button can trigger it later.
 * iOS Safari has no prompt API, so the UI shows a 3-step picture guide instead.
 * When native apps ship (Capacitor, after testing), this becomes "Get the app" store links.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

export type InstallMode = 'installed' | 'prompt' | 'ios-guide' | 'browser-menu';

export function useInstallMode(): { mode: InstallMode; install: () => Promise<boolean> } {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const mode: InstallMode = isStandalone() ? 'installed' : deferred ? 'prompt' : isIOS() ? 'ios-guide' : 'browser-menu';
  const install = async () => {
    if (!deferred) return false;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    listeners.forEach((l) => l());
    return outcome === 'accepted';
  };
  return { mode, install };
}

'use client';

/**
 * The workbench's own keyboard shortcuts: ⌘K (Ctrl+K off the Mac) opens the
 * search, ⌘J (Ctrl+J) starts a new chat. Both are single-modifier chords a page
 * may take (unlike ⌘N/⌘T and Ctrl+N/Ctrl+T, which browsers keep for
 * themselves); Ctrl+J is Chrome's Downloads on Windows and Linux, and the
 * shell's `preventDefault` keeps it for the workbench. The shell listens for them;
 * the rail and the search palette print them, in the platform's own notation.
 */

import { useEffect, useState } from 'react';

export type WorkbenchShortcut = 'search' | 'newChat';

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad/i.test(platform);
}

/** The platform's command modifier, and nothing else of the two. */
function commandOnly(event: KeyboardEvent, mac: boolean): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The letter a key event is for, whatever Shift did to `key`. */
function letterOf(event: KeyboardEvent): string {
  return event.code?.startsWith('Key')
    ? event.code.slice(3).toLowerCase()
    : event.key.toLowerCase();
}

/** ⌘K on the Mac, Ctrl+K elsewhere: the search palette. */
export function isSearchShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (letterOf(event) !== 'k' || event.altKey || event.shiftKey) return false;
  return commandOnly(event, mac);
}

/** ⌘J on the Mac, Ctrl+J elsewhere: a new chat. */
export function isNewChatShortcut(event: KeyboardEvent, mac: boolean): boolean {
  if (letterOf(event) !== 'j' || event.altKey || event.shiftKey) return false;
  return commandOnly(event, mac);
}

export interface ShortcutLabel {
  /** As printed beside the control; empty until the platform is known. */
  readonly label: string;
  /** For `aria-keyshortcuts`. */
  readonly aria: string;
}

export function shortcutLabel(shortcut: WorkbenchShortcut, mac: boolean | null): ShortcutLabel {
  if (shortcut === 'search') {
    if (mac === null) return { label: '', aria: 'Control+K' };
    return mac ? { label: '⌘K', aria: 'Meta+K' } : { label: 'Ctrl K', aria: 'Control+K' };
  }
  if (mac === null) return { label: '', aria: 'Control+J' };
  return mac ? { label: '⌘J', aria: 'Meta+J' } : { label: 'Ctrl J', aria: 'Control+J' };
}

/**
 * Whether this is a Mac, read after mount: the server cannot know the
 * platform, and the first client paint must match what it sent.
 */
export function useIsMac(): boolean | null {
  const [mac, setMac] = useState<boolean | null>(null);
  useEffect(() => {
    setMac(isMacPlatform()); // eslint-disable-line react-hooks/set-state-in-effect -- platform is known only on the client
  }, []);
  return mac;
}

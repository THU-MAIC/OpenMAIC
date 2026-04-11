/**
 * Widget iframe messaging store.
 * Tracks the current interactive widget's iframe for postMessage communication.
 */

import { create } from 'zustand';

interface WidgetIframeState {
  /** Callback to send messages to the widget iframe */
  sendMessage: ((type: string, payload: Record<string, unknown>) => void) | null;
  /** Register the iframe messaging callback (called by InteractiveRenderer) */
  registerIframe: (callback: ((type: string, payload: Record<string, unknown>) => void) | null) => void;
}

export const useWidgetIframeStore = create<WidgetIframeState>((set) => ({
  sendMessage: null,
  registerIframe: (callback) => set({ sendMessage: callback }),
}));
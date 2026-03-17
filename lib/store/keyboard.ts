import { create } from 'zustand';

export interface KeyboardState {
  ctrlKeyState: boolean;
  shiftKeyState: boolean;
  spaceKeyState: boolean;

  // Getters
  ctrlOrShiftKeyActive: () => boolean;

  // Actions
  setCtrlKeyState: (active: boolean) => void;
  setShiftKeyState: (active: boolean) => void;
  setSpaceKeyState: (active: boolean) => void;
}

export const useKeyboardStore = create<KeyboardState>((set, get) => ({
  // Initial state
  ctrlKeyState: false, // Ctrl key pressed state
  shiftKeyState: false, // Shift key pressed state
  spaceKeyState: false, // Space key pressed state

  // Getters
  ctrlOrShiftKeyActive: () => {
    const state = get();
    return state.ctrlKeyState || state.shiftKeyState;
  },

  // Actions
  setCtrlKeyState: (active) => set({ ctrlKeyState: active }),
  setShiftKeyState: (active) => set({ shiftKeyState: active }),
  setSpaceKeyState: (active) => set({ spaceKeyState: active }),
}));

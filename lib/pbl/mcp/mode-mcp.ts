/**
 * Mode MCP - Controls the current workflow mode during PBL generation.
 *
 * Migrated from PBL-Nano. Simplified: no list_tools(), pure method calls.
 */

import type { PBLMode, PBLToolResult } from '../types';

export class ModeMCP {
  private currentMode: PBLMode;
  private availableModes: PBLMode[];

  constructor(availableModes: PBLMode[], defaultMode: PBLMode) {
    this.availableModes = availableModes;
    this.currentMode = defaultMode;
  }

  setMode(mode: PBLMode): PBLToolResult {
    if (!this.availableModes.includes(mode)) {
      return {
        success: false,
        error: `Mode "${mode}" not available. Available: ${this.availableModes.join(', ')}`,
      };
    }
    if (mode === this.currentMode) {
      return { success: false, error: `Already in "${mode}" mode.` };
    }
    this.currentMode = mode;
    return { success: true, message: `Switched to "${mode}" mode.` };
  }

  getCurrentMode(): PBLMode {
    return this.currentMode;
  }

  getAvailableModes(): PBLMode[] {
    return [...this.availableModes];
  }
}

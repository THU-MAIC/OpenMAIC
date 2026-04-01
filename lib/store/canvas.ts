import { create } from 'zustand';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { TextAttrs } from '@/lib/prosemirror/utils';
import { defaultRichTextAttrs } from '@/lib/prosemirror/utils';
import type { TextFormatPainter, ShapeFormatPainter, CreatingElement } from '@/lib/types/edit';
import type { PercentageGeometry } from '@/lib/types/action';

/**
 * Spotlight options
 */
export interface SpotlightOptions {
  radius?: number; // Spotlight radius (pixels)
  dimness?: number; // Background dimming level (0-1)
  transition?: number; // Transition animation duration (milliseconds)
}

/**
 * Highlight overlay options
 */
export interface HighlightOverlayOptions {
  color?: string; // Highlight color
  opacity?: number; // Highlight opacity (0-1)
  borderWidth?: number; // Border width
  animated?: boolean; // Whether to animate
}

/**
 * Laser pointer options
 */
export interface LaserOptions {
  color?: string; // Laser pointer color, default red
  duration?: number; // Duration (milliseconds)
}

/**
 * Canvas Store - Manages all UI state of the Canvas editor
 *
 * Responsibilities:
 * - Element selection state (selected, handling, editing)
 * - Canvas viewport state (zoom, drag, ruler, grid)
 * - Toolbar and panel state
 * - Element being created
 * - Rich text editing state
 * - Format painter state
 *
 * Note: Does not manage slide data (elements, background, etc.), which is managed by Scene Context
 */

// ==================== Store Interface ====================

interface CanvasState {
  // ===== Element selection state =====
  activeElementIdList: string[]; // Currently selected element IDs
  handleElementId: string; // Element being operated (drag, resize, etc.)
  activeGroupElementId: string; // Selected child element within a group
  editingElementId: string; // Element being edited (e.g., text editing)
  hiddenElementIdList: string[]; // Hidden element IDs

  // ===== Teaching feature state =====
  spotlightElementId: string; // Element focused by spotlight
  spotlightOptions: SpotlightOptions | null; // Spotlight configuration
  spotlightMode: 'pixel' | 'percentage'; // Spotlight mode: pixel or percentage
  spotlightPercentageGeometry: PercentageGeometry | null; // Percentage mode geometry info
  highlightedElementIds: string[]; // Highlighted element IDs
  highlightOptions: HighlightOverlayOptions | null; // Highlight configuration
  laserElementId: string; // Element focused by laser pointer
  laserOptions: LaserOptions | null; // Laser pointer configuration
  zoomTarget: { elementId: string; scale: number } | null; // Zoom target

  // ===== Canvas viewport state =====
  canvasScale: number; // Canvas actual zoom scale
  canvasPercentage: number; // Canvas percentage (used to calculate canvasScale)
  viewportSize: number; // Viewport width base (default 1000px)
  viewportRatio: number; // Viewport aspect ratio (default 0.5625, i.e. 16:9)
  canvasDragged: boolean; // Whether canvas is being dragged

  // ===== Display aids =====
  showRuler: boolean; // Show ruler
  gridLineSize: number; // Grid line size (0 means hidden)

  // ===== Toolbar and panels =====
  toolbarState: 'design' | 'ai' | 'elAnimation'; // Right toolbar state
  showSelectPanel: boolean; // Selection panel
  showSearchPanel: boolean; // Find and replace panel

  // ===== Element creation =====
  creatingElement: CreatingElement | null; // Element being created (needs draw-to-insert)
  creatingCustomShape: boolean; // Drawing custom shape (arbitrary polygon)

  // ===== Editing state =====
  isScaling: boolean; // Element scaling in progress
  clipingImageElementId: string; // Image being cropped
  richTextAttrs: TextAttrs; // Rich text editing state

  // ===== Format painter =====
  textFormatPainter: TextFormatPainter | null; // Text format painter
  shapeFormatPainter: ShapeFormatPainter | null; // Shape format painter

  // ===== Video playback =====
  playingVideoElementId: string; // Video element currently playing

  // ===== Whiteboard =====
  whiteboardOpen: boolean; // Whether whiteboard is open
  whiteboardClearing: boolean; // Whiteboard clear animation in progress

  // ===== Other =====
  thumbnailsFocus: boolean; // Whether left thumbnail area is focused
  editorAreaFocus: boolean; // Whether editor area is focused
  disableHotkeys: boolean; // Whether hotkeys are disabled
  selectedTableCells: string[]; // Selected table cells

  // ===== Actions =====

  // ----- Element selection -----
  setActiveElementIdList: (ids: string[]) => void;
  setHandleElementId: (id: string) => void;
  setActiveGroupElementId: (id: string) => void;
  setEditingElementId: (id: string) => void;
  setHiddenElementIdList: (ids: string[]) => void;
  clearSelection: () => void; // Clear all selections

  // ----- Canvas viewport -----
  setCanvasScale: (scale: number) => void;
  setCanvasPercentage: (percentage: number) => void;
  setViewportSize: (size: number) => void;
  setViewportRatio: (ratio: number) => void;
  setCanvasDragged: (dragged: boolean) => void;

  // ----- Display aids -----
  setRulerState: (show: boolean) => void;
  setGridLineSize: (size: number) => void;

  // ----- Toolbar and panels -----
  setToolbarState: (state: 'design' | 'ai') => void;
  setSelectPanelState: (show: boolean) => void;
  setSearchPanelState: (show: boolean) => void;

  // ----- Element creation -----
  setCreatingElement: (element: CreatingElement | null) => void;
  setCreatingCustomShapeState: (creating: boolean) => void;

  // ----- Editing state -----
  setScalingState: (isScaling: boolean) => void;
  setClipingImageElementId: (id: string) => void;
  setRichtextAttrs: (attrs: TextAttrs) => void;

  // ----- Format painter -----
  setTextFormatPainter: (painter: TextFormatPainter | null) => void;
  setShapeFormatPainter: (painter: ShapeFormatPainter | null) => void;

  // ----- Video playback -----
  playVideo: (elementId: string) => void;
  pauseVideo: () => void;

  // ----- Whiteboard -----
  setWhiteboardOpen: (open: boolean) => void;
  setWhiteboardClearing: (clearing: boolean) => void;

  // ----- Other -----
  setThumbnailsFocus: (focus: boolean) => void;
  setEditorAreaFocus: (focus: boolean) => void;
  setDisableHotkeysState: (disable: boolean) => void;
  setSelectedTableCells: (cells: string[]) => void;

  // ----- Teaching features -----
  setSpotlight: (elementId: string, options?: SpotlightOptions) => void;
  clearSpotlight: () => void;
  setSpotlightPercentage: (
    elementId: string,
    geometry: PercentageGeometry,
    options?: SpotlightOptions,
  ) => void;
  setHighlight: (elementIds: string[], options?: HighlightOverlayOptions) => void;
  clearHighlight: () => void;
  setLaser: (elementId: string, options?: LaserOptions) => void;
  clearLaser: () => void;
  setZoom: (elementId: string, scale: number) => void;
  clearZoom: () => void;
  clearAllEffects: () => void;

  // ----- Batch operations -----
  resetCanvasState: () => void; // Reset Canvas state (used when switching scenes)
}

// ==================== Initial State ====================

const initialState = {
  // Element selection
  activeElementIdList: [],
  handleElementId: '',
  activeGroupElementId: '',
  editingElementId: '',
  hiddenElementIdList: [],

  // Canvas viewport
  canvasScale: 1,
  canvasPercentage: 90,
  viewportSize: 1000,
  viewportRatio: 0.5625, // 16:9
  canvasDragged: false,

  // Display aids
  showRuler: false,
  gridLineSize: 0,

  // Toolbar and panels
  toolbarState: 'ai' as const,
  showSelectPanel: false,
  showSearchPanel: false,

  // Element creation
  creatingElement: null,
  creatingCustomShape: false,

  // Editing state
  isScaling: false,
  clipingImageElementId: '',
  richTextAttrs: defaultRichTextAttrs,

  // Format painter
  textFormatPainter: null,
  shapeFormatPainter: null,

  // Video playback
  playingVideoElementId: '',

  // Whiteboard
  whiteboardOpen: false,
  whiteboardClearing: false,

  // Other: false,
  editorAreaFocus: false,
  thumbnailsFocus: false,
  disableHotkeys: false,
  selectedTableCells: [],

  // Teaching features
  spotlightElementId: '',
  spotlightOptions: null,
  spotlightMode: 'pixel' as const,
  spotlightPercentageGeometry: null,
  highlightedElementIds: [],
  highlightOptions: null,
  laserElementId: '',
  laserOptions: null,
  zoomTarget: null,
};

// ==================== Store Implementation ====================

const useCanvasStoreBase = create<CanvasState>((set, get) => ({
  ...initialState,

  // ===== Element Selection Actions =====

  setActiveElementIdList: (ids) => {
    set({ activeElementIdList: ids });
    // Auto-set handleElementId: set to that element for single select, empty for multi-select or none
    if (ids.length === 1) {
      set({ handleElementId: ids[0] });
    } else if (ids.length === 0) {
      set({ handleElementId: '' });
    }
    // Auto-switch to design panel when elements are selected
    if (ids.length > 0) {
      set({ toolbarState: 'design' });
    }
  },

  setHandleElementId: (id) => set({ handleElementId: id }),

  setActiveGroupElementId: (id) => set({ activeGroupElementId: id }),

  setEditingElementId: (id) => set({ editingElementId: id }),

  setHiddenElementIdList: (ids) => set({ hiddenElementIdList: ids }),

  clearSelection: () => {
    set({
      activeElementIdList: [],
      handleElementId: '',
      activeGroupElementId: '',
      editingElementId: '',
    });
  },

  // ===== Canvas Viewport Actions =====

  setCanvasScale: (scale) => set({ canvasScale: scale }),

  setCanvasPercentage: (percentage) => set({ canvasPercentage: percentage }),

  setViewportSize: (size) => set({ viewportSize: size }),

  setViewportRatio: (ratio) => set({ viewportRatio: ratio }),

  setCanvasDragged: (dragged) => set({ canvasDragged: dragged }),

  // ===== Display Aids Actions =====

  setRulerState: (show) => set({ showRuler: show }),

  setGridLineSize: (size) => set({ gridLineSize: size }),

  // ===== Toolbar and Panel Actions =====

  setToolbarState: (toolbarState) => set({ toolbarState }),

  setSelectPanelState: (show) => set({ showSelectPanel: show }),

  setSearchPanelState: (show) => set({ showSearchPanel: show }),

  // ===== Element Creation Actions =====

  setCreatingElement: (element) => set({ creatingElement: element }),

  setCreatingCustomShapeState: (creating) => set({ creatingCustomShape: creating }),

  // ===== Editing State Actions =====

  setScalingState: (isScaling) => set({ isScaling }),

  setClipingImageElementId: (id) => set({ clipingImageElementId: id }),

  setRichtextAttrs: (attrs) => set({ richTextAttrs: attrs }),

  // ===== Format Painter Actions =====

  setTextFormatPainter: (painter) => set({ textFormatPainter: painter }),

  setShapeFormatPainter: (painter) => set({ shapeFormatPainter: painter }),

  // ===== Video Playback Actions =====

  playVideo: (elementId) => set({ playingVideoElementId: elementId }),

  pauseVideo: () => set({ playingVideoElementId: '' }),

  // ===== Whiteboard Actions =====

  setWhiteboardOpen: (open) => set({ whiteboardOpen: open }),
  setWhiteboardClearing: (clearing) => set({ whiteboardClearing: clearing }),

  // ===== Other Actions =====

  setThumbnailsFocus: (focus) => set({ thumbnailsFocus: focus }),

  setEditorAreaFocus: (focus) => set({ editorAreaFocus: focus }),

  setDisableHotkeysState: (disable) => set({ disableHotkeys: disable }),

  setSelectedTableCells: (cells) => set({ selectedTableCells: cells }),

  // ===== Teaching Feature Actions =====

  setSpotlight: (elementId, options = {}) => {
    set({
      spotlightElementId: elementId,
      spotlightMode: 'pixel',
      spotlightOptions: {
        radius: 200,
        dimness: 0.7,
        transition: 300,
        ...options,
      },
      spotlightPercentageGeometry: null,
    });
  },

  setSpotlightPercentage: (elementId, geometry, options = {}) => {
    set({
      spotlightElementId: elementId,
      spotlightMode: 'percentage',
      spotlightPercentageGeometry: geometry,
      spotlightOptions: {
        dimness: 0.7,
        transition: 300,
        ...options,
      },
    });
  },

  clearSpotlight: () => {
    set({
      spotlightElementId: '',
      spotlightOptions: null,
      spotlightMode: 'pixel',
      spotlightPercentageGeometry: null,
    });
  },

  setHighlight: (elementIds, options = {}) => {
    set({
      highlightedElementIds: elementIds,
      highlightOptions: {
        color: '#ff6b6b',
        opacity: 0.3,
        borderWidth: 3,
        animated: true,
        ...options,
      },
    });
  },

  clearHighlight: () => {
    set({
      highlightedElementIds: [],
      highlightOptions: null,
    });
  },

  setLaser: (elementId, options = {}) => {
    set({
      laserElementId: elementId,
      laserOptions: {
        color: '#ff0000',
        duration: 3000,
        ...options,
      },
    });
  },

  clearLaser: () => {
    set({
      laserElementId: '',
      laserOptions: null,
    });
  },

  setZoom: (elementId, scale) => {
    set({
      zoomTarget: { elementId, scale },
    });
  },

  clearZoom: () => {
    set({
      zoomTarget: null,
    });
  },

  clearAllEffects: () => {
    set({
      spotlightElementId: '',
      spotlightOptions: null,
      spotlightMode: 'pixel',
      spotlightPercentageGeometry: null,
      highlightedElementIds: [],
      highlightOptions: null,
      laserElementId: '',
      laserOptions: null,
      zoomTarget: null,
      // Note: playingVideoElementId intentionally NOT cleared here.
      // Video playback has its own lifecycle (playVideo/pauseVideo/onEnded)
      // and must not be interrupted by visual effect auto-clear timers.
    });
  },

  // ===== Batch Operations =====

  resetCanvasState: () => {
    set({
      ...initialState,
      // Preserve viewport settings
      viewportSize: get().viewportSize,
      viewportRatio: get().viewportRatio,
    });
  },
}));

// Enhance store with selectors, supporting store.use.xxx() syntax
export const useCanvasStore = createSelectors(useCanvasStoreBase);

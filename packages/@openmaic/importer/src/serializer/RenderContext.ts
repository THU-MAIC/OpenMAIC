/**
 * Render context — provides resolved theme/master/layout chain for a given slide.
 */

import { PresentationData } from '../model/Presentation';
import { SlideData } from '../model/Slide';
import { ThemeData } from '../model/Theme';
import { MasterData } from '../model/Master';
import { LayoutData } from '../model/Layout';
import { SafeXmlNode } from '../parser/XmlParser';

export type MediaMode = 'base64' | 'blob';

export interface RenderContext {
  presentation: PresentationData;
  slide: SlideData;
  theme: ThemeData;
  master: MasterData;
  layout: LayoutData;
  /** Package path to current slide layout XML, e.g. `ppt/slideLayouts/slideLayout3.xml`. Used for placeholder fill inheritance. */
  layoutPath: string;
  /** Package path to slide master XML, e.g. `ppt/slideMasters/slideMaster1.xml`. */
  masterPath: string;
  mediaUrlCache: Map<string, string>; // path -> blob URL
  colorCache: Map<string, { color: string; alpha: number }>;
  /** Fill node from parent group's grpSpPr, used to resolve `a:grpFill` in children. */
  groupFillNode?: SafeXmlNode;
  /**
   * 'base64' — embed media as data URLs (default, portable JSON).
   * 'blob'   — use blob URLs (shorter JSON, browser-only, good for development).
   */
  mediaMode: MediaMode;
  /**
   * Navigation callback for shape-level hyperlink actions (action buttons, clickable shapes).
   * Called with target slide index (0-based) for `ppaction://hlinksldjump`,
   * or with a URL string for external links.
   */
  onNavigate?: (target: { slideIndex?: number; url?: string }) => void;
}

export function createRenderContext(
  presentation: PresentationData,
  slide: SlideData,
  mediaUrlCache?: Map<string, string>,
  mediaMode: MediaMode = 'base64',
): RenderContext {
  // Resolve the chain: slide -> layout -> master -> theme
  const layoutPath = presentation.slideToLayout.get(slide.index) || '';
  const masterPath = presentation.layoutToMaster.get(layoutPath) || '';
  const themePath = presentation.masterToTheme.get(masterPath) || '';

  const layout: LayoutData =
    presentation.layouts.get(layoutPath) ||
    ({
      placeholders: [],
      spTree: new SafeXmlNode(null),
      rels: new Map(),
      showMasterSp: true,
    } as unknown as LayoutData);

  const master: MasterData =
    presentation.masters.get(masterPath) ||
    ({
      colorMap: new Map(),
      textStyles: {},
      placeholders: [],
      spTree: new SafeXmlNode(null),
      rels: new Map(),
    } as unknown as MasterData);

  const theme: ThemeData = presentation.themes.get(themePath) || {
    colorScheme: new Map(),
    majorFont: { latin: 'Calibri', ea: '', cs: '', hans: '' },
    minorFont: { latin: 'Calibri', ea: '', cs: '', hans: '' },
    fillStyles: [],
    lineStyles: [],
    effectStyles: [],
  };

  return {
    presentation,
    slide,
    theme,
    master,
    layout,
    layoutPath,
    masterPath,
    mediaUrlCache: mediaUrlCache ?? new Map(),
    colorCache: new Map(),
    mediaMode,
  };
}

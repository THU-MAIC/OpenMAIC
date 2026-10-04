/**
 * The layout of the course model map: stations on a fixed canvas, each
 * holding one or more slots. The course pipeline runs left to right on the
 * first row and right to left on the second (a serpentine flow), with the
 * `llm` root above the stations that inherit from it. The positions are
 * design coordinates; the canvas scales them to fit.
 *
 * The station table names slots; a slot the view does not list is left out,
 * and a visible slot no station names is drawn in an extra row, so a slot
 * added to the registry still shows up.
 */
import type { ModelSettingsView, SlotView } from './client';

export const CANVAS_WIDTH = 1140;
export const NODE_WIDTH = 196;
export const ROOT_WIDTH = 260;
export const CHILD_WIDTH = 160;
export const CHILD_GAP = 16;
const PITCH = 222;
export const ROW_1 = 240;
export const ROW_2 = 440;
const col1 = (index: number) => index * PITCH + PITCH / 2;
const col2 = (index: number) => index * PITCH;

export interface StationLine {
  slot: string;
  /** A short label before the value, for stations with more than one slot. */
  labelKey?: string;
  /** Media and tool slots can be switched off from the card. */
  toggle?: boolean;
}

export interface StationDef {
  id: string;
  kind: 'root' | 'station' | 'aside';
  x: number;
  y: number;
  /** Row in the flow: 1 runs left to right, 2 right to left. */
  row?: 1 | 2;
  /** i18n key segment under `stations.`; absent: named after its first slot. */
  labelKey?: string;
  lines: StationLine[];
  /** A station whose slot has children drawn below it when expanded. */
  expandable?: boolean;
}

export const STATIONS: readonly StationDef[] = [
  { id: 'llm', kind: 'root', x: 440, y: 24, lines: [{ slot: 'llm' }] },
  { id: 'agent', kind: 'aside', x: 0, y: 40, lines: [{ slot: 'agent' }] },
  { id: 'asr', kind: 'aside', x: 944, y: 40, lines: [{ slot: 'asr', toggle: true }] },
  { id: 'document', kind: 'station', row: 1, x: col1(0), y: ROW_1, lines: [{ slot: 'document' }] },
  {
    id: 'research',
    kind: 'station',
    row: 1,
    x: col1(1),
    y: ROW_1,
    labelKey: 'research',
    lines: [
      { slot: 'course.research', labelKey: 'rewrite' },
      { slot: 'webSearch', labelKey: 'search', toggle: true },
    ],
  },
  {
    id: 'outline',
    kind: 'station',
    row: 1,
    x: col1(2),
    y: ROW_1,
    lines: [{ slot: 'course.outline' }],
  },
  {
    id: 'agents',
    kind: 'station',
    row: 1,
    x: col1(3),
    y: ROW_1,
    lines: [{ slot: 'course.agents' }],
  },
  {
    id: 'content',
    kind: 'station',
    row: 2,
    x: col2(4),
    y: ROW_2,
    lines: [{ slot: 'course.content' }],
    expandable: true,
  },
  {
    id: 'actions',
    kind: 'station',
    row: 2,
    x: col2(3),
    y: ROW_2,
    lines: [{ slot: 'course.actions' }],
  },
  {
    id: 'tts',
    kind: 'station',
    row: 2,
    x: col2(2),
    y: ROW_2,
    lines: [{ slot: 'tts', toggle: true }],
  },
  {
    id: 'media',
    kind: 'station',
    row: 2,
    x: col2(1),
    y: ROW_2,
    labelKey: 'media',
    lines: [
      { slot: 'image', labelKey: 'image', toggle: true },
      { slot: 'video', labelKey: 'video', toggle: true },
    ],
  },
  {
    id: 'classroom',
    kind: 'station',
    row: 2,
    x: col2(0),
    y: ROW_2,
    lines: [{ slot: 'classroom' }],
  },
];

/** The pipeline order the flow arrows follow. */
export const FLOW = [
  'document',
  'research',
  'outline',
  'agents',
  'content',
  'actions',
  'tts',
  'media',
  'classroom',
] as const;

/** Stations generated once per page: drawn inside one band. */
export const PER_PAGE = ['content', 'actions', 'tts', 'media'] as const;

export interface PlacedStation extends Omit<StationDef, 'lines'> {
  lines: (StationLine & { view: SlotView })[];
  /** Children of an expandable station's slot (the page types). */
  children: SlotView[];
}

/**
 * The stations to draw for a view: lines for slots the view lists and does
 * not reserve for configuration files, and any visible slot no station names
 * (placed in a row below the flow).
 */
export function placeStations(view: ModelSettingsView): PlacedStation[] {
  const visible = new Map<string, SlotView>(
    view.slots.filter((slot) => !slot.configOnly).map((slot) => [slot.slot, slot]),
  );
  const placed = new Set<string>();
  const stations: PlacedStation[] = [];
  for (const def of STATIONS) {
    const lines = def.lines.flatMap((line) => {
      const slot = visible.get(line.slot);
      return slot ? [{ ...line, view: slot }] : [];
    });
    if (!lines.length) continue;
    for (const line of lines) placed.add(line.slot);
    const children = def.expandable
      ? [...visible.values()].filter((slot) => slot.parent === lines[0].slot)
      : [];
    for (const child of children) placed.add(child.slot);
    stations.push({ ...def, lines, children });
  }
  const rest = [...visible.values()].filter((slot) => !placed.has(slot.slot));
  rest.forEach((slot, index) => {
    stations.push({
      id: `extra:${slot.slot}`,
      kind: 'aside',
      x: col2(index % 5),
      y: ROW_2 + 360 + Math.floor(index / 5) * 130,
      lines: [{ slot: slot.slot, view: slot }],
      children: [],
    });
  });
  return stations;
}

/** How the edge from a parent to a slot is drawn. */
export function edgeKind(slot: SlotView): 'inherit' | 'detached' | 'none' {
  const effective = slot.effective;
  if (effective.status === 'assigned' && effective.resolvedAt !== slot.slot) return 'inherit';
  if (effective.status === 'unassigned' || effective.status === 'invalid') {
    return slot.assignment === undefined && !slot.locked ? 'none' : 'detached';
  }
  return 'detached';
}

/** Whether any slot of a station resolves to a model. */
export function stationLit(station: PlacedStation): boolean {
  return [...station.lines.map((line) => line.view), ...station.children].some(
    (slot) => slot.effective.status === 'assigned',
  );
}

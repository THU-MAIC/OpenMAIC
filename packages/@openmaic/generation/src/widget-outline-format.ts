import type { SceneOutline, WidgetOutline, WidgetType, WidgetVariable } from './outline-types.js';

/**
 * Widget outlines arrive as open objects: agent tools accept any plain object,
 * so variables are often `{ name, range, unit, ... }` records rather than bare
 * strings, and outlines carry fields (controls, readouts, ...) that no widget
 * prompt has a dedicated slot for. These helpers turn that data into readable
 * prompt text instead of `[object Object]` or silently dropping it.
 */

/** Widget outline keys each widget prompt already renders through its own slot. */
const CONSUMED_WIDGET_OUTLINE_KEYS: Record<WidgetType, readonly string[]> = {
  simulation: ['concept', 'keyVariables', 'designIdea'],
  diagram: ['diagramType', 'nodeCount', 'nodes'],
  code: ['language'],
  game: ['gameType'],
  visualization3d: ['visualizationType', 'objects', 'interactions'],
  'procedural-skill': [
    'procedureType',
    'task',
    'concept',
    'tools',
    'steps',
    'successCriteria',
    'errorConsequences',
  ],
};

const NAME_KEYS = ['name', 'label', 'title', 'id', 'variable', 'key'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.every(isBlank);
  if (isRecord(value)) return Object.values(value).every(isBlank);
  return false;
}

function formatRange(range: unknown): string | null {
  if (Array.isArray(range) && range.length === 2 && range.every(isPrimitive)) {
    return `${range[0]}–${range[1]}`;
  }
  if (isRecord(range) && isPrimitive(range.min) && isPrimitive(range.max)) {
    // Keep other constraints (step, default, ...) next to the bounds.
    const extras = Object.entries(range)
      .filter(([key, value]) => key !== 'min' && key !== 'max' && !isBlank(value))
      .map(([key, value]) => `${key}: ${compactValue(value)}`);
    return [`${range.min}–${range.max}`, ...extras].join(', ');
  }
  return null;
}

/** Compact single-line text for a nested value. */
function compactValue(value: unknown): string {
  if (isPrimitive(value)) return String(value).trim();
  if (Array.isArray(value)) {
    const items = value.filter((item) => !isBlank(item));
    if (items.every(isPrimitive)) return items.map((item) => String(item).trim()).join(', ');
    if (items.every(isRecord)) return items.map(formatNamedRecord).join('; ');
    return JSON.stringify(items);
  }
  if (isRecord(value)) return formatNamedRecord(value);
  return '';
}

/**
 * Format a record as `name (detail, detail, key: value)`, e.g.
 * `{ name: 'angle', range: [0, 90], unit: 'deg' }` -> `angle (0–90, deg)`.
 */
function formatNamedRecord(record: Record<string, unknown>): string {
  const nameKey = NAME_KEYS.find((key) => isPrimitive(record[key]) && !isBlank(record[key]));
  const name = nameKey ? String(record[nameKey]).trim() : '';
  const used = new Set<string>(nameKey ? [nameKey] : []);
  const details: string[] = [];

  const range = formatRange(record.range);
  if (range) {
    details.push(range);
    used.add('range');
  } else if (record.range === undefined && isPrimitive(record.min) && isPrimitive(record.max)) {
    details.push(`${record.min}–${record.max}`);
    used.add('min');
    used.add('max');
  }
  if (isPrimitive(record.unit) && !isBlank(record.unit)) {
    details.push(String(record.unit).trim());
    used.add('unit');
  }
  for (const [key, value] of Object.entries(record)) {
    if (used.has(key) || isBlank(value)) continue;
    const text = compactValue(value);
    if (text) details.push(`${key}: ${text}`);
  }

  if (!name) return details.join(', ');
  return details.length > 0 ? `${name} (${details.join(', ')})` : name;
}

/** Render one simulation variable, accepting both plain strings and records. */
export function formatWidgetVariable(variable: string | WidgetVariable | unknown): string {
  if (isPrimitive(variable)) return String(variable).trim();
  if (isRecord(variable)) return formatNamedRecord(variable);
  return '';
}

/** Render the simulation `keyVariables` list as one readable line. */
export function formatWidgetVariables(variables: WidgetOutline['keyVariables'] | unknown): string {
  if (isPrimitive(variables)) return String(variables).trim();
  if (!Array.isArray(variables)) return '';
  return variables
    .map(formatWidgetVariable)
    .filter((text) => text !== '')
    .join(', ');
}

function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatRequirement(key: string, value: unknown): string {
  const label = humanizeKey(key);
  if (Array.isArray(value)) {
    const items = value.filter((item) => !isBlank(item)).map(compactValue);
    return [`- ${label}:`, ...items.map((item) => `  - ${item}`)].join('\n');
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => !isBlank(entry));
    return [
      `- ${label}:`,
      ...entries.map(([entryKey, entry]) => `  - ${entryKey}: ${compactValue(entry)}`),
    ].join('\n');
  }
  return `- ${label}: ${compactValue(value)}`;
}

/** The design idea for a widget: widget outline first, then the legacy config. */
export function resolveWidgetDesignIdea(outline: SceneOutline): string {
  const fromWidget = outline.widgetOutline?.designIdea;
  if (typeof fromWidget === 'string' && fromWidget.trim()) return fromWidget.trim();
  return outline.interactiveConfig?.designIdea?.trim() || '';
}

/**
 * Bullet list of widget outline fields the selected widget prompt has no slot
 * for, so they still reach the page writer. Empty string when there are none.
 */
export function formatAdditionalWidgetRequirements(
  outline: SceneOutline,
  widgetType: WidgetType,
): string {
  const consumed = new Set(CONSUMED_WIDGET_OUTLINE_KEYS[widgetType] ?? []);
  const lines: string[] = [];

  // Only the simulation prompt has a design-idea slot; keep it for the others.
  if (!consumed.has('designIdea')) {
    const designIdea = resolveWidgetDesignIdea(outline);
    if (designIdea) lines.push(formatRequirement('designIdea', designIdea));
    consumed.add('designIdea');
  }

  for (const [key, value] of Object.entries(outline.widgetOutline ?? {})) {
    if (consumed.has(key) || isBlank(value)) continue;
    // The fallback outline is `{ concept: title }`; repeating the title adds nothing.
    if (key === 'concept' && typeof value === 'string' && value.trim() === outline.title.trim()) {
      continue;
    }
    lines.push(formatRequirement(key, value));
  }
  return lines.join('\n');
}

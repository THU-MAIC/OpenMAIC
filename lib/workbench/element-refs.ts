/**
 * Element references — the slide elements a user hands the agent alongside a
 * message (e.g. "these elements — make the title shorter").
 *
 * The wire shape is deliberately self-describing. `elementId` is the handle the
 * agent's edit tools address, but an id alone is worthless in a transcript and
 * dangling the moment the element is deleted, so every ref also carries the
 * human `label` the chip shows and a `snapshotText` fallback the server can
 * match against when the id no longer resolves.
 *
 * The text extraction here mirrors `lib/server/agent-runtime/course-edit/apply`
 * `inventorySlide`: same per-type source field, so a chip's label and the
 * inventory the agent reads describe the same element in the same words. That
 * duplication is intentional — this module is client-side and must not pull the
 * server's course-edit graph into the browser bundle.
 */

/** Translator fn (matches `useI18n`'s `t`) — passed in so this module stays hook-free. */
type TFn = (key: string, options?: Record<string, unknown>) => string;

export interface SlideElementRef {
  kind: 'slide-element';
  stageId: string;
  sceneId: string;
  elementId: string;
  /** DSL element type: text | image | shape | line | chart | table | latex | video | audio | code */
  elementType: string;
  /** Human label for the chip (localized type + a short content snippet). */
  label: string;
  /** Visible text of the element, capped — the fallback when `elementId` dangles. */
  snapshotText?: string;
}

export interface InteractiveElementRef {
  kind: 'interactive-element';
  stageId: string;
  sceneId: string;
  /** Best-effort identity in the live iframe DOM. */
  selector: string;
  /** Bounded DOM anchor captured at pick time. */
  outerHTML: string;
  /** Visible text captured at pick time; empty is valid. */
  text: string;
  /** Human label for the chip. */
  label: string;
}

export type ElementRef = SlideElementRef | InteractiveElementRef;

/**
 * How many elements one message may carry. A cap exists because each ref costs
 * prompt budget and because a "selection" of thirty elements is a request to
 * edit the whole page, which is what a plain sentence is for.
 */
export const MAX_ELEMENT_REFS = 10;

/** Snapshot cap. Long enough to identify a paragraph, short enough to stay a hint. */
export const ELEMENT_SNAPSHOT_MAX = 200;
export const ELEMENT_REF_ID_MAX = 64;
export const ELEMENT_REF_LABEL_MAX = 120;
export const ELEMENT_REF_SELECTOR_MAX = 512;
export const INTERACTIVE_OUTERHTML_MAX = 2048;

const SLIDE_ELEMENT_REF_FIELDS = new Set([
  'kind',
  'stageId',
  'sceneId',
  'elementId',
  'elementType',
  'label',
  'snapshotText',
]);

const INTERACTIVE_ELEMENT_REF_FIELDS = new Set([
  'kind',
  'stageId',
  'sceneId',
  'selector',
  'outerHTML',
  'text',
  'label',
]);

const ELEMENT_TYPE_LABEL_KEY: Record<string, string> = {
  text: 'edit.element.text',
  image: 'edit.element.image',
  shape: 'edit.element.shape',
  line: 'edit.element.line',
  chart: 'edit.element.chart',
  table: 'edit.element.table',
  latex: 'edit.element.latex',
  video: 'edit.element.video',
  audio: 'edit.element.audio',
  code: 'edit.element.code',
};

/** Localized element-type noun; an unknown type falls back to its raw string. */
export function elementTypeLabel(type: string, t: TFn): string {
  const key = ELEMENT_TYPE_LABEL_KEY[type];
  return key ? t(key) : type;
}

/**
 * The shape this module reads off a slide's `canvas.elements`. Structural rather
 * than the DSL union, so a partially-loaded scene (or a test fixture) is usable
 * without casting the whole element graph.
 */
export interface SlideElementLike {
  id?: string;
  type: string;
  content?: string;
  text?: { content?: string };
  latex?: string;
  lines?: { content?: string }[];
  data?: { text?: string }[][];
  src?: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The element's visible text, per type. `elementLabel` in the timeline's
 * cue-meta only ever looked at `content`, which is why a shape, a table, a code
 * block and a formula all degraded to their bare type name ("shape", "table") with
 * no way to tell two of them apart in a chip.
 */
export function elementSnapshotText(element: SlideElementLike): string {
  let raw = '';
  switch (element.type) {
    case 'text':
      raw = stripTags(element.content ?? '');
      break;
    case 'shape':
      raw = stripTags(element.text?.content ?? '');
      break;
    case 'latex':
      raw = (element.latex ?? '').trim();
      break;
    case 'code':
      raw = (element.lines ?? [])
        .map((line) => line.content ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      break;
    case 'table':
      raw = (element.data ?? [])
        .flat()
        .map((cell) => cell.text ?? '')
        .filter(Boolean)
        .join(' | ')
        .trim();
      break;
    default:
      // image / video / audio / chart / line carry no authored text. The label
      // stays the type noun, which is what the canvas pin and the ordinal are
      // there to disambiguate.
      raw = stripTags(element.content ?? '');
  }
  return raw.slice(0, ELEMENT_SNAPSHOT_MAX);
}

/** Chip label: localized type, plus a short snippet when the element has text. */
export function elementRefLabel(element: SlideElementLike, t: TFn): string {
  const typeLabel = elementTypeLabel(element.type, t);
  const snapshot = elementSnapshotText(element).replace(/\s+/g, ' ').trim();
  if (!snapshot) return typeLabel;
  const snippet = snapshot.length > 18 ? `${snapshot.slice(0, 18)}…` : snapshot;
  return `${typeLabel} · ${snippet}`;
}

export function makeElementRef(
  stageId: string,
  sceneId: string,
  element: SlideElementLike,
  t: TFn,
): SlideElementRef | null {
  if (!element.id) return null;
  const snapshotText = elementSnapshotText(element);
  return {
    kind: 'slide-element',
    stageId,
    sceneId,
    elementId: element.id,
    elementType: element.type,
    label: elementRefLabel(element, t),
    ...(snapshotText ? { snapshotText } : {}),
  };
}

export interface InteractivePickedElement {
  selector: string;
  outerHTML: string;
  text: string;
}

/** Build a bounded interactive ref from already-sanitized iframe message fields. */
export function makeInteractiveElementRef(
  stageId: string,
  sceneId: string,
  picked: InteractivePickedElement,
  t: TFn,
): InteractiveElementRef {
  const tag = /^\s*<([a-zA-Z][\w:-]*)/.exec(picked.outerHTML)?.[1]?.toLowerCase() ?? 'element';
  const baseLabel = elementTypeLabel(tag, t);
  const text = picked.text.slice(0, ELEMENT_SNAPSHOT_MAX);
  const snapshot = text.replace(/\s+/g, ' ').trim();
  const snippet = snapshot.length > 18 ? `${snapshot.slice(0, 18)}…` : snapshot;
  const label = (snippet ? `${baseLabel} · ${snippet}` : baseLabel).slice(0, ELEMENT_REF_LABEL_MAX);
  return {
    kind: 'interactive-element',
    stageId,
    sceneId,
    selector: picked.selector.slice(0, ELEMENT_REF_SELECTOR_MAX),
    outerHTML: picked.outerHTML.slice(0, INTERACTIVE_OUTERHTML_MAX),
    text,
    label,
  };
}

export function elementRefIdentity(ref: ElementRef): string {
  const localId = ref.kind === 'slide-element' ? ref.elementId : ref.selector;
  return `${ref.kind}\u0000${ref.stageId}\u0000${ref.sceneId}\u0000${localId}`;
}

export function sameElementRef(a: ElementRef, b: ElementRef): boolean {
  return elementRefIdentity(a) === elementRefIdentity(b);
}

export function hasElementRef(
  refs: readonly ElementRef[],
  stageId: string,
  sceneId: string,
  elementId: string,
): boolean {
  return refs.some(
    (ref) =>
      ref.kind === 'slide-element' &&
      ref.stageId === stageId &&
      ref.sceneId === sceneId &&
      ref.elementId === elementId,
  );
}

/**
 * Append unless the same element is already referenced or the cap is reached.
 * Returns the SAME array identity when nothing changed, so a store `set` with
 * this result is a no-op re-render-wise.
 */
export function addElementRef(refs: readonly ElementRef[], ref: ElementRef): ElementRef[] {
  if (refs.some((candidate) => sameElementRef(candidate, ref))) return refs as ElementRef[];
  if (refs.length >= MAX_ELEMENT_REFS) return refs as ElementRef[];
  return [...refs, ref];
}

export function removeElementRef(
  refs: readonly ElementRef[],
  stageId: string,
  sceneId: string,
  elementId: string,
): ElementRef[] {
  const next = refs.filter(
    (ref) =>
      ref.kind !== 'slide-element' ||
      ref.stageId !== stageId ||
      ref.sceneId !== sceneId ||
      ref.elementId !== elementId,
  );
  return next.length === refs.length ? (refs as ElementRef[]) : next;
}

export function removeElementRefValue(
  refs: readonly ElementRef[],
  target: ElementRef,
): ElementRef[] {
  const next = refs.filter((ref) => !sameElementRef(ref, target));
  return next.length === refs.length ? (refs as ElementRef[]) : next;
}

/** Add if absent, drop if present — the pick layer's click behaviour. */
export function toggleElementRef(refs: readonly ElementRef[], ref: ElementRef): ElementRef[] {
  return refs.some((candidate) => sameElementRef(candidate, ref))
    ? removeElementRefValue(refs, ref)
    : addElementRef(refs, ref);
}

/**
 * 1-based position of an element among the current refs, or 0 when it is not
 * referenced. The canvas pin and the chip show the same number, so a pin and a
 * chip can be read as one pair.
 */
export function elementRefOrdinal(
  refs: readonly ElementRef[],
  stageId: string,
  sceneId: string,
  elementId: string,
): number {
  return (
    refs.findIndex(
      (ref) =>
        ref.kind === 'slide-element' &&
        ref.stageId === stageId &&
        ref.sceneId === sceneId &&
        ref.elementId === elementId,
    ) + 1
  );
}

export type ElementRefsDecodeResult =
  | { ok: true; refs: ElementRef[] }
  | { ok: false; error: string };

/**
 * The one strict wire decoder used by both the POST boundary and durable replay.
 * The route rejects the first invalid item; replay drops invalid historical
 * items and deterministically keeps the first ten valid refs.
 */
export function decodeElementRefs(
  value: unknown,
  invalid: 'reject' | 'drop' = 'reject',
): ElementRefsDecodeResult {
  if (!Array.isArray(value)) {
    return invalid === 'drop'
      ? { ok: true, refs: [] }
      : { ok: false, error: 'elementRefs must be an array' };
  }
  const refs: ElementRef[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const reject = (error: string): ElementRefsDecodeResult | null =>
      invalid === 'reject' ? { ok: false, error } : null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const failure = reject(`elementRefs[${index}] must be an object`);
      if (failure) return failure;
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const allowedFields =
      rec.kind === 'slide-element'
        ? SLIDE_ELEMENT_REF_FIELDS
        : rec.kind === 'interactive-element'
          ? INTERACTIVE_ELEMENT_REF_FIELDS
          : null;
    if (!allowedFields) {
      const failure = reject(
        `elementRefs[${index}].kind must be "slide-element" or "interactive-element"`,
      );
      if (failure) return failure;
      continue;
    }
    const unknownField = Object.keys(rec).find((field) => !allowedFields.has(field));
    if (unknownField) {
      const failure = reject(`elementRefs[${index}] contains unknown field "${unknownField}"`);
      if (failure) return failure;
      continue;
    }
    let invalidRequired: string | null = null;
    const idFields =
      rec.kind === 'slide-element'
        ? (['stageId', 'sceneId', 'elementId', 'elementType'] as const)
        : (['stageId', 'sceneId'] as const);
    for (const field of idFields) {
      const fieldValue = rec[field];
      if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
        invalidRequired = `elementRefs[${index}].${field} must be a non-empty string`;
        break;
      }
      if (fieldValue.length > ELEMENT_REF_ID_MAX) {
        invalidRequired = `elementRefs[${index}].${field} cannot exceed ${ELEMENT_REF_ID_MAX} characters`;
        break;
      }
    }
    if (invalidRequired) {
      const failure = reject(invalidRequired);
      if (failure) return failure;
      continue;
    }
    if (rec.kind === 'interactive-element') {
      const boundedFields = [
        ['selector', ELEMENT_REF_SELECTOR_MAX, false],
        ['outerHTML', INTERACTIVE_OUTERHTML_MAX, false],
        ['text', ELEMENT_SNAPSHOT_MAX, true],
      ] as const;
      let invalidInteractive: string | null = null;
      for (const [field, max, allowEmpty] of boundedFields) {
        const value = rec[field];
        if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
          invalidInteractive = `elementRefs[${index}].${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`;
          break;
        }
        if (value.length > max) {
          invalidInteractive = `elementRefs[${index}].${field} cannot exceed ${max} characters`;
          break;
        }
      }
      if (invalidInteractive) {
        const failure = reject(invalidInteractive);
        if (failure) return failure;
        continue;
      }
    }
    if (typeof rec.label !== 'string' || !rec.label.trim()) {
      const failure = reject(`elementRefs[${index}].label must be a non-empty string`);
      if (failure) return failure;
      continue;
    }
    if (rec.label.length > ELEMENT_REF_LABEL_MAX) {
      const failure = reject(
        `elementRefs[${index}].label cannot exceed ${ELEMENT_REF_LABEL_MAX} characters`,
      );
      if (failure) return failure;
      continue;
    }
    if (
      rec.kind === 'slide-element' &&
      rec.snapshotText !== undefined &&
      (typeof rec.snapshotText !== 'string' || !rec.snapshotText.trim())
    ) {
      const failure = reject(
        `elementRefs[${index}].snapshotText must be a non-empty string when provided`,
      );
      if (failure) return failure;
      continue;
    }
    if (
      rec.kind === 'slide-element' &&
      typeof rec.snapshotText === 'string' &&
      rec.snapshotText.length > ELEMENT_SNAPSHOT_MAX
    ) {
      const failure = reject(
        `elementRefs[${index}].snapshotText cannot exceed ${ELEMENT_SNAPSHOT_MAX} characters`,
      );
      if (failure) return failure;
      continue;
    }
    const ref: ElementRef =
      rec.kind === 'slide-element'
        ? {
            kind: 'slide-element',
            stageId: rec.stageId as string,
            sceneId: rec.sceneId as string,
            elementId: rec.elementId as string,
            elementType: rec.elementType as string,
            label: rec.label,
            ...(typeof rec.snapshotText === 'string' ? { snapshotText: rec.snapshotText } : {}),
          }
        : {
            kind: 'interactive-element',
            stageId: rec.stageId as string,
            sceneId: rec.sceneId as string,
            selector: rec.selector as string,
            outerHTML: rec.outerHTML as string,
            text: rec.text as string,
            label: rec.label,
          };
    const identity = elementRefIdentity(ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (refs.length >= MAX_ELEMENT_REFS) {
      if (invalid === 'reject') {
        return {
          ok: false,
          error: `elementRefs cannot contain more than ${MAX_ELEMENT_REFS} items`,
        };
      }
      continue;
    }
    refs.push(ref);
  }
  return { ok: true, refs };
}

/** Decode refs from a durable event, dropping invalid historical items. */
export function parseElementRefs(value: unknown): ElementRef[] {
  const decoded = decodeElementRefs(value, 'drop');
  return decoded.ok ? decoded.refs : [];
}

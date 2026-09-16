/** Experimental, declared semantic evidence. Not a complete JS-state export or tool authority. */
import { z } from 'zod';

export const OBSERVATION_VERSION = 1;
export const OBSERVATION_MAX_BYTES = 32_768;
export const OBSERVATION_ATTRIBUTE = 'data-maic-observation';
/**
 * The single declared activity scope a page publishes state for. It names the
 * state-evidence scope only; it is never the identity of a referenced component.
 */
export const OBSERVATION_SCOPE_ID = 'experiment';
/** Optional browser capability; unsupported contexts retain static references. */
export function supportsInteractiveObservation(): boolean {
  return (
    typeof globalThis.crypto?.randomUUID === 'function' &&
    typeof globalThis.crypto?.subtle?.digest === 'function'
  );
}

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,126}$/);
const text = z.string().min(1).max(240);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().finite().nonnegative();
const fact = z.discriminatedUnion('status', [
  z
    .object({
      key: id,
      label: text,
      status: z.literal('known'),
      value: z.union([z.string().max(500), z.number().finite(), z.boolean()]),
      unit: z.string().max(40).optional(),
    })
    .strict(),
  z.object({ key: id, label: text, status: z.literal('unknown'), reason: text }).strict(),
]);
// `complete` is exhaustive within the declared graph/scope: an unlisted edge
// is absent there; [] is known absence of all such edges. `unknown` establishes
// neither presence nor absence. This does not describe out-of-scope relations.
const relations = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('complete'),
      items: z
        .array(
          z
            .object({
              from: id,
              to: id,
              kind: id,
              label: text,
            })
            .strict(),
        )
        .max(128),
    })
    .strict(),
  z.object({ status: z.literal('unknown'), reason: text }).strict(),
]);
const graph = z
  .object({
    objects: z.array(z.object({ id, label: text, facts: z.array(fact).max(24) }).strict()).max(64),
    relations,
    // Always present: identifies omitted information; completeness is only within declared scope.
    missing: z.array(text).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.objects.map((o) => o.id));
    if (ids.size !== value.objects.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate object identity' });
    for (const object of value.objects) {
      if (new Set(object.facts.map((f) => f.key)).size !== object.facts.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate fact identity' });
    }
    if (value.relations.status === 'complete') {
      for (const relation of value.relations.items) {
        if (!ids.has(relation.from) || !ids.has(relation.to))
          ctx.addIssue({ code: 'custom', message: 'Relation endpoint outside declared graph' });
      }
      const keys = value.relations.items.map((r) => JSON.stringify([r.from, r.to, r.kind]));
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate relation' });
    }
  });

export const observationSchema = z
  .object({
    version: z.literal(OBSERVATION_VERSION),
    scope: z.object({ id, label: text }).strict(),
    current: z.object({ revision, updatedAt: timestamp, graph }).strict(),
    rendered: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('known'),
          basedOnRevision: revision,
          renderedAt: timestamp,
          graph,
        })
        .strict(),
      z.object({ status: z.literal('unknown'), reason: text }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.rendered.status === 'known' &&
      value.rendered.basedOnRevision > value.current.revision
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Rendered revision cannot be newer than current revision',
      });
  });

export type Observation = z.infer<typeof observationSchema>;
export type ObservationGraph = z.infer<typeof graph>;
export type ObservationFact = z.infer<typeof fact>;
export type UnavailableReason =
  | 'no-interface'
  | 'not-ready'
  | 'invalid-data'
  | 'too-large'
  | 'scope-changed'
  | 'document-changed'
  | 'timeout'
  | 'cancelled';
export type ParsedObservation =
  | { status: 'available' | 'partial'; observation: Observation }
  | { status: 'unavailable'; reason: UnavailableReason };

export function parseObservation(raw: string, scopeId: string): ParsedObservation {
  if (
    raw.length > OBSERVATION_MAX_BYTES ||
    new TextEncoder().encode(raw).length > OBSERVATION_MAX_BYTES
  )
    return { status: 'unavailable', reason: 'too-large' };
  try {
    const result = observationSchema.safeParse(JSON.parse(raw), { jitless: true });
    if (!result.success || result.data.scope.id !== scopeId)
      return { status: 'unavailable', reason: 'invalid-data' };
    const observation = result.data;
    const incomplete = (g: ObservationGraph) =>
      g.missing.length > 0 ||
      g.relations.status === 'unknown' ||
      g.objects.some((o) => o.facts.some((f) => f.status === 'unknown'));
    const partial =
      incomplete(observation.current.graph) ||
      observation.rendered.status === 'unknown' ||
      incomplete(observation.rendered.graph);
    return { status: partial ? 'partial' : 'available', observation };
  } catch {
    return { status: 'unavailable', reason: 'invalid-data' };
  }
}

/** Request results are detached and recursively frozen; future publications cannot change them. */
export function freezeEvidence<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeEvidence(item);
    Object.freeze(value);
  }
  return value;
}

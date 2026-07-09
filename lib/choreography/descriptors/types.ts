/**
 * Animation descriptor model — a declarative, render-backend-agnostic
 * description of an effect animation: *what property, from what value to what
 * value, over how long, with what easing*. No implementation, no `motion`, no
 * DOM. The app's effect components and the video exporter both interpret these,
 * so the animation values live in exactly one place and cannot drift.
 *
 * Descriptors are versioned (`spotlight.v1`) and schema-validated: the schema
 * is authored here with zod, the TS types are inferred from it (single source),
 * and every shipped descriptor is checked against it in tests. The exporter can
 * reuse {@link AnimationDescriptorSchema} to validate anything it interprets.
 *
 * Pure — depends only on zod, no React / DOM / render backend.
 */
import { z } from 'zod';

/** A field of the target element's percentage geometry (0-100 space). */
export const GeometryRefSchema = z.enum(['x', 'y', 'w', 'h', 'centerX', 'centerY']);

/**
 * A value derived linearly from the target element's geometry:
 * `value = geometry[ref] * scale + offset`. Used for effect positions that
 * track the highlighted element (e.g. a spotlight cutout inset by a few units).
 */
export const GeometryValueSchema = z.object({
  ref: GeometryRefSchema,
  /** Multiplier on the geometry field. Default 1. */
  scale: z.number().optional(),
  /** Added after scaling. Default 0. */
  offset: z.number().optional(),
});

/**
 * A corner/edge fly-in start value: pick one of two off-screen positions based
 * on which half of the viewport the element center sits in. Models the laser's
 * `center > 50 ? 105 : -5` start rule.
 */
export const CornerValueSchema = z.object({
  /** Which center axis to test. */
  axis: z.enum(['centerX', 'centerY']),
  /** Comparison threshold (percent). */
  threshold: z.number(),
  /** Value used when the center is strictly above the threshold. */
  whenAbove: z.number(),
  /** Value used otherwise. */
  whenBelow: z.number(),
});

/**
 * An animatable endpoint: a literal number, a literal string (colors; may carry
 * a `{param}` placeholder), or a geometry-/corner-derived value.
 */
export const AnimatableValueSchema = z.union([
  z.number(),
  z.string(),
  GeometryValueSchema,
  CornerValueSchema,
]);

/** Easing curve. Omit on a track to use the consumer's engine default. */
export const EasingSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cubicBezier'),
    points: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
  z.object({ type: z.literal('named'), name: z.string() }),
  z.object({
    type: z.literal('spring'),
    stiffness: z.number(),
    damping: z.number(),
    mass: z.number().optional(),
  }),
]);

/** Which phase of the effect lifecycle a track belongs to. Default 'enter'. */
export const TrackPhaseSchema = z.enum(['enter', 'exit']);

/** A single animated property from `from` to `to` over `durationMs`. */
export const TrackSchema = z.object({
  /** The property name (e.g. 'x', 'width', 'opacity', 'scale', 'left', 'top'). */
  property: z.string(),
  from: AnimatableValueSchema,
  to: AnimatableValueSchema,
  durationMs: z.number(),
  delayMs: z.number().optional(),
  /** Omitted when the source specifies no explicit easing. */
  easing: EasingSchema.optional(),
  phase: TrackPhaseSchema.optional(),
  /** Number of repeats, or 'infinite'. Omit for no repeat. */
  repeat: z.union([z.number(), z.literal('infinite')]).optional(),
  repeatDelayMs: z.number().optional(),
});

/** Non-animated static value on a layer; strings may carry `{param}` placeholders. */
const StaticPropsSchema = z.record(z.string(), z.union([z.number(), z.string()]));

/**
 * A visual layer of the effect (e.g. the spotlight cutout, its border, the
 * laser ring). Groups animated `tracks` with non-animated `staticProps`.
 */
export const LayerSchema = z.object({
  id: z.string(),
  tracks: z.array(TrackSchema),
  staticProps: StaticPropsSchema.optional(),
});

/** A versioned, declarative animation for one effect. */
export const AnimationDescriptorSchema = z.object({
  /** Stable id including version, e.g. 'spotlight.v1'. */
  id: z.string(),
  /** Numeric version, bumped on any behavioral change. */
  version: z.number(),
  effect: z.enum(['spotlight', 'laser']),
  /** Default parameter values; consumers may override (e.g. dimness, color). */
  params: StaticPropsSchema.optional(),
  /** Stacking order the effect renders at. */
  zIndex: z.number(),
  layers: z.array(LayerSchema),
});

// Types are inferred from the schemas so the schema stays the single source.
export type GeometryRef = z.infer<typeof GeometryRefSchema>;
export type GeometryValue = z.infer<typeof GeometryValueSchema>;
export type CornerValue = z.infer<typeof CornerValueSchema>;
export type AnimatableValue = z.infer<typeof AnimatableValueSchema>;
export type Easing = z.infer<typeof EasingSchema>;
export type TrackPhase = z.infer<typeof TrackPhaseSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type AnimationDescriptor = z.infer<typeof AnimationDescriptorSchema>;

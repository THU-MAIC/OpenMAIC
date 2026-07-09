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
  /** Omitted when the source specifies no explicit duration — use the consumer's engine default. */
  durationMs: z.number().optional(),
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

/** Whether a layer is painted directly, or only defines geometry used as a mask. */
export const LayerRoleSchema = z.enum(['content', 'mask']);

/**
 * How a content layer is clipped by a `mask`-role layer:
 * - `subtract` — the mask region is removed (made transparent). Models an SVG
 *   `<mask>` of a white full-cover minus a black shape (the spotlight: the dim
 *   rect shows everywhere *except* the cutout).
 * - `intersect` — only the mask region is kept.
 */
export const MaskModeSchema = z.enum(['subtract', 'intersect']);

/** A content layer's clip relationship to a `mask`-role layer in the same descriptor. */
export const MaskRefSchema = z.object({
  /** `id` of the sibling layer (role `mask`) whose animated geometry clips this one. */
  layerId: z.string(),
  mode: MaskModeSchema,
});

/** Which of a parent layer's animated properties a child inherits. */
export const InheritablePropSchema = z.enum(['left', 'top', 'x', 'y', 'opacity', 'scale']);

/**
 * A layer's inheritance from a parent layer in the same descriptor. In the
 * source, the effect nests some layers inside an animated wrapper so they ride
 * its motion (the laser ring/core sit inside the animated dot; the spotlight
 * border sits inside the fading SVG wrapper). A flat layer list can't express
 * that, so a child names its `parentId` and the `props` it rides — a literal
 * consumer composes the parent's animation for those props with the child's own
 * (e.g. the ring inherits the dot's left/top/opacity and adds its own scale
 * pulse). `props` defaults to all of the parent's animated properties.
 */
export const InheritRefSchema = z.object({
  /** `id` of the parent layer whose animation this layer rides. */
  parentId: z.string(),
  /** Properties inherited from the parent. Omit to inherit all of them. */
  props: z.array(InheritablePropSchema).optional(),
});

/**
 * A visual layer of the effect (e.g. the spotlight cutout, its border, the
 * laser ring). Groups animated `tracks` with non-animated `staticProps`.
 *
 * A layer with `role: 'mask'` is not painted on its own — its animated geometry
 * is referenced by another layer's `maskedBy` to clip it. This lets a non-React
 * consumer reconstruct compositing relationships (e.g. the spotlight dim rect
 * with the cutout punched out) that independent layers alone cannot express.
 *
 * A layer with `inheritsFrom` rides a parent layer's animation for the named
 * properties (the source nests it inside that animated wrapper), on top of its
 * own `tracks`.
 */
export const LayerSchema = z.object({
  id: z.string(),
  /** Default `content` (painted). `mask` layers only supply geometry for a `maskedBy` ref. */
  role: LayerRoleSchema.optional(),
  /** This (content) layer is clipped by the referenced `mask`-role layer. */
  maskedBy: MaskRefSchema.optional(),
  /** This layer rides a parent layer's animation (it is nested inside it in the source). */
  inheritsFrom: InheritRefSchema.optional(),
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
export type LayerRole = z.infer<typeof LayerRoleSchema>;
export type MaskMode = z.infer<typeof MaskModeSchema>;
export type MaskRef = z.infer<typeof MaskRefSchema>;
export type InheritableProp = z.infer<typeof InheritablePropSchema>;
export type InheritRef = z.infer<typeof InheritRefSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type AnimationDescriptor = z.infer<typeof AnimationDescriptorSchema>;

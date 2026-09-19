import type { Target, TargetAndTransition, Transition } from 'motion/react';
import type { AnimatableValue, AnimationDescriptor, GeometryRef, Track } from '@/lib/choreography';

export interface ResolvedMotionLayer {
  initial: Target;
  animate: Target;
  exit?: TargetAndTransition;
  transition: Transition;
  staticProps: Record<string, string | number>;
}

type MotionValue = string | number;
type MotionTarget = Record<string, MotionValue | MotionValue[]>;
type Params = Record<string, string | number>;

function hasOwn(record: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function setOwn<T extends Record<string, unknown>>(
  record: T,
  property: string,
  value: T[string],
): void {
  Object.defineProperty(record, property, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function requireGeometry(ref: GeometryRef, geometry: Partial<Record<GeometryRef, number>>): number {
  const value = geometry[ref];
  if (value === undefined) {
    throw new Error(`Missing geometry field "${ref}"`);
  }
  return value;
}

function resolveValue(
  value: AnimatableValue,
  geometry: Partial<Record<GeometryRef, number>>,
  params: Params,
  descriptorId: string,
): MotionValue {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return resolveParameterizedValue(value, params, descriptorId);
  }

  if ('ref' in value) {
    return requireGeometry(value.ref, geometry) * (value.scale ?? 1) + (value.offset ?? 0);
  }

  return requireGeometry(value.axis, geometry) > value.threshold
    ? value.whenAbove
    : value.whenBelow;
}

function applyUnit(value: MotionValue, unit: string | undefined): MotionValue {
  return unit !== undefined && typeof value === 'number' ? `${value}${unit}` : value;
}

function resolveTransition(track: Track): Transition {
  const transition: Record<string, unknown> = {};

  if (track.durationMs !== undefined) transition.duration = track.durationMs / 1000;
  if (track.delayMs !== undefined) transition.delay = track.delayMs / 1000;

  if (track.easing?.type === 'cubicBezier') {
    transition.ease = track.easing.points;
  } else if (track.easing?.type === 'named') {
    transition.ease = track.easing.name;
  } else if (track.easing?.type === 'spring') {
    transition.type = 'spring';
    transition.stiffness = track.easing.stiffness;
    transition.damping = track.easing.damping;
    if (track.easing.mass !== undefined) transition.mass = track.easing.mass;
  }

  if (track.repeat !== undefined) {
    transition.repeat = track.repeat === 'infinite' ? Infinity : track.repeat;
  }
  if (track.repeatDelayMs !== undefined) {
    transition.repeatDelay = track.repeatDelayMs / 1000;
  }

  return transition as Transition;
}

function resolveParameterizedValue(value: string | number, params: Params, descriptorId: string) {
  if (typeof value === 'number') return value;

  const exactMatch = /^\{([^{}]+)\}$/.exec(value);
  if (exactMatch) {
    return requireParameter(exactMatch[1], params, descriptorId);
  }

  return value.replace(/\{([^{}]+)\}/g, (_placeholder, name: string) =>
    String(requireParameter(name, params, descriptorId)),
  );
}

function requireParameter(name: string, params: Params, descriptorId: string): string | number {
  const value = params[name];
  if (!hasOwn(params, name) || value === undefined) {
    throw new Error(`Unresolved parameter "${name}" in descriptor "${descriptorId}"`);
  }
  return value;
}

export function resolveMotionLayer(
  descriptor: AnimationDescriptor,
  layerId: string,
  options?: {
    geometry?: Partial<Record<GeometryRef, number>>;
    params?: Record<string, string | number | undefined>;
    units?: Partial<Record<string, string>>;
  },
): ResolvedMotionLayer {
  const layer = descriptor.layers.find((candidate) => candidate.id === layerId);
  if (!layer) {
    throw new Error(`Layer "${layerId}" was not found in descriptor "${descriptor.id}"`);
  }

  const params: Params = {};
  for (const [name, value] of Object.entries(descriptor.params ?? {})) {
    setOwn(params, name, value);
  }
  for (const [name, value] of Object.entries(options?.params ?? {})) {
    if (value !== undefined) setOwn(params, name, value);
  }

  const geometry = options?.geometry ?? {};
  const initial: MotionTarget = {};
  const animate: MotionTarget = {};
  const transition: Record<string, Transition> = {};
  const exitTarget: MotionTarget = {};
  const exitTransition: Record<string, Transition> = {};
  let hasExit = false;

  for (const track of layer.tracks) {
    const units = options?.units;
    const unit = units && hasOwn(units, track.property) ? units[track.property] : undefined;
    const from = applyUnit(resolveValue(track.from, geometry, params, descriptor.id), unit);
    const to = applyUnit(resolveValue(track.to, geometry, params, descriptor.id), unit);
    const propertyTransition = resolveTransition(track);

    if ((track.phase ?? 'enter') === 'exit') {
      hasExit = true;
      setOwn(exitTarget, track.property, to);
      setOwn(exitTransition, track.property, propertyTransition);
    } else {
      if (track.repeat !== undefined) {
        setOwn(animate, track.property, [from, to]);
      } else {
        setOwn(initial, track.property, from);
        setOwn(animate, track.property, to);
      }
      setOwn(transition, track.property, propertyTransition);
    }
  }

  const staticProps: Record<string, string | number> = {};
  for (const [property, value] of Object.entries(layer.staticProps ?? {})) {
    setOwn(staticProps, property, resolveParameterizedValue(value, params, descriptor.id));
  }

  return {
    initial: initial as Target,
    animate: animate as Target,
    ...(hasExit
      ? {
          exit: {
            ...exitTarget,
            transition: exitTransition as Transition,
          } as TargetAndTransition,
        }
      : {}),
    transition: transition as Transition,
    staticProps,
  };
}

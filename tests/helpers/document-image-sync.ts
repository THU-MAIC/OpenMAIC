/** The former synchronous entry points, retained only for parser contract tests. */
import { imagePlan } from '@/lib/server/material-extraction/document-image-plan.mjs';
import {
  applyImagePlan,
  type ImagePlan,
  type RewriteImageTarget,
} from '@/lib/server/material-extraction/document-image-apply.mjs';
import {
  isProviderPath,
  keyOf,
  type ImagePathIndex,
} from '@/lib/server/material-extraction/document-image-paths.mjs';
const DERIVATIVE_REF_PREFIX = 'openmaic-derivative:';
const MATERIAL_REF_PREFIX = 'material:';
/**
 * Rewrite the image references of one markdown text. The text is parsed as
 * CommonMark, so only real image references change: an image (`![alt](x)`,
 * destinations with balanced parentheses or `<...>` included), an image
 * reference (`![alt][label]`, `![alt][]`, `![alt]`) through its definition,
 * and an `<img>` inside raw HTML. Code blocks, inline code and escaped text
 * are not image references and are left exactly as written.
 *
 * A reference to a kept image names its key; one to any other file of the
 * provider becomes its alt text. A reference image is written inline, and a
 * definition of a provider file that only images use is removed, so no
 * provider path is left behind. Remote, inline (`data:`) and absolute
 * references are kept.
 */
export function rewriteImageReferences(markdown: string, index: ImagePathIndex): string {
  return rewriteImageDestinations(markdown, (target) => {
    if (!isProviderPath(target)) return undefined;
    const key = keyOf(index, target);
    return key ? `${DERIVATIVE_REF_PREFIX}${key}` : null;
  });
}

function rewriteImageDestinations(markdown: string, rewriteTarget: RewriteImageTarget): string {
  const prefix = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
  const input = prefix ? markdown.slice(1) : markdown;
  return prefix + applyImagePlan(input, imagePlan(input), rewriteTarget);
}

// This retained synchronous cache is test-only. Production cache coverage lives
// in tests/agent-runtime/document-image-worker.test.ts via resolveDerivativeRefsAsync.
// A cache of derived reference positions, not owner text or derivative ids.
// Callers supply an immutable text-entry/revision identity after resolving its
// bytes. Every reader still applies its own result's mapping, including reuse.
const MAX_IMAGE_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PLAN_ENTRIES = 16;
const imagePlans = new Map<string, { plan: ImagePlan; bytes: number }>();
let imagePlanBytes = 0;
function cachedImagePlan(cacheKey?: string): ImagePlan | undefined {
  const cached = cacheKey === undefined ? undefined : imagePlans.get(cacheKey);
  if (cached) {
    imagePlans.delete(cacheKey!);
    imagePlans.set(cacheKey!, cached);
    return cached.plan;
  }
}

function cacheImagePlan(plan: ImagePlan, cacheKey?: string): void {
  const size = [...plan.markdown, ...plan.html].reduce(
    (bytes, image) =>
      bytes +
      256 +
      2 *
        (image.target.length +
          image.alt.length +
          ('title' in image ? (image.title?.length ?? 0) : 0) +
          ('attributePrefix' in image ? image.attributePrefix.length : 0)),
    0,
  );
  if (cacheKey !== undefined && size <= MAX_IMAGE_PLAN_BYTES) {
    // Two cold reads may finish together; replacement must not double-count
    // the same cached plan against the byte limit.
    const previous = imagePlans.get(cacheKey);
    if (previous) {
      imagePlanBytes -= previous.bytes;
      imagePlans.delete(cacheKey);
    }
    while (
      imagePlans.size >= MAX_IMAGE_PLAN_ENTRIES ||
      imagePlanBytes + size > MAX_IMAGE_PLAN_BYTES
    ) {
      const oldest = imagePlans.keys().next().value!;
      imagePlanBytes -= imagePlans.get(oldest)!.bytes;
      imagePlans.delete(oldest);
    }
    // Copy the small plan so cached substrings cannot retain a large input's
    // backing storage after its parsed tree has been discarded.
    imagePlans.set(cacheKey, { plan: structuredClone(plan), bytes: size });
    imagePlanBytes += size;
  }
}

function derivativeImagePlan(input: string, cacheKey?: string): ImagePlan {
  const cached = cachedImagePlan(cacheKey);
  if (cached) return cached;
  const parsed = imagePlan(input);
  const plan = {
    markdown: parsed.markdown.filter((image) => image.target.startsWith(DERIVATIVE_REF_PREFIX)),
    html: parsed.html.filter((image) => image.target.startsWith(DERIVATIVE_REF_PREFIX)),
  };
  cacheImagePlan(plan, cacheKey);
  return plan;
}

/**
 * Resolve a stored text's keys to the derivatives of the result being read:
 * `openmaic-derivative:<key>` becomes `material:<derivative id>`. A key the
 * result does not have (it cannot happen for a text and result published
 * together) is left as it is.
 */
export function resolveDerivativeRefs(
  text: string,
  derivatives: ReadonlyArray<{ id: string; key?: string }>,
  cacheKey?: string,
): string {
  const idByKey = new Map(
    derivatives.flatMap((derivative) => (derivative.key ? [[derivative.key, derivative.id]] : [])),
  );
  if (idByKey.size === 0) return text;
  const prefix = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const input = prefix ? text.slice(1) : text;
  return (
    prefix +
    applyImagePlan(input, derivativeImagePlan(input, cacheKey), (target) => {
      if (!target.startsWith(DERIVATIVE_REF_PREFIX)) return undefined;
      const id = idByKey.get(target.slice(DERIVATIVE_REF_PREFIX.length));
      return id ? `${MATERIAL_REF_PREFIX}${id}` : undefined;
    })
  );
}

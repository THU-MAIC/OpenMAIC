/** One isolated parse; exits after its result. Both operations use the same parser. */
import { parentPort, workerData } from 'node:worker_threads';
import { imagePlan } from './document-image-plan.mjs';
import { applyImagePlan } from './document-image-apply.mjs';
import { isProviderPath, keyOf } from './document-image-paths.mjs';

try {
  if (workerData.kind === 'plan') {
    const parsed = imagePlan(workerData.text);
    parentPort.postMessage({
      result: {
        markdown: parsed.markdown.filter((image) =>
          image.target.startsWith('openmaic-derivative:'),
        ),
        html: parsed.html.filter((image) => image.target.startsWith('openmaic-derivative:')),
      },
    });
  } else {
    const parts = [];
    const refs = [];
    let offset = 0;
    for (const block of workerData.blocks) {
      let text = block.text ?? '';
      const localRefs = [];
      if (block.type === 'markdown' && text) {
        const prefix = text.startsWith('\uFEFF') ? '\uFEFF' : '';
        const input = prefix ? text.slice(1) : text;
        text =
          prefix +
          applyImagePlan(
            input,
            imagePlan(input),
            (target) => {
              if (!isProviderPath(target)) return undefined;
              const key = keyOf(workerData.index, target);
              return key ? `openmaic-derivative:${key}` : null;
            },
            localRefs,
          );
        if (prefix)
          for (const ref of localRefs) {
            ref.start += 1;
            ref.end += 1;
          }
      }
      // Match documentOutcome's trim and joining exactly; published offsets
      // belong to the final stored text, not the provider's individual blocks.
      const leading = text.length - text.trimStart().length;
      text = text.trim();
      if (!text) continue;
      if (parts.length) offset += 2;
      for (const ref of localRefs)
        refs.push({ ...ref, start: offset + ref.start - leading, end: offset + ref.end - leading });
      parts.push(text);
      offset += text.length;
    }
    parentPort.postMessage({ result: { text: parts.join('\n\n'), refs } });
  }
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}

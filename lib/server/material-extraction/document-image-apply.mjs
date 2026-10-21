/** Apply recorded image positions without loading a Markdown or HTML parser. */
/** `[`, `]` and `\\` escaped, so alt text stays alt text inside `![...]`. */
function escapeAlt(alt) {
  return alt.replace(/[[\]\\]/g, (character) => `\\${character}`);
}
export function applyImagePlan(input, plan, rewriteTarget, refs) {
  const edits = [];
  const definitions = new Map();
  const missingImage = (alt) => `\\[image${alt ? `: ${escapeAlt(alt)}` : ''}\\]`;
  for (const image of plan.markdown) {
    const target = rewriteTarget(image.target);
    if (target === undefined) continue;
    const title =
      image.title == null
        ? ''
        : ` "${image.title.replace(/["\\]/g, (character) => `\\${character}`)}"`;
    const prefix = `![${escapeAlt(image.alt)}](`;
    edits.push({
      start: image.start,
      end: image.end,
      text: target === null ? missingImage(image.alt) : `${prefix}${target}${title})`,
      ...(target?.startsWith('openmaic-derivative:')
        ? { ref: { offset: prefix.length, target } }
        : {}),
    });
    if (image.definition) definitions.set(image.definition.start, image.definition);
  }
  for (const image of plan.html) {
    const target = rewriteTarget(image.target);
    if (target === undefined) continue;
    if (target === null)
      edits.push({ start: image.start, end: image.end, text: missingImage(image.alt) });
    else {
      const escaped = target.replace(
        /[&<>"']/g,
        (character) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[character],
      );
      edits.push({
        ...image.src,
        text: `${image.attributePrefix}${image.quote}${escaped}${image.quote}`,
        ...(target.startsWith('openmaic-derivative:')
          ? { ref: { offset: image.attributePrefix.length + 1, target } }
          : {}),
      });
    }
  }
  for (const at of definitions.values()) edits.push({ ...at, text: '' });
  // Join once; repeatedly slicing the partially rewritten document amplifies
  // the work by its image count even when a parsed plan has been reused.
  let end = 0;
  let written = 0;
  const parts = [];
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    written += edit.start - end;
    if (refs && edit.ref) {
      const start = written + edit.ref.offset;
      refs.push({
        start,
        end: start + edit.ref.target.length,
        key: edit.ref.target.slice('openmaic-derivative:'.length),
      });
    }
    parts.push(input.slice(end, edit.start), edit.text);
    written += edit.text.length;
    end = edit.end;
  }
  parts.push(input.slice(end));
  return parts.join('');
}

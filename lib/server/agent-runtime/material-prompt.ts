/**
 * The system-prompt block about materials and the knowledge base
 * (RFC #1716 §4).
 *
 * Present on every run, attached materials or not: a conversation with
 * nothing attached can still use the user's knowledge base. It names what the
 * conversation has (safe metadata only -- names, kinds, ids, states; never
 * contents, object keys or pool pointers) and teaches one flow: extract, wait,
 * then read with the same id.
 */
import { isPptxMaterial } from './pptx-mime';
import type { ResolvedMaterial } from './material-resolver';

/** How many attached materials the block names; the rest are a list_materials away. */
const MAX_LISTED = 30;
const MAX_NAME_CHARS = 120;

/** A material's name as one short line: names come from uploads and pages. */
function safeName(name: string): string {
  const line = name.replace(/\s+/g, ' ').trim();
  return line.length > MAX_NAME_CHARS ? `${line.slice(0, MAX_NAME_CHARS - 1)}…` : line;
}

function lineOf(material: ResolvedMaterial): string {
  if (material.origin === 'session') {
    const { record } = material;
    return `- "${safeName(record.title ?? record.id)}" (${record.kind}, id ${record.id})`;
  }
  const { entry } = material;
  const name = safeName(entry.displayName ?? entry.originalName ?? entry.id);
  if (entry.kind !== 'source') {
    return `- "${name}" (${entry.kind} of ${entry.derivedFrom ?? 'a source'}, id ${entry.id})`;
  }
  const status = entry.extraction?.status ?? 'idle';
  return `- "${name}" (knowledge-base source, id ${entry.id}, extraction ${status})`;
}

function isPptx(material: ResolvedMaterial): boolean {
  return material.origin === 'session'
    ? isPptxMaterial({ originalName: material.record.title })
    : isPptxMaterial({
        mime: material.entry.mime ?? undefined,
        originalName: material.entry.originalName,
      });
}

export function materialsPromptBlock(materials: readonly ResolvedMaterial[]): string {
  const listed = materials.slice(0, MAX_LISTED);
  const more = materials.length - listed.length;
  const hasSessionText = materials.some(
    (material) => material.origin === 'session' && material.record.kind === 'web',
  );
  const hasSessionSource = materials.some(
    (material) => material.origin === 'session' && material.record.kind === 'source',
  );
  return [
    '## Materials and the knowledge base',
    '',
    ...(materials.length > 0
      ? [
          'Attached to this conversation:',
          ...listed.map(lineOf),
          ...(more > 0 ? [`- …and ${more} more; call \`list_materials\` to see them all.`] : []),
        ]
      : ['Nothing is attached to this conversation yet.']),
    '',
    "The user's knowledge base holds their uploaded materials, in folders. `list_materials` lists what this conversation has; with `scope: 'library'` it lists the whole knowledge base (filter by `folderId` -- `null` is Unfiled -- or `query`). `read_material`, `search_material`, `extract_material`, `wait_for_materials` and `use_material_media` take `scope: 'library'` too, to reach a knowledge-base material this conversation has not attached; doing so never attaches it. Every other tool, PowerPoint import included, reaches only what is attached.",
    "Reading a knowledge-base source: call `extract_material` with its id, then `wait_for_materials`, then `read_material` with the same id. Pages come about 8000 characters at a time: continue with the `nextOffset` and the `revision` the previous page returned; if the text changed, start again at offset 0. `search_material` finds case-insensitive literal text across readable materials (with `scope: 'library'`, across the knowledge base). A `textChars` in a listing is approximate; `read_material` reports the exact length.",
    'Images and keyframes extracted from a source are materials of their own (their listing names the source in `derivedFrom`, with any page or time), and extracted text names them as `material:<id>`. To show image, video or audio material on a page, call `use_material_media` with its id and the stage, and put the returned `src` on the media element.',
    ...(hasSessionText
      ? ['A `web` material was already fetched and extracted: read it directly.']
      : []),
    ...(hasSessionSource
      ? [
          'A `source` of this conversation that is not a knowledge-base source is read through the `extraction` material its extraction produced (see `list_materials`).',
        ]
      : []),
    'To organize the knowledge base: `list_material_folders`, `create_material_folder`, `rename_material_folder`, `move_materials` (a source moves with its images and keyframes; null is Unfiled), `rename_material`. Deleting a material or a folder is left to the teacher, on the knowledge base page: you cannot delete.',
    ...(materials.some(isPptx)
      ? [
          'An attached .pptx can be imported INTO a stage as appended pages with `import_pptx` (layout-preserving: original slides become pages; the stage keeps its own title). Use that instead of an AI rewrite when the user wants the PowerPoint’s own pages.',
        ]
      : []),
  ].join('\n');
}

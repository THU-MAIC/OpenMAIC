/**
 * Static system-prompt guidance for materials and the knowledge base
 * (RFC #1716 §4).
 *
 * Present on every run, attached materials or not: a conversation with
 * nothing attached can still use the user's knowledge base. The text does
 * not name the set — no names, ids, kinds, counts, or extraction status —
 * and does not add a sentence that depends on it. Those bytes are the head
 * of the provider prompt, so a change would invalidate the prefix cache for
 * the whole conversation. `list_materials` lists what is attached. A
 * follow-up's attachment note and a `fetch_url` result name what was just
 * added.
 *
 * `materials` is accepted so the runner can keep passing the resolved set.
 * The block must not read it.
 */
import { MATERIAL_USER_WORDING } from './material-model-copy';
import type { ResolvedMaterial } from './material-resolver';

export function materialsPromptBlock(_materials: readonly ResolvedMaterial[]): string {
  return [
    '## Materials and the knowledge base',
    '',
    "The user's knowledge base holds their uploaded materials, in folders. `list_materials` lists what this conversation has; with `scope: 'library'` it lists the whole knowledge base (filter by `folderId` -- `top-level` means not in a folder -- or `query`). Listings are paged: when a listing returns `nextBefore`, call again with `before` set to that value and the same scope and filters. `read_material`, `search_material`, `extract_material`, `wait_for_materials` and `use_material_media` take `scope: 'library'` too, to reach a knowledge-base material this conversation has not attached; doing so never attaches it. Every other tool, PowerPoint import included, reaches only what is attached.",
    "Reading a knowledge-base source: call `extract_material` with its id, then `wait_for_materials`, then `read_material` with the same id. Pages come about 8000 characters at a time: continue with the `nextOffset` and the `revision` the previous page returned; if the text changed, start again at offset 0. `search_material` finds case-insensitive literal text across readable materials (with `scope: 'library'`, across the knowledge base). A `textChars` in a listing is approximate; `read_material` reports the exact length.",
    'Images and keyframes extracted from a source are materials of their own (their listing names the source in `derivedFrom`, with any page or time), and extracted text names them as `material:<id>`. To show image, video or audio material on a page, call `use_material_media` with its id and the stage, and put the returned `src` on the media element.',
    'Read a `web` material directly: it is already fetched and extracted. A `source` of this conversation that is not a knowledge-base source is read through the `extraction` material its extraction produced (see `list_materials`).',
    MATERIAL_USER_WORDING,
    'To organize the knowledge base: `list_material_folders`, `create_material_folder`, `rename_material_folder`, `move_materials` (a source moves with its images and keyframes; `folderId: "top-level"` moves it out of its folder), `rename_material`. Deleting a material or a folder is left to the teacher, on the knowledge base page: you cannot delete.',
    'An attached .pptx can be imported INTO a stage as appended pages with `import_pptx` (layout-preserving: original slides become pages; the stage keeps its own title). Use that instead of an AI rewrite when the user wants the PowerPoint’s own pages.',
  ].join('\n');
}

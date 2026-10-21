/**
 * Interactive HTML Post-Processor
 *
 * Ported from Python's PostProcessor class (learn-your-way/concept_to_html.py:287-385)
 *
 * Handles:
 * - LaTeX delimiter conversion ($$...$$ -> \[...\], $...$ -> \(...\))
 * - KaTeX CSS/JS injection with auto-render and MutationObserver
 * - Script tag protection during LaTeX conversion
 */

import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import {
  htmlNodes,
  patchHtml,
  rewriteInteractiveLibraries,
  type HtmlPatch,
} from './interactive-library-mapper.js';
import { interactiveLibraryUrl } from './interactive-libraries.js';

/** Marks the KaTeX markup this module injects, so a second pass adds nothing. */
const KATEX_INJECTION_MARKER = 'data-openmaic-katex';

/** Re-process stored HTML as well as newly generated pages. */
export function postProcessInteractiveHtml(html: string): string {
  // Upgrade the synchronous #1966 injection, including pages that no longer contain math.
  const nodes = htmlNodes(html);
  const legacy = nodes.some(
    (node) =>
      'attrs' in node &&
      node.attrs.some((attr) => attr.name === KATEX_INJECTION_MARKER && attr.value !== '2'),
  );
  if (legacy) {
    html = patchHtml(
      html,
      nodes.flatMap((node) => {
        if (!('attrs' in node) || !node.attrs.some((attr) => attr.name === KATEX_INJECTION_MARKER))
          return [];
        const range = node.sourceCodeLocation;
        return range ? [{ start: range.startOffset, end: range.endOffset, text: '' }] : [];
      }),
    );
  }
  let processed = rewriteInteractiveLibraries(html).html;
  if (
    htmlNodes(processed).some(
      (node) => 'attrs' in node && node.attrs.some((attr) => attr.name === KATEX_INJECTION_MARKER),
    )
  )
    return processed;

  const patches: HtmlPatch[] = [];
  let hasMath = false;
  for (const node of htmlNodes(processed)) {
    if (node.nodeName !== '#text' || !('value' in node)) continue;
    // Script/style/code examples and attributes are never LaTeX input.
    let parent = node.parentNode;
    let excluded = false;
    while (parent) {
      if (
        'tagName' in parent &&
        ['script', 'style', 'pre', 'code', 'textarea', 'noscript', 'title'].includes(parent.tagName)
      )
        excluded = true;
      parent = 'parentNode' in parent ? parent.parentNode : null;
    }
    if (excluded) {
      // Scripts that call KaTeX, or hold TeX strings written into the page later, need it too.
      if (
        node.parentNode &&
        'tagName' in node.parentNode &&
        node.parentNode.tagName === 'script' &&
        (scriptHasTex(node.value) || KATEX_CALL.test(node.value))
      )
        hasMath = true;
      continue;
    }
    const range = node.sourceCodeLocation;
    if (!range) continue;
    const source = processed.slice(range.startOffset, range.endOffset);
    if (/\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(source)) hasMath = true;
    const converted = source
      .replace(/(?<!\\)\$\$([^$]+)\$\$/g, (_, tex: string) => {
        hasMath = true;
        return `\\[${tex}\\]`;
      })
      // Avoid common currency ($5, $10), interpolation, and escaped dollar signs.
      .replace(/(?<![\\\w$])\$(?![\s{])([^$\n]+?)(?<!\s)\$(?![\w${])/g, (_, tex: string) => {
        hasMath = true;
        return `\\(${tex}\\)`;
      });
    if (converted !== source)
      patches.push({ start: range.startOffset, end: range.endOffset, text: converted });
  }
  processed = patchHtml(processed, patches);
  return hasMath ? injectKatex(processed) : processed;
}

/** A page script that calls KaTeX needs the #1966 guards and the library. */
const KATEX_CALL = /\b(?:katex\s*\.\s*render(?:ToString)?|renderMathInElement)\s*\(/;

/** TeX delimiters and common commands after a single backslash. */
const TEX =
  /\\(?:[([]|begin\{|(?:frac|sqrt|sum|int|lim|cdot|times|div|pm|infty|alpha|beta|gamma|delta|theta|lambda|sigma|omega|Delta|vec|mathrm|mathbf)(?![A-Za-z]))/;
/** The same, JS-escaped (two backslashes) inside an ordinary string literal. */
const SCRIPT_TEX = new RegExp(`\\\\${TEX.source}`);
/** String.raw template literals keep TeX backslashes single. */
const RAW_TEMPLATE = /\bString\s*\.\s*raw\s*`((?:[^`\\]|\\[\s\S])*)`/g;

function scriptHasTex(source: string): boolean {
  if (SCRIPT_TEX.test(source)) return true;
  for (const match of source.matchAll(RAW_TEMPLATE)) if (TEX.test(match[1]!)) return true;
  return false;
}

/**
 * Inject KaTeX CSS, JS, auto-render, and a MutationObserver at the start of
 * <head>, ahead of every script the page authored.
 *
 * - The libraries load synchronously before the page's own scripts, so
 *   `katex` and `renderMathInElement` exist when those scripts and their
 *   DOMContentLoaded handlers run. A page that loads its own KaTeX later
 *   replaces these globals with the same library.
 * - When the hosted asset fails to load, no-op stand-ins keep the page's own math
 *   calls from throwing; the math then stays as written.
 * - The render handler is registered before the page's handlers, so the
 *   observer is already watching when the page fills its labels.
 */
function injectKatex(html: string): string {
  const katexInjection = `
<link ${KATEX_INJECTION_MARKER}="2" rel="stylesheet" href="${interactiveLibraryUrl('katex', 'dist/katex.min.css')}">
<script ${KATEX_INJECTION_MARKER}="2" src="${interactiveLibraryUrl('katex')}"></script>
<script ${KATEX_INJECTION_MARKER}="2" src="${interactiveLibraryUrl('katex', 'dist/contrib/auto-render.min.js')}"></script>
<script ${KATEX_INJECTION_MARKER}="2">
(function () {
    if (!window.katex) {
        window.katex = {
            render: function (tex, element) {
                if (element) element.textContent = String(tex);
            },
            renderToString: function (tex) {
                return String(tex).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }
        };
    }
    if (typeof window.renderMathInElement !== 'function') {
        window.renderMathInElement = function () {};
    }
})();
document.addEventListener("DOMContentLoaded", function() {
    const katexOptions = {
        delimiters: [
            {left: '\\\\[', right: '\\\\]', display: true},
            {left: '\\\\(', right: '\\\\)', display: false},
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
        ],
        throwOnError: false,
        strict: false,
        trust: true
    };

    function render() {
        try {
            renderMathInElement(document.body, katexOptions);
        } catch (e) {
            // A failed pass must not stop the observer from being installed.
        }
    }

    let renderTimeout;
    function safeRender() {
        if (renderTimeout) clearTimeout(renderTimeout);
        renderTimeout = setTimeout(render, 100);
    }

    render();

    const observer = new MutationObserver((mutations) => {
        let shouldRender = false;
        mutations.forEach((mutation) => {
            if (mutation.target &&
                mutation.target.className &&
                typeof mutation.target.className === 'string' &&
                mutation.target.className.includes('katex')) {
                return;
            }
            shouldRender = true;
        });

        if (shouldRender) {
            safeRender();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    setInterval(() => {
        const text = document.body.innerText;
        if (text.includes('\\\\(') || text.includes('$$')) {
            safeRender();
        }
    }, 2000);
});
</script>
`;

  return insertAtHeadStart(html, katexInjection);
}

/**
 * Insert markup at the start of the document's <head> without rewriting the
 * authored bytes. A document without an explicit <head> gets one after its
 * <html> start tag or doctype; anything else gets the markup prepended.
 *
 * Offsets come from parse5, so a `<head>` inside a script or comment is never
 * mistaken for the element. The markup is spliced with string slicing, not
 * `String.replace()`, because it contains `$` characters.
 */
function insertAtHeadStart(html: string, markup: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const htmlElement = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === 'html',
  );
  const headElement = htmlElement?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === 'head',
  );
  const insertAt = (offset: number, text: string) =>
    html.slice(0, offset) + text + html.slice(offset);

  const headStartEnd = headElement?.sourceCodeLocation?.startTag?.endOffset;
  if (headStartEnd !== undefined) return insertAt(headStartEnd, markup);

  const htmlStartEnd = htmlElement?.sourceCodeLocation?.startTag?.endOffset;
  if (htmlStartEnd !== undefined) return insertAt(htmlStartEnd, `<head>${markup}</head>`);

  const doctype = document.childNodes.find((node) => node.nodeName === '#documentType');
  const doctypeEnd = doctype?.sourceCodeLocation?.endOffset;
  if (doctypeEnd !== undefined) return insertAt(doctypeEnd, `<head>${markup}</head>`);

  return markup + html;
}

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return !node.nodeName.startsWith('#');
}

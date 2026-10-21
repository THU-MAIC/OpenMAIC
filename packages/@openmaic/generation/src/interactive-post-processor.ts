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
  let synchronous = false;
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
        (SCRIPT_TEX.test(node.value) || KATEX_CALL.test(node.value))
      ) {
        hasMath = true;
        // A classic inline script runs during parsing and may use the return value
        // of katex.renderToString, which a deferred library cannot supply in time.
        if (isClassicScript(node.parentNode) && KATEX_SYNC_CALL.test(node.value))
          synchronous = true;
      }
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
  return hasMath ? injectKatex(processed, synchronous) : processed;
}

/** A page script that calls KaTeX needs the #1966 guards and the library. */
const KATEX_SYNC_CALL = /\bkatex\s*\.\s*render(?:ToString)?\s*\(/;

const CLASSIC_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

function isClassicScript(node: DefaultTreeAdapterTypes.ParentNode): boolean {
  if (!('attrs' in node)) return false;
  const type =
    node.attrs
      .find((attr) => attr.name === 'type')
      ?.value.trim()
      .toLowerCase() ?? '';
  return CLASSIC_SCRIPT_TYPES.has(type);
}

const KATEX_CALL = /\b(?:katex\s*\.\s*render(?:ToString)?|renderMathInElement)\s*\(/;

/** A JS-escaped TeX delimiter or common command inside a script string literal. */
const SCRIPT_TEX =
  /\\\\(?:[([]|begin\{|(?:frac|sqrt|sum|int|lim|cdot|times|div|pm|infty|alpha|beta|gamma|delta|theta|lambda|sigma|omega|Delta|vec|mathrm|mathbf)(?![A-Za-z]))/;

/** The guard runs immediately; local libraries are deferred unless the page needs them during parsing. */
function injectKatex(html: string, synchronous: boolean): string {
  // Pages that call KaTeX from classic inline scripts get the synchronous #1966 order.
  const defer = synchronous ? '' : ' defer';
  const resources = `
<link ${KATEX_INJECTION_MARKER}="2" rel="stylesheet" media="print" onload="this.media='all'" href="${interactiveLibraryUrl('katex', 'dist/katex.min.css')}">
<script ${KATEX_INJECTION_MARKER}="2"${defer} src="${interactiveLibraryUrl('katex')}"></script>
<script ${KATEX_INJECTION_MARKER}="2"${defer} src="${interactiveLibraryUrl('katex', 'dist/contrib/auto-render.min.js')}"></script>`;
  const katexInjection = `
<script ${KATEX_INJECTION_MARKER}="2">
(function () {
    var pending = [];
    window.__openmaicFlushMath = function () {
        if (window.katex && !window.katex.__openmaicStub) {
            pending.splice(0).forEach(function (args) { window.katex.render.apply(window.katex, args); });
        }
    };
    if (!window.katex) {
        window.katex = {
            __openmaicStub: true,
            render: function (tex, element) {
                if (element) {
                    element.textContent = String(tex);
                    pending.push(Array.prototype.slice.call(arguments));
                }
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
            window.__openmaicFlushMath();
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
${resources}
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

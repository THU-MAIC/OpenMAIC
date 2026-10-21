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

/** Marks the KaTeX markup this module injects, so a second pass adds nothing. */
const KATEX_INJECTION_MARKER = 'data-openmaic-katex';

/**
 * Main entry point: post-process generated interactive HTML
 * Converts LaTeX delimiters and injects KaTeX rendering resources.
 *
 * The platform's KaTeX is injected even when the page references KaTeX itself.
 * The page's own copy may not be there when the page needs it (an unreachable
 * CDN, a wrong `integrity` hash, an `async` tag), and a page that then calls
 * `renderMathInElement` or `katex.render` aborts with a ReferenceError.
 * The page's markup is left as authored.
 */
export function postProcessInteractiveHtml(html: string): string {
  // Convert LaTeX delimiters while protecting script tags
  let processed = convertLatexDelimiters(html);

  if (!processed.includes(KATEX_INJECTION_MARKER)) {
    processed = injectKatex(processed);
  }

  return processed;
}

/**
 * Convert LaTeX delimiters while protecting <script> tags.
 *
 * - Protects script blocks from modification
 * - Converts $$...$$ to \[...\] (display math)
 * - Converts $...$ to \(...\) (inline math)
 * - Restores script blocks after conversion
 */
function convertLatexDelimiters(html: string): string {
  const scriptBlocks: string[] = [];

  // Protect script tags by replacing them with placeholders
  let processed = html.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, (match) => {
    scriptBlocks.push(match);
    return `__SCRIPT_BLOCK_${scriptBlocks.length - 1}__`;
  });

  // Convert display math: $$...$$ -> \[...\]
  processed = processed.replace(/\$\$([^$]+)\$\$/g, '\\[$1\\]');

  // Convert inline math: $...$ -> \(...\)
  // Use non-greedy match and exclude newlines to avoid false positives
  processed = processed.replace(/\$(?!\{)([^$\n]+?)\$(?!\{)/g, '\\($1\\)');

  // Restore script blocks in a single pass. A replacer FUNCTION (not a string)
  // is safe even when script content contains `$` — a function's return value
  // is inserted literally, with no `$&`/`$1` substitution. The previous
  // indexOf+substring loop rebuilt the entire string once per block, i.e.
  // O(blocks × length), which balloons memory and blocks the event loop when
  // the generated widget HTML contains many <script> tags.
  processed = processed.replace(
    /__SCRIPT_BLOCK_(\d+)__/g,
    (whole, index) => scriptBlocks[Number(index)] ?? whole,
  );

  return processed;
}

/**
 * Inject KaTeX CSS, JS, auto-render, and a MutationObserver at the start of
 * <head>, ahead of every script the page authored.
 *
 * - The libraries load synchronously before the page's own scripts, so
 *   `katex` and `renderMathInElement` exist when those scripts and their
 *   DOMContentLoaded handlers run. A page that loads its own KaTeX later
 *   replaces these globals with the same library.
 * - When the CDN is unreachable, no-op stand-ins keep the page's own math
 *   calls from throwing; the math then stays as written.
 * - The render handler is registered before the page's handlers, so the
 *   observer is already watching when the page fills its labels.
 */
function injectKatex(html: string): string {
  const katexInjection = `
<link ${KATEX_INJECTION_MARKER} rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script ${KATEX_INJECTION_MARKER} src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script ${KATEX_INJECTION_MARKER} src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script ${KATEX_INJECTION_MARKER}>
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

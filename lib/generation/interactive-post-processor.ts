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

/**
 * Main entry point: post-process generated interactive HTML
 * Converts LaTeX delimiters and injects KaTeX rendering resources.
 */
export function postProcessInteractiveHtml(html: string): string {
  // Convert LaTeX delimiters while protecting script tags
  let processed = convertLatexDelimiters(html);

  // Inject KaTeX resources if not already present
  if (!processed.toLowerCase().includes('katex')) {
    processed = injectKatex(processed);
  }

  // Generated pronunciation widgets use this deterministic helper instead of
  // inventing a new (usually over-sensitive) string comparison per course.
  if (!processed.includes('OpenMAICPronunciation')) {
    processed = injectPronunciationScorer(processed);
  }
  if (!processed.includes('OpenMAICMicrophone')) {
    processed = injectMicrophoneBridge(processed);
  }

  return processed;
}

function injectMicrophoneBridge(html: string): string {
  const script = `<script>
window.OpenMAICMicrophone = window.OpenMAICMicrophone || (function () {
  var selectedDeviceId = '', muted = false, streams = [];
  function apply(stream) { stream.getAudioTracks().forEach(function (track) { track.enabled = !muted; }); }
  function remember(stream) { if (streams.indexOf(stream) < 0) streams.push(stream); apply(stream); return stream; }
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = function (constraints) {
      var next = constraints || {};
      if (next.audio && typeof next.audio === 'object' && selectedDeviceId) next = Object.assign({}, next, { audio: Object.assign({}, next.audio, { deviceId: { exact: selectedDeviceId } }) });
      return nativeGetUserMedia(next).then(remember);
    };
  }
  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type !== 'maic-microphone-control') return;
    if (typeof data.deviceId === 'string') selectedDeviceId = data.deviceId;
    if (typeof data.muted === 'boolean') muted = data.muted;
    streams.forEach(apply);
  });
  return { setMuted: function (value) { muted = !!value; streams.forEach(apply); }, setDeviceId: function (value) { selectedDeviceId = value || ''; } };
})();
</script>`;
  const headCloseIdx = html.indexOf('</head>');
  if (headCloseIdx !== -1) {
    return html.substring(0, headCloseIdx) + script + '\n</head>' + html.substring(headCloseIdx + 7);
  }
  const bodyCloseIdx = html.indexOf('</body>');
  if (bodyCloseIdx !== -1) {
    return html.substring(0, bodyCloseIdx) + script + '\n</body>' + html.substring(bodyCloseIdx + 7);
  }
  return html + script;
}

function injectPronunciationScorer(html: string): string {
  const script = `<script>
window.OpenMAICPronunciation = window.OpenMAICPronunciation || (function () {
  function words(value) {
    return String(value || '').toLocaleLowerCase('en-US').replace(/[\u0027\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\\s+/).filter(Boolean);
  }
  function score(expected, transcript, confidence) {
    var a = words(expected), b = words(transcript);
    if (!a.length || !b.length) return { score: 0, matchedWords: 0, expectedWords: a.length, recognizedWords: b.length, transcript: String(transcript || '') };
    var dp = Array.from({ length: a.length + 1 }, function () { return Array(b.length + 1).fill(0); });
    for (var i = 1; i <= a.length; i++) dp[i][0] = i;
    for (var j = 1; j <= b.length; j++) dp[0][j] = j;
    for (var x = 1; x <= a.length; x++) for (var y = 1; y <= b.length; y++) dp[x][y] = Math.min(dp[x-1][y] + 1, dp[x][y-1] + 1, dp[x-1][y-1] + (a[x-1] === b[y-1] ? 0 : 1));
    var x = a.length, y = b.length, matched = 0;
    while (x || y) {
      if (x && y && dp[x][y] === dp[x-1][y-1] && a[x-1] === b[y-1]) { matched++; x--; y--; }
      else if (x && y && dp[x][y] === dp[x-1][y-1] + 1) { x--; y--; }
      else if (x && dp[x][y] === dp[x-1][y] + 1) x--;
      else y--;
    }
    var lengthPenalty = Math.min(1, Math.abs(a.length - b.length) / a.length);
    var value = 100 * (0.85 * matched / a.length + 0.15 * (1 - lengthPenalty));
    if (typeof confidence === 'number' && isFinite(confidence) && confidence >= 0) value *= 0.8 + 0.2 * Math.max(0, Math.min(1, confidence));
    return { score: Math.round(Math.max(0, Math.min(100, value))), matchedWords: matched, expectedWords: a.length, recognizedWords: b.length, transcript: String(transcript || '') };
  }
  return { normalize: words, score: score };
})();
</script>`;
  const bodyCloseIdx = html.indexOf('</body>');
  if (bodyCloseIdx !== -1) {
    return html.substring(0, bodyCloseIdx) + script + '\n</body>' + html.substring(bodyCloseIdx + 7);
  }
  return html + script;
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
  let processed = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, (match) => {
    scriptBlocks.push(match);
    return `__SCRIPT_BLOCK_${scriptBlocks.length - 1}__`;
  });

  // Convert display math: $$...$$ -> \[...\]
  processed = processed.replace(/\$\$([^$]+)\$\$/g, '\\[$1\\]');

  // Convert inline math: $...$ -> \(...\)
  // Use non-greedy match and exclude newlines to avoid false positives
  processed = processed.replace(/\$([^$\n]+?)\$/g, '\\($1\\)');

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
 * Inject KaTeX CSS, JS, auto-render, and MutationObserver before </head>.
 * Falls back to appending at end if </head> is not found.
 */
function injectKatex(html: string): string {
  const katexInjection = `
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script>
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

    let renderTimeout;
    function safeRender() {
        if (renderTimeout) clearTimeout(renderTimeout);
        renderTimeout = setTimeout(() => {
            renderMathInElement(document.body, katexOptions);
        }, 100);
    }

    renderMathInElement(document.body, katexOptions);

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
</script>`;

  // Use indexOf + substring instead of String.replace() because the
  // katexInjection string contains '$' characters that .replace() would
  // interpret as special substitution patterns ($$ → $, $' → post-match text).
  const headCloseIdx = html.indexOf('</head>');
  if (headCloseIdx !== -1) {
    return (
      html.substring(0, headCloseIdx) +
      katexInjection +
      '\n</head>' +
      html.substring(headCloseIdx + 7)
    );
  }

  // Fallback: inject before </body> if </head> is missing
  const bodyCloseIdx = html.indexOf('</body>');
  if (bodyCloseIdx !== -1) {
    return (
      html.substring(0, bodyCloseIdx) +
      katexInjection +
      '\n</body>' +
      html.substring(bodyCloseIdx + 7)
    );
  }

  // Last resort: append at end
  return html + katexInjection;
}

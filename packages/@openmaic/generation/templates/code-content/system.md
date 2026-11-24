# Code Playground Widget Generator

Generate a self-contained HTML code editor with execution and test validation.

## Executable Languages

- Python (via Pyodide CDN)
- JavaScript (native browser execution)
- TypeScript (via Babel CDN transpilation)

For any other language, preserve the requested language in the lesson and use an
embedded worked example, step trace, or sample output. Label these as examples
and let teaching actions step through them. Offer a Run button only when the
page includes a supported browser runtime for the language.

## Widget Config Schema

```json
{
  "type": "code",
  "language": "python",
  "description": "...",
  "starterCode": "def solution(x):\n    # Your code here\n    pass",
  "testCases": [
    { "id": "t1", "input": "5", "expected": "25", "description": "Square the input" }
  ],
  "hints": ["Think about multiplication", "What is x * x?"],
  "solution": "def solution(x):\n    return x * x"
}
```

## Code Editor

Use CodeMirror 5.65.20 as the default editor with line numbers and syntax
highlighting. Load its stylesheet, core script, and the lesson's language mode
from fixed URLs using ordinary `<link>` and `<script>` tags. Load the core
before the mode. Do not use Monaco, workers, or a dynamic mode loader.

For Python, use this setup. Keep the textarea and use it if the editor cannot
load. Put the editor inside a visible `#code-editor-region` so teaching actions
can target the same element in both cases.

```html
<head>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.20/lib/codemirror.css">
  <script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.20/lib/codemirror.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.20/mode/python/python.js"></script>
</head>
<body>
  <div id="code-editor-region">
    <textarea id="code-input" aria-label="Code">def square(value):
    return value * value</textarea>
  </div>
  <script>
    const codeInput = document.getElementById('code-input');
    let editor = null;

    if (window.CodeMirror?.modes?.python) {
      const candidate = window.CodeMirror.fromTextArea(codeInput, { mode: 'python', lineNumbers: true });
      // Check the required scrollbar styling with either linked or inlined CSS.
      if (getComputedStyle(candidate.getScrollerElement()).overflowX === 'scroll') {
        editor = candidate;
      } else {
        candidate.toTextArea();
      }
    }
  </script>
</body>
```

For JavaScript or TypeScript, replace the Python script with
`https://cdn.jsdelivr.net/npm/codemirror@5.65.20/mode/javascript/javascript.js`.
Use `mode: 'javascript'` for JavaScript and
`mode: { name: 'javascript', typescript: true }` for TypeScript, and check that
the JavaScript mode loaded before initializing the editor. Use the matching
mode and its static dependencies from the same version for other languages.

## Python Execution Requirements (CRITICAL)

When generating Python widgets using Pyodide, follow these **mandatory patterns**:

### 1. Proper Stdout Capture Setup

**ALWAYS use this exact pattern for stdout capture:**
```javascript
// CORRECT - imports both sys AND io
await pyodide.runPythonAsync(`
    import sys
    import io
    sys.stdout = io.StringIO()
`);
```

**NEVER do this (causes NameError):**
```javascript
// WRONG - missing import io
pyodide.runPython('import sys; sys.stdout = io.StringIO()');
```

### 2. Use Async Execution

- Always use `pyodide.runPythonAsync()` instead of `pyodide.runPython()`
- Async execution is more reliable and handles module loading correctly
- All Pyodide operations should be wrapped in async functions

### 3. Load Required Packages Before Execution

If the lesson needs a package in the Pyodide distribution, declare it literally
in the startup code and wait for it before rendering the lesson view:
```javascript
await pyodide.loadPackage(['numpy']);
```

`micropip` can be used for an optional learner-initiated online feature. Keep
PyPI downloads out of startup and teaching actions. Load `micropip` before
importing it:

```javascript
await pyodide.loadPackage('micropip');
await pyodide.runPythonAsync(`
    import micropip
    await micropip.install('package-name')
`);
```

Never run `import micropip` before `loadPackage('micropip')` resolves, because
that aborts widget initialization with `ModuleNotFoundError`.

### 4. Wait for Pyodide Initialization

- Disable the run button until Pyodide is fully loaded
- Show loading status to users
- Check `pyodide !== null` before running code

### 5. Retrieve Output Correctly

```javascript
const output = pyodide.runPython('sys.stdout.getvalue()');
```

## Complete Python Widget Runtime Pattern

```javascript
let pyodide = null;

async function initPyodide() {
    pyodide = await loadPyodide();
    // Load the distribution packages explicitly required by this lesson here.
    document.getElementById('run-btn').disabled = false;
    document.getElementById('status').textContent = 'Python ready';
}
const ready = initPyodide();
window.__openmaicWaitForStaticRuntime?.(ready) ?? ready;

async function runCode() {
    if (!pyodide) {
        alert('Python environment not ready');
        return;
    }
    const input = document.getElementById('code-input');
    const code = typeof editor !== 'undefined' && typeof editor?.getValue === 'function'
        ? editor.getValue()
        : input?.value ?? '';
    try {
        // MUST import sys AND io before using StringIO
        await pyodide.runPythonAsync(`
            import sys
            import io
            sys.stdout = io.StringIO()
        `);
        await pyodide.runPythonAsync(code);
        const output = pyodide.runPython('sys.stdout.getvalue()');
        document.getElementById('output').textContent = output;
    } catch (e) {
        document.getElementById('output').textContent = `Error: ${e.message}`;
    }
}
```

## Technical Requirements

- Use CodeMirror with the appropriate syntax mode and a textarea fallback as described above
- For executable lessons, a Run button, output display, and test case validation with pass/fail indicators
- For worked-example lessons, controls to move through the embedded trace and inspect the sample output
- Hint button that reveals hints progressively
- Mobile-responsive layout

## Layout Guidelines

- Code editor should be visible and not overlap with output panel
- On mobile, stack editor above output (not side-by-side)
- Ensure editor has minimum height of 200px on mobile
- Test cases should be collapsible on small screens

## CRITICAL: postMessage Listener for Widget Actions (REQUIRED)

The platform drives this widget by posting messages into the iframe
(`SET_WIDGET_STATE`, `HIGHLIGHT_ELEMENT`, `ANNOTATE_ELEMENT`, `REVEAL_ELEMENT`).
Your HTML MUST register this listener, or those actions silently do nothing.
For a code playground, `SET_WIDGET_STATE` typically loads code into the editor and
optionally runs it. Target `#code-editor-region` when highlighting or annotating
the editor:

```javascript
window.addEventListener('message', function(event) {
  const { type, target, state, content } = event.data;

  switch (type) {
    case 'SET_WIDGET_STATE':
      // e.g. { code: "...", run: true } — set editor contents, optionally run.
      if (state && typeof state.code === 'string') {
        // Guard the identifier itself: `editor?.setValue` still throws
        // ReferenceError when no `editor` variable is declared (e.g. a
        // textarea-only widget). `typeof editor` is safe for that case.
        if (typeof editor !== 'undefined' && typeof editor?.setValue === 'function') editor.setValue(state.code);
        else { const ta = document.getElementById('code-input'); if (ta) ta.value = state.code; }
      }
      if (state && state.run && typeof runCode === 'function') {
        const rendered = runCode();
        window.__openmaicWaitForStaticRuntime?.(rendered) ?? rendered;
      }
      break;

    case 'HIGHLIGHT_ELEMENT':
      const highlightEl = document.querySelector(target);
      if (highlightEl) {
        highlightEl.style.outline = '3px solid rgba(139, 92, 246, 0.8)';
        highlightEl.style.outlineOffset = '4px';
        highlightEl.style.animation = 'pulse-highlight 2s infinite';
        setTimeout(() => {
          highlightEl.style.outline = '';
          highlightEl.style.animation = '';
        }, 3000);
      }
      break;

    case 'ANNOTATE_ELEMENT':
      const annotateEl = document.querySelector(target);
      if (annotateEl && content) {
        const rect = annotateEl.getBoundingClientRect();
        const tooltip = document.createElement('div');
        tooltip.className = 'teacher-annotation';
        tooltip.style.cssText = 'position:fixed; top:' + (rect.top - 40) + 'px; left:' + rect.left + 'px; background:rgba(139,92,246,0.95); color:white; padding:8px 12px; border-radius:8px; font-size:14px; z-index:1000; animation:fadeIn 0.3s;';
        tooltip.textContent = content;
        document.body.appendChild(tooltip);
        setTimeout(() => tooltip.remove(), 4000);
      }
      break;

    case 'REVEAL_ELEMENT':
      // Reveal a hidden element (e.g. the solution or a hint panel)
      const revealEl = document.querySelector(target);
      if (revealEl) {
        revealEl.removeAttribute('hidden'); // Works for HTML and SVG elements
        revealEl.classList.remove('hidden');
        revealEl.style.display = '';
        revealEl.style.opacity = '1';
      }
      break;
  }
});

const style = document.createElement('style');
style.textContent = '@keyframes pulse-highlight { 0%, 100% { outline-color: rgba(139, 92, 246, 0.8); } 50% { outline-color: rgba(139, 92, 246, 0.4); } } @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }';
document.head.appendChild(style);
```

### Element Naming Convention

So highlight/annotate/reveal can target UI, use consistent ids:
- Run button: `id="run-btn"`, output panel: `id="output"`, editor host: `id="code-input"`.
- Solution/hint panels: `id="solution"`, `id="hint-{n}"`.

## Output Format

Return ONLY the HTML document, no markdown fences or explanations.

**CRITICAL: Output EXACTLY ONE HTML document.**
- Do NOT duplicate content
- Do NOT include multiple `<!DOCTYPE html>` tags
- The output must end with exactly one `</html>` tag

## Quality Checklist

- [ ] Code editor is visible and usable on mobile
- [ ] Run button works correctly
- [ ] Output panel doesn't overlap editor
- [ ] Test cases show pass/fail clearly
- [ ] Hints reveal progressively
- [ ] **NO DUPLICATED HTML** - exactly ONE `<!DOCTYPE html>` tag
- [ ] **Python stdout uses correct import pattern** - imports BOTH `sys` AND `io`
- [ ] **Pyodide uses async execution** - `runPythonAsync()` not `runPython()`


{{snippet:interactive-libraries}}

{{snippet:interactive-math}}

{{snippet:interactive-observation}}

{{snippet:interactive-display-state}}

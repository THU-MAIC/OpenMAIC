# Code Playground Widget Generator

Generate a self-contained HTML code editor with execution and test validation.

## Supported Languages

- Python (via Pyodide CDN)
- JavaScript (native browser execution)
- TypeScript (via Babel CDN transpilation)

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

If user code needs packages like numpy, load them during initialization:
```javascript
await pyodide.loadPackage(['numpy']);
```

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
    // Load any packages user code might need
    await pyodide.loadPackage(['numpy']);
    document.getElementById('run-btn').disabled = false;
    document.getElementById('status').textContent = 'Python ready';
}
initPyodide();

async function runCode() {
    if (!pyodide) {
        alert('Python environment not ready');
        return;
    }
    const code = editor.getValue();
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

- Use CodeMirror or Monaco via CDN for editing
- Syntax highlighting for the language
- Run button with output display
- Test case validation with pass/fail indicators
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
optionally runs it:

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
        if (typeof editor !== 'undefined' && typeof editor.setValue === 'function') editor.setValue(state.code);
        else { const ta = document.getElementById('code-input'); if (ta) ta.value = state.code; }
      }
      if (state && state.run && typeof runCode === 'function') runCode();
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

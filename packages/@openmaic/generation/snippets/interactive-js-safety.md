## JavaScript Safety Rules (MANDATORY)

Your inline `<script>` runs directly in the learner's browser. A single runtime
error — a `ReferenceError` or `TypeError` — makes the ENTIRE interactive page
blank and unusable. The platform does NOT tolerate these. Follow every rule
below, without exception.

1. **Declare every variable.** Always use `const` / `let`. Never assume an
   element's `id` becomes a global variable. If the HTML has
   `<div id="canvas-container">`, you MUST write:
   ```javascript
   const canvasContainer = document.getElementById('canvas-container');
   if (!canvasContainer) { /* guard or return */ }
   ```
   Referencing `canvasContainer` (or any element id) as a bare identifier without
   declaring it throws `ReferenceError: canvasContainer is not defined`.

2. **Fetch the DOM explicitly.** Always obtain elements with
   `document.getElementById('id')` or `document.querySelector(...)`, and
   **null-check the result before reading or writing any property**.

3. **Every slider / range / input control MUST carry a `data-var="<variableName>"`
   attribute** that matches its key in the widget config `variables`. Read it as
   `element.dataset.var` and guard when it is missing:
   ```javascript
   const variable = slider.dataset.var;
   if (!variable) return;
   ```

4. **Do NOT build property names dynamically to read undeclared state.** A pattern
   like `state[\`${variable}Display\`].textContent = ...` throws `TypeError` when
   that key does not exist. Declare the display element explicitly and assign to
   it directly:
   ```javascript
   const objectDensityDisplay = document.getElementById('object-density-display');
   // later, guarded:
   if (objectDensityDisplay) objectDensityDisplay.textContent = value.toFixed(2);
   ```

5. **Wrap event handlers defensively.** The platform dispatches `input` and
   `click` events during widget initialization; any thrown error there blanks the
   page. Guard every `getElementById` / `querySelector` result and every indexed
   access inside handlers.

6. **Self-check before finishing.** Mentally execute the top-level script and one
   `input` event per slider. If any line would throw, rewrite it. A page that
   loads but throws on init is a failed page.

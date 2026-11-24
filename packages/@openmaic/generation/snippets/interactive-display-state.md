## REQUIRED: what the page shows must match its state

Each rule below prevents a failure that is still valid JavaScript, so a syntax check accepts it and only the browser shows it.

**A hidden layer stays hidden.** An author `display` rule (`display: grid`, `flex`, `block`) overrides the `hidden` attribute, so an error or result layer marked `hidden` would still cover the page. Whenever an element that can carry `hidden` also gets a `display` value, include this rule once:

```css
[hidden]:not([hidden="until-found"]) { display: none !important; }
```

Show and hide such an element only through the attribute: `element.removeAttribute('hidden')` to show it and `element.setAttribute('hidden', '')` to hide it, which also works for SVG elements. Never show it by setting `style.display`; the rule above wins over inline styles. This includes `REVEAL_ELEMENT` handlers. Show an error layer only from the path that detected the failure (for example `getContext('2d')` returned `null`, or initialization threw), never by default.

**A drawing surface never sizes the element it is measured from.** Give the container of a canvas, SVG or WebGL renderer a size that does not depend on its content: let it fill the remaining space of a full-viewport layout, or give it a bounded height (for example `clamp(260px, 60vh, 640px)` when the layout stacks on narrow screens) or an `aspect-ratio`. Make it `position: relative`, and place the surface inside it with `position: absolute; inset: 0; width: 100%; height: 100%`. Read sizes only from the container, and never write a measured size to the container's `style`. When the container's height comes from its content and the surface sits in that flow, each resize enlarges the element being observed, and the drawing grows until it disappears.

For a 2D canvas, set `canvas.width` and `canvas.height` to the container's `clientWidth` and `clientHeight` times `devicePixelRatio`, only when they changed, then call `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`. Do all drawing and layout math in the container's CSS size, never in `canvas.width` or `canvas.height`, which are device pixels and would place objects and margins off by the pixel ratio.

**One render path from state to screen.** Keep one render function (`render()`, or the one the template names, such as `renderStep()`) that writes every readout, label, button text and enabled state, and redraws, from the current state. Initialization, every update, presets, `SET_WIDGET_STATE` and reset all call it. Reset stops the timers and animation loops that advance the activity, rebuilds the state from the same initial values used at startup, then calls the render function. A loop that only redraws, such as a 3D scene's render loop, keeps running. Resetting the state without rendering leaves readouts showing the previous run.

**Make the initial view and teaching actions work offline.** Render the initial lesson view and every teaching action in the browser using embedded data or assets referenced by ordinary HTML, CSS or static module imports. Use fixed, versioned asset URLs. Avoid network APIs, workers, nested frames and runtime downloads for these paths. If a program needs to load an individual script or data file by a computed URL, declare each exact absolute HTTP(S) URL in a `<script type="application/json" data-openmaic-offline-assets>` JSON array. Resolve a script or other DOM asset with `window.__openmaicOfflineAsset?.(url) ?? url`. Read a data or WebAssembly file with `window.__openmaicFetchOfflineAsset?.(url) ?? fetch(url)`. The declared file and its lesson prerequisites must fit in the export bundle. Features that require an online service or a runtime unavailable in the browser need an embedded lesson example that works at startup and responds to teaching actions.

**Report readiness after drawing.** For asynchronous initialization, pass the entire initialization promise to `window.__openmaicWaitForStaticRuntime` when available. Resolve it only after the initial view is rendered and after the last required canvas or WebGL draw. Use the same hook when a teaching message needs asynchronous work before it can update the view. An action should render its new state immediately after that work, with timers reserved for effects that change later on the lesson timeline. Long-running loops and interactive features that wait for learner input stay outside the readiness promise.

For a teaching action that starts independent browser work while unrelated timed effects are active, register its promise with `{ blockCapture: true }`. Use that option only if the work can finish at the current lesson time. Work waiting for a future timer or animation frame must allow the lesson clock to advance.

```javascript
const ready = initializeAndRender(); // resolves after the first meaningful view is drawn
(window.__openmaicWaitForStaticRuntime?.(ready) ?? ready).catch(showStartupError);
```

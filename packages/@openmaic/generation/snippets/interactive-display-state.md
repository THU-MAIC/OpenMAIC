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

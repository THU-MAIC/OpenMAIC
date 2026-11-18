# Simulation Widget Content Generator

Generate a self-contained HTML simulation with embedded widget configuration.

## Output Structure

Your output must be a complete HTML document with:

1. **Standard HTML5 structure**
2. **Embedded widget configuration** in a `<script type="application/json" id="widget-config">` tag
3. **Interactive controls** for variables
4. **Canvas or SVG visualization**
5. **Mobile-responsive design**
6. **postMessage listener** for widget actions (REQUIRED)

## Widget Config Schema

```json
{
  "type": "simulation",
  "concept": "projectile_motion",
  "description": "...",
  "variables": [
    { "name": "angle", "label": "Launch Angle", "min": 0, "max": 90, "default": 45, "unit": "°" }
  ],
  "presets": [
    { "name": "Hit the target", "variables": { "angle": 30, "velocity": 25 } }
  ]
}
```

## CRITICAL: postMessage Listener for Widget Actions

Your HTML MUST include this message listener to respond to widget actions:

```javascript
// Add this script at the end of your HTML
window.addEventListener('message', function(event) {
  const { type, target, state, content } = event.data;

  switch (type) {
    case 'SET_WIDGET_STATE':
      // Update all variables in the state object
      if (state) {
        Object.entries(state).forEach(([key, value]) => {
          // Find the slider/input for this variable and update it
          const slider = document.getElementById(key + '-slider') || document.querySelector('[data-var="' + key + '"]');
          if (slider) {
            slider.value = value;
            // Trigger change event to update simulation
            slider.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
      }
      break;

    case 'HIGHLIGHT_ELEMENT':
      // Highlight the target element with a pulsing border
      const highlightEl = document.querySelector(target);
      if (highlightEl) {
        highlightEl.style.outline = '3px solid rgba(139, 92, 246, 0.8)';
        highlightEl.style.outlineOffset = '4px';
        highlightEl.style.animation = 'pulse-highlight 2s infinite';
        // Remove highlight after 3 seconds
        setTimeout(() => {
          highlightEl.style.outline = '';
          highlightEl.style.animation = '';
        }, 3000);
      }
      break;

    case 'ANNOTATE_ELEMENT':
      // Show an annotation tooltip near the target element
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
      // Reveal a hidden element
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

// Add this CSS for animations
const style = document.createElement('style');
style.textContent = '@keyframes pulse-highlight { 0%, 100% { outline-color: rgba(139, 92, 246, 0.8); } 50% { outline-color: rgba(139, 92, 246, 0.4); } } @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }';
document.head.appendChild(style);
```

## Element Naming Convention

To make highlight/annotation work, use consistent IDs for controls:
- Sliders: `id="{variable_name}-slider"` (e.g., `id="angle-slider"`, `id="velocity-slider"`)
- Buttons: `id="{action}-btn"` (e.g., `id="start-btn"`, `id="reset-btn"`)
- Displays: `id="{variable_name}-display"` (e.g., `id="acceleration-display"`)

## CRITICAL Design Requirements

### 1. Mobile Layout - NO OVERLAP
- **Control panel MUST NOT overlap with canvas on mobile**
- Use one of these mobile-safe layouts:
  - **Stacked layout**: Control panel on top, canvas below (with proper spacing)
  - **Bottom sheet**: Control panel slides up from bottom on mobile
  - **Side drawer**: Collapsible panel that doesn't block canvas
- Test viewport widths: 320px, 375px, 414px, 768px
- Give the canvas stage a bounded height so it stays visible on mobile
- Control panel should be collapsible on mobile if large

Example mobile-safe layout:
```html
<style>
  [hidden]:not([hidden="until-found"]) { display: none !important; }
  /* The stage's size never depends on the canvas, which sits out of flow inside it:
     a bounded height when stacked, the full row height side by side. */
  #stage { position: relative; flex: 1 1 auto; min-width: 0; height: clamp(260px, 60vh, 640px); }
  @media (min-width: 768px) { #stage { height: auto; align-self: stretch; } }
  #canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  #canvas-error { position: absolute; inset: 0; display: grid; place-items: center; }
</style>
<body class="flex flex-col min-h-screen md:flex-row">
  <!-- Mobile: Full-width, collapsible control panel -->
  <div id="controls" class="w-full md:w-80 shrink-0 overflow-auto max-h-[40vh] md:max-h-screen">
    <button id="start-btn" onclick="handleMainButton()"></button>
    <button id="reset-btn" onclick="resetSimulation()">Reset</button>
    <p>Time: <span id="time-display"></span></p>
    <p>Velocity: <span id="velocity-display"></span></p>
    <button onclick="toggleControls()" class="md:hidden">Hide Controls</button>
  </div>
  <div id="stage">
    <canvas id="canvas"></canvas>
    <div id="canvas-error" hidden>Canvas unavailable</div>
  </div>
</body>
```

### 2. Reset Button - MUST WORK CORRECTLY
- **Reset button MUST return simulation to initial state**
- Common bug: Button changes text to "重新开始" but clicking it doesn't reset
- Common bug: Reset restores the state but the readouts keep showing the previous run
- Solution: Use a separate reset function that rebuilds the state, then calls the same `render()` as startup and every update

Correct implementation:
```javascript
function initialState() {
  return { running: false, paused: false, ended: false, time: 0, posX: 50, velocity: 0 };
}
let state = initialState();
let frameId = null;
let lastFrameTime = null;

function buttonLabel() {
  if (state.ended) return 'Restart';
  if (state.running) return 'Pause';
  return state.paused ? 'Resume' : 'Start';
}

// The one path from state to screen: every readout, the button text and the drawing.
function render() {
  document.getElementById('time-display').textContent = state.time.toFixed(1) + ' s';
  document.getElementById('velocity-display').textContent = state.velocity.toFixed(1) + ' m/s';
  document.getElementById('start-btn').textContent = buttonLabel();
  draw();
  publishCurrentState();
}

function handleMainButton() {
  if (state.ended) {
    // If simulation ended, reset first
    resetSimulation();
  } else if (state.running) {
    pauseSimulation();
  } else {
    startSimulation(); // Starts, or resumes after a pause
  }
}

function startSimulation() {
  state.running = true;
  state.paused = false;
  lastFrameTime = null;
  render();
  frameId = requestAnimationFrame(step);
}

function pauseSimulation() {
  state.running = false;
  state.paused = true;
  cancelAnimationFrame(frameId);
  render();
}

// Advance by the real time since the last frame, so the speed does not depend
// on the display's refresh rate.
function step(now) {
  const dt = lastFrameTime === null ? 0 : Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  state.time += dt;
  state.velocity += 9.8 * dt;
  state.posX += state.velocity * dt;
  if (state.posX >= 400) {
    onSimulationEnd();
    return;
  }
  render();
  frameId = requestAnimationFrame(step);
}

function resetSimulation() {
  cancelAnimationFrame(frameId); // Stop the loop first
  state = initialState();        // The same initial values as startup
  render();                      // Readouts, button and drawing all follow the state
}

// When simulation hits boundary/ends:
function onSimulationEnd() {
  state.running = false;
  state.ended = true;
  render();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'r' || event.key === 'R') resetSimulation();
});

// The initial render() runs once at startup, after the canvas setup below.
```

### 3. Button State Management
- Use clear state variables: `running`, `paused`, `ended`
- Button text should reflect what will happen when clicked:
  - "启动" / "开始" → Start simulation
  - "暂停" / "暂停" → Pause running simulation
  - "继续" / "继续" → Resume paused simulation
  - "重新开始" / "重试" → Reset and start fresh (when ended)
- One button should NOT do different things based on text alone

### 4. Touch-Friendly Controls
- Minimum touch target: 44x44px for buttons
- Sliders: Increase thumb size for mobile (min 24px)
- Add `touch-action: manipulation` to prevent double-tap zoom
- Use `touch-action: none` on canvas for custom gesture handling

### 5. Canvas Sizing
- Measure the stage, never the canvas: the stage's size must not depend on the canvas (see the layout example)
- Apply `devicePixelRatio` once, and assign the bitmap size only when it changed
- Draw and position everything in the stage's CSS size, never in `canvas.width` / `canvas.height` (device pixels)
- Never write a measured size back to `canvas.style` or to the stage
- Don't use fixed pixel dimensions
- Account for control panel height on mobile

```javascript
const stage = document.getElementById('stage');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(stage.clientWidth * dpr);
  const height = Math.round(stage.clientHeight * dpr);
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width; // Resizing the bitmap clears it and resets the transform
  canvas.height = height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // Draw in CSS pixels
  draw();
}

function draw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  // Draw the current state here, in CSS pixels.
}

if (ctx) {
  new ResizeObserver(resizeCanvas).observe(stage); // Observing also runs the first resize
} else {
  document.getElementById('canvas-error').removeAttribute('hidden'); // The only path that shows it
}

render(); // Initial state, before any user action
```

### 6. Visual Feedback
- Clear indication when simulation starts/pauses/ends
- Show current state in UI (running indicator, paused icon)
- Highlight end boundary or target
- Show success/failure message when simulation ends
- Animate the "重新开始" button appearance

### 7. Visible Animation (CRITICAL)

**When the user clicks "启动" (Start), there MUST be OBVIOUS visual animation.**

#### Animation Requirements:
1. **Moving objects**: Objects should visibly move, rotate, or change when simulation runs
2. **Clear motion**: Animation should be immediately noticeable - not subtle
3. **Rotation animations**: For spinning/rotating objects (earth, wheels, etc.), show actual rotation:
   ```javascript
   // GOOD: Earth visibly rotates
   function draw() {
     ctx.clearRect(0, 0, w, h);
     ctx.save();
     ctx.translate(centerX, centerY);
     ctx.rotate(rotationAngle); // Earth rotates!
     // Draw earth content...
     ctx.restore();

     if (state.running) {
       rotationAngle += 0.02 * state.speed; // Update rotation
     }
   }
   ```
4. **Multiple visual cues**: Combine motion with other feedback:
   - Object position/rotation changes
   - Clock/timer updates
   - Color changes or highlights
   - Particle effects for dynamic simulations

#### BAD Example (User can't tell if it's running):
```javascript
// Earth is static 2D circle, only time number changes
// User clicks "Start" → Nothing visibly moves → Confusing!
```

#### GOOD Example (Clear visual feedback):
```javascript
// Earth rotates, sun position moves, day/night boundary shifts
// User clicks "Start" → Earth visibly spins → Satisfying!
```

### 8. Data Display
- Real-time values should be clearly visible
- Use monospace font for numbers
- Show units consistently
- Consider a floating info panel that doesn't block the simulation

### 9. Presets
- Each preset should clearly describe what it demonstrates
- Preset buttons should be touch-friendly (larger on mobile)
- Applying a preset should reset the simulation

### 10. Accessibility
- ARIA labels on all controls
- Keyboard support (Space to start/pause, R to reset)
- Focus indicators
- High contrast text on canvas

### 11. Performance
- Use `requestAnimationFrame` for animations
- Clear canvas each frame
- Don't create objects in render loop
- Throttle slider input events if needed

## Common Bugs to Avoid

| Bug | Cause | Solution |
|-----|-------|----------|
| Reset doesn't work | Button calls wrong function | Ensure reset function resets ALL state variables |
| Readouts show the previous run after reset | Reset changes state without rendering | Rebuild the state, then call the one `render()` |
| Error message covers a working canvas | `display: grid` on the layer overrides `hidden` | Add the `[hidden]` rule; show the layer only on a detected failure |
| Canvas keeps growing until it is blank | Canvas in the flow of the stage it measures | Bounded stage, absolutely positioned canvas, bitmap size from the stage only |
| Canvas overlap on mobile | Fixed positioning | Use flex/grid with proper responsive classes |
| Simulation stuck | Missing `ended` state | Track `ended` separately from `running` |
| Button does nothing | State logic error | Clear state machine with defined transitions |
| Touch issues | Small touch targets | Min 44px touch targets, larger sliders |

## Output Format

Return ONLY the HTML document, no markdown fences or explanations.

**CRITICAL: Output EXACTLY ONE HTML document.**
- Do NOT duplicate content
- Do NOT include multiple `<!DOCTYPE html>` tags
- The output must end with exactly one `</html>` tag

## Object Positioning with UI Overlays

When calculating positions for simulation objects, account for UI overlays:

```javascript
// Positions are in CSS pixels: use the stage's size, not canvas.height (device pixels).
const height = stage.clientHeight;

// BAD: Object overlaps with controls/HUD
const objectY = baseY - (value / maxValue) * height;

// GOOD: Reserve space for UI elements
const TOP_MARGIN = 100;    // Space for HUD/stats at top
const BOTTOM_MARGIN = 200; // Space for controls at bottom
const playableHeight = height - TOP_MARGIN - BOTTOM_MARGIN;
const objectY = baseY - BOTTOM_MARGIN - (value / maxValue) * playableHeight;
```

## Quality Checklist (verify before output)

- [ ] Control panel does NOT overlap canvas on mobile (test 320px width)
- [ ] Reset button returns simulation to EXACT initial state
- [ ] Button text matches button action correctly
- [ ] Touch targets are at least 44px
- [ ] Canvas size settles after a resize: bounded stage, canvas out of its flow
- [ ] Error layers stay hidden unless a failure was detected
- [ ] State machine is clear (running/paused/ended)
- [ ] All state variables reset on resetSimulation(), and every readout and button label follows
- [ ] Works on both desktop and mobile browsers
- [ ] **NO DUPLICATED HTML** - exactly ONE `<!DOCTYPE html>` tag
- [ ] Simulation objects are visible and not hidden under UI overlays
- [ ] **Visible animation: Objects visibly move/rotate when simulation runs**
- [ ] **Animation is OBVIOUS, not subtle - user can tell simulation is running**


{{snippet:interactive-libraries}}

{{snippet:interactive-math}}

{{snippet:interactive-observation}}

{{snippet:interactive-display-state}}

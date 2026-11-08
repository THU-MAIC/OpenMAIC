# Interactive Diagram Generator

Generate a self-contained HTML diagram with connected nodes.

## Data Schema

```json
{
  "nodes": [
    { "id": "n1", "label": "Label", "icon": "🎯", "details": "Description" }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "next" }
  ],
  "revealOrder": ["n1", "n2"]
}
```

## Core Requirements

1. **SVG-based** with embedded JSON config
2. **First node visible** on load
3. **High contrast**: White nodes on dark background, light edge labels
4. **Edges connect to node edges** (account for node dimensions and arrow offset)
5. **Mobile**: Sidebar/panel collapsible, doesn't block diagram
6. **No jitter**: Never apply a CSS `transform` to an element that already carries an SVG `transform` attribute
7. **All nodes connected**: No orphan nodes

## Node Structure

Positioning and animation MUST live on separate elements.

```html
<!-- Outer <g>: position only. Never target this element with a CSS transform. -->
<g id="node-n1" class="node" transform="translate(320, 180)">
  <!-- Inner <g>: every hover/active animation goes here. -->
  <g class="node-body">
    <rect x="-90" y="-35" width="180" height="70" rx="12"></rect>
    <text text-anchor="middle" dy="6">Label</text>
  </g>
</g>
```

```css
/* Correct: animates the inner group, so the node keeps its position. */
.node:hover .node-body { transform: translateY(-4px); }
.node:active .node-body { transform: scale(0.98); }

/* WRONG: wipes out translate(320, 180) and snaps the node to the origin. */
.node:hover { transform: translateY(-4px); }
```

The `<rect>` is centred on the group origin, so each node's `translate()` is its
centre — which is what the edge maths below expects for `from.x`/`from.y`.

## Edge Connection Code

```javascript
const NODE_WIDTH = 180, NODE_HEIGHT = 70, ARROW_OFFSET = 10;

function getEdgePoints(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    let sx, sy, ex, ey;

    if (Math.abs(dy) > Math.abs(dx)) { // Vertical
        sx = from.x;
        sy = dy > 0 ? from.y + NODE_HEIGHT/2 : from.y - NODE_HEIGHT/2;
        ex = to.x;
        ey = dy > 0 ? to.y - NODE_HEIGHT/2 - ARROW_OFFSET : to.y + NODE_HEIGHT/2 + ARROW_OFFSET;
    } else { // Horizontal
        sx = dx > 0 ? from.x + NODE_WIDTH/2 : from.x - NODE_WIDTH/2;
        sy = from.y;
        ex = dx > 0 ? to.x - NODE_WIDTH/2 - ARROW_OFFSET : to.x + NODE_WIDTH/2 + ARROW_OFFSET;
        ey = to.y;
    }
    return `M ${sx} ${sy} L ${ex} ${ey}`;
}
```

## Step State

Keep all reveal state in one `revealedCount` (how many `revealOrder` entries are shown, starting at 1) and one `renderStep()` derived from it. Next, Back, reset and the listener below only change `revealedCount` and call `renderStep()`. It alone decides which nodes and edges are shown, and it also updates the step label, the Next/Back disabled state, the detail panel and the state publication, so learner clicks and narration can never disagree.

Hide nodes from `renderStep()` only. A message handler must not write `display` or `opacity` on a node group: the inline style would survive `renderStep()` and Back could no longer hide that node.

## CRITICAL: postMessage Listener for Widget Actions (REQUIRED)

The platform drives this widget by posting messages into the iframe
(`SET_WIDGET_STATE`, `HIGHLIGHT_ELEMENT`, `ANNOTATE_ELEMENT`, `REVEAL_ELEMENT`).
Your HTML MUST register this listener, or those actions silently do nothing.
Narration moves the diagram with `REVEAL_ELEMENT` targeting `#node-{id}`:

```javascript
// Add this script at the end of your HTML, after revealOrder, revealedCount and renderStep exist.

// Move forward to a node, through step state. Never moves backwards: a learner
// who has already stepped further keeps their position.
function revealThroughNode(id) {
  const index = revealOrder.indexOf(id);
  if (index + 1 > revealedCount) {
    revealedCount = index + 1;
    renderStep();
  }
}

function targetNodeId(target) {
  const id = String(target).replace(/^#node-/, '');
  return revealOrder.includes(id) ? id : null;
}

// A node must be shown before it can be highlighted or annotated. An unknown or
// invalid selector resolves to null, so that message does nothing.
function showTarget(target) {
  const nodeId = targetNodeId(target);
  if (nodeId) revealThroughNode(nodeId);
  try {
    return document.querySelector(target);
  } catch {
    return null;
  }
}

window.addEventListener('message', function(event) {
  const { type, target, state, content } = event.data;

  switch (type) {
    case 'SET_WIDGET_STATE':
      // Apply state keyed by node id (the JSON node ids).
      if (state) {
        Object.entries(state).forEach(([key, value]) => {
          if (value) revealThroughNode(key);
          const node = document.getElementById('node-' + key);
          const body = node && node.querySelector('.node-body');
          if (body) {
            body.style.opacity = value ? '1' : '0.35';
            node.classList.toggle('active', !!value);
          }
        });
      }
      break;

    case 'HIGHLIGHT_ELEMENT':
      // Highlight the target element with a pulsing border
      const highlightEl = showTarget(target);
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
      // Show an annotation tooltip near the target element
      const annotateEl = showTarget(target);
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
      // Nodes reveal through step state; any other element reveals directly.
      const revealEl = showTarget(target);
      if (revealEl && !targetNodeId(target)) {
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

### Element Naming Convention

So highlight/annotate/reveal can target nodes, every node has one stable id, whether it is written in the markup or built by script:
- Node groups: always `id="node-{id}"`, with `{id}` exactly as in the JSON `id`. Do not use other id patterns for nodes.
- Edge labels: `id="edge-{from}-{to}"` if they need to be targeted.

## Output

Return exactly ONE complete HTML document. No markdown fences, no duplication.

{{snippet:interactive-libraries}}

{{snippet:interactive-math}}

{{snippet:interactive-observation}}

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
6. **No jitter**: Avoid hover transform conflicts on click
7. **All nodes connected**: No orphan nodes

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

## CRITICAL: postMessage Listener for Widget Actions (REQUIRED)

The platform drives this widget by posting messages into the iframe
(`SET_WIDGET_STATE`, `HIGHLIGHT_ELEMENT`, `ANNOTATE_ELEMENT`, `REVEAL_ELEMENT`).
Your HTML MUST register this listener, or those actions silently do nothing:

```javascript
// Add this script at the end of your HTML
window.addEventListener('message', function(event) {
  const { type, target, state, content } = event.data;

  switch (type) {
    case 'SET_WIDGET_STATE':
      // Apply state keyed by node id. Use the same convention as REVEAL_ELEMENT:
      // each diagram node is `id="node-{id}"` (matching the JSON node ids).
      if (state) {
        Object.entries(state).forEach(([key, value]) => {
          const node = document.getElementById('node-' + key) || document.querySelector('[data-node="' + key + '"]');
          if (node) {
            node.style.opacity = value ? '1' : '0.35';
            node.classList.toggle('active', !!value);
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
      // Reveal a hidden node/element
      const revealEl = document.querySelector(target);
      if (revealEl) {
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

So highlight/annotate/reveal can target nodes, give each node a stable id:
- Node groups: `id="node-{id}"` (e.g., `id="node-n1"`), matching the JSON `id`.
- Edge labels: `id="edge-{from}-{to}"` if they need to be targeted.

## Output

Return exactly ONE complete HTML document. No markdown fences, no duplication.
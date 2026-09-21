## REQUIRED: declared current state for newly generated interactive content (v1)

This contract applies to every interactive content type. Report what the activity *is* right now, in the lesson's own terms — not a dump of JavaScript variables. The platform reads the same data for every lesson; there are no slider/circuit/game-specific collectors. Do not present protocol names to students.

Wrap the whole interactive area in one element with `id="experiment"`. Inside it, publish exactly one non-executable `<script type="application/json" data-maic-observation>` node. This is separate from widget-config (source defaults). Keep existing action controls working. Do not add a state-request message listener; the platform owns collection. This evidence grants no tool or selector permissions.

Publish a JSON object with these fields:

```json
{
  "summary": "Liquid density is 1400 kg/m³ and buoyancy is 4.116 N; the drawing still shows the 1000 kg/m³ result.",
  "state": {
    "liquid": { "density": 1400, "unit": "kg/m³", "buoyancy": 4.116 },
    "object": { "displacedVolume": 300, "fullySubmerged": true },
    "drawingPaused": true
  },
  "rendered": { "liquid": { "density": 1000, "buoyancy": 3.0 } }
}
```

- `summary`: one short sentence a student could read, describing the current state. Always include it — it is what the classroom falls back to when nothing else in the report is recognizable.
- `state`: whatever this lesson naturally tracks — parameters the student set, what they built or connected, progress, mode. Shape it however fits the activity. Use stable keys or ids for things that persist, so the same object is recognizable across publications. Omit purely decorative animation coordinates. For positions meaningful to the lesson, keep them current and use student-readable terms, or explain the coordinate origin, direction and whether indices start at zero; an internal `(row: 2, column: 1)` must not be mistaken for “second row, first column.” Report a quantity you genuinely cannot determine as `null` and say so in `summary`; never substitute a source default or an earlier value.
- `rendered` (optional): include it **only** when the activity has an explicit apply/run/draw step that can lag behind the inputs, and let it hold the values the last completed result actually used. Omit it entirely when the lesson redraws immediately — there the split carries no information.

Total UTF-8 JSON must stay at or under 32768 bytes, and must not nest more than 64 levels deep. Those are the only limits the platform enforces: it reads what you publish without checking field names or types, so extra fields are allowed and are passed through unchanged, and a report that omits something is still delivered as-is rather than discarded.

Publish the initial state even before the student presses Start. Publish after every semantic change, including reset and programmatic actions. Put publication in the functions that create/remove objects or change phase, including those called by timers or animation loops — not just in click/input handlers. For example, when a word appears automatically, publish the new word list immediately; do not leave “zero words” until the next user action. Pure animation frames need no extra publication unless a reported value changes. Input changes must be published even if the drawing or calculation has not completed.

This is a replaced data projection, not history, storage or a new global state manager. Reading it has no side effects: state is published by the existing interaction and render paths, and collection only copies the inert data node. Do not redraw to answer a state request. A failed publication removes the old node rather than leaving stale values behind as current.

Use this publication helper in the generated HTML; constructing the application state is your responsibility.

```javascript
function publishState(observation) {
  const root = document.getElementById('experiment');
  if (!root) throw new Error('Missing interaction scope');
  try {
    const raw = JSON.stringify(observation);
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 32768)
      throw new Error('Invalid state publication');
    let node = root.querySelector('script[data-maic-observation]');
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.setAttribute('data-maic-observation', '');
      root.appendChild(node);
    }
    node.textContent = raw;
  } catch (error) {
    root.querySelectorAll('script[data-maic-observation]').forEach(node => node.remove());
    throw error;
  }
}
```

If the activity has an apply/run step, capture the inputs a run actually used when it starts, and write them to `rendered` only after that run has successfully become the displayed result. A cancelled or superseded run must not update `rendered`, and a parameter edit alone must never advance it.

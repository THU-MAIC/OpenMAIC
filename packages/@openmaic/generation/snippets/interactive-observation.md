## REQUIRED: declared current state for newly generated interactive content (v1)

This contract applies to every interactive content type. Provide semantic state, not a dump of all JavaScript variables. The platform reads the same data projection for every lesson; there are no slider/circuit/game-specific collectors. Do not present protocol names to students.

Wrap the whole interactive area in one element with id="experiment". Inside it, publish exactly one non-executable `<script type="application/json" data-maic-observation>` node. This is separate from widget-config (source defaults). Keep existing action controls working. Do not add a state-request message listener; the platform owns collection. This evidence grants no tool or selector permissions.

Publish this exact JSON shape (no extra fields):

```json
{
  "version": 1,
  "scope": {"id": "experiment", "label": "Student-readable activity name"},
  "current": {
    "revision": 0,
    "updatedAt": 0,
    "graph": {
      "objects": [{"id": "object1", "label": "Object name", "facts": [
        {"key": "value", "label": "Value", "status": "known", "value": 1, "unit": "m"},
        {"key": "unmeasured", "label": "Unmeasured quantity", "status": "unknown", "reason": "Not measured"}
      ]}],
      "relations": {"status": "complete", "items": []},
      "missing": []
    }
  },
  "rendered": {"status": "unknown", "reason": "First render not finished"}
}
```

The values above illustrate the SHAPE ONLY; replace them with this lesson's actual facts. IDs start with a letter and contain only letters, digits, underscore or hyphen (max 127 characters). IDs are unique within each graph and stable for an object's lifetime. Removed objects and their incident relations disappear on the next publication; replacement objects receive new IDs. Canvas and dynamically created SVG objects use semantic IDs, not invented static DOM selectors.

Facts: known has key,label,status,value (finite number, boolean, or string up to 500 characters), optional unit; unknown has only key,label,status,reason. Labels/reasons are nonempty, max 240 characters; units max 40. Max 64 objects, 24 facts/object, 128 relations, 16 missing descriptions. Total UTF-8 JSON <=32768 bytes. No duplicate fact keys or duplicate (from,to,kind) relations.

Relations: known complete relationships are `{ "status":"complete", "items":[{"from":"object1","to":"object2","kind":"connects","label":"connected to"}] }`, with both endpoints present in THAT graph. Unknown relationships are `{ "status":"unknown", "reason":"Connection information unavailable" }`, NOT an empty array. Completeness only covers the declared scope. Use missing for omitted information. Do not fabricate facts, use defaults as current state, or substitute the previous result when information is unknown.

`complete` promises an exhaustive relationship set within the declared objects, scope and relation semantics, not merely a list of some observed relationships. A nonempty complete set establishes both the listed relationships and the absence of unlisted relationships within that scope; a complete empty set establishes that there are no relationships there. Use `unknown` if you cannot supply the complete relationship set; neither presence nor absence can then be inferred, and history must not fill it. Current and last-rendered relationship completeness are independent. This does not authorize conclusions about other scopes, undeclared objects or unrelated facts.

Missing information: `graph.missing` is ALWAYS an array of nonempty STRINGS, each at most 240 characters; maximum 16 items. Legal: `[]` or `["Connection endpoints were not reported"]`. Illegal: `[{"key":"refresh-needed","label":"...","reason":"..."}]`. Unlike unknown facts and relations, missing entries have no object fields. A paused old picture is not missing information when its last completed facts are known: keep those facts under rendered, use a control fact for paused/pending, and leave missing as [] unless information is actually omitted.

Update lifecycle:
1. Keep a monotonic nonnegative integer revision, incremented on semantic state changes (including reset, programmatic actions and dynamic creation/removal), and updatedAt = Date.now(). Build current.graph from the real current state.
2. Publish after initialization and every relevant update. Input changes must be published even if the drawing/calculation has not completed. This is a replaced data projection, not history, storage or a new global state manager. No polling for sampling.
3. Keep rendered separate. Only AFTER successful drawing/result completion, store a detached graph of the facts actually used by that render, its captured revision and renderedAt = Date.now(): `{ "status":"known", "basedOnRevision":0, "renderedAt":0, "graph":{...} }`. Do not point it at mutable current objects. For asynchronous rendering capture inputs and revision when the work starts; never stamp an old result with the latest revision. If no render evidence exists, report unknown with a reason. Do not redraw just to answer a state request.
4. Never compute rendered.basedOnRevision or rendered.renderedAt inside a generic buildObservation/publishState function. A publication is not a render. Preserve the ENTIRE last completed rendered record, including graph, revision and timestamp, through pause, input edits and repeated publication.
5. When parameters change while drawing is paused or pending, current changes and rendered retains the last completed result. Include a student-appropriate pause/update control when requested by the activity outline.
6. Readout must have no side effects. State is published by existing interaction/render paths; collection only copies the inert data node. Publish error invalidates the old node, never leaving old known facts as current.

Use this small publication helper in the generated HTML (application state construction is your responsibility). It intentionally does not collect business data or claim semantic validation; the platform validates the received v1 shape.

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


### Render lifecycle example (adapt data construction, preserve this timing)

The following is an executable timing example, not a required state-management library. Use the lesson's existing local state. publishState is the publication helper above. No automatic draw is triggered by commitCurrent. For asynchronous work, beginRender must capture the inputs actually used by that work, and completeRender may be called only when that result has successfully become the displayed picture; discarded/cancelled results must not complete.

```javascript
let currentEvidence = null;
let lastCompletedRender = { status: 'unknown', reason: 'First render not finished' };
function commitCurrent(graph) {
  currentEvidence = {
    revision: currentEvidence ? currentEvidence.revision + 1 : 0,
    updatedAt: Date.now(),
    graph: structuredClone(graph)
  };
  publishEvidence();
}
function beginRender() {
  // The drawing operation must use these captured inputs, not later edits.
  return structuredClone(currentEvidence);
}
function completeRender(started, graphActuallyDrawn) {
  // Call AFTER successful drawing, never from parameter-change handlers alone.
  lastCompletedRender = {
    status: 'known',
    basedOnRevision: started.revision,
    renderedAt: Date.now(),
    graph: structuredClone(graphActuallyDrawn)
  };
  publishEvidence();
}
function publishEvidence() {
  publishState({
    version: 1,
    scope: { id: 'experiment', label: 'Activity' },
    current: structuredClone(currentEvidence),
    rendered: structuredClone(lastCompletedRender)
  });
}
```

Self-check before returning HTML: initialize and complete a picture at revision 0; pause; change a parameter to revision 1; publish and sample. current must change, but rendered must remain byte-for-byte unchanged at revision 0 and its original renderedAt. Refresh using captured revision 1; only after drawing completes may rendered advance to revision 1 with a new completion time. Both publications must validate, including the nonempty missing path. Do not patch schema errors by silently substituting defaults or a previous current record.

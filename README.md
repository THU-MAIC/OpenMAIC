# PBL explicit first start — PR #2277

The current implementation keeps workbench onboarding in its existing place, then waits at the project overview. The learner chooses **Start learning** before the first teaching request is sent. The existing waiting bubble appears immediately and normal tail following handles all replies.

## Current recordings

- [Desktop, 1365 × 900](explicit-start/first-entry-desktop.gif)
- [Narrow, 390 × 900](explicit-start/first-entry-narrow.gif)

Both recordings use a fresh learner and a new disposable classroom with the unchanged built-in `greeting-python-lab@1.2.0` package. They show actual environment preparation, the automatic workbench guide, the overview, explicit start, and the opening response. The long environment-preparation wait is sped up 10×; the guide, start action, and response retain normal speed. Initial blank frames are trimmed.

Assertions during each recording: no begin request before the guide or before Start learning; no assistant turn before start; the overview reading pane starts at scrollTop 0; exactly one begin request after start; an immediately visible waiting turn; completed reply within 1 px of the tail. Waiting-turn visibility was observed 93 ms after click on desktop and 74 ms on narrow width.

The GIFs in the repository root document the superseded scroll-hold candidate and are retained as historical evidence only.

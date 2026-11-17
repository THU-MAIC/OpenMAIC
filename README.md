# PBL explicit first start — PR #2277

The current implementation keeps workbench onboarding in its existing place, then waits at the project overview. The learner chooses **Start learning** before the first teaching request is sent. The existing waiting bubble appears immediately and normal tail following handles all replies.

## Current recordings

- [Desktop walkthrough](explicit-start/first-entry-desktop.gif): Start project → environment preparation → automatic workbench guide → project overview → Start learning → assistant waiting bubble → opening response with normal tail following. The preparation and workbench recordings are joined into one walkthrough, with a cut between them.
- [Narrow-window walkthrough](explicit-start/first-entry-narrow.gif): automatic workbench guide → project overview in the narrower layout → Start learning → waiting feedback → opening response and tail following. Environment preparation is covered by the desktop recording.

Both walkthroughs use the local acceptance classroom for Future Self, Lesson 3: Save Records. They show that the overview remains available for reading until Start learning is clicked, followed by the existing conversation behavior. These are UI walkthroughs; the automated regression checks are listed separately in the PR.

The GIFs in the repository root document the superseded scroll-hold candidate and are retained as historical evidence only. Earlier explicit-start recordings remain available in the branch history.

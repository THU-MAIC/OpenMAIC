# PR 2310: failed file refresh recovery

Browser recordings of the production LearningWorkbenchPanel, useProjectEditor, and Monaco CodeEditor components.

- Before: c2652d66eedba18a7c7d1da99e265d12cc37ea4a
- After: 4d66bc09b03f3a2b1d788e7557f610c318cb11ea

A targeted HTTP 503 is injected for the cached History.java GET request. Other file reads and saves remain available. The recordings show the actual component state and keyboard interactions.

Before: returning to the cached file fails revalidation but still allows typing and saving.
After: the cached content stays visible and read-only, repeated read failure stays blocked, README.md can still be saved, and a successful reload restores editing and saving.

The recordings use isolated browser state and do not change any learner classroom, course package, or progress.

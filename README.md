# Initial PBL project overview scroll evidence

Synthetic browser reproduction for OpenMAIC PR #2277.

Before: public main `439ad53`. After: fix `477ddff`.
The recordings render the real PBL LearningConversation, ConversationViewport, and ProjectOverview components. An illustrative overlay reproduces their visibility lifecycle during onboarding or environment preparation. The opening transcript and project are synthetic, and the composer only simulates the existing send counter. Markdown rendering is simplified. These are controlled component reproductions, not recordings of a production learner session.

Each pair demonstrates the opening growing without learner interaction. The after recordings also demonstrate explicitly sending a message restoring tail following.

- `guide`: overview appears, entry guide hides it, reply begins, guide closes.
- `prepare`: overview appears, environment preparation hides it, then reply grows.
- `already-arriving`: the first snapshot already contains an opening assistant reply.

No learner data or credentials are included.

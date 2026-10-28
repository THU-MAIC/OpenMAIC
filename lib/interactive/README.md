# Interactive media coordination

The classroom and standalone player coordinate HTML `<audio>` and `<video>`
elements in the injected interactive document. A media `play` event pauses
narration; the learner resumes narration with the normal Play control.

Starting or resuming narration sends a fire-and-forget request to pause the
current frame's media elements. There is no acknowledgement, silence guarantee,
or automatic media resume. Background pooled frames do not participate.

WebAudio does not take part in this coordination: `AudioContext`, scheduled
sources and suspend/resume remain untouched. Interactive content that needs
narration coordination should use `<audio>` elements. Detached media and media
inside nested or external documents are outside this document-level bridge.

These cooperative signals do not replace the iframe's opaque sandbox or CSP.
Messages are checked against the frame window and injected document identity.

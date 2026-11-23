# Message field height

This silent clip is a crop from a local browser recording of the public OpenMAIC workbench. The lesson, Python filenames, code and learner input were created for the demonstration. The crop contains only the application viewport with the fictional lesson. It contains no account, classroom record, browser chrome, notifications or external service UI.

## Reproduce the interaction

Open the public [workbench implementation](https://github.com/THU-MAIC/OpenMAIC/blob/955eccce5da859facbb833eead63e26a664f7fce/components/scene-renderers/pbl/v3/workspace.tsx) with the greeting lesson from the [workspace browser test](https://github.com/THU-MAIC/OpenMAIC/blob/955eccce5da859facbb833eead63e26a664f7fce/e2e/tests/pbl-v3-workspace.spec.ts). In the conversation pane, start with an empty draft. Type the following five lines, then delete the final four lines. The field grows upward and shrinks back with the first line still present.

## Visible sequence

The draft starts empty. The five lines are “How should I test a name?”, “First I will try Ada.”, “Then an empty name.”, “Should both return a string?” and “I can compare the two results.” Only the first line remains at the end. Above the field are the sample task title and its stage counter.

The excerpt begins and ends at 0.00–10.76 seconds in the 19.04-second source recording. It has 65 frames at 538 × 232 pixels. To verify the rendered states, open the clip in a browser or extract its animation track with `ffmpeg -i message-field.avif -map 0:v:1 -fps_mode passthrough frame-%03d.png`. The SHA-256 of `message-field.avif` is `7cef967b7bbf3b962315f9737793f5d69b1ad3d8bf831c5db62d51438100957c`.

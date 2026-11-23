# File tabs

This silent clip is a crop from a local browser recording of the public OpenMAIC workbench. The lesson, Python filenames, code and learner input were created for the demonstration. The crop contains only the application viewport with the fictional lesson. It contains no account, classroom record, browser chrome, notifications or external service UI.

## Reproduce the interaction

Open the public [workbench implementation](https://github.com/THU-MAIC/OpenMAIC/blob/955eccce5da859facbb833eead63e26a664f7fce/components/scene-renderers/pbl/v3/workbench-panel.tsx) with the greeting lesson from the [workspace browser test](https://github.com/THU-MAIC/OpenMAIC/blob/955eccce5da859facbb833eead63e26a664f7fce/e2e/tests/pbl-v3-workspace.spec.ts). Open src/this-is-a-very-long-module-name-that-should-truncate.py in the file tree. Move the pointer over the greeting.py tab and activate it.

## Visible sequence

The example file tree shows PLAN.md, greeting.py and a fictional long Python filename. Opening that file adds a truncated tab. Hovering over greeting.py reveals its close button inside the tab. The clip ends after greeting.py is active again. The sample editor contains print("Starter").

The excerpt begins and ends at 10.76–13.72 seconds in the 19.04-second source recording. It has 24 frames at 662 × 154 pixels. To verify the rendered states, open the clip in a browser or extract its animation track with `ffmpeg -i file-tabs.avif -map 0:v:1 -fps_mode passthrough frame-%03d.png`. The SHA-256 of `file-tabs.avif` is `513191b4e22f97e4d78aea36c171dbaf876fa2e60443514a82bc47d305de977d`.

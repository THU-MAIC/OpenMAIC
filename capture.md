# Editor save confirmation

This silent clip is a crop from a local browser recording of the public OpenMAIC workbench. The lesson, Python filenames, code and learner input were created for the demonstration. The crop contains only the application viewport with the fictional lesson. It contains no account, classroom record, browser chrome, notifications or external service UI.

## Reproduce the interaction

Open the public [workbench implementation](https://github.com/THU-MAIC/OpenMAIC/blob/955eccce5da859facbb833eead63e26a664f7fce/components/scene-renderers/pbl/v3/workbench-panel.tsx) with the greeting lesson from the [workspace browser test](https://github.com/THU-MAIC/OpenMAIC/blob/955eccce5da859facbb833eead63e26a664f7fce/e2e/tests/pbl-v3-workspace.spec.ts). In greeting.py, replace print("Starter") with print("Hello, Ada!"). Stop typing and wait for the write receipt and the confirmation to clear.

## Visible sequence

The editor initially shows print("Starter"). The changed line is print("Hello, Ada!"). A dot appears on the tab, the toolbar shows its pending indicator, then a check mark and “Saved”. The confirmation clears while the edited line remains.

The excerpt begins and ends at 13.72–19.04 seconds in the 19.04-second source recording. It has 43 frames at 512 × 90 pixels. To verify the rendered states, open the clip in a browser or extract its animation track with `ffmpeg -i save-confirmation.avif -map 0:v:1 -fps_mode passthrough frame-%03d.png`. The SHA-256 of `save-confirmation.avif` is `05c3d5b0a84b7758e4f60bc4ba4fd2140387d92248be03071aea687123f42dec`.

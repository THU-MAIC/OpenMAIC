# Reproduce the workbench UI example

The capture runs the actual [PBL workspace](https://github.com/THU-MAIC/OpenMAIC/blob/324e6a9360ca582c92c88e4cf767344c8a437676/components/scene-renderers/pbl/v3/workspace.tsx) in a new Chromium context. All lesson data comes from the short fictional example in `capture.cjs`. Requests to other origins are blocked. The event stream and transcription run on the same machine. The microphone input is synthesized speech.

1. Use a disposable checkout of THU-MAIC/OpenMAIC at `324e6a9360ca582c92c88e4cf767344c8a437676` with the documented local development prerequisites. Follow the capture workflow to install the example page and its isolated layout in that checkout. The layout loads the public workbench styles and fonts, and leaves service startup to the local fixture. Start the webpack development server on loopback.
2. Copy `capture.cjs` and `recognize.py` into the checkout together. Use the repository's version of Playwright with Chromium installed. The example also needs FFmpeg, Python with PocketSphinx installed, and eSpeak NG.
3. Run `node capture.cjs http://127.0.0.1:3000`, substituting the local port if needed. Set `PYTHON` to the Python executable containing PocketSphinx if appropriate. The script creates its microphone sample, captures the workbench and checks the final draft and outgoing chat count.
4. The resulting files are `pane-headers.png` and `voice-draft.mp4`. The screenshot checks the height and bottom edge of all three pane headers. The silent movie is restricted to the message field, recording control and Send button.

No viewer account, hosted classroom, remote transcription provider or personal recording is needed. The offline recognizer uses a three-command grammar for this fixture. Browser timing and encoder versions can change the bytes of a repeated capture. The capture workflow records its SHA-256 digest and provides it alongside the generated video.

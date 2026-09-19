# Vendoring Intent: pi-agent-core

## Upstream

- Repository: github.com/earendil-works/pi
- Author: Mario Zechner (MIT License)
- Baseline tag: `0.78.0`

## What we use

- `@earendil-works/pi-agent-core` — agent loop / harness (session management, skills, compaction, hooks)
- `@earendil-works/pi-ai` — types and event protocol

We do NOT use:
- `pi-ai` provider implementations (LLM calls are routed through the project's own connector via an adapter)
- `pi-tui` (terminal UI)
- `pi-coding-agent` (coding-specific agent)

## Pinning rationale

Both packages are pinned at exact version `0.78.0` (no caret range) in the root `package.json`. This ensures reproducible installs and a stable baseline for any future fork/vendor operation.

## Fork / vendor rule

**Do not vendor the source until you actually need to modify the loop.**

When that time comes:

1. Vendor the source at the recorded baseline (`0.78.0`) by copying the relevant packages into this repository.
2. Run `diff baseline..upstream` to identify changes in newer upstream releases.
3. Cherry-pick any desired upstream improvements onto the vendored copy.
4. Remove the npm dependency and update all imports to point at the local copy.

This "lazy modification" approach avoids the module-resolution overhead of full source vendoring until it is actually necessary.

## MIT Attribution

```
Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

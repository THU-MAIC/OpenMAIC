# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] - 2026-04-26

### Features

- **[VoxCPM2](https://github.com/OpenBMB/VoxCPM) TTS provider with voice cloning** — OpenMAIC adapts to user-managed VoxCPM backends (vLLM-Omni, Nano-VLLM, official Python API). Clone any voice from a reference audio clip you upload or record in the browser, or let Auto Voice generate a fitting voice from each agent's persona at synthesis time. Voice profiles are stored locally to keep the serverless setup model. The Agent Bar exposes a searchable, previewable voice picker that draws from the global VoxCPM voice pool [#496](https://github.com/THU-MAIC/OpenMAIC/pull/496)
- **Per-model thinking configuration** — First-class metadata for each model's reasoning capability (effort levels, on/off toggle, adjustable budget, or fixed thinking) flows through chat and all generation paths and is mapped to the right provider-specific request fields (Anthropic `thinking`, OpenAI `reasoning`, etc.). The model selector becomes a unified provider/model/thinking popover with compact search and a much smaller toolbar footprint [#494](https://github.com/THU-MAIC/OpenMAIC/pull/494)
- **End-of-course completion page with persistent quiz state** — When the outline is fully materialized, students see a course-complete view with quiz score card, scene-type stat cards, and a (motion-respecting) confetti celebration. Quiz answers persist on submit and grading results persist on completion, so navigating away and back restores the reviewing state with AI feedback intact instead of resetting [#484](https://github.com/THU-MAIC/OpenMAIC/pull/484)
- Add latest released models including [GPT-5.5](https://github.com/THU-MAIC/OpenMAIC/pull/487), DeepSeek-V4 (`-pro`, `-flash`), Xiaomi [MiMo](https://github.com/XiaomiMiMo) (`mimo-v2.5-pro`, `mimo-v2.5`), Tencent [Hy3](https://github.com/Tencent-Hunyuan), and [OpenRouter](https://openrouter.ai/) as a multi-provider gateway [#481](https://github.com/THU-MAIC/OpenMAIC/pull/481) [#487](https://github.com/THU-MAIC/OpenMAIC/pull/487)
- Add OpenAI image generation (GPT-Image-2) as a media provider [#481](https://github.com/THU-MAIC/OpenMAIC/pull/481)
- Refresh built-in model registries across Anthropic, DeepSeek, Kimi, Qwen, MiniMax, Grok, OpenAI, GLM, SiliconFlow, and Ollama; persisted local settings now rehydrate in registry order so newly curated lists appear consistent without clearing state [#481](https://github.com/THU-MAIC/OpenMAIC/pull/481)
- Add inline search for recent classrooms on the home page with deferred filtering by name and description, keyboard-driven open/clear/collapse [#476](https://github.com/THU-MAIC/OpenMAIC/pull/476)
- Add Deep-Interactive badge on classroom thumbnails for sessions generated with Interactive Mode [#478](https://github.com/THU-MAIC/OpenMAIC/pull/478)
- Replace always-included media instruction blocks in generation prompts with conditional snippet includes gated on `imageEnabled` / `videoEnabled` — disabled capabilities are removed from the prompt entirely instead of relying on negative-override directives the model often ignored [#490](https://github.com/THU-MAIC/OpenMAIC/pull/490) (by @YizukiAme)

### Bug Fixes

- Fix language drift between outline and scene generation by unifying the languageDirective across the pipeline so the same target language flows from outline planning through every per-scene call [#474](https://github.com/THU-MAIC/OpenMAIC/pull/474)

### Other Changes

- Refactor whiteboard role prompts to file-based markdown templates and add a geometry-conflict detector (overlap, line-through-bbox, canvas clipping) that surfaces problems back to the model. Eval (flash, repeat 3, gemini-3.1-pro scorer) shows overall quality 5.4 → 6.1 and overlap 6.3 → 8.1 from prompt + detector alone [#485](https://github.com/THU-MAIC/OpenMAIC/pull/485)
- Migrate orchestration prompt builders (`buildStructuredPrompt`, `buildDirectorPrompt`, `buildPBLSystemPrompt`) from inline TS template literals to file-based markdown templates under `lib/prompts/`, sharing the loader infrastructure with the generation pipeline. `prompt-builder.ts` 890 → 314 lines; future content tweaks land as markdown edits [#459](https://github.com/THU-MAIC/OpenMAIC/pull/459)

## [0.2.0] - 2026-04-20

### Features

- **Deep Interactive Mode** — Generate hands-on interactive scenes (3D visualization, simulation, game, mind map/diagram, online programming) with an AI teacher who operates the UI to guide students. Fully responsive across desktop, tablet, and mobile [#461](https://github.com/THU-MAIC/OpenMAIC/pull/461)
- Add code element support on the whiteboard — AI agents can write, display, and reference runnable code during lessons [#385](https://github.com/THU-MAIC/OpenMAIC/pull/385) (by @cosarah)
- Add Arabic (ar-SA) interface language [#431](https://github.com/THU-MAIC/OpenMAIC/pull/431) (by @YizukiAme)
- Add MinerU Cloud API as a PDF parsing provider, with a dedicated settings UI [#438](https://github.com/THU-MAIC/OpenMAIC/pull/438)
- Add latest OpenAI models to the default config [#416](https://github.com/THU-MAIC/OpenMAIC/pull/416) (by @donghch)
- Add GLM-5.1 and GLM-5V-Turbo to GLM preset models [#437](https://github.com/THU-MAIC/OpenMAIC/pull/437)
- Add international base URL shortcuts for GLM, Kimi, and MiniMax in provider settings [#449](https://github.com/THU-MAIC/OpenMAIC/pull/449)
- Add anti-framing security headers (X-Frame-Options + CSP `frame-ancestors`) with an optional `ALLOWED_FRAME_ANCESTORS` override [#430](https://github.com/THU-MAIC/OpenMAIC/pull/430) (by @YizukiAme)
- Add i18n key alignment check to CI so missing or extra translation keys fail the build [#447](https://github.com/THU-MAIC/OpenMAIC/pull/447) (by @KanameMadoka520)
- Add whiteboard layout quality eval harness and unify it with the outline-language harness [#425](https://github.com/THU-MAIC/OpenMAIC/pull/425) [#453](https://github.com/THU-MAIC/OpenMAIC/pull/453)

### Bug Fixes

- Fix classroom ZIP export to use the latest classroom name from IndexedDB [#435](https://github.com/THU-MAIC/OpenMAIC/pull/435)
- Fix spotlight cutout for text elements and add element-content variant for image/video [#457](https://github.com/THU-MAIC/OpenMAIC/pull/457)

### Other Changes

- Renew the README with Deep Interactive Mode showcase and visual assets [#463](https://github.com/THU-MAIC/OpenMAIC/pull/463) (by @Shirokumaaaa)
- Update Discord invite links across README, CONTRIBUTING, and issue templates

## [0.1.1] - 2026-04-14

### Features
- Add inline language inference for outline and PBL generation, replacing manual language selector [#412](https://github.com/THU-MAIC/OpenMAIC/pull/412) (by @cosarah)
- Add ACCESS_CODE site-level authentication for shared deployments [#411](https://github.com/THU-MAIC/OpenMAIC/pull/411)
- Add classroom export and import as ZIP [#418](https://github.com/THU-MAIC/OpenMAIC/pull/418)
- Add custom OpenAI-compatible TTS/ASR provider support [#409](https://github.com/THU-MAIC/OpenMAIC/pull/409)
- Add Ollama as built-in provider with keyless activation [#94](https://github.com/THU-MAIC/OpenMAIC/pull/94) (by @f1rep0wr)
- Add Japanese (ja-JP) locale [#365](https://github.com/THU-MAIC/OpenMAIC/pull/365) (by @YizukiAme)
- Add Russian (ru-RU) locale [#261](https://github.com/THU-MAIC/OpenMAIC/pull/261) (by @maximvalerevich)
- Migrate i18n infrastructure to i18next framework [#331](https://github.com/THU-MAIC/OpenMAIC/pull/331) (by @cosarah)
- Add MiniMax provider support [#182](https://github.com/THU-MAIC/OpenMAIC/pull/182) (by @Hi-Jiajun)
- Add Doubao TTS 2.0 (Volcengine) provider [#283](https://github.com/THU-MAIC/OpenMAIC/pull/283)
- Add configurable model selection for TTS and ASR [#108](https://github.com/THU-MAIC/OpenMAIC/pull/108) (by @ShaojieLiu)
- Add context-aware Tavily web search when PDF is uploaded [#258](https://github.com/THU-MAIC/OpenMAIC/pull/258) (by @nkmohit)
- Add course rename [#58](https://github.com/THU-MAIC/OpenMAIC/pull/58) (by @YizukiAme)
- Add end-to-end generation happy path test [#405](https://github.com/THU-MAIC/OpenMAIC/pull/405)

### Bug Fixes
- Fix DNS rebinding bypass in SSRF validation [#386](https://github.com/THU-MAIC/OpenMAIC/pull/386) (by @YizukiAme)
- Add ALLOW_LOCAL_NETWORKS env var for self-hosted deployments [#366](https://github.com/THU-MAIC/OpenMAIC/pull/366)
- Fix custom provider baseUrl not persisting on creation [#417](https://github.com/THU-MAIC/OpenMAIC/pull/417) (by @YizukiAme)
- Hide Ollama from model selector when not configured [#420](https://github.com/THU-MAIC/OpenMAIC/pull/420) (by @cosarah)
- Fix agent configs not persisting in server-generated classrooms [#336](https://github.com/THU-MAIC/OpenMAIC/pull/336) (by @YizukiAme)
- Fix action filtering logic and add safety improvements [#163](https://github.com/THU-MAIC/OpenMAIC/pull/163) (by @zky001)
- Fix modifier-key combos triggering single-key shortcuts [#359](https://github.com/THU-MAIC/OpenMAIC/pull/359) (by @YizukiAme)
- Fix agent mode selection for conditionally set generatedAgentConfigs [#373](https://github.com/THU-MAIC/OpenMAIC/pull/373) (by @YizukiAme)
- Unify TTS model selection to per-provider and fix ElevenLabs model_id [#326](https://github.com/THU-MAIC/OpenMAIC/pull/326)
- Allow model-level test connection without client-side API key [#309](https://github.com/THU-MAIC/OpenMAIC/pull/309) (by @cosarah)
- Add structured request context to all API error logs [#337](https://github.com/THU-MAIC/OpenMAIC/pull/337) (by @YizukiAme)
- Fix breathing bar background color in roundtable [#307](https://github.com/THU-MAIC/OpenMAIC/pull/307)

### Other Changes
- Add missing Ollama and Doubao provider names for ru-RU [#389](https://github.com/THU-MAIC/OpenMAIC/pull/389) (by @cosarah)
- Update Ollama logo to official version [#400](https://github.com/THU-MAIC/OpenMAIC/pull/400) (by @cosarah)
- Remove deprecated Gemini 3 Pro Preview model [#142](https://github.com/THU-MAIC/OpenMAIC/pull/142) (by @Orinameh)
- Update expired Discord invite link
- Create SECURITY.md [#281](https://github.com/THU-MAIC/OpenMAIC/pull/281) (by @fai1424)

### New Contributors

@f1rep0wr, @maximvalerevich, @Hi-Jiajun, @cosarah, @zky001, @Orinameh, @fai1424

## [0.1.0] - 2026-03-26

The first tagged release of OpenMAIC, including all improvements since the initial open-source launch.

### Highlights

- **Discussion TTS** — Voice playback during discussion phase with per-agent voice assignment, supporting all TTS providers including browser-native [#211](https://github.com/THU-MAIC/OpenMAIC/pull/211)
- **Immersive Mode** — Full-screen view with speech bubbles, auto-hide controls, and keyboard navigation [#195](https://github.com/THU-MAIC/OpenMAIC/pull/195) (by @YizukiAme)
- **Discussion buffer-level pause** — Freeze text reveal without aborting the AI stream [#129](https://github.com/THU-MAIC/OpenMAIC/pull/129) (by @YizukiAme)
- **Keyboard shortcuts** — Comprehensive roundtable controls: T/V/Esc/Space/M/S/C [#256](https://github.com/THU-MAIC/OpenMAIC/pull/256) (by @YizukiAme)
- **Whiteboard enhancements** — Pan, zoom, auto-fit [#31](https://github.com/THU-MAIC/OpenMAIC/pull/31), history and auto-save [#40](https://github.com/THU-MAIC/OpenMAIC/pull/40) (by @YizukiAme)
- **New providers** — ElevenLabs TTS [#134](https://github.com/THU-MAIC/OpenMAIC/pull/134) (by @nkmohit), Grok/xAI for LLM, image, and video [#113](https://github.com/THU-MAIC/OpenMAIC/pull/113) (by @KanameMadoka520)
- **Server-side generation** — Media and TTS generation on the server [#75](https://github.com/THU-MAIC/OpenMAIC/pull/75) (by @cosarah)
- **1.25x playback speed** [#131](https://github.com/THU-MAIC/OpenMAIC/pull/131) (by @YizukiAme)
- **OpenClaw integration** — Generate classrooms from Feishu, Slack, Telegram, and 20+ messaging apps [#4](https://github.com/THU-MAIC/OpenMAIC/pull/4) (by @cosarah)
- **Vercel one-click deploy** [#2](https://github.com/THU-MAIC/OpenMAIC/pull/2) (by @cosarah)

### Security

- Fix SSRF and credential forwarding via client-supplied baseUrl [#30](https://github.com/THU-MAIC/OpenMAIC/pull/30) (by @Wing900)
- Use resolved API key in chat route instead of client-sent key [#221](https://github.com/THU-MAIC/OpenMAIC/pull/221)

### Testing

- Add Vitest unit testing infrastructure [#144](https://github.com/THU-MAIC/OpenMAIC/pull/144)
- Add Playwright e2e testing framework [#229](https://github.com/THU-MAIC/OpenMAIC/pull/229)

### New Contributors

@YizukiAme, @nkmohit, @KanameMadoka520, @Wing900, @Bortlesboat, @JokerQianwei, @humingfeng, @tsinglua, @mehulmpt, @ShaojieLiu, @Rowtion

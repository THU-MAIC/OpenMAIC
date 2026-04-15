# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

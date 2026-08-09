# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] - 2026-07-21

### Features

- **Video export (MP4)** — Export a lesson as a rendered video: a `VideoTimeline` IR with a pure compile pipeline [#913](https://github.com/THU-MAIC/OpenMAIC/pull/913), an L1 Hyperframes emitter with in-browser frame collection and ZIP export [#931](https://github.com/THU-MAIC/OpenMAIC/pull/931), and a service-backed MP4 render with in-app one-click export [#937](https://github.com/THU-MAIC/OpenMAIC/pull/937) (by @cosarah) — built on a shared orchestration spec in `lib/choreography` [#890](https://github.com/THU-MAIC/OpenMAIC/pull/890) (by @cosarah) and persisted TTS audio durations [#862](https://github.com/THU-MAIC/OpenMAIC/pull/862) (by @cosarah)
- **Server-backed runtime storage** — A pluggable storage seam for classroom runtime state: `@openmaic/storage` KV + asset primitives [#858](https://github.com/THU-MAIC/OpenMAIC/pull/858), a normalized DocumentStore [#860](https://github.com/THU-MAIC/OpenMAIC/pull/860), RuntimeStore sessions with append-only records [#880](https://github.com/THU-MAIC/OpenMAIC/pull/880), a DSL runtime envelope [#870](https://github.com/THU-MAIC/OpenMAIC/pull/870), device-anonymous learner identity [#885](https://github.com/THU-MAIC/OpenMAIC/pull/885), a runtime-event outbox with dual-write [#893](https://github.com/THU-MAIC/OpenMAIC/pull/893), cutovers for PBL learner state [#902](https://github.com/THU-MAIC/OpenMAIC/pull/902) [#922](https://github.com/THU-MAIC/OpenMAIC/pull/922) and chat sessions [#926](https://github.com/THU-MAIC/OpenMAIC/pull/926), and an HTTP backend contract with a Postgres backend and reference server [#946](https://github.com/THU-MAIC/OpenMAIC/pull/946)
- **Editor: direct manipulation** — Select and drag slide elements [#859](https://github.com/THU-MAIC/OpenMAIC/pull/859), 8-point resize + rotate handles [#881](https://github.com/THU-MAIC/OpenMAIC/pull/881), marquee multi-select with multi-element drag [#888](https://github.com/THU-MAIC/OpenMAIC/pull/888), and a draggable insert toolbar [#912](https://github.com/THU-MAIC/OpenMAIC/pull/912), scaffolded as the `@openmaic/renderer` v2 editing surface behind a machine-enforced import boundary [#853](https://github.com/THU-MAIC/OpenMAIC/pull/853) [#855](https://github.com/THU-MAIC/OpenMAIC/pull/855)
- **Edit with AI upgrades** — Natural-language element edits through a typed EditIntent pipeline [#896](https://github.com/THU-MAIC/OpenMAIC/pull/896), validated JSON Patch element edits [#927](https://github.com/THU-MAIC/OpenMAIC/pull/927), and multi-session conversation history for the AI editor [#801](https://github.com/THU-MAIC/OpenMAIC/pull/801)
- **DSL self-ownership** — `@openmaic/dsl` now owns the Action playback verbs [#787](https://github.com/THU-MAIC/OpenMAIC/pull/787), ships JSON Schema artifacts with pure validators [#817](https://github.com/THU-MAIC/OpenMAIC/pull/817), activates the migration registry and runner [#825](https://github.com/THU-MAIC/OpenMAIC/pull/825), and owns element-level normalization and defaults wired into the generator [#832](https://github.com/THU-MAIC/OpenMAIC/pull/832) and the importer output boundary [#845](https://github.com/THU-MAIC/OpenMAIC/pull/845)
- **Document Parsing expansion** — Multi-format course-material upload [#741](https://github.com/THU-MAIC/OpenMAIC/pull/741) and document bundles [#844](https://github.com/THU-MAIC/OpenMAIC/pull/844) (by @jackefn), audio/video media extraction with an AliDocMind provider [#887](https://github.com/THU-MAIC/OpenMAIC/pull/887) (by @yanpgwang), and a renamed Document Parsing surface with visible supported formats and extended MinerU support (by @yanpgwang)
- Add Azure OpenAI as an LLM provider [#916](https://github.com/THU-MAIC/OpenMAIC/pull/916) (by @hydraxman), SearXNG as a web-search provider [#842](https://github.com/THU-MAIC/OpenMAIC/pull/842) (by @PineSongCN), ComfyUI as an image provider [#850](https://github.com/THU-MAIC/OpenMAIC/pull/850) (by @PhillLittlewood), the GPT-5.6 model family [#907](https://github.com/THU-MAIC/OpenMAIC/pull/907), and an updated Doubao Seed model catalog [#827](https://github.com/THU-MAIC/OpenMAIC/pull/827)
- Add one-click token-plan setup and a deployment usage dashboard [#784](https://github.com/THU-MAIC/OpenMAIC/pull/784) (by @yanpgwang)
- Add action-level playback navigation [#843](https://github.com/THU-MAIC/OpenMAIC/pull/843) (by @danishsshaikh)
- Redesign the narration timeline (action picker + inline insert) and enable it for interactive/PBL scenes [#834](https://github.com/THU-MAIC/OpenMAIC/pull/834)
- Add in-editor authoring of classroom agents with a Stage-level roster [#816](https://github.com/THU-MAIC/OpenMAIC/pull/816)
- Parallelize within-scene TTS generation [#696](https://github.com/THU-MAIC/OpenMAIC/pull/696) (by @ly-wang19)
- Feed the real HTML element inventory into interactive-action prompts [#829](https://github.com/THU-MAIC/OpenMAIC/pull/829) and add a postMessage listener contract to diagram/game/code widgets [#872](https://github.com/THU-MAIC/OpenMAIC/pull/872) (by @yanpgwang)
- Add an experimental Pi classroom runtime behind a flag [#914](https://github.com/THU-MAIC/OpenMAIC/pull/914)

### Bug Fixes

- Security: disable redirects in media connectivity probes [#930](https://github.com/THU-MAIC/OpenMAIC/pull/930) and harden provider redirect handling with ISATAP address detection [#928](https://github.com/THU-MAIC/OpenMAIC/pull/928) against SSRF (by @YizukiAme)
- Generation: strip reasoning blocks before JSON parsing [#750](https://github.com/THU-MAIC/OpenMAIC/pull/750) (by @yipwingtim), localize scene-generation errors [#894](https://github.com/THU-MAIC/OpenMAIC/pull/894) (by @wsun1), tolerate malformed generated slide data (by @yipwingtim), and honor outline node constraints in diagrams [#911](https://github.com/THU-MAIC/OpenMAIC/pull/911)
- Editor: keep emptied or zero-action scenes playable, bind the outline by stable id, and surface incomplete content [#814](https://github.com/THU-MAIC/OpenMAIC/pull/814); show per-line loading while the batch "regenerate all TTS" runs [#830](https://github.com/THU-MAIC/OpenMAIC/pull/830)
- Export: fix the unresponsive resource pack for interactive-only decks [#933](https://github.com/THU-MAIC/OpenMAIC/pull/933) (by @2046731121CC), compute SVG path bounding boxes via `getBounds()` [#656](https://github.com/THU-MAIC/OpenMAIC/pull/656), keep sibling attributes when style is empty [#683](https://github.com/THU-MAIC/OpenMAIC/pull/683), and convert PPTX shadow offsets from px to pt [#679](https://github.com/THU-MAIC/OpenMAIC/pull/679) (by @ly-wang19)
- Quiz: render formulas in quiz text [#833](https://github.com/THU-MAIC/OpenMAIC/pull/833) (by @dpersek); stop leaking questions on entry and pass results to the chat agent [#823](https://github.com/THU-MAIC/OpenMAIC/pull/823) (by @yanpgwang)
- Storage: store image files as array buffers [#923](https://github.com/THU-MAIC/OpenMAIC/pull/923) (by @YizukiAme) and accept image storage IDs containing underscores [#918](https://github.com/THU-MAIC/OpenMAIC/pull/918)
- Chat: preserve message line breaks [#908](https://github.com/THU-MAIC/OpenMAIC/pull/908), and cap the roundtable non-presentation input height [#917](https://github.com/THU-MAIC/OpenMAIC/pull/917) (by @YizukiAme)
- TTS: respect string context when splitting the Doubao stream [#677](https://github.com/THU-MAIC/OpenMAIC/pull/677); web search: match Brave's current result-title markup [#688](https://github.com/THU-MAIC/OpenMAIC/pull/688) (by @ly-wang19)
- Stage: centralize the deck completion predicate [#883](https://github.com/THU-MAIC/OpenMAIC/pull/883) (by @dpersek)
- AI: close PROVIDERS/THINKING_CAPABILITIES metadata drift with a guard [#809](https://github.com/THU-MAIC/OpenMAIC/pull/809) (by @mvanhorn)
- Home: clarify the Interactive Mode selected state [#901](https://github.com/THU-MAIC/OpenMAIC/pull/901); lecture notes: render interactive-webpage widget actions [#810](https://github.com/THU-MAIC/OpenMAIC/pull/810)
- Docker: fix the postinstall script failure in Docker builds [#835](https://github.com/THU-MAIC/OpenMAIC/pull/835) (by @Lee-Flier)
- mathml2omml: call `includes()` instead of indexing it [#681](https://github.com/THU-MAIC/OpenMAIC/pull/681) (by @ly-wang19)

### Other Changes

- Performance: dedupe editor alignment snap-lines in O(n) [#692](https://github.com/THU-MAIC/OpenMAIC/pull/692), diff code lines in O(n) via a prev-line map [#706](https://github.com/THU-MAIC/OpenMAIC/pull/706), and index assigned images by id in `fixElementDefaults` [#701](https://github.com/THU-MAIC/OpenMAIC/pull/701) (by @ly-wang19)
- Tests: cover `splitLongSpeechText` / `splitLongSpeechActions` [#694](https://github.com/THU-MAIC/OpenMAIC/pull/694) (by @ly-wang19); settle dynamic imports [#899](https://github.com/THU-MAIC/OpenMAIC/pull/899) and drain debounced saves [#897](https://github.com/THU-MAIC/OpenMAIC/pull/897) before store-test teardown
- Media providers: share the submit-poll task driver [#900](https://github.com/THU-MAIC/OpenMAIC/pull/900) and the auth probe across matching adapters [#903](https://github.com/THU-MAIC/OpenMAIC/pull/903), and remove the dead legacy pipeline chain [#905](https://github.com/THU-MAIC/OpenMAIC/pull/905) (by @YizukiAme)
- Packages: add repository metadata [#813](https://github.com/THU-MAIC/OpenMAIC/pull/813) and set `@openmaic/*` package versions to 0.0.2 [#812](https://github.com/THU-MAIC/OpenMAIC/pull/812) (by @xuyuanwei678)
- Docs: document the dev-server OOM workaround for large generations [#808](https://github.com/THU-MAIC/OpenMAIC/pull/808) (by @mvanhorn)
- Tighten GitHub issue intake [#921](https://github.com/THU-MAIC/OpenMAIC/pull/921)

## [0.3.0] - 2026-06-28

### License

- Relicense the project from AGPL-3.0 to MIT

### Breaking Changes

- Remove `allow-same-origin` from the interactive `srcDoc` iframe sandbox for tighter isolation; interactive widgets that relied on same-origin access may need updates [#726](https://github.com/THU-MAIC/OpenMAIC/pull/726) (by @sebastiondev)
- Restructure the slide DSL and renderer into standalone `@openmaic/*` packages consumed by the app; the inline DSL shim is removed [#707](https://github.com/THU-MAIC/OpenMAIC/pull/707) [#738](https://github.com/THU-MAIC/OpenMAIC/pull/738)

### Features

- **Project-Based Learning (PBL) v2** — Add the PBL v2 core schema and generation path [#795](https://github.com/THU-MAIC/OpenMAIC/pull/795) (by @cosarah), runtime APIs with classroom UI [#799](https://github.com/THU-MAIC/OpenMAIC/pull/799) (by @cosarah), in-timeline discussion authoring [#798](https://github.com/THU-MAIC/OpenMAIC/pull/798), auto-retry for transient scene-generation failures [#788](https://github.com/THU-MAIC/OpenMAIC/pull/788) (by @YizukiAme), and a planner eval harness [#803](https://github.com/THU-MAIC/OpenMAIC/pull/803) [#805](https://github.com/THU-MAIC/OpenMAIC/pull/805) (by @cosarah)
- **Edit with AI** — Add a Pro-mode editor agent that edits generated slides from a chat prompt [#777](https://github.com/THU-MAIC/OpenMAIC/pull/777)
- **`@openmaic/*` SDK on npm** — Publish the DSL, renderer, and importer SDK family to npm [#778](https://github.com/THU-MAIC/OpenMAIC/pull/778) [#780](https://github.com/THU-MAIC/OpenMAIC/pull/780), introduce the `maic-import`/`maic-renderer` workspace packages [#668](https://github.com/THU-MAIC/OpenMAIC/pull/668) (by @xuyuanwei678), and promote the Stage/Scene lesson skeleton into `@maic/dsl` [#740](https://github.com/THU-MAIC/OpenMAIC/pull/740)
- Add optional per-stage LLM model routing [#745](https://github.com/THU-MAIC/OpenMAIC/pull/745)
- Add GLM-5.2 and Kimi K2.7 Code [#774](https://github.com/THU-MAIC/OpenMAIC/pull/774), and Qwen3.7 Plus and Qwen3.7 Max [#753](https://github.com/THU-MAIC/OpenMAIC/pull/753), to the model registry
- Add a vocational-learning task engine with procedural skill widgets [#685](https://github.com/THU-MAIC/OpenMAIC/pull/685) (by @jackefn)
- Add Korean (ko-KR) translation [#733](https://github.com/THU-MAIC/OpenMAIC/pull/733) (by @moduvoice)
- Improve TTS with per-agent auto-voice quality and stable timbre registration [#670](https://github.com/THU-MAIC/OpenMAIC/pull/670), and unify the provider-enablement model with browser-native TTS off by default [#665](https://github.com/THU-MAIC/OpenMAIC/pull/665)
- Add opt-in parallel scene-content generation [#660](https://github.com/THU-MAIC/OpenMAIC/pull/660) (by @ly-wang19)
- Add a document extractor provider foundation [#704](https://github.com/THU-MAIC/OpenMAIC/pull/704) (by @jackefn)
- Infer concise course titles from outlines for more readable course names [#756](https://github.com/THU-MAIC/OpenMAIC/pull/756)
- Refactor widget actions into the unified scene action pipeline [#796](https://github.com/THU-MAIC/OpenMAIC/pull/796)

### Bug Fixes

- Importer: port PPTX shape-restoration hotfixes [#789](https://github.com/THU-MAIC/OpenMAIC/pull/789) (by @xuyuanwei678), fix hanging-indent bullet rendering [#727](https://github.com/THU-MAIC/OpenMAIC/pull/727) (by @xuyuanwei678), and guard SVG export against arc-first paths [#638](https://github.com/THU-MAIC/OpenMAIC/pull/638) (by @ly-wang19)
- Generation: make outline type changes take effect so interactive/PBL outlines are no longer downgraded to slides [#772](https://github.com/THU-MAIC/OpenMAIC/pull/772), stop regenerating deleted slides on finished decks [#769](https://github.com/THU-MAIC/OpenMAIC/pull/769), show full key-point text in the outline editor [#782](https://github.com/THU-MAIC/OpenMAIC/pull/782), and linearize outline streaming and interactive post-processing for better performance [#732](https://github.com/THU-MAIC/OpenMAIC/pull/732)
- Agent: respond to the user's turn before lecturing [#699](https://github.com/THU-MAIC/OpenMAIC/pull/699), and constrain action narration to a single teacher voice [#671](https://github.com/THU-MAIC/OpenMAIC/pull/671)
- Editor: stop dumping the raw tool-failure blob in AI edit tool cards [#785](https://github.com/THU-MAIC/OpenMAIC/pull/785), persist AgentBar voice and mode selections across reloads [#723](https://github.com/THU-MAIC/OpenMAIC/pull/723), and keep the edit runtime alive across read-only scenes [#802](https://github.com/THU-MAIC/OpenMAIC/pull/802) (by @cosarah)
- Audio: gate the speech button on ASR availability [#711](https://github.com/THU-MAIC/OpenMAIC/pull/711), revoke blob URLs when playback is rejected [#652](https://github.com/THU-MAIC/OpenMAIC/pull/652) (by @ly-wang19), and surface TTS provider rate limits as HTTP 429 [#644](https://github.com/THU-MAIC/OpenMAIC/pull/644) (by @ly-wang19)
- Renderer: make the code entrance animation play line by line [#724](https://github.com/THU-MAIC/OpenMAIC/pull/724) (by @tongshu2023)
- Security: point the SSRF local-network rejection at the `ALLOW_LOCAL_NETWORKS` escape hatch [#667](https://github.com/THU-MAIC/OpenMAIC/pull/667) (by @mvanhorn)
- Networking: bypass the proxy for loopback hosts and honor `NO_PROXY` [#718](https://github.com/THU-MAIC/OpenMAIC/pull/718) (by @tongshu2023)
- Fix overlay layout shift on the home and classroom pages [#690](https://github.com/THU-MAIC/OpenMAIC/pull/690) (by @cosarah)

### Other Changes

- Drop the dead `ThumbnailSlide` path and fix `@maic/dsl` Node ESM resolution [#736](https://github.com/THU-MAIC/OpenMAIC/pull/736)
- Docs: correct the stale i18n location and supported-language list [#640](https://github.com/THU-MAIC/OpenMAIC/pull/640) (by @ly-wang19)

## [0.2.2] - 2026-06-02

### Features

- **MAIC Editor (v0) — slide editing surface** — A new **Pro Mode** toggle turns any generated slide into an editable canvas: select and edit text, insert text boxes and images, navigate and reorder slides from a thumbnail rail, with history-aware undo/redo. This is the first surface of the broader MAIC Editor framework (gated behind `NEXT_PUBLIC_MAIC_EDITOR_ENABLED`) [#615](https://github.com/THU-MAIC/OpenMAIC/pull/615)
- **Editable outline before generation** — The streaming course outline now morphs into an inline editor: review, edit, reorder, and add or delete scenes and bullet points, then confirm to generate the full course — so you catch structure problems before spending a full generation [#558](https://github.com/THU-MAIC/OpenMAIC/pull/558)
- **Offline-ready classroom export** — Exported teaching resource packs and classroom ZIPs now inline external assets so interactive pages open fully offline, even when copied to another machine [#613](https://github.com/THU-MAIC/OpenMAIC/pull/613)
- Add Claude Opus 4.8 and MiniMax M3 to the default model registry [#635](https://github.com/THU-MAIC/OpenMAIC/pull/635)
- Add Gemini 3.5 Flash [#584](https://github.com/THU-MAIC/OpenMAIC/pull/584)
- Add Xiaomi MiMo Token Plan support [#578](https://github.com/THU-MAIC/OpenMAIC/pull/578) (by @xuruiray)
- Add web search providers: Brave and Baidu [#42](https://github.com/THU-MAIC/OpenMAIC/pull/42) (by @YizukiAme), Bocha [#524](https://github.com/THU-MAIC/OpenMAIC/pull/524), and MiniMax [#634](https://github.com/THU-MAIC/OpenMAIC/pull/634)
- Add Azure STT (Fast Transcription) as a speech-to-text provider [#175](https://github.com/THU-MAIC/OpenMAIC/pull/175) (by @ismailariyan)
- Add HappyHorse video adapter [#509](https://github.com/THU-MAIC/OpenMAIC/pull/509) (by @xuruiray) and Lemonade as an LLM provider [#508](https://github.com/THU-MAIC/OpenMAIC/pull/508)
- Add OpenAI image generation environment-variable fallback [#510](https://github.com/THU-MAIC/OpenMAIC/pull/510) (by @xuruiray)
- Add generated-video manifest references so produced videos survive export/import [#540](https://github.com/THU-MAIC/OpenMAIC/pull/540)
- Add Traditional Chinese (zh-TW) [#517](https://github.com/THU-MAIC/OpenMAIC/pull/517) (by @alvinets) and Brazilian Portuguese (pt-BR) [#602](https://github.com/THU-MAIC/OpenMAIC/pull/602) (by @hemanz) interface languages

### Bug Fixes

- **Server-configured providers are now admin-managed** — providers set via server environment can no longer be overridden by client settings, preventing base-URL/key tampering on shared deployments [#624](https://github.com/THU-MAIC/OpenMAIC/pull/624); fixes server API-key fallback when the client echoes the provider base URL [#533](https://github.com/THU-MAIC/OpenMAIC/pull/533) (by @LooThao); auto-selects the server LLM model [#577](https://github.com/THU-MAIC/OpenMAIC/pull/577) (by @xuruiray); and enforces a "usable provider ⇒ concrete model" invariant [#581](https://github.com/THU-MAIC/OpenMAIC/pull/581)
- Keep interactive scenes alive across remounts with an iframe keep-alive pool, so interactive content no longer reloads when navigating [#629](https://github.com/THU-MAIC/OpenMAIC/pull/629)
- Restore the orchestration director's ability to answer the user's question and stop runaway turns (removed `maxTurns`) [#599](https://github.com/THU-MAIC/OpenMAIC/pull/599); restore agent attribution in the director summary [#554](https://github.com/THU-MAIC/OpenMAIC/pull/554) (by @ashutoshrana)
- Skip shapes with malformed SVG paths instead of aborting the whole PPTX export [#505](https://github.com/THU-MAIC/OpenMAIC/pull/505); prevent memory leaks and silent export failures [#552](https://github.com/THU-MAIC/OpenMAIC/pull/552) (by @arnow117)
- Add defensive checks in ChartElement to prevent crashes on malformed chart data [#588](https://github.com/THU-MAIC/OpenMAIC/pull/588) (by @tongshu2023)
- Let whiteboard code elements capture internal scroll/drag instead of the canvas [#544](https://github.com/THU-MAIC/OpenMAIC/pull/544) (by @cosarah)
- Preserve discussion triggers when importing classroom ZIPs [#557](https://github.com/THU-MAIC/OpenMAIC/pull/557) (by @cosarah)
- Fix generated video thumbnails [#546](https://github.com/THU-MAIC/OpenMAIC/pull/546)
- Gate media snippets in the interactive-outlines prompt template [#628](https://github.com/THU-MAIC/OpenMAIC/pull/628)
- Hide the unsupported MiniMax Hailuo fast text-to-video model [#632](https://github.com/THU-MAIC/OpenMAIC/pull/632); remove weak Lemonade recommended models [#567](https://github.com/THU-MAIC/OpenMAIC/pull/567) (by @cosarah)
- Fix Haiku 4.5 thinking controls [#501](https://github.com/THU-MAIC/OpenMAIC/pull/501)
- Use an ESM import for TypeScript in the pptxgenjs rollup config [#616](https://github.com/THU-MAIC/OpenMAIC/pull/616)
- Align zh-TW provider names with the rest of the locale set

### Other Changes

- Add a Fumadocs-based documentation site [#622](https://github.com/THU-MAIC/OpenMAIC/pull/622)
- Add a VoxCPM2 setup guide and tighten the README section [#500](https://github.com/THU-MAIC/OpenMAIC/pull/500) [#502](https://github.com/THU-MAIC/OpenMAIC/pull/502)
- Fix the commercial licensing contact email [#604](https://github.com/THU-MAIC/OpenMAIC/pull/604) (by @DHQ1204)

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

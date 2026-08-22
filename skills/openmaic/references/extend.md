# Extend Or Build On OpenMAIC (二次开发)

## Charter

Secondary development is a confirmation-heavy, **read-before-modify** guidance flow — not a generation flow. Help the user understand the existing code first, then make targeted changes. Default to **not** editing source under `packages/@openmaic/*`; consume those packages as-is. (Modifying the SDK itself is a different, heavier path — see the last section of [extend-sdk.md](extend-sdk.md).)

This reference takes priority over the `accessCode` auto-shortcut in Phase 0: if the user's intent is to extend / build on / customize OpenMAIC or consume the `@openmaic/*` SDK, enter this flow **even when a stored `accessCode` exists**. A returning Live Demo user who now wants to do 二开 should be routed here, not silently sent back to Live Demo.

## Secondary-Development Rules

1. **Read before edit.** Before changing any file, read it (and the symbols it imports) so the edit matches surrounding conventions. Do not paste large code blocks into chat — point the user at `file:line` entry points and let them read.
2. **Toolchain is hard-required.** `pnpm@10.28.0` (root `packageManager`), Node `>=20.9` (`.nvmrc` pins `22`). Mismatched pnpm will fail install.
3. **Forking and disabling CI are conditional, not defaults.** Decide per the user's intent — see Development Environment below — instead of reflexively forking every user.

## Development Environment (Same As Local Deployment)

二开的开发环境本质上就是 OpenMAIC **本地部署环境**——同一套工具链、同一个仓库、同一次 `pnpm install`、同一套 provider key 和启动方式。所以**环境搭建不要在这里另搞一套**：走标准本地部署流程拿到一个能跑的实例，二开只在其上加几个增量。

**在哪里拿代码（按需选，不强制 fork）：**

- **自用 / 不需要远程**：直接 `git clone` 上游 `THU-MAIC/OpenMAIC`，本地改、本地跑。最简单——不 fork、不管 CI。你对上游无写权限，不可能误推；建议本地 `git commit` 到一条分支做版本回滚。
- **需要远程**（备份 / 多机同步 / 协作 / 从 GitHub 部署 / 回馈上游）：fork → clone 你的 fork → 推到 fork。fork 的唯一意义是"拥有一个能 push 的远程"。

**安装与启动** → 复用现有本地部署 reference，不要重写流程：[clone.md](clone.md)（clone + `pnpm install`，后者会在 postinstall 构建全部 `@openmaic/*` 包并同步 vendor 包）、[startup-modes.md](startup-modes.md)（启动方式）、[provider-keys.md](provider-keys.md)（provider key）。

**禁用 publish CI —— 注意"触发 workflow"≠"跑 publish job"：** fork 自带 `.github/workflows/publish-packages.yml` 和 `publish-openmaic-skill.yml`，要分两层看：

- **触发层（workflow 什么时候跑）**：`publish-packages.yml` 只在 **push 到 main 且改了 `packages/@openmaic/*/package.json`** 时触发（PR 根本不触发这个 workflow）；`publish-openmaic-skill.yml` 在 **PR 或 push 到 main 且动了 `skills/openmaic/**`** 时触发。
- **job 层（哪些 job 会跑）**：`publish-openmaic-skill.yml` 在 **PR 上只跑** bash-3 兼容性 + preview（dry-run）job——这两个不需要 token；**带 `CLAWHUB_TOKEN` 的 publish job 只在 push（或 main 上的手动非 dry-run dispatch）时运行**。`publish-packages.yml` 的带 `NPM_TOKEN` 的 publish job 同样只在 push 时跑。

所以 fork 里的 token 红叉**只来自命中触发条件的 push**，PR 不会产生；普通 feature 分支推送不匹配触发条件则整个 workflow 都不跑。是否禁用取决于你的 fork 工作流：会往 main 推命中触发的改动就禁用（或去掉触发），否则不用管；纯本地自用、从不 push 同样无需处理。误发版本身已被 environment + token 闸门挡死，不用担心。

**改完代码后运行 / 验证：** 启动方式同 [startup-modes.md](startup-modes.md)，key 同 [provider-keys.md](provider-keys.md)，用 `GET {url}/api/health` 验证，UI / 路由改动在浏览器确认。若你改动了 `packages/@openmaic/*` 的**源码**，要先重建对应包的 `dist/`（消费方解析的是 `dist/` 不是 `src/`；依赖顺序 `dsl → generation → storage → importer → renderer → editor`，`pnpm install` 的 postinstall 已按此顺序构建，单包可用各自 `pnpm run build`）。

## Route To The Right Sub-Reference

Ask the user which of these they want. When unsure, offer 2–3 examples (below) and let them self-identify before loading anything.

- **Customize the OpenMAIC product itself** (change a feature / UI / swap in your own provider, storage, or theme / add a page or API route / embed the renderer or editor inside the product) → Load [extend-cookbook.md](extend-cookbook.md).
- **Use the `@openmaic/*` SDK to build a new, standalone app** (outside this repo — `npm install @openmaic/renderer` into your own project, not a monorepo workspace) → Load [extend-sdk.md](extend-sdk.md).

Typical examples to help the user pick:

- "I want OpenMAIC to call my company's LLM / write to my S3 bucket / show my branding" → **cookbook** (you are modifying the product).
- "I want to render OpenMAIC slides, or embed the slide editor, inside my own separate app" → **SDK** (you are consuming packages, not editing the product).
- "I want to add a feature to OpenMAIC and ship it in the product" → **cookbook** (modifying the product).

## General Gotchas

Each is tagged with where it bites: **[product/fork]** (working inside the OpenMAIC repo), **[SDK]** (consuming packages in a separate app), or **[both]**.

- **[product/fork] `dist/` is gitignored in a source checkout.** In a fork/monorepo, each `@openmaic/*` package ships source only; its `dist/` is produced by `postinstall` (builds `dsl → generation → storage → importer → renderer → editor` in dependency order). If you `git clean -fdx` or nuke `node_modules`, re-run `pnpm install` or the packages won't resolve. (Published npm packages — the [SDK] path — ship built `dist/`, so this does not apply there.)
- **[product/fork] The vendor bundle is asserted before build.** `pnpm build` runs `node scripts/assert-vendor-maic-importer.mjs && next build`. That guard `stat()`s `public/vendor/maic-importer/index.js`; if missing/empty it exits 1 with an actionable message. `postinstall`'s `sync-maic-importer.mjs` step populates it — re-run `pnpm run sync:maic-importer` if you cleared it.
- **[product/fork] `workspace:*` are symlinks.** Inside the monorepo, `@openmaic/*` resolve to live `packages/@openmaic/*` source via pnpm workspace links. Editing a package's `src/` is picked up on its next build — but consumers see the built `dist/`, not `src/`, so rebuild the package after source changes.
- **[both] The renderer hard-depends on Tailwind v4.** `@openmaic/renderer` has `tailwindcss: ">=4"` as a peer. Tailwind v4 uses `@theme`/`@source` CSS directives, not a JS config — see [extend-cookbook.md](extend-cookbook.md) (branding) before touching styles.
- **[product/fork] `@/*` path alias** is anchored at the repo root (`tsconfig.json` → `"@/*": ["./*"]`), not inside `packages/`.

# Phase 1+2 报告：DocumentStore 与 RuntimeStore 冷安装

> 日期：2026-07-27  
> 范围：只引入上游 storage 包能力与测试；不接入任何 RJ 业务读写路径。

## 前置结论

上游提交图不是“Part A 后可任选 RuntimeStore 或 DocumentStore”：

```text
6d6e1ac8 DocumentStore
  -> 83fdecf3 DSL runtime envelope
    -> 1c507884 RuntimeStore
```

`1c507884` 的 package 入口已经导出 `DocumentStore`，所以 `6d6e1ac8` 是 RuntimeStore 的实际祖先依赖。为可回滚，开始前在当前 main 打了 `pre-runtimestore-part-b` tag。

## 已应用提交

| 阶段 | 上游提交 | RJ 提交 | 内容 |
|---|---|---|---|
| B0 | `6d6e1ac8` | `1d52aea7` | DocumentStore package 与测试，冷安装 |
| B1 | `1c507884` | `a05ffc22` | RuntimeStore package 与测试，冷安装 |

两次 cherry-pick 均为 0 冲突。

## Turbopack / workspace 预检

`@openmaic/storage` 的 `main`、`module` 与 `exports.import` 都指向 `./dist/index.js`，而非源码。根 `postinstall` 已按正确顺序构建 DSL、再构建 storage，因此没有新增 `transpilePackages` 或 Turbopack alias；将它指向源码反而会重演 DSL 的 Turbopack 解析问题。

本地验收必须复现该顺序：先 build `@openmaic/dsl`，再 build `@openmaic/storage`，最后执行 Next build。

## 验收

| 检查 | 结果 |
|---|---|
| `@openmaic/storage` build（DSL → storage 顺序） | ✅ |
| `@openmaic/storage` Vitest | ✅ 6 files / 105 tests |
| RJ `tsc --noEmit` | ✅ |
| RJ 扩展/资产测试 | ✅ 2 files / 11 tests |
| `$env:NODE_OPTIONS=''; npx next build` | ✅ Turbopack，57/57 pages |
| app/lib/components/configs/tests 业务导入 `@openmaic/storage` | ✅ 0 个 |

## 明确未做

- 不创建 RuntimeStore singleton，不生成 learnerKey，不接 chat/PBL/quiz/playback。
- 不让应用使用 BrowserDocumentStore；scene order 写端归一任务完成前，DocumentStore 仅存在于 workspace 包。
- 不改 Supabase schema、RLS 或云同步语义。

## 回滚

生产问题时优先 `git revert a05ffc22` 后 `git revert 1d52aea7`，不使用 reset。`pre-runtimestore-part-b` tag 是开始本阶段前的精确回退锚点。

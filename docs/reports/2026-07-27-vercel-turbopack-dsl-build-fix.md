# Vercel Turbopack DSL 构建失败修复

> 日期：2026-07-27  
> 影响提交：`5dd7131`、`d540feb`

## 根因与修复

P1-b 的 TypeScript paths 将 `@openmaic/dsl` 指向源码入口，令 `tsc` 能解析 workspace 包；但 Next 16 / Turbopack 生产构建也跟随该映射进入源码。该入口以 `.js` 相对路径导出相邻 TypeScript 文件，Turbopack 无法在此路径将 `.js` 重映射到 `.ts`，因而报出 `Can't resolve './action.js'` 和后续“无 exports”错误。

`postinstall` 已成功生成 `packages/@openmaic/dsl/dist/`。根 `next.config.ts` 现保留 TypeScript 源码映射，同时通过 `turbopack.resolveAlias` 将运行时解析显式指向 `./packages/@openmaic/dsl/dist/index.js`。没有改动上游包源码。

别名使用相对 POSIX 路径；Windows 绝对路径会触发 Turbopack 的 `windows imports are not implemented yet`。

## 验证

```powershell
$env:NODE_OPTIONS=''; npx next build
```

Next.js 16.1.2 / Turbopack 编译成功，57/57 静态页面生成完成，退出码为 0。

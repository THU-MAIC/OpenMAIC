# OpenMAIC 桌面端

桌面端使用 Electron 承载现有 Next.js 应用，不复制一套 UI 或业务逻辑：

- 开发模式启动现有 Next.js 开发服务，并在 Electron 窗口中打开 `http://localhost:3000`。
- 生产模式把 Next.js standalone 服务放进应用资源目录，由 Electron 主进程在回环地址启动后再加载。
- Electron 的渲染进程启用 `contextIsolation`、禁用 Node 集成，并只通过预加载层暴露最小的桌面能力。
- 外部链接交给系统浏览器打开，应用内只允许访问本机 OpenMAIC 服务。
- Web 设置页的“同步到桌面端”通过同一个本机开发服务的一次性内存中转完成；服务端在两个 owner 之间复制加密保存的模型配置，API Key 不会经过浏览器或 Electron 渲染进程。
- 桌面端默认发现 `~/.codex/skills` 和 `~/.agents/skills` 下包含 `SKILL.md` 的本机公共 skill；也可通过 `OPENMAIC_PUBLIC_SKILLS_DIRS` 传入 JSON 目录数组覆盖扫描范围。
- 公共 skill 只读展示并按低优先级任务指导处理，不能覆盖系统指令或工具安全边界。

## 开发

```bash
pnpm desktop:dev
```

这条命令会同时启动 Next.js 和 Electron。若 3000 端口已经有服务，也可以直接运行：

```bash
pnpm exec electron desktop/main.cjs --dev
```

直接分别启动两个进程时，需要给 Next.js 和 Electron 设置相同的随机
`OPENMAIC_DESKTOP_SYNC_TOKEN`，并为 Next.js 设置
`OPENMAIC_DESKTOP_SYNC_ENABLED=1`；使用 `pnpm desktop:dev` 会自动完成这些设置。

## 打包

```bash
pnpm desktop:dist       # 当前平台
pnpm desktop:dist:mac   # macOS
pnpm desktop:dist:win   # Windows
pnpm desktop:dist:linux # Linux
```

打包前会先执行 `pnpm build`，因此桌面安装包包含可独立运行的 Next.js 服务和静态资源。模型 API Key、数据库和其他服务配置仍通过环境变量或服务端配置提供，不写入安装包。

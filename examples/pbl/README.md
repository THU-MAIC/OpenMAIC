# 最小 PBL 课程包

`future-self-lite/` 是独立编写的 Python 项目，不依赖内置项目或静态注册。
它包含一个留言函数、一个任务里程碑和 `skeleton/skills/docs/tests` 四类资源。
初始函数留空，学习者完成实现后，评测会检查中文、英文和空名字三种输入。

在仓库根目录运行：

```sh
node scripts/build-pbl-example.mjs
# 或指定 ZIP 输出位置
node scripts/build-pbl-example.mjs /tmp/course.maic.zip
```

在首页通过“导入课堂”选择生成的 `dist/future-self-lite.maic.zip`。
打包脚本根据资源计算文件索引和内容哈希，生成课程 manifest 和场景引用：

```text
future-self-lite.maic.zip
├── manifest.json
└── pbl/<内容哈希>/
    ├── project.json
    ├── skeleton/
    │   ├── PLAN.md
    │   └── src/main.py
    ├── skills/
    │   ├── SKILL.md
    │   ├── A-intro.md
    │   └── A-implement.md
    ├── docs/brief.md
    └── tests/
        ├── check.py
        └── message.json
```

本例没有媒体资源，因而不生成 `media/`。项目名称保存在 `project.json`
和 manifest 中，目录使用内容哈希。修改源文件后重新运行脚本会更新索引和引用。
`tests/` 由评测运行器临时提供，不会复制到学习者的工作区。
导入只保存资源；实际学习需要服务端配置模型和共享沙箱。

## 验证

```sh
PBL_PACKAGE_TOOLCHAINS=1 pnpm exec vitest run tests/pbl/v3/minimal-project-package.test.ts
```

测试会实际打包、读取并校验这 9 个源文件，检查教学材料绑定，并使用本机
Python 执行平台评测运行器：初始代码失败，临时工作区中补全函数后通过。
源文件中的初始代码保持未完成状态。

本例已在两个独立空 PostgreSQL 数据库上通过真实浏览器导入和重新导出，
9 个资源文件逐字节一致；服务进程重启后重新导出也一致。还验证了重复导入
复用资源，以及篡改文件后拒绝导入。本次界面验证没有调用真实模型或云沙箱。

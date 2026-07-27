# Scene Order 写端归一化报告

> 日期：2026-07-27
> 范围：为云端 `courses.data` 中的 scene 顺序提供可审计、可恢复的连续编号迁移工具；本报告记录 dry-run，不代表生产写入已执行。

## 已决策的顺序语义

本期统一使用连续编号：`scene.order === scene.seq === array index`，从 `0` 开始。

稀疏编号未在本期采用。虽然上游 DocumentStore 可按任意数值 `order` 排序，但 RJ 的本地保存、云同步、导入、generation outline 和完成进度都依赖连续编号；将稀疏编号夹带进入本次迁移会被下一次保存重新压缩，或导致 outline 对齐失效。

## 工具与安全边界

新增 `scripts/normalize-course-scene-order.js`：

- `--dry-run`：只读扫描，不写 Supabase、不创建 checkpoint；
- 默认执行：逐课写 checkpoint，可在中断后续跑；`--restart` 从头重新扫描；
- 可信课程：按有效且唯一的 `seq` 排序；
- 未可信课程：按既有恢复规则 `createdAt → updatedAt → id` 排序；
- 写入前使用 `courses.updated_at` 乐观锁；课程被并发编辑会跳过并报告，不覆盖；
- 缺 stage、非数组 scenes、缺 scene id、重复 scene id：阻断并报告，绝不猜测或静默删除；
- 对每门可迁移课程生成迁移前后 scene ID / order / seq 快照及 SHA-256 指纹。

## 验证

- `tests/scripts/normalize-course-scene-order.test.ts`：4/4 通过；
- 覆盖可信 seq、未可信稳定恢复、阻断异常、幂等重跑；
- `node --check`、Prettier、`git diff --check`：通过；
- 以无权限占位 Supabase 配置的 Next build 不在本任务中重复执行；本脚本为独立 Node CLI。

## 生产 dry-run

执行：

```powershell
node --env-file=.env.local scripts/normalize-course-scene-order.js --dry-run --report-dir=docs/reports/scene-order-migration-dry-run
```

结果：

| 项目 | 数量 |
|---|---:|
| 扫描课程 | 6 |
| 预计更新 | 6 |
| 阻断异常 | 0 |
| 时间戳歧义警告 | 0 |
| 并发跳过 | 0（dry-run 不写入） |

完整审计产物：

- `docs/reports/scene-order-migration-dry-run/before-order.json`
- `docs/reports/scene-order-migration-dry-run/after-order.json`
- `docs/reports/scene-order-migration-dry-run/dry-run.json`

## 尚未执行

生产写入尚未执行。执行前需人工确认 dry-run 结果；执行后必须再跑一次 dry-run，验收为：零阻断、零待更新、所有快照 hash 前后一致。

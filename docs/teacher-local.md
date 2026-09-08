# 教师工作台本地部署与备份

本配置面向一名老师管理多个学生，在本机或可信私网运行。开发与验收只录入虚构学生。

## 启动

1. 安装并启动 Docker Desktop，使用 Node.js 22 和项目已安装的 pnpm 依赖。
2. 运行 `pnpm teacher:setup`。脚本只启动项目名为 `openmaic-teacher-local` 的 PostgreSQL 服务，并独占创建被 Git 忽略的 `.env.local`。已有其他配置会被保留。
3. 运行 `pnpm dev`，在启动日志给出的地址打开 `/teacher`。

数据库只监听 `127.0.0.1:55432`。首次配置时可使用 `pnpm teacher:setup --port 55433` 选择其他端口；后续必须使用相同端口。模型服务仍须按原项目配置，启用本地数据库不会使外部模型服务自动变成本地服务。

## 身份备份

在教师工作台下载并妥善保存老师身份恢复码。恢复码能访问该老师的资料，应按密码保管，不放入 Git、聊天截图或共享文档。清除浏览器数据或更换浏览器后，可输入恢复码重新关联原资料。

身份恢复码只恢复访问身份，不包含数据库内容。恢复码和数据库备份都需要保管。

## 数据库备份

```powershell
pnpm teacher:backup
```

等效命令为 `node scripts/teacher-local-backup.mjs backup`。备份保存到被 Git 忽略的 `data/teacher-backups/`，文件名带时间和随机标识；已有文件不会被覆盖。脚本先验证本地配置和 Docker Compose 项目、服务标签，再使用 PostgreSQL 的自定义归档格式导出。备份凭据不会出现在命令参数或输出中，导出失败时移除本次未完成文件。

归档包含现有 PostgreSQL 数据库中的记录，可能包含学生资料、课程内容和学习记录。备份不会自动复制上传文件或远程对象存储，也不包含 `.env.local` 和老师身份恢复码。迁移整机时，还需要保管原项目配置、文件存储目录或对象存储备份，保留数据库记录与文件之间的对应关系。将完成的归档另存到私有备份介质，避免只依赖同一块硬盘。

## 恢复数据库

先停止应用，给当前数据库另做一次备份。把要恢复的可信归档放入该项目的 `data/teacher-backups/`，确认文件名及目标项目后执行：

```powershell
pnpm teacher:restore --file data/teacher-backups/你的备份文件.dump --replace
```

等效命令为 `node scripts/teacher-local-backup.mjs restore --file data/teacher-backups/你的备份文件.dump --replace`。没有 `--replace` 时脚本不会执行恢复。恢复固定针对经过标签核验的 `openmaic-teacher-local` 项目的 `postgres` 服务及 `openmaic` 数据库，不支持选择其他容器或数据库。

恢复会覆盖归档中同名的数据库对象和记录，并在一个事务内完成；发生 SQL 错误时回滚本次恢复。该操作不创建新数据库，也不会自动删除归档里没有记录的其他对象，因此应用版本应与归档对应。恢复结束后重新启动应用，必要时导入老师身份恢复码，然后核对学生数量及虚构验收记录。仅从可信私有备份恢复，PostgreSQL 归档可以包含可执行数据库定义。

第一版未提供云端备份、定时备份或跨版本数据库迁移工具。

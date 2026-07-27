# GitHub Actions workflow 解析错误修复报告

> 日期：2026-07-27
> 范围：修复 `supabase-schema-snapshot` workflow 的 YAML 表达式解析错误。

## 根因

`.github/workflows/supabase-schema-snapshot.yml` 的 PR body 表达式使用了 JavaScript 风格的字符串拼接：

```yaml
${{ github.event.inputs.reason && '> 触发说明：' + github.event.inputs.reason || '' }}
```

GitHub Actions 表达式不支持使用 `+` 拼接字符串，因此 workflow 在解析阶段失败，job 根本不会启动。该错误与 Supabase Secret、数据库连接和项目代码无关。

## 修复

改为 GitHub Actions 支持的 `format()`：

```yaml
${{ github.event.inputs.reason && format('> 触发说明：{0}', github.event.inputs.reason) || '' }}
```

## 验证

- Prettier：通过；
- `git diff --check`：通过；
- 本地未安装 `actionlint`，最终解析验证需在推送后由 GitHub Actions 完成；
- 本次修复不涉及 Supabase schema、RLS、应用代码或部署配置。

## 预期

推送修复 commit 后，`supabase-schema-snapshot` 应能进入正常 job 阶段。若随后出现失败，才需要继续检查 CLI、Secret 或数据库连接。

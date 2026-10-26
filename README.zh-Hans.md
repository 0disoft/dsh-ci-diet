<p align="center"><img src="docs/assets/readme-banner.svg" alt="CI Diet" width="820"></p>

# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ci-diet"><img src="https://img.shields.io/npm/v/dsh-ci-diet.svg" alt="npm 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="许可证：MIT"></a>
  <a href="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml"><img src="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

**找出运行过于频繁或耗时过长的 GitHub Actions 任务，应用前先审查 YAML 修改。**

CI Diet 是 alpha 阶段的 CLI 和 DeepSeek Harness（DSH）插件。它会读取 workflow 定义，并在启用后读取 GitHub Actions 历史，然后展示发现并准备范围很小的 YAML 修改；它不会自行改动 workflow。

## 安装

CLI 需要 Node `^22.19.0 || >=24.0.0`。当前 npm 版本是 `0.5.2`。

```bash
npm install --global dsh-ci-diet@0.5.2
ci-diet --version
dsh plugin --profile web add dsh-ci-diet@0.5.2
dsh --profile web
```

插件会注册 DSH 工具以及 **Settings → CI Diet** 和 **CI Diet 审查** 页面。仅安装不会扫描仓库、节省 runner 分钟或修改 workflow。如果没有全局安装 CLI，可以把 `ci-diet` 换成 `npx dsh-ci-diet@0.5.2`。

## 首次扫描与历史

在要检查的仓库中运行以下命令。静态扫描离线执行并保存报告。历史同步是单独的网络步骤，通过已认证的 `gh` CLI 发起只读 GitHub API 请求，读取最近的运行和 job。

```bash
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`gh` 需要读取仓库的 Actions 运行和 job。CI Diet 从不需要 GitHub 写入权限。HTML 报告是单个自包含文件，使用内联 CSS，不含脚本，也不会发起外部请求。在 DSH 中，`ci_diet_scan` 和 `ci_diet_sync` 都会保存报告；新插件配置默认启用网络访问和 preflight。

![CI Diet 流程：扫描、预览、人工审批、应用、测量](docs/assets/workflow.svg)

## 检测内容

<p align="center">
  <img src="docs/assets/settings-preview.png" alt="启用部署前检查和历史分析的 CI Diet 英文设置页面" width="820">
</p>
<p align="center"><sub>Settings → CI Diet 英文界面。部署前检查和历史分析默认启用。</sub></p>

| 规则 | 默认 | 查找内容 | 常见输出 |
| --- | --- | --- | --- |
| CD001 | 开 | 被更新提交取代的 PR 运行 | `concurrency` 计划 |
| CD002 | 开 | 重叠或重复的触发器候选 | 说明 |
| CD003 | 关 | 对已声明的仅文档变更运行的重型检查 | 说明 |
| CD004 | 开 | 可静态展开的大型 matrix | 审查提示 |
| CD005 | 关 | 没有 timeout 的 job | 经过测量的 `timeout-minutes` 计划 |
| CD006 | 开 | 未显式缓存且受支持的 npm、pnpm 或 Bun frozen install | 下载缓存计划 |
| CD008 | 开 | 保留时间超过需要的 artifact | 需要人工确认的 `retention-days` 计划 |

CD003 和 CD005 默认关闭。CD002、CD003 和 CD004 不生成补丁。CD005 只限制异常运行，不缩短正常执行。CD008 改变 artifact 存储的保留时间，不改变 runner 分钟。每个计划在审查并测量结果前都只是假设。

## 受支持的 npm 缓存示例

CD006 只识别范围很窄的形式：受支持的 `actions/setup-node@v7` 步骤后紧跟 `npm ci`，并且存在受跟踪的 manifest 和 lockfile。计划只添加缓存输入，版本、安装和测试保持不变。该示例假设 `package.json` 未在 `packageManager` 或 `devEngines.packageManager` 中声明 npm；若已声明 npm，v7 会自动启用缓存，因此 CI Diet 不会建议重复的缓存配置。

**修改前**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
```

**修改后**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: package-lock.json
      - run: npm ci
```

计划命令中的 `--step 1` 表示这段 YAML 数组的第二步：checkout 是 `0`，setup-node 是 `1`。它是从零开始的索引，不是步骤名称。pnpm、Bun、timeout、保留期和当前 guard 请见[插件指南](docs/guide/plugin.md)。

## 写入前审查

流程是 **scan → preview → human approval → apply → measure**。包括 `ci_diet_plan` 在内的模型工具只预览修改并计算 plan digest，不能批准、应用或回退。审查页面允许人员在输入 plan digest 末段或 change ID 后批准、应用和回退。本地写入只修改一个现有 workflow 文件中计划好的字节范围。

```bash
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet measure --cwd . --change CHANGE_ID --before-runs 100,101 --after-runs 110,111 --network
ci-diet revert --cwd . --change CHANGE_ID
```

批准只对当前计划有效。应用会创建备份、重写计划中的字节，并检查 source、dependency、policy、digest、lock 和 backup。回退会恢复备份。CI Diet 不会 commit、push、deploy、运行 workflow、更改 branch protection 或删除 artifact。

## 测量结果与限制

- 在测量前不声称节省。当历史或 workflow 归属不完整时，发现可能出错。
- dependency cache 会增加 restore 和 save 时间。缓存开销可能超过它节省的安装时间；请比较条件相同的 cold 和 warm 运行，并把缓存步骤计算在内。
- `measure` 会比较选定的真实运行，显示观察到的 runner-time 差异、成功率和重跑率。它只说明这些样本，不能证明因果关系或实际账单。
- Settings 页面保存工具配置，并显示会话范围内的报告和计划。它本身不会优化 workflow。
- 源文件哈希不匹配、审批过期或策略检查都可能阻止修改。保留修改前，请检查报告、diff 和仓库自己的检查。

| 指标 | 含义 |
| --- | --- |
| `observedRunnerSeconds` | 在收集到的运行中观察到的 runner 时间 |
| `modeledRoundedMinutes` | 按 job 向上取整的分钟数，仅用于估算 |
| `listPriceUsd` | 根据内置价格快照计算的标价估算 |
| `actualBilledUsd` | 在能证明实际账单前保持 `unknown` |

分别保留这些值，避免把模型分钟数当成账单结论。

## 文档

| 需要了解 | 阅读 |
| --- | --- |
| 安装、设置、CLI、审查和测量 | [插件指南](docs/guide/plugin.md) · [测量部分](docs/guide/plugin.md#measuring-an-applied-change) |
| 规范性产品说明与契约索引 | [规范索引](docs/spec/README.md) |
| 规则 guard、成本模型、patch 和 storage | [规则](docs/spec/rules.md) · [成本模型](docs/spec/cost-model.md) · [patch 模型](docs/spec/patch-model.md) · [storage](docs/spec/storage.md) |
| 一次真实的缓存开销测量 | [2026-10-25 缓存审查](docs/measurements/2026-10-25-cache-review.md) |

<details>
<summary>插件默认值、迁移与兼容性</summary>

新的 DSH 配置会启用 `preflightEnabled`、`networkEnabled`、`localApplyEnabled` 和 CD001、CD002、CD004、CD006、CD008。一次性迁移会记录 `defaultsRevision: 2`；之后选择的开关和规则在重启后仍会保留。CD003 和 CD005 在显式启用前保持关闭。状态路径、保留期、配额和现有费用输入都会保留。

插件支持 DSH `>=0.2.1-rc.2 <0.3.0-0` 和 `>=0.2.2-rc.1 <0.3.0-0`。不支持 DSH `0.3.0`。插件 preflight 会在受支持的部署命令运行前检查，但不会发起网络请求或修改文件，并会跳过无法识别的 shell。CLI 历史需要 `--network`；插件网络开关只允许 sync 工具调用 `gh`。使用相同命令并加上 `@latest` 更新，然后重启 DSH。

</details>

## 贡献与许可证

欢迎在 [GitHub Issues](https://github.com/0disoft/dsh-ci-diet/issues) 提交 bug 和范围明确的建议。修改规则或契约前，请先阅读[插件指南](docs/guide/plugin.md)和[决策记录](docs/spec/decisions.md)。详细规范和公开文档使用英语。

MIT © Rodisoft

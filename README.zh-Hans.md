# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

**状态：** alpha；`dsh-ci-diet@0.5.1` 已发布到 npm。当前源码树在现有契约、分析引擎、补丁引擎、CLI、DSH 工具、设置页面和自包含 HTML 报告之外，新增了 **设置 → CI Diet Reports** 审查页面。审查页面已在之前的提交中通过真实浏览器 E2E。一次性默认值迁移另行在 DSH `0.2.1-rc.2` 的 configEditor、SettingsForms 和 Loader 运行时中验证，并不表示这次重新验证了浏览器页面渲染。DSH 插件现在默认开启 preflight、历史网络访问和本地应用。

**DSH 默认值和迁移。** 新配置档默认启用 `preflightEnabled`、`networkEnabled`、`localApplyEnabled` 以及 CD001、CD002、CD004、CD006、CD008。锁定配置档迁移会记录 `defaultsRevision: 2`。已经迁移到修订版 1 的配置档会保留之后选择的开关和规则。状态路径、保留期限、配额和现有数值型账户输入均会保留。除非主动启用，CD003 和 CD005 保持关闭。金额估算会自动使用两项账户输入；留空表示未知，显式填写 `0` 是有效的。以前启用过计费的配置档在省略某个值时，会保留其零默认值。

CI Diet 用于查找可能被浪费的 GitHub Actions 工作，保留每个发现背后的证据，并预览供人审查的小型 workflow 修改。

**只安装本工具不会节省 runner 分钟。** 支持的 DSH 部署命令会在运行前自动检查节省候选项；workflow 修改只有在审查和批准后才会应用。DSH 插件没有批准、apply 或 revert 工具，preflight 本身不会修改文件。设置页面保存工具配置并显示主机提供的会话级报告和计划，不会自行优化 workflow。已批准的本地写入默认开启，但应用仍需单独的 digest 批准。任何发现都不能保证降低成本。

`preflightEnabled` 默认为开启。在带 `workdir` 参数的受支持 stateless DSH bash tool 中，literal `git push`、`npm|pnpm|bun publish`、`wrangler deploy` 或 `npm|pnpm|bun run deploy` 执行前会做一次离线检查。它会把 npm CD006、仅 PR workflow 缺少 concurrency、以及未显式设置下载缓存的 Bun frozen install 作为候选项提示审查。存在候选项时，第一次命令不会执行；模型审查这些项目后重试同一命令即可放行。preflight 本身不会联网，也不会自动修改文件；应用 plan 仍需要人工批准。持久 shell 和复杂 shell wrapper 无法可靠识别，preflight 会跳过。节省量尚未测量，因此不声称节省。

## 功能

静态扫描读取目标检出目录中的 workflow YAML。可选的历史同步通过只读 `gh api` 调用收集最近的运行。每项发现都带有证据级别（`observed`、`inferred` 或 `static`）以及各维度的采集 coverage。

| 规则 | 查找内容 | 可能的 plan |
| --- | --- | --- |
| CD001 | 被较新提交取代的 PR 运行 | `concurrency` 编辑 |
| CD002 | 重叠的触发器 | 仅解释 |
| CD003 | 仅文档变更仍执行重型检查 | 仅解释，默认关闭 |
| CD004 | 过大的矩阵 | 仅解释 |
| CD005 | 缺少 `timeout-minutes` 的 job | timeout 编辑，默认关闭 |
| CD006 | npm / pnpm / Bun | [CD006](docs/spec/rules.md) |
| CD008 | 过长的 artifact 保留时间 | 保留时间编辑 |

CD001 针对因出现较新提交而重叠、已被取代的 PR 运行。CD005 为异常运行设置上限，不会缩短正常 job 的运行时间。CD008 改变 artifact 的存储保留时间，与 runner 分钟无关。CD003 和 CD005 在通过质量门槛前默认关闭。

CD006 还支持经过验证的 npm/pnpm 配置，以及使用 `oven-sh/setup-bun@v2`、随后执行 `bun install --frozen-lockfile` 并且采用受跟踪的文本文件 `bun.lock` 的 Bun 作业。Bun 会增加一个下载缓存步骤；安装和测试仍会运行。缓存恢复/保存的开销可能超过其收益。请参阅[当前缓存防护](docs/spec/rules.md#bun-dependency-cache-variant)和[一个实测示例](docs/measurements/2026-10-25-cache-review.md)。下面的 npm 示例展示了其中一种受支持的配置。

## 安装与升级

CLI 需要 Node `^22.19.0 || >=24.0.0`。插件支持 DSH `>=0.2.1-rc.2 <0.3.0-0` 和 `>=0.2.2-rc.1 <0.3.0-0`。版本 `0.3.1` 已在 DSH `0.2.1-rc.2` 上验证；不支持 DSH `0.3.0`。

```
npm install --global dsh-ci-diet@0.5.1
ci-diet --version
```

如果不希望全局安装，请把命令名 `ci-diet` 替换为 `npx dsh-ci-diet@0.5.1`，例如 `npx dsh-ci-diet@0.5.1 report --cwd .`。

```
dsh plugin --profile web add dsh-ci-diet@0.5.1
dsh --profile web
```

安装后会注册插件工具、设置页面和 **设置 → CI Diet Reports** 审查页面。插件的 preflight、网络访问和本地应用默认开启。安装和启动不会调用 `gh`、收集历史、执行扫描或修改 workflow。

```
npm install --global dsh-ci-diet@latest
dsh plugin --profile web add dsh-ci-diet@latest
```

更新插件后重启 DSH。使用 `dsh plugin --profile web list`、`ci-diet --version` 或 `npx dsh-ci-diet@latest --version` 核对已安装版本。

## 首次扫描与历史报告

在要检查的仓库中运行这些命令。`--cwd .` 表示该仓库；`--cwd` 也可以接受其他路径，相对路径从实际生效的工作目录解析。第一个命令离线执行。历史采集需要单独、明确地允许网络访问。

```
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`scan` 在没有网络的情况下输出静态报告；`--json` 或 `--out FILE` 可以写出该输出，但 CLI scan 不会把报告保存到状态存储。`report` 需要 CLI `sync`、插件 `ci_diet_scan` 或插件 `ci_diet_sync` 已保存的报告。在下面的纯 CLI 流程中，sync 会保存报告，随后 HTML 选项生成一个自包含文件。历史同步要求安装并认证 `gh`，且 `gh` 能读取该仓库的 Actions 运行和 job。`sync --network` 是 CLI 的网络启用方式，不需要 GitHub 写权限。历史不完整时仍会生成并保存报告，并标出覆盖不完整的维度。插件的离线 `ci_diet_scan` 会保存报告，因此可以直接在其后运行 `ci_diet_report`。

DSH 插件的网络访问默认开启，因此只要 `gh` 已安装并认证，就可以运行 `ci_diet_sync`。该开关只允许这个工具调用 `gh`；安装、启动和保存设置本身不会收集历史。要阻止插件联网，请在 **设置 → CI Diet** 中关闭 **允许网络访问**，然后选择 **保存更改**。该页面设置只作用于插件工具，不会开启 CLI 的 `--network` 参数。静态扫描和报告无需网络。设置页面本身不会执行优化。

清晰的聊天请求应写明执行顺序和审查边界。请把示例绝对路径换成自己的仓库路径：

> 以 cwd `C:\work\my-repo` 运行 `ci_diet_scan`，再用同一个 cwd 运行 `ci_diet_sync` 和 `ci_diet_report`。如果 `gh` 未认证或我关闭了网络访问，就在扫描后停止。如果用 `ci_diet_plan` 预览补丁，只显示编辑内容。不要批准、apply、revert、提交、推送或部署任何内容。

插件预览不会保存 plan。响应中的 `nextCommand` 会通过 CLI 重新创建 plan，使其持久保存并进入人工批准流程。

## 离线 npm 缓存 plan（CD006）

CD006 不需要运行历史。它匹配仓库根目录下的 job：`actions/checkout` 没有用户 `with` 选项，紧接其后恰好有一个未启用缓存的 `actions/setup-node@v3` 或 `@v4` 步骤，再下一步的 `run` 正好是 `npm ci`。根目录的 `package.json` 和 `package-lock.json` 必须是已提交的普通 JSON 文件。plan 只向 setup-node 添加 `cache: npm` 和 `cache-dependency-path: package-lock.json`，不改变 Node、action 版本、`npm ci`、测试或本地缓存。

```
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
```

`--step` 是 setup-node 步骤从 0 开始的索引；示例假设 checkout 是 0、setup-node 是 1。CLI `plan` 在内存中执行这次静态扫描，无需先 `sync` 就能保存 plan，并保留最新已保存的报告。插件 `ci_diet_plan` 仍需要已保存的报告，所以先运行 `ci_diet_scan`。审批和适用沿用下面的现有命令。plan 和 attestation 会在规划阶段保存；人工批准 plan 并运行 apply 之前，不会修改任何 workflow 文件。

## CLI 命令参考

```
ci-diet scan --cwd .
ci-diet sync --cwd . --network
ci-diet sync --cwd . --network --repo OWNER/REPO --days 7
ci-diet report --cwd .
ci-diet report --cwd . --format json
ci-diet report --cwd . --format html --out report.html
ci-diet diagnose --cwd .
ci-diet prune
ci-diet changes --cwd .
ci-diet plans --cwd . --plan PLAN_ID
ci-diet report --cwd . --lang ko
```

`scan` 检查 workflow 文件。`sync` 仅在指定 `--network` 时读取历史；`--repo` 明确选择 `OWNER/REPO`，`--days` 在配置范围内调整回溯时间。`report` 输出文本、JSON 或 HTML，`--out` 相对于 `--cwd` 写入。`diagnose` 根据已保存历史解释 job 名称匹配和 coverage；加上 `--require-complete` 后，数据不完整会以退出码 `3` 结束。`prune` 按状态存储设置删除过期报告、plan 和缓存项。`changes` 列出已经应用的修改，`plans` 重新显示已保存的 plan。`--config FILE` 可为任意命令合并部分 JSON 配置。

## 审查、批准、apply 与 revert

成功的 CLI `plan` 会显示提议的 diff、类似 `p_...` 的真实 plan id，以及由 plan digest 最后 12 个字符组成的 confirmation。创建 plan 时会拒绝过期证据和其他不安全的写入；找不到 workflow 可能是用法错误并以退出码 `1` 结束。如果查看已保存 plan 时工作区或 workflow 消失，`plans --plan` 会隐藏 diff、保留 plan JSON、要求重新创建 plan，并以退出码 `3` 结束。workflow 字节与保存的源哈希不一致时也是如此。批准前请再次检查 diff 和 plan。

```
ci-diet plan --cwd . --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet revert --cwd . --change CHANGE_ID
```

把 `PLAN_ID` 换成 plan 输出的 id，把 `CONFIRMATION` 换成 digest 的最后 12 个字符，把 `CHANGE_ID` 换成 apply 输出的 id。每个值都作为字面参数传入，不要输入尖括号。`approve` 创建一次性批准，`apply` 只改写一个 workflow 文件中计划好的字节范围，`revert` 恢复该变更的备份。检查结果 diff，并按需运行仓库检查。CI Diet 不会提交、推送、部署、运行 workflow、修改分支保护或删除 artifact。

对于符合条件的仅 PR CI，CD001 示例中的 `ci-only` 和 `replace-safe` 是人工 attestation。它们表示操作者已经审查取消运行的语义，不是绕过开关。CD005 需要测量得到的 `--job` 和 `--minutes`；CD008 需要 `--job`、目标 step 从 0 开始的数字 `--step` 数组索引以及 artifact claims。CD006 需要 `--job` 和 setup-node/setup-bun 步骤从 0 开始的 `--step` 索引，不需要 claims。两个步骤规则中的数字 step 都是数组索引，不是步骤名称令牌。

## 状态与限制

CLI 和插件共享默认状态目录：Windows 上为 `%LOCALAPPDATA%\CI-Diet\profiles\default`，其他平台为 `~/.local/state/ci-diet/profiles/default`。插件里的 `stateDir` 覆盖会形成独立存储；在 CLI 的 `plan`、`approve`、`apply`、`revert` 中都要用 `--state-dir` 传入同一个绝对路径。CLI 的相对 `--state-dir` 从实际生效的 `--cwd` 解析。现有状态不会在不同目录间自动迁移。

Web 客户端有设置页面和 **CI Diet Reports** 审查页面。报告、批准、apply 和 revert 控件已在之前的提交中通过真实浏览器 E2E。默认值迁移则在 DSH `0.2.1-rc.2` 运行时中，使用 configEditor、SettingsForms、Loader 和临时 profile 单独验证：legacy `false` 会保存为 `true`，之后显式保存的 `false` 在重启后仍保持关闭。这不是新的浏览器渲染验证。批准和应用会从该页面发送给主机，`localApplyEnabled` 默认开启。插件工具不执行批准或应用。plan 会对一个现有 workflow 文件做字节范围编辑，不支持的结构会被拒绝。历史或 workflow 归属信息不完整时，发现可能有误或缺失，其他系统可能拥有更准确的账单数据。请把报告作为审查证据，并在 GitHub 中单独确认效果。

## 成本与证据

| 字段 | 含义 |
| --- | --- |
| `observedRunnerSeconds` | 采集运行中记录的 runner 时间 |
| `modeledRoundedMinutes` | 为建模按 job 向上取整的分钟数 |
| `listPriceUsd` | 按报告内嵌的定价快照计算的费用 |
| `actualBilledUsd` | 在能够证明实际账单前始终为 `null` |

报告会嵌入定价快照和内容哈希，以便以后复现数字。它不会声称自动节省。HTML 报告只包含内联 CSS，没有脚本或外部请求。

## 语言

DSH 设置 UI、CLI 消息、HTML 报告和这六份 README 支持英语、韩语、简体中文、印地语、西班牙语和法语。详细规范仅提供英语。选择顺序为 `--lang`、DSH locale、`LC_ALL`/`LC_MESSAGES`/`LANG`、英语。CLI 语言代码是 `en`、`ko`、`zh-Hans`、`hi`、`es`、`fr`；把示例命令中的 `ko` 换成所需代码。地区标签按语言解析。报告以英语保存，显示时再翻译。规则 id、错误代码、枚举值、路径、哈希和数字保持原文。HTML 的 `lang` 属性跟随所选 locale。DSH 工具描述在加载插件时固定，因此更改 DSH 语言偏好后需要重新加载。

## 开发

```
bun install
node scripts/test-core.mjs
node scripts/gen-types.mjs --check
node scripts/sync-contracts.mjs --check
bun run typecheck
bun run lint
bun run test:docs
```

使用 Node 运行测试，以保持发布入口与 Node 兼容。Bun 仅用于依赖管理。

## 发布

推送与 `package.json` 一致的标签会启动 `.github/workflows/publish.yml`。下面的两个参数中，把字面 `VERSION` 换成新版本；`0.3.1` 已经发布，不要再次创建该标签。

```
git tag vVERSION
git push origin vVERSION
```

工作流会比较标签与 `package.json`、运行发布检查、拒绝已存在的 npm 版本，并通过 GitHub OIDC 使用 npm trusted publishing 发布。trusted publisher 必须指定 `publish.yml`。

## 目录结构

```
src/core        workflow parsing, rules, savings, patch engine
src/adapters    GitHub, git, storage
src/client      Web Settings and review UI
src/dsh         host plugin and bundle code
src/cli         command-line entry
src/shared      i18n and shared helpers
contracts       JSON Schemas from the frozen design pack
examples        sample records and evaluation vectors
docs/spec       normative specification
scripts         contract and documentation checks
tests/unit      fast checks that need no network
```

## 文档

详细规范、规则、成本、补丁、存储和决策文档均使用**英语**。规范索引是 [docs/spec/README.md](docs/spec/README.md)。另见[规则](docs/spec/rules.md)、[成本模型](docs/spec/cost-model.md)、[补丁模型](docs/spec/patch-model.md)、[存储与错误](docs/spec/storage.md)、[决策](docs/spec/decisions.md)、[测量](docs/spikes/a0a-rules.md)、[插件与 CLI 指南](docs/guide/plugin.md)以及[契约来源](contracts/UPSTREAM.md)。

## 许可证

MIT

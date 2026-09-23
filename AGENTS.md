# AGENTS.md

本文件面向**一切** AI 编码代理（Claude Code / Cursor / Codex / 其他）。在这个仓库动手前先读完本文件；上游的 `CLAUDE.md` 已删除，仍有价值的部分合并在 §8，需要更多深度时按 §6 文档地图查对应文档。

## 1. 这个仓库是什么

**`decolua/9router` 的个人 fork，用作个人 AI 网关**：一个 OpenAI 兼容端点（`/v1/*`）+ Next.js 控制面板 + 路由/翻译引擎（`open-sse/`）。它不是上游项目的附属副本，有三件事定义了日常形态：

- **上游只读**：只从 `decolua/9router` merge 有价值的修复，永不回推（§4）。
- **做过减法**：一批上游功能被主动删除，且**必须保持删除**（§2）。
- **做过加法**：一批上游没有的个人功能（§3）。

三条主线，动手前先判断自己的改动属于哪条：

| 线 | 内容 | 纪律 |
|---|---|---|
| 个人线 | 自己加的功能（§3） | 只推 `origin`；不要因为"上游没有"就重构掉 |
| 上游线 | merge 进来的 provider 适配、流式修复 | 按 §4 协议合并，冲突默认保留本地删除 |
| 删除线 | 已删功能（§2） | merge 后检查复活并再删；不要把残留当 bug 修回去 |

## 2. 已删除的上游功能——保持删除

以下均已从代码树删除（可 `git ls-files` 验证）。上游 merge 会让其中目录/文件级内容作为新文件复活，**必须再次删除**（检查命令见 `docs/UPSTREAM-SYNC.md` §2.1）：

| 删除项 | 备注 |
|---|---|
| combo（组合） | `combosRepo.js` / `combos` 表**故意保留**：`tests/unit/db-migration-chain.test.js` 断言表存在，功能层停用即可，空表零成本 |
| proxy pools | |
| capacity / vision adapter | |
| 9Remote 推广弹窗 + `NineRemoteButton` | 纯引流 |
| 9English 链接 | |
| gitbook 文档站 + `gitbook-pages.yml` workflow | 上游仍在维护内容，合并后最易复活 |
| README 机器翻译副本 + `scripts/translate-readme.js` | |
| 多语言系统 | `public/i18n/literals/` 只留 `zh-CN.json`；`src/i18n/runtime.js` 是**保留**的精简运行时，上游若改它需人工合并，保持固定 zh-CN |
| docker-publish workflow | fork 的 CI 不得推上游 Docker Hub |
| 侧边栏入口：basic-chat、PXPIPE | nav 项以注释保留，路由文件仍在但无入口 |
| compact 等条目 | 以 `docs/UPSTREAM-SYNC.md` §2 冲突处理表的清单为准 |
| `CLAUDE.md` | 上游的代理指引（2026-07 添加后未再维护）；内容已合并进本文件 §8，上游 master 仍有此文件，复活则再删 |
| npm 自升级机制（2026-09-23 删除） | 侧边栏 "New version available" 横幅与手动更新面板、`/api/version` GET 与 `/api/version/update` 路由、`src/lib/updater/`、`src/lib/appUpdater.js`、CLI 的 `checkForUpdate()` / `--skip-update` / "Update to vX" 菜单项、`UPDATER_CONFIG` 的 install 字段。**保留**：`/api/version/shutdown` 路由与 `src/lib/processKill.js`（profile 页和 HeaderMenu 的关停按钮在用）、侧边栏版本号展示 |

`docs/FEATURE-REMOVAL-PLAN.md` 是当时的施工单，**已执行完毕**，只作历史参考——不要按它以为这些功能还在。

## 3. 个人新增功能——上游没有

| 功能 | 位置 / 文档 |
|---|---|
| 百度网盘多实例 DB 同步 | `src/app/api/sync/baidu/*`、`src/lib/sync/baidu/*`；手册 `docs/BAIDU-SYNC.md`（动它之前必读：冲突语义、排除表、已知坑） |
| 重复账户凭证检测 | providers / connections 相关 |
| 自定义模型能力与思考档位、账户冷却状态展示与清除 | providers 相关页面 |
| 用量明细显示 account/connection 名 | `src/app/(dashboard)/dashboard/usage/` 相关 |

这些是**故意与上游分叉**的代码：与上游架构不一致 ≠ bug，上游没有文档 ≠ 过时。要动它们先读上表指向的文档。

## 4. Git 拓扑与上游同步协议

| remote | 指向 | 用途 |
|---|---|---|
| `origin` | `18459115408/9router` | 个人仓库，日常 push 目标 |
| `upstream` | `decolua/9router` | **只读**。pushurl 已置 `DISABLED`；`.git/hooks/pre-push` 拦截一切指向上游的推送（按 remote 名或裸 URL）；`master` 跟踪 `origin/master` |

- 个人线只有一条分支：`master`。上游更新用 **merge，不要 rebase**——删过上游功能，rebase 会反复冲突，merge 只在同一处代码被双方改动时才冲突一次。
- 查上游新提交：`git updates`（alias = `git fetch upstream && git log --oneline master..upstream/master`；无输出 = 已跟平）。
- 冲突默认策略：上游改到你删掉/改过的代码 → **保留删除**；上游新增同类推广/文档站文件 → 再次删掉；无关的 provider 适配、流式修复 → 照常接受（这是同步的主要收益）。
- 合并前后细节、回滚、快照分支恢复：`docs/UPSTREAM-SYNC.md`，**同步操作前必读**。
- ⚠️ 推送隔离三道配置 + 钩子都是**本机**的，不随 clone 传播。重新 clone 后必须按 runbook §0.1 重配一遍，否则有误推原仓库的风险。

## 5. 代理工作规则（Pitfalls）

- **本 fork 不自升级**：npm 系的自升级机制已整体删除（横幅、CLI 启动检查、`/api/version*` 路由、`src/lib/updater/`，清单见 §2）。`package.json` 版本低于 npm registry 是**正常现象**（当前 0.5.81 < registry 0.5.86——上游 npm 发布走在 git master 前面），升级只有一条路：merge `upstream/master`（§4）。不要为消掉版本差 bump `package.json`，也不要把 npm 安装入口加回来。
- 改任何功能前，先对照 §2 删除清单 grep 一下——你很可能在改一个**被故意删掉**的功能的残留。
- 修 bug 前先 `git updates`：上游几乎每天有 provider 适配和流式修复，可能已经修了。
- **界面固定中文**：源码串写英文，运行时替换为中文（`src/i18n/runtime.js`）。新 UI 文案写英文源码串，词条只维护 `public/i18n/literals/zh-CN.json`，不要引入语言切换。
- 测试套件**不是全绿**（约 64 个已知失败，清单和原因见 §8）。回归判断用 `tests/__baseline__/verify-no-regression.mjs`，不要看到一片红就逐个去"修"。
- `skills/` 是**产品资产**：通过 raw.githubusercontent 链接分发给终端用户代理的 drop-in skills，不是本仓库的开发指引，别按它改代码。
- 提交信息用 Conventional Commits（`fix(sync): …`、`feat(providers): …`）；root 与 `cli/` 版本独立管理，变更记 `CHANGELOG.md`。

## 6. 文档地图

| 文档 | 什么时候读 |
|---|---|
| `docs/UPSTREAM-SYNC.md` | 任何同步 / 合并 / 推送操作前；合并后按 §2.1 复查删除项复活 |
| `docs/BAIDU-SYNC.md` | 动百度网盘同步功能前后 |
| `docs/ARCHITECTURE.md` | 需要系统级理解（请求生命周期、账号 fallback、OAuth、数据模型）；**persistence 段过时**（仍是 `db.json` 描述），以 §8 和代码为准 |
| `open-sse/AGENTS.md` | 动 `open-sse/` 下任何代码前 |
| `tests/translator/AGENTS.md` | 动 translator 或其测试前 |
| `docs/FEATURE-REMOVAL-PLAN.md` | 仅历史参考（已执行完） |
| `docs/superpowers/` | plans / specs 存档 |

## 7. 环境速查

- 纯 JavaScript（ESM），无 TypeScript；`@/*` → `src/*`（`jsconfig.json`）。
- `cp .env.example .env && npm install && npm run dev`（dev 脚本固定端口 20127；`.env.example` 与 `APP_CONFIG.appPort` 默认 20128）。生产：`npm run build && npm run start`。Lint：`npx eslint .`。
- Bun 变体脚本：`dev:bun` / `build:bun` / `start:bun`；CLI 打包：`npm run cli:pack`。

## 8. 技术要点（原上游 `CLAUDE.md` 的合并保留）

上游 `CLAUDE.md` 已于 2026-09-23 删除（上游写完就没再维护，内容合并于此，避免两处漂移）。以下条目别处没有、或别处已过时，动对应代码前必读：

- **一个仓库两个发布物**：根 `package.json`（`9router-app`——dashboard + gateway，真正干路由的服务器）和 `cli/`（发布到 npm 的 `9router` 启动器，管安装和托盘）。两者版本独立、各自演进，`cli/` 有自己的 `package.json` 和构建。
- **请求主链路**（先理解它再动手）：`/v1/*`（Next rewrite 映射到 `/api/v1/*`，见 `next.config.mjs`）→ `src/sse/handlers/chat.js`（解析、账号选择循环）→ `open-sse/handlers/chatCore.js`（格式识别、翻译、executor 分发、重试/刷新、流式）→ `open-sse/executors/*` → `open-sse/translator/*` → SSE 回客户端。`src/sse/` 是应用侧胶水，`open-sse/` 是 provider 无关引擎，**跨越这条边界要清醒**。深度版见 `docs/ARCHITECTURE.md`。
- **持久层**：状态**不是 `db.json`**，是 SQLite，驱动链 `bun:sqlite` → `better-sqlite3`（在 optionalDependencies，装不上不报错）→ `node:sqlite`（Node ≥22.5）→ `sql.js`（纯 JS 兜底，永远可用）。`src/lib/localDb.js` 只是向前兼容 shim，新代码 import `@/lib/db/index.js`，实体逻辑在 `src/lib/db/repos/*`，schema/迁移在 `src/lib/db/migrations/`。DB 路径看 `src/lib/db/paths.js`（`DATA_DIR`，否则 `~/.9router/`）；usage/logs（`src/lib/usageDb.js`）不跟 `DATA_DIR`，固定在 `~/.9router`。⚠️ `docs/ARCHITECTURE.md` 的 persistence 段还是 `db.json` 的旧描述，**以本节和代码为准**。
- **测试基线**：套件**不是全绿**——约 938 过、64 挂是预期状态。已知失败集中在 `tests/__baseline__/known-fails.txt`（rtk、oauth-cursor-auto-import、translator-request-normalization 等）；`unit/embeddings.cloud.test.js` 必挂（`cloud/` worker 目录不在本仓）；`unit/xai-oauth-service.test.js` 在 xAI 端点发现请求不可达时会超时；`tests/translator/real/*.real.test.js` 打真实 provider，无凭证要跳过。判回归用 `tests/__baseline__/verify-no-regression.mjs`（对拍提交的快照），改 provider 注册表 / alias 逻辑 / OAuth URL 后必跑。另：tests 是独立 ESM 包，先根目录 `npm install` 再 `cd tests && npm install`；`tests/package.json` 里硬编码 Unix 路径的 `test` 脚本在 Windows 不可用，统一用 `npx vitest run`。
- **安全 env**：`JWT_SECRET`（会话 cookie）、`INITIAL_PASSWORD`（默认 `123456`，必须覆盖）、`API_KEY_SECRET`、`MACHINE_ID_SALT`。完整契约见 `.env.example` 和 `docs/ARCHITECTURE.md` 的 env 矩阵。
- **`custom-server.js`**：在 Next standalone 外包了一层，从 TCP socket 推导客户端 IP 并剥离攻击可控的 `X-Forwarded-For`，只信任 loopback 反代转发的头。动请求 / IP / 限流 / 封禁代码时必须保留这个行为。

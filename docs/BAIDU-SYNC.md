# 百度网盘同步（Baidu Netdisk Sync）运行手册

> 功能把本机 SQLite 数据库加密后同步到百度网盘，用于多实例之间共享数据。
> 本文记录**运行方式、配置、数据落点**，以及 2026-09-21 排查时发现的问题与坑。
> 编写时间：2026-09-21

---

## 1. 一句话原理

每个实例定期检查云端快照（1 次 API 调用），若别的机器推过更新的数据就拉取并应用，若本地内容变了就推送一份 `gzip + AES-256-GCM` 加密的整库快照。冲突语义（2026-09-22 起）：配置类表仍是**文件级 last-writer-wins**；**用量三表在拉取时按合并语义应用** —— `usageHistory` 内容去重并集、`usageDaily` 按 `byMachine` 分片每片取较新、`_meta` 的 `totalRequestsLifetime:<machineId>` 取 max，因此多机并发产生的用量是**相加**而不是互相覆盖（详见 §3.1）。

| 项目 | 值 |
|---|---|
| 远端文件 | `/apps/9router/9router-sync/data.sqlite.enc` |
| 单文件内容 | 加密后的整库快照（**看不到内部内容**） |
| 加密算法 | `scrypt(BAIDU_SYNC_KEY, salt)` → AES-256-GCM，明文先 gzip |
| 容器格式 | `MAGIC("9RSYNC1", 8B) \| salt(16B) \| iv(12B) \| gcm-tag(16B) \| ciphertext` |
| 上传方式 | `precreate → superfile2（4MB/片）→ create` 三步分片，**任何大小都走这条**（单步上传接口已被百度废弃，见 §6.9） |
| 排除表 | 默认 `requestDetails,apiKeys`，永不参与同步，也不被拉取覆盖 |

**`/apps/<应用名>/` 是百度网盘给应用划的沙箱目录**：网页版里它在「我的应用数据」下面，**不在「我的网盘」根目录**。去根目录找会以为同步没生效。

---

## 2. 配置（.env）

| 变量 | 必需 | 说明 |
|---|---|---|
| `BAIDU_SYNC` | 否 | `off`/`false`/`0`/`no` 关闭调度；其他值或未设=启用 |
| `BAIDU_APP_KEY` | **是** | 应用 AppKey。`isConfigured()` 的判定项之一 |
| `BAIDU_SECRET_KEY` | **是** | 应用 SecretKey。判定项之一 |
| `BAIDU_SYNC_KEY` | **是** | 同步口令，加解密快照用。判定项之一；缺失时引擎拒绝推送明文库 |
| `BAIDU_SIGN_KEY` | 否 | 预留 |
| `BAIDU_APP_NAME` | 否 | 默认 `9router`，决定远端目录名 |
| `BAIDU_REMOTE_DIR` | 否 | 默认 `/apps/<BAIDU_APP_NAME>/9router-sync` |
| `BAIDU_REDIRECT_URI` | 否 | 未设时授权走 `oob`（页面显示授权码，手工粘贴） |
| `BAIDU_SYNC_INTERVAL_MINUTES` | 否 | 默认 30 |
| `BAIDU_SYNC_EXCLUDE_TABLES` | 否 | 逗号分隔，默认 `requestDetails,apiKeys`（`apiKeys` 是入站访问密钥，该功能计划移除，2026-09-22 起刻意排除） |

> `isConfigured()` **只看上面三个必需项是否存在，不看是否已授权**。这是刻意的，见 §5.1。

---

## 3. 运行机制

- 服务启动时 `src/instrumentation.js` 调用 `startBaiduSync()` 挂上调度器。
- **首次 tick 在启动后 15 秒**（`INITIAL_DELAY_MS`），不是等一个完整周期。
- 之后每 `BAIDU_SYNC_INTERVAL_MINUTES` 一轮。`custom-server.js` 启动的生产模式首轮可能因 Next 别名未就绪而失败，下轮自动重试。
- 每轮顺序：`getAccessToken` → `filemetas` 探测远端（1 次调用）→ 判断是否拉取 → 本地逻辑哈希变化时才推送。
- 推送前会把当前库快照存到 `db/backups/sync-apply-*/`，**只保留最近 3 份**。
- 百度配额错误（errno `20012`/`9013`）触发指数退避，最长 6 小时。
- 拉取应用前会比对 `_meta.schemaVersion`，两端版本不一致直接报错拒绝（避免结构错配写坏库）。

### 3.1 用量合并（多机并发不丢用量）

- **分片 ID**：`sha256(<DATA_DIR>/machine-id)` 前 16 位（与应用机器码同源文件，本机生成、不同步）。每台机只写自己的分片/计数键 —— 单写者是合并幂等的前提。
- **`usageDaily`**：JSON 内部按 `byMachine: { <id>: {…当日计数…, ts} }` 分片；写入只动自己的分片，顶层 totals 每次**由分片求和重算**（读路径看到的结构不变）。拉取合并对每个分片取 `ts` 较新的一份（同 ts 比 requests，再同则按 JSON 字典序，保证两台机裁决一致），跨分片求和 —— 重放同一快照不双计，云端被旧快照覆盖过也能自愈。
- **`usageHistory`**：按 `saveRequestUsage` 现成的内容去重谓词做 `INSERT … WHERE NOT EXISTS` 并集；`id` 不随快照travel（由本机序列重新分配 —— 两机 AUTOINCREMENT 同基线，跨机 id 会撞车），因此相关查询按 `timestamp` 排序。
- **`_meta.totalRequestsLifetime:<machineId>`**：每机只自增自己的键，合并取 max；旧的无后缀键不再写入（无读取方）。
- **回推**：合并后若本地存在云端缺的用量内容（localExtras > 0），**当轮立即推送并集**（日志 `Pull merged N local-only usage item(s)`）；否则沿用旧行为把拉到的内容采纳为推送基线，避免无意义的回声上传。
- **旧格式兼容**：迁移前的 `usageDaily` blob 无 `byMachine`，读写/合并时折叠进共享的 `legacy` 分片；两侧同值时合并不翻倍，只有历史分叉时取计数大的一份（等于旧 LWW 的结果，永不相加）。
- **已知边界**：配置表（providers/settings 等）仍是整表覆盖 —— 拉取会抹掉本地未推送的配置改动（行级合并在下一批）；`settings`/`kv` 单槽值即使行级化也仍需 LWW。

---

## 4. 授权流程（oob）

`BAIDU_REDIRECT_URI` 未设置时走 out-of-band 流程，三步：

1. 打开 `/api/sync/baidu/authorize` → 跳转百度登录/确认页
2. 确认后百度**在页面上显示一串授权码**（点「复制授权码」）
3. 把授权码填回 9router 完成授权

第 3 步有两种等价方式：

- **界面（推荐）**：在设置页同步卡片里点「授权」→ 百度页面复制授权码 → 回到卡片，粘贴到「授权码」输入框 → 点「完成授权」。卡片会自动刷新成「已授权」。
- **手敲 URL**：打开 `/api/sync/baidu/exchange?code=授权码` → 显示「授权成功 ✅」。

`exchange` 路由支持 `?format=json`，返回 `{ok, scope}` / `{ok:false, error}` 而不是 HTML 页 —— 界面走的就是这个分支。

**授权码 10 分钟内有效且只能用一次**，超时回到第 1 步重来。

若把 `BAIDU_REDIRECT_URI` 注册进百度应用，可改用自动回调 `/api/sync/baidu/callback`（该路由在 `dashboardGuard.js` 的白名单里，不需要登录态）。

---

## 5. 数据与凭证落点

| 内容 | 位置 | 参与同步？ |
|---|---|---|
| 数据库 | `<DATA_DIR>/db/data.sqlite` | ✅ 被同步（除排除表；用量三表合并语义见 §3.1） |
| 入站 API Keys（库内 `apiKeys` 表） | 在数据库内 | ❌ **刻意排除**（功能计划移除，见 §2） |
| 机器码 | `<DATA_DIR>/machine-id` | ❌ 不参与（同时是用量分片 ID 的来源） |
| 授权凭证 | `<DATA_DIR>/baidu-sync/token.json` | ❌ **刻意排除** |
| 同步状态 | `<DATA_DIR>/baidu-sync/state.json` | ❌ **刻意排除** |
| 应用前备份 | `<DATA_DIR>/db/backups/sync-apply-*` | ❌ 本地归档 |

Windows 上 `DATA_DIR` 默认 `%APPDATA%\9router`，Linux/macOS 默认 `~/.9router`。

### 5.1 为什么 token 不放数据库

`panClient.js` 顶部注释给了理由，展开是三条：

1. **数据库正是会被拉取覆盖的东西。** `applySnapshot()` 对每张共享表执行 `DELETE` + 从远端 `INSERT`。token 若入库，下一次从别的机器拉取就会用自己的凭证覆盖掉对方的。
2. **`refresh_token` 是一次性的。** 每次刷新都换新的、旧的立刻失效。两个实例共用一份 token 时，A 刷新会让 B 手里那份作废，B 下次刷新失败后永久置为 `needsReauth`，只能人工重新授权。所以刷新链必须是**每实例独立**的。
3. **`state.json` 同理。** 它存 `lastPushedBlobMd5` 等记账，用来识别「这个远端文件是我自己传的」。这份数据若被同步，B 机器会把 A 的推送误判成自己的，于是永远不拉取 → 静默单向同步。

原则：**同步的是共享数据，不同步的是身份凭证和本地记账**。这和 `requestDetails` 被排除在同步之外是同一个思路。

---

## 6. 已知问题与坑

### 6.1 【已修】没有 UI 入口，功能只能手敲 URL

**现象**：整个 `src/` 里除 API 路由和实现文件外，没有任何 UI 代码引用同步功能；侧边栏 12 个入口无一相关；`(dashboard)` 下没有设置页。

**影响**：用户无法在界面上完成授权（必须手敲 `/api/sync/baidu/authorize`），也无法知道功能是否存在。

**修复（2026-09-21）**：在 `/dashboard/profile`（侧边栏的 Settings）「本地模式 / 数据库」卡片下方新增 **Baidu Netdisk Sync** 卡片，含状态展示、**立即同步**按钮、授权/重新授权按钮。见 §7。

### 6.2 失败被静默吞掉（**仍存在**）

**现象**：调度器对各类失败一律 `console.warn` 后吞掉，服务不崩、界面无提示。`state.json` 里确实记录了 `lastError`，但此前没有任何页面去读它。

**后果**：未授权、凭证过期、口令错误等情况可以持续数周而无人察觉 —— 表现就是「一直在跑，但从没同步成功过」。

**现状**：新增的卡片会显示 `lastError`，缓解了「看不见」的问题；但**定时任务里的失败依然只是 warn**，且只有打开设置页才会看到。

**排查途径**：`/dashboard/console-log` 能看到 `[BAIDU_SYNC]` 的日志（`consoleLogBuffer.js` 全局劫持了 `console.warn`）。限制：只保留最近 200 行，且捕获是懒初始化的 —— 必须是打开过该页面之后产生的日志才在缓冲区里。

### 6.3 token 是明文，且 `0600` 在 Windows 上是空操作

**现象**：`token.json` 里 `access_token` / `refresh_token` 是**明文**，未用 `BAIDU_SYNC_KEY` 加密（加密只作用于上传的快照）。代码意图是写成 `0o600`，但 Node 在 Windows 上只支持切换只读位，NTFS 不认 POSIX 权限位。

**实测**：

```
写入 mode: 666
chmod 后 mode: 666
平台: win32
```

**影响**：在 Windows 上，该文件仅受 `%APPDATA%\9router\baidu-sync\` 目录 ACL 保护 —— 任何能读到该目录的账户都能拿到 token。单用户机器上等同于其他应用把 token 放 APPDATA 的常规做法；**共享机器/多人环境下需要额外注意**。Linux/macOS 上 `0600` 正常生效。

### 6.4 `DATA_DIR` 配了 Unix 路径时 Windows 静默回落

**现象**：`.env` 里 `DATA_DIR=/var/lib/9router`，在 Windows 上 `dataDir.js` 会识别出这是 Unix 路径并**回落到 `%APPDATA%\9router`**，只打一条 `[DATA_DIR] ... fallback to default` 警告。

**坑**：同一份 `.env` 在 Linux（含 Docker）下 `DATA_DIR` 会真的生效，指向**另一张库**。跨机器同步测试时，两边看到的并不是同一份数据，现象酷似「同步把数据弄丢了」。

### 6.5 每台机器必须单独授权；不要拷贝 `token.json`

因为 token 不参与同步（§5.1），新机器**必须重新走一遍授权流程**。

把 `token.json` 手工拷到另一台机器**看起来是捷径，实际会坏**：两个实例共用同一个 `refresh_token`，刷新时互相作废，后刷的那台会卡在 `needsReauth` 直到人工重新授权。

### 6.6 新实例会采纳云端快照并覆盖本地（数据风险）

`shouldPull()` 在实例**没有任何同步记录**时直接返回 `true`（注释写的「fresh instance adopts whatever the cloud has」）。

**含义**：在一台有重要数据的新机器上首次启动，它会拉取云端快照并**逐表覆盖本地库**。虽然覆盖前会自动备份到 `db/backups/sync-apply-*`（保留 3 份），但这仍是容易踩的坑。**测试第二台机器前先确认本地数据可以丢弃。**

### 6.7 Windows 上残留 dev server 导致端口占用

排查时遇到的相邻问题，记录备查：关掉终端窗口（点 X）不会给 Next 的 dev server 发终止信号，它会作为孤儿进程继续占着端口，导致下次 `npm run dev` 报 `EADDRINUSE`。

```bash
# 查占用者
netstat -ano | grep 20127
# 按端口杀（PowerShell）
Get-NetTCPConnection -LocalPort 20127 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

注意用 `taskkill /PID <父PID> /T /F` 时 `/T` 是关键，否则子进程仍占着端口。

### 6.8 【已修】`schedulerStarted` 跨模块实例不可见，界面显示「已停止」

**现象**：调度器明明已经启动（日志有 `[BAIDU_SYNC] scheduler started`，tick 在跑、`state.lastSyncAt` 持续更新），但 `GET /api/sync/baidu/status` 返回 `"schedulerStarted": false`。

**原因**：`index.js` 用模块级 `let started` 记录运行状态，而 Next 会在同一个进程里对同一模块求值多次 —— `instrumentation.js`（启动调度器的那份）与路由处理器（读状态的那份）**不共享模块实例**，所以路由手里的 `started` 永远是 `false`。

**影响**：设置页的同步卡片会显示「已停止」，与事实正好相反 —— 这恰恰是本功能最需要避免的「状态不可信」。此外生产模式下 `custom-server.js` 和 `instrumentation.js` 可能各自起一个定时器，让同一轮同步被跑两次，对 `state.json` 构成读-改-写竞争。

**修复（2026-09-21）**：把运行标志镜像到进程全局（`globalThis.__9routerBaiduSyncStarted`），并在 `startBaiduSync()` 里一并检查该标志以防重复启动。这是仓库里已有的做法（见 `lib/consoleLogBuffer.js` 的 `global._consoleLogBufferState`）。

**验证**：`GET /api/sync/baidu/status` 返回 `"schedulerStarted": true`，设置页显示「运行中」。

### 6.9 【已修】单步上传接口已被百度废弃 —— 这是「同步从来没成功过」的根因

**现象**：授权成功、远端目录也存在，但每一轮都是 `api: upload failed (errno=31832)`，网盘里始终没有 `data.sqlite.enc`。这个错误码在公开文档里查不到。

**证据**：直接复现上传调用并打印百度的**完整响应体**（应用只透出 errno，看不到 `error_msg`）：

| 请求 | HTTP | 百度响应 |
|---|---|---|
| `pcs/file?method=upload` | 403 | `{"error_code":31064,"error_msg":"file is not authorized"}` |
| `xpan/file?method=upload` | 400 | `{"error_code":31832,"error_msg":"unsupported api"}` |

即 **31832 的真实含义是 `unsupported api`** —— 与文件内容、路径、权限、配额都无关。

**根因**：`uploadSingleStep()` 依次尝试上面两个 endpoint，而**两者都已不可用**；而 `engine.js` 只在 `blob.length > SINGLE_STEP_MAX`（2GB）时才改走分片上传。于是 6.3MB 的数据库**永远**走这条死路 —— 功能等于完全不可用。

**修复（2026-09-21）**：删除 `uploadSingleStep()` 和 `SINGLE_STEP_MAX`，上传统一走三步分片流程。已实测该流程对 2KB 和 331KB 的文件都正常（4 次调用：precreate + locateupload + superfile2 + create）。

**验证**：`POST /api/sync/baidu/trigger` 返回 `{"status":"ok","pushed":true,"pushedBytes":338933,"calls":6}`，网盘上 `/apps/9router/9router-sync/data.sqlite.enc` 的大小与之完全一致。

**顺带发现（未修，属噪音）**：百度返回的 `md5` 字段是**打乱过的 32 位串，含非十六进制字符**（如 `71ce36cbejc6644dc9575ee647b8615e`），`normalizeMd5()` 会正确判为无效，于是 `state.lastPushedBlobMd5` 落成 `null`。后果是「识别自己上传的文件」这一步实际靠 mtime 判断而非 md5 比对。行为仍然正确（不会误拉自己刚推的快照），但每轮会多打一条 `Remote snapshot not pulled (older or undecryptable) — a push will overwrite it` 的警告。

---

## 7. 界面入口（2026-09-21 新增）

路径：**侧边栏 → Settings（`/dashboard/profile`）→ Baidu Netdisk Sync 卡片**

展示内容：

| 字段 | 来源 |
|---|---|
| 调度器状态 / 同步间隔 | `schedulerStarted` / `intervalMinutes` |
| 授权状态（已授权 / 未授权 / 需要重新授权） | `token.hasToken` / `token.needsReauth` |
| 上次同步时间 | `state.lastSyncAt` |
| 凭证刷新时间 | `token.expiresAt`（是**刷新触发时间**，不是硬过期时间，提前 24h） |
| 远端文件路径 | `remotePath` |
| 排除的表 | `excludeTables` |
| 最后错误 | `state.lastError` |
| 配额退避等级（>0 时显示） | `state.throttleLevel` |

操作按钮：

- **立即同步** → `POST /api/sync/baidu/trigger`，同步执行一轮并回填结果（拉取/推送/调用次数）。配置缺失时禁用。
- **授权 / 重新授权** → 新标签页打开 `/api/sync/baidu/authorize`。
- **刷新** → 重新拉取状态。

> 未授权时卡片会显示 oob 三步提示（授权码 10 分钟一次性）。
> 文案走 `public/i18n/literals/zh-CN.json`（英文源串 → 中文）。该 i18n 运行时**只对完整文本节点做整串替换**，所以拼接出来的句子不会被翻译 —— 文案必须写成独立的完整句子，数值单独放在自己的元素里。

---

## 8. 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sync/baidu/status` | 状态总览（配置、调度器、token、state） |
| POST | `/api/sync/baidu/trigger` | 手动同步一轮 |
| GET | `/api/sync/baidu/authorize` | 跳转百度授权页 |
| GET | `/api/sync/baidu/exchange?code=…` | oob 流程换 token |
| GET | `/api/sync/baidu/callback` | 注册了 `BAIDU_REDIRECT_URI` 时的自动回调（白名单，免登录） |

除 `callback` 外都受 `dashboardGuard` 保护：浏览器访问自带 session 没问题，**curl/Postman 裸调需要带 `x-9r-cli-token` 请求头**，否则 401。

---

## 9. 排查顺序

1. `GET /api/sync/baidu/status` — 看 `configured`、`schedulerStarted`、`token.hasToken`、`state.lastError`
2. `token.hasToken === false` → 走 §4 授权
3. `token.needsReauth === true` → `refresh_token` 已失效（常见于别处刷新过或拷贝过凭证），重新授权
4. 同步跑过但没效果 → 确认远端文件位置是不是在「我的应用数据」下（§1）
5. `lastError` 出现 `upload failed (errno=31832)` 或 `errno=31064` → 单步上传接口被废弃了；本仓库已修（§6.9），若又出现说明上游改动回退了修复
6. `lastError` 出现 `pull-decrypt-failed` → 两端 `BAIDU_SYNC_KEY` 不一致，**此时本地数据被保护、未被覆盖**，修好口令即可
7. 还看不清 → `/dashboard/console-log` 看 `[BAIDU_SYNC]` 日志，或直接读 `<DATA_DIR>/baidu-sync/state.json`

### 排查技巧：拿到百度的完整错误响应

应用只透出 `errno`，看不到百度的 `error_msg`，而错误码在公开文档里经常查不到。要定位就得把完整响应体打出来：照着 `panClient.js` 里对应的 `xpanCall` 参数复现一次请求，打印整个 JSON。§6.9 就是这么定出 31832 = `unsupported api` 的。

> 注意：上传接口有每日调用配额（约 100 次/天），排查时别反复上传大文件；用几百字节的探测文件、**换一个文件名**（别覆盖 `data.sqlite.enc`），用完删掉。

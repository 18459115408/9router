# 9Router 功能裁剪方案（减法）

> 目标：移除 4 个不需要的功能。本文件是给执行代理的施工单。
> 代码库：`9router-app`（Next.js 16 + SQLite + open-sse 引擎）
> 编写时间：2026-09-20

---

## 0. 执行前必读

### 0.1 通用规则

1. **行号会漂移**。下面给的行号是编写时的快照。**以 grep 锚点为准**，行号只用于快速定位。每个改动点都给了可 grep 的锚点文本。
2. **不要动 `open-sse/` 里的 translator/executor/registry**，除非本文件明确要求。那是请求引擎的核心。
3. **保留 DB 表**。`combos` 和 `proxyPools` 两张表**不要从 `src/lib/db/schema.js` 删除**——`tests/unit/db-migration-chain.test.js` 断言它们存在。功能层停用即可，空表零成本。
4. **每批做完必须验证**（见 §6），不要 4 个功能一起改完再验证。
5. 提交风格：Conventional Commits，例如 `chore(cleanup): remove 9Remote promo modal`。

### 0.2 施工前准备

```bash
git status --short          # 确认工作区干净
git checkout -b chore/feature-removal
```

### 0.3 四个功能的风险分级

| # | 功能 | 风险 | 建议批次 | 涉及文件数 |
|---|---|---|---|---|
| 1 | 9Remote 弹窗 | 无 | 第 1 批 | 3 + 6 个 i18n |
| 2 | 9English 链接 | 无 | 第 1 批 | 1 |
| 3 | 代理池 | 中 | 第 2 批 | 28 |
| 4a | 视觉适配器 | 中 | 第 3 批 | 4 + 1 测试 |
| 4b | 组合（Combo） | 高 | 第 4 批 | 45 |

---

## 1. 9Remote 弹窗

### 1.1 它是什么

侧边栏底部一个按钮，点开弹窗推广外部产品 `https://9remote.cc`（远程终端/桌面/文件）。纯引流，不读 API、不碰 DB、不影响路由。

### 1.2 删除清单

**整文件删除：**

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/shared/components/NineRemotePromoModal.js` | 99 | 弹窗本体 |
| `src/shared/components/NineRemoteButton.js` | 23 | **已经是死代码**——只在 `components/index.js` 导出，全项目无人引用 |

**`src/shared/components/index.js`**
- 删除导出行：`export { default as NineRemoteButton } from "./NineRemoteButton";`（约 L23）

**`src/shared/components/Sidebar.js`** —— 4 处

| 锚点 | 动作 |
|---|---|
| `import NineRemotePromoModal from "./NineRemotePromoModal";`（约 L13） | 删整行 |
| `const [showRemoteModal, setShowRemoteModal] = useState(false);`（约 L45） | 删整行 |
| `{/* Remote */}` 开头的整个 `<button>` 块（约 L294-309） | 删整块（含注释掉的 "New" 徽章） |
| `<NineRemotePromoModal isOpen={showRemoteModal} onClose={...} />`（约 L355） | 删整行 |

**i18n**：删除 `"Get 9Remote"` 键

```
public/i18n/literals/zh-CN.json   L511
public/i18n/literals/fa.json
public/i18n/literals/id.json
public/i18n/literals/km.json
public/i18n/literals/pt-BR.json   （有 2 处）
public/i18n/literals/th.json
```

> 注意：i18n 是运行时遍历 DOM 文本节点查表（`src/i18n/runtime.js` 的 `processTextNode`），残留的孤儿键不会报错，只是冗余。清理是为了整洁。

### 1.3 影响

**无。** 该组件不参与任何业务逻辑。

---

## 2. 9English 链接

### 2.1 它是什么

`Sidebar.js` 里一个裸的 `<a href="https://9english.net/">` 外链，连组件都不是。

### 2.2 删除清单

**`src/shared/components/Sidebar.js`** —— 1 处

删除 `{/* 9English */}` 开头的整个 `<a>` 块（约 L311-326，共 16 行）：

```jsx
{/* 9English */}
<a
  href="https://9english.net/"
  target="_blank"
  rel="noreferrer"
  onClick={onClose}
  className={cn(
    "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group w-full",
    "text-text-muted hover:bg-surface-2 hover:text-text-main"
  )}
>
  <span className="material-symbols-outlined text-[18px] group-hover:text-primary transition-colors">
    translate
  </span>
  <span className="text-[13px] font-medium">9English</span>
</a>
```

### 2.3 影响

**无。** 无 i18n 键、无依赖、无路由。

> 第 1、2 批可以合并成一次提交。改完后 `Sidebar.js` 的 System 区顺序为：Media Providers → Skills → Console Log → Translator → Settings。

---

## 3. 代理池（Proxy Pools）

### 3.1 它是什么

一条从 DB 贯穿到每次上游请求的链路：管理多个代理（HTTP / Vercel Relay / Cloudflare Relay / Deno Relay），支持轮询/随机分配，可按 provider 或单个连接绑定。

### 3.2 ⚠️ 关键区分：不要误删全局出网代理

**代理池 ≠ 全局出网代理。这是两套独立系统：**

| | 代理池（要删） | 全局出网代理（**保留**） |
|---|---|---|
| 设置项 | `settings.providerStrategies[].proxyPoolId` | `settings.outboundProxyEnabled` / `outboundProxyUrl` / `outboundNoProxy` |
| 实现 | `src/lib/network/connectionProxy.js` + DB `proxyPools` 表 | `src/lib/network/outboundProxy.js` → 写 `HTTP_PROXY` 环境变量 |
| 生效方式 | 按连接注入 `providerSpecificData` | 进程级环境变量 |
| 消费者 | `resolveConnectionProxyConfig()` | `open-sse/utils/proxyFetch.js` 读 `process.env` |
| 页面 | Settings → Proxy Pools | Settings → Network |

**保留清单（不要动）：**
- `src/lib/network/outboundProxy.js`
- `src/lib/network/initOutboundProxy.js`
- `open-sse/utils/proxyFetch.js`（读 `HTTP_PROXY`，与池无关）
- `src/lib/network/proxyTest.js` + `src/app/api/settings/proxy-test/`（全局代理的连通性测试）
- `src/lib/db/schema.js` 里的 `proxyPools` 表定义
- `package.json` 的 `socks-proxy-agent`（`outboundProxy.js` 的 scheme 白名单含 socks；虽然当前代码里没有直接 import，但删除需确认无运行时依赖——保守起见先留着）

### 3.3 删除清单 —— 整文件/整目录

```
src/app/(dashboard)/dashboard/proxy-pools/page.js          1063 行（页面）
src/app/api/proxy-pools/route.js                            93 行
src/app/api/proxy-pools/[id]/route.js                      123 行
src/app/api/proxy-pools/[id]/test/route.js                  70 行
src/app/api/proxy-pools/vercel-deploy/route.js             142 行
src/app/api/proxy-pools/cloudflare-deploy/route.js         145 行
src/app/api/proxy-pools/deno-deploy/route.js               174 行
src/lib/db/repos/proxyPoolsRepo.js                         103 行
src/shared/components/NoAuthProxyCard.js                   134 行
```

### 3.4 删除清单 —— 运行时改造（重点）

#### `src/lib/network/connectionProxy.js`（187 行）—— 这是枢纽

导出两个函数，被 **8 个文件**依赖：

- `resolveConnectionProxyConfig(providerSpecificData)` —— 返回结构被下游消费，**必须保持返回 shape 不变**：
  ```js
  { source, proxyPoolId, proxyPool, connectionProxyEnabled, connectionProxyUrl,
    connectionNoProxy, strictProxy, vercelRelayUrl }
  ```
  改造方式：**删除 Proxy Pool 分支**（`if (proxyPoolId) { ... }` 那一整段，约 L70-127），保留 legacy proxy 分支和 no-proxy 分支。`proxyPoolId` 字段恒返回 `null`，`proxyPool` 恒返回 `null`，`vercelRelayUrl` 恒返回 `""`。
  同时删除文件顶部的 `import { getProxyPoolById } from "@/models";`。

- `pickProxyPoolId(poolIds, strategy, providerId)` —— **整个函数删除**，含 `rotateState` Map 和 `normalizeLegacyProxy` 之外的相关状态。唯一调用点是 `src/sse/services/auth.js`。

**调用点全清单（改造后需保持编译通过）：**

| 文件 | 用途 |
|---|---|
| `src/sse/services/auth.js:234` | 取凭据时解析连接代理 |
| `src/app/api/providers/route.js` | 创建连接时规范化 |
| `src/app/api/providers/[id]/route.js` | 更新连接时规范化 |
| `src/app/api/providers/[id]/models/route.js:465` | 拉模型列表 |
| `src/app/api/providers/[id]/test/testUtils.js:841` | 连接测试 |
| `src/app/api/usage/[connectionId]/route.js:149` | 用量查询 |
| `src/app/api/usage/[connectionId]/codex-reset-credits/route.js:66` | Codex 重置 |
| `src/app/api/v1/models/route.js:90` | /v1/models 列表 |
| `src/shared/services/quotaAutoPing.js:198` | 配额自动 ping |
| `src/sse/services/antigravityQuota.js:107` | Antigravity 配额 |

#### `src/sse/services/auth.js`

- L1：`import { ... getProxyPools } from "@/lib/localDb";` → 去掉 `getProxyPools`
- L2：`import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";` → 去掉 `pickProxyPoolId`
- L72-95：免鉴权（noAuth）provider 的虚拟连接注入块。删除代理轮询分支：

  ```js
  // 删除这一段
  const override = (settings.providerStrategies || {})[providerId] || {};
  const strategy = override.rotateStrategy || "none";
  let pickedId = override.proxyPoolId || null;
  if (strategy !== "none") {
    const allPools = await getProxyPools({ isActive: true });
    const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
    pickedId = pickProxyPoolId(poolIds, strategy, providerId);
  }
  const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
  ```
  替换为直接返回无代理配置。注意**保留** `providerSpecificData` 里其余字段（`vercelRelayUrl: ""` 等），下游 `chatCore.js` 会读。

  > 该文件有一处**已有的未提交改动**（fill-first 粘性故障转移，见 `git log daf85a06`）。改造时不要回滚它。

#### 导出链（3 处，删 pool 相关行）

| 文件 | 行 | 删除内容 |
|---|---|---|
| `src/lib/db/index.js` | L26-28 | `getProxyPools, getProxyPoolById, createProxyPool, updateProxyPool, deleteProxyPool` 的 re-export 块 |
| `src/lib/localDb.js` | L11-12 | 同上 |
| `src/models/index.js` | L13-17 | 同上 |

#### `src/lib/db/migrate.js`（legacy JSON → SQLite 迁移）

- L135-139：删除 `importWithAssertion(adapter, "proxyPools", ...)` 块
- 注意 `_migratedAdapters` / marker 逻辑**不要动**

#### `src/lib/db/index.js` 的 `exportDb()` / `importDb()`

- `exportDb()` L79：删除 `proxyPools: db.all(...)` 行
- `importDb()` L107：删除 `db.run('DELETE FROM proxyPools')`
- `importDb()` L131-136：删除 `for (const p of payload.proxyPools || [])` 循环

> 表本身保留（§0.1 规则 3），只是不再纳入导出/导入。

#### `src/dashboardGuard.js`

- L59：从 `PROTECTED_API_PATHS` 删除 `"/api/proxy-pools",`

### 3.5 删除清单 —— UI 散落点

#### `src/shared/components/Sidebar.js`
- L38：`systemItems` 删除 `{ href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },`

#### `src/shared/components/Header.js`
- L130-134：删除 `if (pathname.includes("/proxy-pools"))` 整个 page-info 分支

#### `src/shared/components/EditConnectionModal.js` —— 顺手清理死 prop
`proxyPools` 只在函数签名（L12）和 propTypes（L309）出现，**从未被渲染**。删除 prop + propTypes 条目，并清理 7 个调用点的传参：
```
src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js   L457, L480, L487
src/app/(dashboard)/dashboard/providers/[id]/page.js                    L1035, L1886, L1899
src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js  L1544
```

#### `src/app/(dashboard)/dashboard/providers/[id]/page.js`（改动最多）
- 状态：L47 `proxyPools`、L57 `showBulkProxyModal`、L67 `bulkProxyPoolId`（及相关 `bulkUpdatingProxy`）
- 数据获取：L308-323 的 `proxyPoolsRes` / `setProxyPools`
- 批量分配逻辑块：L935-1070（`selectedProxySummary`、`openBulkProxyModal`、`closeBulkProxyModal`、`applyProxyAssignments`、`handleApplySinglePool`、`handleApplyOneToOne`）
- `ConnectionRow` 的 `onUpdateProxy` prop（约 L1047-1060）
- 批量代理 Modal 渲染：L1078-1110
- "Apply Proxy" 按钮：L1517-1525（`{connections.length > 0 && proxyPools.length > 0 && (<Button ...>Apply Proxy</Button>)}`）
- `EditConnectionModal` 的 `proxyPools` 传参：L1886、L1899

#### `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`
- L15-41：`boundProxyPoolId`、`hasLegacyProxy`、`boundProxyPool`、`proxyDisplayText`、`maskedProxyUrl`、`noProxyText`、代理 Badge 等全部代理展示逻辑

#### `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js`
- L34-61：`ConnectionRow` 内的代理状态与展示
- L80-100：`showProxyDropdown`、`handleSelectProxy`
- L200 / L240：`formData.proxyPoolId`
- L275：`<Select label="Proxy Pool" ...>`
- L384-387：`handleUpdateProxy`
- L457 / L480 / L487：`proxyPools` 传参

#### `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js`
- L11：签名去掉 `proxyPools`
- L31：`proxyPoolId: NONE_PROXY_POOL_VALUE`
- L127：`proxyPoolId: ... === NONE_PROXY_POOL_VALUE ? null : ...`
- L375-392：`<Select label="Proxy Pool">` 及 "No active proxy pools available..." 提示、legacy 说明文字
- L418：propTypes 条目

#### `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`
- L151：`proxyPools` state
- L455-465：`fetch("/api/proxy-pools?isActive=true")` 的 useEffect
- L1544：`proxyPools` 传参

#### `src/app/api/providers/route.js` + `src/app/api/providers/[id]/route.js`
- 删除 `getProxyPoolById` import
- 删除 `normalizeProxyPoolId()` / `normalizeProxyPoolUpdate()` 函数
- 移除调用点。**建议**：直接忽略请求体里的 `proxyPoolId` 字段（静默丢弃），而不是报错，避免旧客户端 400。

### 3.6 已知残留（可接受，不必处理）

1. **DB 里已有行的 `providerSpecificData.proxyPoolId`** 变成惰性字段——`resolveConnectionProxyConfig` 不再读它。不会报错。如需清理，写一次性迁移把该键删掉。
2. **`providerSpecificData.connectionProxyUrl` 等 legacy 字段**在 dashboard 里**本来就没有输入口**（grep 确认无 UI 写入），只有 API 接受。可以顺手从 `normalizeProxyConfig` 里也删掉。
3. **`vercelRelayUrl` 变成恒空字符串** → `open-sse/utils/proxyFetch.js:297-306` 的 relay 分支和 `src/app/api/providers/[id]/test/testUtils.js:456-460` 成为死代码。无害，可选清理。
4. **`open-sse/executors/cursor.js:687`** 的 `!!proxyOptions?.vercelRelayUrl` 判断恒为 false。无害。

### 3.7 影响总结

| 失去的能力 | 保留的能力 |
|---|---|
| ❌ 多代理轮询/随机分配 | ✅ 全局出网代理（Settings → Network） |
| ❌ Vercel / Cloudflare / Deno Relay 一键部署 | ✅ `HTTP_PROXY` 环境变量代理 |
| ❌ 按 provider/连接绑定不同代理 | ✅ SOCKS 代理（scheme 白名单保留） |
| ❌ 免鉴权 provider 的代理轮询 | ✅ 直连 |
| ❌ 代理健康检查（`/[id]/test`） | ✅ 全局代理连通性测试（`/api/settings/proxy-test`） |

---

## 4a. 视觉适配器（Vision Adapter）

> 建议与 4b 分开做：本项小、独立、低风险。

### 4a.1 它是什么

`settings.capacityAdapter` 定义按输入模态（vision / pdf / audioInput / videoInput）分组的"兜底模型池"。当请求带了图片而目标模型不支持视觉时，自动把池里的模型插到候选列表最前面。**对单模型请求也生效**，不只是组合。

### 4a.2 删除清单

**整文件删除：**
```
open-sse/services/capacityAdapter.js    173 行
```

**`src/sse/handlers/chat.js`**
- L19：`import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";` → 删整行
- L93：`const requiredCapabilities = detectRequiredCapabilities(body);` → 删（如果 4b 不做则保留 `detectRequiredCapabilities` 的 import，因为 combo auto-switch 还用）
- L102-103：`const augmentedModels = ...` / `const adapterAdded = ...` → 删，改为直接用 `comboModels`
- L126-137：`handleComboChat` 调用里的 `withCapacityAdapterStripping(...)` 包裹 → 还原为直接传 `(b, m) => handleSingleModelChat(...)`
- L143-157：**整个"单模型 + 视觉适配器"块** → 删，直接走 `return handleSingleModelChat(...)`
- L179-180、L188-198：第二处 combo 分支里的同样改造

**`src/app/(dashboard)/dashboard/combos/page.js`**（该页如果 4b 已删则整页消失，本节跳过）
- L19-23：`CAPACITY_ADAPTER_CAPS`
- L24：`DEFAULT_FALLBACK_MODEL`
- L25：`EMPTY_CAP_ENTRY`
- L26-31：`EMPTY_CAPACITY_ADAPTER`
- L33-45：`normalizeCapEntry()`
- L54：`const [capacityAdapter, setCapacityAdapter] = useState(...)`
- L80-85：从 settings 读取 + 归一化
- L93-99：`handleSetCapacityAdapter`
- L249-256：`<CapacityAdapterSection ... />` 渲染
- L412-441：`CapacityAdapterSection` 组件
- L443-...：`CapacityAdapterCap` 组件

**`src/lib/db/repos/settingsRepo.js`**
- L26-31：删除 `DEFAULT_SETTINGS.capacityAdapter` 块

### 4a.3 测试影响

`tests/unit/hermes-vision-detection.test.js` 导入 `augmentModelsWithCapacityAdapter`：
```js
import { detectRequiredCapabilities } from "../../open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter } from "../../open-sse/services/capacityAdapter.js";
```
（第一行来自 `combo.js`，所以**如果 4b 也做，这个测试文件必然要删**。）
→ 该测试会 import 失败。**该文件不在 `tests/__baseline__/baseline-results.json` 的 62 个基线文件里**，所以不受 `verify-no-regression.mjs` 门禁保护。处理方式二选一：
- (a) 删除该测试文件
- (b) 保留文件，删掉 `augmentModelsWithCapacityAdapter` 相关的 `it` 块，只留 `detectRequiredCapabilities` 的断言（前提：4b 不做，`detectRequiredCapabilities` 仍在）

### 4a.4 影响总结

| 失去 | 保留 |
|---|---|
| ❌ 单模型请求的图片自动路由到视觉模型 | ✅ 组合内部的 `reorderByCapabilities` auto-switch（在 `combo.js`，属 4b） |
| ❌ 适配模型的上下文裁剪（`stripHistoryForContext`） | ✅ `chatCore.js` 的 `stripUnsupportedModalities`（不支持就剥离媒体，不报错） |
| ❌ Vision / Audio 兜底池配置 UI | ✅ 模型能力标签 `CapacityBadges`（被 `ModelRow`、`ModelSelectModal` 使用，**保留**） |

> ⚠️ 删掉后，给不支持视觉的模型发图片，行为是**静默剥离图片**（`stripUnsupportedModalities`，`open-sse/translator/concerns/modality.js:135`），而不是报错或切换模型。确认这是你想要的语义。

---

## 4b. 组合（Combo）

> 风险最高的一批。**建议在 1、2、3、4a 全部验证通过后再开始。**

### 4b.1 它是什么

"Combo" 不只是管理页面，而是**模型名解析 + 多模型 fallback 的运行时机制**：

- 客户端传 `model: "my-combo"` → `getModelInfo()` 先查 combo 表 → 命中则返回 `{ provider: null }` → `handleChat` 展开成模型序列 → `handleComboChat` 按策略（fallback / round-robin / fusion）逐个尝试
- 媒体侧（Web Search / Web Fetch）的**多 provider 容错也是靠 combo 实现**
- `/v1/models` 把 combo 名当模型暴露给客户端

### 4b.2 ⚠️ 必须理解：账号级 fallback 是独立的，不受影响

```
handleSingleModelChat (src/sse/handlers/chat.js:229)
  └── while (true) {
        credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
        ...
        excludeConnectionIds.add(credentials.connectionId);   // L331
      }
```
**多账号故障转移（同一 provider 多账号轮换）走的是这条独立路径**，删掉 combo 后照常工作。失去的只是**跨模型/跨 provider** 的 fallback。

### 4b.3 删除清单 —— 整文件/整目录

```
open-sse/services/combo.js                                    625 行（核心逻辑）
open-sse/services/compact.js                                   71 行（已经是死代码，全项目无人 import）
src/app/api/combos/route.js                                    48 行
src/app/api/combos/[id]/route.js                               81 行
src/app/(dashboard)/dashboard/combos/page.js                  855 行
src/app/(dashboard)/dashboard/media-providers/combo/[id]/page.js  412 行
src/shared/components/ComboFormModal.js                       178 行
cli/src/cli/menus/combos.js                                   477 行
```

> `open-sse/services/compact.js` 无论本批做不做都建议删除——它导出的 `getComboModelsFromData` / `handleComboChat` 与 `combo.js` 重名，是历史遗留副本，没有任何 importer。

### 4b.4 删除清单 —— 请求处理器（5 个）

**`src/sse/handlers/chat.js`**
- L18：`import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";` → 删
- L93：`detectRequiredCapabilities` 调用 → 删
- L95-137：**主 combo 分支**（`const comboModels = await getComboModels(modelStr); if (comboModels) { ... }`），含 fusion 分支
- L169-211：**`handleSingleModelChat` 内的兜底 combo 分支**（`if (!modelInfo.provider) { const comboModels = ... }`）
  → 保留 L217-218 的 `log.warn("CHAT", "Invalid model format", ...)` + `errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format")` 作为兜底
- L96 的 `getComboModels` import（来自 `../services/model.js`）→ 删

**`src/sse/handlers/fetch.js`**
- L8：`import { getSettings, getCombos } from "@/lib/localDb";` → 去掉 `getCombos`
- L15：`import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";` → 删
- L91-104：combo 展开块 → 删，直接 `return handleSingleProviderFetch(body, providerInput, request, apiKey, settings);`（L106）

**`src/sse/handlers/search.js`**
- L8、L15：同上
- L71-84：combo 展开块 → 删，直接 `return handleSingleProviderSearch(...)`

**`src/sse/handlers/imageGeneration.js`**
- L9：`import { getModelInfo, getComboModels } from "../services/model.js";` → 去掉 `getComboModels`
- L14：`import { handleComboChat } from "open-sse/services/combo.js";` → 删
- L49-64：combo 展开块 → 删，直接 `return handleSingleModelImage(...)`（L66）

**`src/sse/handlers/tts.js`**
- L6、L11、L47-62：同上

**`src/sse/handlers/videoGeneration.js`**
- L84 已有 `"Combos are not supported for video generation"` 报错，无需改动。

### 4b.5 删除清单 —— 模型解析

**`src/sse/services/model.js`**
- L2：`import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";` → 去掉 `getComboByName`
- L69-79：`getModelInfo()` 内的 combo 检查块
  ```js
  // 删除
  const combo = await getComboByName(parsed.model);
  if (combo) {
    return { provider: null, model: parsed.model };
  }
  ```
  → 直接 `return getModelInfoCore(modelStr, getModelAliases);`
- L82-95：整个 `export async function getComboModels(modelStr)` → 删

### 4b.6 删除清单 —— API 与列表

**`src/app/api/v1/models/route.js`**
- L8：`import { getProviderConnections, getCombos, ... }` → 去掉 `getCombos`
- L146：`const LLM_KIND = "llm";` —— **保留**（`modelKind()` 等仍在用）
- L243-247：`comboMatchesKinds()` → 删
- L267-271：`let combos = []; try { combos = await getCombos(); } catch {...}` → 删
- L305-316：`for (const combo of combos) { ... }` 的 combo 列表注入 → 删

**`src/app/api/settings/route.js`**
- L4：`import { resetComboRotation } from "open-sse/services/combo.js";` → 删
- L89-97：`resetComboRotation` 调用块 → 删

**`src/dashboardGuard.js`**
- L60：从 `PROTECTED_API_PATHS` 删除 `"/api/combos",`

**`src/lib/db/index.js` / `src/lib/localDb.js` / `src/models/index.js`**
- 删除 combo 相关 re-export：
  - `src/lib/db/index.js` L37-40
  - `src/lib/localDb.js` L19-23
  - `src/models/index.js` L19-24
- **注意**：`src/lib/db/repos/combosRepo.js` 文件**保留**（表要留），但不再从 barrel 导出。
- `src/lib/db/index.js` 的 `exportDb()` L81 / `importDb()` L109、L144-148 的 combo 行 → 同 §3.4 的方式移除（可选；若移除需同步 `db-migration-chain.test.js` 的断言——**建议只删导出/导入，保留表和 repo**）。

### 4b.7 删除清单 —— 前端 UI

**`src/shared/components/index.js`**
- L19：`export { default as ComboFormModal } from "./ComboFormModal";` → 删
- ⚠️ **`CapacityBadges`（L40）保留**——被 `ModelRow.js` 和 `ModelSelectModal.js` 使用。

**`src/shared/components/ModelSelectModal.js`**
- L96：`const [combos, setCombos] = useState([]);`
- L120-133：`fetchCombos()` 及其 useEffect
- L201 附近的注释
- L425-431：`filteredCombos` useMemo
- L522-...：`{/* Combos section - always first */}` 整个渲染块

**`src/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard.js`**
- L4：import 去掉 `ComboFormModal`
- L48：`const [comboModalOpen, setComboModalOpen] = useState(false);`
- L168-187：`handleCreateCombo`
- L352：`+ Combo` 按钮
- L523-531：`<ComboFormModal ... />` 渲染

**`src/app/(dashboard)/dashboard/media-providers/web/page.js`**
- L66-107：`ComboList` 组件
- L110-...：`Section` 的 `combos` / `onCreateCombo` props、`Create Combo` 按钮、`{combos.length > 0 && <ComboList .../>}`、`({providers.length} providers · {combos.length} combos)` 文案
- L149：`const [combos, setCombos] = useState([]);`
- L152-158：`fetch("/api/combos")` 调用
- L167-168：`searchCombos` / `fetchCombos` 过滤
- L172-187：`handleCreateCombo`
- L195-204：两个 `<Section>` 的 combos props

**`src/app/(dashboard)/dashboard/media-providers/[kind]/page.js`**
- L10-13：`COMBO_KINDS`（当前是空 Set）+ `COMBO_BASE_NAMES` + 注释
- L99-133：`ComboList` 组件
- L145：`combos` state；L157 `supportsCombo`；L171-177 fetch；L182 `kindCombos`
- L210-226：`handleCreateCombo`
- L232-246：`Create Combo` 按钮 + `ComboList` 渲染

**`src/app/(dashboard)/dashboard/profile/page.js`**
- L280-291：`updateComboStrategy`
- L313-327：`updateComboStickyLimit`
- L1482-1496：`{/* Combo Round Robin */}` 区块
- L1497-1517：`{/* Combo Sticky Round Robin Limit */}` 区块
- L1522-1524：底部说明文字里的 combo 分句

**`src/lib/db/repos/settingsRepo.js`**
- L23：`comboStrategy: "fallback",`
- L24：`comboStickyRoundRobinLimit: 1,`
- L25：`comboStrategies: {},`

**`src/shared/components/Header.js`**
- L80-86：`if (pathname.includes("/combos"))` 的 page-info 分支（title "Combos" / description "Model combos with fallback"）→ 删整块

### 4b.8 删除清单 —— CLI

- `cli/src/cli/terminalUI.js` L5：`const { showCombosMenu } = require("./menus/combos");` → 删
- `cli/src/cli/terminalUI.js` L98：`await showCombosMenu([...basePath, "Combos"]);` → 删
- `cli/src/cli/api/client.js`：
  - 删除方法定义 L319-361（`getCombos` / `getComboById` / `createCombo` / `updateCombo` / `deleteCombo`）
  - 删除 L523-528 的 `module.exports` 里的 `// Combos` 导出块
- `cli/src/cli/utils/modelSelector.js` L31-69：`combos` 相关（`owned_by === "combo"` 分组、`excludeCombos` 参数）
- 删除 `cli/src/cli/menus/combos.js`

> ⚠️ CLI 是**独立发布的 npm 包**（`cli/package.json`，与根包独立版本）。改 CLI 需要单独 bump 版本。

### 4b.9 测试影响

以下测试 import 了 `open-sse/services/combo.js`，**删除后会 import 失败**：

| 文件 | 是否在 baseline 门禁内 | 处理建议 |
|---|---|---|
| `tests/unit/combo-routing.test.js` | ✅ **是**（pass=4） | 删除文件，并**从 `tests/__baseline__/baseline-results.json` 同步移除** |
| `tests/unit/combo-autoswitch.test.js` | ❌ 否 | 删除文件 |
| `tests/unit/combo-fusion.test.js` | ❌ 否 | 删除文件 |
| `tests/unit/fusion-strip-stream-options-3024.test.js` | ❌ 否 | 删除文件 |
| `tests/unit/commandcode-executor.test.js` | ❌ 否 | **改**：删掉 L7 import + L214 的 `handleComboChat` 用例，保留其余 |
| `tests/unit/hermes-vision-detection.test.js` | ❌ 否 | 见 §4a.3（若 4a 已处理则此处已解决） |

> **门禁机制提醒**：`tests/__baseline__/verify-no-regression.mjs` 只判定"基线里 pass 的现在 fail 了"。**删测试文件不会触发它**，但会让 `baseline-results.json` 与实际情况不一致。规范做法是同步更新 baseline。
> 另外 `db-migration-chain.test.js` 与 `db-sqlite-vs-lowdb.test.js` 断言 `combos` 表与 CRUD——**保留表和 repo 即可继续绿**。

### 4b.10 影响总结

| 失去 | 保留 |
|---|---|
| ❌ 跨模型 fallback（A 挂了换 B） | ✅ **账号级 fallback**（同 provider 多账号轮换） |
| ❌ Fusion（并行面板 + judge 合成） | ✅ 模型别名（alias）机制 |
| ❌ Combo 轮询 / 粘性限制 | ✅ 单模型直连 |
| ❌ Web Search / Web Fetch 多 provider 容错 | ✅ 单 provider search/fetch |
| ❌ 组合的 auto-switch（按能力重排） | ✅ `CapacityBadges` 能力标签展示 |
| ❌ CLI 的 Combos 菜单 | ✅ 其余 CLI 菜单 |
| ❌ `/v1/models` 暴露 combo 名 | ✅ `/v1/models` 其余列表 |

### 4b.11 ⚠️ 破坏性变更：客户端需手动改

**任何客户端里填了 combo 名的 `model` 字段会返回 `400 Invalid model format`。**

排查方法（执行前先跑，把结果交给用户确认）：
```bash
# 查 DB 里现存 combo 名
sqlite3 ~/.9router/data.sqlite "SELECT name, kind, models FROM combos;"
```
然后检查：
- CLI Tools 各卡片保存的模型映射（`/api/cli-tools/*-settings`）
- Cowork 的 selectedModels
- 用户自己的客户端配置（Claude Code / Codex / Cline 等）
- 媒体页保存的 `webSearch` / `webFetch` combo 名

**建议**：删除前先把这份清单给用户，让他确认没有正在用的 combo；或者先做一个"降级映射"——把 combo 名替换成它的第一个模型。

---

## 5. 顺带发现（与本任务无关，但建议处理）

| 项 | 说明 | 建议 |
|---|---|---|
| `open-sse/services/compact.js` | 71 行死代码，无任何 importer，且与 `combo.js` 函数重名 | 无论 4b 做不做都删 |
| `src/shared/components/NineRemoteButton.js` | 死代码，只有 index.js 导出 | 随 §1 删除 |
| `package.json` 的 `socks-proxy-agent` | 全仓库无 import | 确认后移除 |
| `providerSpecificData.connectionProxyUrl` | dashboard 已无输入口，只有 API 接受写入 | 随 §3 一并清理 |
| `EditConnectionModal` 的 `proxyPools` prop | 从未被渲染 | 随 §3 清理 |

---

## 6. 每批的验证协议

### 6.1 静态检查

```bash
npx eslint .
```

### 6.2 构建（必须）

```bash
npm run build
```
> Next.js 会在构建期发现 import 断裂、缺失导出、客户端/服务端边界问题。**这是最重要的门禁。**

### 6.3 残留引用扫描（每批做完跑对应的）

```bash
# 第 1 批
grep -rn "9Remote\|NineRemote" src/ public/i18n/ --include="*.js" --include="*.json"
grep -rn "9english\|9English" src/ public/i18n/ --include="*.js" --include="*.json"

# 第 2 批
grep -rn "proxy-pools\|proxyPool\|ProxyPool\|pickProxyPoolId\|NoAuthProxyCard" \
  src/ open-sse/ cli/ --include="*.js" | grep -v "outboundProxy\|proxyFetch\|proxyTest"

# 第 3 批
grep -rn "capacityAdapter\|augmentModelsWithCapacityAdapter\|withCapacityAdapterStripping\|getActiveAdapterStrategy" \
  src/ open-sse/ --include="*.js"

# 第 4 批
grep -rn "handleComboChat\|handleFusionChat\|getComboModels\|getComboModelsFromData\|getComboByName\|resetComboRotation\|ComboFormModal" \
  src/ open-sse/ cli/src/ --include="*.js"
```
预期：全部无输出（第 4 批的 `getComboByName` / `combosRepo` 若保留 repo 则允许出现在 `src/lib/db/repos/combosRepo.js` 内）。

### 6.4 测试

```bash
cd tests && npm install    # 首次
npx vitest run 2>&1 | tee /tmp/now.log
```
> ⚠️ **该测试套件在干净 checkout 上本来就不是全绿**：约 938 pass / 64 fail。判断回归**必须**用：
> ```bash
> node tests/__baseline__/verify-no-regression.mjs tests/__baseline__/current.json
> ```
> 不能看原始 pass/fail 数。

**每批必跑的关键用例（当前全绿，改动后必须仍绿）：**
```bash
npx vitest run unit/db-migration-chain.test.js
npx vitest run unit/db-sqlite-vs-lowdb.test.js
npx vitest run unit/capabilities.test.js
```

### 6.5 手工冒烟（第 2、3、4 批必做）

```bash
npm run dev     # 或 npm run build && npm run start
```
逐项确认：
1. Dashboard 能打开，侧边栏无残留菜单项
2. Providers 页 → 进入某个 provider → 连接列表正常渲染、能增删改
3. Settings → Network 的**全局出网代理开关仍在且可用**
4. 发一个真实的 `/v1/chat/completions` 请求（带 API key），确认路由正常
5. 多账号 provider 断开一个账号，确认**账号级 fallback 仍工作**（这是 4b 的核心保留项）
6. 第 3 批后：给不支持视觉的模型发一张图，确认是**静默剥离**而非报错

---

## 7. 建议提交切分

```
chore(cleanup): remove 9Remote promo modal and 9English link      ← 第 1+2 批
chore(cleanup): remove proxy pools feature                        ← 第 3 批
chore(cleanup): remove capacity/vision adapter                    ← 第 4a 批
chore(cleanup): remove combo feature                              ← 第 4b 批
chore(cleanup): drop dead compact.js and unused socks dep         ← §5
```

每批一个 commit，便于单独 revert。**不要合成一个巨型提交。**

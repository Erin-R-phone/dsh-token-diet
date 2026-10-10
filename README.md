# dsh-token-diet

给 DeepSeek Harness 一个**可开关的省 token 面板**：把"每轮都要付的固定开销"变成能随手拨的开关，并在侧边栏底部实时显示当前档位。

> 起因（2026-10-10 实测）：一次长会话 277 次模型调用，账单拆开是
> **缓存读 52% · 输出 39% · 未命中 9%**；而每次请求的**固定底噪 ≈18.5k tokens**。
> 其中最大的一块是 AnySearch MCP —— 一台就 **≈8,013 tokens/轮**
> （4 个工具 schema 23,288 字节，其中 `search` 一个工具 14,416 字节；服务器 instructions 另 2,352 字节）。
> 但垂类/结构化搜索偶尔确实要用 —— 所以正确做法不是"删掉它"，而是**默认关、要用时一键开**。

## 它管什么

| 开关 | 档位 | 实际改的是 profile 补丁层里的哪一行 | 值 |
|---|---|---|---|
| **搜索**（AnySearch MCP） | `off` / `on`（`gate` 是旧的 env 门写法，仍能识别） | `- id: mcp-anysearch` 的 `disabled:` | `true` / `false` / `!!js "process.env.ENABLE_ANYSEARCH !== '1'"` |
| **剪枝**（工具结果剪枝） | `strict` / `normal` | `- id: tool-result-pruner` 的 `config` | `4096/2048/512` / `8192/4096/1024`（上游默认） |
| **溢出**（超大结果落文件） | `strict` / `normal` | `- id: spill-policy` 的 `config.maxInlineTokens` | `6000` / `12500`（上游默认） |

- **搜索**：默认 `off` = **真排除**（那一行就是 `disabled: true`，那个 MCP 服务器根本不挂载，省下约 8k tokens/轮）。
  **需要垂类 / 结构化搜索时点一下拨到 `on`**（保存即热重组合，不用重启），用完拨回 `off`。
  `gate`（env 条件门）是早期写法，插件仍能识别并把它拨成硬开/硬关，但不再产生这一档。
- **剪枝 / 溢出**：`strict` 让历史里的大工具结果更早被剪、更大的结果更早落到文件（省的是"每轮重读的上下文"）；`normal` 是上游默认，信息更全但更贵。

## 安装

```bash
# 从本地目录（开发）：
dsh plugin --profile web add E:/path/to/dsh-token-diet
# 从 npm（发布后）：
dsh plugin --profile web add dsh-token-diet
```

装完在**侧边栏底部**多出三个小开关（`搜索` / `剪枝` / `溢出`），点一下拨到下一档。
模型侧同时多一个工具 `token_diet`，可以直接说「把搜索打开」「剪枝切回 normal」。

## 它怎么改配置（安全约束）

这个插件改的是**你的配置**，所以规则写死：

- **只改已存在的行**：三个目标行必须在补丁层里已经存在；找不到就**拒绝写入**并说明原因，绝不替你新增（新增/覆盖别人的行是插件管理器与用户自己的事）。
- **只做锚点字面替换**：每种写法的命中数必须**恰好 1 次**，否则抛错、一个字节都不写。
- **先备份**：每次写入前复制 `<cordis.patch.yml>.bak-token-diet-<时间戳>`。
- **保持编码**：本机 profile 补丁层是**无 BOM UTF-8**；带 BOM 会被 DSH 整层丢弃（表现是插件从界面消失）。插件会检测并沿用原编码。
- **换档后自检**：替换完再数一遍目标写法是否恰好 1 次，不过就抛错。

### 锚点（版本相关，改版要同步）

```yaml
# 1) 搜索
    - id: mcp-anysearch
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: !!js "process.env.ENABLE_ANYSEARCH !== '1'"   # ← 6 空格缩进

# 2) 剪枝
- id: tool-result-pruner
  config:
    thresholdChars: 4096                                     # ← 4 空格缩进
    headChars: 2048
    tailChars: 512

# 3) 溢出
- id: spill-policy
  config:
    maxInlineTokens: 6000
```

## 宿主接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__token-diet/status` | `{ ok, status: { anysearch, pruner, spill, patch, build }, where }` |
| POST | `/__token-diet/set` | body `{ "target": "anysearch|pruner|spill", "value": "..." }` → `{ ok, changed, from, to, backup, status }` |

模型工具：`token_diet({ action: "status" | "set", target?, value? })`。

## 边界（别对外承诺错）

- **它不减少功能，只减少"每轮重复读的东西"**；省下的量取决于档位与你的用法。
- 剪枝/溢出拨到 `strict` 后，**远期工具输出的中段模型看不到了**（被剪成头+尾+标记），要看全文需要重新读文件或重跑命令 —— 这是速度/成本换信息完整度的取舍。
- 插件只写**当前 profile** 的补丁层；改了 `--profile` 或换 home 就换了目标文件。
- 不改任何官方包、不改别的插件的行；**卸载即恢复**（或从 `.bak-token-diet-*` 还原）。

## 开发

```bash
node tools/self-check.mjs      # 离线自检（24 项）：语法 / 清单 / 补丁 / 浏览器半注册名 / 锚点夹具
```

- `lib/anchors.js` 纯逻辑（零依赖，可离线单测）：锚点识别与就地改写。
- `lib/index.js` 宿主半：`ctx.tools.register(defineTool(...))` + `webServer.register({ kind: 'prefix' })`
  （注册必须绑在 `ctx.effect(...)` 上，释放时才撤得掉）。
- `lib/client.js` 浏览器半：手写 bundle，`window.__ModuleLoader__.load({ id: '<包名>', factory })`；
  **id 必须是包名**（client-modules 按包名做行 id），注册席位走 `ctx.slots.inject('sidebar.footer.action', ...)`，
  list 席位**必须给 `id`**。
- 排查开关：给宿主设 `TOKEN_DIET_LOG=<某个文件路径>`，`apply()` 的每一步都会追加进去
  （正常情况只走 `ctx.logger`）。

### 一次真事故（为什么自检里有"语法"这一项）

本插件第一次装进 profile 时**整行不激活**（管理页面显示"未运行"，界面里也没有那三个开关）。
原因不是权限、不是版本：一次编辑留下了**重复的 `const` 声明**，模块 `SyntaxError` 根本解析不了，
而当时的自检只做字符串匹配、看不出来。修好之后：
- 自检新增「语法」一节（`lib/*.js` 逐个动态导入并区分 `SyntaxError`；浏览器半用 `vm.Script` 只编译不执行）；
- 并加了**反向夹具** `tools/fixtures/duplicate-const.js`（故意写坏），自检会断言"它必须被 SyntaxError 拦下"，
  否则报"检查器是摆设"。

另外两条实测经验：
- **装了新 bundle 要重启一次 `dsh web`** 才稳（HMR 会重组合，但一次加载失败之后它会停在那里不再推进；
  本机就是这样：14:54 那次失败后，之后所有补丁改动都不再生效）。
- 宿主半里 `ctx.webServer.register(...)` 必须放在 `ctx.effect(...)` 里 —— 漏了它会抛错，行同样不激活。

## 发到 GitHub（不需要 git / gh）

本机没有 git、也没有 gh，所以发布脚本走 GitHub REST API（零依赖、一次一个干净 commit）：

```bash
set GITHUB_TOKEN=ghp_xxx                        # fine-grained: Contents=RW + Administration=RW；或 classic: repo
node tools/publish-to-github.mjs --dry-run      # 先看会上传哪些文件、做哪些 API 调用
node tools/publish-to-github.mjs                # 建仓库（默认同名）+ 推一个 commit
node tools/publish-to-github.mjs --private --owner=<你的账号或组织> --repo=<名字>
```

只上传 `package.json` + 它的 `files` 列表（外加可选的 `.gitignore`），
所以工作区里的临时文件（`lib/probe.js`、缓存、诊断日志）不会被推上去。

MIT © 2026

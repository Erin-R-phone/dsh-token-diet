/**
 * `dsh-token-diet` — 宿主半。
 *
 * 它只做一件事：**让"省 token 的开关"变成能随时拨的东西**，而不是每次手改补丁层。
 *
 * 三个开关（都改写 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里**已经存在**的行，
 * 不新增行、不碰别的插件）：
 *
 *   1. `anysearch` —— 那个 MCP 服务器的行 `disabled:`：
 *        · `gate`   ：`disabled: !!js "process.env.ENABLE_ANYSEARCH !== '1'"`（默认；要 .env 或环境变量才开）
 *        · `on`     ：`disabled: false`  ← **需要搜索时拨到这一档**（保存即热重组合，不用重启）
 *        · `off`    ：`disabled: true`
 *        为什么它最重要：这个 MCP 一台就是 4 个工具 schema 23,288 字节 + instructions 2,352 字节
 *        ≈ 8,013 tokens/轮，是每轮固定开销里最大的一块。
 *   2. `pruner` —— `tool-result-pruner` 的 `thresholdChars/headChars/tailChars`：
 *        `strict` = 4096/2048/512（历史里的大工具结果剪得更早）· `normal` = 8192/4096/1024（上游默认）
 *   3. `spill`  —— `spill-policy` 的 `maxInlineTokens`：
 *        `strict` = 6000 · `normal` = 12500（更大的结果更早落到文件、不进上下文）
 *
 * 安全设计（因为这个插件要改的是**你的配置**，不是它自己的状态）：
 *   · 只做**锚点就地的字面替换**：每种写法必须**恰好命中一次**，否则抛错、一个字都不写；
 *   · 替换前后都重新数一遍锚点，写之前先复制 `.bak-token-diet-<时间戳>` 备份；
 *   · 保持原文件编码（本机 profile 补丁层是无 BOM UTF-8——带 BOM 会被 DSH 整层丢弃）；
 *   · 找不到目标行时**拒绝写入**并说明原因，不做"猜一个位置"。
 *
 * 暴露给模型：工具 `token_diet`（action=status|set）。
 * 暴露给界面：`/__token-diet/status`（GET）与 `/__token-diet/set`（POST {target,value}），
 * 由浏览器半（lib/client.js）在侧边栏底部画成三个小开关。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectStatus, applySwitch } from './anchors.js'

const PROBE_LOG = process.env.TOKEN_DIET_LOG ?? ''
/** 可选的文件探针（只在设了 TOKEN_DIET_LOG 时写）；正常走 ctx.logger。 */
const probe = (ctx, message) => {
	try {
		ctx?.logger?.info?.('[token-diet] ' + message)
	} catch {
		/* 记日志本身绝不能影响挂载 */
	}
	if (PROBE_LOG !== '') {
		try {
			appendFileSync(PROBE_LOG, `${new Date().toISOString()}  ${message}\n`)
		} catch {
			/* 同上 */
		}
	}
}

export const name = 'token-diet'
export const inject = ['tools']

const ROUTE_PREFIX = '/__token-diet'
const BUILD = 'v1'

const WHERE = { anysearch: 'AnySearch MCP（每轮 ≈8k tokens）', pruner: '工具结果剪枝（历史越长越值钱）', spill: '超大结果溢出门槛' }
const TARGETS = ['anysearch', 'pruner', 'spill']

/* ------------------------------------------------------------------ helpers */
function profilePatchPath(ctx) {
	const context = ctx.profileContext ?? ctx.get('profileContext')
	if (context !== undefined && typeof context.dir === 'string' && context.dir !== '') {
		return join(context.dir, 'cordis.patch.yml')
	}
	const home = context?.home ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
	const profile = context?.name ?? process.env.DSH_PROFILE ?? 'web'
	return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** 取某个行锚点之后、下一个 `- id:` 之前的文本块（也就是"这一行自己的配置"）。 */

function readPatch(file) {
	if (!existsSync(file)) throw new Error(`找不到 profile 补丁层：${file}`)
	const bytes = readFileSync(file)
	return { text: bytes.toString('utf8'), bom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf }
}

function writePatch(file, text, bom) {
	const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
	const backup = `${file}.bak-token-diet-${stamp}`
	copyFileSync(file, backup)
	writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8'))
	return backup
}

function statusPayload(ctx) {
	const file = profilePatchPath(ctx)
	const { text } = readPatch(file)
	return { ...detectStatus(text), patch: file, build: BUILD }
}

/** 拨开关并落盘；返回新状态与备份路径。 */
function setSwitch(ctx, target, value) {
	const file = profilePatchPath(ctx)
	const { text, bom } = readPatch(file)
	const result = applySwitch(text, target, value)
	if (!result.changed) return { changed: false, from: result.from, to: result.to, patch: file, backup: null, status: statusPayload(ctx) }
	const backup = writePatch(file, result.text, bom)
	return { changed: true, from: result.from, to: result.to, patch: file, backup, status: statusPayload(ctx) }
}

const summarize = (status) =>
	`token 饮食：AnySearch=${status.anysearch} · 剪枝=${status.pruner} · 溢出=${status.spill} · 补丁层=${status.patch}`

/* ------------------------------------------------------------------ routes */
function createHandler(ctx) {
	return (request, response) => {
		const url = request.url ?? ''
		const send = (code, payload) => {
			const body = JSON.stringify(payload)
			response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
			response.end(body)
		}
		if (!url.startsWith(ROUTE_PREFIX)) return send(404, { ok: false, error: 'not-a-token-diet-route' })
		const tail = url.slice(ROUTE_PREFIX.length)
		try {
			if (request.method === 'GET' && (tail === '/status' || tail === '')) return send(200, { ok: true, status: statusPayload(ctx), where: WHERE })
			if (request.method === 'POST' && tail === '/set') {
				const chunks = []
				request.on('data', (chunk) => chunks.push(chunk))
				request.on('end', () => {
					try {
						const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
						const outcome = setSwitch(ctx, body.target, body.value)
						send(200, { ok: true, ...outcome })
					} catch (error) {
						send(400, { ok: false, error: String(error?.message ?? error) })
					}
				})
				return
			}
			return send(404, { ok: false, error: 'unknown-token-diet-route' })
		} catch (error) {
			return send(500, { ok: false, error: String(error?.message ?? error) })
		}
	}
}

/* ------------------------------------------------------------------ plugin */
export function apply(ctx) {
	probe(ctx, 'apply entered; webServer=' + String(ctx.get('webServer') !== undefined) + ' tools=' + String(ctx.get('tools') !== undefined))

	/* 每一步各自兜底：任何一步失败，行照样激活，其余能力照常可用，错误进日志而不是把整行拖死。 */
	const steps = []
	const step = (label, run) => {
		try {
			run()
			steps.push(label + ':ok')
		} catch (error) {
			steps.push(label + ':FAILED')
			probe(ctx, `step ${label} FAILED: ${error?.stack ?? error}`)
			try {
				ctx.logger?.error?.(`[token-diet] step ${label} failed: ${error?.message ?? error}`)
			} catch {
				/* ignore */
			}
		}
	}

	// 路由：注册必须绑在 effect 上（释放时要撤掉），冷启动时 webServer 可能还没注册，用 inject 等它。
	const handler = createHandler(ctx)
	const mount = (webServer, owner) => {
		owner.effect(() => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'dsh-token-diet: routes')
		probe(ctx, 'web routes mounted at ' + ROUTE_PREFIX)
	}
	const webServer = ctx.get('webServer')
	if (webServer === undefined) {
		probe(ctx, 'webServer not ready yet; deferring route mount')
		ctx.inject(['webServer'], (scoped) => {
			const late = scoped.get('webServer')
			if (late !== undefined) step('routes(late)', () => mount(late, scoped))
		})
	} else {
		step('routes', () => mount(webServer, ctx))
	}

	// 模型侧：一个工具，status / set。
	step('tool', () => ctx.tools.register(
		defineTool({
			name: 'token_diet',
			description:
				'Read or change the profile-wide token-diet switches: anysearch (the AnySearch MCP row: off = the default hard exclusion, on = mounted while a task needs vertical/structured search, gate = legacy env-gated form), ' +
				'pruner (tool-result trimming: strict|normal) and spill (oversized-result spilling: strict|normal). ' +
				'Changes are written into the profile patch layer with a timestamped backup and take effect on the next recomposition. ' +
				'Use action=status first; turn anysearch on only while a task really needs vertical search, then turn it back off.',
			parameters: {
				action: { type: 'string', required: true, enum: ['status', 'set'], description: 'status = 只读当前档位；set = 拨动一个开关' },
				target: { type: 'string', enum: TARGETS, description: 'set 时必填：要拨哪个开关' },
				value: {
					type: 'string',
					enum: ['gate', 'on', 'off', 'strict', 'normal'],
					description: 'set 时必填：anysearch 用 gate|on|off；pruner/spill 用 strict|normal',
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						summary: { type: 'string', required: true, description: '一行结论' },
						status: {
							type: 'object',
							required: true,
							additionalProperties: false,
							properties: {
								anysearch: { type: 'string', required: true, description: 'gate | on | off | custom | missing' },
								pruner: { type: 'string', required: true, description: 'strict | normal | custom' },
								spill: { type: 'string', required: true, description: 'strict | normal | custom' },
								patch: { type: 'string', required: true, description: '补丁层文件路径' },
								build: { type: 'string', required: true, description: '本插件版本标记' },
							},
						},
					},
				},
				render: (_args, value) => [{ type: 'text', text: value.summary }],
			},
			execute(args) {
				if (args.action === 'set') {
					const outcome = setSwitch(ctx, args.target, args.value)
					const head = outcome.changed
						? `已把 ${args.target} 从 ${outcome.from} 拨到 ${outcome.to}（备份 ${outcome.backup}），下一次重组合生效`
						: `${args.target} 本来就是 ${outcome.to}，没动它`
					return Promise.resolve({ summary: `${head} —— ${summarize(outcome.status)}`, status: outcome.status })
				}
				const status = statusPayload(ctx)
				return Promise.resolve({ summary: summarize(status), status })
			},
		}),
	))
	probe(ctx, 'apply finished: ' + steps.join(', '))
}

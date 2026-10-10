/**
 * `dsh-token-diet` —— 锚点逻辑（**零依赖**，可离线单测）。
 *
 * 这些函数只吃/吐字符串，不碰文件、不 import DSH 的任何包 —— 所以
 * `tools/self-check.mjs` 能在没有 DSH 的机器上直接跑它们。
 *
 * 设计原则（因为改的是用户的配置，不是自己的状态）：
 *   · 只认**已存在的行**，找不到就报错，绝不新增；
 *   · 每种写法必须**恰好命中一次**，否则抛错、一个字节都不写；
 *   · 替换后自检目标写法，不通过就抛错。
 */

/** 三个开关的锚点与合法写法。缩进必须与真实补丁层一致（见 README「锚点」）。 */
export const ANCHORS = {
	anysearch: {
		row: '- id: mcp-anysearch',
		forms: {
			gate: `      disabled: !!js "process.env.ENABLE_ANYSEARCH !== '1'"`,
			on: '      disabled: false',
			off: '      disabled: true',
		},
	},
	pruner: {
		row: '- id: tool-result-pruner',
		forms: {
			strict: ['    thresholdChars: 4096', '    headChars: 2048', '    tailChars: 512'],
			normal: ['    thresholdChars: 8192', '    headChars: 4096', '    tailChars: 1024'],
		},
	},
	spill: {
		row: '- id: spill-policy',
		forms: {
			strict: ['    maxInlineTokens: 6000'],
			normal: ['    maxInlineTokens: 12500'],
		},
	},
}

export const TARGETS = ['anysearch', 'pruner', 'spill']

export const countOf = (text, needle) => text.split(needle).length - 1

/** 取某个行锚点之后、下一个 `- id:` 之前的文本块（也就是"这一行自己的配置"）。 */
export function blockOf(text, marker) {
	const start = text.indexOf(marker)
	if (start < 0) return null
	const rest = text.slice(start + marker.length)
	const next = rest.search(/\r?\n\s*- id: /)
	return next < 0 ? rest : rest.slice(0, next)
}

/** 当前各开关的档位；认不出来就报 `custom`/`missing`，绝不猜。 */
export function detectStatus(text) {
	const status = { anysearch: 'missing', pruner: 'custom', spill: 'custom' }
	const anyBlock = blockOf(text, ANCHORS.anysearch.row)
	if (anyBlock !== null) {
		if (anyBlock.includes(ANCHORS.anysearch.forms.gate)) status.anysearch = 'gate'
		else if (/^\s*disabled:\s*false\s*$/m.test(anyBlock)) status.anysearch = 'on'
		else if (/^\s*disabled:\s*true\s*$/m.test(anyBlock)) status.anysearch = 'off'
		else status.anysearch = 'custom'
	}
	for (const form of ['strict', 'normal']) {
		if (ANCHORS.pruner.forms[form].every((line) => countOf(text, line) === 1)) status.pruner = form
	}
	for (const form of ['strict', 'normal']) {
		if (ANCHORS.spill.forms[form].every((line) => countOf(text, line) === 1)) status.spill = form
	}
	return status
}

/** 把一个开关拨到目标档：只做整块字面替换，命中数不等于 1 就抛错。 */
export function applySwitch(text, target, value) {
	const anchor = ANCHORS[target]
	if (anchor === undefined) throw new Error(`未知开关：${target}（可用：${TARGETS.join(' / ')}）`)
	if (blockOf(text, anchor.row) === null) {
		throw new Error(`补丁层里没有 "${anchor.row}" 这一行 —— 本插件只改已存在的行，不替你新增；请先在补丁层里加上它`)
	}
	const wanted = anchor.forms[value]
	if (wanted === undefined) throw new Error(`${target} 不支持档位 "${value}"（可用：${Object.keys(anchor.forms).join(' / ')}）`)

	let current = null
	for (const [form, formValue] of Object.entries(anchor.forms)) {
		const lines = Array.isArray(formValue) ? formValue : [formValue]
		if (lines.every((line) => text.includes(line))) {
			current = form
			break
		}
	}
	if (current === null) {
		throw new Error(`${target} 当前的写法不在已知档位里（${Object.keys(anchor.forms).join(' / ')}）—— 版本不同或已被手改，本插件拒绝盲改`)
	}
	if (current === value) return { text, changed: false, from: current, to: value }

	const fromLines = Array.isArray(anchor.forms[current]) ? anchor.forms[current] : [anchor.forms[current]]
	const toLines = Array.isArray(wanted) ? wanted : [wanted]
	let next = text
	for (let index = 0; index < fromLines.length; index += 1) {
		const from = fromLines[index]
		const to = toLines[index]
		const hits = countOf(next, from)
		if (hits !== 1) throw new Error(`锚点 "${from.trim()}" 命中 ${hits} 次（要求恰好 1 次）—— 拒绝写入`)
		next = next.split(from).join(to)
	}
	if (!toLines.every((line) => countOf(next, line) === 1)) throw new Error('替换后自检失败（目标写法没有恰好出现一次）—— 拒绝写入')
	return { text: next, changed: true, from: current, to: value }
}

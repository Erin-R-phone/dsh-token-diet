#!/usr/bin/env node
/**
 * self-check.mjs —— dsh-token-diet 的离线自检（不需要 DSH 在跑）。
 *
 * 检查的是「装上去会不会出事的硬判据」：
 *   1. package.json：名字、type、exports["./client"]、dsh.bundle.patch、dsh.client.platform=web
 *      （每个 `files` 里声明的文件都真的存在 —— 少了那个文件，pnpm 装出来的副本就是残的）
 *   2. cordis.patch.yml 能解析，且 `insert` 里恰好一行、name === 包名
 *   3. lib/client.js：调了 `__ModuleLoader__.load`，而且 **load 的 id 就是包名**
 *      （client-modules 按包名做行 id，少了这一格 = 刷新后页面起不来）
 *   4. lib/index.js：导出了 name / inject / apply，并暴露 token_diet 工具与 /__token-diet 路由
 *   5. 锚点工具函数在真实补丁层文本上能正常工作（用一个最小夹具跑一遍 detect/apply）
 *
 * 退出码：0 全过；1 有问题。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)

const problems = []
const notes = []
const ok = (message) => console.log('  ✓ ' + message)
const fail = (message) => {
	problems.push(message)
	console.log('  ✗ ' + message)
}

/* ---------------------------------------------------------------- 0) syntax */
console.log('语法（这一项救过一次命：重复 const 声明 → SyntaxError → 整行不激活）')
const vm = await import('node:vm')
for (const entry of ['lib/index.js', 'lib/anchors.js']) {
	const source = readFileSync(join(root, entry), 'utf8')
	try {
		// 解析先于依赖解析：所以即使 @deepseek-ai/dsh-tools 在本机解析不到，
		// 语法错误也会先以 SyntaxError 冒出来 —— 正好拿来当离线语法检查。
		await import(pathToFileURL(join(root, entry)).href + '?selfcheck=' + Date.now())
		ok(`${entry} 语法通过（且能被导入）`)
	} catch (error) {
		if (error?.name === 'SyntaxError') fail(`${entry} 语法错误：${error.message}`)
		else if (/ERR_MODULE_NOT_FOUND|Cannot find package/.test(String(error?.code ?? '') + String(error?.message))) {
			ok(`${entry} 语法通过（依赖在离线环境解析不到，属预期）`)
		} else fail(`${entry} 导入失败：${error?.name}: ${error?.message}`)
	}
}
{
	// 浏览器半是 **classic script**（自己调 window.__ModuleLoader__.load），不能当 ESM 导入；
	// 用 vm.Script 只编译不执行 —— 正好做纯语法检查。
	const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
	try {
		new vm.Script(source, { filename: 'lib/client.js' })
		ok('lib/client.js 语法通过（vm.Script 编译，不执行）')
	} catch (error) {
		fail(`lib/client.js 语法错误：${error.message}`)
	}
}
{
	// 反向自测：故意带重复声明的夹具必须被判为语法错误，否则这个检查器是摆设。
	const fixture = join(root, 'tools', 'fixtures', 'duplicate-const.js')
	if (existsSync(fixture)) {
		try {
			await import(pathToFileURL(fixture).href + '?selfcheck=' + Date.now())
			fail('检查器自测失败：坏夹具居然通过了语法检查')
		} catch (error) {
			if (error?.name === 'SyntaxError') ok('检查器自测通过（坏夹具被 SyntaxError 拦下）')
			else fail('检查器自测异常：' + error?.message)
		}
	}
}

/* ---------------------------------------------------------------- 1) manifest */
console.log('package.json')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (manifest.name !== 'dsh-token-diet') fail(`name = ${manifest.name}，应为 dsh-token-diet`)
else ok('name = dsh-token-diet')
if (manifest.type !== 'module') fail(`type = ${manifest.type}，应为 module`)
else ok('type = module')
const clientRel = manifest.exports?.['./client']?.default
if (typeof clientRel !== 'string') fail('exports["./client"].default 不是字符串')
else ok(`exports["./client"] = ${clientRel}`)
if (manifest.dsh?.bundle?.patch === undefined) fail('dsh.bundle.patch 未声明（装了也不会成为组合包行）')
else ok(`dsh.bundle.patch = ${manifest.dsh.bundle.patch}`)
if (manifest.dsh?.client?.platform !== 'web') fail(`dsh.client.platform = ${manifest.dsh?.client?.platform}，应为 web`)
else ok('dsh.client.platform = web')
for (const file of manifest.files ?? []) {
	if (!existsSync(join(root, file))) fail(`files 里声明的 ${file} 不存在`)
}
if ((manifest.files ?? []).length > 0) ok(`files 里 ${manifest.files.length} 项都在`)
// 反向检查：代码里 import 的每个同包相对路径都必须出现在 files 里 —— 漏一个，
// pnpm 装出来的副本就是残的（本机 workbench-viewports 就栽过：host.js 不在 files 里）。
for (const entry of [...(manifest.files ?? [])].filter((file) => file.startsWith('lib/') && file.endsWith('.js'))) {
	const source = readFileSync(join(root, entry), 'utf8')
	for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
		const target = match[1].replace(/^\.\//, 'lib/')
		if (!(manifest.files ?? []).includes(target)) fail(`${entry} 里 import 了 ${match[1]}，但 ${target} 不在 files 里（装出来的副本会缺文件）`)
	}
}
ok('lib/ 下每个相对 import 都在 files 里')
for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
	if (!peer.startsWith('@deepseek-ai/dsh')) fail(`peerDependency ${peer} 不是 DSH 包（会被 app-boot 忽略）`)
	else notes.push(`peer ${peer}@${range}`)
}

/* ---------------------------------------------------------------- 2) bundle patch */
console.log('cordis.patch.yml')
const patchPath = join(root, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
const patchText = readFileSync(patchPath, 'utf8')
if (/^\uFEFF/.test(patchText)) fail('补丁层带 BOM（DSH 会整层丢弃）')
else ok('补丁层无 BOM')
let YAML = null
for (const candidate of ['yaml', 'E:/DSH/app/node_modules/yaml']) {
	try {
		YAML = require(candidate)
		break
	} catch {
		/* try the next candidate */
	}
}
if (YAML === null) notes.push('本机找不到 yaml 模块，跳过解析检查（只看结构）')
if (YAML !== null) {
	const doc = YAML.parse(patchText)
	if (!Array.isArray(doc)) fail('补丁层顶层不是数组')
	else {
		const inserts = doc.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
		if (inserts.length !== 1) fail(`insert 里应恰好 1 行，实际 ${inserts.length}`)
		else if (inserts[0].name !== manifest.name) fail(`insert 的 name = ${inserts[0].name}，应等于包名 ${manifest.name}`)
		else ok(`insert 一行：id=${inserts[0].id} name=${inserts[0].name}`)
	}
}

/* ---------------------------------------------------------------- 3) browser half */
console.log('lib/client.js')
const clientText = readFileSync(join(root, clientRel), 'utf8')
if (!clientText.includes('__ModuleLoader__.load')) fail('没有调用 window.__ModuleLoader__.load（浏览器半不会被识别）')
else ok('调用了 __ModuleLoader__.load')
const loadId = /__ModuleLoader__\.load\(\s*\{\s*id:\s*["'`]([^"'`]+)["'`]/.exec(clientText)
if (loadId === null) fail('读不出 load 的 id')
else if (loadId[1] !== manifest.name) fail(`load 的 id = ${loadId[1]}，必须是包名 ${manifest.name}（否则刷新后页面起不来）`)
else ok(`load id = ${manifest.name}`)
if (!/slots\.inject\(/.test(clientText)) fail('没有用 slots.inject 注册席位（外壳声明晚于本插件激活时会挂不上）')
else ok('用 slots.inject 注册席位')
if (!/id:\s*["']token-diet["']/.test(clientText)) fail('list 席位没给 id（sidebar.footer.action 是 list 席位，必须给 id）')
else ok('list 席位带了 id')

/* ---------------------------------------------------------------- 4) host half */
console.log('lib/index.js')
const hostText = readFileSync(join(root, 'lib/index.js'), 'utf8')
for (const [label, pattern] of [
	['导出 name', /export const name = /],
	['导出 inject', /export const inject = /],
	['导出 apply', /export function apply\(/],
	['注册 token_diet 工具', /name:\s*'token_diet'/],
	['注册 /__token-diet 路由', /ROUTE_PREFIX = '\/__token-diet'/],
	['用 webServer.register', /webServer\.register\(/],
	['webServer 晚到用 inject', /ctx\.inject\(\['webServer'\]/],
]) {
	if (pattern.test(hostText)) ok(label)
	else fail(`缺：${label}`)
}

/* ---------------------------------------------------------------- 5) anchors on a fixture */
console.log('锚点夹具')
const fixture = `- insert:\n    - id: mcp-anysearch\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: !!js "process.env.ENABLE_ANYSEARCH !== '1'"\n- id: tool-result-pruner\n  config:\n    thresholdChars: 4096\n    headChars: 2048\n    tailChars: 512\n- id: spill-policy\n  config:\n    maxInlineTokens: 6000\n`
try {
	const { pathToFileURL } = await import('node:url')
	const { detectStatus, applySwitch } = await import(pathToFileURL(join(root, 'lib', 'anchors.js')).href)
	const detected = detectStatus(fixture)
	if (detected.anysearch === 'gate' && detected.pruner === 'strict' && detected.spill === 'strict') ok(`detectStatus → ${JSON.stringify(detected)}`)
	else fail(`detectStatus 认错档位：${JSON.stringify(detected)}`)
	const toOn = applySwitch(fixture, 'anysearch', 'on')
	if (!toOn.changed || detectStatus(toOn.text).anysearch !== 'on') fail('anysearch → on 没生效')
	else ok('anysearch gate → on')
	const toNormal = applySwitch(toOn.text, 'pruner', 'normal')
	if (detectStatus(toNormal.text).pruner !== 'normal') fail('pruner → normal 没生效')
	else ok('pruner strict → normal（三行一起换）')
	const again = applySwitch(toNormal.text, 'pruner', 'normal')
	if (again.changed) fail('同档位重复拨动不该改文件')
	else ok('同档位重复拨动 = no-op')
	let refused = false
	try {
		applySwitch('- insert:\n    - id: other\n', 'anysearch', 'on')
	} catch {
		refused = true
	}
	if (refused) ok('目标行不存在时拒绝写入')
	else fail('目标行不存在时居然写成功了')
} catch (error) {
	fail('锚点检查抛错：' + error.message)
}

/* ---------------------------------------------------------------- recap */
console.log('')
for (const note of notes) console.log('  · ' + note)
console.log(problems.length === 0 ? 'self-check 全部通过' : `self-check 失败 ${problems.length} 项`)
process.exit(problems.length === 0 ? 0 : 1)

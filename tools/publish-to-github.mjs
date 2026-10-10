#!/usr/bin/env node
/**
 * publish-to-github.mjs —— 零依赖把本插件发到 GitHub（**不需要 git / gh**）。
 *
 * 为什么用 REST API：本机没装 git、也没装 gh，没有任何 GitHub 凭据；
 * 而 `api.github.com` 是可达的。用 Git Data API 一次推一个干净的 commit：
 *   blobs → tree → commit → 更新 ref
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxx            &  node tools/publish-to-github.mjs
 *   node tools/publish-to-github.mjs --token=ghp_xxx --repo=dsh-token-diet --private
 *   node tools/publish-to-github.mjs --dry-run          # 只列要上传哪些文件、做哪些 API 调用
 *   node tools/publish-to-github.mjs --owner=someone    # 默认用 token 自己的账号
 *
 * 只上传 `package.json` + `package.json#files` 里声明的东西（外加可选的 .gitignore），
 * 所以工作区里的临时文件（probe.js、缓存、诊断日志）不会被推上去。
 *
 * Token 需要的最小权限：fine-grained → Contents: Read and write + Administration: Read and write
 * （要新建仓库）；或 classic → `repo`（私有）/~`public_repo`（公开）。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const API = 'https://api.github.com'

const args = new Map()
for (const raw of process.argv.slice(2)) {
	const match = /^--([^=]+)(?:=(.*))?$/.exec(raw)
	if (match) args.set(match[1], match[2] === undefined ? 'true' : match[2])
}
const opt = (name, fallback) => (args.has(name) ? args.get(name) : fallback)
const token = opt('token', process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '')
const repo = opt('repo', 'dsh-token-diet')
const owner = opt('owner', null)
const branch = opt('branch', 'main')
const isPrivate = opt('private', 'false') === 'true'
const dryRun = opt('dry-run', 'false') === 'true'

/* ------------------------------------------------------------------ collect */
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const wanted = new Set(['package.json', ...(manifest.files ?? []), '.gitignore'])
const files = []
const collect = (absolute) => {
	const stats = statSync(absolute)
	if (stats.isDirectory()) {
		for (const entry of readdirSync(absolute)) collect(join(absolute, entry))
		return
	}
	const path = relative(root, absolute).split(sep).join('/')
	files.push({ path, absolute, size: stats.size })
}
for (const entry of wanted) {
	const absolute = join(root, entry)
	if (!existsSync(absolute)) {
		console.log(`· 跳过（不存在）：${entry}`)
		continue
	}
	collect(absolute)
}
files.sort((a, b) => a.path.localeCompare(b.path))
const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

console.log(`将上传 ${files.length} 个文件，共 ${(totalBytes / 1024).toFixed(1)} KB：`)
for (const file of files) console.log(`  ${file.path}  (${file.size} B)`)
if (dryRun) {
	console.log('\n--dry-run：不做任何网络写操作。真实运行时将执行：')
	console.log('  GET  /user                              → 确认 token 身份')
	console.log(`  GET  /repos/{owner}/${repo}             → 不存在则 POST 创建（${isPrivate ? 'private' : 'public'}）`)
	console.log(`  POST /repos/{owner}/${repo}/git/blobs   ×${files.length}`)
	console.log(`  POST /repos/{owner}/${repo}/git/trees   → 一棵树（一个 commit）`)
	console.log(`  POST /repos/{owner}/${repo}/git/commits`)
	console.log(`  PATCH /repos/{owner}/${repo}/git/refs/heads/${branch}`)
	process.exit(0)
}

if (token === '') {
	console.error('\n没有 token。两种给法：')
	console.error('  1) set GITHUB_TOKEN=ghp_xxx   然后重跑（临时环境变量，不落盘）')
	console.error('  2) node tools/publish-to-github.mjs --token=ghp_xxx')
	console.error('权限：fine-grained 需要 Contents=Read+Write、Administration=Read+Write（要建仓库）；')
	console.error('      或 classic token 的 repo（私有）/ public_repo（公开）。')
	process.exit(2)
}

/* ------------------------------------------------------------------ api */
async function api(method, path, body) {
	const response = await fetch(API + path, {
		method,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'x-github-api-version': '2022-11-28',
			'user-agent': 'dsh-token-diet-publisher',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await response.text()
	let payload = null
	try {
		payload = text === '' ? null : JSON.parse(text)
	} catch {
		payload = { raw: text.slice(0, 300) }
	}
	if (!response.ok) {
		const message = payload?.message ?? response.statusText
		const error = new Error(`${method} ${path} → ${response.status} ${message}`)
		error.status = response.status
		error.payload = payload
		throw error
	}
	return payload
}

const user = await api('GET', '/user')
const login = owner ?? user.login
console.log(`\n已认证：${user.login}`)

let repository = null
try {
	repository = await api('GET', `/repos/${login}/${repo}`)
	console.log(`仓库已存在：${repository.full_name}（默认分支 ${repository.default_branch}）`)
} catch (error) {
	if (error.status !== 404) throw error
	const createPath = owner !== null && owner !== user.login ? `/orgs/${login}/repos` : '/user/repos'
	repository = await api('POST', createPath, {
		name: repo,
		description: manifest.description,
		private: isPrivate,
		has_issues: true,
		has_wiki: false,
		has_projects: false,
		auto_init: false,
	})
	console.log(`已创建仓库：${repository.full_name}（${isPrivate ? 'private' : 'public'}）`)
}

const head = await (async () => {
	try {
		return await api('GET', `/repos/${login}/${repo}/git/ref/heads/${branch}`)
	} catch (error) {
		if (error.status === 404) return null
		throw error
	}
})()
const parentCommit = head === null ? null : await api('GET', `/repos/${login}/${repo}/git/commits/${head.object.sha}`)

console.log(`\n上传 ${files.length} 个 blob…`)
const blobs = []
for (const file of files) {
	const blob = await api('POST', `/repos/${login}/${repo}/git/blobs`, {
		content: readFileSync(file.absolute).toString('base64'),
		encoding: 'base64',
	})
	blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
	process.stdout.write(`  ${file.path} → ${String(blob.sha).slice(0, 8)}\n`)
}

const tree = await api('POST', `/repos/${login}/${repo}/git/trees`, {
	...(parentCommit === null ? {} : { base_tree: parentCommit.tree.sha }),
	tree: blobs,
})
const commit = await api('POST', `/repos/${login}/${repo}/git/commits`, {
	message: `dsh-token-diet ${manifest.version}: ${files.length} files\n\nvia tools/publish-to-github.mjs`,
	tree: tree.sha,
	...(parentCommit === null ? {} : { parents: [parentCommit.sha] }),
})
if (head === null) {
	await api('POST', `/repos/${login}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
} else {
	await api('PATCH', `/repos/${login}/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
}
console.log(`\n完成：${repository.html_url}（分支 ${branch}，commit ${String(commit.sha).slice(0, 8)}）`)

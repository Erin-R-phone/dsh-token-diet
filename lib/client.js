/**
 * `dsh-token-diet` — 浏览器半。
 *
 * 手写 bundle：DSH 的 Web carrier 把 `exports["./client"]` 当 classic script 原样下发，
 * 所以必须自己调 `window.__ModuleLoader__.load()` 注册工厂，而且 **load 的 id 必须是包名**
 * （client-modules 按包名做行 id，少了那一格 = 刷新后页面起不来）。
 *
 * 只做一件事：在侧边栏底部 `sidebar.footer.action` 席位放三个小开关 ——
 *   搜索（AnySearch MCP：gate/on/off）· 剪枝（strict/normal）· 溢出（strict/normal）
 * 状态与拨动都走宿主半的 `/__token-diet/*`，浏览器不碰文件。
 *
 * 页面安全是硬要求：
 *   · 渲染里不抛错（取不到状态就显示 `—`，不阻塞侧边栏）；
 *   · 样式全部走 `--dsw-*` 主题令牌并带兜底色，不硬编码调色板外的颜色；
 *   · 不用 `width:100%`，避免把同一行的余额卡挤窄（那一行的排布是别的插件的战场）。
 */

window.__ModuleLoader__.load({
	id: "dsh-token-diet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const ROUTE = "/__token-diet";

		/* ------------------------------------------------------------ styles */
		const STYLE_ID = "dsh-token-diet-style";
		const CSS = `
.dsh-td-row{display:inline-flex;align-items:center;gap:4px;flex:none}
.dsh-td-chip{appearance:none;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap}
.dsh-td-chip:hover{background:var(--dsw-alias-fill-l1,rgba(127,127,127,.12))}
.dsh-td-chip:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);outline-offset:1px}
.dsh-td-chip[disabled]{opacity:.55;cursor:default}
.dsh-td-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#aaa)}
.dsh-td-chip[data-state="on"] .dsh-td-dot{background:var(--dsw-alias-brand-primary,#f97316)}
.dsh-td-chip[data-state="gate"] .dsh-td-dot{background:var(--dsw-alias-state-warn-primary,#e08a1e)}
.dsh-td-chip[data-state="off"] .dsh-td-dot{background:var(--dsw-alias-label-tertiary,#bbb)}
.dsh-td-chip[data-state="strict"] .dsh-td-dot{background:var(--dsw-alias-brand-primary,#f97316)}
.dsh-td-chip[data-state="normal"] .dsh-td-dot{background:var(--dsw-alias-label-tertiary,#bbb)}
.dsh-td-chip[data-busy="1"]{opacity:.7}
.dsh-td-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);max-width:220px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
`;

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID)) return;
			const node = document.createElement("style");
			node.id = STYLE_ID;
			node.textContent = CSS;
			(document.head ?? document.documentElement)?.appendChild(node);
		}

		/* ------------------------------------------------------------ logic */
		/* 两档：off（默认，**真排除** —— 那一行 `disabled: true`，服务器根本不挂载）/ on（需要搜索时）。
		 * `gate` 是旧写法（env 条件门），仍能识别，但本插件不再产生它。 */
		const ANYSEARCH_ORDER = ["off", "on"];
		const ANY_TITLE = {
			off: "AnySearch：关（默认，真排除）· 省下约 8k tokens/轮 —— 需要垂类/结构化搜索时点一下打开",
			on: "AnySearch：开 · 每轮约 8k tokens —— 用完记得拨回关",
			gate: "AnySearch：旧写法（env 条件门）—— 点一下会改成硬开/硬关",
			custom: "AnySearch：写法不在已知档位（手改过？）—— 点一下可拨到下一档",
			missing: "AnySearch：补丁层里没有这一行",
		};
		const PRUNER_TITLE = {
			strict: "工具结果剪枝：strict（4096/2048/512 码点）—— 历史里的大结果剪得更早",
			normal: "工具结果剪枝：normal（8192/4096/1024，上游默认）",
			custom: "剪枝：写法不在已知档位",
		};
		const SPILL_TITLE = {
			strict: "超大结果溢出：strict（6000 tokens 以内留在上下文）",
			normal: "超大结果溢出：normal（12500，上游默认）",
			custom: "溢出：写法不在已知档位",
		};

		async function callStatus() {
			const response = await fetch(ROUTE + "/status", { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error("HTTP " + response.status);
			const payload = await response.json();
			return payload.status ?? null;
		}

		async function callSet(target, value) {
			const response = await fetch(ROUTE + "/set", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target, value }),
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? "HTTP " + response.status);
			return payload;
		}

		/* ------------------------------------------------------------ component */
		function TokenDietChips() {
			const [status, setStatus] = React.useState(null);
			const [note, setNote] = React.useState("读取中…");
			const [busy, setBusy] = React.useState(false);

			const refresh = React.useCallback(() => {
				callStatus()
					.then((next) => {
						setStatus(next);
						setNote("搜索 " + next.anysearch + " · 剪枝 " + next.pruner + " · 溢出 " + next.spill);
					})
					.catch((error) => {
						setStatus(null);
						setNote("宿主路由未就绪：" + String(error?.message ?? error));
					});
			}, []);

			React.useEffect(() => {
				ensureStyles();
				refresh();
			}, [refresh]);

			const flip = React.useCallback(
				(target, value) => {
					setBusy(true);
					setNote("正在拨 " + target + " → " + value + "…");
					callSet(target, value)
						.then((payload) => {
							if (payload.status) setStatus(payload.status);
							setNote(payload.changed ? "已拨 " + target + " → " + payload.to + "（已重组合）" : target + " 本来就是 " + payload.to);
						})
						.catch((error) => setNote("拨动失败：" + String(error?.message ?? error)))
						.finally(() => setBusy(false));
				},
				[],
			);

			const anyState = status?.anysearch ?? "missing";
			const prunerState = status?.pruner ?? "custom";
			const spillState = status?.spill ?? "custom";

			const chip = (key, label, state, title, onClick) =>
				React.createElement(
					"button",
					{
						type: "button",
						className: "dsh-td-chip",
						"data-state": state,
						"data-busy": busy ? "1" : "0",
						disabled: busy,
						title: title + "\n（点击拨到下一档）",
						"aria-label": "Token 饮食 · " + label + "：" + state,
						onClick,
					},
					React.createElement("span", { className: "dsh-td-dot" }),
					React.createElement("span", null, label),
				);

			return React.createElement(
				"div",
				{ className: "dsh-td-row", "aria-label": "Token 饮食（省 token 开关）" },
				chip("anysearch", "搜索", anyState, ANY_TITLE[anyState] ?? ANY_TITLE.custom, () =>
					flip("anysearch", anyState === "on" ? "off" : "on"),
				),
				chip("pruner", "剪枝", prunerState, PRUNER_TITLE[prunerState] ?? PRUNER_TITLE.custom, () =>
					flip("pruner", prunerState === "strict" ? "normal" : "strict"),
				),
				chip("spill", "溢出", spillState, SPILL_TITLE[spillState] ?? SPILL_TITLE.custom, () =>
					flip("spill", spillState === "strict" ? "normal" : "strict"),
				),
				React.createElement("span", { className: "dsh-td-note", title: note }, note),
			);
		}

		/** 需要插槽注册表；服务就绪前 cordis 会推迟 apply。 */
		const inject = ["slots"];

		/**
		 * 注册到侧边栏底部那一行。
		 *
		 * 必须走 `slots.inject(slotName, cb)`：`sidebar.footer.action` 由侧边栏外壳声明，
		 * 声明可能晚于本插件激活。order=30 让它排在余额表(10)与桌宠按钮(15)之后。
		 * 这是 list 席位，**必须给 id**（少了 id 会被 slots 直接抛错，挂不上）。
		 */
		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "token-diet", order: 30, label: () => "Token 饮食" },
					TokenDietChips,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TokenDietChips = TokenDietChips;
		return module.exports;
	},
});

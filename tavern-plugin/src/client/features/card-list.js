		async function deleteTavernCards(cards, remove) {
			const results = [];
			const paths = new Set();
			for (const card of cards) {
				if (paths.has(card.path)) continue;
				paths.add(card.path);
				try {
					const result = await remove(card.path);
					if (!result || result.deleted !== true) throw new Error("人物卡未删除");
					results.push({ path: card.path, name: card.name, ok: true });
				} catch (error) { results.push({ path: card.path, name: card.name, ok: false, error: String(error && error.message || error) }); }
			}
			return results;
		}

		// @include card-organization.js

		function useCardBatchDeletion(cards, busy, setBusy, refresh) {
            const askConfirm = useTavernConfirm();
			const [managing, setManaging] = React.useState(false);
			const [paths, setPaths] = React.useState([]);
			const [notice, setNotice] = React.useState("");
			const running = React.useRef(false);
			const selected = cards.filter(card => paths.includes(card.path));
			function toggle(path) { if (!busy && !running.current) setPaths(previous => previous.includes(path) ? previous.filter(value => value !== path) : previous.concat(path)); }
			function isSelected(path) { return paths.includes(path); }
			function reset() { setManaging(false); setPaths([]); setNotice(""); }
			async function removeSelected() {
				if (busy || running.current || !selected.length) return;
				const names = selected.slice(0, 20).map(card => "• " + card.name + "（" + card.path + "）").join("\n");
				if (!await askConfirm("删除所选的 " + selected.length + " 张人物卡吗？\n\n" + names + (selected.length > 20 ? "\n……共 " + selected.length + " 张" : "") + "\n\n此操作不可撤销。")) return;
				running.current = true; setBusy(true); setNotice("");
				try {
					const results = await deleteTavernCards(selected, path => rpc("deleteCard", { path }));
					const failed = results.filter(item => !item.ok);
					setPaths(failed.map(item => item.path));
					setNotice("已删除 " + (results.length - failed.length) + " 张" + (failed.length ? "，" + failed.length + " 张失败，可重试：" + failed.map(item => item.name + "：" + item.error).join("；") : "。"));
					await refresh();
					notifyTavernDataChanged(["cards", "sessions"], "cards");
				} catch (error) { setNotice(previous => previous + " 刷新失败：" + String(error && error.message || error)); }
				finally { running.current = false; setBusy(false); }
			}
			function toolbar(visible) {
				const h = React.createElement;
				return h("div", { className: "dsh-tavern-card-batch" },
					h("button", { className: "dsh-tavern-btn", disabled: busy, onClick: function () { setManaging(!managing); setPaths([]); setNotice(""); } }, managing ? "取消批量选择" : "批量管理"),
					managing ? h(React.Fragment, null,
						h("button", { className: "dsh-tavern-btn", disabled: busy || !visible.length, onClick: function () { setPaths(previous => Array.from(new Set(previous.concat(visible.map(card => card.path))))); } }, "全选当前列表"),
						h("button", { className: "dsh-tavern-btn", disabled: busy || !selected.length, onClick: function () { setPaths([]); } }, "清空选择"),
						h("span", { className: "dsh-tavern-card-batch-count" }, "已选 " + selected.length + " 张"),
						h("button", { className: "dsh-tavern-btn danger", disabled: busy || !selected.length, onClick: removeSelected }, busy ? "正在删除…" : "删除所选（" + selected.length + "）")) : null,
					notice ? h("div", { role: "status", className: "dsh-tavern-card-batch-notice" }, notice) : null);
			}
			function checkbox(card) {
				return managing ? React.createElement("input", {
					type: "checkbox",
					className: "dsh-tavern-card-batch-checkbox",
					checked: paths.includes(card.path),
					disabled: busy,
					"aria-label": "选择人物卡：" + card.name + "（" + card.path + "）",
					onClick: function (event) { event.stopPropagation(); },
					onChange: function () { toggle(card.path); }
				}) : null;
			}
			return { managing, toggle, toolbar, checkbox, isSelected, reset, paths, begin: function () { setManaging(true); setPaths([]); setNotice(""); } };
		}

		function tavernHistoryCardKey(item) {
			return item.cardPath ? "card:" + item.cardPath : "unbound:" + (item.chatId || item.sessionId);
		}

		function groupTavernHistory(history, summaries = {}) {
			function timestamp(value) { const n = Number(value); return Number.isFinite(n) ? n : (Date.parse(value) || 0); }
			function activity(item) { return Math.max(timestamp(item.lastOpenedAt), timestamp(item.updatedAt), timestamp(summaries[item.sessionId]?.updatedAt)); }
			const groups = new Map();
			for (const item of history.slice().sort((a, b) => activity(b) - activity(a))) {
				const key = tavernHistoryCardKey(item);
				if (!groups.has(key)) groups.set(key, { key, name: item.cardName || "未命名人物卡", path: item.cardPath || "", items: [] });
				groups.get(key).items.push(item);
			}
			return Array.from(groups.values());
		}

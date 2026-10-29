// 兼容垫层：为 tavern 客户端提供 0.2.0 已删除的会话 API 等价物。
//
// 0.1.5 的 ctx.sessions 提供 { list, current, open(), clear(), binding(id), scope(id) }；
// 0.2.0 只保留 { list, binding(id), scope(id), create(), fork() }，「当前会话」改为
// 主视图 retain（retainedBy.mainView）的推导属性，打开/关闭会话由 uiWorkspace 服务负责。
// tavern 侧栏、会话选择器、恢复模块都还在用旧形状，这里一次性补齐，避免散落的 typeof 兜底。

function mainSessionId(snapshot) {
	const items = Object.values((snapshot && snapshot.byId) || {});
	// 0.2.0：主视图 retain 的会话即「当前会话」（dsh-client-ui-workspace 的同一判据）。
	for (const row of items) {
		if (row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) return row.id;
	}
	// 回退：0.1.5 的快照带 current / selected 语义，老宿主直接沿用。
	if (snapshot && typeof snapshot.current === "string" && snapshot.current) return snapshot.current;
	return "";
}

function isBlankRow(row) {
	if (!row) return false;
	return row.blank === true;
}

// createSessionCompat(sessions) -> 兼容后的 sessions 视图
// 返回的新对象保留 list/binding/scope/create/fork/refresh 原样，并补回：
//   current    —— 主会话 id（0.1.5 语义，随列表快照推导）
//   open(id)   —— 切到某会话（0.2.0 用 uiWorkspace.openSession，缺失时退化为 retain）
//   clear()    —— 取消当前选择（0.2.0 用 uiWorkspace.clearMain）
function createSessionCompat(sessions, uiWorkspace) {
	if (!sessions || typeof sessions.list !== "object" || sessions.list === null) return sessions;
	const compat = {
		list: sessions.list,
		binding: sessions.binding ? sessions.binding.bind(sessions) : undefined,
		scope: sessions.scope ? sessions.scope.bind(sessions) : undefined,
		create: sessions.create ? sessions.create.bind(sessions) : undefined,
		fork: typeof sessions.fork === "function" ? sessions.fork.bind(sessions) : undefined,
		refresh: typeof sessions.refresh === "function" ? sessions.refresh.bind(sessions) : undefined,
		refreshSubagents: typeof sessions.refreshSubagents === "function" ? sessions.refreshSubagents.bind(sessions) : undefined,
		retain: typeof sessions.retain === "function" ? sessions.retain.bind(sessions) : undefined,
		subagentAddress: typeof sessions.subagentAddress === "function" ? sessions.subagentAddress.bind(sessions) : undefined,
	};

	Object.defineProperty(compat, "current", {
		enumerable: true,
		get: function () {
			const snapshot = sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
			return mainSessionId(snapshot);
		},
	});

	// 0.1.5 的 open() 同步返回；这里统一返回 Promise，调用点已 await。
	compat.open = function (sessionId) {
		const target = String(sessionId || "");
		if (!target) return compat.clear();
		if (uiWorkspace && typeof uiWorkspace.openSession === "function") {
			return Promise.resolve(uiWorkspace.openSession(target));
		}
		// 兜底：至少 retain 一次，让 summary+binding 两个就绪条件成立。
		// 未知会话的 sessions.retain 错误冒泡给 recovery 的 isUnknownSession 判定。
		if (typeof compat.retain === "function") {
			compat.retain(target, { source: "tavern" });
		}
		return Promise.resolve();
	};

	compat.clear = function () {
		if (uiWorkspace && typeof uiWorkspace.clearMain === "function") {
			return Promise.resolve(uiWorkspace.clearMain());
		}
		return Promise.resolve();
	};

	return compat;
}

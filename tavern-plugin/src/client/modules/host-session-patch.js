function evaluatePatchedSessionClient(source, require) {
	let exports
	const previous = window.__ModuleLoader__
	window.__ModuleLoader__ = {
		load: function (descriptor) {
			exports = descriptor.factory(require)
		}
	}
	try { (0, eval)(source) }
	finally { window.__ModuleLoader__ = previous }
	return exports
}

// RemoteJournalStream advances its durable cursor for every entry, but the UI
// must publish a whole algebra transaction at once. Keep the loaded window and
// replace it only at commit; all seqs remain present for host pagination/replay.
function installConversationPublicationGate(stream) {
	if (stream.__tavernAlgebraPublicationGate) return;
	if (!stream.options || typeof stream.options.publish !== "function") throw new Error("会话客户端缺少事务发布接口");
	const publish = stream.options.publish;
	let entries = [], page = {}, hasMore = false, pending = null;
	const tagOf = function (entry) {
		const event = entry && entry.event;
		const message = event && (event.type === "user/message" ? event.data : event.data && event.data.message);
		return message && message.source && message.source.conversationTransaction;
	};
	stream.options.publish = function (change) {
		if (change.type === "replace") {
			entries = change.entries.slice(); page = change.page; hasMore = change.hasMore;
			pending = null;
			const committed = new Set(entries.map(tagOf).filter(function (tag) { return tag && (tag.phase === "commit" || tag.phase === "begin-commit"); }).map(function (tag) { return tag.operationId; }));
			if (entries.some(function (entry) { const tag = tagOf(entry); return tag && tag.phase === "begin" && !committed.has(tag.operationId); })) throw new Error("拒绝发布未提交的会话快照");
			return publish(change);
		}
		if (change.type === "prepend") {
			entries = change.entries.concat(entries); hasMore = change.hasMore;
			if (!pending) return publish(change);
			return;
		}
		if (change.type === "notification") {
			if (pending) throw new Error("未提交事务中出现模型流，停止发布");
			return publish(change);
		}
		if (change.type !== "append") return publish(change);
		const tag = tagOf(change.entry);
		entries.push(change.entry);
		if (tag && tag.phase === "begin") {
			if (pending) throw new Error("会话事务交错");
			pending = tag.operationId;
		}
		if (!pending) return publish(change);
		if (tag && tag.operationId !== pending) throw new Error("会话事务标识不匹配");
		if (tag && tag.phase === "commit") {
			pending = null;
			// Omit stale projections/assistant-stream baselines: a fresh durable
			// window is folded by the host as one publication.
			page = { records: entries.slice(), hasMore: hasMore };
			return publish({ type: "replace", entries: entries.slice(), page: page, hasMore: hasMore });
		}
	};
	stream.__tavernAlgebraPublicationGate = true;
}

function installTavernSessionHistoryPatch(require, rpc) {
	let live
	try { live = require("@deepseek-ai/dsh-api-session-controller/client") }
	catch (error) {
		void Promise.resolve().then(function () { return rpc("confirmSessionPatch", { protocol: 1, installed: false, reason: "客户端没有拿到会话历史模块：" + (error && error.message || error) }); }).catch(function () {})
		return
	}
	const proto = live && live.SessionEventStream && live.SessionEventStream.prototype
	if (!proto || typeof proto.readPage !== "function" || typeof proto.follow !== "function") {
		void Promise.resolve().then(function () { return rpc("confirmSessionPatch", { protocol: 1, installed: false, reason: "客户端会话历史模块没有可安装的读取方法" }); }).catch(function () {})
		return
	}
	if (proto.__dshTavernSessionPatch) return
	const originalRead = proto.readPage
	const originalFollow = proto.follow
	let patched = null
	const ready = rpc("getSessionPatchStatus").then(function (result) {
		const patch = result && result.patch
		if (!patch || patch.status === "skipped" || patch.serverReady !== true) return null
		return rpc("getSessionPatchClient").then(function (client) {
			if (!client || !client.source) throw new Error(client && client.reason || "服务端没有提供会话历史补丁")
			const evaluated = evaluatePatchedSessionClient(client.source, require)
			if (!evaluated || !evaluated.SessionEventStream) throw new Error("会话历史补丁没有导出读取类")
			patched = evaluated.SessionEventStream.prototype
			return rpc("confirmSessionPatch", { protocol: 1, installed: true })
		})
	}).catch(function (error) {
		return rpc("confirmSessionPatch", { protocol: 1, installed: false, reason: String(error && error.message || error) }).catch(function () {})
	})
	proto.readPage = function () {
		const self = this
		const args = arguments
		return ready.then(function () {
			return (patched ? patched.readPage : originalRead).apply(self, args)
		})
	}
	proto.follow = async function* () {
		await ready
		installConversationPublicationGate(this)
		yield* (patched ? patched.follow : originalFollow).apply(this, arguments)
	}
	Object.defineProperty(proto, "__dshTavernSessionPatch", { value: true })
}

// The pinned host's human transcript deliberately renders append-origin input
// only. Tavern input edits are single-node surface replacements: project those
// into the original bubble, retaining its key, turn and presentation position.
function installTavernUserSurfaceView(require) {
	let conversation;
	try { conversation = require("@deepseek-ai/dsh-client-ui-conversation/client"); } catch (_) { return; }
	const proto = conversation && conversation.ConversationNodeAssembler && conversation.ConversationNodeAssembler.prototype;
	if (!proto || typeof proto.buildNode !== "function" || typeof proto.append !== "function" || typeof proto.replaceWindow !== "function" || typeof proto.markDirty !== "function" || proto.__tavernUserSurfaceView) return;
	const build = proto.buildNode, append = proto.append, replaceWindow = proto.replaceWindow;
	const caches = new WeakMap();
	function edits(assembler) {
		const cached = caches.get(assembler);
		if (cached && cached.size === assembler.inputs.size) return cached.values;
		const owners = new Map(), values = new Map();
		const events = Array.from(assembler.inputs.values(), function (record) { return record.event; }).sort(function (a, b) { return a.seq - b.seq; });
		for (const event of events) {
			const op = event.surfaceOp;
			if (op === "append" && event.type === "user/message" && event.data.source.kind === "user") owners.set(event.seq, event.seq);
			if (!op || op.op !== "replace" || op.startSeq !== op.endSeq || !owners.has(op.startSeq)) continue;
			const owner = owners.get(op.startSeq);
			owners.delete(op.startSeq);
			owners.set(event.seq, owner);
			if (event.type === "user/message" && event.data.source.kind === "user" && event.data.content.length > 0) values.set(owner, event.data);
		}
		caches.set(assembler, { size: assembler.inputs.size, values: values });
		return values;
	}
	proto.buildNode = function (context, target) {
		const node = build.call(this, context, target);
		if (!node || target !== "chat" || node.kind !== "user") return node;
		const replacement = edits(this).get(node.data.seq);
		if (!replacement) return node;
		return Object.assign({}, node, { data: Object.assign({}, node.data, { content: replacement.content, source: replacement.source }) });
	};
	proto.append = function (record) {
		const publication = append.call(this, record);
		const op = record.event.surfaceOp;
		if (!op || op.op !== "replace") return publication;
		// Replacement events do not match the host's input-message Definition,
		// so explicitly invalidate its existing bubbles for incremental delivery.
		for (const context of this.contextsByKind.get("input-message") || []) this.markDirty(context);
		return "immediate";
	};
	proto.replaceWindow = function () {
		caches.delete(this);
		return replaceWindow.apply(this, arguments);
	};
	Object.defineProperty(proto, "__tavernUserSurfaceView", { value: true });
}
installTavernUserSurfaceView(require);

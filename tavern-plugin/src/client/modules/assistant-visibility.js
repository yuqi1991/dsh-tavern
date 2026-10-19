// Empty append-origin rows Tavern wrote as conversation bookkeeping before
// ADR-0009 (branch metadata carriers, checkout and restoration placeholders).
// They carry no content; the host would render each as "context injection".
function tavernBookkeepingContext(data) {
	if (!data || data.kind !== "context" || !Array.isArray(data.content) || data.content.length !== 0) return false;
	const source = data.source || {};
	if (source.kind !== "plugin") return false;
	if (source.plugin === "dsh-tavern-surface-restore") return true;
	return source.plugin === "dsh-tavern" && (source.form === "conversation-metadata" || source.form === "checkout");
}

// DSH 0.1.5 may withdraw an already materialized assistant when a stream block
// becomes empty. Preserve its identity at the assembler boundary, before the
// core enforces monotonic node membership. React renderers cannot enforce this.
// The same boundary hides legacy bookkeeping rows instead of the DOM.
function installTavernAssistantVisibilityPatch(require) {
	let conversation;
	try { conversation = require("@deepseek-ai/dsh-client-ui-conversation/client"); }
	catch (_) { return; }
	const proto = conversation && conversation.ConversationNodeAssembler && conversation.ConversationNodeAssembler.prototype;
	if (!proto || typeof proto.buildNode !== "function" || proto.__dshTavernAssistantVisibility) return;
	const buildNode = proto.buildNode;
	proto.buildNode = function (context, target) {
		const node = buildNode.call(this, context, target);
		if (target === "chat" && node !== null && tavernBookkeepingContext(node.data)) return Object.assign({}, node, { visibility: "hidden" });
		if (target !== "chat" || context.kind !== "assistant-step") return node;
		if (node === null) {
			const previous = context.current.get(target);
			if (!previous) return null;
			return Object.assign({}, previous, { visibility: "hidden" });
		}
		const messageId = node.data && node.data.finalNode && node.data.finalNode.messageId;
		if (/^tavern-seed-trajectory:v1:.+:2$/.test(String(messageId || ""))) {
			return Object.assign({}, node, { visibility: "hidden" });
		}
		return node;
	};
	Object.defineProperty(proto, "__dshTavernAssistantVisibility", { value: true });
}

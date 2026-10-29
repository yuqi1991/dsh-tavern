// Story View: the Tavern conversation read one story floor at a time. Floors
// come from getStoryFloors (Chat); the reply being generated comes from the
// host Chat target's partial assistant. Native rows, native turns and
// bookkeeping never reach this view, so nothing here hides host DOM.
const STORY_VIEW_ID = "dsh-tavern:story";
const STORY_VIEW_FOLLOW_SLACK = 96;

const storyFloorStore = (function () {
	const states = new Map();
	const listeners = new Map();
	const requests = new Map();
	const empty = Object.freeze({ floors: [], hasMore: false, total: 0, loaded: false, loading: false, error: "" });
	function get(sessionId) { return states.get(sessionId) || empty; }
	function set(sessionId, patch) {
		states.set(sessionId, Object.assign({}, get(sessionId), patch));
		(listeners.get(sessionId) || []).forEach(function (listener) { listener(); });
	}
	function subscribe(sessionId, listener) {
		const set = listeners.get(sessionId) || new Set();
		set.add(listener); listeners.set(sessionId, set);
		return function () { set.delete(listener); };
	}
	// Each request supersedes older ones for the same session; a late reply
	// never overwrites floors a newer read already published.
	async function request(sessionId, args, merge) {
		const id = (requests.get(sessionId) || 0) + 1;
		requests.set(sessionId, id);
		set(sessionId, { loading: true, error: "" });
		try {
			const page = await rpc("getStoryFloors", args, sessionId);
			if (requests.get(sessionId) !== id) return;
			set(sessionId, { floors: merge(get(sessionId).floors, page.floors || []), hasMore: page.hasMore === true, total: Number(page.total) || 0, loaded: true, loading: false, revision: page.revision });
		} catch (error) {
			if (requests.get(sessionId) === id) set(sessionId, { loading: false, error: String(error && error.message || error) });
		}
	}
	function loadLatest(sessionId) {
		return request(sessionId, {}, function (_previous, floors) { return floors; });
	}
	// Refresh everything from the oldest loaded floor so earlier pages stay.
	function refresh(sessionId) {
		const floors = get(sessionId).floors;
		if (!floors.length) return loadLatest(sessionId);
		const from = floors[0].turn;
		return request(sessionId, { from: from }, function (previous, next) {
			return previous.filter(function (floor) { return floor.turn < from; }).concat(next);
		});
	}
	function loadOlder(sessionId) {
		const floors = get(sessionId).floors;
		if (!floors.length) return loadLatest(sessionId);
		const before = floors[0].turn;
		return request(sessionId, { before: before }, function (previous, older) {
			return older.filter(function (floor) { return floor.turn < before; }).concat(previous);
		});
	}
	return Object.freeze({ get: get, subscribe: subscribe, loadLatest: loadLatest, refresh: refresh, loadOlder: loadOlder });
})();

function useStoryFloors(sessionId) {
	const subscribe = React.useCallback(function (notify) { return storyFloorStore.subscribe(sessionId, notify); }, [sessionId]);
	const snapshot = React.useCallback(function () { return storyFloorStore.get(sessionId); }, [sessionId]);
	return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

// The host shell picks a persisted view, else Chat. Tavern play sessions open
// the story view by default: the preference is written before first binding,
// and only while the player has never chosen a view for that session.
function preferStoryView(sessionId) {
	const key = "dsh.conversation." + sessionId;
	try {
		const raw = window.localStorage.getItem(key);
		const stored = raw ? JSON.parse(raw) : null;
		if (stored && typeof stored === "object" && typeof stored.view === "string") return;
		window.localStorage.setItem(key, JSON.stringify(Object.assign({ draft: "", viewRequest: null }, stored && typeof stored === "object" ? stored : {}, { view: STORY_VIEW_ID })));
	} catch (_) { }
}

function TavernStoryImages(props) {
	const [urls, setUrls] = React.useState([]);
	const attachments = props.images.map(function (image) { return image.attachment; });
	const key = JSON.stringify(attachments);
	React.useEffect(function () {
		let active = true;
		if (!props.uiConversation || typeof props.uiConversation.imageUrl !== "function") return;
		Promise.all(attachments.map(function (attachment) { return Promise.resolve(props.uiConversation.imageUrl(props.sessionId, attachment)).catch(function () { return ""; }); }))
			.then(function (next) { if (active) setUrls(next); });
		return function () { active = false; };
	}, [props.sessionId, key]);
	if (!attachments.length) return null;
	return React.createElement("div", { className: "dsh-tavern-story-images", "data-align": props.align || "end" },
		urls.filter(Boolean).map(function (url, index) { return React.createElement("img", { key: index, src: url, alt: "图片附件", loading: "lazy" }); }));
}

function TavernStoryCopy(props) {
	const [copied, setCopied] = React.useState(false);
	return React.createElement(DshUi.Tooltip, { label: copied ? "已复制" : "复制", side: "bottom" },
		React.createElement("button", { type: "button", className: "dsh-tavern-story-icon", "aria-label": copied ? "已复制" : "复制", onClick: function () {
			DshUi.writeClipboard(props.text).then(function (ok) { if (!ok) return; setCopied(true); window.setTimeout(function () { setCopied(false); }, 1000); });
		} }, React.createElement(copied ? DshUi.IconCheckOutlineRegular : DshUi.IconCopyOutlineRegular, null)));
}

function TavernStoryInput(props) {
	const h = React.createElement;
	const input = props.input;
	const images = (input.attachments || []).filter(function (block) { return block && block.type === "image" && block.attachment !== undefined; });
	return h("div", { className: "dsh-tavern-user-row" },
		h("div", { className: "dsh-tavern-user-stack" },
			images.length ? h(TavernStoryImages, { images: images, sessionId: props.sessionId, uiConversation: props.uiConversation, align: "end" }) : null,
			input.text !== "" || input.templateDisplay ? h("div", { className: "dsh-tavern-user-bubble" }, input.templateDisplay
				? h(TavernMessageFrame, { content: input.templateDisplay, sessionId: props.sessionId, turn: props.turn, partIndex: "user-template", eager: true })
				: h("div", { style: { whiteSpace: "pre-wrap" } }, input.text)) : null),
		input.text !== "" ? h("div", { className: "dsh-tavern-user-actions" }, h(TavernStoryCopy, { text: input.text })) : null);
}

function TavernStoryForkAction(props) {
	const [forking, setForking] = React.useState(false);
	async function fork() {
		if (forking) return;
		setForking(true);
		try { await tavernConversationForkRequests.request({ sessionId: props.sessionId, turn: props.turn }); }
		catch (error) { tavernErrorHub.report("分叉对话", error); }
		finally { setForking(false); }
	}
	return React.createElement(DshUi.Tooltip, { label: forking ? "正在分叉…" : "从这一轮分叉", side: "bottom" },
		React.createElement("button", { type: "button", className: "dsh-tavern-story-icon", "aria-label": "从这一轮分叉", disabled: forking, onClick: fork },
			React.createElement(DshUi.IconBranchOutlineRegular, null)));
}

function TavernStoryFloor(props) {
	const h = React.createElement;
	const floor = props.floor;
	const view = props.view || {};
	const SceneIllustration = assistantRendererFeature.SceneIllustration;
	// Render depth: only the latest rounds run a card's HTML interface (heavy status bars).
	const displayPrefs = React.useSyncExternalStore(displayPreferences.subscribe, displayPreferences.snapshot, displayPreferences.snapshot);
	const [renderRound, setRenderRound] = React.useState(false);
	const renderDepth = displayPrefs && Number.isSafeInteger(displayPrefs.renderDepth) ? displayPrefs.renderDepth : 3;
	const deferHtml = !renderRound && !props.liveBody && renderDepth > 0 && !floor.greeting && props.latestTurn - floor.turn >= renderDepth ? function () { setRenderRound(true); } : null;
	const body = props.liveBody || (floor.body ? renderTavernProjection(floor.body, {
		deferHtml: deferHtml,
		streaming: false, codeLabels: { copyLabel: "复制", copiedLabel: "已复制" }, sessionId: props.sessionId, turn: floor.turn,
		helperContext: view.tavernHelper, trustedCardMode: Boolean(view.tavernRuntimePolicy && view.tavernRuntimePolicy.trustedCardMode),
		eagerFrame: props.latest, executeSlash: props.executeSlash
	}) : null);
	const settled = !props.liveBody && floor.body;
	const receipt = settled && floor.receipt ? floor.receipt.receipt || null : null;
	const sceneImages = settled && !floor.greeting && view.releaseCapabilities && view.releaseCapabilities.sceneImages;
	// One read serves the picture, the extra pictures of this turn and the "add" button.
	const sceneRecord = useSceneImageRecord(sceneImages ? props.sessionId : null, floor.turn);
	const sceneExtras = sceneImages && sceneRecord && sceneRecord.extras || [];
	const canAddPicture = Boolean(sceneRecord && sceneRecord.maxPictures && sceneExtras.length + 1 < sceneRecord.maxPictures);
	return h("article", { className: "dsh-tavern-story-floor", "data-story-turn": floor.turn },
		floor.input ? h(TavernStoryInput, { input: floor.input, turn: floor.turn, sessionId: props.sessionId, uiConversation: props.uiConversation }) : null,
		body ? h("div", { className: "dsh-tavern-assistant", "data-streaming": props.streaming || undefined }, body,
			sceneImages ? h(SceneIllustration, { key: props.sessionId + ":" + floor.turn, sessionId: props.sessionId, turn: floor.turn, record: sceneRecord, canAdd: canAddPicture }) : null,
			// Added pictures follow the text, in the order they were made.
			sceneExtras.map(function (extra) { return h(SceneIllustration, { key: props.sessionId + ":" + floor.turn + ":slot:" + extra.slot, sessionId: props.sessionId, turn: floor.turn, record: extra, canAdd: canAddPicture }); }),
			receipt ? h(TavernMvuReceipt, { receipt: receipt, sessionId: props.sessionId, turn: floor.turn, latest: floor.turn === view.settlementTurn, busy: Boolean(view.activity && view.activity.busy) }) : null,
			settled && props.latest && view.statusBarPlacement === "body" ? h(TavernPersistentStatusRuntime, { sessionId: props.sessionId, view: view, executeSlash: props.executeSlash }) : null) : null,
		settled ? h("div", { className: "dsh-tavern-story-actions" },
			h(TavernStoryCopy, { text: floor.body.text }),
			!floor.greeting ? h(TavernStoryForkAction, { sessionId: props.sessionId, turn: floor.turn }) : null,
			sceneImages ? h(SceneImageAction, { key: props.sessionId + ":" + floor.turn, sessionId: props.sessionId, turn: floor.turn }) : null,
			props.latest && props.hostProps ? h(TavernVariantSwitcher, props.hostProps) : null) : null,
		props.children);
}

function TavernStoryFailedTurn(props) {
	const h = React.createElement;
	const [busy, setBusy] = React.useState(false);
	const view = props.view;
	const error = view.foregroundError && view.foregroundError.message || "本轮正文生成失败。";
	async function replay() {
		if (busy) return;
		setBusy(true);
		try { await submitFailedTurnReplay(props.sessionId); }
		catch (caught) { tavernErrorHub.report("重新生成本轮", caught); }
		finally { setBusy(false); liveTavernView.invalidate(props.sessionId); }
	}
	async function dismiss() {
		if (busy) return;
		setBusy(true);
		try {
			const result = await rpc("setFailedErrorVisibility", { sessionId: props.sessionId, turn: view.replayFailedTurn, hidden: true });
			liveTavernView.setView(props.sessionId, result.view);
		} catch (caught) { tavernErrorHub.report("隐藏错误提示", caught); }
		finally { setBusy(false); }
	}
	return h("div", { className: "dsh-tavern-story-error", role: "alert" },
		h("p", null, error.length > 600 ? error.slice(0, 600) + "…" : error),
		h("div", { className: "dsh-tavern-story-error-actions" },
			h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, title: "移除被中断的回复，并原样重发本轮请求（复用模型缓存）", onClick: replay }, busy ? "处理中…" : "重新生成本轮"),
			h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: dismiss }, "隐藏此错误")));
}

function TavernStoryView(props) {
	const h = React.createElement;
	const sessionId = props.sessionId;
	const running = props.useSession(function (snapshot) { return snapshot.running === true; });
	const partial = props.useChat(function (snapshot) { return snapshot.legacy.partial; });
	const live = useLiveTavernView(sessionId, "story:" + String(running));
	const view = live.view;
	const story = useStoryFloors(sessionId);
	const transitioning = React.useSyncExternalStore(tavernSessionTransition.subscribe, tavernSessionTransition.getSnapshot, tavernSessionTransition.getSnapshot);
	const root = React.useRef(null);
	const follow = React.useRef(true);
	const anchor = React.useRef(null);
	// The last streamed blocks stay until the refreshed floors carry the reply.
	const [lingering, setLingering] = React.useState(null);
	const lastBlocks = React.useRef(null);
	const rerolling = React.useRef(false);
	if (partial && Array.isArray(partial.blocks)) lastBlocks.current = partial.blocks;
	if (running && view) rerolling.current = view.regenerating === true;
	const subagent = props.storySessions && typeof props.storySessions.subagentAddress === "function" && props.storySessions.subagentAddress(sessionId);
	const notStory = Boolean(subagent) || Boolean(view && !isPlayMode(view.mode));
	React.useEffect(function () { if (notStory && typeof props.openView === "function") props.openView("chat"); }, [notStory]);
	React.useEffect(function () { if (!storyFloorStore.get(sessionId).loaded) storyFloorStore.loadLatest(sessionId); }, [sessionId]);
	// Any published view change may move floors (reroll, switch, rollback, edit,
	// settlement); one coalesced refresh rereads the loaded range.
	React.useEffect(function () {
		if (!view) return;
		const timer = window.setTimeout(function () { storyFloorStore.refresh(sessionId); }, 120);
		return function () { window.clearTimeout(timer); };
	}, [sessionId, view]);
	React.useEffect(function () {
		if (running) { setLingering(null); return; }
		if (lastBlocks.current) { setLingering({ blocks: lastBlocks.current, revision: story.revision, rerolled: rerolling.current }); lastBlocks.current = null; }
	}, [running]);
	React.useEffect(function () {
		if (!lingering) return;
		if (story.revision !== lingering.revision) { setLingering(null); return; }
		const timer = window.setTimeout(function () { setLingering(null); }, 15000);
		return function () { window.clearTimeout(timer); };
	}, [story.revision, lingering]);
	// Scrolling belongs to the shell's conversation scroller; stick to the
	// bottom while the reader is there, and keep position when older floors load.
	React.useEffect(function () {
		const scroller = root.current && root.current.closest("[data-conversation-scroll]");
		if (!scroller) return;
		// Only the reader's own scrolling decides whether to follow; layout
		// growth and shell scroll restoration must not unstick the tail.
		let touched = 0;
		function onInput() { touched = Date.now(); }
		function onScroll() {
			if (Date.now() - touched > 1000) return;
			follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STORY_VIEW_FOLLOW_SLACK;
		}
		const observer = new ResizeObserver(function () { if (follow.current) scroller.scrollTop = scroller.scrollHeight; });
		observer.observe(root.current);
		const inputs = ["wheel", "touchmove", "keydown", "pointerdown"];
		inputs.forEach(function (type) { scroller.addEventListener(type, onInput, { passive: true }); });
		scroller.addEventListener("scroll", onScroll, { passive: true });
		follow.current = true;
		scroller.scrollTop = scroller.scrollHeight;
		return function () {
			observer.disconnect();
			inputs.forEach(function (type) { scroller.removeEventListener(type, onInput); });
			scroller.removeEventListener("scroll", onScroll);
		};
	}, [sessionId]);
	React.useLayoutEffect(function () {
		const scroller = root.current && root.current.closest("[data-conversation-scroll]");
		if (scroller && follow.current) scroller.scrollTop = scroller.scrollHeight;
	}, [story.floors, partial]);
	const firstTurn = story.floors.length ? story.floors[0].turn : 0;
	React.useLayoutEffect(function () {
		const scroller = root.current && root.current.closest("[data-conversation-scroll]");
		const previous = anchor.current;
		anchor.current = null;
		if (!scroller || !previous || previous.turn === firstTurn) return;
		scroller.scrollTop = previous.top + (scroller.scrollHeight - previous.height);
	}, [firstTurn]);
	function loadOlder() {
		const scroller = root.current && root.current.closest("[data-conversation-scroll]");
		if (scroller) anchor.current = { turn: firstTurn, top: scroller.scrollTop, height: scroller.scrollHeight };
		follow.current = false;
		storyFloorStore.loadOlder(sessionId);
	}
	if (notStory) return h("section", { className: "dsh-tavern-story", ref: root, "data-session-id": sessionId }, h("p", { className: "dsh-tavern-story-hint" }, "这个会话不是游玩会话，请使用对话页。"));
	const floors = story.floors.filter(function (floor) { return !floor.open; });
	const latestFloor = floors[floors.length - 1];
	const viewState = view || {};
	const regenerating = running ? viewState.regenerating === true : Boolean(lingering && lingering.rerolled);
	const streamingBlocks = running ? (partial && partial.blocks) || [] : lingering && lingering.blocks;
	const liveBody = streamingBlocks ? renderTavernAssistantBlocks({
		blocks: streamingBlocks, streaming: running, projection: null, sessionId: sessionId, turn: 0,
		helperContext: viewState.tavernHelper, executeSlash: props.executeSlash,
		renderMessageImages: function (input) { return h(TavernStoryImages, { images: input.images, sessionId: sessionId, uiConversation: props.uiConversation, align: input.align }); }
	}) : null;
	const generating = running && !(liveBody && liveBody.length) ? h("div", { className: "dsh-tavern-story-status", role: "status" }, "正在生成…") : null;
	const failed = !running && !lingering && viewState.canReplayFailedTurn === true && !(viewState.hiddenDshErrorTurns || []).map(Number).includes(Number(viewState.replayFailedTurn));
	const pendingInput = viewState.latestInput && (running || failed || lingering) && !regenerating ? { text: String(viewState.latestInput.text || "") } : null;
	return h("section", { className: "dsh-tavern-story", ref: root, "data-session-id": sessionId },
		story.hasMore ? h("div", { className: "dsh-tavern-story-older" }, h("button", { type: "button", disabled: story.loading, onClick: loadOlder }, story.loading ? "加载中…" : "加载更早")) : null,
		!story.loaded && story.loading ? h("p", { className: "dsh-tavern-story-hint", role: "status" }, "正在加载剧情…") : null,
		story.error ? h("p", { className: "dsh-tavern-story-hint", role: "alert" }, "剧情加载失败：" + story.error, " ", h("button", { type: "button", className: "dsh-tavern-btn", onClick: function () { storyFloorStore.refresh(sessionId); } }, "重试")) : null,
		transitioning ? h("div", { className: "dsh-tavern-session-switching", role: "status" }, "正在完成游戏初始化…") : null,
		floors.map(function (floor) {
			const isLatest = floor === latestFloor;
			const replaced = isLatest && regenerating;
			return h(TavernStoryFloor, {
				key: floor.turn, floor: floor, view: view, latest: isLatest, latestTurn: latestFloor.turn, sessionId: sessionId,
				executeSlash: props.executeSlash, uiConversation: props.uiConversation, hostProps: isLatest ? props : null,
				liveBody: replaced && liveBody && liveBody.length ? liveBody : null, streaming: replaced && running
			}, replaced ? generating : null);
		}),
		failed || pendingInput || (!regenerating && (liveBody && liveBody.length || generating)) ? h("article", { className: "dsh-tavern-story-floor", "data-story-turn": "live" },
			pendingInput ? h(TavernStoryInput, { input: pendingInput, turn: 0, sessionId: sessionId, uiConversation: props.uiConversation }) : null,
			!regenerating && liveBody && liveBody.length ? h("div", { className: "dsh-tavern-assistant", "data-streaming": running || undefined }, liveBody) : null,
			!regenerating ? generating : null,
			failed ? h(TavernStoryFailedTurn, { sessionId: sessionId, view: viewState }) : null) : null);
}

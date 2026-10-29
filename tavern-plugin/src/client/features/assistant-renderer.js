		function createTavernFrameSlashExecutor(ctx, hostWindow) {
			hostWindow = hostWindow || window;
			// The live composer draft of a session, for native #send_textarea
			// scripts that append to what the player already typed.
			function readInputDraft(sessionId) {
				const actx = ctx.sessions.scope(sessionId);
				const conversation = ctx.get("conversation");
				if (!actx || !conversation) return "";
				try {
					const state = conversation.input.for(actx).state;
					const snapshot = state && typeof state.getSnapshot === "function" ? state.getSnapshot() : null;
					if (snapshot && typeof snapshot.draft === "string") return snapshot.draft;
				} catch (_) {}
				return "";
			}
			const execute = function (line, sessionId, options) {
				if (/^\/ejs(?:-refresh)?(?:\s|$)/.test(String(line))) return rpc("executeFullTemplateCommand", { text: line }, sessionId).then(function (result) { return result.pipe; });
				const draftMatch = /^\/setinput(?: ([\s\S]*))?$/.exec(String(line || ""));
                // Preflight before touching the composer: otherwise the greedy
                // send match silently includes unsupported commands in the draft.
                const pipes = draftMatch ? [] : Array.from(String(line || "").matchAll(/\|\s*(\/[\w-]+)/g));
                const unsupported = pipes.find((part, index) => part[1] !== "/trigger" || index !== pipes.length - 1);
                if (!draftMatch && (/^\/cut(?:\s|$)/.test(String(line)) || unsupported || (pipes.length && !/^\/send\s/.test(String(line))))) {
                    const command = unsupported ? unsupported[1] : /^\/cut(?:\s|$)/.test(String(line)) ? "/cut" : pipes[0][1];
                    const error = new Error("暂不支持人物卡命令管道中的 " + command + "，未发送消息。当前支持 /send … | /trigger；/cut 删除楼层尚未实现。");
                    error.code = "UNSUPPORTED_SLASH_PIPELINE";
                    return Promise.reject(error);
                }
				const match = /^\/send\s+([\s\S]+)\|\s*\/trigger\s*$/.exec(String(line || ""));
				const triggerOnly = /^\/trigger\s*$/.test(String(line || ""));
				if (!draftMatch && !triggerOnly && (!match || !match[1].trim())) {
                    if (!ctx.remote?.commands?.execute) return Promise.reject(new Error("当前酒馆没有注册这条命令"));
                    return ctx.remote.commands.execute(sessionId, String(line), []).then(function (execution) {
                        if (!execution) throw new Error("当前酒馆没有注册这条命令");
                        if (execution.result?.kind === "error") throw new Error(execution.result.text || "命令执行失败");
                        return String(execution.result?.text || "");
                    });
                }
				const actx = ctx.sessions.scope(sessionId);
				const conversation = ctx.get("conversation");
				if (!actx || !conversation) return Promise.reject(new Error("当前对话输入框不可用"));
				const input = conversation.input.for(actx);
				if (draftMatch) { input.setDraft(draftMatch[1] || ""); return Promise.resolve({ drafted: true }); }
				const binding = triggerOnly && ctx.sessions.binding(sessionId);
                // DSH requires nonempty prompt content. Helper messages are already
                // persisted; admit a continuation without resending them or touching the draft.
                const triggerContent = [{ type: "text", text: "继续。" }];
                // Template execution owns the generation queue; waiting here would deadlock it.
                if (options?.waitForCompletion === false) {
                	if (triggerOnly) return Promise.resolve(binding.session.prompt(triggerContent, "queue")).then(function (result) {
                        if (!result?.ok) throw new Error(result?.error?.message || "生成提交失败");
                        return { submitted: true };
                    });
                    input.setDraft(match[1]);
                    return Promise.resolve(input.submit("queue")).then(function () { return { submitted: true }; });
                }
				const sessions = ctx.sessions.list;
				return new Promise(function (resolve, reject) {
					let observedRun = false;
					let settled = false;
					let stop = function () { };
					let timer = null;
					function finish(error) {
						if (settled) return;
						settled = true;
						hostWindow.clearTimeout(timer);
						stop();
						if (error) reject(error); else resolve({ submitted: true });
					}
					function inspect() {
						const summary = sessions.getSnapshot().byId[sessionId];
						if (!summary) { finish(new Error("当前对话已关闭")); return; }
						if (summary.running === true) observedRun = true;
						else if (observedRun) finish();
					}
					stop = sessions.subscribe(inspect);
					timer = hostWindow.setTimeout(function () { finish(new Error("等待开局生成完成超时")); }, 15 * 60 * 1000);
					try {
						if (triggerOnly) {
							// Helper messages are already persisted and projected into the next request.
							Promise.resolve(binding.session.prompt(triggerContent, "queue")).then(function (result) {
								if (!result || !result.ok) finish(new Error(result && result.error && result.error.message || "开局生成提交失败"));
							}, finish);
						} else {
							input.setDraft(match[1]);
							input.submit("queue");
						}
						inspect();
					} catch (error) { finish(error); }
				});
			};
			execute.readInput = readInputDraft;
			return execute;
		}

		const tavernSessionTransition = (function () {
			let active = null;
			const listeners = new Set();
			function publish(next) {
				if (active === next) return;
				active = next;
				listeners.forEach(function (listener) { listener(); });
			}
			return {
				begin: function (preview) { publish(preview && typeof preview === "object" ? preview : {}); },
				end: function () { publish(null); },
				getSnapshot: function () { return active; },
				subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; }
			};
		})();

		const tavernConversationForkRequests = (function () {
			let handler = null;
			return Object.freeze({
				bind: function (next) {
					handler = next;
					return function () { if (handler === next) handler = null; };
				},
				request: function (input) {
					if (typeof handler !== "function") return Promise.reject(new Error("分叉功能尚未就绪，请刷新页面后重试"));
					return Promise.resolve(handler(input));
				}
			});
		})();

		// The plan behind a picture, for judging whether the Agent's staging or the image model fell short.
		function sceneImagePlanDetails(version, onEditPrompt) {
			if (!version || !(version.prompt || version.composition || version.description)) return null;
			const details = document.createElement("details");
			details.className = "dsh-tavern-image-plan";
			const summary = document.createElement("summary");
			summary.textContent = "画面方案";
			details.append(summary);
			[["画面", version.description], ["时刻", version.moment === "earlier" ? "本轮中间的瞬间" : "本轮结尾"], ["构图", version.composition], ["画风", version.style], ["提示词", version.prompt]].forEach(function (row) {
				if (!row[1]) return;
				const label = document.createElement("dt");
				label.textContent = row[0];
				const value = document.createElement("dd");
				value.textContent = row[1];
				details.append(label, value);
			});
			if (version.planPrompt && onEditPrompt) {
				const edit = document.createElement("button");
				edit.type = "button";
				edit.className = "dsh-tavern-image-plan-edit";
				edit.textContent = "改提示词重画";
				edit.addEventListener("click", onEditPrompt);
				details.append(edit);
			}
			details.addEventListener("click", function (event) { event.stopPropagation(); });
			return details;
		}

		// gallery: { urls, index } pages through several pictures with ‹ › and the arrow keys.
		function openSceneImagePreview(url, opener, version, onEditPrompt, gallery, label) {
			const dialog = document.createElement("dialog");
			// A labelled picture (an avatar) is shown at a moderate size, not stretched to the screen.
			dialog.className = "dsh-tavern-image-preview" + (label ? " is-compact" : "");
			dialog.setAttribute("aria-label", (label || "场景插画") + "预览");
			const close = document.createElement("button");
			close.type = "button";
			close.textContent = "缩小并返回 ×";
			close.setAttribute("aria-label", "缩小并返回");
			const image = document.createElement("img");
			image.src = url;
			image.alt = "放大的" + (label || "场景插画");
			// An avatar grows out of the one clicked and shrinks back into it when closed.
			const grow = Boolean(label && opener && typeof image.animate === "function" && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches));
			function origin() {
				const from = opener.getBoundingClientRect(), to = image.getBoundingClientRect();
				if (!from.width || !to.width) return "";
				return "translate(" + (from.left + from.width / 2 - to.left - to.width / 2) + "px, " + (from.top + from.height / 2 - to.top - to.height / 2) + "px) scale(" + from.width / to.width + ")";
			}
			function dismiss() {
				const start = grow && opener.isConnected && !dialog.dataset.closing ? origin() : "";
				if (!start) { dialog.close(); return; }
				dialog.dataset.closing = "1";
				// The timer closes it even where animations do not run (a hidden tab).
				const done = function () { if (dialog.open) dialog.close(); };
				image.animate([{ transform: "none", opacity: 1 }, { transform: start, opacity: 0.4 }], { duration: 180, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" }).finished.then(done, done);
				window.setTimeout(done, 240);
			}
			if (grow) {
				dialog.addEventListener("cancel", function (event) { event.preventDefault(); dismiss(); });
				const play = function () { const start = origin(); if (start) image.animate([{ transform: start, opacity: 0.4 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)" }); };
				image.addEventListener("load", play, { once: true });
			}
			close.addEventListener("click", dismiss);
			dialog.addEventListener("click", function (event) { if (event.target === dialog) dismiss(); });
			dialog.addEventListener("close", function () { dialog.remove(); if (opener && opener.isConnected) opener.focus(); }, { once: true });
			dialog.append(close, image);
			const urls = gallery && gallery.urls || [];
			if (urls.length > 1) {
				let at = Math.max(0, Math.min(urls.length - 1, Number(gallery.index) || 0));
				const counter = document.createElement("span");
				counter.className = "dsh-tavern-image-preview-counter";
				const pager = ["‹", "›"].map(function (text, side) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = text;
					button.className = "dsh-tavern-image-preview-page";
					button.dataset.side = side ? "next" : "prev";
					button.setAttribute("aria-label", side ? "下一张" : "上一张");
					button.addEventListener("click", function () { step(side ? 1 : -1); });
					return button;
				});
				function show() {
					image.src = urls[at];
					counter.textContent = (at + 1) + " / " + urls.length;
					pager[0].disabled = at === 0; pager[1].disabled = at === urls.length - 1;
				}
				function step(delta) { if (urls[at + delta]) { at += delta; show(); } }
				dialog.addEventListener("keydown", function (event) {
					if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); }
				});
				dialog.append(counter, pager[0], pager[1]);
				show();
			}
			const plan = sceneImagePlanDetails(version, onEditPrompt && function () { dialog.close(); onEditPrompt(); });
			if (plan) dialog.append(plan);
			document.body.append(dialog);
			dialog.showModal();
			close.focus();
		}

		function createTavernAssistantRendererFeatureModule() {
			function SceneImagePending(props) {
				const state = props.state;
				const [now, setNow] = React.useState(Date.now());
				React.useEffect(function () { const timer = window.setInterval(function () { setNow(Date.now()); }, 1000); return function () { window.clearInterval(timer); }; }, []);
				const started = Number(state.createdAt) || 0;
				const seconds = started ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
				const elapsed = started ? (seconds >= 60 ? Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒" : seconds + " 秒") : "";
				const cancelling = Boolean(state.cancelRequestedAt);
				const line = React.createElement("div", { className: "dsh-tavern-image-pending-line", role: "status" },
					React.createElement("span", { className: "dsh-tavern-image-pending-spinner", "aria-hidden": true }),
					React.createElement("span", null, sceneImageStageLabel(state)),
					elapsed ? React.createElement("span", { className: "dsh-tavern-image-pending-time" }, elapsed) : null,
					React.createElement("button", { type: "button", className: "dsh-tavern-image-pending-cancel", disabled: props.disabled || cancelling, onClick: props.onCancel }, cancelling ? "正在取消…" : "取消"));
				return props.picture ? React.createElement("div", { className: "dsh-tavern-image-pending" },
					React.createElement("div", { className: "dsh-tavern-image-pending-frame", "aria-hidden": true }), line) : line;
			}
			function SceneIllustration(props) {
            const askConfirm = useTavernConfirm(props.sessionId || props.scope?.sessionId);
				// The message view may already read the record (to place the picture); reuse it.
				const fetchedState = useSceneImageRecord(props.record === undefined ? props.sessionId : null, props.turn);
				const state = props.record === undefined ? fetchedState : props.record;
				const [error, setError] = React.useState("");
				const [selected, setSelected] = React.useState("");
			const [refreshes, setRefreshes] = React.useState({});
				const [busy, setBusy] = React.useState(false);
				const [adjusting, setAdjusting] = React.useState(false);
				const [instruction, setInstruction] = React.useState("");
				const [promptDraft, setPromptDraft] = React.useState(null);
				const [referenceDraft, setReferenceDraft] = React.useState(null);
				const [addDraft, setAddDraft] = React.useState(null);
				const requestRef = React.useRef(null);
				const addRequestRef = React.useRef(null);
				const versions = state && state.versions || [];
				const version = versions.find(function (item) { return item.id === selected; }) || versions[versions.length - 1];
				const index = version ? versions.findIndex(function (item) { return item.id === version.id; }) : -1;
				const lastId = versions.length ? versions[versions.length - 1].id : "";
				React.useEffect(function () { setSelected(lastId); setError(""); }, [lastId]);
				React.useEffect(function () {
					if (state && ["failed", "cancelled"].includes(state.status) && state.kind === "adjust" && state.instruction) {
						setSelected(state.baseVersionId); setInstruction(state.instruction); setAdjusting(true);
					}
					if (state && ["failed", "cancelled"].includes(state.status) && state.kind === "prompt" && state.instruction) {
						setSelected(state.baseVersionId); setPromptDraft(state.instruction); setAdjusting(false);
					}
				}, [state && state.requestId, state && state.status]);
				function notify() { window.dispatchEvent(new CustomEvent("dsh-tavern-image-changed", { detail: { sessionId: props.sessionId } })); }
				async function retrySave() {
					if (busy || !state || state.status === "running") return;
					setBusy(true); setError("");
					try { await rpc("retrySceneImageSave", { turn: props.turn, key: state.key, requestId: state.requestId }, props.sessionId); }
					catch (e) { setError(String(e.message || e)); }
					finally { setBusy(false); notify(); }
				}
				async function cancelImage() {
					if (busy || !state || state.status !== "running" || state.cancelRequestedAt) return;
					setBusy(true); setError("");
					try { await rpc("cancelSceneImage", { turn: props.turn, key: state.key, requestId: state.requestId }, props.sessionId); }
					catch (e) { setError(String(e.message || e)); }
					finally { setBusy(false); notify(); }
				}
				async function generate(kind) {
				const text = kind === "prompt" ? (promptDraft || "").trim() : instruction;
				const reusable = requestRef.current && !(state && requestRef.current.id === state.requestId && ["failed", "cancelled", "idle"].includes(state.status));
				const clickId = reusable && requestRef.current.signature === kind + ":" + (version && version.id) + ":" + text ? requestRef.current.id : sceneImageRequestId();
				recordImageInteraction(props.sessionId, props.turn, clickId, "click");
					if ((!version && kind !== "generate") || busy || state.status === "running" || state.recovery === "save") { recordImageInteraction(props.sessionId, props.turn, clickId, "blocked", "busy-or-existing"); return; }
					const confirmNewRequestId = await sceneImagePurchaseConfirmation(state, askConfirm);
					if (confirmNewRequestId === false) { recordImageInteraction(props.sessionId, props.turn, clickId, "cancelled", "confirmation"); return; }
					if (requestRef.current && requestRef.current.id === state.requestId && ["failed", "cancelled", "idle"].includes(state.status)) requestRef.current = null;
					setBusy(true); setError("");
					const signature = kind + ":" + (version && version.id) + ":" + text;
					if (!requestRef.current || requestRef.current.signature !== signature) requestRef.current = { signature: signature, id: clickId };
					try {
						await rpc("generateSceneImage", { turn: props.turn, key: state.key, kind: kind, versionId: version && version.id, instruction: kind === "adjust" ? instruction : "", prompt: kind === "prompt" ? text : "", requestId: requestRef.current.id, confirmNewRequestId: confirmNewRequestId }, props.sessionId);
						requestRef.current = null; setAdjusting(false); setInstruction(""); setPromptDraft(null);
					} catch (e) { setError(String(e.message || e)); }
					finally { setBusy(false); notify(); }
				}
				async function removeImage() {
					if (!version || locked || !await askConfirm("删除这张图片？删除后可以重新生成。")) return;
					setBusy(true); setError("");
					try {
						await rpc("removeSceneImage", { turn: props.turn, key: state.key, versionId: version.id }, props.sessionId);
						setSelected(""); setAdjusting(false); setReferenceDraft(null); setInstruction(""); requestRef.current = null;
					} catch (e) { setError(String(e.message || e)); }
					finally { setBusy(false); notify(); }
				}
				// A further picture of this turn: the plan Agent picks a different moment,
				// following the optional wish. It appears in its own slot below.
				async function addPicture() {
					if (busy || !state || !state.enabled) return;
					const text = (addDraft || "").trim();
					const signature = state.key + ":" + text;
					if (!addRequestRef.current || addRequestRef.current.signature !== signature) addRequestRef.current = { signature: signature, id: sceneImageRequestId() };
					recordImageInteraction(props.sessionId, props.turn, addRequestRef.current.id, "click");
					setBusy(true); setError("");
					try {
						await rpc("generateSceneImage", { turn: props.turn, key: state.key, kind: "add", instruction: text, requestId: addRequestRef.current.id }, props.sessionId);
						addRequestRef.current = null; setAddDraft(null);
					} catch (e) { setError(String(e.message || e)); }
					finally { setBusy(false); notify(); }
				}
				async function dismiss() {
					if (busy || !state || !state.slot) return;
					setBusy(true); setError("");
					try { await rpc("removeSceneImage", { turn: props.turn, key: state.key, versionId: "" }, props.sessionId); }
					catch (e) { setError(String(e.message || e)); }
					finally { setBusy(false); notify(); }
				}
				function openReference() {
					const people = version.referencePeople || [];
					setReferenceDraft({ key: state.key, versionId: version.id, gateway: state.reference.gateway, service: state.reference.service, personId: version.referenceSingle && people.length === 1 ? people[0].id : "" });
				}
				async function setReference(enabled, personId) {
					if (!version || locked) return;
					if (enabled && (!referenceDraft || referenceDraft.key !== state.key || referenceDraft.versionId !== version.id || !referenceDraft.personId)) return;
					setBusy(true); setError("");
					try { await rpc("setSceneImageReference", { turn: props.turn, key: state.key, versionId: version.id, consent: enabled ? referenceDraft.gateway : state.reference.gateway, personId: enabled ? referenceDraft.personId : personId, enabled: enabled }, props.sessionId); setReferenceDraft(null); }
					catch (e) { setError(String(e.message || e)); }
					finally { setBusy(false); notify(); }
				}
				const url = version ? "/api/dsh-tavern/scene-image?" + new URLSearchParams({ sessionId: props.sessionId, turn: String(props.turn), key: state.key, versionId: version.id }).toString() : "";
				if (!state) return null;
				// Without a picture, generation lives in the turn's action row.
				if (!version && state.status === "idle") return null;
				const locked = busy || state.status === "running" || state.recovery === "save";
				const referencePeople = version && version.referencePeople || [];
				const referenceBindings = state.reference && state.reference.bindings ? state.reference.bindings.filter(function (binding) { return version && binding.versionId === version.id; }) : [];
				const canBindReference = state.enabled && state.reference && state.reference.supported && referencePeople.length > 0;
				const showReference = referenceDraft && version && referenceDraft.key === state.key && referenceDraft.versionId === version.id;
				return React.createElement("div", { className: "dsh-tavern-illustration" },
					url ? React.createElement("a", { href: url, "aria-label": "放大场景插画", onClick: function (event) { event.preventDefault(); openSceneImagePreview(url, event.currentTarget, version, state.enabled ? function () { setAdjusting(false); setPromptDraft(version.planPrompt); } : null); } }, React.createElement("img", { src: url, alt: "本段场景插画", loading: "lazy", onError: function () { setError("图片加载失败，请刷新后重试"); } })) : null,
					version ? React.createElement("div", { className: "dsh-tavern-image-actions" },
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: removeImage }, "删除图片"),
						versions.length > 1 ? React.createElement(React.Fragment, null,
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", "aria-label": "上一张插图", disabled: index <= 0, onClick: function () { setSelected(versions[index - 1].id); } }, "‹"),
							React.createElement("span", null, String(index + 1) + " / " + String(versions.length)),
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", "aria-label": "下一张插图", disabled: index >= versions.length - 1, onClick: function () { setSelected(versions[index + 1].id); } }, "›")
						) : null,
						state.enabled ? React.createElement(React.Fragment, null,
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: function () { setPromptDraft(null); setAddDraft(null); setAdjusting(true); } }, "重画"),
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", title: "自己写这张图的提示词再画，任意语言都可以，不经过文字模型", disabled: locked, onClick: function () { setAdjusting(false); setAddDraft(null); setPromptDraft(version.planPrompt || ""); } }, "改提示词"),
							props.canAdd ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", title: "为这一轮另选一个场景，再加一张插图", disabled: busy, onClick: function () { setAdjusting(false); setPromptDraft(null); setAddDraft(""); } }, "新增插图") : null
						) : null
					) : null,
					!version && state.slot && state.status !== "running" && state.recovery !== "save" ? React.createElement("div", { className: "dsh-tavern-image-actions" },
						state.enabled ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: function () { return generate("generate"); } }, state.outcome === "unconfirmed" ? "重新生图" : "重试这张插图") : null,
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: dismiss }, "移除")
					) : null,
					addDraft !== null && state.enabled ? React.createElement("div", { className: "dsh-tavern-image-adjust dsh-tavern-image-repaint", role: "region", "aria-label": "新增插图" },
						React.createElement("textarea", { value: addDraft, maxLength: 2000, rows: 2, autoFocus: true, "aria-label": "新插图想画什么（选填）", placeholder: "想画哪个场景？例如：她转身离开时的背影。留空由 AI 另选一个不同的场景", onChange: function (event) { setAddDraft(event.target.value); }, onKeyDown: function (event) {
							if (event.key === "Escape" && !busy) setAddDraft(null);
							else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) { event.preventDefault(); addPicture(); }
						}, disabled: busy }),
						React.createElement("div", { className: "dsh-tavern-image-repaint-actions" },
							React.createElement("button", { type: "button", className: "dsh-tavern-image-repaint-cancel", disabled: busy, onClick: function () { setAddDraft(null); } }, "取消"),
							React.createElement("button", { type: "button", className: "dsh-tavern-btn dsh-tavern-image-repaint-submit", title: "另选一个场景再画一张，原有插图保留；会再跑一次文字模型和生图", disabled: busy, onClick: addPicture }, "新增插图"))
					) : null,
					canBindReference || referenceBindings.length ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: openReference }, referenceBindings.length ? "管理造型参考" : "用作造型参考") : null,
					version && state.enabled && version.profile && version.profile !== state.profile ? React.createElement("span", { role: "status" }, "将按新渠道重新整理画面，可能产生文字模型费用。") : null,
					state.referenceWarning || state.reference && state.reference.warning ? React.createElement("span", { role: "status" }, state.referenceWarning || state.reference.warning) : null,
					showReference ? React.createElement("div", { className: "dsh-tavern-image-adjust dsh-tavern-image-reference", role: "region", "aria-label": "造型参考" },
						canBindReference ? React.createElement(React.Fragment, null,
							React.createElement("label", null, "参考人物", React.createElement("select", { value: referenceDraft.personId, disabled: locked, onChange: function (event) { setReferenceDraft(Object.assign({}, referenceDraft, { personId: event.target.value })); } },
								React.createElement("option", { value: "" }, "请选择图中人物"),
								referencePeople.map(function (person) { return React.createElement("option", { key: person.id, value: person.id }, person.name + (person.description ? " · " + person.description : "") + (referencePeople.filter(function (other) { return other.name === person.name; }).length > 1 ? " · " + person.id.slice(-8) : "")); })
							)),
							React.createElement("p", null, "确认图片中的所选人物。整张图会发送给：" + referenceDraft.service + "。从当前游戏进度起用于该人物的造型参考，不自动绑定其他人；仅辅助外貌一致，不保证锁脸，也不沿用旧服装。"),
							referenceDraft.gateway !== state.reference.gateway ? React.createElement("p", { role: "status" }, "渠道配置已变化，请关闭后重新选择参考图。") : null,
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked || !referenceDraft.personId || referenceDraft.gateway !== state.reference.gateway, onClick: function () { return setReference(true); } }, "确认使用")
						) : null,
						referenceBindings.map(function (binding) { return React.createElement("button", { key: binding.personId, type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: function () { return setReference(false, binding.personId); } }, "取消「" + binding.name + "」的参考"); }),
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: function () { setReferenceDraft(null); } }, "关闭参考设置")
					) : null,
					adjusting && state.enabled ? React.createElement("div", { className: "dsh-tavern-image-adjust dsh-tavern-image-repaint", role: "region", "aria-label": "重画插图" },
						React.createElement("textarea", { value: instruction, maxLength: 2000, rows: 2, autoFocus: true, "aria-label": "重画意见（选填）", placeholder: "想怎么改？例如：改成雨夜，镜头拉近。留空可重新构思画面，或按原方案再画一张", onChange: function (event) { setInstruction(event.target.value); }, onKeyDown: function (event) {
							if (event.key === "Escape" && !busy) setAdjusting(false);
							else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !locked) { event.preventDefault(); generate(instruction.trim() ? "adjust" : "replan"); }
						}, disabled: locked }),
						React.createElement("div", { className: "dsh-tavern-image-repaint-actions" },
							React.createElement("button", { type: "button", className: "dsh-tavern-image-repaint-cancel", disabled: busy, onClick: function () { setAdjusting(false); } }, "取消"),
							instruction.trim() ? null : React.createElement("button", { type: "button", className: "dsh-tavern-btn", title: "沿用这张图的画面方案，只换随机种子", disabled: locked, onClick: function () { return generate("repaint"); } }, "同方案重画"),
							React.createElement("button", { type: "button", className: "dsh-tavern-btn dsh-tavern-image-repaint-submit", title: instruction.trim() ? "按意见修改这张图的方案后重画" : "重新读正文、选时刻、写构图，多跑一次文字模型", disabled: locked, onClick: function () { return generate(instruction.trim() ? "adjust" : "replan"); } }, instruction.trim() ? "按意见重画" : "重新构思画面"))
					) : null,
					promptDraft !== null && state.enabled && version ? React.createElement("div", { className: "dsh-tavern-image-adjust dsh-tavern-image-repaint", role: "region", "aria-label": "改提示词重画" },
						React.createElement("textarea", { value: promptDraft, maxLength: 12000, rows: 6, autoFocus: true, "aria-label": "画面提示词", placeholder: "直接写画面提示词，中文、英文或标签都可以；画风设置会另外追加", onChange: function (event) { setPromptDraft(event.target.value); }, onKeyDown: function (event) {
							if (event.key === "Escape" && !busy) setPromptDraft(null);
							else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !locked && promptDraft.trim()) { event.preventDefault(); generate("prompt"); }
						}, disabled: locked }),
						React.createElement("div", { className: "dsh-tavern-image-repaint-actions" },
							React.createElement("button", { type: "button", className: "dsh-tavern-image-repaint-cancel", disabled: busy, onClick: function () { setPromptDraft(null); } }, "取消"),
							React.createElement("button", { type: "button", className: "dsh-tavern-btn dsh-tavern-image-repaint-submit", title: "直接用这段提示词画，不经过文字模型，不改人物资料和本轮方案", disabled: locked || !promptDraft.trim(), onClick: function () { return generate("prompt"); } }, "用这段重画"))
					) : null,
					state.status === "running" ? React.createElement(SceneImagePending, { state: state, picture: !version, disabled: busy, onCancel: cancelImage }) : null,
					state.recovery === "save" && state.status !== "running" ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: retrySave }, "重试保存") : null,
					error || state && state.error ? React.createElement("span", { role: "alert", className: "dsh-tavern-settings-error" }, error || state.error) : null
				);
			}
			function register(input) {
				// uiWorkspace 由 dsh-client-ui-workspace 提供；缺失时（老宿主/未加载）退化为 sessions.retain。
				function resolveUiWorkspace() {
					try { return input.ctx.get("uiWorkspace") || null; } catch (_) { return null; }
				}
				const scriptOwner = createTavernScriptSessionOwner({ sessions: createSessionCompat(input.ctx.sessions, resolveUiWorkspace()), executeSlash: createTavernFrameSlashExecutor(input.ctx) });
				const executeSlash = createTavernFrameSlashExecutor(input.ctx);
				input.ctx.effect(function () {
					scriptOwner.start();
					return function () { scriptOwner.dispose(); };
				}, "dsh-tavern: game script owner");
				input.ctx.effect(function () {
					return input.slots.inject("conversation.session.header.actions", function () {
						return input.slots.register({
						name: "conversation.session.header.actions", id: "dsh-tavern-script-runtime", order: -140, label: "人物卡脚本运行时"
						}, function () { return React.createElement(TavernScriptRuntime, { owner: scriptOwner }); });
					});
				}, "dsh-tavern: conversation script lifecycle");
			}
			return Object.freeze({ register: register, SceneIllustration: SceneIllustration });
		}

		function createTavernFrameSlashExecutor(ctx, hostWindow) {
			hostWindow = hostWindow || window;
			return function (line, sessionId, options) {
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

		function createTavernAssistantRendererFeatureModule() {
			function openSceneImagePreview(url, opener) {
				const dialog = document.createElement("dialog");
				dialog.className = "dsh-tavern-image-preview";
				dialog.setAttribute("aria-label", "场景插画预览");
				const close = document.createElement("button");
				close.type = "button";
				close.textContent = "缩小并返回 ×";
				close.setAttribute("aria-label", "缩小并返回");
				const image = document.createElement("img");
				image.src = url;
				image.alt = "放大的场景插画";
				close.addEventListener("click", function () { dialog.close(); });
				dialog.addEventListener("click", function (event) { if (event.target === dialog) dialog.close(); });
				dialog.addEventListener("close", function () { dialog.remove(); if (opener && opener.isConnected) opener.focus(); }, { once: true });
				dialog.append(close, image);
				document.body.append(dialog);
				dialog.showModal();
				close.focus();
			}
			function SceneIllustration(props) {
            const askConfirm = useTavernConfirm(props.sessionId || props.scope?.sessionId);
				const state = useSceneImageRecord(props.sessionId, props.turn);
				const [error, setError] = React.useState("");
				const [selected, setSelected] = React.useState("");
			const [refreshes, setRefreshes] = React.useState({});
				const [busy, setBusy] = React.useState(false);
				const [adjusting, setAdjusting] = React.useState(false);
				const [instruction, setInstruction] = React.useState("");
				const [referenceDraft, setReferenceDraft] = React.useState(null);
				const requestRef = React.useRef(null);
				const versions = state && state.versions || [];
				const version = versions.find(function (item) { return item.id === selected; }) || versions[versions.length - 1];
				const index = version ? versions.findIndex(function (item) { return item.id === version.id; }) : -1;
				const lastId = versions.length ? versions[versions.length - 1].id : "";
				React.useEffect(function () { setSelected(lastId); setError(""); }, [lastId]);
				React.useEffect(function () {
					if (state && ["failed", "cancelled"].includes(state.status) && state.kind === "adjust" && state.instruction) {
						setSelected(state.baseVersionId); setInstruction(state.instruction); setAdjusting(true);
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
				const reusable = requestRef.current && !(state && requestRef.current.id === state.requestId && ["failed", "cancelled", "idle"].includes(state.status));
				const clickId = reusable && requestRef.current.signature === kind + ":" + (version && version.id) + ":" + instruction ? requestRef.current.id : sceneImageRequestId();
				recordImageInteraction(props.sessionId, props.turn, clickId, "click");
					if ((!version && kind !== "generate") || busy || state.status === "running" || state.recovery === "save") { recordImageInteraction(props.sessionId, props.turn, clickId, "blocked", "busy-or-existing"); return; }
					const confirmNewRequestId = await sceneImagePurchaseConfirmation(state, askConfirm);
					if (confirmNewRequestId === false) { recordImageInteraction(props.sessionId, props.turn, clickId, "cancelled", "confirmation"); return; }
					if (requestRef.current && requestRef.current.id === state.requestId && ["failed", "cancelled", "idle"].includes(state.status)) requestRef.current = null;
					setBusy(true); setError("");
					const signature = kind + ":" + (version && version.id) + ":" + instruction;
					if (!requestRef.current || requestRef.current.signature !== signature) requestRef.current = { signature: signature, id: clickId };
					try {
						await rpc("generateSceneImage", { turn: props.turn, key: state.key, kind: kind, versionId: version && version.id, instruction: kind === "adjust" ? instruction : "", requestId: requestRef.current.id, confirmNewRequestId: confirmNewRequestId }, props.sessionId);
						requestRef.current = null; setAdjusting(false); setInstruction("");
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
				if (!state || state.status === "idle" && !state.hasDeletedImages) return null;
				const locked = busy || state.status === "running" || state.recovery === "save";
				const referencePeople = version && version.referencePeople || [];
				const referenceBindings = state.reference && state.reference.bindings ? state.reference.bindings.filter(function (binding) { return version && binding.versionId === version.id; }) : [];
				const canBindReference = state.enabled && state.reference && state.reference.supported && referencePeople.length > 0;
				const showReference = referenceDraft && version && referenceDraft.key === state.key && referenceDraft.versionId === version.id;
				return React.createElement("div", { className: "dsh-tavern-illustration" },
					url ? React.createElement("a", { href: url, "aria-label": "放大场景插画", onClick: function (event) { event.preventDefault(); openSceneImagePreview(url, event.currentTarget); } }, React.createElement("img", { src: url, alt: "本段场景插画", loading: "lazy", onError: function () { setError("图片加载失败，请刷新后重试"); } })) : null,
					version ? React.createElement("div", { className: "dsh-tavern-image-actions" },
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: removeImage }, "删除图片"),
						versions.length > 1 ? React.createElement(React.Fragment, null,
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", "aria-label": "上一张插图", disabled: index <= 0, onClick: function () { setSelected(versions[index - 1].id); } }, "‹"),
							React.createElement("span", null, String(index + 1) + " / " + String(versions.length)),
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", "aria-label": "下一张插图", disabled: index >= versions.length - 1, onClick: function () { setSelected(versions[index + 1].id); } }, "›")
						) : null,
						state.enabled ? React.createElement(React.Fragment, null,
							React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: function () { setAdjusting(true); } }, "重画")
						) : null
					) : null,
					!version && state.hasDeletedImages && state.enabled ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: function () { return generate("generate"); } }, "重新生图") : null,
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
					adjusting && state.enabled ? React.createElement("div", { className: "dsh-tavern-image-adjust", role: "region", "aria-label": "重画插图" },
						React.createElement("label", null, "重画意见（选填）", React.createElement("textarea", { value: instruction, maxLength: 2000, placeholder: "留空直接重画；例如：改成雨夜，镜头拉近", onChange: function (event) { setInstruction(event.target.value); }, disabled: locked })),
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: locked, onClick: function () { return generate(instruction.trim() ? "adjust" : "repaint"); } }, "开始重画"),
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: function () { setAdjusting(false); } }, "取消")
					) : null,
					state.status === "running" ? React.createElement("span", { role: "status" }, sceneImageStageLabel(state)) : null,
					state.status === "running" ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy || Boolean(state.cancelRequestedAt), onClick: cancelImage }, state.cancelRequestedAt ? "正在取消…" : "取消生图") : null,
					state.recovery === "save" && state.status !== "running" ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: retrySave }, "重试保存") : null,
					error || state && state.error ? React.createElement("span", { role: "alert", className: "dsh-tavern-settings-error" }, error || state.error) : null
				);
			}
			function register(input) {
				const scriptOwner = createTavernScriptSessionOwner({ sessions: input.ctx.sessions, executeSlash: createTavernFrameSlashExecutor(input.ctx) });
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

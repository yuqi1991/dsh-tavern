        function installTavernImmersiveMode(button) {
            const header = button?.closest("header");
            if (!header) return { enter() { }, dispose() { } };
            const restore = header.ownerDocument.createElement("button");
            restore.type = "button";
            restore.className = "dsh-tavern-restore-header";
            restore.textContent = "⌄ 显示顶部栏";
            restore.setAttribute("aria-label", "退出沉浸模式，显示顶部栏");
            restore.hidden = true;
            header.before(restore);
            function leave() {
                header.classList.remove("dsh-tavern-immersive-header");
                restore.hidden = true;
                button.focus();
            }
            restore.addEventListener("click", leave);
            return {
                enter() {
                    header.classList.add("dsh-tavern-immersive-header");
                    restore.hidden = false;
                    restore.focus();
                },
                dispose() {
                    header.classList.remove("dsh-tavern-immersive-header");
                    restore.removeEventListener("click", leave);
                    restore.remove();
                }
            };
        }
        function TavernImmersiveAction() {
            const button = React.useRef(null), controller = React.useRef(null);
            React.useEffect(() => {
                controller.current = installTavernImmersiveMode(button.current);
                return () => { controller.current.dispose(); controller.current = null; };
            }, []);
            return React.createElement("button", { ref: button, type: "button", className: "dsh-tavern-btn", title: "隐藏顶部标题和标签栏，可随时恢复", onClick: () => controller.current?.enter() }, "沉浸模式");
        }

		async function expandTavernFrame(root) {
            const frame = root?.querySelector('iframe:not([aria-hidden="true"])');
            try {
                if (!frame) throw new Error("面板尚未加载，请稍后重试。");
                try {
                    if (typeof frame.requestFullscreen === "function") {
                        await frame.requestFullscreen();
                        return;
                    }
                } catch (_) { /* Embedded hosts may deny native fullscreen. */ }
                if (!frame.isConnected) return;
                openTavernPageFullscreen(frame);
            } catch (error) { tavernErrorHub.report("展开大屏", error); }
        }

        let closeTavernPageFullscreen = null;
        function openTavernPageFullscreen(frame) {
            closeTavernPageFullscreen?.();
            const doc = frame.ownerDocument;
            const previousStyle = frame.getAttribute("style");
            const previousPopover = frame.getAttribute("popover");
            const previousFocus = doc.activeElement;
            const close = doc.createElement("button");
            close.type = "button";
            close.className = "dsh-tavern-btn";
            close.textContent = "退出大屏";
            close.style.cssText = "position:fixed;inset:16px 16px auto auto;margin:0;padding:10px 16px;z-index:2147483647;";
            let observer;
            const restore = () => {
                observer?.disconnect();
                if (typeof frame.hidePopover === "function" && frame.matches(":popover-open")) frame.hidePopover();
                if (previousPopover === null) frame.removeAttribute("popover");
                else frame.setAttribute("popover", previousPopover);
                if (previousStyle === null) frame.removeAttribute("style");
                else frame.setAttribute("style", previousStyle);
                close.remove();
                doc.removeEventListener("keydown", onKey);
                if (closeTavernPageFullscreen === restore) closeTavernPageFullscreen = null;
                if (previousFocus?.isConnected) previousFocus.focus();
            };
            const onKey = event => { if (event.key === "Escape") { event.preventDefault(); restore(); } };
            closeTavernPageFullscreen = restore;
            close.addEventListener("click", restore);
            doc.addEventListener("keydown", onKey);
            try {
                // Keep the live iframe in place: reparenting would reload card scripts.
                frame.style.cssText += ";position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;box-sizing:border-box!important;border:0!important;z-index:2147483646!important;";
                if (typeof frame.showPopover === "function") {
                    frame.setAttribute("popover", "manual");
                    frame.showPopover();
                    close.setAttribute("popover", "manual");
                }
                doc.body.append(close);
                if (close.hasAttribute("popover")) close.showPopover();
                close.focus();
                observer = new doc.defaultView.MutationObserver(() => {
                    if (!frame.isConnected || frame.getAttribute("aria-hidden") === "true") restore();
                });
                observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden"] });
            } catch (error) { restore(); throw error; }
        }

		function TavernMessageFrame(props) {
            if (props.sessionId && window.document?.body && typeof window.document.body.moveBefore === "function") {
                return React.createElement(TavernRetainedMessageFrame, props);
            }
			const homeRef = React.useRef(null);
			const panelKey = React.useRef(null);
			if (!panelKey.current) panelKey.current = "manual-" + Math.random().toString(36).slice(2);
			const panels = React.useSyncExternalStore(tavernPanelRegistry.subscribe, tavernPanelRegistry.inspect);
			const movable = Boolean(props.sessionId && !props.persistent && /<(?:script|iframe|object|embed)\b/i.test(String(props.content || "")));
			const pinned = panels.some(function (entry) { return entry.id === panelKey.current && entry.pinned; });
			const slotRef = React.useRef(null);
			const lifecycleRef = React.useRef(null);
			const frameProps = Object.assign({}, props, {
				panelId: props.panelId || "message-" + props.turn + "-" + props.partIndex,
				placement: props.persistent || pinned ? "sidebar" : "message"
			});
			if (!lifecycleRef.current) lifecycleRef.current = createTavernMessageFrameLifecycle(frameProps);
			const lifecycle = lifecycleRef.current;
			const [state, setState] = React.useState(lifecycle.snapshot);
			const visibleDocument = state.visibleDocument;
			const pendingDocument = state.pendingDocument;
			const height = state.height;
			const [activated, setActivated] = React.useState(props.eager === true);
			React.useEffect(function () { return lifecycle.start(setState); }, [lifecycle]);
			React.useEffect(function () { lifecycle.update(frameProps); });
			React.useEffect(function () {
				if (props.eager === true) { setActivated(true); return; }
				if (activated) return;
				let observer = null, cancelActivation = null;
				function enqueue() {
					if (cancelActivation) return;
					cancelActivation = enqueueTavernFrameActivation(function () {
						cancelActivation = null;
						setActivated(true);
						if (observer) observer.disconnect();
					});
				}
				const timer = window.setTimeout(function () {
					if (!slotRef.current) return;
					if (typeof window.IntersectionObserver !== "function") { enqueue(); return; }
					observer = new window.IntersectionObserver(function (entries) {
						if (entries[entries.length - 1]?.isIntersecting) enqueue();
						else if (cancelActivation) { cancelActivation(); cancelActivation = null; }
					}, { rootMargin: "240px 0px" });
					observer.observe(slotRef.current);
				}, 120);
				return function () { window.clearTimeout(timer); if (observer) observer.disconnect(); if (cancelActivation) cancelActivation(); };
			}, [activated, props.eager, props.sessionId]);
			function renderFrame(document, hidden) {
				if (!document) return null;
				const pendingHeight = document.height || height;
				return React.createElement("iframe", {
					key: document.token,
					ref: document.ref,
					className: "dsh-tavern-message-frame",
					title: hidden ? "正在准备人物卡消息界面" : "人物卡消息界面",
					"aria-hidden": hidden || undefined,
					sandbox: document.trustedCardMode ? undefined : "allow-scripts",
					referrerPolicy: "no-referrer",
					loading: "lazy",
					srcDoc: document.html,
					style: hidden
						? { position: "absolute", left: 0, top: 0, width: "100%", height: pendingHeight + "px", opacity: 0, pointerEvents: "none" }
						: { height: height + "px", overflow: height >= TAVERN_FRAME_MAX_HEIGHT ? "auto" : "hidden" }
				});
			}
			React.useLayoutEffect(function () {
				if (!movable || !slotRef.current || !homeRef.current) return;
				return tavernPanelRegistry.register({
					id: panelKey.current, sessionId: props.sessionId,
					title: "第 " + props.turn + " 轮 · 面板 " + (Number(props.partIndex) + 1),
					node: slotRef.current, home: homeRef.current, pinned: false
				});
			}, [movable, props.sessionId, props.content]);
			const frames = activated ? [renderFrame(visibleDocument, false), renderFrame(pendingDocument, true)] : null;
			return React.createElement("div", null,
				movable ? React.createElement("button", {
					type: "button", className: "dsh-tavern-btn", onClick: function () {
					try { setActivated(true); tavernPanelRegistry.pin(panelKey.current, !pinned); }
					catch (error) { tavernErrorHub.report("固定面板", error); }
					}
				}, pinned ? "返回原消息" : "固定到右侧") : null,
				React.createElement("div", { ref: homeRef },
					React.createElement("div", { ref: slotRef, className: "dsh-tavern-message-frame-slot", style: { position: "relative", height: height + "px" } }, frames)));

		}

		function TavernMvuReceipt(props) {
			const h = React.createElement;
			const [retrying, setRetrying] = React.useState(false);
			const receipt = props.receipt || {};
			const changes = Array.isArray(receipt.changes) ? receipt.changes : [];
			// MVU display/delta mirrors and schema maintenance stay in receipts for diagnostics,
			// but are not extra gameplay changes worth showing to players.
			const sideEffects = (Array.isArray(receipt.sideEffects) ? receipt.sideEffects : []).filter(function (change) {
				return !/^\/(?:delta_data|display_data|schema)(?:\/|$)/.test(String(change && change.path || ""));
			});
			const failures = Array.isArray(receipt.failures) ? receipt.failures : [];
			const status = ["pending", "updated", "partial", "error", "stale", "interrupted", "unchanged"].includes(receipt.status) ? receipt.status : "unchanged";
			const sideEffectSuffix = sideEffects.length > 0 ? " · 人物卡联动 " + sideEffects.length + " 项" : "";
			const labels = {
				pending: props.busy ? "变量结算中…" : "变量结算等待中",
				interrupted: "变量结算已中断",
				updated: (changes.length > 0 ? "变量已更新 · " + changes.length + " 项" : "变量已更新 · 旧记录无明细") + sideEffectSuffix,
				partial: "变量部分更新 · " + changes.length + " 项成功 · " + failures.length + " 项失败" + sideEffectSuffix,
				error: "变量更新失败 · " + failures.length + " 项" + sideEffectSuffix,
				stale: "变量结算已过期，未覆盖当前状态",
				unchanged: (sideEffects.length > 0 ? "Agent 未更新变量" : "本轮变量未更新") + sideEffectSuffix
			};
			const operationLabels = { set: "设置", replace: "设置", add: "新增", delta: "增减", insert: "新增", delete: "删除", remove: "删除", move: "移动" };
			const summary = h("div", { className: "dsh-tavern-mvu-receipt-summary" }, h("span", { className: "dsh-tavern-mvu-receipt-dot" }), h("span", null, labels[status]));
			async function retry() {
				if (retrying) return;
				setRetrying(true);
				try {
					if (status === "pending") {
						await rpc("retrySettlement", { turn: props.turn }, props.sessionId);
						liveTavernView.invalidate(props.sessionId);
						return;
					}
					await askTavernText({
						title: "重新结算变量", description: "指导意见（选填），仅对本次结算生效。正文保持不变。",
						placeholder: "例如：这轮还没有交付物品，不要扣除库存。",
						allowEmpty: true, maxLength: 4000, confirmLabel: "重新结算",
						onSubmit: guidance => rpc("retrySettlement", { turn: props.turn, guidance }, props.sessionId)
					});
					liveTavernView.invalidate(props.sessionId);
				} catch (error) { tavernErrorHub.report("重试变量结算", error); }
				finally { setRetrying(false); }
			}
			const retryButton = props.latest
				? h("button", { type: "button", className: "dsh-tavern-mvu-retry", disabled: retrying || props.busy, onClick: retry }, props.busy ? "结算中…" : retrying ? "重试中…" : status === "pending" ? "重新投递结算" : ["error", "stale", "interrupted", "partial"].includes(status) ? "重试变量结算" : "重新结算变量")
				: null;
			const hasDetails = String(receipt.summary || "") !== "" || changes.length > 0 || sideEffects.length > 0 || failures.length > 0 || retryButton;
			if (!hasDetails) return h("div", { className: "dsh-tavern-mvu-receipt", "data-status": status }, summary);
			return h("details", { className: "dsh-tavern-mvu-receipt", "data-status": status },
				h("summary", { className: "dsh-tavern-mvu-receipt-summary" }, h("span", { className: "dsh-tavern-mvu-receipt-dot" }), h("span", null, labels[status])),
				h("div", { className: "dsh-tavern-mvu-receipt-body" },
					receipt.summary ? h("div", { className: "dsh-tavern-mvu-receipt-reason" }, "原因：" + String(receipt.summary)) : null,
					changes.map(function (change, index) {
						return h("div", { key: "change:" + index, className: "dsh-tavern-mvu-change" },
						h("div", { className: "dsh-tavern-mvu-change-path" }, (operationLabels[change.operation] || "更新") + " " + String(change.path || "/")),
						h("div", { className: "dsh-tavern-mvu-change-values" }, String(change.before) + " → " + String(change.after))
						);
					}),
					sideEffects.length > 0 ? h("div", { className: "dsh-tavern-mvu-side-effect-title" }, "人物卡脚本联动") : null,
					sideEffects.map(function (change, index) {
						return h("div", { key: "side-effect:" + index, className: "dsh-tavern-mvu-change", "data-origin": "card-script" },
						h("div", { className: "dsh-tavern-mvu-change-path" }, (operationLabels[change.operation] || "更新") + " " + String(change.path || "/")),
						h("div", { className: "dsh-tavern-mvu-change-values" }, String(change.before) + " → " + String(change.after))
						);
					}),
					failures.map(function (failure, index) {
						const operation = operationLabels[failure.operation] || String(failure.operation || "操作");
						const path = String(failure.path || failure.command || "/");
						return h("div", { key: "failure:" + index, className: "dsh-tavern-mvu-failure" }, "失败：" + operation + " " + path + "：" + String(failure.message || "未知错误"));
					}),
					(status === "error" || status === "partial") && Array.isArray(receipt.runtimeDiagnostics) ? receipt.runtimeDiagnostics.filter(function (item) { return item && item.message && ["warn", "error"].includes(item.level); }).slice(-3).map(function (item, index) { return h("div", { key: "runtime:" + index, className: "dsh-tavern-mvu-failure" }, "运行时：" + String(item.message)); }) : null,
					retryButton
				)
			);
		}

		function htmlPartHasPresentation(value) {
			const source = String(value || "").trim();
			if (!source) return false;
			if (/<(?:script|style|link|iframe|object|embed|img|picture|video|audio|canvas|svg|br|hr|input|button|select|textarea|progress|meter)\b/i.test(source)) return true;
			const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
			if (withoutComments.replace(/<[^>]*>/g, "").trim() !== "") return true;
			const openingTags = withoutComments.match(/<[a-z][\w:-]*(?:\s[^<>]*?)?\/?\s*>/gi) || [];
			return openingTags.some(function (tag) {
				return /^<[a-z][\w:-]*\s+[^>]*>/i.test(tag) && !/^<[a-z][\w:-]*\s*\/?>$/i.test(tag);
			});
		}

		function projectionPartsOf(projection) {
			if (!projection) return [];
			if (Array.isArray(projection.parts)) return projection.parts.filter(function (part) {
				if (!part || (part.kind !== "markdown" && part.kind !== "html")) return false;
				if (part.kind === "html") return htmlPartHasPresentation(part.content !== undefined ? part.content : part.html || "");
				return String(part.text || "").trim() !== "";
			});
			if (projection.mode === "html" || projection.mode === "rich") {
				const content = String(projection.html || projection.text || "");
				return htmlPartHasPresentation(content) ? [{ kind: "html", content: content }] : [];
			}
			return [{ kind: "markdown", text: String(projection.text || "") }];
		}

		function renderTavernProjection(projection, options) {
			const h = React.createElement;
			const parts = projectionPartsOf(projection);
			if (options.openingPreview && options.openingPreview.runtime) {
				const content = '<div id="chat"><div class="mes" mesid="0" is_user="false"><div class="mes_text">' + (options.openingPreview.messageHtml !== undefined ? options.openingPreview.messageHtml : parts.map(function (part) {
					if (part.kind === "html") return String(part.content !== undefined ? part.content : part.html || "");
					return '<div class="dsh-tavern-plain-text">' + String(part.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</div>';
				}).join("\n")) + '</div></div></div>';
				return h(TavernMessageFrame, Object.assign({}, options, { key: "opening-runtime", content: content, partIndex: 0, eager: options.eagerFrame }));
			}
			return parts.map(function (part, index) {
				if (part.kind === "markdown") return h(TavernColoredMarkdown, { key: index, text: String(part.text || ""), streaming: options.streaming, labels: { code: options.codeLabels, footnotes: "脚注" }, codeLabels: options.codeLabels, fileMentions: options.mentions });
				// Rounds past the render depth keep their prose; the card's HTML waits for one click.
				if (typeof options.deferHtml === "function") {
					if (parts.findIndex(function (item) { return item.kind === "html"; }) !== index) return null;
					return h("button", { key: index, type: "button", className: "dsh-tavern-btn dsh-tavern-render-round", title: "超出渲染深度的轮次只显示文字；点击后渲染本轮的卡片界面", onClick: options.deferHtml }, "渲染此轮");
				}
				const content = String(part.content !== undefined ? part.content : part.html || "");
				return h(TavernMessageFrame, { key: index, content: content, sessionId: options.sessionId, turn: options.turn, partIndex: index, frameOwner: options.frameOwner, helperContext: options.helperContext, openingPreview: options.openingPreview, onSelectOpening: options.onSelectOpening, onSubmitOpening: options.onSubmitOpening, trustedCardMode: options.trustedCardMode, eager: options.eagerFrame, executeSlash: options.executeSlash });
			});
		}

		function renderTavernAssistantBlocks(input) {
			const h = React.createElement;
			const blocks = Array.isArray(input.blocks) ? input.blocks : [];
			const translate = typeof input.t === "function" ? input.t : function (key, values) {
				if (key === "copy") return "复制";
				if (key === "copied") return "已复制";
				if (key === "message.stopped") return "已停止";
				if (key === "message.unknownBlock") return "未知消息块";
				if (key === "json.truncated") return "内容过长（共 " + String(values && values.total || 0) + " 项）";
				return key;
			};
			const codeLabels = { copyLabel: translate("copy"), copiedLabel: translate("copied") };
			const rendered = [];
			let projected = false;
			for (let index = 0; index < blocks.length; index += 1) {
				const block = blocks[index];
				if (!block) continue;
				if (block.kind === "text") {
					if (input.projection && projected) continue;
					const projection = input.projection;
					if (projection) rendered.push(h(React.Fragment, { key: index }, renderTavernProjection(projection, { streaming: input.streaming, codeLabels: codeLabels, mentions: input.mentions, sessionId: input.sessionId, turn: input.turn, helperContext: input.helperContext, trustedCardMode: input.trustedCardMode, eagerFrame: input.eagerFrame, deferHtml: input.deferHtml, frameOwner: input.frameOwner, executeSlash: input.executeSlash })));
					else rendered.push(h(TavernColoredMarkdown, { key: index, text: String(block.text || ""), streaming: input.streaming, labels: { code: codeLabels, footnotes: "脚注" }, codeLabels: codeLabels, fileMentions: input.mentions }));
					projected = true;
					continue;
				}
				if (block.kind === "reasoning") {
					rendered.push(h("details", { key: index, className: "dsh-tavern-assistant-reasoning", open: input.streaming && index === blocks.length - 1 }, h("summary", null, input.streaming && index === blocks.length - 1 ? "思考中…" : "思考过程"), h("pre", null, String(block.text || ""))));
					continue;
				}
				if (block.kind === "image") {
					const start = index;
					const group = [block];
					while (index + 1 < blocks.length && blocks[index + 1] && blocks[index + 1].kind === "image") { group.push(blocks[index + 1]); index += 1; }
					rendered.push(h(React.Fragment, { key: start }, input.renderMessageImages({ images: group.map(function (item) { return { attachment: item.attachment }; }), align: "start" })));
					continue;
				}
				if (block.kind !== "tool-call") rendered.push(h(DshUi.JsonBlock, { key: index, label: translate("message.unknownBlock"), payload: block.block || block, truncatedLabel: function (total) { return translate("json.truncated", { total: total }); } }));
			}
			if (input.projection && !projected) {
				rendered.push(h(React.Fragment, { key: "projection" }, renderTavernProjection(input.projection, { streaming: false, codeLabels: codeLabels, mentions: input.mentions, sessionId: input.sessionId, turn: input.turn, helperContext: input.helperContext, trustedCardMode: input.trustedCardMode, eagerFrame: input.eagerFrame, deferHtml: input.deferHtml, frameOwner: input.frameOwner, executeSlash: input.executeSlash })));
			}
			if (input.interrupted) rendered.push(h("span", { key: "stopped", className: "dsh-tavern-assistant-stopped" }, translate("message.stopped")));
			return rendered;
		}

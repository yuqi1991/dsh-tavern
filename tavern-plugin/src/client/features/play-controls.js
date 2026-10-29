		function createPlayControlsFeatureModule() {
			function TavernConversationExportAction(props) {
				// The header only needs session membership. Building a complete
				// Tavern view here delays the button behind templates and history.
				const owner = props.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
				const available = Boolean(useTavernSessionMode(owner));
                const [busy, setBusy] = React.useState(false);
                const [open, setOpen] = React.useState(false);
                const root = React.useRef(null);
                React.useEffect(function () {
                    setOpen(false);
                }, [props.sessionId]);
                React.useEffect(function () {
                    if (!open) return;
                    function outside(event) { if (!root.current || !root.current.contains(event.target)) setOpen(false); }
                    function escape(event) { if (event.key === "Escape") { setOpen(false); root.current?.querySelector("[aria-haspopup]")?.focus(); } }
                    document.addEventListener("pointerdown", outside, true);
                    document.addEventListener("keydown", escape);
                    return function () { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
                }, [open]);
				if (!available) return null;
				async function exportText() {
					setBusy(true);
					try {
						const snapshot = props.sessions.list.getSnapshot();
						const summary = snapshot.byId && snapshot.byId[props.sessionId];
						const result = await rpc("exportConversation", { title: summary && summary.displayTitle || "" }, props.sessionId);
						const blob = new Blob(["\uFEFF", result.text], { type: "text/plain;charset=utf-8" });
						const url = URL.createObjectURL(blob);
						const link = document.createElement("a");
						link.href = url; link.download = result.filename || "对话记录.txt";
						document.body.appendChild(link); link.click(); link.remove();
						URL.revokeObjectURL(url);
					} catch (err) { tavernErrorHub.report("导出纯对话", err); }
					finally { setBusy(false); }
				}
				async function exportSave() {
					setBusy(true);
					try {
						const result = await rpc("exportGameSave", { images: true }, props.sessionId);
						const bytes = Uint8Array.from(atob(result.base64), function (value) { return value.charCodeAt(0); });
						const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
						const link = document.createElement("a");
						link.href = url; link.download = result.filename;
						document.body.appendChild(link); link.click(); link.remove();
						window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
					} catch (err) { tavernErrorHub.report("导出存档", err); }
					finally { setBusy(false); }
				}
				async function exportLogs() {
					setBusy(true);
					try {
						const result = await rpc("exportTavernLogs", {}, props.sessionId);
						const bytes = Uint8Array.from(atob(result.base64), function (value) { return value.charCodeAt(0); });
						const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
						const link = document.createElement("a");
						link.href = url; link.download = result.filename;
						document.body.appendChild(link); link.click(); link.remove();
						window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
					} catch (err) { tavernErrorHub.report("导出日志", err); }
					finally { setBusy(false); }
				}
				return React.createElement("div", { className: "dsh-tavern-more-actions dsh-tavern-export-menu", ref: root },
                    React.createElement("button", { type: "button", className: "dsh-tavern-export-action", "aria-label": busy ? "导出中" : "导出", title: "导出", "aria-haspopup": "menu", "aria-expanded": open, "aria-busy": busy, onClick: function () { setOpen(value => !value); } },
                        React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, React.createElement("path", { d: "M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" })),
                        React.createElement("span", { className: "dsh-tavern-header-action-label" }, busy ? "导出中…" : "导出")),
                    React.createElement("div", { className: "dsh-tavern-more-menu", role: "menu", "aria-label": "导出", hidden: !open, onClick: function (event) { if (event.target.closest("button:not(:disabled)")) setOpen(false); } },
                        React.createElement("button", { type: "button", role: "menuitem", disabled: busy, title: "导出这一局的存档，可在其他电脑的酒馆里导入继续玩", onClick: exportSave }, "存档"),
                        React.createElement("button", { type: "button", role: "menuitem", "data-tavern-log-export": "", disabled: busy, "aria-label": "日志", title: "下载 Session、MVU、生图与更新日志；含私人剧情，分享前请检查隐私", onClick: exportLogs }, "日志"),
                        React.createElement("button", { type: "button", role: "menuitem", disabled: busy, title: "导出只包含玩家与角色正文的 TXT", onClick: exportText }, "纯对话 TXT")
                    ));
            }

			function TavernCompactionAction(props) {
				const [busy, setBusy] = React.useState(false);
				const [resultLabel, setResultLabel] = React.useState("");
				const [resultTitle, setResultTitle] = React.useState("");
				const running = props.useSession(function (snapshot) { return snapshot.running; });
				async function compactContext() {
					setBusy(true);
					setResultLabel("");
					setResultTitle("");
					try {
                        const response = await rpc("runCompaction", {}, props.sessionId);
                        const operation = response.result;
                        if (!operation) throw new Error("当前会话不支持剧情压缩");
                        setResultTitle("前台：" + operation.foreground.message + "；后台：" + (operation.background.message || "无后台"));
                        if (operation.status !== "completed") throw new Error("上下文压缩未全部完成。前台：" + operation.foreground.message + "；后台：" + (operation.background.message || "无后台"));
                        setResultLabel(operation.backgroundSessionId ? "前台和后台已压缩" : "前台已压缩");
					} catch (err) { tavernErrorHub.report("压缩上下文", err); }
					finally { setBusy(false); }
				}
				return React.createElement("button", { className: props.inMenu ? "" : "dsh-tavern-choice-trigger", role: props.inMenu ? "menuitem" : undefined, disabled: busy || running, title: resultTitle || "前台使用剧情提示词、后台使用 DSH 内置提示词并联合压缩", onClick: compactContext }, busy ? "压缩中…" : (resultLabel || "压缩上下文"));
			}

			function TavernPlayerNameAction(props) {
				const [view, setView] = React.useState(null);
				const [busy, setBusy] = React.useState(false);
				React.useEffect(function () {
					let stopped = false;
					rpc("getSession", {}, props.sessionId).then(function (result) {
						if (!stopped) setView(result.view || null);
					}, function () { if (!stopped) setView(null); });
					return function () { stopped = true; };
				}, [props.sessionId]);
				if (!view || view.mode === "card") return null;
				async function renamePlayer() {
					if (busy) return;
					setBusy(true);
					try {
						await askTavernText({
							title: "修改故事中的玩家称呼",
							description: "仅影响之后生成的内容，不会重写历史消息。",
							initialValue: view.playerName || "你",
							placeholder: "你",
							maxLength: 80,
							onSubmit: async function (next) {
								try {
									const result = await rpc("setPlayerName", { userName: next }, props.sessionId);
									setView(Object.assign({}, view, { playerName: result.playerName || "你" }));
									liveTavernView.invalidate(props.sessionId);
									notifyTavernDataChanged(["sessions"], "play-controls");
								} catch (err) { tavernErrorHub.report("玩家称呼", err); throw err; }
							}
						});
					} finally { setBusy(false); }
				}
				return React.createElement("button", { className: "dsh-tavern-btn", disabled: busy, title: "修改之后内容中的玩家称呼", onClick: renamePlayer }, "玩家称呼：" + (view.playerName || "你"));
			}

			// 暂时保留自研手机实现，但不从产品界面挂载；现阶段优先兼容人物卡自带手机。
			function TavernPhone(props) {
				const h = React.createElement;
				const [page, setPage] = React.useState("home");
				const [contactId, setContactId] = React.useState("");
				const [draft, setDraft] = React.useState("");
				const [busy, setBusy] = React.useState(false);
				const [phone, setPhone] = React.useState(props.view.phoneChat || { contacts: [], threads: [] });
				const [optimistic, setOptimistic] = React.useState("");
				const messagesRef = React.useRef(null);
				React.useEffect(function () { setPhone(props.view.phoneChat || { contacts: [], threads: [] }); }, [props.view.phoneChat]);
				const contacts = Array.isArray(phone.contacts) ? phone.contacts : [];
				const contact = contacts.find(function (item) { return item.id === contactId; }) || null;
				const thread = (Array.isArray(phone.threads) ? phone.threads : []).find(function (item) { return item.contactId === contactId; }) || { messages: [] };
            React.useEffect(function () {
            	const element = messagesRef.current;
            	if (element) element.scrollTop = element.scrollHeight;
            }, [contactId, thread.messages.length, optimistic, busy]);
            function clock() {
            	const date = new Date();
            	return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
            }
            function openContact(next) { setContactId(next.id); setPage("chat"); setDraft(""); }
            async function send() {
            	const text = draft.trim();
            	if (!contact || !text || busy) return;
            	const requestId = "phone-" + Date.now() + "-" + Math.random().toString(36).slice(2);
            	setDraft(""); setOptimistic(text); setBusy(true);
                    try {
                    	const result = await rpc("sendPhoneMessage", { contactId: contact.id, text: text, requestId: requestId }, props.sessionId);
                    	setPhone(result.phoneChat || phone);
                    	setOptimistic("");
                    	liveTavernView.invalidate(props.sessionId);
                    } catch (error) {
                    	setOptimistic("");
                    	tavernErrorHub.report("手机聊天", error);
                    	liveTavernView.invalidate(props.sessionId);
                    } finally { setBusy(false); }
                }
                function timeLabel(value) {
                	if (!value) return "";
                	const date = new Date(value);
                	return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
            }
            let content;
            if (page === "home") {
            	content = h("div", { className: "dsh-tavern-phone-home" },
            		h("button", { className: "dsh-tavern-phone-app", onClick: function () { setPage("contacts"); }, "aria-label": "打开消息" },
            			h("span", { className: "dsh-tavern-phone-app-icon", "aria-hidden": "true" }),
            			h("span", { className: "dsh-tavern-phone-app-label" }, "消息")
            		)
            	);
            } else if (page === "contacts") {
            	content = h("div", { className: "dsh-tavern-phone-page" },
            		h("div", { className: "dsh-tavern-phone-nav" }, h("button", { onClick: function () { setPage("home"); } }, "‹ 主屏"), h("strong", null, "消息"), h("span", null)),
            		contacts.length ? h("div", { className: "dsh-tavern-phone-contact-list" }, contacts.map(function (item) {
            			const itemThread = (phone.threads || []).find(function (value) { return value.contactId === item.id; }) || {};
            			return h("button", { key: item.id, className: "dsh-tavern-phone-contact", onClick: function () { openContact(item); } },
            				h("span", { className: "dsh-tavern-phone-avatar" }, item.name.slice(0, 1)),
            				h("span", { className: "dsh-tavern-phone-contact-copy" }, h("span", { className: "dsh-tavern-phone-contact-name" }, item.name), h("span", { className: "dsh-tavern-phone-contact-preview" }, itemThread.preview || (item.main ? "开始聊天" : "尚无消息"))),
            				h("time", { className: "dsh-tavern-phone-contact-time" }, timeLabel(itemThread.updatedAt))
            			);
            		})) : h("div", { className: "dsh-tavern-phone-empty" }, "暂时没有可聊天的人物。人物卡主角或后台建立的人物设计会出现在这里。")
            	);
            } else {
            	const messages = Array.isArray(thread.messages) ? thread.messages : [];
            	content = h("div", { className: "dsh-tavern-phone-page" },
            		h("div", { className: "dsh-tavern-phone-nav" }, h("button", { onClick: function () { setPage("contacts"); } }, "‹ 消息"), h("strong", null, contact ? contact.name : "联系人"), h("span", null)),
            		h("div", { ref: messagesRef, className: "dsh-tavern-phone-messages" },
            			messages.length || optimistic ? messages.map(function (message) {
            				return h("div", { key: message.id, className: "dsh-tavern-phone-bubble " + message.role + " " + message.status }, message.text, message.status === "failed" ? h("span", { className: "dsh-tavern-phone-message-error" }, message.error || "发送失败") : null);
            			}).concat(optimistic ? [h("div", { key: "optimistic", className: "dsh-tavern-phone-bubble user pending" }, optimistic)] : []) : h("div", { className: "dsh-tavern-phone-empty" }, "发一条消息，开始这段独立私聊。")
            		),
            		h("div", { className: "dsh-tavern-phone-compose" },
            			h("textarea", { rows: 1, value: draft, maxLength: 1200, disabled: busy || !contact, placeholder: busy ? "对方正在回复…" : "输入消息", onChange: function (event) { setDraft(event.target.value); }, onKeyDown: function (event) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } } }),
            			h("button", { disabled: busy || !contact || draft.trim() === "", onClick: send, "aria-label": "发送消息" }, busy ? "…" : "↑")
            		)
            );
        }
        return h("aside", { className: "dsh-tavern-status dsh-tavern-phone-host" },
        	h("div", { className: "dsh-tavern-phone-toolbar" }, h("button", { className: "dsh-tavern-phone-exit", onClick: props.onClose }, "退出手机视图")),
        	h("div", { className: "dsh-tavern-phone-device" }, h("div", { className: "dsh-tavern-phone-island", "aria-hidden": "true" }), h("div", { className: "dsh-tavern-phone-screen" }, h("div", { className: "dsh-tavern-phone-statusbar" }, h("span", null, clock()), h("span", { className: "dsh-tavern-phone-status-icons" }, "▮▮ ᴡɪғɪ ▰")), content, h("div", { className: "dsh-tavern-phone-indicator", "aria-hidden": "true" })))
        );
			}

			// @include modules/story-ledger.js

			// @include script-navigation.js

			function TavernStatusPanel(props) {
            const askConfirm = useTavernConfirm(props.sessionId || props.scope?.sessionId);
			const [error, setError] = usePersistentError("酒馆状态");
			const [guideDraft, setGuideDraft] = React.useState("");
			const guideInputRef = React.useRef(null);
			const [guideBusy, setGuideBusy] = React.useState(false);
			const [guideNotice, setGuideNotice] = React.useState("");
			const [guideError, setGuideError] = usePersistentError("Guide");
			const [debugBusy, setDebugBusy] = React.useState(false);
			const [settlementRetryBusy, setSettlementRetryBusy] = React.useState(false);
			const [cardUpdateBusy, setCardUpdateBusy] = React.useState(false);
            const [cardUpdateError, setCardUpdateError] = React.useState("");
			const running = props.useSession(function (snapshot) { return snapshot.running; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const stateKey = String(running) + ":" + String(latestMessageId || "");
			const liveState = useLiveTavernView(props.sessionId, stateKey);
			const view = liveState.view;
			const loadState = liveState.phase;
			const missingCard = isMissingTavernCardError(liveState.error);
			const debugTurns = view && Array.isArray(view.debugTurns) ? view.debugTurns : [];
			const latestDebugTurn = Number(debugTurns[0] && debugTurns[0].turn) || 0;
			React.useEffect(function () {
				setError(missingCard ? "" : (liveState.error || ""));
			}, [liveState.error, missingCard]);
			async function openDebugger() {
				if (!latestDebugTurn || debugBusy) return;
				setDebugBusy(true);
				try { await openPlayChatDebugWorkspace(props.sessionId, latestDebugTurn); }
				catch (error) { tavernErrorHub.report("交给卡片 Agent 调试", error); }
				finally { setDebugBusy(false); }
			}
			async function addGuide() {
				const text = guideDraft.trim();
				if (!text) return;
				setGuideBusy(true); setGuideError("");
				try {
					await rpc("addGuide", { text: text }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
					setGuideDraft("");
				} catch (err) { setGuideError(String(err && err.message || err)); }
				finally { setGuideBusy(false); }
			}
			async function saveGuideLibrary() {
				if (guideBusy || !(view.guides || []).length) return;
				const name = await askTavernText({ title: "Guide 方案名称", initialValue: "本局 Guide", maxLength: 80 });
				if (!name) return;
				setGuideBusy(true); setGuideError(""); setGuideNotice("");
				try {
					await rpc("saveGuideLibrary", { name }, props.sessionId);
					notifyTavernDataChanged(["guide-library"], "guide-library");
					setGuideNotice("已保存到 Guide 库，本局 Guide 保持不变。");
				} catch (err) { setGuideError(String(err && err.message || err)); }
				finally { setGuideBusy(false); }
			}
			async function removeGuide(guide, index) {
				setGuideBusy(true); setGuideError("");
				try {
					await rpc("deleteGuide", guide.id ? { id: guide.id } : { index, expected: guide }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
				} catch (err) { setGuideError(String(err && err.message || err)); }
				finally { setGuideBusy(false); }
			}
			async function applyUpdatedCard() {
				if (cardUpdateBusy || !view?.cardUpdate || view.cardUpdate.error) return;
				if (!await askConfirm("将从资源库重新加载人物卡及绑定的世界书，本局脚本对世界书的修改会被替换。将预检最新状态栏、EJS、世界书与变量结构，再应用到当前游戏。已有剧情和保留字段的当前数值不变，新增变量补对应开场的初值，已从人物卡定义删除的变量会从当前及历史快照同步删除；显式改名迁移保留原值，以便回退后继续玩。预检失败不修改存档。更新会破坏提示词缓存，增加下一轮的 Token 费用和等待时间。是否继续？" + (view.cardUpdate.migrations?.length ? "\n\n声明的变量迁移：\n" + view.cardUpdate.migrations.join("\n") : ""))) return;
				setCardUpdateBusy(true); setCardUpdateError("");
				try { await rpc("applyUpdatedCard", { digest: view.cardUpdate.digest }, props.sessionId); liveTavernView.invalidate(props.sessionId); }
				catch (error) { setCardUpdateError(String(error.message || error)); }
				finally { setCardUpdateBusy(false); }
			}
			async function retrySettlement() {
				if (!view || settlementRetryBusy) return;
				setSettlementRetryBusy(true);
				try {
					await rpc("retrySettlement", { turn: view.settlementTurn }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
				} catch (retryError) { tavernErrorHub.report("重试后台结算", retryError); }
				finally { setSettlementRetryBusy(false); }
			}
			async function designCharacter(initialValue = "") {
				await askTavernText({
					title: "设计人物", description: "设计意见（选填）。留空则根据当前剧情和已有档案设计人物。", initialValue, allowEmpty: true, maxLength: 4000, confirmLabel: "开始设计",
                    onSubmit: async guidance => { await rpc("designCharacter", { guidance }, props.sessionId); liveTavernView.invalidate(props.sessionId); }
                });
            }
            React.useEffect(function () {
                if (view?.characterDesignTask?.status !== "running") return;
                const timer = setInterval(() => liveTavernView.invalidate(props.sessionId), 2000);
                return () => clearInterval(timer);
            }, [props.sessionId, view?.characterDesignTask?.status]);
			function characterDesignTime(ts) {
				if (!ts) return "";
				const date = new Date(ts);
				return (date.getMonth() + 1) + "/" + date.getDate() + " " + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
			}
			const h = React.createElement;
			if (!view) return h("aside", { className: "dsh-tavern-status" },
				h("div", { className: "dsh-tavern-status-head" }, h("div", { className: "dsh-tavern-status-title" }, "状态栏")),
				h("div", { className: "dsh-tavern-status-body" },
					h("div", { className: "dsh-tavern-status-empty" }, missingCard ? "人物卡已删除，酒馆状态不可用；已有对话仍可查看。" : (loadState === "retrying" ? "正在重新连接酒馆状态…" : (error || (loadState === "loading" ? "正在加载酒馆状态…" : "选择人物卡后，这里会显示持续状态。")))),
					loadState === "retrying" || missingCard ? h("button", { className: "dsh-tavern-btn", onClick: function () { liveTavernView.invalidate(props.sessionId); } }, "重新加载") : null
				)
			);
			if (view.mode === "card") return null;
			const statusText = view.settleStatus === "running" ? "正在执行后台结算" : (view.settleStatus === "error" ? "后台结算失败" : "后台结算已完成");
			const cardUpdateNotice = !view.cardUpdate ? "" : view.cardUpdate.error ? "检查更新失败：" + view.cardUpdate.error
				: view.cardUpdate.worldbookSyncRequired || view.cardUpdate.legacy ? "旧存档需同步"
				: view.cardUpdate.cardChanged && view.cardUpdate.worldbookChanged ? "人物卡和世界书有变化"
				: view.cardUpdate.cardChanged ? "人物卡有变化"
				: view.cardUpdate.worldbookChanged ? "世界书有变化" : "";
				return h("aside", { className: "dsh-tavern-status" },
				h("div", { className: "dsh-tavern-status-head" },
					h("div", { className: "dsh-tavern-status-role" }, view.card.name),
					(view.card.tags || []).length ? h("div", { className: "dsh-tavern-status-tags" }, (view.card.tags || []).slice(0, 8).map(function (tag) { return h("span", { key: tag, className: "dsh-tavern-status-tag" }, tag); })) : null,
					h("div", { className: "dsh-tavern-status-settle" }, h("span", { className: "dsh-tavern-status-dot " + (view.settleStatus || "idle") }), statusText)
				),
					h("div", { className: "dsh-tavern-status-body" },
						h(TavernBackgroundWait, { sessionId: props.sessionId, activity: view.activity }),
					["story", "script"].includes(view.mode || "story") && view.requestMode !== "sillytavern" && view.cardUpdate ? h("section", { className: "dsh-tavern-status-section" },
						h("div", { className: "dsh-tavern-card-reload" },
							h("button", { className: "dsh-tavern-btn", disabled: running || cardUpdateBusy || !!view.cardUpdate.error || view.settleStatus === "running", onClick: applyUpdatedCard }, cardUpdateBusy ? "正在重新加载人物卡和世界书…" : "重新加载人物卡和世界书"),
							cardUpdateNotice ? h("span", { className: "dsh-tavern-card-reload-notice", role: "status" }, cardUpdateNotice) : null
						),
						cardUpdateError ? h("p", { className: "dsh-card-error", role: "alert" }, "未应用更新：" + cardUpdateError) : null
					) : null,
					h(TavernCardAppDock, { sessionId: props.sessionId }),
					view.settleStatus === "error" ? h("div", { className: "dsh-card-error" },
						h("div", null, view.settleError || "后台结算失败，请重试。"),
						h("button", { className: "dsh-tavern-btn", disabled: settlementRetryBusy, onClick: retrySettlement }, settlementRetryBusy ? "重试中…" : "重试后台结算")
					) : null,
					view.worldBookError ? h("div", { className: "dsh-card-error" }, "世界书召回失败：" + view.worldBookError) : null,
					view.foregroundError ? h("div", { className: "dsh-card-error" }, view.foregroundError.message || "前台正文生成失败，请重新生成本轮正文。") : null,
					view.tavernHelper && view.statusBarPlacement !== "body" ? h("section", { className: "dsh-tavern-status-section" },
						h(TavernPersistentStatusRuntime, { sessionId: props.sessionId, view: view, executeSlash: props.executeSlash })
					) : null,
					(view.presentationWarnings || []).map(function (warning, index) {
						return h("div", { className: "dsh-card-error", key: "presentation-warning-" + index }, warning);
					}),
					h("section", { className: "dsh-tavern-status-section" },
						h("div", { className: "dsh-tavern-status-label" }, "正则加载不对？前端美化不对？内容生成不对？"),
						h("div", { className: "dsh-tavern-debug-panel" },
							h("button", { className: "dsh-tavern-debug-open", disabled: debugBusy || !latestDebugTurn, onClick: openDebugger }, debugBusy ? "正在打开卡片 Agent…" : "交给卡片 Agent 调试")
						)
					),
                    view.mode === "script" && view.scriptProgress ? h(ScriptNavigation, {
                        sessionId: props.sessionId, cursor: view.scriptProgress.cursor, total: view.scriptProgress.totalChunks, chunkSize: view.scriptProgress.chunkSize,
                        busy: running || view.activity?.busy || view.regenInProgress
                    }) : null,
                    h("section", { className: "dsh-tavern-status-section" },
                    	h("div", { className: "dsh-tavern-status-label" }, "Guide（注入上下文）"),
						h("div", { className: "dsh-tavern-guide-list" },
							(view.guides || []).length ? (view.guides || []).map(function (guide, index) {
								return h("div", { key: guide.id || index, className: "dsh-tavern-guide-item" },
									h("div", { className: "dsh-tavern-guide-text" }, guide.text),
									h("button", { className: "dsh-tavern-worldbook-del", disabled: guideBusy, onClick: function () { removeGuide(guide, index); } }, "删除")
								);
								}) : h("div", { className: "dsh-tavern-status-empty" }, "暂无 Guide。添加后会自动注入正文和候选项生成。")
						),
						h("div", { className: "dsh-tavern-guide-actions" },
							h("button", { type: "button", className: "dsh-tavern-btn", onClick: function () { props.openStyleTab("dsh-tavern:guide-library"); } }, "打开 Guide 库 ↗"),
							h("button", { type: "button", className: "dsh-tavern-btn", disabled: guideBusy || !(view.guides || []).length, onClick: saveGuideLibrary }, "保存到 Guide 库")),
						guideNotice ? h("p", { role: "status", className: "dsh-tavern-settings-desc" }, guideNotice) : null,
                        h("div", { className: "dsh-tavern-guide-add" },
                        	h("textarea", { className: "dsh-tavern-regen-input", ref: guideInputRef, rows: 2, maxLength: 2000, "aria-label": "新 Guide 内容", value: guideDraft, placeholder: "例如：多用短句，多写心理活动，对话不要超过三句", onChange: function (e) { setGuideDraft(e.target.value); } }),
							h("button", { className: "dsh-card-primary", disabled: guideBusy || guideDraft.trim() === "", onClick: addGuide }, guideBusy ? "保存中…" : "添加 Guide")
						),
						guideError ? h("div", { className: "dsh-card-error" }, guideError) : null
					),
					h("section", { className: "dsh-tavern-status-section" },
						h("div", { className: "dsh-tavern-character-design-head" },
                            h("div", { className: "dsh-tavern-status-label" }, "人物设计档案（" + ((view.characterDesigns && view.characterDesigns.characters || []).length) + "）"),
                            h("button", { className: "dsh-tavern-btn", disabled: running || view.activity?.busy || view.characterDesignTask?.status === "running", onClick: () => designCharacter(view.characterDesignTask?.status === "failed" ? view.characterDesignTask.guidance : "") }, view.characterDesignTask?.status === "running" ? "设计中…" : view.characterDesignTask?.status === "failed" ? "重试设计" : "设计人物")),
                        view.characterDesignTask?.status === "failed" ? h("div", { className: "dsh-card-error", role: "alert" }, view.characterDesignTask.error) : null,
						h("div", { className: "dsh-tavern-character-designs" },
							(view.characterDesigns && view.characterDesigns.characters || []).length ? view.characterDesigns.characters.map(function (character, index) {
								const summary = character.identity || character.narrativeRole || "已建立完整人物设计";
								const aliases = Array.isArray(character.aliases) && character.aliases.length ? character.aliases.join("、") : "";
								return h("details", { key: character.name || index, className: "dsh-tavern-character-design" },
									h("summary", null,
										h("span", null,
											h("span", { className: "dsh-tavern-character-design-name" }, character.name),
											h("span", { className: "dsh-tavern-character-design-summary", title: summary }, summary)
									),
									character.updatedAt ? h("time", { className: "dsh-tavern-character-design-meta", dateTime: new Date(character.updatedAt).toISOString() }, characterDesignTime(character.updatedAt)) : h("span", { className: "dsh-tavern-character-design-meta" }, "查看")
								),
									h("div", { className: "dsh-tavern-character-design-body" },
										aliases ? h("div", { className: "dsh-tavern-character-design-row" }, h("b", null, "别名"), h("p", null, aliases)) : null,
										(character.sections || []).map(function (section) {
											return h("div", { key: section.key, className: "dsh-tavern-character-design-row" }, h("b", null, section.label), h("p", null, section.text));
										})
									)
								);
							}) : h("div", { className: "dsh-tavern-status-empty" }, "点击“设计人物”，按你的要求创建或补充档案。")
						)
					),
					h(TavernLedger, { sessionId: props.sessionId, ledger: view.ledger, ledgerTask: view.ledgerTask, busy: running || view.activity?.busy }),
					h("section", { className: "dsh-tavern-status-section" },
						h("div", { className: "dsh-tavern-status-label" }, "人物姿势"),
						view.posture ? h("div", { className: "dsh-tavern-status-now" }, view.posture) : h("div", { className: "dsh-tavern-status-empty" }, "等待第一轮状态结算")
						),
						h("section", { className: "dsh-tavern-status-section dsh-tavern-style-guide", "aria-label": "调整文风" },
						h("div", { className: "dsh-tavern-style-title" }, "想调整文风？"),
						h("button", { type: "button", onClick: function () { guideInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); guideInputRef.current?.focus({ preventScroll: true }); } }, h("span", null, "1. 当前故事"), h("small", null, "通过 Guide 调整后续写法")),
						h("button", { type: "button", onClick: function () { props.openStyleTab("dsh-tavern:user-profile"); } }, h("span", null, "2. 长期偏好"), h("small", null, "在用户画像中设置新游戏偏好")),
						h("button", { type: "button", disabled: running, onClick: function () { window.dispatchEvent(new CustomEvent("dsh-tavern-adjust-card-style", { detail: { card: view.card } })); } }, h("span", null, "3. 这张人物卡"), h("small", null, "交给卡片助手修改，再应用到当前游戏")),
						h("button", { type: "button", onClick: function () { props.openStyleTab("dsh-tavern:presets"); } }, h("span", null, "4. 导入预设"), h("small", null, "已有喜欢的预设？前往预设库"))
					)
				)
			);
		}

		function TavernCardAppDock(props) {
			const slotRef = React.useRef(null);
			const controllerRef = React.useRef(null);
			const presence = React.useSyncExternalStore(tavernCardAppPresence.subscribe, tavernCardAppPresence.inspect);
			React.useEffect(function () {
				if (!slotRef.current) return;
				const controller = createTavernCardAppDock({ document: document, slot: slotRef.current, sessionId: props.sessionId, onChange: tavernCardAppPresence.change });
				controllerRef.current = controller;
				return function () { controllerRef.current = null; controller.dispose(); };
			}, []);
			return React.createElement("section", { className: "dsh-tavern-status-section dsh-tavern-card-app-section", hidden: !presence.attached },
				React.createElement("div", { className: "dsh-tavern-card-app-head" },
					React.createElement("div", { className: "dsh-tavern-status-label" }, "人物卡应用"),
					React.createElement("button", { className: "dsh-tavern-btn", disabled: !presence.attached, onClick: function () { if (controllerRef.current) controllerRef.current.open(); } }, presence.attached ? "打开手机" : "恢复中…")
				),
				presence.recovering ? React.createElement("div", { className: "dsh-tavern-card-app-recovering", role: "status" }, "正在恢复人物卡应用…") : null,
				React.createElement("div", { ref: slotRef, className: "dsh-tavern-card-app-slot" })
			);
		}

		function TavernStatusTab(props) {
			const binding = React.useSyncExternalStore(
				function (listener) { return props.sessions.list.subscribe(listener); },
				function () { return props.sessions.binding(props.sessionId); },
				function () { return props.sessions.binding(props.sessionId); }
			);
			const h = React.createElement;
			if (!binding) return h("aside", { className: "dsh-tavern-status" },
				h("div", { className: "dsh-tavern-status-head" }, h("div", { className: "dsh-tavern-status-title" }, "酒馆状态")),
				h("div", { className: "dsh-tavern-status-body" }, h("div", { className: "dsh-tavern-status-empty" }, "正在连接当前会话…"))
			);
			function useSession(selector) {
				return React.useSyncExternalStore(
					function (listener) { return binding.session.subscribe(listener); },
					function () { return selector(binding.session.getSnapshot()); },
					function () { return selector(binding.session.getSnapshot()); }
				);
			}
			const chat = resolveConversationChatBinding(props.uiConversation, binding);
			function useChat(selector) {
				return React.useSyncExternalStore(
					function (listener) { return chat.subscribe(listener); },
					function () { return selector(chat.getSnapshot()); },
					function () { return selector(chat.getSnapshot()); }
				);
			}
			return h(TavernStatusPanel, { sessionId: props.sessionId, useSession: useSession, useChat: useChat, executeSlash: props.executeSlash, openStyleTab: props.openStyleTab });
		}

		const candidatePanel = { value: null, listeners: new Set() };
		function setCandidatePanel(value) {
            if (value) {
                const previous = candidatePanel.value;
                const sameChoices = previous && previous.sessionId === value.sessionId && previous.messageId === value.messageId && previous.phase === value.phase && JSON.stringify(previous.choices) === JSON.stringify(value.choices);
                value = Object.assign({}, value, { expanded: value.expanded ?? (sameChoices ? previous.expanded : value.phase === "error") });
            }
			candidatePanel.value = value;
			candidatePanel.listeners.forEach(function (listener) { listener(value); });
		}
		function useCandidatePanel() {
			return React.useSyncExternalStore(subscribeCandidatePanel, candidatePanelSnapshot, candidatePanelSnapshot);
		}
		function subscribeCandidatePanel(listener) {
			candidatePanel.listeners.add(listener);
			return function () { candidatePanel.listeners.delete(listener); };
		}
		function candidatePanelSnapshot() { return candidatePanel.value; }
		function readyCandidatePanel(sessionId, messageId, candidates) {
			const value = candidates && typeof candidates === "object" ? candidates : {};
			return {
				sessionId: sessionId,
				messageId: messageId,
				phase: "ready",
				choices: Array.isArray(value.choices) ? value.choices : [],
				traceSessionId: String(value.traceSessionId || ""),
				traceMode: value.traceMode === "continuable" ? "continuable" : "one-shot",
				error: ""
			};
		}
		function candidateRequestId() { return "candidate-request-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
		async function submitCandidateTask(sessionId, messageId, guidance) {
			const requestId = candidateRequestId();
			let lastError = null;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const controller = new AbortController();
				const timer = window.setTimeout(function () { controller.abort(); }, 2000);
				try {
					const result = await rpc("submitTask", { kind: "candidate", requestId: requestId, messageId: messageId, guidance: guidance || "" }, sessionId, { signal: controller.signal });
					const view = coordinationView(result, sessionId);
					tavernCoordination.setView(sessionId, view);
					return view.task;
				} catch (error) {
					lastError = error;
					const message = String(error && error.message || "");
					if (!(error && error.name === "AbortError") && !/failed to fetch|networkerror|signal timed out/i.test(message)) throw error;
				} finally { window.clearTimeout(timer); }
				await new Promise(function (resolve) { window.setTimeout(resolve, 250); });
			}
			tavernCoordination.invalidate(sessionId);
			throw lastError || new Error("持久任务提交失败");
		}

		const regenPanel = { value: null, listeners: new Set() };
		function setRegenPanel(value) {
			regenPanel.value = value;
			regenPanel.listeners.forEach(function (listener) { listener(value); });
		}
		function useRegenPanel() {
			const [value, setValue] = React.useState(regenPanel.value);
			React.useEffect(function () { regenPanel.listeners.add(setValue); return function () { regenPanel.listeners.delete(setValue); }; }, []);
			return value;
		}

		const candidateGuidePanel = { value: null, listeners: new Set() };
		function setCandidateGuidePanel(value) {
			candidateGuidePanel.value = value;
			candidateGuidePanel.listeners.forEach(function (listener) { listener(value); });
		}
		function useCandidateGuidePanel() {
			const [value, setValue] = React.useState(candidateGuidePanel.value);
			React.useEffect(function () { candidateGuidePanel.listeners.add(setValue); return function () { candidateGuidePanel.listeners.delete(setValue); }; }, []);
			return value;
		}

		async function submitBodyRegeneration(sessionId, panel, guidance, input) {
		const res = await rpc("regenBody", { guidance: String(guidance || "").trim(), input: String(input || "") }, sessionId);
		applyBodyRegenerationResult({ liveTavernView: liveTavernView, sessionId: sessionId, view: res.view });
			setCandidatePanel(null);
		}

		// A failed turn never committed a story round, so recovering it is not a
		// rollback: remove the interrupted reply and resend the same input, which
		// lets the provider reuse the cached prompt prefix.
		async function submitFailedTurnReplay(sessionId) {
			const res = await rpc("replayTurn", {}, sessionId);
			applyBodyRegenerationResult({ liveTavernView: liveTavernView, sessionId: sessionId, view: res.view });
			setRegenPanel(null);
			setCandidatePanel(null);
			setCandidateGuidePanel(null);
			notifyTavernDataChanged(["sessions"], "play-controls");
			tavernCoordination.invalidate(sessionId);
			return res;
		}

		function CandidateAction(props) {
			const [busy, setBusy] = React.useState(false);
			const candidatePanelState = useCandidatePanel();
			const regenPanelState = useRegenPanel();
			const sessionMode = useTavernSessionMode(props.sessionId);
			const frontRunning = props.useSession(function (snapshot) { return snapshot.running === true; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const rollbackViewState = useLiveTavernView(props.sessionId, String(frontRunning) + ":" + String(latestMessageId || ""));
			const activityState = useTavernCoordination(props.sessionId, String(frontRunning) + ":" + String(latestMessageId || ""));
			const activity = describeTavernActivity(activityState.view && activityState.view.activity);
			const settlementActive = activity.role === "settlement" && (activity.phase === "pending" || activity.phase === "running");
			const canRollback = rollbackViewState.view && (rollbackViewState.view.canRegenerate ?? rollbackViewState.view.canRollback) === true;
            const clearIncomplete = rollbackViewState.view && rollbackViewState.view.canClearIncompleteReply === true;
			const canReplayFailed = rollbackViewState.view && rollbackViewState.view.canReplayFailedTurn === true;
			const candidateTask = activityState.view && activityState.view.task;
			const taskForMessage = candidateTask && candidateTask.kind === "candidate" && candidateTask.input && String(candidateTask.input.messageId || "") === String(props.messageId || "") ? candidateTask : null;
			const taskBusy = !!(taskForMessage && taskForMessage.busy);
			const regenBusy = regenPanelState !== null && regenPanelState.sessionId === props.sessionId && regenPanelState.phase === "loading";
			const [replayBusy, setReplayBusy] = React.useState(false);
			const projectedTaskRef = React.useRef("");
			React.useEffect(function () {
				if (!taskForMessage) return;
				const projection = String(taskForMessage.taskId || "") + ":" + String(taskForMessage.version || 0) + ":" + String(taskForMessage.status || "");
				if (projectedTaskRef.current === projection) return;
				projectedTaskRef.current = projection;
				if (taskForMessage.busy) {
					setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "loading", choices: [], error: "" });
					return;
				}
				if (taskForMessage.status === "succeeded" && taskForMessage.result && taskForMessage.result.candidates) {
					setCandidatePanel(readyCandidatePanel(props.sessionId, props.messageId, taskForMessage.result.candidates));
					setCandidateGuidePanel(null);
					return;
				}
				if (taskForMessage.terminal) {
					setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "error", choices: [], error: String(taskForMessage.error || "候选生成未完成") });
				}
			}, [props.sessionId, props.messageId, taskForMessage && taskForMessage.taskId, taskForMessage && taskForMessage.version, taskForMessage && taskForMessage.status]);
			const reconciledActivityRef = React.useRef("");
			React.useEffect(function () {
				if (!activityState.view || activity.busy) return;
				const revision = activity.phase + ":" + String(activityState.view.updatedAt || 0);
				if (reconciledActivityRef.current === revision) return;
				reconciledActivityRef.current = revision;
				liveTavernView.invalidate(props.sessionId);
				if (typeof props.refreshSessions === "function") Promise.resolve(props.refreshSessions()).catch(function () { });
			}, [props.sessionId, props.refreshSessions, activity.phase, activity.busy, activityState.view && activityState.view.updatedAt]);
			async function generate(force, guidance) {
				if (busy || activity.busy) return;
				setBusy(true);
				setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "loading", choices: [], error: "" });
				try {
					await submitCandidateTask(props.sessionId, props.messageId, guidance);
				} catch (err) { tavernErrorHub.report("候选项生成", err); setCandidatePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "error", choices: [], error: String(err && err.message || err) }); }
				finally { setBusy(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }
			}
			function regenerationPanelFor(event, phase) {
			return { sessionId: props.sessionId, phase: phase, guidance: "", text: "", error: "", openedAt: Date.now() };
			}
			function openRegeneration(event) {
				if (!canRollback || frontRunning || (activity.busy && !settlementActive) || regenBusy) return;
				setCandidatePanel(null);
				setRegenPanel(regenerationPanelFor(event, "input"));
			}
			// A failed tail has nothing to replace: one click clears the
			// interrupted reply and replays the same request, so no guidance box.
			async function replayFailed() {
				if (!canReplayFailed || frontRunning || replayBusy) return;
				setReplayBusy(true);
				try { await submitFailedTurnReplay(props.sessionId); }
				catch (err) { tavernErrorHub.report("重新生成本轮", err); }
				finally { setReplayBusy(false); liveTavernView.invalidate(props.sessionId); }
			}
			const h = React.createElement;
			const isScript = sessionMode === "script";
			const hasReadyPanel = candidatePanelState !== null && candidatePanelState.sessionId === props.sessionId && candidatePanelState.messageId === props.messageId && candidatePanelState.phase === "ready";
			const hasLoadingPanel = candidatePanelState !== null && candidatePanelState.sessionId === props.sessionId && candidatePanelState.messageId === props.messageId && candidatePanelState.phase === "loading";
			if (!isPlayMode(sessionMode) || latestMessageId !== props.messageId) return null;
			return h(React.Fragment, null,
				h("button", {
					className: "dsh-tavern-choice-trigger", disabled: busy || taskBusy || activity.busy || settlementActive || regenBusy, title: settlementActive ? "当前正文正在后台结算，请等待完成" : (activity.busy ? activity.blockReason : (hasReadyPanel ? "重新生成候选项（可先填写意见）" : (isScript ? "手动生成候选项；由于跟随剧本，只有一个推荐候选项" : "手动生成候选项"))), onClick: function () {
					setRegenPanel(null);
					if (hasReadyPanel) {
						const previous = candidatePanelState;
						setCandidatePanel(null);
						setCandidateGuidePanel({ sessionId: props.sessionId, messageId: props.messageId, phase: "input", error: "", previous: previous });
					} else {
						generate(false);
					}
						}
					}, settlementActive ? "后台结算中…" : (activity.busy ? activity.label : ((busy || taskBusy) ? "生成中…" : (hasReadyPanel ? "重新生成候选项" : "生成候选项")))),
					(canReplayFailed || canRollback) ? h("button", { className: "dsh-tavern-choice-trigger", disabled: frontRunning || (!canReplayFailed && activity.busy && !settlementActive) || regenBusy || replayBusy, title: canReplayFailed ? "移除被中断的回复并原样重放本轮请求（复用模型缓存）" : (settlementActive ? "重新生成将取消当前正文的后台结算" : (activity.busy ? activity.blockReason : "可修改本轮输入或填写意见，再重新生成并替换当前正文")), onClick: canReplayFailed ? replayFailed : openRegeneration }, replayBusy ? "重放中…" : regenBusy ? "重生成中…" : canReplayFailed ? "重新生成本轮" : "重新生成正文") : null
				);
			}

			// Spec §9.2/D4: variant switcher for the LAST assistant floor only.
			// ‹ n/m ›: left/right check out sibling branches; past the end = regenerate.
			function TavernVariantSwitcher(props) {
				const [busy, setBusy] = React.useState(false);
				const frontRunning = props.useSession(function (snapshot) { return snapshot.running === true; });
				const latestMessageId = props.useChat(latestTavernAssistantMessageId);
				const live = useLiveTavernView(props.sessionId, "variant:" + String(frontRunning) + ":" + String(latestMessageId || ""));
				const variantSwitch = live.view && live.view.variantSwitch;
				if (!variantSwitch || variantSwitch.available !== true || variantSwitch.count <= 1) return null;
				const selected = Math.max(0, Math.min(Number(variantSwitch.count) - 1, Number(variantSwitch.selected) || 0));
				const blocked = busy || frontRunning;
				async function switchTo(index) {
					if (blocked || index === selected) return;
					setBusy(true);
					try {
						const result = await rpc("switchVariant", { index: index }, props.sessionId);
						if (result && result.view) liveTavernView.setView(props.sessionId, result.view);
						liveTavernView.invalidate(props.sessionId);
						notifyTavernDataChanged(["sessions"], "variant-switch");
					} catch (err) { tavernErrorHub.report("切换变体", err); }
					finally { setBusy(false); }
				}
				function step(delta) {
					const next = selected + delta;
					if (next > Number(variantSwitch.count) - 1) return; // past-the-end = regenerate, handled by the regen button
					if (next < 0) return;
					switchTo(next);
				}
				const h = React.createElement;
				return h("div", { className: "dsh-tavern-variant-switcher", role: "group", "aria-label": "正文变体" },
					h("span", { className: "dsh-tavern-variant-label" }, "正文变体"),
					h("span", { className: "dsh-tavern-variant-arrows" },
						h("button", { type: "button", "aria-label": "上一个变体", disabled: blocked || selected <= 0, onClick: function () { step(-1); } }, "‹"),
						h("span", { className: "dsh-tavern-variant-index", title: "当前变体 / 全部变体" }, (selected + 1) + " / " + variantSwitch.count),
						h("button", { type: "button", "aria-label": "下一个变体", disabled: blocked || selected >= Number(variantSwitch.count) - 1, onClick: function () { step(1); } }, "›")
					)
			);
		}

		function TavernRollbackAction(props) {
			const [rolling, setRolling] = React.useState(false);
			const regenPanelState = useRegenPanel();
			const frontRunning = props.useSession(function (snapshot) { return snapshot.running === true; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const rollbackViewState = useLiveTavernView(props.sessionId, "rollback:" + String(frontRunning) + ":" + String(latestMessageId || ""));
			const activityState = useTavernCoordination(props.sessionId, "rollback:" + String(frontRunning) + ":" + String(latestMessageId || ""));
			const activity = describeTavernActivity(activityState.view && activityState.view.activity);
			const settlementActive = activity.role === "settlement" && (activity.phase === "pending" || activity.phase === "running");
			const canRollback = rollbackViewState.view && rollbackViewState.view.canRollback === true;
            const clearIncomplete = rollbackViewState.view && rollbackViewState.view.canClearIncompleteReply === true;
			const regenBusy = regenPanelState !== null && regenPanelState.sessionId === props.sessionId && regenPanelState.phase === "loading";
			const targetTurn = Number(rollbackViewState.view && rollbackViewState.view.rollbackTargetTurn) || 0;
            const targetLabel = targetTurn > 0 ? "回退第 " + targetTurn + " 轮" : "回退本轮";
			const blocked = rolling || frontRunning || regenBusy || activity.busy || settlementActive;
			async function rollback() {
				if (!canRollback || blocked) return;
				setRolling(true);
				try {
					const result = await rpc("rollbackTurn", { expectedTurn: clearIncomplete ? null : targetTurn }, props.sessionId);
					if (result && result.view) liveTavernView.setView(props.sessionId, result.view);
					setCandidatePanel(null);
					setRegenPanel(null);
					setCandidateGuidePanel(null);
					notifyTavernDataChanged(["sessions"], "play-controls");
					if (result && result.view && result.view.rollbackWarning) tavernErrorHub.report("回退提示", new Error(result.view.rollbackWarning));
				} catch (err) {
					tavernErrorHub.report("回退本轮", err);
				} finally { setRolling(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }
			}
			if (!canRollback) {
                const reason = rollbackViewState.view && rollbackViewState.view.rollbackUnavailableReason;
                return reason ? React.createElement("span", { role: "status", className: "dsh-tavern-muted" }, reason) : null;
            }
			return React.createElement("button", { className: "danger", role: "menuitem", disabled: blocked, title: blocked ? "请等待当前生成或后台处理完成后再回退" : clearIncomplete ? "清除未完成回复，保留已完成剧情" : "删除最近一次用户输入和这段 LLM 输出", onClick: rollback }, rolling ? "处理中…" : clearIncomplete ? "清除未完成回复" : targetLabel);
		}

        function TavernUndoRollbackAction(props) {
            const [busy, setBusy] = React.useState(false);
            const running = props.useSession(function (state) { return state.running === true; });
            const live = useLiveTavernView(props.sessionId, "undo:" + String(running));
            const turn = Number(live.view && live.view.undoRollbackTurn) || 0;
            if (!turn) return null;
            async function undo() {
                if (busy || running) return;
                setBusy(true);
                try {
                    const result = await rpc("undoRollbackTurn", {}, props.sessionId);
                    if (result && result.view) liveTavernView.setView(props.sessionId, result.view);
                    setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
                    notifyTavernDataChanged(["sessions"], "play-controls");
                } catch (error) { tavernErrorHub.report("撤销回退", error); }
                finally { setBusy(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }
            }
            return React.createElement("button", {
            	role: "menuitem", disabled: busy || running, onClick: undo,
            	title: "恢复第 " + turn + " 轮正文和状态；新的操作会使此恢复点失效"
            }, busy ? "恢复中…" : "撤销回退（恢复第 " + turn + " 轮）");
        }

		const bodyEditPanel = { value: null, listeners: new Set() };
		function setBodyEditPanel(value) {
			bodyEditPanel.value = value;
			bodyEditPanel.listeners.forEach(function (listener) { listener(value); });
		}
		function useBodyEditPanel() {
			const [value, setValue] = React.useState(bodyEditPanel.value);
			React.useEffect(function () { bodyEditPanel.listeners.add(setValue); return function () { bodyEditPanel.listeners.delete(setValue); }; }, []);
			return value;
		}
		function TavernEditBodyAction(props) {
			const [busy, setBusy] = React.useState(false);
			const running = props.useSession(function (snapshot) { return snapshot.running === true; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const live = useLiveTavernView(props.sessionId, "edit:" + String(running) + ":" + String(latestMessageId));
			const coordination = useTavernCoordination(props.sessionId, String(running));
			const activity = describeTavernActivity(coordination.view && coordination.view.activity);
			async function openEditor() {
				setBusy(true);
				try {
					const result = await rpc("getBodyEdit", {}, props.sessionId);
					setRegenPanel(null); setCandidatePanel(null); setCandidateGuidePanel(null);
					setBodyEditPanel({ sessionId: props.sessionId, edit: result.edit, texts: result.edit.parts.filter(function (part) { return part.kind === "text"; }).map(function (part) { return part.text; }), busy: false, error: "" });
				} catch (error) { tavernErrorHub.report("编辑正文", error); }
				finally { setBusy(false); }
			}
			if (!live.view || !(live.view.canEditBody ?? live.view.canRollback)) return null;
			return React.createElement("button", { role: "menuitem", disabled: busy || running || activity.busy, onClick: openEditor }, busy ? "读取中…" : "编辑正文");
		}
		function BodyEditPanel(props) {
			const panel = useBodyEditPanel();
			const running = props.useSession(function (snapshot) { return snapshot.running === true; });
			const h = React.createElement;
			if (!panel || panel.sessionId !== props.sessionId) return null;
			async function save() {
				setBodyEditPanel(Object.assign({}, panel, { busy: true, error: "" }));
				try {
					const result = await rpc("saveBodyEdit", { token: panel.edit.token, texts: panel.texts }, props.sessionId);
					liveTavernView.setView(props.sessionId, result.view);
					notifyTavernDataChanged(["sessions"], "play-controls");
					tavernCoordination.invalidate(props.sessionId);
					setBodyEditPanel(null);
				} catch (error) { setBodyEditPanel(Object.assign({}, panel, { busy: false, error: String(error.message || error) })); }
			}
			let textIndex = 0;
			return h("div", { className: "dsh-tavern-question", role: "region", "aria-label": "编辑正文" },
				h("div", { className: "dsh-tavern-question-head" }, h("span", null, "编辑正文")),
				panel.error ? h("div", { className: "dsh-tavern-choice-error", role: "alert" }, panel.error) : null,
				h("div", { style: { maxHeight: "50vh", overflowY: "auto" } }, panel.edit.parts.map(function (part, index) {
					if (part.kind === "html") return h("div", { key: index, className: "dsh-tavern-question-sub" }, "HTML 内容保持原样");
					if (part.kind !== "text") return null;
					const current = textIndex++;
					return h("textarea", {
						key: index, className: "dsh-tavern-regen-input", "aria-label": "正文文本 " + (current + 1), rows: Math.min(12, Math.max(3, panel.texts[current].split("\n").length)), value: panel.texts[current], disabled: panel.busy, onChange: function (event) {
						const texts = panel.texts.slice(); texts[current] = event.target.value;
						setBodyEditPanel(Object.assign({}, panel, { texts: texts }));
							}
						});
				})),
				h("div", { className: "dsh-tavern-question-foot" },
					h("button", { className: "dsh-tavern-question-primary", disabled: panel.busy || running, onClick: save }, panel.busy ? "保存中…" : "保存"),
					h("button", { className: "dsh-tavern-question-free", disabled: panel.busy, onClick: function () { setBodyEditPanel(null); } }, "取消")));
		}

        // @include modules/background-wait.js

		function TavernStopBackgroundAction(props) {
			const [busy, setBusy] = React.useState(false);
			const state = useTavernCoordination(props.sessionId);
			const activity = state.view && state.view.activity;
			if (!activity || (!activity.busy && activity.phase !== "pending")) return null;
			async function stop() {
				if (busy) return;
				setBusy(true);
				try {
					await rpc("stopBackground", { operationId: activity.operationId }, props.sessionId);
					liveTavernView.invalidate(props.sessionId);
					tavernCoordination.invalidate(props.sessionId);
				} catch (error) { tavernErrorHub.report("停止后台", error); }
				finally { setBusy(false); }
			}
			return React.createElement("button", { type: "button", className: "dsh-tavern-choice-trigger", role: props.inMenu ? "menuitem" : undefined, disabled: busy, onClick: stop }, busy ? "正在停止…" : "停止后台");
		}

        function TavernConversationPreset(props) {
            const h = React.createElement;
            const [data, setData] = React.useState(null);
            const [error, setError] = React.useState("");
            const [busy, setBusy] = React.useState(false);
            const [notice, setNotice] = React.useState("");
            async function refresh() {
                const [catalog, session] = await Promise.all([rpc("listPresets", {}, props.sessionId), rpc("getSession", {}, props.sessionId)]);
                setData({ presets: catalog.presets || [], current: session.view?.runtimePreset });
            }
            React.useEffect(() => { refresh().catch(err => setError(String(err.message || err))); }, []);
            async function change(path) {
                setBusy(true); setError(""); setNotice("");
                try { await rpc("applyConversationPreset", { sessionId: props.sessionId, path }, props.sessionId); await refresh(); setNotice("已保存"); liveTavernView.invalidate(props.sessionId); notifyTavernDataChanged(["presets", "sessions"], "presets"); }
                catch (err) { setError(String(err.message || err)); }
                finally { setBusy(false); }
            }
            return h("div", { className: "dsh-local-field" }, h("label", null, "当前预设", h("select", { className: "dsh-tavern-settings-select", "aria-label": "本局预设", value: data?.current?.id || "", disabled: busy || !data, onChange: event => change(event.target.value) },
                h("option", { value: "" }, "不使用外部预设"),
                data?.current?.id && !data.presets.some(p => p.path === data.current.id) ? h("option", { value: data.current.id }, data.current.name + "（源文件已移除）") : null,
                (data?.presets || []).filter(p => p.valid && p.recognized).map(p => h("option", { key: p.path, value: p.path }, p.title)))),
                h("p", { className: "dsh-tavern-settings-desc" }, "用于后续正文，选择后自动保存。"), error ? h("p", { role: "alert" }, "保存失败：" + error) : h("span", { role: "status", className: "dsh-local-feedback" }, busy ? "保存中…" : notice));
        }

        function TavernLocalPlayerName(props) {
            const [name, setName] = React.useState(null), [busy, setBusy] = React.useState(false), [status, setStatus] = React.useState("");
            React.useEffect(() => { let active = true; rpc("getSession", {}, props.sessionId).then(result => { if (active) setName(result.view?.playerName || "你"); }, err => { if (active) setStatus("读取失败：" + err.message); }); return () => { active = false; }; }, []);
            async function save(value) {
                if (busy || value === name) return;
                setBusy(true); setStatus("保存中…");
                try { const result = await rpc("setPlayerName", { userName: value }, props.sessionId); setName(result.playerName || "你"); setStatus("已保存"); liveTavernView.invalidate(props.sessionId); notifyTavernDataChanged(["sessions"], "play-controls"); }
                catch (err) { setStatus("保存失败：" + err.message); }
                finally { setBusy(false); }
            }
            return React.createElement("div", { className: "dsh-local-field" },
                React.createElement("label", null, "玩家称呼", React.createElement("input", { key: name, defaultValue: name || "", placeholder: "你", maxLength: 80, disabled: name === null || busy, onBlur: event => save(event.target.value), onKeyDown: event => { if (event.key === "Enter" && !event.nativeEvent?.isComposing) event.currentTarget.blur(); } })),
                React.createElement("p", { className: "dsh-local-help" }, "离开输入框后保存，仅用于后续内容。"), React.createElement("span", { role: "status", className: "dsh-local-feedback" }, status));
        }

        function TavernStatusBarSetting(props) {
            const h = React.createElement;
            const state = useLiveTavernView(props.sessionId, "status-bar-setting");
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState("");
            async function change(placement) {
                setBusy(true); setError("");
                try {
                    await rpc("setStatusBarPlacement", { placement: placement }, props.sessionId);
                    liveTavernView.invalidate(props.sessionId);
                } catch (err) { setError(String(err.message || err)); }
                finally { setBusy(false); }
            }
            return h("div", { className: "dsh-local-field" },
            	h("label", null, "状态栏位置", h("select", {
            		className: "dsh-tavern-settings-select", "aria-label": "状态栏位置",
            		value: state.view?.statusBarPlacement || "sidebar", disabled: busy || !state.view, onChange: event => change(event.target.value)
            	},
                    h("option", { value: "sidebar" }, "侧边栏"), h("option", { value: "body" }, "正文下方"))),
                error ? h("p", { role: "alert" }, "保存失败：" + error) : null);
        }

        function TavernConversationSettingsTab(props) {
            const h = React.createElement;
            const owner = props.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
            const mode = useTavernSessionMode(owner);
            return h("aside", { className: "dsh-tavern-status dsh-local-settings", "aria-label": "本局设置" },
                h("div", { className: "dsh-tavern-status-head" }, h("strong", null, "本局设置")),
                h("div", { className: "dsh-tavern-status-body" }, isPlayMode(mode) ? h(React.Fragment, null,
                    h("p", { className: "dsh-local-intro" }, "仅影响本局，修改后自动保存，已有对话和变量会保留。"),
                    h("p", { className: "dsh-local-warning dsh-local-intro" }, "切换预设、长期偏好、模型、结算或联网搜索后，下一次请求要重建缓存，耗时和费用会增加。"),
                    h("section", { className: "dsh-local-section" }, h("h3", null, "游玩"),
                        h(TavernLocalPlayerName, { key: owner + ":name", sessionId: owner }),
                        h(TavernConversationPreset, { key: owner + ":preset", sessionId: owner }),
                        h(UserPreferenceProfileTab, { key: owner + ":profile", scope: { sessionId: owner }, conversationOnly: true }),
                        h(TavernStatusBarSetting, { key: owner + ":status", sessionId: owner })),
                    h(TavernConversationBackgroundModel, { key: owner, sessionId: owner }),
                    h("details", { className: "dsh-local-advanced" }, h("summary", null, "高级"),
                        h(TavernConversationWritingSkills, { key: owner + ":skills", sessionId: owner }))) : h("p", null, "请选择一个游玩对话。")));
        }

        function TavernConversationSettingsAction(props) {
            const owner = props.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
            const mode = useTavernSessionMode(owner);
            if (!isPlayMode(mode)) return null;
            return React.createElement("button", { type: "button", className: "dsh-tavern-btn dsh-tavern-header-settings", "aria-label": "酒馆状态", title: "查看本局酒馆状态", onClick: () => props.open(owner) },
                React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", "aria-hidden": "true" },
                    React.createElement("path", { d: "M4 7h3m4 0h9M4 17h9m4 0h3" }),
                    React.createElement("circle", { cx: 9, cy: 7, r: 2 }), React.createElement("circle", { cx: 15, cy: 17, r: 2 })),
                React.createElement("span", { className: "dsh-tavern-header-action-label" }, "酒馆状态"));
        }

        function TavernConversationBackgroundModel(props) {
            const h = React.createElement;
            const [catalog, setCatalog] = React.useState([]);
            const [selection, setSelection] = React.useState(null);
            const [tasks, setTasks] = React.useState({ variables: true, posture: true, characterDesign: false, variableFeedback: true });
            const [saved, setSaved] = React.useState(null);
            const [features, setFeatures] = React.useState({ webSearchEnabled: false, sceneImagesEnabled: false, sceneImagesAvailable: false, mvuCard: false });
            const [loaded, setLoaded] = React.useState(false);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState("");
            const [notice, setNotice] = React.useState("");
            const [reasoning, setReasoning] = React.useState({ key: "", value: null, error: "" });
            const [imageSelection, setImageSelection] = React.useState(null);
            const [imageReasoning, setImageReasoning] = React.useState({ key: "", value: null });
            const key = selection ? JSON.stringify({ provider: selection.provider, model: selection.model }) : "";
            const imageKey = imageSelection ? JSON.stringify({ provider: imageSelection.provider, model: imageSelection.model }) : "";
            async function load() {
                setError("");
                try {
                    const result = await rpc("getConversationBackgroundConfig", { sessionId: props.sessionId }, props.sessionId);
                    setCatalog(result.modelCatalog || []); setSelection(result.backgroundModel); setSaved(result.backgroundModel); setImageSelection(result.imageModel || null);
                    setTasks(result.backgroundTasks); setFeatures({ webSearchEnabled: result.webSearchEnabled === true, sceneImagesEnabled: result.sceneImagesEnabled === true, sceneImagesAvailable: result.sceneImagesAvailable === true, mvuCard: result.mvuCard === true }); setLoaded(true);
                } catch (err) { setError(String(err.message || err)); }
            }
            React.useEffect(() => { void load(); }, []);
            React.useEffect(() => {
                let active = true;
                if (key) rpc("getBackgroundModelReasoning", JSON.parse(key), props.sessionId).then(result => {
                    if (active) setReasoning({ key, value: result.reasoning, error: "" });
                }, err => { if (active) setReasoning({ key, value: null, error: String(err.message || err) }); });
                return () => { active = false; };
            }, [key]);
            React.useEffect(() => {
                let active = true;
                if (imageKey) rpc("getBackgroundModelReasoning", JSON.parse(imageKey), props.sessionId).then(result => {
                    if (active) setImageReasoning({ key: imageKey, value: result.reasoning });
                }, () => { if (active) setImageReasoning({ key: imageKey, value: null }); });
                return () => { active = false; };
            }, [imageKey]);
            async function save(patch) {
                if (busy || !loaded) return;
                setBusy(true); setError(""); setNotice("");
                try {
                    const result = await rpc("setConversationBackgroundConfig", Object.assign({ sessionId: props.sessionId, backgroundModel: selection }, patch), props.sessionId);
                    setSaved(result.backgroundModel); setSelection(result.backgroundModel); setImageSelection(result.imageModel || null); setTasks(result.backgroundTasks); setFeatures({ ...features, webSearchEnabled: result.webSearchEnabled, sceneImagesEnabled: result.sceneImagesEnabled });
                    setNotice("已保存");
                    window.dispatchEvent(new CustomEvent("dsh-tavern-image-settings-changed"));
                    liveTavernView.invalidate(props.sessionId);
                } catch (err) { setError(String(err.message || err)); }
                finally { setBusy(false); }
            }
            const efforts = reasoning.key === key ? reasoning.value?.efforts || [] : [];
            const imageEfforts = imageReasoning.key === imageKey ? imageReasoning.value?.efforts || [] : [];
            const imageKnown = !imageSelection || catalog.some(group => group.provider === imageSelection.provider && group.models.some(model => model.id === imageSelection.model));
            const modelOptions = () => catalog.map(group => h("optgroup", { key: group.provider, label: group.providerName || group.provider }, group.models.map(model => h("option", { key: model.id, value: JSON.stringify({ provider: group.provider, model: model.id }) }, model.name || model.id))));
            const known = !selection || catalog.some(group => group.provider === selection.provider && group.models.some(model => model.id === selection.model));
            const toggle = (name, title, description, checked, patch) => h("label", { key: name, className: "dsh-tavern-background-task" },
                h("span", null, title, h("span", { className: "dsh-tavern-settings-desc" }, description)),
                h("input", { type: "checkbox", role: "switch", "aria-label": title, checked, disabled: !loaded || busy, onChange: event => save(patch(event.target.checked)) }));
            return h("div", { className: "dsh-local-runtime" },
                h("section", { className: "dsh-local-section" }, h("h3", null, "模型"),
                    h("p", { className: "dsh-tavern-settings-desc" }, "下一次后台任务生效。建议 High 推理强度；Max 容易过度思考、增加等待。"),
                    h("label", null, "后台模型", h("select", { "aria-label": "本局后台模型", className: "dsh-tavern-settings-select", value: key, disabled: !loaded || busy, onChange: event => { return save({ backgroundModel: event.target.value ? JSON.parse(event.target.value) : null }); } },
                        h("option", { value: "" }, "跟随前台"),
                        !known ? h("option", { value: key }, backgroundModelLabel(selection, catalog) + "（当前不可用）") : null,
                        modelOptions())),
                    h("label", null, "推理强度", h("select", { "aria-label": "本局后台推理强度", className: "dsh-tavern-settings-select", value: selection?.reasoningEffort || "", disabled: !key || !efforts.length || busy, onChange: event => { const next = { ...selection }; if (event.target.value) next.reasoningEffort = event.target.value; else delete next.reasoningEffort; return save({ backgroundModel: next }); } },
                        h("option", { value: "" }, key ? "模型默认" : "跟随前台"), efforts.map(item => h("option", { key: item.id, value: item.id }, item.name || item.id)))),
                    features.sceneImagesAvailable ? h("label", null, "生图 Agent 模型", h("select", { "aria-label": "本局生图 Agent 模型", className: "dsh-tavern-settings-select", value: imageKey, disabled: !loaded || busy, onChange: event => { return save({ imageModel: event.target.value ? JSON.parse(event.target.value) : null }); } },
                        h("option", { value: "" }, "跟随前台（最低推理强度）"),
                        !imageKnown ? h("option", { value: imageKey }, backgroundModelLabel(imageSelection, catalog) + "（当前不可用）") : null,
                        modelOptions())) : null,
                    features.sceneImagesAvailable && imageKey ? h("label", null, "生图推理强度", h("select", { "aria-label": "本局生图 Agent 推理强度", className: "dsh-tavern-settings-select", value: imageSelection?.reasoningEffort || "", disabled: !imageEfforts.length || busy, onChange: event => { const next = { ...imageSelection }; if (event.target.value) next.reasoningEffort = event.target.value; else delete next.reasoningEffort; return save({ imageModel: next }); } },
                        h("option", { value: "" }, "模型默认"), imageEfforts.map(item => h("option", { key: item.id, value: item.id }, item.name || item.id)))) : null),
                h("section", { className: "dsh-local-section" }, h("h3", null, "功能"),
                    features.mvuCard ? toggle("variables", "变量结算", "关闭后变量和状态栏不再更新。", tasks.variables, checked => ({ backgroundTasks: { variables: checked } })) : null,
                    toggle("variableFeedback", "变量回灌前台", "每轮把上一轮变化的变量最新值告诉前台，减少时间、地点、数值前后不一致。", tasks.variableFeedback, checked => ({ backgroundTasks: { variableFeedback: checked } })),
                    toggle("posture", "人物姿势", "每轮总结人物的位置、动作和姿势，供前台保持一致。", tasks.posture, checked => ({ backgroundTasks: { posture: checked } })),
                    toggle("webSearchEnabled", "联网搜索", "前台和后台可按需搜索。", features.webSearchEnabled, checked => ({ webSearchEnabled: checked }))),
                error || key && reasoning.key === key && reasoning.error ? h("p", { role: "alert", className: "dsh-tavern-prompt-error" }, error || reasoning.error) : null,
                notice ? h("p", { role: "status" }, notice) : null,
                !loaded && error ? h("button", { className: "dsh-tavern-btn", onClick: load }, "重试") : null,
                h("div", { role: "status", className: "dsh-local-feedback" }, busy ? "保存中…" : ""));
        }

		function TavernMoreActions(props) {
			const [open, setOpen] = React.useState(false);
			const [placement, setPlacement] = React.useState(null);
			const root = React.useRef(null);
			const trigger = React.useRef(null);
			// The mobile composer seat scrolls (overflow-y: auto), which clipped an absolutely
			// positioned menu to a thin strip. Anchor it to the viewport above the trigger instead.
			React.useLayoutEffect(function () {
				if (!open) { setPlacement(null); return; }
				function place() {
					const rect = trigger.current && trigger.current.getBoundingClientRect();
					if (!rect) return;
					const width = document.documentElement.clientWidth || window.innerWidth;
					setPlacement({ position: "fixed", top: "auto", left: "auto", right: Math.max(8, width - rect.right) + "px", bottom: (window.innerHeight - rect.top + 6) + "px", maxHeight: Math.max(120, rect.top - 12) + "px", overflowY: "auto" });
				}
				place();
				window.addEventListener("resize", place);
				if (window.visualViewport) window.visualViewport.addEventListener("resize", place);
				return function () { window.removeEventListener("resize", place); if (window.visualViewport) window.visualViewport.removeEventListener("resize", place); };
			}, [open]);
			React.useEffect(function () {
				if (!open) return;
				function closeOutside(event) { if (!root.current || !root.current.contains(event.target)) setOpen(false); }
				function closeOnEscape(event) { if (event.key === "Escape") setOpen(false); }
				document.addEventListener("pointerdown", closeOutside, true);
				document.addEventListener("keydown", closeOnEscape);
				return function () { document.removeEventListener("pointerdown", closeOutside, true); document.removeEventListener("keydown", closeOnEscape); };
			}, [open]);
			return React.createElement("div", { className: "dsh-tavern-more-actions", ref: root },
				React.createElement("button", { ref: trigger, type: "button", className: "dsh-tavern-choice-trigger", "aria-haspopup": "menu", "aria-expanded": open, onClick: function () { setOpen(function (value) { return !value; }); } }, "更多 ▾"),
				React.createElement("div", { className: "dsh-tavern-more-menu", role: "menu", hidden: !open, style: placement || undefined, onClick: function (event) { if (event.target && event.target.closest && event.target.closest("button:not(:disabled)")) setOpen(false); } },
                    React.createElement(TavernStopBackgroundAction, Object.assign({}, props, { inMenu: true })),
                    React.createElement(TavernVariantSwitcher, props),
					React.createElement(TavernEditBodyAction, props),
					React.createElement(TavernRollbackAction, props),
                    React.createElement(TavernUndoRollbackAction, props),
					React.createElement(TavernCompactionAction, Object.assign({}, props, { inMenu: true })))
			);
		}

		function CandidateDockActions(props) {
			const address = props.sessions && props.sessions.subagentAddress(props.sessionId);
			const ownerSessionId = address ? address.parentSessionId : props.sessionId;
			const sessionMode = useTavernSessionMode(ownerSessionId);
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const running = props.useSession(function (snapshot) { return snapshot.running === true; });
			const live = useLiveTavernView(ownerSessionId, String(running) + ":" + String(latestMessageId || ""));
			const imageTurn = Number(live.view && live.view.latestAssistantTurn) || 0;
			const h = React.createElement;
			if (!sessionMode) return null;
			if (address) return isPlayMode(sessionMode) ? h("div", { className: "dsh-tavern-dock-actions" }, h(TavernStopBackgroundAction, { sessionId: ownerSessionId })) : null;
			return h("div", { className: "dsh-tavern-dock-actions" },
				isPlayMode(sessionMode) && latestMessageId ? React.createElement(CandidateAction, Object.assign({}, props, { messageId: latestMessageId })) : null,
				isPlayMode(sessionMode) ? React.createElement(TavernMoreActions, props) : React.createElement(TavernCompactionAction, props),
                live.view && live.view.contextCompaction && (live.view.contextCompaction.warning || live.view.contextCompaction.operation && live.view.contextCompaction.operation.status === "running") ? h("span", { role: "status", className: "dsh-tavern-settings-desc" }, live.view.contextCompaction.warning || "正在压缩前后台上下文…") : null
			);
		}

		function CandidateQuestion(props) {
            // 宿主输入器可由 textarea 升级为 contenteditable，两种入口共享聚焦与收起逻辑。
            const inputSelector = "[data-composer-card] :is(textarea, [contenteditable='true'])";
            const dismissMode = useCandidatePreferences();
			const panel = useCandidatePanel();
            const draft = props.useInput(snapshot => snapshot.draft);
            const draftRef = React.useRef(draft);
            draftRef.current = draft;
			const sessionMode = useTavernSessionMode(props.sessionId);
			const running = props.useSession(function (snapshot) { return snapshot.running; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const [added, setAdded] = React.useState([]);
            const expanded = Boolean(panel && panel.expanded);
            function setExpanded(value) {
                if (panel) setCandidatePanel(Object.assign({}, panel, { expanded: value }));
            }
            React.useEffect(() => { if (running && panel?.expanded) setExpanded(false); }, [running, panel]);
			React.useEffect(function () {
				if (typeof document === "undefined" || !panel?.expanded) return;
				function onComposerFocus(event) {
					// 手机开始手动输入就收起候选，给键盘上方的正文留出空间；面板编辑器不受影响。
					if (window.matchMedia(TAVERN_MOBILE_QUERY + ", (pointer: coarse)").matches && event.target?.matches(inputSelector)) setExpanded(false);
				}
				document.addEventListener("focusin", onComposerFocus);
				return function () { document.removeEventListener("focusin", onComposerFocus); };
			}, [panel]);
			React.useEffect(function () {
				setAdded([]);
			}, [panel?.choices]);

			if (panel && panel.sessionId === props.sessionId && panel.phase === "error") {
				return React.createElement("div", { className: "dsh-tavern-choice-error dsh-tavern-candidate-error-banner" },
					"候选项生成失败：" + (panel.error || "未知错误") + "。请点上方“生成候选项”重试。"
				);
			}
			if (!isPlayMode(sessionMode) || !panel || panel.sessionId !== props.sessionId || panel.messageId !== latestMessageId || running) {
				return null;
			}
			const h = React.createElement;
			const count = (panel.choices || []).length;
			const isScript = sessionMode === "script";
			const heading = "接下来的行动";
			const summary = panel.phase === "loading" ? "正在生成…" : (panel.error ? "生成失败" : (isScript ? "跟随剧本" : count + " 个"));
			return h("div", { className: "dsh-tavern-question dsh-tavern-candidate-question" + (expanded ? "" : " collapsed") },
				h("div", { className: "dsh-tavern-question-head", role: "button", tabIndex: 0, "aria-expanded": expanded ? "true" : "false", onClick: function () { setExpanded(!expanded); }, onKeyDown: function (event) { if (event.target === event.currentTarget && !event.isComposing && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setExpanded(!expanded); } } }, h("span", null, heading), h("span", { className: "dsh-tavern-question-sub" }, summary), h("button", { type: "button", className: "dsh-tavern-question-close", title: expanded ? "收起行动列表" : "展开行动列表", "aria-label": expanded ? "收起行动列表" : "展开行动列表", onClick: function (event) { event.stopPropagation(); setExpanded(!expanded); } }, expanded ? "⌃" : "⌄")),
				expanded && panel.phase === "loading" ? h("div", { className: "dsh-tavern-question-sub" }, "正在生成候选项…") : null,
				expanded && panel.error ? h("div", { className: "dsh-tavern-choice-error" }, "候选项生成失败，请点回复下方的“生成候选项”重试") : null,
				expanded ? h("div", { className: "dsh-tavern-question-body" }, (panel.choices || []).map(function (choice, index) {
					const item = choice !== null && typeof choice === "object" ? choice : { type: "action", text: String(choice) };
					// 点选项即追加到输入框，再点一次取消并从输入框移除；发送前仍可修改。
					const isAdded = added.includes(index);
					return h("button", { key: index, className: "dsh-tavern-question-option" + (isAdded ? " selected" : ""), "aria-pressed": isAdded, title: isAdded ? "从输入框移除" : "追加到输入框", onClick: function () {
						const marked = item.type === "scene" ? "【场景变化】" + item.text : item.text;
						const current = String(draftRef.current || "");
						let next;
						if (isAdded) {
							// 只移除原样追加的那一行；用户改过的文字保留不动。
							const lines = current.split("\n");
							const at = lines.lastIndexOf(marked);
							if (at >= 0) lines.splice(at, 1);
							next = lines.join("\n").replace(/^\n+|\n+$/g, "");
						} else next = current + (current && !current.endsWith("\n") ? "\n" : "") + marked;
						draftRef.current = next;
						props.inputActions.setDraft(next);
						if (!isAdded && dismissMode !== "after-send") setCandidatePanel(null);
						else setAdded(list => isAdded ? list.filter(value => value !== index) : list.concat(index));
					} },
						h("span", { className: "dsh-tavern-question-text" },
							item.type === "scene" ? h("span", { className: "dsh-tavern-question-tag dsh-tavern-question-tag-scene" }, "场景变化") : null,
							h("span", null, item.text)
						)
					);
				})) : null,
				expanded && panel.phase === "ready" && panel.traceSessionId ? h("button", {
					className: "dsh-tavern-question-free", title: panel.traceMode === "continuable" ? "打开持续存在的后台 Agent" : "打开后台候选任务的推理与工具调用记录", onClick: async function () {
						try {
							await props.sessions.refreshSubagents(panel.sessionId);
							props.sessions.openSubagent({ parentSessionId: panel.sessionId, childSessionId: panel.traceSessionId, mode: panel.traceMode });
						} catch (err) {
							tavernErrorHub.report("后台 Agent 轨迹", "无法打开后台 Agent 轨迹：" + String(err && err.message || err));
						}
					}
				}, panel.traceMode === "continuable" ? "查看后台 Agent" : "查看后台候选任务轨迹") : null
			);
		}

		function CandidateGuidePanel(props) {
			const panel = useCandidateGuidePanel();
			const sessionMode = useTavernSessionMode(props.sessionId);
			const running = props.useSession(function (snapshot) { return snapshot.running; });
			const latestMessageId = props.useChat(latestTavernAssistantMessageId);
			const [guidance, setGuidance] = React.useState("");
			const h = React.createElement;
			if (!isPlayMode(sessionMode) || running || !panel || panel.sessionId !== props.sessionId || panel.messageId !== latestMessageId) {
				return null;
			}
			const isScript = sessionMode === "script";
			async function generateGuided() {
				const guide = guidance.trim();
				const messageId = panel.messageId;
				setCandidateGuidePanel({ sessionId: props.sessionId, messageId: messageId, phase: "loading", error: "", previous: panel.previous });
				try {
					setCandidatePanel({ sessionId: props.sessionId, messageId: messageId, phase: "loading", choices: [], error: "" });
					await submitCandidateTask(props.sessionId, messageId, guide);
					setCandidateGuidePanel(null);
				} catch (err) {
					tavernErrorHub.report("候选项重新生成", err);
					setCandidateGuidePanel({ sessionId: props.sessionId, messageId: messageId, phase: "input", error: String(err && err.message || err), previous: panel.previous });
				}
			}
			function cancel() {
				setCandidateGuidePanel(null);
				if (panel.previous) setCandidatePanel(panel.previous);
			}
			const body = panel.phase === "loading"
				? h("div", { className: "dsh-tavern-question-sub" }, "正在重新生成候选项…")
				: h(React.Fragment, null,
					panel.error ? h("div", { className: "dsh-tavern-choice-error" }, panel.error) : null,
					h("textarea", {
						className: "dsh-tavern-regen-input",
						rows: 2,
						value: guidance,
						placeholder: isScript ? "对候选的要求（可选）：例如“侧重角色行动”“直接开新场景”" : "对候选的要求（可选）：例如“多点暧昧动作”“场景换到白天户外”“新场景换一批人物”",
						onChange: function (e) { setGuidance(e.target.value); }
					}),
					h("div", { className: "dsh-tavern-question-foot" },
						h("button", { className: "dsh-tavern-question-primary", disabled: panel.phase === "loading", onClick: generateGuided }, "按此意见重新生成"),
						h("button", { className: "dsh-tavern-question-free", onClick: cancel }, "取消")
					)
				);
			return h("div", { className: "dsh-tavern-question" },
				h("div", { className: "dsh-tavern-question-head" }, h("span", null, "重新生成候选项"), h("span", { className: "dsh-tavern-question-sub" }, isScript ? "可填写意见；由于跟随剧本，只会重新生成一个推荐候选项" : "可填写意见，行动候选与场景候选通用")),
				body
			);
		}

		// The last guidance per game, offered again when the player regenerates once more.
		const regenGuidance = new Map();
		function RegenPanel(props) {
			const panel = useRegenPanel();
			const sessionMode = useTavernSessionMode(props.sessionId);
			const running = props.useSession(function (snapshot) { return snapshot.running; });
			const [guidance, setGuidance] = React.useState(function () { return regenGuidance.get(props.sessionId) || ""; });
			const opened = panel && panel.sessionId === props.sessionId && panel.phase === "input";
			React.useEffect(function () { if (opened) setGuidance(regenGuidance.get(props.sessionId) || ""); }, [opened, props.sessionId]);
			// null = 本轮输入尚未读到；预填只在面板每次打开时拉取一次，
			// 后续 phase 更新不重置，避免覆盖用户正在编辑的文本。
			const [input, setInput] = React.useState(null);
			const panelKey = panel ? String(panel.sessionId) + ":" + String(panel.openedAt || "") : "";
			const h = React.createElement;
			React.useEffect(function () {
				if (panelKey === "") return;
				let alive = true;
				setInput(null);
				rpc("getRegenInput", {}, props.sessionId).then(function (res) {
					if (alive) setInput(String(res && res.input || ""));
				}).catch(function () {
					if (alive) setInput("");
				});
				return function () { alive = false; };
			}, [panelKey]);
			if (!isPlayMode(sessionMode) || running || !panel || panel.sessionId !== props.sessionId) return null;
			async function generate() {
				const guide = guidance.trim();
				if (guide) regenGuidance.set(props.sessionId, guide); else regenGuidance.delete(props.sessionId);
				setRegenPanel(Object.assign({}, panel, { phase: "loading", error: "", rewrite: guide !== "" }));
				try {
					await submitBodyRegeneration(props.sessionId, panel, guide, input === null ? "" : input);
					setRegenPanel(null);
				} catch (err) {
					tavernErrorHub.report("正文重新生成", err);
					setRegenPanel(Object.assign({}, panel, { phase: "error", error: String(err && err.message || err) }));
				}
			}
			const body = panel.phase === "loading"
				? h("div", { className: "dsh-tavern-question-sub" }, panel.rewrite ? "正在按意见改写正文…" : "正在重新生成正文…")
				: h(React.Fragment, null,
						panel.error ? h("div", { className: "dsh-tavern-choice-error" }, panel.error) : null,
						h("textarea", {
							className: "dsh-tavern-regen-input",
							rows: 3,
							value: input === null ? "" : input,
							placeholder: input === null ? "正在读取本轮输入…" : "本轮输入（可直接修改；留空或保持原样则不变）",
							onChange: function (e) { setInput(e.target.value); }
						}),
						h("textarea", {
							className: "dsh-tavern-regen-input",
							rows: 2,
							value: guidance,
							placeholder: "指导意见（可选）：例如“写得更长，侧重心理描写”",
							onChange: function (e) { setGuidance(e.target.value); }
						}),
						h("div", { className: "dsh-tavern-question-foot" },
							h("button", { className: "dsh-tavern-question-primary", disabled: panel.phase === "loading", onClick: generate }, "生成并替换正文"),
							h("button", { className: "dsh-tavern-question-free", onClick: function () { setRegenPanel(null); } }, "取消")
						)
					);
			return h("div", { className: "dsh-tavern-question" },
				h("div", { className: "dsh-tavern-question-head" }, h("span", null, "重新生成正文"), h("span", { className: "dsh-tavern-question-sub" }, "可先修改本轮输入再生成；不填意见是重新来一次，填了意见就在当前正文基础上改")),
				body
			);
		}
			// @include modules/story-view.js
        function tavernHeaderMenuButton(h, label, iconPath, disabled, onClick) {
            return h("button", { type: "button", role: "menuitem", disabled: disabled, onClick: onClick },
                h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, h("path", { d: iconPath })),
                label);
        }

        const TAVERN_HEADER_GEAR_PATH = "M12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z";

        // Width the shortcuts may use, read from the whole title row so it does
        // not depend on how many buttons are folded right now: the row, minus the
        // host's own buttons, minus a minimum share kept for the session title.
        function tavernHeaderAvailableWidth(node) {
            const row = node.closest("[class*=\"_titleRow\"]");
            if (!row) return node.clientWidth;
            const px = value => parseFloat(value) || 0;
            const rowStyle = window.getComputedStyle(row);
            let free = row.clientWidth - px(rowStyle.paddingLeft) - px(rowStyle.paddingRight);
            const children = Array.from(row.children).filter(child => window.getComputedStyle(child).display !== "none");
            free -= px(rowStyle.columnGap) * Math.max(0, children.length - 1);
            for (const child of children) {
                const style = window.getComputedStyle(child);
                free -= px(style.marginLeft) + px(style.marginRight);
                if (child.contains(node)) { free -= Math.max(0, child.offsetWidth - node.offsetWidth); continue; }
                if (/_titleCluster/.test(String(child.className))) {
                    // Everything in the cluster except the crumbs stays; the crumbs keep a minimum.
                    const parts = Array.from(child.children).filter(part => window.getComputedStyle(part).display !== "none");
                    free -= px(style.columnGap) * Math.max(0, parts.length - 1);
                    for (const part of parts) if (!/_crumbs/.test(String(part.className))) free -= part.offsetWidth;
                    free -= Math.min(160, row.clientWidth * 0.3);
                    continue;
                }
                free -= child.offsetWidth;
            }
            return Math.max(0, free);
        }

        // The 顶栏设置 entry in the ⋯ and right-click menus: the settings page's own
        // editor in a dialog, so it works without a host route to the settings page.
        function TavernHeaderSettingsDialog(props) {
            const h = React.createElement;
            React.useEffect(function () {
                function key(event) { if (event.key === "Escape") props.onClose(); }
                document.addEventListener("keydown", key);
                return function () { document.removeEventListener("keydown", key); };
            }, [props.onClose]);
            return require("react-dom").createPortal(h("div", { className: "dsh-tavern-header-dialog-backdrop", onPointerDown: function (event) { if (event.target === event.currentTarget) props.onClose(); } },
                h("div", { className: "dsh-tavern-header-dialog dsh-tavern-global-settings", role: "dialog", "aria-modal": "true", "aria-label": "顶栏设置" },
                    h("div", { className: "dsh-tavern-header-dialog-head" },
                        h("strong", null, "顶栏设置"),
                        h("button", { type: "button", className: "dsh-tavern-header-op", "aria-label": "关闭", title: "关闭", onClick: props.onClose }, "×")),
                    h(HeaderItemsSettings, { collapsible: false }))), document.body);
        }

        // One slot for every top-bar shortcut. 酒馆状态 and 导出 keep their own
        // components (the export one owns a menu); pinned pages open their tab.
        function TavernHeaderItems(props) {
            const h = React.createElement;
            const catalog = useTavernHeaderCatalog();
            const header = useTavernHeaderItems();
            // 手机/触屏顶栏只有一行：强制纯图标，并把快捷入口限制在上限内。
            // 存回设置时用用户自己选的形态，别把手机上的强制图标写进配置。
            const mobile = useTavernMobileHeader();
            const configuredDisplay = header.display === "icon" ? "icon" : "icon-text";
            const display = mobile ? "icon" : configuredDisplay;
            const items = header.items;
            const owner = props.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
            const [folded, setFolded] = React.useState([]);
            // 手机上最多保留几个快捷入口（按标题行宽实测，见下方 effect）。
            const [mobileLimit, setMobileLimit] = React.useState(TAVERN_HEADER_MOBILE_LIMIT);
            const [context, setContext] = React.useState(null);
            const [more, setMore] = React.useState(null);
            const [dialog, setDialog] = React.useState(false);
            const closeDialog = React.useCallback(function () { setDialog(false); }, []);
            const host = React.useRef(null);
            const widths = React.useRef(new Map());
            const measuredDisplay = React.useRef("");
            const entries = React.useMemo(function () {
                const map = new Map();
                map.set("header:export", { id: "header:export", label: "导出" });
                map.set("dsh-tavern:status", { id: "dsh-tavern:status", label: "酒馆状态" });
                catalog.forEach(entry => map.set(entry.id, entry));
                return map;
            }, [catalog]);
            const visible = items.filter(id => id === "dsh-tavern:status" || id === "header:export" || entries.has(id) || !catalog.length);
            const titleOf = id => (entries.get(id) || {}).label || id.replace(/^[^:]+:/, "");
            function saveHeader(next) {
                Promise.resolve(displayPreferences.save({ headerItems: next }))
                    .catch(error => tavernErrorHub.report("保存顶栏设置", error));
            }
            function move(id, delta) {
                const index = items.indexOf(id), target = index + delta;
                if (index < 0 || target < 0 || target >= items.length) return;
                const next = items.slice();
                [next[index], next[target]] = [next[target], next[index]];
                saveHeader({ display: configuredDisplay, items: next });
            }
            function remove(id) {
                saveHeader({ display: configuredDisplay, items: items.filter(value => value !== id) });
            }
            // Natural widths are cached: a folded button is display:none, so it
            // cannot be measured again until the display mode changes.
            React.useLayoutEffect(function () {
                // 手机上不量按钮宽度：容器会被 flex 压窄，量出来的「可用宽度」
                // 反而恒为够用，于是从不折叠。这里按固定上限折，其余全进 ⋮。
                if (mobile) {
                    const next = tavernHeaderMobileFold(visible, mobileLimit);
                    setFolded(current => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next);
                    return undefined;
                }
                setMobileLimit(TAVERN_HEADER_MOBILE_LIMIT);
                const node = host.current;
                if (!node) return undefined;
                let frame = 0;
                // Icon-only and labelled buttons have different widths; a cached
                // width from the other mode would fold the wrong pages.
                if (measuredDisplay.current !== display) { widths.current.clear(); measuredDisplay.current = display; }
                function measure() {
                    const buttons = Array.from(node.querySelectorAll("[data-header-item]"));
                    buttons.forEach(button => { button.style.display = "inline-flex"; });
                    for (const button of buttons) widths.current.set(button.dataset.headerItem, button.offsetWidth);
                    buttons.forEach(button => { button.style.display = ""; });
                    const sample = node.appendChild(document.createElement("button"));
                    sample.className = "dsh-tavern-btn dsh-tavern-header-more-button";
                    const style = window.getComputedStyle(node);
                    const gap = parseFloat(style.columnGap || style.gap) || 0;
                    const moreWidth = sample.offsetWidth + gap;
                    sample.remove();
                    // ⋯ appears only once something folds, so its width is reserved
                    // only then; the default bar looks exactly as it did before.
                    const available = tavernHeaderAvailableWidth(node);
                    const next = tavernHeaderFold(visible, id => widths.current.get(id) || 0, available, { gap: gap, fixed: TAVERN_HEADER_NOT_FOLDED, moreWidth: moreWidth });
                    setFolded(current => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next);
                }
                measure();
                if (typeof ResizeObserver !== "function") return undefined;
                const observer = new ResizeObserver(function () { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
                observer.observe(node);
                const row = node.closest("[class*=\"_titleRow\"]");
                if (row) observer.observe(row);
                return function () { observer.disconnect(); cancelAnimationFrame(frame); };
            }, [visible.join("|"), display, catalog, mobile, mobileLimit]);
            // 手机上按标题行宽算槽位：行宽减掉宿主自己的固定开销（见
            // tavernHeaderMobileChrome），剩下的按每格 42px 折算。行宽与当前保留
            // 数量无关，所以不会「收一个 → 标题变宽 → 又想放回」来回跳。
            React.useLayoutEffect(function () {
                if (!mobile) return undefined;
                let frame = window.requestAnimationFrame(function () {
                    const node = host.current;
                    if (!node) return;
                    const row = node.closest("[class*=\"_titleRow\"]");
                    const width = row ? row.clientWidth - tavernHeaderMobileChrome(row) : node.clientWidth;
                    const capacity = tavernHeaderMobileCapacity(visible.length, width, { limit: TAVERN_HEADER_MOBILE_LIMIT });
                    if (capacity !== mobileLimit) setMobileLimit(capacity);
                });
                return function () { window.cancelAnimationFrame(frame); };
            }, [mobile, mobileLimit, folded.join("|"), visible.join("|")]);
            React.useEffect(function () {
                if (!mobile) return undefined;
                let timer = 0;
                function onResize() {
                    window.clearTimeout(timer);
                    // 旋屏后回到上限重算，不该一直停在横屏时收窄的结果。
                    setMobileLimit(TAVERN_HEADER_MOBILE_LIMIT);
                    timer = window.setTimeout(function () { setMobileLimit(TAVERN_HEADER_MOBILE_LIMIT); }, 0);
                }
                window.addEventListener("resize", onResize);
                window.addEventListener("orientationchange", onResize);
                return function () {
                    window.clearTimeout(timer);
                    window.removeEventListener("resize", onResize);
                    window.removeEventListener("orientationchange", onResize);
                };
            }, [mobile]);
            React.useEffect(function () {
                if (!context && !more) return undefined;
                function close(event) {
                    const target = event && event.target;
                    if (target && target.closest && target.closest(".dsh-tavern-header-popup, [data-tavern-header-trigger]")) return;
                    setContext(null); setMore(null);
                }
                function key(event) { if (event.key === "Escape") close(); }
                document.addEventListener("pointerdown", close, true);
                document.addEventListener("keydown", key);
                window.addEventListener("scroll", close, true);
                return function () {
                    document.removeEventListener("pointerdown", close, true);
                    document.removeEventListener("keydown", key);
                    window.removeEventListener("scroll", close, true);
                };
            }, [context, more]);
            function activate(id, node) {
                setMore(null);
                if (id === "header:export") return;
                if (id === "dsh-tavern:status") { props.openStatus(owner); return; }
                // 世界书按钮弹出快捷面板（「完整」再进右侧栏世界书库）。
                if (id === "dsh-tavern:worldbooks" && node) { worldBookSwitcherFeature.open(node, owner); return; }
                openTavernSidebarTab(props.ctx, { type: id }, { sessionId: owner });
            }
            function item(id) {
                const entry = entries.get(id) || { id: id, label: titleOf(id) };
                const label = entry.label || titleOf(id);
                const content = id === "dsh-tavern:status"
                    ? h(TavernConversationSettingsAction, { sessionId: props.sessionId, sessions: props.sessions, open: props.openStatus })
                    : id === "header:export"
                        ? h(TavernConversationExportAction, { sessionId: props.sessionId, sessions: props.sessions })
                        : h("button", { type: "button", className: "dsh-tavern-btn dsh-tavern-header-page", title: label, "aria-label": label, onClick: function (event) { activate(id, event.currentTarget); } },
                            tavernStartIcon(id, entry, 18),
                            h("span", { className: "dsh-tavern-header-action-label" }, label));
                return h("span", {
                    key: id,
                    className: "dsh-tavern-header-item" + (folded.includes(id) ? " is-folded" : ""),
                    "data-header-item": id,
                    onContextMenu: function (event) { event.preventDefault(); setMore(null); setContext({ id: id, x: event.clientX, y: event.clientY }); }
                }, content);
            }
            const foldedEntries = folded.map(id => ({ id: id, label: titleOf(id) })).filter(entry => entry.id !== "header:export");
            return h("div", {
                ref: host,
                className: "dsh-tavern-header-items" + (display === "icon" ? " is-icon" : ""),
                // 手机上实测的保留上限；夹具与线上排查都读它。
                "data-tavern-header-limit": mobile ? mobileLimit : ""
            },
                visible.map(item),
                foldedEntries.length ? h("div", { className: "dsh-tavern-more-actions dsh-tavern-header-more" },
                    h("button", { type: "button", className: "dsh-tavern-btn dsh-tavern-header-more-button", "data-tavern-header-trigger": "more", "aria-label": "更多快捷入口", "aria-haspopup": "menu", "aria-expanded": Boolean(more), title: "更多快捷入口", onClick: function () { setContext(null); setMore(more ? null : { x: null, y: null }); } },
                        h("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", "aria-hidden": "true" }, h("path", { d: mobile ? "M12 5h.01M12 12h.01M12 19h.01" : "M5 12h.01M12 12h.01M19 12h.01" }))),
                    more ? h("div", { className: "dsh-tavern-more-menu dsh-tavern-header-popup", role: "menu", "aria-label": "更多快捷入口" },
                        foldedEntries.map(entry => h("button", { key: entry.id, type: "button", role: "menuitem", onClick: function () { setMore(null); activate(entry.id, host.current); } }, tavernStartIcon(entry.id, entries.get(entry.id), 15), entry.label)),
                        h("div", { className: "dsh-tavern-header-menu-sep", role: "separator" }),
                        tavernHeaderMenuButton(h, "顶栏设置…", TAVERN_HEADER_GEAR_PATH, false, function () { setMore(null); setDialog(true); })) : null) : null,
                context ? h("div", { className: "dsh-tavern-more-menu dsh-tavern-header-popup dsh-tavern-header-context", role: "menu", style: { position: "fixed", left: Math.min(context.x, (window.innerWidth || 1024) - 190) + "px", top: Math.min(context.y, (window.innerHeight || 768) - 190) + "px", right: "auto", bottom: "auto" } },
                    tavernHeaderMenuButton(h, "左移", "M15 6l-6 6 6 6", items.indexOf(context.id) <= 0, function () { setContext(null); move(context.id, -1); }),
                    tavernHeaderMenuButton(h, "右移", "M9 6l6 6-6 6", items.indexOf(context.id) >= items.length - 1, function () { setContext(null); move(context.id, 1); }),
                    tavernHeaderMenuButton(h, "移除", "M6 6l12 12M18 6L6 18", false, function () { setContext(null); remove(context.id); }),
                    h("div", { className: "dsh-tavern-header-menu-sep", role: "separator" }),
                    tavernHeaderMenuButton(h, "顶栏设置…", TAVERN_HEADER_GEAR_PATH, false, function () { setContext(null); setDialog(true); })) : null,
                dialog ? h(TavernHeaderSettingsDialog, { onClose: closeDialog }) : null);
        }

		function register(input) {
			const ctx = input.ctx;
			const slots = input.slots;
			const uiConversation = ctx.get("uiConversation") || ctx.get("conversation");
			const executeSlash = createTavernFrameSlashExecutor(ctx);
			ctx.effect(() => slots.inject("conversation.view", () => slots.register({
				name: "conversation.view", id: STORY_VIEW_ID, order: -10, label: "剧情",
				inject: function () { return { executeSlash: executeSlash, uiConversation: uiConversation, storySessions: ctx.sessions }; }
			}, TavernStoryView)), "dsh-tavern: story view");
			ctx.effect(function () {
				const list = ctx.sessions.list;
				function prefer() {
					const byId = list.getSnapshot().byId || {};
					for (const id of Object.keys(byId)) {
						const summary = byId[id];
						if (!summary || summary.parentId || summary.origin === "subagent" || id.startsWith("background-")) continue;
						preferStoryView(id);
					}
				}
				prefer();
				return list.subscribe(prefer);
			}, "dsh-tavern: story view default");
            ctx.effect(() => ctx.betterSidebar.registerTab({
                id: "dsh-tavern:conversation-settings", title: "本局设置", order: 8, single: true,
                component: props => React.createElement(TavernConversationSettingsTab, { sessionId: props.scope.sessionId, sessions: ctx.sessions })
            }), "dsh-tavern: conversation settings tab");
            // Replace shipped host chrome that is noise in the Tavern profile.
            // Same id + lower priority shadows the host entry (lowest renders).
            ctx.effect(() => slots.inject("conversation.session.header.actions", () => slots.register(
                { name: "conversation.session.header.actions", id: "agent-preset", order: -10, priority: -1 },
                () => null
            )), "dsh-tavern: hide host agent-preset label");
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                { name: "conversation.session.header.utilities", id: "open-in-app", order: -10, priority: -1 },
                () => null
            )), "dsh-tavern: hide host open-in-app");
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                { name: "conversation.session.header.utilities", id: "session-log-download", order: 0, priority: -1 },
                () => null
            )), "dsh-tavern: hide host session-log-download");
            ctx.effect(() => slots.inject("conversation.session.header.actions", () => slots.register(
                { name: "conversation.session.header.actions", id: "dsh-tavern-immersive", order: 9 },
                () => React.createElement(TavernImmersiveAction)
            )), "dsh-tavern: immersive header action");
            ctx.effect(() => slots.inject("conversation.session.header.utilities", () => slots.register(
                { name: "conversation.session.header.utilities", id: "dsh-tavern-header-items", order: 80 },
                function (props) {
                    const owner = ctx.sessions.subagentAddress(props.sessionId)?.parentSessionId || props.sessionId;
                    const mode = useTavernSessionMode(owner);
                    if (!mode) return null;
                    return React.createElement(TavernHeaderItems, Object.assign({}, props, { ctx: ctx, sessions: ctx.sessions, openStatus: sessionId => openTavernSidebarTab(ctx, { type: "dsh-tavern:status" }, { sessionId }) }));
                }
            )), "dsh-tavern: header items");
			ctx.effect(() => ctx.betterSidebar.registerTab({
				id: "dsh-tavern:status",
				title: "酒馆状态",
				order: 7,
				single: true,
				component: function (props) {
					return React.createElement(TavernStatusTab, { sessions: ctx.sessions, uiConversation: uiConversation, sessionId: props.scope.sessionId, executeSlash: executeSlash, openStyleTab: function (type) { openTavernSidebarTab(ctx, { type: type }, { sessionId: props.scope.sessionId }); } });
				}
			}), "dsh-tavern: Better Sidebar status tab");
			ctx.effect(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-candidate-actions", order: -130, label: "候选项操作" },
				function (props) {
					return React.createElement(CandidateDockActions, Object.assign({}, props, {
					sessions: ctx.sessions,
					refreshSessions: function () { return typeof ctx.sessions.refresh === "function" ? ctx.sessions.refresh() : Promise.resolve(); },
					executeCompact: function (sessionId) { return ctx.remote.commands.execute(sessionId, "/compact", []); }
						}));
					}
			)), "dsh-tavern: candidate dock actions");
			ctx.effect(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-question", order: -120, label: "下一步行动" },
				function (props) {
					return React.createElement(React.Fragment, null,
					React.createElement(CandidateQuestion, Object.assign({}, props, { sessions: ctx.sessions }))
						);
					}
			)), "dsh-tavern: candidate question panel");
			ctx.effect(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-candidate-guide", order: -115, label: "重新生成候选项" },
				function (props) { return React.createElement(CandidateGuidePanel, props); }
			)), "dsh-tavern: candidate guide panel");
			ctx.effect(() => slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "dsh-tavern-regen", order: -110, label: "重新生成正文" },
				function (props) { return React.createElement(React.Fragment, null, React.createElement(RegenPanel, props), React.createElement(BodyEditPanel, props)); }
			)), "dsh-tavern: regen body panel");
		}
		return Object.freeze({ register: register });
		}
		const playControlsFeature = createPlayControlsFeatureModule();
		const assistantRendererFeature = createTavernAssistantRendererFeatureModule();

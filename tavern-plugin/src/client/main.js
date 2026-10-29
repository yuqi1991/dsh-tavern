// @include android-web-polyfills.js
window.__ModuleLoader__.load({
	id: "dsh-tavern-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
			let React = require("react");
			let DshUi = require("@deepseek-ai/dsh-client-ui-primitives");

		// @include stylesheet.js
		if (typeof document !== "undefined") installTavernStylesheet(document, __TAVERN_BUNDLED_CSS__);


		function isPlayMode(mode) {
			return mode === "story" || mode === "script";
		}
		function groupOfMode(mode) {
			return isPlayMode(mode || "story") ? "play" : "card";
		}
		function playModeOfCard(card) {
			return card && card.script ? "script" : "story";
		}
		function modeLabel(mode) {
			return mode === "script" ? "剧本" : mode === "card" ? "卡片" : "故事";
		}

		function ascii(bytes, off, len) {
			let s = "";
			for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
			return s;
		}

		function bytesToBase64(bytes) {
			let binary = "";
			for (let offset = 0; offset < bytes.length; offset += 32768) {
				binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(bytes.length, offset + 32768)));
			}
			return btoa(binary);
		}

		// @include interaction-diagnostics.js
		const tavernInteractionDiagnostics = createInteractionDiagnostics(window);

		// @include text-resource-file.js

		function parseCardFile(file) {
			const name = String(file.name || "");
			if (name.toLowerCase().endsWith(".json")) {
				return file.text().then(function (text) { return { kind: "text", name: name, text: text }; });
			}
			return file.arrayBuffer().then(function (buf) {
				const bytes = new Uint8Array(buf);
				if (bytes.length <= 8 || ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n") {
					throw new Error("无法识别的角色卡文件（需要 PNG 或 JSON）");
				}
				let off = 8;
				while (off + 8 <= bytes.length) {
					const len = (((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3])) >>> 0;
					const type = ascii(bytes, off + 4, 4);
					if (type === "tEXt" && off + 8 + len <= bytes.length) {
						const dataOff = off + 8;
						let nul = -1;
						for (let i = 0; i < len; i++) {
							if (bytes[dataOff + i] === 0) { nul = i; break; }
						}
						if (nul >= 0) {
							const keyword = ascii(bytes, dataOff, nul);
							const value = ascii(bytes, dataOff + nul + 1, len - nul - 1);
							if (keyword === "chara" || keyword === "ccv3") return { kind: "png", name: name, b64: value, fileB64: bytesToBase64(bytes) };
						}
					}
					if (type === "IEND") break;
					off += 12 + len;
				}
				throw new Error("PNG 中未找到角色卡数据（chara/ccv3 文本块）");
			});
		}

		function MobileCardImportButton(props) {
			const [catalog, setCatalog] = React.useState(null);
			const [open, setOpen] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			function load() {
				return rpcWithTimeout("listMobileCardImports", {}).then(function (result) { setCatalog(result); return result; }, function () { setCatalog({ available: false, files: [] }); return { available: false, files: [] }; });
			}
			React.useEffect(function () { load(); }, []);
			async function activate() {
				const current = catalog || await load();
				if (current.available) { setOpen(true); load(); }
				else if (props.inputRef.current) props.inputRef.current.click();
			}
			async function importFile(file) {
				setBusy(true); setError("");
				try { const result = await rpc("importMobileCard", { id: file.id }); setOpen(false); await props.onImported(result.card); }
				catch (err) { setError(String(err && err.message || err)); }
				finally { setBusy(false); }
			}
			const h = React.createElement;
			return h(React.Fragment, null,
				h("button", { className: "dsh-tavern-btn", disabled: props.disabled || busy, onClick: activate }, "导入人物卡"),
				open ? h("div", { className: "dsh-tavern-mobile-import", role: "dialog", "aria-modal": "true", "aria-label": "从手机下载目录导入人物卡" }, h("div", { className: "dsh-tavern-mobile-import-shell" }, h("div", { className: "dsh-tavern-mobile-import-panel" },
					h("div", { className: "dsh-tavern-mobile-import-title" }, "从手机下载目录导入"),
					h("div", { className: "dsh-tavern-question-sub" }, "把 PNG 或 JSON 人物卡放进手机 Download，回到这里点选。"),
					error ? h("div", { className: "dsh-tavern-dock-error", role: "alert" }, error) : null,
					h("div", { className: "dsh-tavern-mobile-import-list" }, catalog && catalog.files.length ? catalog.files.map(function (file) { return h("button", { key: file.id, className: "dsh-tavern-mobile-import-file", disabled: busy, onClick: function () { importFile(file); } }, h("b", null, file.name), h("span", null, file.directory + " · " + Math.ceil(file.size / 1024) + " KB")); }) : h("div", { className: "dsh-tavern-empty" }, catalog && catalog.storageAccessible === false ? "DSHA 无法读取下载目录。请在系统设置中允许 DSHA ‘访问所有文件’，然后点刷新；也可尝试系统文件选择器。" : "下载目录里还没有 PNG/JSON 人物卡。")),
					h("div", { className: "dsh-tavern-library-head-actions" }, h("button", { className: "dsh-tavern-btn", disabled: busy, onClick: load }, "刷新"), h("button", { className: "dsh-tavern-btn", disabled: busy, onClick: function () { setOpen(false); if (props.inputRef.current) props.inputRef.current.click(); } }, "使用系统文件选择器"), h("button", { className: "dsh-tavern-btn", disabled: busy, onClick: function () { setOpen(false); } }, "关闭"))
				))) : null
			);
		}

		// @include modules/runtime-generation-monitor.js

		function reloadTavernClient() {
			const script = Array.from(document.scripts || []).find(function (item) {
				return String(item && item.src || "").includes("/plugins/dsh-tavern-plugin/client.js");
			});
			const warm = script && script.src
				? fetch(script.src, { cache: "reload" }).catch(function () { })
				: Promise.resolve();
			return warm.then(function () { window.location.reload(); });
		}

		const tavernRuntimeGenerationMonitor = createTavernRuntimeGenerationMonitor({
			load: function () {
				return fetch("/api/dsh-tavern/runtime-generation", { cache: "no-store" }).then(readTavernJsonResponse);
			},
			refresh: reloadTavernClient
		});

		async function readTavernJsonResponse(response, onBody) {
			function failure(message, retryable) {
				const error = new Error(message);
				error.status = response.status;
				error.retryable = retryable;
				return error;
			}
			if (response.status === 401) throw failure("连接认证已失效，请通过服务启动时提供的地址重新打开页面", false);
			if (response.status === 403) throw failure("请求被拒绝，请检查访问地址和权限", false);
			if (!response.ok) throw failure("服务请求失败（HTTP " + response.status + "），请稍后重试", [404, 408, 429, 502, 503, 504].includes(response.status));
			const body = await response.text();
            if (onBody) onBody(body);
			if (!body.trim()) throw failure("服务返回空响应，可能仍在启动或重启，请稍后重试", true);
			try { return JSON.parse(body); }
			catch (_error) { throw failure("服务返回非 JSON 或不完整的响应，请稍后重试", true); }
		}

		// @include opening-performance.js
		const pagePerformance = { observedMs: 0, longTaskCount: 0, longTaskTotalMs: 0, longTaskMaxMs: 0, slowRpcCount: 0, slowRpcMaxMs: 0, longTaskSupported: false };
		const pagePerformanceStarted = Date.now();
		let performanceReportAt = 0;
		let performanceActiveRequests = 0;
		const performanceRequests = [];
		if (typeof window !== "undefined" && typeof PerformanceObserver !== "undefined") {
			try {
				if (window.__dshTavernPerformanceObserver) window.__dshTavernPerformanceObserver.disconnect();
				if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
					const observer = new PerformanceObserver(function (list) {
						for (const entry of list.getEntries()) {
							if (entry.duration < 100) continue;
							pagePerformance.longTaskCount++;
							pagePerformance.longTaskTotalMs += Math.round(entry.duration);
							pagePerformance.longTaskMaxMs = Math.max(pagePerformance.longTaskMaxMs, Math.round(entry.duration));
						}
					});
					observer.observe({ type: "longtask" });
					window.__dshTavernPerformanceObserver = observer;
					pagePerformance.longTaskSupported = true;
				}
			} catch (_) { }
		}

		// @include-domain indexed-array.js
		// @include-domain ordered-numeric-index.js
		// @include-domain chat-import-batch.js
		// @include modules/session-view-sync.js
		// @include modules/session-compat.js
		const beginSessionViewRead = createSessionViewReader();

		function rpc(method, args, sessionId, requestOptions) {
			const runtimeControl = ["claimTavernScriptWork", "startTavernScriptWork", "getTavernScriptWorkState", "heartbeatTavernScriptRuntime", "completeTavernHelperEvent", "releaseTavernHelperRuntime"].includes(method);
			const controlChannel = runtimeControl && typeof tavernSessionSignals !== "undefined" && typeof tavernSessionSignals.control === "function" ? tavernSessionSignals : null;
			const started = Date.now();
            const clockStart = performance.now();
            const traced = ["getSession", "syncSession", "getCardOpenings", "initializeOpeningTemplate", "preparePlayStart", "startChat"].includes(method);
            const trace = traced ? { id: window.crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === "x" ? n : (n & 3) | 8).toString(16); }), method, sentAt: started, active: ++performanceActiveRequests } : null;
            const payload = Object.assign({}, args || {});
			if (!runtimeControl && (started - performanceReportAt >= 60000 || /diagnostic|export/i.test(method))) {
				pagePerformance.observedMs = started - pagePerformanceStarted;
				payload._performance = Object.assign({}, pagePerformance, { requests: performanceRequests.slice(), openingRequests: typeof openingPerformance !== "undefined" ? openingPerformance.requests() : [], openings: typeof openingPerformance !== "undefined" ? openingPerformance.read() : [] });
				performanceReportAt = started;
			}
			if (trace) payload._traceId = trace.id;
			if (sessionId) payload.sessionId = sessionId;
			const viewRead = method === "getSession" ? beginSessionViewRead(payload.sessionId) : null;
			if (viewRead) { payload.viewSync = 1; payload.viewCursor = viewRead.cursor; }
			const requestBody = JSON.stringify(payload);
			if (trace) {
				try { trace.requestBytes = typeof TextEncoder === "function" ? new TextEncoder().encode(requestBody).length : requestBody.length; }
				catch (_error) { trace.requestBytes = requestBody.length; }
			}
			const request = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: requestBody
			};
			if (requestOptions && requestOptions.signal) request.signal = requestOptions.signal;
			if (requestOptions && requestOptions.keepalive === true) request.keepalive = true;
			if (method === "generateSceneImage") recordImageInteraction(payload.sessionId, payload.turn, payload.requestId, "sent");
			const responsePromise = controlChannel
				? Promise.resolve().then(() => controlChannel.control(method, JSON.parse(requestBody), requestOptions && requestOptions.signal))
				: fetch("/api/dsh-tavern/" + method, request).then(async function (response) {
                if (trace) trace.headersMs = Math.round(performance.now() - clockStart);
                const result = await readTavernJsonResponse(response, trace ? body => { trace.bodyChars = body.length; } : undefined);
                if (trace) {
					trace.parsedMs = Math.round(performance.now() - clockStart);
					try {
						const header = response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : null;
						if (header) trace.responseBytes = Number(header);
						// bodyChars measures the decoded body without serializing the large result again.
						} catch (_error) { }
				}
                return result;
            });
			return responsePromise.then(function (result) {
				tavernRuntimeGenerationMonitor.observe(result && result.runtimeGeneration);
				if (!result || !result.ok) {
					const error = new Error(result && result.error ? result.error : "操作失败");
					if (typeof result?.errorCode === "string" && result.errorCode) error.code = result.errorCode;
					throw error;
				}
				return viewRead ? viewRead.accept(result) : result;
			}).catch(function (error) {
                if (trace) trace.failed = true;
				if (method === "generateSceneImage") recordImageInteraction(payload.sessionId, payload.turn, payload.requestId, "failed", "rpc-error");
				throw error;
			}).finally(function () {
				const elapsed = Date.now() - started;
                if (trace) {
                    performanceActiveRequests--;
                    trace.durationMs = Math.round(performance.now() - clockStart);
                    performanceRequests.push(trace);
                    if (!["getSession", "syncSession"].includes(method) && typeof openingPerformance !== "undefined") openingPerformance.recordRequest(trace);
                    if (performanceRequests.length > 60) performanceRequests.shift();
                }
                if (elapsed >= 1000) { pagePerformance.slowRpcCount++; pagePerformance.slowRpcMaxMs = Math.max(pagePerformance.slowRpcMaxMs, elapsed); }
			});
		}

		function recordImageInteraction(sessionId, turn, requestId, stage, reason) {
			void rpc("recordSceneImageInteraction", { turn: turn, requestId: requestId, stage: stage, reason: reason }, sessionId).catch(function () { });
		}

		function rpcWithTimeout(method, args, sessionId) {
			const controller = new AbortController();
			const timer = window.setTimeout(function () { controller.abort(); }, 15000);
			return rpc(method, args, sessionId, { signal: controller.signal }).catch(function (error) {
				if (controller.signal.aborted) throw new Error("读取超时，请重新读取");
				throw error;
			}).finally(function () { window.clearTimeout(timer); });
		}

		function worldBookCatalogDiagnostic(result) {
			const diagnostics = result && Array.isArray(result.diagnostics) ? result.diagnostics : [];
			if (!diagnostics.length) return "";
			return "已跳过 " + diagnostics.length + " 个损坏资源：\n" + diagnostics.map(function (item) { return String(item.path || "未知资源") + "：" + String(item.message || "无法读取"); }).join("\n");
		}

		function notifyTavernDataChanged(kinds, source) {
			const changedKinds = Array.isArray(kinds) ? kinds.filter(Boolean) : [];
			window.dispatchEvent(new CustomEvent("dsh-tavern-data-changed", { detail: { kinds: changedKinds, source: String(source || "") } }));
		}

		function tavernDataChangeAffects(event, kinds, owner) {
			const detail = event && event.detail && typeof event.detail === "object" ? event.detail : null;
			if (!detail || !Array.isArray(detail.kinds) || detail.kinds.length === 0) return true;
			if (owner && detail.source === owner) return false;
			const expected = Array.isArray(kinds) ? kinds : [];
			return detail.kinds.indexOf("*") >= 0 || expected.some(function (kind) { return detail.kinds.indexOf(kind) >= 0; });
		}

		// @include modules/library-refresh.js

        const tavernSidebarOpens = new Map();
        function openTavernSidebarTab(ctx, seed, scope) {
            const key = JSON.stringify([scope.sessionId, seed]);
            if (tavernSidebarOpens.has(key)) return tavernSidebarOpens.get(key);
            const operation = (async function () {
                const deadline = Date.now() + 10000;
                for (; ;) {
                    try { ctx.betterSidebar.openTab(seed, scope); return; }
                    catch (error) {
                        // The session list can restore before DSH mounts its native
                        // sidebar seat. Retry this specific readiness error only.
                        if (!/sidebarRight: no session surface is mounted/.test(String(error.message || error)) || Date.now() >= deadline) throw error;
                        await new Promise(resolve => window.setTimeout(resolve, 100));
                        // 0.2.0 无 current 字段；会话已切换则这次重试打开的 tab 不再属于它。
                        const snapshotNow = ctx.sessions.list.getSnapshot();
                        if (snapshotNow.retainedBy) {
                            const main = Object.values(snapshotNow.byId || {}).find(function (row) { return row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0; });
                            if (!main || main.id !== scope.sessionId) return;
                        } else if (snapshotNow.current !== scope.sessionId) return;
                    }
                }
            })().catch(error => tavernErrorHub.report("打开酒馆侧栏", error)).finally(() => tavernSidebarOpens.delete(key));
            tavernSidebarOpens.set(key, operation);
            return operation;
        }

		function openPlayChatDebugWorkspace(sourceSessionId, turn) {
			return new Promise(function (resolve, reject) {
				let settled = false;
				const timer = window.setTimeout(function () {
					if (settled) return;
					settled = true;
					reject(new Error("卡片工作台没有响应，请重试"));
				}, 15000);
				function finish(callback, value) {
					if (settled) return;
					settled = true;
					window.clearTimeout(timer);
					callback(value);
				}
				window.dispatchEvent(new CustomEvent("dsh-tavern-debug-play-chat", {
					detail: {
					sourceSessionId: sourceSessionId,
					turn: Number(turn),
					resolve: function (value) { finish(resolve, value); },
					reject: function (error) { finish(reject, error); }
					}
				}));
			});
		}

		// @include modules/live-tavern-view.js

		function isMissingTavernCardError(value) {
			return /^人物卡不存在:\s*/.test(String(value && value.message || value || ""));
        }

		function applyTavernHelperMessageHydration(view, payload) {
			if (!view || !view.tavernHelper || !Array.isArray(view.tavernHelper.messages) || !payload || !Array.isArray(payload.messages)) return view;
			const messages = view.tavernHelper.messages.slice();
			for (const message of payload.messages) {
				const index = Number(message && message.message_id);
				if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length) continue;
				messages[index] = message;
			}
			const nextHelper = Object.assign({}, view.tavernHelper, { messages: messages });
			delete nextHelper.messagesPending;
			return Object.assign({}, view, { tavernHelper: nextHelper });
		}

		async function hydrateLiveTavernHelperMessages(sessionId, view) {
			const pending = view && view.tavernHelper && view.tavernHelper.messagesPending;
			if (!pending) return view;
			const payload = await rpc("hydrateTavernHelperMessages", {
				from: pending.from,
				to: pending.to
			}, sessionId);
			return applyTavernHelperMessageHydration(view, payload);
		}

		const liveTavernView = createLiveTavernViewModule({
			loadTimeoutMs: 10000,
			cacheRetentionMs: 10 * 60 * 1000,
			timeoutRetryDelayMs: 5000,
			load: function (sessionId, request) { return rpc("getSession", {}, sessionId, request); },
			hydrateHelperMessages: hydrateLiveTavernHelperMessages,
			shouldPoll: function (view) { return !!(view && view.activity && view.activity.busy); },
			pollWhileBusy: false,
			isTerminalError: isMissingTavernCardError
		});
		function coordinationView(result, sessionId) {
			const sync = result && result.sync ? result.sync : (result || {});
			const tasks = sync.tasks && typeof sync.tasks === "object" ? sync.tasks : {};
			const background = tasks.background || null;
			return {
				runtimeGeneration: String(sync.runtimeGeneration || ""),
				liveSession: sync.liveSession === true,
				requestMode: sync.requestMode === "sillytavern" ? "sillytavern" : "dsh",
				cardPath: String(sync.cardPath || ""),
				cardName: String(sync.cardName || ""),
				activity: background ? { phase: background.status === "queued" ? "pending" : (background.status === "succeeded" ? "idle" : background.status), busy: background.busy === true, role: background.kind, operationId: background.operationId, updatedAt: background.updatedAt } : (sync.activity || null),
				task: tasks.candidate || sync.task || null,
				tasks: tasks,
				mailboxVersion: Number(sync.mailboxVersion) || 0,
				projectionRevision: Number(sync.projectionRevision) || 0
			};
		}

		let tavernSessionSignals;

		function createTavernCoordinationEventModule(options) {
			if (!options || typeof options.connect !== "function") throw new Error("Tavern Coordination Event 缺少 SSE adapter");
			const records = new Map();
			function initialState() { return { phase: "connecting", view: null, error: "", updatedAt: 0 }; }
			function recordFor(sessionId) {
				const id = String(sessionId || "");
				if (!records.has(id)) records.set(id, { id: id, state: initialState(), listeners: new Set(), connection: null });
				return records.get(id);
			}
			function publish(record, state) {
				record.state = state;
				record.listeners.forEach(function (listener) { listener(state); });
			}
			function disconnect(record) {
				if (record.connection && typeof record.connection.close === "function") record.connection.close();
				record.connection = null;
			}
			function connect(record) {
				if (record.listeners.size === 0 || record.connection !== null) return;
				record.connection = options.connect(record.id, {
					message: function (view) {
						publish(record, { phase: "ready", view: view || null, error: "", updatedAt: Date.now() });
						if (typeof options.onView === "function") options.onView(record.id, view || null);
					},
					error: function (error) {
						publish(record, { phase: "retrying", view: record.state.view, error: String(error && error.message || ""), updatedAt: record.state.updatedAt });
					}
				});
				// Session Signals are lossy wake-ups, not state. Always establish the
				// coordination view from its authoritative source after (re)connecting.
				if (record.connection && typeof record.connection.refresh === "function") void record.connection.refresh();
			}
			function invalidate(sessionId) {
				const targets = sessionId === undefined || sessionId === null || sessionId === "" ? Array.from(records.values()) : [recordFor(sessionId)];
				targets.forEach(function (record) {
					if (record.connection && typeof record.connection.refresh === "function") {
						void record.connection.refresh();
						return;
					}
					disconnect(record);
					if (record.listeners.size > 0) {
						publish(record, { phase: "connecting", view: record.state.view, error: "", updatedAt: record.state.updatedAt });
						connect(record);
					}
				});
			}
			return {
				getSnapshot: function (sessionId) { return recordFor(sessionId).state; },
				setView: function (sessionId, view) {
					const record = recordFor(sessionId);
					publish(record, { phase: "ready", view: view || null, error: "", updatedAt: Date.now() });
				},
				subscribe: function (sessionId, listener) {
					const record = recordFor(sessionId);
					record.listeners.add(listener);
					listener(record.state);
					connect(record);
					return function () {
						record.listeners.delete(listener);
						if (record.listeners.size === 0) disconnect(record);
					};
				},
				invalidate: invalidate
			};
		}

		const coordinatedCardPaths = new Map();
		const tavernCoordination = createTavernCoordinationEventModule({
			onView: function (sessionId, view) {
				liveTavernView.invalidate(sessionId);
				const cardPath = String(view && view.cardPath || "");
				const observed = coordinatedCardPaths.has(sessionId);
				const previous = observed ? coordinatedCardPaths.get(sessionId) : cardPath;
				coordinatedCardPaths.set(sessionId, cardPath);
				if (observed && previous === "" && cardPath !== "") notifyTavernDataChanged(["cards", "sessions"], "coordination");
			},
			connect: function (sessionId, handlers) {
				let active = true;
				let loading = false;
				let reloadRequested = false;
				async function load() {
					if (!active) return;
					if (loading) { reloadRequested = true; return; }
					loading = true;
					try {
						const result = await rpc("syncSession", { kind: "candidate" }, sessionId);
						if (active) handlers.message(coordinationView(result, sessionId));
					} catch (error) {
						if (active) handlers.error(error);
					} finally {
						loading = false;
						if (active && reloadRequested) { reloadRequested = false; void load(); }
					}
				}
				const stop = tavernSessionSignals.subscribe(sessionId, "tavern-state", function (signal) {
					if (signal && signal.snapshot) {
						handlers.message(coordinationView(signal.snapshot, sessionId));
						return;
					}
					void load();
				}, handlers.error, function () {
					void load();
				});
				return { close: function () { active = false; stop(); }, refresh: load };
			}
		});

		function describeTavernActivity(value) {
			const activity = value && typeof value === "object" ? value : {};
			const busy = activity.busy === true;
			const role = String(activity.role || "");
			let label = "生成候选项";
			let blockReason = "";
			if (busy && role === "candidate") { label = "生成中…"; blockReason = "正在生成候选项，请稍候…"; }
			else if (busy) { label = "后台结算中…"; blockReason = "后台结算中，请稍候…"; }
			return { phase: String(activity.phase || "idle"), busy: busy, role: role, label: label, blockReason: blockReason };
		}

		function useLiveTavernView(sessionId, revision) {
			const subscribe = React.useCallback(function (notify) { return liveTavernView.subscribe(sessionId, notify); }, [sessionId]);
			const snapshot = React.useCallback(function () { return liveTavernView.getSnapshot(sessionId); }, [sessionId]);
			const state = React.useSyncExternalStore(subscribe, snapshot, snapshot);
			const previous = React.useRef({ sessionId: sessionId, revision: revision });
			React.useEffect(function () {
				const last = previous.current;
				previous.current = { sessionId: sessionId, revision: revision };
				if (last.sessionId === sessionId && last.revision !== revision) liveTavernView.invalidate(sessionId);
			}, [sessionId, revision]);
			return state;
		}

		function useTavernCoordination(sessionId, revision) {
			const [state, setState] = React.useState(function () { return tavernCoordination.getSnapshot(sessionId); });
			React.useEffect(function () { return tavernCoordination.subscribe(sessionId, setState); }, [sessionId]);
			React.useEffect(function () { tavernCoordination.invalidate(sessionId); }, [sessionId, revision]);
			return state;
		}

// @include runtime/conversation-lifecycle.js

// @include ui/error-center.js


// @include runtime/host-artifacts.js

// @include runtime/frame-document.js

// @include runtime/helper-facade.js

        // Bounded, value-free timings shared by every card's initialization.
// @include runtime/helper-bootstrap.js

		// Only downloading is repeatable. Once evaluation starts, its effects are unknown.
// @include runtime/helper-loader.js

		// jQuery captures its owning document. Sharing the iframe's instance with
		// the host would still send $('body') into the hidden script iframe.
// @include runtime/helper-host.js

// @include runtime/helper-script-runtime.js

		// The execution owner holds the lease, signal subscription and sandbox as one lifetime.
		// A new session (including A -> B -> A) gets a distinct lease identity.
// @include runtime/script-execution.js

// @include modules/host-theme.js

		// Guard pathological card resize loops without constraining normal long content.
// @include runtime/message-frame-lifecycle.js
		const tavernRetainedFrames = createRetainedTavernFrames({
			window: window, retention: tavernSessionRetention,
			panels: tavernPanelRegistry, createLifecycle: function (props) { return createTavernMessageFrameLifecycle(props); }
		});

// @include ui/message-frame.js

// @include features/assistant-renderer.js

// @include features/card-list.js

// @include features/sidebar.js

// @include features/scene-images.js
// @include features/text-layout.js
// @include features/settings.js
				return function () { active = false; };
			}, []);
			async function saveDefault(name, selection) {
				if (state.loading || state.busy) return;
				setState(current => ({ ...current, busy: true, error: "", notice: "" }));
				try {
					const result = await rpc("updateTavernSettings", { patch: { [name]: selection } });
					setState(current => ({ ...current, [name]: result.settings[name], busy: false, notice: "已保存，下次新游戏生效" }));
				} catch (err) { setState(current => ({ ...current, busy: false, error: String(err.message || err) })); }
			}
			return React.createElement("div", { className: "dsh-tavern-settings-section" },
				React.createElement("p", { className: "dsh-tavern-settings-intro" }, "默认模型用于新游戏；已有游戏保持当前配置，可在本局单独调整。"),
				React.createElement("p", { className: "dsh-tavern-settings-intro" }, "建议前台和后台使用 High 推理强度，优先保证正文输出和后台任务的质量。不推荐 Max，以免过度思考、增加等待。若更在意响应速度，可按需降低。"),
				React.createElement(TavernDefaultModelSetting, { label: "默认前台模型", fallback: "使用 DSH 默认模型", selection: state.defaultForegroundModel, catalog: state.modelCatalog, disabled: state.loading || state.busy, onChange: selection => saveDefault("defaultForegroundModel", selection) }),
				React.createElement(TavernDefaultModelSetting, { label: "默认后台模型", fallback: "跟随前台", selection: state.defaultBackgroundModel, catalog: state.modelCatalog, disabled: state.loading || state.busy, onChange: selection => saveDefault("defaultBackgroundModel", selection) }),
				state.notice ? React.createElement("p", { role: "status" }, state.notice) : null,
				React.createElement(TavernConversationWritingSkills, { globalDefaults: true }),
				React.createElement(CandidatePreferencesSettings),
				React.createElement(DisplayPreferencesSettings),
				React.createElement(PromptTemplateSettingsEntry),
				React.createElement(ContextCompactionSettings),
				state.error ? React.createElement("div", { className: "dsh-tavern-settings-error", role: "alert" }, "保存失败：" + state.error) : null
			);
		}

// @include features/user-profile.js

// @include features/system-prompts.js

// @include features/resources-library.js

        // @include card-memory.js

// @include features/skills.js


// @include features/preset-library.js


// @include features/worldbook-library.js

// @include features/guide-library.js

// @include features/card-library.js

		function TavernDockedPanel(props) {
			const ref = React.useRef(null);
			React.useLayoutEffect(function () {
				tavernPanelRegistry.dock(props.id, ref.current);
				return function () { tavernPanelRegistry.restore(props.id); };
			}, [props.id]);
			return React.createElement("div", { ref: ref });
		}
		function TavernPersistentStatusRuntime(props) {
			const entries = React.useSyncExternalStore(tavernPanelRegistry.subscribe, tavernPanelRegistry.inspect);
			const [selected, setSelected] = React.useState("");
			const [refreshes, setRefreshes] = React.useState({});
			const view = props.view;
			const statuses = view && isPlayMode(view.mode) ? (view.tavernStatusViews || (view.tavernStatusView ? [view.tavernStatusView] : [])) : [];
			const manual = entries.filter(function (entry) { return entry.sessionId === props.sessionId && entry.pinned; });
			const newest = manual.reduce(function (latest, entry) { return !latest || entry.activation > latest.activation ? entry : latest; }, null);
			React.useEffect(function () { if (newest) setSelected(newest.id); }, [props.sessionId, newest && newest.activation]);
			const ids = statuses.map(function (panel) { return panel.viewId; }).concat(manual.map(function (entry) { return entry.id; }));
			const active = ids.includes(selected) ? selected : ids[0];
			if (!view || !view.tavernHelper || !ids.length) return null;
			const h = React.createElement;
			return h("section", { className: "dsh-tavern-status-runtime" },
				h("div", { className: "dsh-tavern-panel-toolbar" }, h("div", { className: "dsh-tavern-panel-tabs", role: "tablist", "aria-label": "人物卡面板" },
					statuses.concat(manual.map(function (entry) { return { viewId: entry.id, title: entry.title }; })).map(function (panel) {
						return h("button", {
							key: panel.viewId, role: "tab", type: "button", "aria-selected": active === panel.viewId,
							className: "dsh-tavern-panel-tab", onClick: function () { setSelected(panel.viewId); }
						}, panel.title || "角色状态");
					})),
					statuses.some(panel => panel.viewId === active) ? h("button", { type: "button", className: "dsh-tavern-panel-refresh", title: "重新加载此面板，未保存的输入会清空", onClick: function () { tavernRetainedFrames.invalidatePanel(props.sessionId, active); setRefreshes(function (previous) { return Object.assign({}, previous, { [active]: (previous[active] || 0) + 1 }); }); } }, "↻ 刷新") : null),
				statuses.map(function (statusView) {
					return h("div", {
						key: props.sessionId + statusView.viewId, role: "tabpanel", hidden: active !== statusView.viewId,
						"data-status-view-id": statusView.viewId, "data-template-revision": statusView.templateRevision
					},
						h(TavernMessageFrame, {
							key: props.sessionId + statusView.viewId + (refreshes[statusView.viewId] || 0), preserveInstance: true,
							content: String(statusView.content), sessionId: props.sessionId,
							turn: Math.max(1, Number(statusView.targetTurn) || 1), partIndex: Math.max(0, Number(statusView.sourcePartIndex) || 0),
							panelId: statusView.viewId, helperContext: view.tavernHelper,
							trustedCardMode: Boolean(view.tavernRuntimePolicy && view.tavernRuntimePolicy.trustedCardMode),
							eager: true, persistent: true, followContentFont: false, executeSlash: props.executeSlash,
							observeMvuView: false, runtimeReporting: true
						}));
				}),
				manual.map(function (entry) {
					return h("div", { key: entry.id, role: "tabpanel", hidden: active !== entry.id },
						h("button", { type: "button", className: "dsh-tavern-btn", onClick: function () { tavernPanelRegistry.pin(entry.id, false); } }, "返回原消息"),
						h(TavernDockedPanel, { id: entry.id }));
				})
			);
		}

		function latestTavernAssistantMessageId(snapshot) {
			// alpha.2 keeps message projections on Chat, separate from Session lifecycle.
			const nodes = snapshot && snapshot.legacy && snapshot.legacy.nodes || [];
			for (let index = nodes.length - 1; index >= 0; index -= 1) {
				if (nodes[index].kind === "assistant" && nodes[index].messageId) return nodes[index].messageId;
			}
			return null;
		}

		function applyBodyRegenerationResult(options) {
			options.liveTavernView.setView(options.sessionId, options.view);
		}

		function resolveConversationChatBinding(uiConversation, binding) {
			if (uiConversation && typeof uiConversation.binding === "function") {
				return uiConversation.binding(binding).target("chat");
			}
			if (!binding || !binding.session || typeof binding.session.subscribe !== "function" || typeof binding.session.getSnapshot !== "function") {
				throw new Error("当前 DSHA 无法提供酒馆状态所需的对话消息");
			}
			return {
				subscribe: function (listener) { return binding.session.subscribe(listener); },
				getSnapshot: function () {
					const snapshot = binding.session.getSnapshot();
					if (!snapshot || !snapshot.chat) throw new Error("当前 DSHA 的对话消息尚未就绪");
					return snapshot.chat;
				}
			};
		}

// @include features/play-controls.js

// @include features/request-context.js


		const inject = ["slots", "sessions", "workspaces", "layout", "connection", "conversation", "betterSidebar", "remote", "remote.commands", "tavernSessionSignals", "theme"];

		// The host chat page's row-hiding layer is gone; drop what it left behind.
		function forgetRetiredHidingKeys(storage) {
			try {
				for (const key of ["dsh-tavern-hidden-turns", "dsh-tavern-rolled-back-turns", "dsh-tavern-hidden-regen-user-turns"]) storage.removeItem(key);
				for (let index = storage.length - 1; index >= 0; index -= 1) {
					const key = storage.key(index);
					if (key && key.startsWith("dsh-tavern-hidden-errors:")) storage.removeItem(key);
				}
			} catch (_) { }
		}

		function apply(ctx) {
			forgetRetiredHidingKeys(window.localStorage);
			ctx.effect(() => tavernInteractionDiagnostics.start(), "dsh-tavern: interaction diagnostics");
			ctx.effect(function () { return tavernTextLayoutFeature.register(ctx); }, "dsh-tavern: text layout in appearance settings");
			ctx.effect(() => displayPreferences.start(), "dsh-tavern: global display preferences");
			ctx.effect(() => syncTavernSubagentCatalogs(ctx.sessions, ctx.tavernSessionSignals), "dsh-tavern: subagent catalog synchronization");
			const slots = ctx.slots;
			if (slots === undefined) return;
            ctx.effect(() => slots.inject("conversation.view", () => slots.register({
                name: "conversation.view", id: "dsh-tavern:full-context", order: 11,
                label: "完整上下文", inject: sessionId => ({ contextSessionId: sessionId })
            }, FullRequestContextView)), "dsh-tavern: full request context");
            ctx.effect(() => slots.inject("conversation.view", () => slots.register({
                name: "conversation.view", id: "dsh-tavern:gallery", order: 12,
                label: "画廊", inject: sessionId => ({ gallerySessionId: sessionId })
            }, SceneImageGallery)), "dsh-tavern: picture gallery");
			const signals = ctx.tavernSessionSignals;
			if (!signals || typeof signals.subscribe !== "function") throw new Error("DSH Tavern Remote 状态流不可用");
			tavernSessionSignals = signals;
			ctx.effect(function () { return function () { if (tavernSessionSignals === signals) tavernSessionSignals = undefined; }; }, "dsh-tavern: remote session signals");
			ctx.effect(function () { return tavernRuntimeGenerationMonitor.start(); }, "dsh-tavern: runtime generation monitor");
			function reconcileLibraryTabTitles() {
				if (!ctx.betterSidebar || typeof ctx.betterSidebar.getSnapshot !== "function" || typeof ctx.betterSidebar.updateTab !== "function") return;
				const snapshot = ctx.betterSidebar.getSnapshot();
				const state = snapshot.state;
				if (!state) return;
				const retiredTabs = [];
				const expectedTitles = {
					"dsh-tavern:conversation-settings": "本局设置",
					"dsh-tavern:user-profile": "用户画像",
					"dsh-tavern:cards": "人物卡库",
					"dsh-tavern:presets": "预设库",
					"dsh-tavern:worldbooks": "世界书库",
					"dsh-tavern:resources": "剧本与素材库"
				};
				function visit(node) {
					if (!node) return;
					if (node.kind === "split") {
						(node.children || []).forEach(visit);
						return;
					}
					(node.tabs || []).forEach(function (tab) {
						if (tab.type === "dsh-tavern:boundary-prompts" || tab.type === "dsh-tavern:bypass-plans") { retiredTabs.push(tab.id); return; }
						const title = expectedTitles[tab.type];
						if (title && tab.title !== title) ctx.betterSidebar.updateTab(tab.id, { title: title });
					});
				}
				visit(state.splits);
				visit(state.bottomSplits);
				if (typeof ctx.betterSidebar.closeTab === "function") retiredTabs.forEach(function (tabId) { ctx.betterSidebar.closeTab(tabId, snapshot.sessionId ? { sessionId: snapshot.sessionId } : undefined); });
			}
			function appendMention(sessionId, kind, path, label) {
				try {
					const actx = ctx.sessions.scope(sessionId);
					const conversation = ctx.get("conversation");
					if (!actx || !conversation) throw new Error("当前对话输入框不可用");
					const input = conversation.input.for(actx);
					const safePath = String(path || "").replace(/\\/g, "/").replace(/["\r\n]/g, "");
					const safeLabel = String(label || safePath.split("/").pop() || "世界书").replace(/[\]\r\n]/g, "");
					const mention = kind === "worldbook" ? "@[" + safeLabel + "](tavern-worldbook:" + encodeURIComponent(safePath) + ")" : "@\"" + safePath + "\"";
					const draft = input.state.getSnapshot().draft;
					input.setDraft(draft.trim() === "" ? mention : draft + (/\s$/.test(draft) ? "" : " ") + mention);
				} catch (err) {
					console.warn("dsh-tavern: resource mention failed", err);
					tavernErrorHub.report("在对话中引用", err);
				}
			}
			function cleanWorkspaceDraft(sessionId) {
				const input = ctx.get("conversation").input.for(ctx.sessions.scope(sessionId));
				let busy = false, stopped = false;
				async function clean() {
					const draft = String(input.state.getSnapshot().draft || "");
					const taskStart = draft.indexOf("【卡片任务：");
					if (busy || stopped || !draft.startsWith("【当前 Tavern 资源工作区】") || taskStart < 0) return;
					busy = true;
					try {
						const result = await rpc("getCardTaskPrompt", { task: "edit" }, sessionId);
						const normalize = text => String(text || "").replace(/\s+/g, " ").trim();
						if (!stopped && result.legacyWorkspaceText && normalize(draft.slice(0, taskStart)) === normalize(result.legacyWorkspaceText) && input.state.getSnapshot().draft === draft) input.setDraft(draft.slice(taskStart));
					} catch (error) { tavernErrorHub.report("整理工作区说明", error); }
					finally { busy = false; }
				}
				const unsubscribe = input.state.subscribe(clean);
				void clean();
				return function () { stopped = true; unsubscribe(); };
			}
			async function injectTaskPrompt(sessionId, task, label, card, hasInitialResources, taskSupplement) {
				const actx = ctx.sessions.scope(sessionId);
				const conversation = ctx.get("conversation");
				if (!actx || !conversation) throw new Error("当前对话输入框不可用");
				const input = conversation.input.for(actx);
				const targetPath = card && card.path ? String(card.path).replace(/\\/g, "/").replace(/["\r\n]/g, "") : "";
				if (task === "writing-skill") {
					const references = String(input.state.getSnapshot().draft || "");
					input.setDraft("/create-writing-skill\n\n请从已引用的素材中提炼写作 Skill，用于前台正文写作。先与我确认适用场景、禁用场景和写作要求，再编写自包含的提示词；成品不依赖原素材或参考文件。\n\n【参考素材】\n" + references);
					return;
				}
				if (task === "gentle") {
					if (!targetPath) throw new Error("温和改写缺少目标人物卡");
					input.setDraft("/gentle-rewrite\n\n@\"" + targetPath + "\"\n\n先调用 tavern_copy_card 创建保留原卡图片的独立副本，再按温和改写 skill 完成改写，交付副本路径与改写摘要。");
					return;
				}
				if (task === "mvu") {
					if (!targetPath) throw new Error("MVU 转换缺少目标人物卡");
					input.setDraft(
						"/card-to-mvu\n\n【目标人物卡】\n@\"" + targetPath + "\"\n\n" +
						"把这张人物卡转换为独立的 MVU 版本；保留剧情设定与状态栏视觉风格。原卡自带的候选项（生成提示、按钮、正则和专用脚本）移除，统一使用 DSH Tavern 内置候选项；手机、开场主页等与状态栏和候选项无关的美化与脚本原样保留。"
					);
					return;
				}
				if (task === "user-profile") {
					input.setDraft(
						"/user-profile\n\n通过分批提问了解我的长期游玩与写作偏好。可以提供差异明确的参考选项，也允许我自由回答或跳过；信息足够后形成画像草案让我核对，只有我明确确认后才保存。"
					);
					return;
				}
				const result = await rpc("getCardTaskPrompt", { task: task }, sessionId);
				const draft = String(input.state.getSnapshot().draft || "");
				const supplement = draft + (taskSupplement ? "\n\n" + taskSupplement : "");
				const targetSection = targetPath ? "\n\n【目标人物卡】\n@\"" + targetPath + "\"" : "";
				const resourceSection = hasInitialResources ? (task === "worldbook" || task === "preset" || task === "script" ? "\n\n【编辑目标】\n" : "\n\n【初始剧本】\n") : "";
				if (task === "debug-play") {
					input.setDraft("/debug-card" + targetSection + "\n\n" + supplement.trim() + "\n\n请结合已引用的游玩记录，检查这张人物卡的异常表现，按需读取相关日志和状态，说明原因并给出修改建议。");
					return;
				}
				if (task === "edit") {
					const editPrompt = String(result && result.text || "").trim();
					const target = targetPath ? "\n\n目标卡：@\"" + targetPath + "\"" : "";
					input.setDraft(editPrompt.replace("/edit-card", "/edit-card" + target) + resourceSection + (supplement ? "\n\n" + supplement : ""));
					return;
				}
				const taskText = "【卡片任务：" + label + "】" + targetSection + "\n\n" + String(result && result.text || "").trim() + resourceSection;
				input.setDraft(taskText + supplement);
			}
			registerTavernStartPage(ctx, slots);
			playControlsFeature.register({ ctx: ctx, slots: slots });
			assistantRendererFeature.register({ ctx: ctx, slots: slots });
			ctx.effect(function () {
				return slots.inject("conversation.input.right", function () {
					return slots.register({
					name: "conversation.input.right",
					id: "dsh-tavern-background-model",
					order: 100
					}, function (props) { return React.createElement(TavernBackgroundModelLabel, Object.assign({}, props, { sessions: ctx.sessions })); });
				});
			}, "dsh-tavern: background model label");
			ctx.effect(function () {
				return slots.inject("settings.section", function () {
					return slots.register({
					name: "settings.section",
					id: "dsh-tavern",
					order: 110,
					label: function () { return "DSH Tavern"; }
					}, TavernSettingsSection);
				});
			}, "dsh-tavern: settings section");
			ctx.effect(function () {
				let dispose = null, active = true;
				// Releases without scene images get no page at all.
				rpc("getTavernSettings").then(function (result) {
					if (!active || !(result.releaseCapabilities && result.releaseCapabilities.sceneImages)) return;
					dispose = slots.inject("settings.section", function () { return slots.register({
						name: "settings.section",
						id: "dsh-tavern-scene-images",
						order: 111,
						label: function () { return "场景生图"; }
					}, function () { return React.createElement("div", { className: "dsh-tavern-settings-section dsh-tavern-global-settings" }, React.createElement(SceneImageSettings, null)); }); });
				}, function () {});
				return function () { active = false; if (typeof dispose === "function") dispose(); };
			}, "dsh-tavern: scene image settings section");

			ctx.effect(function () {
				const dispose = ctx.betterSidebar.registerTab({ id: "dsh-tavern:system-prompts", title: "系统提示词", order: 5, single: true, component: SystemPromptSidebarTab });
				return function () { if (typeof dispose === "function") dispose(); };
			}, "dsh-tavern: system prompt sidebar tab");
			userPreferenceProfileFeature.register({ ctx: ctx });
			presetLibraryFeature.register({ ctx: ctx, appendMention: appendMention });
			resourcesLibraryFeature.register({ ctx: ctx, appendMention: appendMention });
			ctx.effect(() => ctx.betterSidebar.registerTab({ id: "dsh-tavern:skills", title: "Skill 库", order: 8, single: true, component: props => React.createElement(TavernSkillsTab, { sessionId: props.scope.sessionId }) }), "dsh-tavern: Skill library");
            ctx.effect(() => ctx.betterSidebar.registerTab({ id: "dsh-tavern:card-memory", title: "改卡记忆", order: 9, single: true, component: props => React.createElement(TavernCardMemoryTab, { sessionId: props.scope.sessionId }) }), "dsh-tavern: card memory");
			ctx.effect(() => ctx.betterSidebar.registerTab({ id: "dsh-tavern:guide-library", title: "Guide 库", order: 9, single: true, component: GuideLibraryTab }), "dsh-tavern: guide library");
			worldBookLibraryFeature.register({ ctx: ctx, appendMention: appendMention });
			cardLibraryFeature.register({ ctx: ctx, appendMention: appendMention });
			ctx.effect(function () {
				reconcileLibraryTabTitles();
				if (typeof ctx.betterSidebar.subscribeState !== "function") return;
				return ctx.betterSidebar.subscribeState(reconcileLibraryTabTitles);
			}, "dsh-tavern: reconcile persisted library tab titles");
			ctx.effect(function () {
				function invalidateLiveView(event) { if (tavernDataChangeAffects(event, ["sessions", "cards", "presets", "worldbooks", "scripts"], "live-view")) liveTavernView.invalidate(); }
				window.addEventListener("dsh-tavern-data-changed", invalidateLiveView);
				return function () { window.removeEventListener("dsh-tavern-data-changed", invalidateLiveView); };
			}, "dsh-tavern: live Tavern view invalidation");
			tavernShellFeature.register({ ctx: ctx, slots: slots, appendMention: appendMention, injectTaskPrompt: injectTaskPrompt, cleanWorkspaceDraft: cleanWorkspaceDraft });
		}

		exports.TavernMessageFrame = TavernMessageFrame;
		exports.renderTavernProjection = renderTavernProjection;
		exports.TavernPersistentStatusRuntime = TavernPersistentStatusRuntime;
		exports.createTavernMessageFrameLifecycle = createTavernMessageFrameLifecycle;
		exports.createTavernScriptExecutionModule = createTavernScriptExecutionModule;
		exports.createTavernScriptSessionOwner = createTavernScriptSessionOwner;
		exports.createTavernSessionRetention = createTavernSessionRetention;
		exports.createRetainedTavernFrames = createRetainedTavernFrames;
		exports.createMvuBundleLoader = createMvuBundleLoader;
		exports.TavernMvuLoadRecovery = TavernMvuLoadRecovery;
		exports.findTavernQuoteRanges = findTavernQuoteRanges;
        exports.installTavernTextColors = installTavernTextColors;
        exports.TavernColoredMarkdown = TavernColoredMarkdown;
        exports.apply = apply;
		exports.inject = inject;
		exports.buildOpeningPreviewDocument = buildOpeningPreviewDocument;
		exports.buildTavernFrameDocument = buildTavernFrameDocument;
		exports.openingPreviewSelection = openingPreviewSelection;
		exports.syncTavernSubagentCatalogs = syncTavernSubagentCatalogs;
		exports.applyTavernVariableReceipt = applyTavernVariableReceipt;
		exports.createTavernHelperTransport = createTavernHelperTransport;
		exports.createTavernInitializationTiming = createTavernInitializationTiming;
		exports.createTavernHelperEventBus = createTavernHelperEventBus;
		exports.buildTavernHelperScriptDocument = buildTavernHelperScriptDocument;
		exports.createTavernHostStylesheetBridge = createTavernHostStylesheetBridge;
		exports.createTavernPanelRegistry = createTavernPanelRegistry;
		exports.createTavernCardAppPresence = createTavernCardAppPresence;
		exports.createTavernCardAppDock = createTavernCardAppDock;
		exports.createTavernHelperScriptRuntime = createTavernHelperScriptRuntime;
		exports.ensureTavernHostJQuery = ensureTavernHostJQuery;
		exports.ensureTavernHostJQueryUi = ensureTavernHostJQueryUi;
		exports.installTavernTrustedHostFacade = installTavernTrustedHostFacade;
		exports.releaseTavernHostJQueryHandlers = releaseTavernHostJQueryHandlers;
		exports.tavernScriptRuntimeReady = tavernScriptRuntimeReady;
		exports.clampTavernFrameHeight = clampTavernFrameHeight;
		exports.createTavernHelperContextUpdate = createTavernHelperContextUpdate;
		exports.applyTavernHelperContextUpdate = applyTavernHelperContextUpdate;
		exports.projectionPartsOf = projectionPartsOf;
		exports.createTavernPreviewWindow = createTavernPreviewWindow;
		exports.createTavernFrameSlashExecutor = createTavernFrameSlashExecutor;
		exports.createWorldBookLibraryRefreshModule = createWorldBookLibraryRefreshModule;
		exports.groupWorldBookEditorEntries = groupWorldBookEditorEntries;
		exports.orderWorldBookCatalogItems = orderWorldBookCatalogItems;
		exports.filterWorldBookCatalogItems = filterWorldBookCatalogItems;
		exports.groupPresetEntriesByPhase = groupPresetEntriesByPhase;
		exports.createCardLibraryRefreshModule = createCardLibraryRefreshModule;
		exports.tavernDataChangeAffects = tavernDataChangeAffects;
		exports.createLiveTavernViewModule = createLiveTavernViewModule;
		exports.createSessionCompat = createSessionCompat;
		exports.sessionListAdapters = sessionListAdapters;
		exports.applyBodyRegenerationResult = applyBodyRegenerationResult;
		exports.createTavernCoordinationEventModule = createTavernCoordinationEventModule;
		exports.describeTavernActivity = describeTavernActivity;
		exports.deleteTavernCards = deleteTavernCards;
		exports.groupTavernHistory = groupTavernHistory;
		exports.createPlayWorkspaceResolver = createPlayWorkspaceResolver;
		exports.createSessionListRecoveryModule = createSessionListRecoveryModule;
		exports.installOpeningHostComposer = installOpeningHostComposer;
        exports.installFrameHostComposer = installFrameHostComposer;
		exports.createConversationLifecycleModule = createConversationLifecycleModule;
		exports.createConversationHostAdapter = createConversationHostAdapter;
		exports.createConversationPrewarmModule = createConversationPrewarmModule;
        exports.createConversationAttemptStore = createConversationAttemptStore;
		exports.resolveConversationChatBinding = resolveConversationChatBinding;
		exports.createResourcesLibraryFeatureModule = createResourcesLibraryFeatureModule;
		exports.createPresetLibraryFeatureModule = createExternalPresetAndBypassPlanFeatureModule;
		exports.createWorldBookLibraryFeatureModule = createWorldBookLibraryFeatureModule;
		exports.createCardLibraryFeatureModule = createCardLibraryFeatureModule;
		exports.createPlayControlsFeatureModule = createPlayControlsFeatureModule;
		exports.createTavernAssistantRendererFeatureModule = createTavernAssistantRendererFeatureModule;
		exports.createTavernShellFeatureModule = createTavernShellFeatureModule;
		exports.createTavernRuntimeGenerationMonitor = createTavernRuntimeGenerationMonitor;
		// @include modules/assistant-visibility.js
		installTavernAssistantVisibilityPatch(require);
		// @include modules/trajectory-surface-view.js
		// @include modules/host-session-patch.js
		installTavernSessionHistoryPatch(require, rpc);
		return module.exports;
	}
});

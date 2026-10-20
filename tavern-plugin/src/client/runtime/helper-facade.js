		function createTavernHelperTransport(options) {
			const { parent, token, copy, identity, onContext, onEvent } = options;
			let nextId = 1;
			const pending = Object.create(null);
			function post(message) { parent.postMessage(Object.assign({}, message, { token: token }), "*"); }
			function request(method, args) {
				// A card may replace its document; DOM listeners must be restored before RPC.
				options.listen(receive);
				return new Promise(function (resolve, reject) {
					const requestId = String(nextId++);
					const owner = identity();
					pending[requestId] = { resolve: resolve, reject: reject, method: method, owner: owner };
					post(Object.assign({ type: "dsh-tavern-helper-call", requestId: requestId, method: method, args: copy(args || {}) }, owner));
				});
			}
			function receive(event) {
				const data = event && event.data;
				if (event.source !== parent || !data || data.token !== token) return;
				if (data.type === "dsh-tavern-helper-context") { onContext({ context: data.context || {} }); return; }
				if (data.type === "dsh-tavern-helper-event" || data.type === "dsh-tavern-helper-event-ack" || data.type === "dsh-tavern-helper-event-query") { onEvent(data); return; }
				if (data.type !== "dsh-tavern-helper-response") return;
				const task = pending[data.requestId];
				if (!task) return;
				delete pending[data.requestId];
				if (data.ok) {
					// A variable receipt may need a read-only resync before the
					// caller can safely read its synchronous compatibility state.
					try { Promise.resolve(onContext(data.result || {}, task.method)).then(function () { task.resolve(data.result); }, task.reject); }
					catch (error) { task.reject(error); }
				}
				else {
					const error = new Error(String(data.error || "Helper 调用失败"));
					if (typeof data.errorCode === "string" && data.errorCode) error.code = data.errorCode;
					error.dshTavernScriptId = task.owner.scriptId;
					error.dshTavernEventId = task.owner.eventId;
					error.dshTavernMethod = task.method;
					task.reject(error);
				}
			}
			options.listen(receive);
			return Object.freeze({ request: request, post: post });
		}

		function createTavernHelperEventBus(options) {
			const { currentScript, withScript, reportSubscriptions, post } = options;
			const listeners = Object.create(null);
			function eventName(name) {
				const aliases = { message_sent: "MESSAGE_SENT", message_received: "MESSAGE_RECEIVED", message_updated: "MESSAGE_UPDATED", message_swiped: "MESSAGE_SWIPED", message_deleted: "MESSAGE_DELETED", message_edited: "MESSAGE_EDITED", chat_id_changed: "CHAT_CHANGED", chat_created: "CHAT_CREATED", character_page_loaded: "CHARACTER_PAGE_LOADED" };
				return aliases[String(name)] || String(name);
			}
			function removeEventEntry(name, entry) {
				if (listeners[name]) listeners[name].delete(entry);
				reportSubscriptions();
			}
			function listen(name, handler, position, once) {
				name = eventName(name);
				if (typeof handler !== "function") throw new TypeError("事件监听器必须是函数");
				let items = listeners[name] || (listeners[name] = new Set());
				let entry = Array.from(items).find(function (item) { return item.scriptId === currentScript().id && item.handler === handler; });
				if (!entry) entry = { scriptId: currentScript().id, handler: handler, once: once === true };
				if (position) items.delete(entry);
				if (position === "first") listeners[name] = new Set([entry].concat(Array.from(items)));
				else items.add(entry);
				reportSubscriptions();
				return { stop: function () { removeEventEntry(name, entry); } };
			}
			async function invokeEventEntry(name, entry, args) {
				if (!listeners[name] || !listeners[name].has(entry)) return;
				// Remove before calling so recursive emits cannot invoke a once-listener twice.
				if (entry.once) removeEventEntry(name, entry);
				const pending = withScript(entry.scriptId, function () { return entry.handler.apply(null, args); });
				return name === "mag_variable_initialized" && options.initializationTiming
					? await options.initializationTiming.wait("variable-initialized", pending, entry.scriptId) : await pending;
			}
			async function eventEmit(name) {
				name = eventName(name);
				const args = Array.prototype.slice.call(arguments, 1);
				const items = listeners[name] ? Array.from(listeners[name]) : [];
				// mvu_zod gates validation details on the official panel's checkbox.
				// Our executor has no visible panel: capture those errors for the receipt
				// without changing stored settings, commands, or validation behavior.
				let notification, previous;
				if (name === "mag_command_parsed_for_zod") {
					try {
						notification = options.document && options.document.getElementById("mvu_notification_error");
						if (notification) { previous = notification.checked; notification.checked = true; }
					} catch (_) { notification = null; }
				}
				try { for (const entry of items) await invokeEventEntry(name, entry, args); }
				finally { try { if (notification) notification.checked = previous; } catch (_) { } }
			}
			async function emitHostEvent(eventId, name, args) {
				name = eventName(name);
				const items = listeners[name] ? Array.from(listeners[name]) : [];
				for (const entry of items) {
					post({ type: "dsh-tavern-helper-event-progress", eventId: eventId, scriptId: entry.scriptId, phase: "started" });
					try { await invokeEventEntry(name, entry, args); }
					catch (error) {
						if (error && typeof error === "object" && !error.dshTavernScriptId) error.dshTavernScriptId = entry.scriptId;
						post({ type: "dsh-tavern-helper-event-progress", eventId: eventId, scriptId: entry.scriptId, phase: "failed" });
						throw error;
					}
					post({ type: "dsh-tavern-helper-event-progress", eventId: eventId, scriptId: entry.scriptId, phase: "completed" });
				}
			}
			function off(name, handler) {
				name = eventName(name);
				if (listeners[name]) for (const entry of Array.from(listeners[name])) if (entry.handler === handler && entry.scriptId === currentScript().id) listeners[name].delete(entry);
				reportSubscriptions();
			}
			function clearMatching(predicate) {
				const scriptId = currentScript().id;
				for (const name of Object.keys(listeners)) for (const entry of Array.from(listeners[name])) {
					if (entry.scriptId === scriptId && predicate(name, entry)) listeners[name].delete(entry);
				}
				reportSubscriptions();
			}
			return Object.freeze({
				clearEvent: function (name) { name = eventName(name); clearMatching(function (key) { return key === name; }); },
				clearListener: function (handler) { clearMatching(function (_name, entry) { return entry.handler === handler; }); },
				clearAll: function () { clearMatching(function () { return true; }); },
				listen: listen, off: off, emit: eventEmit, emitHost: emitHostEvent,
				names: function () { return Object.keys(listeners).filter(function (name) { return listeners[name] && listeners[name].size > 0; }); },
				subscriptionsFor: function (scriptId) { return Object.keys(listeners).filter(function (name) { return listeners[name] && Array.from(listeners[name]).some(function (entry) { return entry.scriptId === scriptId; }); }); }
			});
		}

		function createTavernHelperPopup(options) {
			const { document, parent, token } = options;
			function HelperPopup(content, _type, title, options) {
				const popup = this;
				popup.content = content;
				popup.options = options && typeof options === "object" ? options : {};
				popup.root = null;
				popup.resolve = null;
				popup.completeAffirmative = async function () {
					if (popup.root) popup.root.remove();
					popup.root = null;
					parent.postMessage({ type: "dsh-tavern-helper-ui-close", token: token }, "*");
					if (popup.resolve) { const resolve = popup.resolve; popup.resolve = null; resolve(true); }
					return true;
				};
				popup.show = function () {
					if (popup.root) return Promise.resolve(false);
					const overlay = document.createElement("div");
					overlay.setAttribute("data-dsh-helper-popup", "");
					overlay.style.cssText = "position:fixed;inset:0;z-index:10;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.64);box-sizing:border-box";
					const panel = document.createElement("section");
					panel.style.cssText = "width:min(920px,100%);max-height:90vh;overflow:auto;border:1px solid rgba(255,255,255,.2);border-radius:16px;padding:16px;background:#15191f;color:#eef4fb;box-shadow:0 24px 80px rgba(0,0,0,.5);box-sizing:border-box";
					if (title) { const heading = document.createElement("h2"); heading.textContent = String(title); panel.appendChild(heading); }
					const node = content && content.jquery ? content[0] : content;
					if (node && typeof node.nodeType === "number") panel.appendChild(node);
					else if (node !== undefined && node !== null) { const text = document.createElement("div"); text.textContent = String(node); panel.appendChild(text); }
					const actions = document.createElement("div");
					actions.style.cssText = "display:flex;justify-content:flex-end;margin-top:14px";
					const close = document.createElement("button");
					close.type = "button"; close.textContent = String(popup.options.okButton || "关闭");
					close.style.cssText = "border:1px solid rgba(255,255,255,.24);border-radius:9px;padding:7px 14px;background:#273241;color:#fff;cursor:pointer";
					close.addEventListener("click", popup.completeAffirmative);
					actions.appendChild(close); panel.appendChild(actions); overlay.appendChild(panel); document.body.appendChild(overlay);
					popup.root = overlay;
					parent.postMessage({ type: "dsh-tavern-helper-ui-open", token: token }, "*");
					return new Promise(function (resolve) { popup.resolve = resolve; });
				};
			}
			return HelperPopup;
		}

		function createTavernChatDataFacade(options) {
			const { copy, request } = options;
			const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
			const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
			const reserved = new Set(["message_id", "message", "mes", "role", "is_user", "is_system", "name", "send_date", "swipe_id", "swipes", "swipes_data", "variables", "pluginData", "original_avatar", "force_avatar"]);
			let chat = [], metadata = {}, rows = [], metadataBase = {}, metadataRevision = 0;
			let binding = "", chatId = "", lifecycleRevision = 0, lastRevision = -1;
			let tail = Promise.resolve(), saving = false, deferred = null;
			function keyOf(value) { return String(value.chatId || "") + ":" + Number(value.lifecycleRevision || 0); }
			function set(target, key, value) {
				Object.defineProperty(target, key, { value: copy(value), writable: true, configurable: true, enumerable: true });
			}
			function reconcile(target, source) {
				for (const key of Object.keys(target)) if (!own(source, key)) delete target[key];
				for (const key of Object.keys(source)) {
					const a = own(target, key) ? target[key] : undefined, b = source[key];
					if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
						reconcile(a, b); if (Array.isArray(a)) a.length = b.length;
					} else set(target, key, b);
				}
			}
			function pluginData(value) {
				const result = {};
				for (const key of Object.keys(value)) if (!reserved.has(key)) set(result, key, value[key]);
				return result;
			}
			function mergeView(target, base, remote, fields) {
				for (const key of new Set(Object.keys(base).concat(Object.keys(remote)))) {
					if (fields && !fields(key)) continue;
					if (own(target, key) !== own(base, key) || !same(target[key], base[key])) continue;
					if (!own(remote, key)) delete target[key];
					else if (target[key] && remote[key] && typeof target[key] === "object" && typeof remote[key] === "object" && Array.isArray(target[key]) === Array.isArray(remote[key])) {
						reconcile(target[key], remote[key]); if (Array.isArray(target[key])) target[key].length = remote[key].length;
					} else set(target, key, remote[key]);
				}
			}
			function coreOf(message) {
				const core = copy(message); delete core.pluginData;
				core.mes = String(message.message || ""); core.is_user = message.role === "user";
				core.variables = copy(message.swipes_data || []);
				return core;
			}
			function identity(core) { return [core.message_id, core.role, core.message, core.swipe_id, core.swipes]; }
			function layoutMatches() { return chat.length === rows.length && rows.every((row, index) => chat[index] === row.view); }
			function dirty() { return !layoutMatches() || !same(metadata, metadataBase) || rows.some(row => !same(pluginData(row.view), row.base)); }
			function sync(value, acknowledged, variableDelta) {
				if (!value) return;
				if (saving && !acknowledged) {
					if (!deferred || keyOf(value) !== keyOf(deferred) || Number(value.stateRevision || 0) >= Number(deferred.stateRevision || 0)) deferred = copy(value);
					return;
				}
				const nextBinding = keyOf(value), revision = Number(value.stateRevision || 0);
				if (binding !== nextBinding) {
					if (binding && dirty()) console.warn("聊天或历史版本已切换，未保存的插件编辑已隔离，请在当前聊天重新操作");
					chat = []; rows = []; metadata = {}; metadataBase = {}; metadataRevision = revision; lastRevision = -1;
					binding = nextBinding;
				}
				if (revision < lastRevision && !acknowledged) return;
				chatId = String(value.chatId || ""); lifecycleRevision = Number(value.lifecycleRevision || 0);
				// Do not conceal an unsupported local splice/reorder with a host refresh.
				if (!layoutMatches()) return;
				const variablesOnly = variableDelta && !acknowledged && revision === variableDelta.stateRevision
					&& lastRevision === variableDelta.baseRevision && rows.length === (value.messages || []).length;
				const nextRows = (value.messages || []).map(function (message, index) {
					if (variablesOnly && index !== variableDelta.messageId) {
						const row = rows[index];
						if (same(pluginData(row.view), row.base)) row.revision = revision;
						return row;
					}
					const core = coreOf(message), remote = copy(message.pluginData || {});
					let row = rows[index];
					if (!row || !same(identity(row.core), identity(core))) {
						const view = copy(remote); for (const key of Object.keys(core)) set(view, key, core[key]);
						return { view: view, core: core, base: remote, revision: revision };
					}
					const ack = acknowledged && acknowledged.messages.find(item => item.message_id === core.message_id);
					mergeView(row.view, ack ? ack.data : row.base, remote, key => !reserved.has(key));
					mergeView(row.view, row.core, core, key => reserved.has(key));
					row.core = core;
					if (ack || same(pluginData(row.view), remote)) { row.base = remote; row.revision = revision; }
					return row;
				});
				rows = nextRows; chat.splice(0, chat.length, ...rows.map(row => row.view));
				const remoteMetadata = copy(value.chatMetadata || {}), ackMetadata = acknowledged && acknowledged.metadata;
				mergeView(metadata, ackMetadata ? ackMetadata.data : metadataBase, remoteMetadata);
				if (ackMetadata || same(metadata, remoteMetadata)) { metadataBase = remoteMetadata; metadataRevision = revision; }
				lastRevision = revision;
			}
			function snapshot() {
				if (!layoutMatches()) throw new Error("saveChat 不支持新增、删除、替换或重排历史消息");
				const messages = [];
				for (const row of rows) {
					for (const key of reserved) if (own(row.view, key) !== own(row.core, key) || !same(row.view[key], row.core[key])) throw new Error("saveChat 只保存插件数据，不支持修改正文、身份或消息版本: " + key);
					const data = pluginData(row.view);
					if (!same(data, row.base)) messages.push({ message_id: row.core.message_id, stateRevision: row.revision, data: data });
				}
				const result = { chatId: chatId, lifecycleRevision: lifecycleRevision, messages: messages };
				if (!same(metadata, metadataBase)) result.metadata = { stateRevision: metadataRevision, data: copy(metadata) };
				return result;
			}
			function save() {
				const requestedBinding = binding;
				const task = tail.catch(function () { }).then(async function () {
					if (binding !== requestedBinding) throw new Error("聊天已切换，已取消旧聊天的排队保存");
					const submitted = snapshot();
					if (!submitted.messages.length && !submitted.metadata) return;
					saving = true;
					try {
						const result = await request("saveTavernChatData", { request: submitted });
						if (!result || result.updated !== true || !result.context) throw new Error("插件聊天数据未保存");
						sync(result.context, submitted);
					} finally {
						saving = false;
						const pending = deferred; deferred = null; if (pending) sync(pending);
					}
				});
				tail = task;
				task.catch(function (error) { console.error(error); });
				return task;
			}
			function updateMetadata(values, reset) {
				if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("聊天元数据必须是对象");
				if (reset) reconcile(metadata, values);
				else for (const key of Object.keys(values)) set(metadata, key, values[key]);
			}
			sync(options.context());
			return { sync: sync, save: save, updateMetadata: updateMetadata, chat: () => chat, metadata: () => metadata };
		}

		function installTavernCompatibilityDiagnostics(options) {
			const counts = new Map();
			for (const entry of options.catalog || []) {
				const target = options.surfaces[entry.surface];
				if (!target || !["noop", "reject", "missing"].includes(entry.policy)) continue;
				function record(args) {
					const scriptId = options.currentScript().id;
					const key = scriptId + "\n" + entry.id;
					const count = Math.min(Number.MAX_SAFE_INTEGER, (counts.get(key) || 0) + 1);
					counts.set(key, count);
					// typeof never traverses plugin objects, invokes getters or serializes secrets.
					const argumentTypes = Array.from(args).slice(0, 12).map(value => value === null ? "null" : typeof value);
					options.post({ type: "dsh-tavern-helper-compatibility", scriptId: scriptId, capabilityId: entry.id, count: count, argumentTypes: argumentTypes });
				}
				if (entry.policy === "missing") {
					// Preserve typeof-based fallbacks. This records a lookup, never a successful call.
					Object.defineProperty(target, entry.name, {
						configurable: true, get: function () { record([]); return undefined; },
						set: function (value) { Object.defineProperty(target, entry.name, { value: value, configurable: true, writable: true }); }
					});
				} else target[entry.name] = function () {
					record(arguments);
					if (entry.policy === "reject") {
						const error = new Error("[unsupported] " + entry.id + " 尚未实现，操作未执行");
						error.code = "TAVERN_CAPABILITY_UNSUPPORTED";
						throw error;
					}
				};
				// Helper scripts also use the same APIs as bare window globals.
				if (entry.surface === "TavernHelper") Object.defineProperty(options.window, entry.name, {
					configurable: true, get: function () { return target[entry.name]; }, set: function (value) { target[entry.name] = value; }
				});
			}
		}

		// @include local-variables.js
		// @include variable-receipts.js

		function installTavernHelperFacade(options) {
			const nativeWorldInfoSnapshots = new WeakMap();
			const nativeWorldInfoByName = new Map();
			const functionTools = new Map();
			const { window, copy, context, request: call, Popup: HelperPopup } = options;
			const chatData = options.createChatData({ copy: copy, context: context, request: call });
			const localVariables = options.createLocalVariables({ context, request: call, copy, currentScript: options.currentScript, reportError: error => console.error(error) });
			async function saveChatData() {
				const chatId = context().chatId, revision = context().lifecycleRevision;
				await localVariables.flush();
				if (context().chatId !== chatId || context().lifecycleRevision !== revision) throw new Error("聊天已切换或历史版本已变化，插件数据未保存");
				return chatData.save();
			}
			const extensionSettings = Object.assign(Object.create(null), copy(context().extensionSettings || {}));
			// Tavern applies enabled card regexes without ST's per-avatar opt-in.
			// Project that host-owned permission without persisting a fabricated setting.
			const visibleExtensionSettings = new Proxy(extensionSettings, {
				get: function (target, key) {
					if (key !== "character_allowed_regex") return target[key];
					const allowed = Array.isArray(target[key]) ? target[key].slice() : [];
					const character = context().character;
					if (character && typeof character === "object") {
						const avatar = character.avatar || String(character.path || "");
						if (!allowed.includes(avatar)) allowed.push(avatar);
					}
					return allowed;
				}
			});
			let savedExtensionSettings = copy(extensionSettings);
			let settingsTail = Promise.resolve();
			// Keep plugin-held object references stable when acknowledging persisted settings.
			function reconcileSettings(target, source) {
				for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(source, key)) delete target[key];
				for (const key of Object.keys(source)) {
					const value = source[key], previous = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined;
					if (value && previous && typeof value === "object" && typeof previous === "object" && Array.isArray(value) === Array.isArray(previous)) {
						reconcileSettings(previous, value);
						if (Array.isArray(previous)) previous.length = value.length;
					} else Object.defineProperty(target, key, { value: copy(value), enumerable: true, configurable: true, writable: true });
				}
			}
			function saveExtensionSettings() {
				// Serialize calls without an unload-sensitive debounce timer. Capture at execution
				// time so a burst of legacy fire-and-forget calls saves the newest edits.
				const task = settingsTail.catch(function () { }).then(async function () {
					const submitted = JSON.parse(JSON.stringify(extensionSettings));
					const result = await call("saveTavernExtensionSettings", { settings: submitted, expectedSettings: savedExtensionSettings });
					if (!result || !result.extensionSettings || result.updated === false) throw new Error("插件设置未保存");
					const remote = result.extensionSettings;
					for (const key of new Set(Object.keys(submitted).concat(Object.keys(remote)))) {
						// Edits made while the write was in flight stay dirty for the next call.
						if (JSON.stringify(extensionSettings[key]) !== JSON.stringify(submitted[key])) continue;
						if (Object.prototype.hasOwnProperty.call(remote, key)) {
							const patch = Object.create(null); patch[key] = remote[key];
							const current = Object.create(null);
							if (Object.prototype.hasOwnProperty.call(extensionSettings, key)) current[key] = extensionSettings[key];
							reconcileSettings(current, patch);
							Object.defineProperty(extensionSettings, key, { value: current[key], enumerable: true, configurable: true, writable: true });
						} else delete extensionSettings[key];
					}
					savedExtensionSettings = copy(remote);
					return copy(remote);
				});
				settingsTail = task;
				task.catch(function (error) { console.error(error); });
				return task;
			}
			// Both entry points reference the same functions; plugin wrappers stay visible to each other.
			const helper = {};
			const helperNames = ["generateRaw", "injectPrompts", "uninjectPrompts", "getScriptId", "getScriptName", "getScriptInfo", "replaceScriptInfo", "getScriptButtons", "replaceScriptButtons", "updateScriptButtonsWith", "appendInexistentScriptButtons", "getButtonEvent", "getCharData", "getCurrentCharacterName", "getCurrentMessageId", "getLastMessageId", "getChatMessages", "setChatMessages", "createChatMessages", "getVariables", "getAllVariables", "replaceVariables", "insertOrAssignVariables", "insertVariables", "updateVariablesWith", "deleteVariable", "getTavernRegexes", "replaceTavernRegexes", "updateTavernRegexesWith", "importRawTavernRegex", "replaceWorldbook", "createWorldbookEntries", "deleteWorldbookEntries", "setLorebookEntries", "createLorebookEntries", "deleteLorebookEntries", "getLorebooks", "getWorldbookNames", "getCharWorldbookNames", "getWorldbook", "getLorebookEntries", "getCharLorebooks", "getCurrentCharPrimaryLorebook", "getLorebookSettings", "setLorebookSettings", "updateWorldbookWith", "getTavernHelperVersion", "substitudeMacros", "iframe_events", "tavern_events"];
			for (const name of helperNames) Object.defineProperty(helper, name, { enumerable: true, configurable: true, get: function () { return window[name]; }, set: function (value) { window[name] = value; } });
			window.TavernHelper = helper;
			const eventSource = { on: window.eventOn, once: window.eventOnce, off: window.eventOff, removeListener: window.eventOff, makeFirst: window.eventMakeFirst, makeLast: window.eventMakeLast, emit: window.eventEmit };
			const sillyTavern = {
				TavernHelper: helper,
				variables: Object.freeze({ local: localVariables.api }),
				substituteParams: function (value) { return window.substitudeMacros(value); },
				getContext: function () { return sillyTavern; },
				eventSource: eventSource,
				eventTypes: window.tavern_events,
				Popup: HelperPopup,
				POPUP_TYPE: Object.freeze({ DISPLAY: "display", TEXT: "text", CONFIRM: "confirm", INPUT: "input" }),
				POPUP_RESULT: Object.freeze({ AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 2 }),
				extensionSettings: visibleExtensionSettings,
				// These ST rewriting/media restrictions are disabled in Tavern rendering.
				powerUserSettings: Object.freeze({ auto_fix_generated_markdown: false, trim_sentences: false, forbid_external_media: false, encode_tags: false }),
				get characters() {
					const character = context().character;
					if (!character || typeof character !== "object") return [];
					const current = copy(character);
					if (!current.avatar) current.avatar = String(current.path || "");
					return [current];
				},
				get characterId() { return context().character && typeof context().character === "object" ? 0 : undefined; },
				chatCompletionSettings: {},
				ToolManager: Object.freeze({ isToolCallingSupported: function () { return false; } }),
				isToolCallingSupported: function () { return false; },
				canPerformToolCalls: function () { return false; },
				registerFunctionTool: function (tool) {
					if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new TypeError("Function Tool 定义无效");
					const name = String(tool.name || "").trim();
					if (!name) throw new TypeError("Function Tool 名称不能为空");
					if (typeof tool.action !== "function") throw new TypeError("Function Tool action 必须是函数");
					if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) throw new TypeError("Function Tool parameters 必须是 JSON Schema 对象");
					functionTools.set(name, tool);
				},
				unregisterFunctionTool: function (name) { functionTools.delete(String(name || "")); },
				getCurrentChatId: function () { return String(context().chatId || ""); },
				getCurrentLocale: function () { return "zh-CN"; },
				getCharacterCardFields: function () { return copy(context().character && (context().character.data || context().character) || {}); },
				loadWorldInfo: async function (name) {
					const result = await call("loadTavernWorldInfo", { name: name });
					const document = copy(result.worldInfo);
					nativeWorldInfoSnapshots.set(document, copy(document));
					nativeWorldInfoByName.set(String(name || "current"), copy(document));
					return document;
				},
				saveWorldInfo: async function (name, document) {
					const expected = nativeWorldInfoSnapshots.get(document) || nativeWorldInfoByName.get(String(name || "current"));
					if (!expected) throw new Error("保存前请先读取世界书");
					const result = await call("saveTavernWorldInfo", { name: name, worldInfo: copy(document), expectedWorldInfo: copy(expected) });
					if (!result || result.updated === false) throw new Error("世界书未保存");
					nativeWorldInfoSnapshots.set(document, copy(result.worldInfo));
					nativeWorldInfoByName.set(String(name || "current"), copy(result.worldInfo));
					context().worldbook = copy(result.worldbook);
				},
				callGenericPopup: function (content, type, title, options) {
					// MVU's legacy JSONL compaction is not a DSH history operation. Decline only
					// this maintenance prompt; never delete snapshots or dismiss other confirms.
					const legacyCleanup = typeof content === "string" && (
						content.startsWith("检测到可以清理本聊天文件中的旧变量以减小文件体积，是否清理？") ||
						content.startsWith("Old variables can be removed from this chat to reduce its file size. Clean them now?")
					);
					if (type === "confirm" && legacyCleanup) return Promise.resolve(0);
					return new HelperPopup(content, type, title, options).show();
				},
				saveChat: saveChatData,
				saveMetadata: saveChatData,
				saveMetadataDebounced: saveChatData,
				updateChatMetadata: chatData.updateMetadata,
				saveSettingsDebounced: saveExtensionSettings
			};
			Object.defineProperties(sillyTavern, {
				chatId: { enumerable: true, get: function () { return String(context().chatId || ""); } },
				name1: { enumerable: true, get: function () { return String(context().playerName || "你"); } },
				chat: { enumerable: true, get: chatData.chat },
				chatMetadata: { enumerable: true, get: chatData.metadata },
				name2: { enumerable: true, get: function () { return String(context().characterName || "角色"); } }
			});
			options.installCompatibility({ catalog: context().compatibilityCapabilities, surfaces: { TavernHelper: helper, SillyTavern: sillyTavern }, window: window, currentScript: options.currentScript, post: options.post });
			window.SillyTavern = Object.freeze(sillyTavern);
			window.getContext = sillyTavern.getContext;
			window.errorCatched = function (factory) { return function () { try { return factory.apply(this, arguments); } catch (error) { console.error(error); return {}; } }; };
			window.retrieveDisplayedMessage = function () { return window.jQuery ? window.jQuery() : []; };
			window.toastr = { success: console.info, info: console.info, warning: console.warn, error: console.error };
			return { sync: function (value, variableDelta) { chatData.sync(value, undefined, variableDelta); localVariables.sync(); }, flushVariables: localVariables.flush };
		}

        function ContextCompactionSettings() {
            const [policy, setPolicy] = React.useState(null), [notice, setNotice] = React.useState(""), [busy, setBusy] = React.useState(false);
            React.useEffect(function () { let active = true; rpc("getTavernSettings").then(function (result) { if (active) setPolicy(result.settings.contextCompaction || { mode: "manual", rounds: 20, percent: 80, retainRounds: 10 }); }, function (error) { if (active) setNotice(error.message); }); return function () { active = false; }; }, []);
            async function save() {
                setBusy(true); setNotice("");
                try { const result = await rpc("updateTavernSettings", { patch: { contextCompaction: { mode: policy.mode, rounds: Number(policy.rounds), percent: Number(policy.percent), retainRounds: String(policy.retainRounds ?? 10).trim() === "" ? "" : Number(policy.retainRounds ?? 10) } } }); setPolicy(result.settings.contextCompaction); setNotice("已保存，下一个安全边界生效"); }
                catch (error) { setNotice(String(error.message || error)); } finally { setBusy(false); }
            }
            return React.createElement("div", { className: "dsh-tavern-settings-group dsh-tavern-compaction-settings" },
                React.createElement("h3", { className: "dsh-tavern-settings-title" }, "上下文压缩"),
                React.createElement("p", { className: "dsh-tavern-settings-desc" }, "默认手动，也可按轮数或占用比例自动压缩前后台。所有模式都保留接近容量或请求超限时的自动保护，不会删除原始剧情记录。"),
                policy ? React.createElement("label", { className: "dsh-tavern-compaction-field" }, "压缩模式", React.createElement("select", { className: "dsh-tavern-settings-select", value: policy.mode, disabled: busy, onChange: function (e) { setPolicy(Object.assign({}, policy, { mode: e.target.value })); } }, [["manual", "手动压缩（默认）"], ["rounds", "每 N 轮自动压缩"], ["percent", "上下文达到 X% 自动压缩"]].map(function (item) { return React.createElement("option", { key: item[0], value: item[0] }, item[1]); }))) : null,
                policy && policy.mode !== "manual" ? React.createElement("label", { className: "dsh-tavern-compaction-field" }, policy.mode === "rounds" ? "剧情轮数（1–1000）" : "上下文占用百分比（10–95，估算）", React.createElement("input", { className: "dsh-tavern-settings-select", type: "number", min: policy.mode === "rounds" ? 1 : 10, max: policy.mode === "rounds" ? 1000 : 95, step: 1, value: policy[policy.mode], disabled: busy, onChange: function (e) { setPolicy(Object.assign({}, policy, { [policy.mode]: e.target.value })); } })) : null,
                React.createElement("p", { className: "dsh-tavern-settings-desc" }, "重写同一轮、工具调用和生图不计轮数。模型窗口未知时百分比模式会提示；可改用轮数模式。"),
                policy ? React.createElement("label", { className: "dsh-tavern-compaction-field" }, "压缩后保留最近几轮原文（0–100）", React.createElement("input", { className: "dsh-tavern-settings-select", type: "number", "aria-label": "压缩后保留最近几轮原文", min: 0, max: 100, step: 1, value: policy.retainRounds ?? 10, disabled: busy, onChange: function (e) { setPolicy(Object.assign({}, policy, { retainRounds: e.target.value })); } })) : null,
                React.createElement("p", { className: "dsh-tavern-settings-desc" }, "前台压缩只总结更早的剧情，最近几轮保留原文，压缩后仍可回退、重新生成和切换变体；保留部分最多占模型窗口的四分之一。设为 0 时只保留最后一条回复，摘要会额外记下「当前情况」。"),
                React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy || !policy, onClick: save }, busy ? "保存中…" : "保存压缩设置"),
                notice ? React.createElement("p", { role: "status", className: "dsh-tavern-settings-desc" }, notice) : null);
        }
        const EMPTY_PROJECTION_FACE = Object.freeze({ subscribe: function () { return function () { }; }, getSnapshot: function () { return null; } });

		function backgroundModelLabel(selection, catalog) {
			if (!selection || !selection.provider || !selection.model) return "";
			const groups = Array.isArray(catalog) ? catalog : [];
			const group = groups.find(function (item) { return item && item.provider === selection.provider; });
			const model = group && Array.isArray(group.models) ? group.models.find(function (item) { return item && item.id === selection.model; }) : null;
			return (group && (group.providerName || group.provider) || selection.provider) + ": " + (model && (model.name || model.id) || selection.model);
		}

		function TavernBackgroundModelLabel(props) {
			const sessionId = String(props.sessionId || "");
			const binding = sessionId && props.sessions ? props.sessions.binding(sessionId) : null;
			const subagentFace = binding ? binding.session.projections.faceOf("subagent") : EMPTY_PROJECTION_FACE;
			const modelFace = binding ? binding.session.projections.faceOf("modelSelection") : EMPTY_PROJECTION_FACE;
			const identity = React.useSyncExternalStore(
				function (listener) { return subagentFace.subscribe(listener); },
				function () { return subagentFace.getSnapshot(); },
				function () { return subagentFace.getSnapshot(); }
			);
			const modelState = React.useSyncExternalStore(
				function (listener) { return modelFace.subscribe(listener); },
				function () { return modelFace.getSnapshot(); },
				function () { return modelFace.getSnapshot(); }
			);
			const [catalog, setCatalog] = React.useState([]);
			const isTavernBackground = Boolean(props.sessions && props.sessions.subagentAddress(sessionId)) && identity && identity.label === "酒馆后台 Agent";
			React.useEffect(function () {
				let active = true;
				if (!isTavernBackground) return function () { active = false; };
				rpc("getTavernSettings").then(function (result) {
					if (active) setCatalog(Array.isArray(result.modelCatalog) ? result.modelCatalog : []);
				}, function () { });
				return function () { active = false; };
			}, [isTavernBackground]);
			if (!isTavernBackground) return null;
			const selection = modelState && (modelState.next || modelState.lastUsed);
			const label = backgroundModelLabel(selection, catalog);
			if (!label) return null;
			return React.createElement("div", {
				className: "dsh-tavern-background-model",
				title: label + "（可在本局设置中修改）",
				"aria-label": "后台模型：" + label
			}, React.createElement("span", null, label));
		}

        function TavernConversationWritingSkills(props) {
            const h = React.createElement;
            const [skills, setSkills] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(""), [notice, setNotice] = React.useState("");
            async function load() { try { const result = await rpc(props.globalDefaults ? "getDefaultWritingSkills" : "getConversationWritingSkills", { sessionId: props.sessionId }, props.sessionId); setSkills(result.skills); setError(""); } catch (err) { setError(String(err.message || err)); } }
            React.useEffect(() => { void load(); }, []);
            async function change(name, enabled) {
                if (busy) return;
                setBusy(true); setError(""); setNotice("");
                try { await rpc(props.globalDefaults ? "setDefaultWritingSkill" : "setConversationWritingSkill", { sessionId: props.sessionId, name, enabled }, props.sessionId); setSkills(skills.map(skill => skill.name === name ? { ...skill, enabled } : skill)); setNotice(props.globalDefaults ? "已保存，下次新游戏生效" : "已生效，后续请求采用新设置"); }
                catch (err) { setError(String(err.message || err)); } finally { setBusy(false); }
            }
            return h(props.globalDefaults ? "details" : "section", { className: "dsh-local-section" + (props.globalDefaults ? " dsh-tavern-default-skills" : ""), "aria-label": props.globalDefaults ? "默认写作 Skill" : "写作 Skill" },
                props.globalDefaults ? h("summary", null, "默认写作 Skill") : h("h3", null, "写作 Skill"),
                h("p", { className: "dsh-local-help" }, props.globalDefaults ? "设置新游戏默认启用的写作 Skill。已有游戏不变，可在本局设置中逐项调整。" : "开局采用全局默认配置，可在此逐项调整本局后续加载；前台按场景选用。"),
                (skills || []).map(skill => h("div", { key: skill.name, className: "dsh-tavern-background-task dsh-tavern-writing-skill" },
                    h("label", { className: "dsh-tavern-writing-skill-heading" }, h("span", null, skill.name), h("input", { type: "checkbox", role: "switch", "aria-label": skill.name, checked: skill.enabled, disabled: busy, onChange: event => change(skill.name, event.target.checked) })),
                    h("p", { className: "dsh-tavern-settings-desc" }, skill.description))),
                skills && !skills.length ? h("p", null, "暂无写作 Skill，请在 Skill 库中分配给前台。") : null,
                !props.globalDefaults ? h("p", { className: "dsh-local-help" }, "开关立即更新，后续模型请求生效；已发出的请求不受影响。通过追加通知保留已有缓存前缀，关闭后停止沿用该 Skill，历史内容保留。") : null,
                error ? h("p", { role: "alert" }, error) : h("span", { role: "status" }, busy ? "保存中…" : skills ? notice : "正在读取…"),
                error ? h("button", { className: "dsh-tavern-btn", onClick: load }, "重新加载") : null);
        }

        function TavernDefaultModelSetting(props) {
            const h = React.createElement;
            const selection = props.selection;
            const key = selection ? JSON.stringify({ provider: selection.provider, model: selection.model }) : "";
            const [reasoning, setReasoning] = React.useState({ key: "", value: null, error: "" });
            React.useEffect(() => {
                let active = true;
                if (key) rpc("getBackgroundModelReasoning", JSON.parse(key)).then(result => {
                    if (active) setReasoning({ key, value: result.reasoning, error: "" });
                }, err => { if (active) setReasoning({ key, value: null, error: String(err.message || err) }); });
                return () => { active = false; };
            }, [key]);
            const efforts = reasoning.key === key ? reasoning.value?.efforts || [] : [];
            const known = !selection || props.catalog.some(group => group.provider === selection.provider && group.models.some(model => model.id === selection.model));
            return h("div", { className: "dsh-tavern-model-row" },
                h("div", { className: "dsh-tavern-model-row-label" }, props.title || props.label,
                    props.description ? h("span", { className: "dsh-tavern-settings-desc" }, props.description) : null),
                h("div", { className: "dsh-tavern-model-row-controls" },
                h("select", { className: "dsh-tavern-settings-select", "aria-label": props.label, value: key, disabled: props.disabled,
                    onChange: event => props.onChange(event.target.value ? JSON.parse(event.target.value) : null) },
                    h("option", { value: "" }, props.fallback),
                    !known ? h("option", { value: key }, backgroundModelLabel(selection, props.catalog) + "（当前不可用）") : null,
                    props.catalog.map(group => h("optgroup", { key: group.provider, label: group.providerName || group.provider }, group.models.map(model => h("option", { key: model.id, value: JSON.stringify({ provider: group.provider, model: model.id }) }, model.name || model.id))))),
                h("select", { className: "dsh-tavern-settings-select", "aria-label": props.label + "推理强度", value: selection?.reasoningEffort || "", disabled: props.disabled || !key || !efforts.length,
                    onChange: event => { const next = { ...selection }; if (event.target.value) next.reasoningEffort = event.target.value; else delete next.reasoningEffort; return props.onChange(next); } },
                    h("option", { value: "" }, key ? "模型默认" : props.fallback), efforts.map(item => h("option", { key: item.id, value: item.id }, item.name || item.id)))),
                key && reasoning.key === key && reasoning.error ? h("p", { role: "alert" }, reasoning.error) : null);
        }

        function PromptTemplateSettingsEntry({ sessionId } = {}) {
            const [error, setError] = React.useState("");
            const request = React.useRef(null);
            React.useEffect(() => () => { request.current?.close?.(); }, [sessionId]);
            function open() {
                setError(""); request.current?.close?.();
                if (!sessionId) {
                    const panel = createServerTemplatePanel({ window, rpc, globalSettings: true });
                    request.current = panel; panel.open(); return;
                }
                const detail = { handled: false, sessionId };
                request.current = detail;
                window.dispatchEvent(new CustomEvent("dsh-template-settings", { detail }));
                if (!detail.handled) setError("请等待本局加载完成后重试。");
            }
            const h = React.createElement;
            return h("section", { className: sessionId ? "dsh-local-section" : "dsh-tavern-settings-group" },
                h("div", { className: "dsh-tavern-settings-row" },
                    h("div", { className: "dsh-tavern-settings-copy" },
                        h("strong", null, sessionId ? "本局模板调试" : "提示词模板"),
                        h("p", { className: "dsh-tavern-settings-desc" }, sessionId ? "执行 EJS 命令，查看或调整本局变量。" : "调整 EJS 模板运行、兼容性与性能选项，对所有游戏生效。")),
                    h("button", { type: "button", className: "dsh-tavern-btn", onClick: open }, sessionId ? "本局模板命令" : "提示词模板设置")),
                error ? h("p", { className: "dsh-tavern-settings-error", role: "alert" }, error) : null);
        }

        const displayPreferences = (() => {
            let value = null, revision = 0;
            const listeners = new Set();
            const key = "dsh-tavern:display-preferences-changed";
            // The top bar reads this before the first read lands; the shipped
            // default keeps it from flashing an empty row.
            function headerItemsOf(settings) {
                const input = settings && settings.headerItems;
                if (!input || typeof input !== "object" || !Array.isArray(input.items)) return { display: TAVERN_HEADER_DEFAULT.display, items: [...TAVERN_HEADER_DEFAULT.items] };
                return { display: input.display === "icon" ? "icon" : "icon-text", items: input.items.filter(item => typeof item === "string").slice(0, 24) };
            }
            function apply(settings) {
                value = { hideContextAndReasoning: settings.hideContextAndReasoning !== false, headerItems: headerItemsOf(settings), autoOpenStatusPanel: settings.autoOpenStatusPanel !== false,
                    renderDepth: Number.isSafeInteger(settings.renderDepth) ? settings.renderDepth : 3 };
                document.documentElement.classList.toggle("dsh-tavern-hide-process", value.hideContextAndReasoning);
                listeners.forEach(listener => listener());
            }
            async function refresh() {
                const request = ++revision;
                try { const result = await rpc("getDisplayPreferences"); if (request === revision) apply(result); } catch (_) {}
            }
            return {
                subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
                snapshot: () => value,
                async save(patch) {
                    ++revision;
                    const result = await rpc("updateTavernSettings", { patch });
                    ++revision; apply(result.settings);
                    try { window.localStorage.setItem(key, String(Date.now())); } catch (_) {}
                    // 侧栏的「进入游戏时打开酒馆状态」据此重新读取设置。
                    window.dispatchEvent(new CustomEvent("dsh-tavern-settings-changed"));
                },
                start() {
                    // Hidden is the default; keep process details out of view until the setting loads.
                    if (value === null) document.documentElement.classList.add("dsh-tavern-hide-process");
                    refresh();
                    const onStorage = event => { if (event.key === key) refresh(); };
                    window.addEventListener("focus", refresh);
                    window.addEventListener("storage", onStorage);
                    return () => { ++revision; window.removeEventListener("focus", refresh); window.removeEventListener("storage", onStorage); document.documentElement.classList.remove("dsh-tavern-hide-process"); };
                }
            };
        })();
        function DisplayPreferencesSettings() {
            const preferences = React.useSyncExternalStore(displayPreferences.subscribe, displayPreferences.snapshot, displayPreferences.snapshot);
            const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState("");
            async function save(patch) {
                setBusy(true); setNotice("");
                try { await displayPreferences.save(patch); setNotice("已保存，对所有对话立即生效"); }
                catch (error) { setNotice("保存失败：" + String(error.message || error)); }
                finally { setBusy(false); }
            }
            const h = React.createElement;
            return h("section", { className: "dsh-tavern-settings-group dsh-tavern-display-preferences" },
                h("label", { className: "dsh-tavern-settings-row dsh-tavern-background-task" },
                    h("div", { className: "dsh-tavern-settings-copy" }, h("strong", { className: "dsh-tavern-settings-title" }, "隐藏上下文注入和思考过程"),
                        h("p", { className: "dsh-tavern-settings-desc" }, "隐藏对话中的上下文注入、上下文压缩记录、已思考和思考过程。仅影响显示，正文、模型请求和存档内容不变。")),
                    h("input", { type: "checkbox", role: "switch", "aria-label": "隐藏上下文注入和思考过程", checked: preferences?.hideContextAndReasoning !== false, disabled: preferences === null || busy, onChange: event => save({ hideContextAndReasoning: event.target.checked }) })),
                h("label", { className: "dsh-tavern-settings-row dsh-tavern-background-task" },
                    h("div", { className: "dsh-tavern-settings-copy" }, h("strong", { className: "dsh-tavern-settings-title" }, "进入游戏时打开酒馆状态"),
                        h("p", { className: "dsh-tavern-settings-desc" }, "进入或切换到一局游戏时，右侧面板自动展开并显示本局设置和酒馆状态。关闭后右侧面板保持你上次的样子。手机宽度下不会自动展开。")),
                    h("input", { type: "checkbox", role: "switch", "aria-label": "进入游戏时打开酒馆状态", checked: preferences?.autoOpenStatusPanel !== false, disabled: preferences === null || busy, onChange: event => save({ autoOpenStatusPanel: event.target.checked }) })),
                h("label", { className: "dsh-tavern-settings-row dsh-tavern-background-task" },
                    h("div", { className: "dsh-tavern-settings-copy" }, h("strong", { className: "dsh-tavern-settings-title" }, "渲染深度"),
                        h("p", { className: "dsh-tavern-settings-desc" }, "只有最近几轮渲染人物卡的 HTML 界面（状态栏、美化面板等），更早的轮次只显示文字，可点「渲染此轮」单独打开。重美化的卡渲染太多轮会很卡。")),
                    h("select", { className: "dsh-tavern-settings-select", "aria-label": "渲染深度", value: String(preferences?.renderDepth ?? 3), disabled: preferences === null || busy,
                        onChange: event => save({ renderDepth: Number(event.target.value) }) },
                        [1, 2, 3, 5, 10, 20].map(depth => h("option", { key: depth, value: String(depth) }, "最近 " + depth + " 轮")),
                        h("option", { value: "0" }, "不限"))),
                notice ? h("p", { className: "dsh-tavern-settings-desc", role: "status" }, notice) : null);
        }

        function HeaderItemsSettings(props) {
            const h = React.createElement;
            // The settings page folds this block; the 顶栏设置 dialog is already
            // that one block, so folding there would hide everything behind a
            // title that repeats the dialog's own heading.
            const collapsible = !(props && props.collapsible === false);
            const preferences = React.useSyncExternalStore(displayPreferences.subscribe, displayPreferences.snapshot, displayPreferences.snapshot);
            const catalog = React.useSyncExternalStore(tavernHeaderCatalog.subscribe, tavernHeaderCatalog.snapshot, tavernHeaderCatalog.snapshot);
            const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState("");
            const [dragging, setDragging] = React.useState("");
            const dragRef = React.useRef("");
            const config = preferences && preferences.headerItems ? preferences.headerItems : TAVERN_HEADER_DEFAULT;
            const items = Array.isArray(config.items) ? config.items : [];
            const known = React.useMemo(function () {
                const list = [], seen = new Set();
                function push(entry) { if (!entry || !entry.id || seen.has(entry.id)) return; seen.add(entry.id); list.push(entry); }
                push({ id: "header:export", label: "导出" });
                push({ id: "dsh-tavern:status", label: "酒馆状态" });
                catalog.forEach(push);
                return list;
            }, [catalog]);
            const byId = React.useMemo(function () {
                const map = new Map(known.map(entry => [entry.id, entry]));
                return id => map.get(id) || { id: id, label: String(id).replace(/^[^:]+:/, "") };
            }, [known]);
            const groups = React.useMemo(function () {
                const headerTools = known.filter(entry => entry.id === "header:export");
                return [["顶栏工具", headerTools]].concat(tavernStartGroups(known.filter(entry => entry.id !== "header:export"), []));
            }, [known]);
            async function save(next) {
                setBusy(true); setNotice("");
                try { await displayPreferences.save({ headerItems: { display: next.display, items: next.items } }); setNotice("已保存，对所有对话立即生效"); }
                catch (error) { setNotice("保存失败：" + String(error.message || error)); }
                finally { setBusy(false); }
            }
            function changeItems(next) { return save({ display: config.display, items: next }); }
            function toggle(id) {
                if (busy) return;
                return changeItems(items.includes(id) ? items.filter(value => value !== id) : [...items, id]);
            }
            function move(id, delta) {
                if (busy) return;
                const index = items.indexOf(id), target = index + delta;
                if (index < 0 || target < 0 || target >= items.length) return;
                const next = items.slice();
                [next[index], next[target]] = [next[target], next[index]];
                return changeItems(next);
            }
            function drop(target) {
                const source = dragRef.current;
                dragRef.current = ""; setDragging("");
                if (busy || !source || source === target) return;
                const next = items.filter(value => value !== source);
                next.splice(next.indexOf(target) + (items.indexOf(source) < items.indexOf(target) ? 1 : 0), 0, source);
                return changeItems(next);
            }
            const mode = (value, title, description, preview) => h("button", {
                type: "button", className: "dsh-tavern-header-mode", role: "radio", "aria-checked": config.display === value, disabled: busy || preferences === null,
                onClick: function () { if (config.display !== value) save({ display: value, items: items }); }
            },
                h("span", { className: "dsh-tavern-header-mode-preview" }, preview),
                h("span", { className: "dsh-tavern-header-mode-name" }, h("span", { className: "dsh-tavern-header-radio" }), title),
                h("small", null, description));
            const chip = option => {
                const on = items.includes(option.id);
                return h("button", { key: option.id, type: "button", className: "dsh-tavern-header-chip" + (on ? " is-on" : ""), "aria-pressed": on, disabled: busy, onClick: function () { void toggle(option.id); } },
                    h("span", { className: "dsh-tavern-header-chip-icon", "aria-hidden": true }, tavernStartIcon(option.id, option, 13)),
                    option.label,
                    h("span", { className: "dsh-tavern-header-chip-state", "aria-hidden": true }, on ? "✓" : "＋"));
            };
            const headerSummary = (config.display === "icon" ? "只显示图标" : "图标 + 文字") + " · " + items.length + " 个按钮";
            const heading = h("strong", { className: "dsh-tavern-settings-title", key: "title" }, "自定义顶栏");
            return h(collapsible ? "details" : "section", { className: "dsh-tavern-settings-group dsh-tavern-header-settings-group" + (collapsible ? "" : " is-expanded") },
                collapsible ? h("summary", { className: "dsh-tavern-header-summary" },
                    heading,
                    h("span", { className: "dsh-tavern-header-summary-meta" }, headerSummary),
                    h("span", { className: "dsh-tavern-header-summary-chevron", "aria-hidden": true }, "▾")) : null,
                h("div", { className: "dsh-tavern-settings-copy" },
                    collapsible ? null : heading,
                    h("p", { className: "dsh-tavern-settings-desc" }, "决定会话顶栏显示哪些按钮、按什么顺序、要不要文字。改动立即保存，对所有对话生效。全屏和右侧栏按钮由宿主提供，始终保留在最右。")),
                h("div", { className: "dsh-tavern-header-modes", role: "radiogroup", "aria-label": "顶栏显示方式" },
                    mode("icon", "只显示图标", "最省空间，悬停显示名称",
                        h(React.Fragment, null, h("span", { className: "dsh-tavern-header-mode-chip is-square" }, tavernStartIcon("dsh-tavern:worldbooks", null, 13)), h("span", { className: "dsh-tavern-header-mode-chip is-square" }, tavernStartIcon("dsh-tavern:cards", null, 13)))),
                    mode("icon-text", "图标 + 文字", "一眼认出，适合宽屏",
                        h(React.Fragment, null, h("span", { className: "dsh-tavern-header-mode-chip" }, tavernStartIcon("dsh-tavern:worldbooks", null, 13), "世界书"), h("span", { className: "dsh-tavern-header-mode-chip" }, tavernStartIcon("dsh-tavern:cards", null, 13), "人物卡")))),
                items.length ? h("ul", { className: "dsh-tavern-header-list" }, items.map(function (id, index) {
                    const entry = byId(id);
                    return h("li", {
                        key: id, className: "dsh-tavern-header-list-row" + (dragging === id ? " is-dragging" : ""),
                        onDragOver: function (event) { if (dragRef.current && dragRef.current !== id) event.preventDefault(); },
                        onDrop: function (event) { event.preventDefault(); void drop(id); }
                    },
                        h("span", {
                            className: "dsh-tavern-header-grip", title: "拖动排序", "aria-hidden": true, draggable: !busy,
                            onDragStart: function (event) { dragRef.current = id; setDragging(id); if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; try { event.dataTransfer.setData("text/plain", id); } catch (_) {} } },
                            onDragEnd: function () { dragRef.current = ""; setDragging(""); }
                        }, "⋮⋮"),
                        h("span", { className: "dsh-tavern-header-list-icon", "aria-hidden": true }, tavernStartIcon(id, entry, 16)),
                        h("span", { className: "dsh-tavern-header-list-name" }, h("strong", null, entry.label), h("small", null, id === "header:export" || id === "dsh-tavern:status" ? "原有按钮" : "侧栏页面")),
                        h("span", { className: "dsh-tavern-header-list-ops" },
                            h("button", { type: "button", className: "dsh-tavern-header-op", "aria-label": "上移", title: "上移", disabled: busy || index === 0, onClick: function () { void move(id, -1); } }, "↑"),
                            h("button", { type: "button", className: "dsh-tavern-header-op", "aria-label": "下移", title: "下移", disabled: busy || index === items.length - 1, onClick: function () { void move(id, 1); } }, "↓"),
                            h("button", { type: "button", className: "dsh-tavern-header-op is-danger", "aria-label": "移除", title: "移除", disabled: busy, onClick: function () { void toggle(id); } }, "×")));
                })) : h("p", { className: "dsh-tavern-header-empty" }, "顶栏上没有可编辑的按钮了。从下方添加，或点「恢复默认」找回酒馆状态和导出。"),
                h("div", { className: "dsh-tavern-header-catalog" },
                    h("strong", { className: "dsh-tavern-settings-title" }, "可添加的按钮"),
                    h("p", { className: "dsh-tavern-settings-desc" }, "「顶栏工具」是顶栏自带的按钮；其余与侧栏开始页一致，插件注册的页面也会出现在这里。"),
                    groups.filter(group => group[1].length).map(function ([title, options]) {
                        return h("div", { key: title, className: "dsh-tavern-header-catalog-group" },
                            h("div", { className: "dsh-tavern-header-catalog-title" }, title),
                            h("div", { className: "dsh-tavern-header-chips" }, options.map(chip)));
                    })),
                h("div", { className: "dsh-tavern-header-foot" },
                    h("p", { className: "dsh-tavern-settings-desc" }, "手机和窄窗口上统一只显示图标；放不下的页面会收进顶栏末尾的「⋯」菜单。酒馆状态和导出不会收起。"),
                    h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: function () { void save({ display: TAVERN_HEADER_DEFAULT.display, items: [...TAVERN_HEADER_DEFAULT.items] }); } }, "恢复默认")),
                notice ? h("p", { className: "dsh-tavern-settings-desc", role: "status" }, notice) : null);
        }

        function useCandidatePreferences() {
            const [mode, setMode] = React.useState("after-send");
            React.useEffect(function () {
                let active = true;
                let changed = false;
                function update(event) { changed = true; setMode(event.detail); }
                window.addEventListener("dsh-tavern-candidate-preferences", update);
                rpc("getCandidatePreferences").then(result => {
                    if (active && !changed) setMode(result.candidateDismissMode);
				}, () => { });
                return () => { active = false; window.removeEventListener("dsh-tavern-candidate-preferences", update); };
            }, []);
            return mode;
        }

        function CandidatePreferencesSettings() {
            const mode = useCandidatePreferences();
            const [busy, setBusy] = React.useState(false);
            const [notice, setNotice] = React.useState("");
            async function save(value) {
                if (busy) return;
                setBusy(true); setNotice("");
                try {
                    const result = await rpc("updateTavernSettings", { patch: { candidateDismissMode: value } });
                    window.dispatchEvent(new CustomEvent("dsh-tavern-candidate-preferences", { detail: result.settings.candidateDismissMode }));
                    setNotice("已保存，对所有游戏生效");
                } catch (error) { setNotice("保存失败：" + String(error.message || error)); }
                finally { setBusy(false); }
            }
            const h = React.createElement;
            return h("section", { className: "dsh-tavern-settings-group" },
                h("label", { className: "dsh-tavern-settings-row" },
                    h("span", { className: "dsh-tavern-settings-copy" },
                        h("strong", null, "候选项"),
                        h("p", { className: "dsh-tavern-settings-desc" }, "设置候选项的隐藏时机。")),
                    h("select", { className: "dsh-tavern-settings-select", "aria-label": "候选项收起时机", value: mode, disabled: busy, onChange: event => save(event.target.value) },
                        h("option", { value: "after-fill" }, "选择一项后即隐藏"),
                        h("option", { value: "after-send" }, "可选择多项发送后才隐藏"))),
                notice ? h("div", { className: "dsh-tavern-settings-row", role: "status" },
                    h("span", { className: "dsh-tavern-settings-desc" }, notice)) : null);
        }

        // @include modules/global-settings.js
        const { TavernSettingsSection } = createGlobalSettingsModule({
            React, rpc, notifySettingsChanged: () => window.dispatchEvent(new CustomEvent("dsh-tavern-settings-changed")),
            TavernDefaultModelSetting, TavernConversationWritingSkills, DisplayPreferencesSettings, HeaderItemsSettings,
            CandidatePreferencesSettings, PromptTemplateSettingsEntry, ContextCompactionSettings
        });

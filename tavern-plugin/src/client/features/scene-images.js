		function sceneImageRequestId() {
			// LAN HTTP deployments may not expose crypto.randomUUID. This identifies a
			// request, not an authentication secret; no secure-context API is required.
			return "scene-" + Date.now() + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
		}
		function sceneImageStageLabel(record) {
			return record && record.cancelRequestedAt ? "正在取消…" : record && record.stage === "queued" ? "排队等待生图…" : record && record.stage === "saving" ? "保存图片…" : record && record.stage === "generating" ? "生成图片…" : "整理画面…";
		}
		async function sceneImagePurchaseConfirmation(record, askConfirm) {
			if (!record || record.outcome !== "unconfirmed" || record.providerTask) return undefined;
			return await askConfirm("上一次生图结果未确认，服务可能已经计费。仍要重新请求一张图片吗？这可能再次产生费用。") ? record.requestId : false;
		}
		function useSceneImageRecord(sessionId, turn) {
			const [state, setState] = React.useState(null);
			React.useEffect(function () {
				let active = true, timer, revision = 0, missingRetries = 0;
				setState(null);
				if (!sessionId || !turn) return;
				async function refresh(event) {
					if (event && event.detail && event.detail.sessionId !== sessionId) return;
					const requested = ++revision;
					window.clearTimeout(timer);
					try {
						const result = await rpc("sceneImageStatus", { turn: turn }, sessionId);
						if (!active || requested !== revision) return;
						setState(result.illustration);
						if (result.illustration.reason === "target-unavailable") {
                            if (missingRetries++ < 5) timer = window.setTimeout(refresh, 1500);
                        } else {
                            missingRetries = 0;
                            if (result.illustration.status === "running") timer = window.setTimeout(refresh, 1500);
                        }
					} catch (e) {
						if (active && requested === revision) setState(function (previous) { return Object.assign({}, previous || { status: "unavailable", versions: [] }, { error: String(e.message || e) }); });
					}
				}
				void refresh();
				window.addEventListener("dsh-tavern-image-changed", refresh);
				window.addEventListener("dsh-tavern-image-settings-changed", refresh);
				window.addEventListener("focus", refresh);
				return function () { active = false; window.clearTimeout(timer); window.removeEventListener("dsh-tavern-image-changed", refresh); window.removeEventListener("dsh-tavern-image-settings-changed", refresh); window.removeEventListener("focus", refresh); };
			}, [sessionId, turn]);
			return state;
		}
		function SceneImageAction(props) {
            const askConfirm = useTavernConfirm(props.sessionId || props.scope?.sessionId);
			const [settings, setSettings] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const requestRef = React.useRef(null);
			const state = useSceneImageRecord(props.sessionId, props.turn);
			React.useEffect(function () {
				let active = true, revision = 0;
				async function refresh() {
					const request = ++revision;
					try { const result = await rpc("getSceneImageSettings", { conversation: true, sessionId: props.sessionId }, props.sessionId); if (active && revision === request) setSettings(result.settings); }
					catch (_) { if (active && revision === request) setSettings(null); }
				}
				void refresh();
				const timer = window.setInterval(refresh, 15000);
				window.addEventListener("dsh-tavern-image-settings-changed", refresh);
				window.addEventListener("focus", refresh);
				return function () { active = false; window.clearInterval(timer); window.removeEventListener("dsh-tavern-image-settings-changed", refresh); window.removeEventListener("focus", refresh); };
			}, []);
			async function generate() {
				const reusable = requestRef.current && !(state && requestRef.current.id === state.requestId && ["failed", "cancelled", "idle"].includes(state.status));
				const clickId = reusable && state && requestRef.current.key === state.key ? requestRef.current.id : sceneImageRequestId();
				recordImageInteraction(props.sessionId, props.turn, clickId, "click");
				if (!settings || !settings.enabled || !settings.ready || settings.migrationPending || !state || !state.key || busy || props.running || state.status === "running" || state.recovery === "save" || state.versions && state.versions.length) { recordImageInteraction(props.sessionId, props.turn, clickId, "blocked", "not-ready"); return; }
				const confirmNewRequestId = await sceneImagePurchaseConfirmation(state, askConfirm);
				if (confirmNewRequestId === false) { recordImageInteraction(props.sessionId, props.turn, clickId, "cancelled", "confirmation"); return; }
				if (requestRef.current && requestRef.current.id === state.requestId && ["failed", "cancelled", "idle"].includes(state.status)) requestRef.current = null;
				setBusy(true); setError("");
				if (!requestRef.current || requestRef.current.key !== state.key) requestRef.current = { key: state.key, id: clickId };
				try { await rpc("generateSceneImage", { turn: props.turn, key: state.key, requestId: requestRef.current.id, confirmNewRequestId: confirmNewRequestId }, props.sessionId); requestRef.current = null; }
				catch (e) { setError(String(e.message || e)); }
				finally { setBusy(false); window.dispatchEvent(new CustomEvent("dsh-tavern-image-changed", { detail: { sessionId: props.sessionId } })); }
			}
			if (!settings || settings.enabled !== true) return null;
			const unavailable = settings.migrationPending ? "旧生图配置待迁移，请在全局设置中保存生图 API 配置。" : !settings.ready ? "生图配置未完成，请在设置中补全并保存。" : "";
			const working = state && state.status === "running";
			return React.createElement(React.Fragment, null,
				React.createElement("button", { type: "button", className: "dsh-tavern-choice-trigger", title: unavailable || (!props.turn ? "请先生成一段正文" : !state ? "正在读取生图状态…" : state.error || undefined), disabled: Boolean(unavailable) || !state || !state.key || props.running || busy || working || state.recovery === "save" || state.versions && state.versions.length > 0, onClick: generate }, busy ? "整理画面…" : working ? sceneImageStageLabel(state) : state && state.recovery === "save" ? "图片待保存" : state && state.outcome === "unconfirmed" ? state.providerTask ? "查询原任务" : "重新生图" : state && state.status === "failed" && !state.versions.length ? "重试生图" : "生图"),
				unavailable ? React.createElement("span", { role: "status", className: "dsh-tavern-settings-desc" }, unavailable) : null,
				(error || state && state.error) ? React.createElement("span", { role: "alert", className: "dsh-tavern-settings-error" }, error || state.error) : null
			);
		}
		function SceneImageSettings() {
			const [form, setForm] = React.useState(null);
			const [dirty, setDirty] = React.useState(false);
			const [key, setKey] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState("");
			const [connection, setConnection] = React.useState(null);
			const [models, setModels] = React.useState([]);
			const [modelNotice, setModelNotice] = React.useState("");
			const [checking, setChecking] = React.useState("");
			React.useEffect(function () {
				let active = true;
				rpc("getSceneImageSettings").then(function (result) { if (active) setForm(result.settings); }, function (e) { if (active) setNotice(String(e.message || e)); });
				return function () { active = false; };
			}, []);
			async function save(patch) {
				setBusy(true); setNotice("");
				try {
					const channel = form.channels.find(function (item) { return item.id === form.provider; });
					const input = patch ? Object.assign({ provider: form.provider }, patch) : { provider: form.provider, style: form.style, apiKey: key };
					if (!patch) channel.fields.forEach(function (field) { input[field] = form[field]; });
					if (!patch && form.provider === "comfyui") input.workflow = form.workflow;
					let result = await rpc("saveSceneImageSettings", input); setForm(result.settings); setKey(""); setDirty(false);
					window.dispatchEvent(new CustomEvent("dsh-tavern-image-settings-changed"));
					setNotice("已保存全局 API 配置；请在本局设置中开启场景生图。");
					window.dispatchEvent(new CustomEvent("dsh-tavern-image-settings-changed"));
					return true;
				}
				catch (e) { setNotice(String(e.message || e)); return false; }
				finally { setBusy(false); }
			}
			async function chooseChannel(provider) {
				setBusy(true); setNotice("");
				setConnection(null); setModels([]); setModelNotice("");
				try {
					const result = await rpc("getSceneImageSettings", { provider });
					setForm(result.settings); setKey(""); setDirty(true);
					setNotice("已读取此渠道配置；配置完成后点击保存。未保存的修改不保留。");
				} catch (e) { setNotice(String(e.message || e)); }
				finally { setBusy(false); }
			}
			const selectedChannel = form && (form.channels || []).find(function (item) { return item.id === form.provider; });
			const modelOptions = Array.from(new Set((selectedChannel && selectedChannel.models || []).concat(models)));
			function resetConnection() { setConnection(null); setModels([]); setModelNotice(""); }
			async function inspectConnection(listModels) {
				setBusy(true); setChecking(listModels ? "models" : "connection"); setNotice("");
				if (listModels) setModelNotice(""); else setConnection(null);
				try {
					const result = await rpc(listModels ? "listSceneImageModels" : "testSceneImageConnection", { provider: form.provider, baseURL: form.baseURL, authType: form.authType, username: form.username, apiKey: key });
					if (listModels) { setModels(result.models || []); setModelNotice(result.message); }
					else setConnection(result);
				} catch (e) {
					if (listModels) setModelNotice(String(e.message || e));
					else setConnection({ status: "failed", message: String(e.message || e) });
				} finally { setBusy(false); setChecking(""); }
			}
			async function importWorkflow(event) {
				const file = event.target.files && event.target.files[0];
				if (!file) return;
				setBusy(true); setNotice("");
				try {
					if (file.size > 512000) throw new Error("工作流文件不能超过 500 KB");
					let workflow; try { workflow = JSON.parse(await file.text()); } catch (e) { throw new Error("工作流不是有效 JSON 文件"); }
					setForm(function (current) { return Object.assign({}, current, { workflow: workflow }); }); setDirty(true);
					setNotice("已选择工作流，保存后将校验；不会请求生图。请只导入可信维护者提供的文件。");
				} catch (e) { setNotice(String(e.message || e)); }
				finally { setBusy(false); event.target.value = ""; }
			}
			function channelField(field) {
				if (field === "username" && form.authType !== "basic") return null;
				const labels = { baseURL: "API 根地址", model: "生图模型名称", size: "图片尺寸／分辨率", aspectRatio: "画面比例", authType: "服务鉴权", username: "鉴权用户名", negativePrompt: "负面提示词（不希望出现的内容）", steps: "生成步数", guidance: "提示词引导强度（CFG）" };
				function change(event) { const value = event.target.value; setDirty(true); if (["baseURL", "authType", "username"].includes(field)) resetConnection(); if (field === "authType") setKey(""); setForm(function (current) { return Object.assign({}, current, { [field]: value }, field === "authType" ? { hasKey: false } : {}); }); }
				const control = field === "authType" ? React.createElement("select", { value: form[field], disabled: busy, onChange: change }, [["none", "无需鉴权"], ["basic", "用户名和密码"], ["bearer", "Bearer Token（反向代理）"]].map(function (option) { return React.createElement("option", { key: option[0], value: option[0] }, option[1]); }))
					: field === "negativePrompt" ? React.createElement("textarea", { value: form[field] || "", rows: 3, maxLength: 4000, placeholder: "留空沿用默认；例如：模糊、水印、多余的手指", disabled: busy, onChange: change })
                    : React.createElement("input", { value: form[field] || "", type: ["steps", "guidance"].includes(field) ? "number" : "text", step: field === "guidance" ? "0.1" : "1", placeholder: ["steps", "guidance"].includes(field) ? "留空沿用默认" : undefined, disabled: busy, onChange: change });
				return React.createElement("label", { key: field }, labels[field] || field, control);
			}
			return React.createElement("div", { className: "dsh-tavern-settings-group" },
				React.createElement("h3", { style: { padding: "16px", margin: 0 } }, "生图 API 配置（全局共用）"),
				React.createElement("div", { className: "dsh-tavern-image-settings" },
					React.createElement("p", { className: "dsh-tavern-settings-intro" }, "保存 API 配置后，在本局设置中开启场景生图，再点输入框上方的「生图」。连接测试不生成图片；实际生图可能产生费用。"),
					form ? React.createElement("label", null, "提供商", React.createElement("select", { value: form.provider, disabled: busy, onChange: function (e) { return chooseChannel(e.target.value); } }, (form.channels || []).map(function (item) { return React.createElement("option", { key: item.id, value: item.id }, item.label); }))) : null,
					selectedChannel ? React.createElement("p", null, selectedChannel.hint) : null,
					form && form.migrationPending ? React.createElement("p", { role: "status" }, "检测到旧配置。保存后将迁入生图模块；旧密钥不会显示或发送到新地址。") : null,
					selectedChannel ? selectedChannel.fields.filter(function (field) { return ["baseURL", "authType", "username"].includes(field); }).map(channelField) : null,
					form && form.provider !== "dsh-image-gen" && !(["webui", "comfyui"].includes(form.provider) && form.authType === "none") ? React.createElement("label", null, (form.authType === "basic" ? "鉴权密码" : "API Key") + (form.hasKey ? "（已配置，留空保留；更换地址需重新填写）" : ""), React.createElement("input", { type: "password", autoComplete: "new-password", value: key, disabled: busy, onChange: function (e) { setKey(e.target.value); setDirty(true); resetConnection(); } })) : null,
					form && form.provider === "dsh-image-gen" ? React.createElement("div", null,
						React.createElement("p", { role: "status" }, form.pluginError || (form.pluginReady ? "已读取插件配置：" + form.pluginProvider + " / " + form.model + " · " + form.aspectRatio + " · " + form.size + "。未验证 Key 或执行生图。" : "请先在 dsh-image-gen 插件设置中配置云端渠道和 Key。")),
						React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy, onClick: function () { return chooseChannel("dsh-image-gen"); } }, "刷新插件配置"))
						: React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: !form || busy || !form.baseURL, onClick: function () { return inspectConnection(false); } }, checking === "connection" ? "验证中…" : "测试连接与鉴权"),
					connection ? React.createElement("span", { role: "status", "data-connection-status": connection.status }, connection.message) : null,
					connection && connection.httpStatus ? React.createElement("details", null,
						React.createElement("summary", null, "连接诊断"),
						React.createElement("p", null, "HTTP " + connection.httpStatus + " · 只读检查路径：" + (connection.probePath || "/") + "。未调用生图接口；根路径返回 404 不代表生图接口不可用。")) : null,
					selectedChannel && form.provider !== "dsh-image-gen" && selectedChannel.fields.includes("model") ? React.createElement("div", null,
						React.createElement("label", null, "生图模型", React.createElement("input", { list: "dsh-tavern-image-models", value: form.model || "", placeholder: "选择或输入模型名称", disabled: busy, onChange: function (e) { const value = e.target.value; setDirty(true); setForm(function (current) { return Object.assign({}, current, { model: value }); }); } })),
						React.createElement("datalist", { id: "dsh-tavern-image-models" }, modelOptions.map(function (model) { return React.createElement("option", { key: model, value: model }, model); })),
						selectedChannel.canListModels ? React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: busy || !form.baseURL, onClick: function () { return inspectConnection(true); } }, checking === "models" ? "获取中…" : "获取模型列表") : React.createElement("p", null, "此渠道使用预设或手动填写模型；连接测试不验证模型。"),
						modelNotice ? React.createElement("span", { role: "status" }, modelNotice) : null) : null,
					form && form.provider === "comfyui" ? React.createElement("div", null,
						React.createElement("p", null, form.workflow ? "工作流：" + (form.workflow.name || "已选择，待保存校验") : "尚未导入工作流"),
						React.createElement("label", null, "导入工作流", React.createElement("input", { type: "file", accept: ".json,application/json", disabled: busy, onChange: importWorkflow }))) : null,
					form ? React.createElement("details", null,
					React.createElement("summary", null, "绘图选项（风格、尺寸）"),
					selectedChannel && form.provider !== "dsh-image-gen" ? selectedChannel.fields.filter(function (field) { return ["size", "aspectRatio"].includes(field); }).map(channelField) : null,
                    selectedChannel && selectedChannel.fields.some(function (field) { return ["negativePrompt", "steps", "guidance"].includes(field); }) ? React.createElement("details", { open: true },
                        React.createElement("summary", null, "高级绘图设置（负面提示词、步数）"),
                        React.createElement("p", null, "选填，留空沿用默认。步数越高通常越慢，也可能增加费用；不保证画质更好。保存后用于下一次生图和重画。"),
                        form.provider === "comfyui" ? React.createElement("p", null, "显示已映射的参数；更换工作流后，未映射的旧设置需清空。没有选项时请先保存新工作流，或请维护者补充映射。") : null,
                        selectedChannel.fields.filter(function (field) { return ["negativePrompt", "steps", "guidance"].includes(field) && (form.provider !== "comfyui" || form[field] || form.workflow && form.workflow.bindings && form.workflow.bindings[field === "negativePrompt" ? "negative" : field] && form.workflow.bindings[field === "negativePrompt" ? "negative" : field].length); }).map(channelField)) : null,
					form ? React.createElement("label", null, "风格预设", React.createElement("select", { value: form.style.preset, disabled: busy, onChange: function (e) { const value = e.target.value; setDirty(true); setForm(function (current) { return Object.assign({}, current, { style: Object.assign({}, current.style, { preset: value }) }); }); } }, (form.stylePresets || []).map(function (preset) { return React.createElement("option", { key: preset.id, value: preset.id }, preset.label); }))) : null,
					form ? React.createElement("label", null, "补充描述／标签（选填）", React.createElement("textarea", { value: form.style.custom, rows: 2, maxLength: 2000, placeholder: "例如：低饱和、柔和光线、胶片质感", disabled: busy, onChange: function (e) { const value = e.target.value; setDirty(true); setForm(function (current) { return Object.assign({}, current, { style: Object.assign({}, current.style, { custom: value }) }); }); } })) : null) : null,
					React.createElement("button", { type: "button", className: "dsh-tavern-btn", disabled: !form || busy, onClick: function () { return save(); } }, busy && !checking ? "保存中…" : "保存生图 API 配置")
				),
				notice ? React.createElement("div", { role: "status", className: "dsh-tavern-settings-desc" }, notice) : null
			);
		}

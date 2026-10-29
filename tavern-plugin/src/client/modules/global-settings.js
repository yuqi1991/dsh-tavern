// Settings owns its initial snapshot; each editor saves only its own resource.
function createGlobalSettingsModule({ React, rpc, notifySettingsChanged, TavernDefaultModelSetting, TavernConversationWritingSkills, DisplayPreferencesSettings, HeaderItemsSettings, CandidatePreferencesSettings, PromptTemplateSettingsEntry, ContextCompactionSettings }) {
    function TavernSettingsSection() {
        const [state, setState] = React.useState({ loading: true, busy: false, defaultForegroundModel: null, defaultBackgroundModel: null, notice: "", modelCatalog: [], error: "" });
        React.useEffect(function () {
            let active = true;
            rpc("getTavernSettings").then(function (result) {
                if (active) setState({ loading: false, busy: false, defaultForegroundModel: result.settings?.defaultForegroundModel || null, defaultBackgroundModel: result.settings?.defaultBackgroundModel || null, notice: "", modelCatalog: Array.isArray(result.modelCatalog) ? result.modelCatalog : [], error: "" });
            }, function (error) {
                if (active) setState(function (current) { return Object.assign({}, current, { loading: false, busy: false, error: String(error && error.message || error) }); });
            });
            return function () { active = false; };
        }, []);
        async function saveDefault(name, selection) {
            if (state.loading || state.busy) return;
            setState(current => ({ ...current, busy: true, error: "", notice: "" }));
            try {
                const result = await rpc("updateTavernSettings", { patch: { [name]: selection } });
                notifySettingsChanged();
                setState(current => ({ ...current, [name]: result.settings[name], busy: false, notice: "已保存，下次新游戏生效" }));
            } catch (err) { setState(current => ({ ...current, busy: false, error: String(err.message || err) })); }
        }
        const h = React.createElement;
        function group(title, desc, ...children) {
            return h("section", { className: "dsh-tavern-gs-group", "aria-label": title },
                h("header", { className: "dsh-tavern-gs-head" }, h("h2", null, title), desc ? h("p", null, desc) : null),
                ...children);
        }
        return h("div", { className: "dsh-tavern-settings-section dsh-tavern-global-settings" },
            group("默认模型", "用于新游戏，已有对话保持当前配置，可在本局设置中单独调整。建议使用 High 推理强度；Max 容易过度思考、增加等待。",
                h("div", { className: "dsh-tavern-gs-card" },
                    React.createElement(TavernDefaultModelSetting, { label: "默认前台模型", title: "前台模型", description: "写正文、扮演角色，直接决定剧情质量", fallback: "使用 DSH 默认模型", selection: state.defaultForegroundModel, catalog: state.modelCatalog, disabled: state.loading || state.busy, onChange: selection => saveDefault("defaultForegroundModel", selection) }),
                    React.createElement(TavernDefaultModelSetting, { label: "默认后台模型", title: "后台模型", description: "变量结算、世界书筛选、候选回复等幕后任务", fallback: "跟随前台", selection: state.defaultBackgroundModel, catalog: state.modelCatalog, disabled: state.loading || state.busy, onChange: selection => saveDefault("defaultBackgroundModel", selection) })),
                state.notice ? h("p", { className: "dsh-tavern-gs-notice", role: "status" }, state.notice) : null),
            group("新游戏默认", "开局时继承，开局后可在本局设置中单独修改。",
                h(TavernConversationWritingSkills, { globalDefaults: true })),
            group("显示与交互", "",
                h(DisplayPreferencesSettings),
                h(CandidatePreferencesSettings)),
            group("高级", "",
                h(PromptTemplateSettingsEntry),
                h(ContextCompactionSettings),
                // Most players never need this; it lives at the bottom of 高级, folded.
                h(HeaderItemsSettings)),
            state.error ? React.createElement("div", { className: "dsh-tavern-settings-error", role: "alert" }, "保存失败：" + state.error) : null
        );
    }

    return { TavernSettingsSection };
}

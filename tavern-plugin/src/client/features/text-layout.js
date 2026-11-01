		// 外观 → 正文排版：字号（就是 DSH 通用设置里的「字号大小」，两边联动）、行间距、字间距。
		// 只作用于酒馆正文、玩家对话气泡与舞台文本；卡片自己的 HTML 界面保持卡的排版。
		// 行距与字距是看屏幕的偏好，存在本机。思路来自 DrifterJD/ZITI。
		const TAVERN_TEXT_LAYOUT_KEY = "dsh-tavern-text-layout";
		const TAVERN_TEXT_LAYOUT_LIMITS = Object.freeze({ lineHeight: [1, 3], letterSpacing: [-0.1, 0.3] });
		// 酒馆的默认字号。宿主默认是 14（范围 10–22，整数）；首次使用时若还在宿主默认值，就一次性改成这个。
		const TAVERN_DEFAULT_FONT_SIZE = 18;
		const TAVERN_FONT_SIZE_RANGE = Object.freeze([10, 22]);
		const TAVERN_FONT_SIZE_SEEDED_KEY = "dsh-tavern-font-size-seeded";

		// DSH 0.2.1 的快照把字号放在 fontSizes.text（旧版是 fontSize）；setFontSize 要先给角色。
		function readHostFontSize(snapshot) {
			const sizes = snapshot && snapshot.fontSizes;
			const value = sizes && Number.isFinite(sizes.text) ? sizes.text : snapshot && snapshot.fontSize;
			return Number.isFinite(value) ? value : 14;
		}

		function normalizeTavernTextLayout(value) {
			const source = value && typeof value === "object" ? value : {};
			const clamp = function (raw, range) {
				const number = Number(raw);
				if (raw === null || raw === "" || !Number.isFinite(number)) return null;
				return Math.round(Math.min(range[1], Math.max(range[0], number)) * 1000) / 1000;
			};
			return { lineHeight: clamp(source.lineHeight, TAVERN_TEXT_LAYOUT_LIMITS.lineHeight), letterSpacing: clamp(source.letterSpacing, TAVERN_TEXT_LAYOUT_LIMITS.letterSpacing) };
		}

		function readTavernTextLayout() {
			try { return normalizeTavernTextLayout(JSON.parse(window.localStorage.getItem(TAVERN_TEXT_LAYOUT_KEY) || "null")); }
			catch (_) { return normalizeTavernTextLayout(null); }
		}

		// 没调过的项不写变量：行高沿用酒馆原来的值（正文 28px、气泡 24px，各加字号增量），字距保持默认。
		function applyTavernTextLayout(layout, root) {
			const element = root || document.documentElement;
			const custom = layout.lineHeight !== null || layout.letterSpacing !== null;
			element.toggleAttribute("data-dsh-text-layout", custom);
			if (layout.lineHeight === null) element.style.removeProperty("--dsh-tavern-line-height");
			else element.style.setProperty("--dsh-tavern-line-height", String(layout.lineHeight));
			if (layout.letterSpacing === null) element.style.removeProperty("--dsh-tavern-letter-spacing");
			else element.style.setProperty("--dsh-tavern-letter-spacing", layout.letterSpacing + "em");
		}

		// 酒馆正文原来是 (16 + d)px 字号、(28 + d)px 行高，d = 通用设置字号 − 14，换算成倍数作为「默认」的显示值。
		function defaultTavernLineHeight(fontSize) {
			return Math.round((28 + fontSize - 14) / (16 + fontSize - 14) * 100) / 100;
		}

		function createTavernTextLayoutFeature() {
			let layout = readTavernTextLayout();
			const listeners = new Set();
			function update(patch) {
				layout = normalizeTavernTextLayout(Object.assign({}, layout, patch));
				try { window.localStorage.setItem(TAVERN_TEXT_LAYOUT_KEY, JSON.stringify(layout)); } catch (_) {}
				applyTavernTextLayout(layout);
				listeners.forEach(function (listener) { listener(layout); });
			}

			function TextLayoutRow(props) {
				const h = React.createElement;
				const theme = props.theme;
				const [current, setCurrent] = React.useState(layout);
				const [fontSize, setFontSize] = React.useState(function () { return readHostFontSize(theme.getTheme()); });
				const [error, setError] = React.useState("");
				React.useEffect(function () {
					listeners.add(setCurrent);
					return function () { listeners.delete(setCurrent); };
				}, []);
				React.useEffect(function () {
					// 通用设置里改了字号，这里跟着变。
					return props.onThemeChange(function (snapshot) { setFontSize(readHostFontSize(snapshot)); });
				}, []);
				function changeFontSize(px) {
					setError("");
					try { theme.setFontSize("text", px); }
					catch (err) { setError(String(err && err.message || err)); }
				}
				const lineHeight = current.lineHeight === null ? defaultTavernLineHeight(fontSize) : current.lineHeight;
				const letterSpacing = current.letterSpacing === null ? 0 : current.letterSpacing;
				function field(label, hint, value, min, max, step, unit, onChange) {
					return h("label", { className: "dsh-tavern-text-layout-field" },
						h("span", { className: "dsh-tavern-text-layout-label" }, label, h("small", null, hint)),
						h("input", { type: "range", min: min, max: max, step: step, value: value, "aria-label": label, onChange: function (event) { onChange(Number(event.target.value)); } }),
						h("span", { className: "dsh-tavern-text-layout-value" }, value + unit));
				}
				return h("section", { className: "dsh-tavern-text-layout" },
					h("div", { className: "dsh-tavern-text-layout-head" },
						h("strong", null, "正文排版"),
						h("button", { type: "button", className: "dsh-tavern-btn", disabled: current.lineHeight === null && current.letterSpacing === null && fontSize === TAVERN_DEFAULT_FONT_SIZE,
							onClick: function () { update({ lineHeight: null, letterSpacing: null }); if (fontSize !== TAVERN_DEFAULT_FONT_SIZE) changeFontSize(TAVERN_DEFAULT_FONT_SIZE); } }, "恢复默认")),
					h("p", { className: "dsh-tavern-settings-desc" }, "作用于酒馆正文、你的对话气泡和舞台文本，卡片自带的界面不受影响。字号与「通用设置」里的字号大小是同一个设置。"),
					field("字号", "px", fontSize, TAVERN_FONT_SIZE_RANGE[0], TAVERN_FONT_SIZE_RANGE[1], 1, "px", changeFontSize),
					field("行间距", "倍", lineHeight, 1, 3, 0.05, "×", function (value) { update({ lineHeight: value }); }),
					field("字间距", "em", letterSpacing, -0.1, 0.3, 0.01, "em", function (value) { update({ letterSpacing: value }); }),
					h("p", { className: "dsh-tavern-text-layout-preview", style: { fontSize: (fontSize + 2) + "px", lineHeight: lineHeight, letterSpacing: letterSpacing + "em" } },
						"夜色从窗棂上滑下来，落在她的发梢。她抬起头，轻声说：「雨停了，我们走吧。」"),
					error ? h("p", { className: "dsh-tavern-settings-error", role: "alert" }, error) : null);
			}

			// 首次使用：宿主字号还是出厂的 14 就改成酒馆默认；改过的值不动，之后也不再覆盖。
			function seedDefaultFontSize(theme) {
				try {
					if (window.localStorage.getItem(TAVERN_FONT_SIZE_SEEDED_KEY)) return;
					window.localStorage.setItem(TAVERN_FONT_SIZE_SEEDED_KEY, "1");
					if (readHostFontSize(theme.getTheme()) === 14) theme.setFontSize("text", TAVERN_DEFAULT_FONT_SIZE);
				} catch (_) {}
			}

			function register(ctx) {
				applyTavernTextLayout(layout);
				seedDefaultFontSize(ctx.theme);
				// 外观页由内置的 dsh-dream-skin 提供；没有它时这一行不出现，已保存的排版照样生效。
				return ctx.slots.inject("settings.dreamSkin.item", function () {
					return ctx.slots.register({
						name: "settings.dreamSkin.item",
						id: "dsh-tavern-text-layout",
						order: 15,
						inject: function () {
							return { theme: ctx.theme, onThemeChange: function (listener) { return ctx.on("theme/change", listener); } };
						}
					}, TextLayoutRow);
				});
			}

			return Object.freeze({ register: register, update: update, normalize: normalizeTavernTextLayout, defaultLineHeight: defaultTavernLineHeight, apply: applyTavernTextLayout });
		}

		const tavernTextLayoutFeature = createTavernTextLayoutFeature();

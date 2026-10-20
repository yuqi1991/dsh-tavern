		function ensureTavernHostJQuery(host) {
			if (host.jQuery && host.jQuery.fn && host.jQuery.fn.jquery) return Promise.resolve();
			const doc = host.document;
			const existing = doc.querySelector('script[data-dsh-tavern-host-jquery]');
			if (existing && existing.tavernReady) return existing.tavernReady;
			const script = doc.createElement('script');
			script.setAttribute('data-dsh-tavern-host-jquery', '');
			script.src = '/api/dsh-tavern/vendor/runtime-assets/jquery/jquery.min.js';
			const previousDollar = host.$;
			script.tavernReady = new Promise(function (resolve, reject) {
				const timer = host.setTimeout(function () { finish(new Error('宿主 jQuery 加载超时')); }, 15000);
				function finish(error) {
					host.clearTimeout(timer);
					script.onload = script.onerror = null;
					script.remove();
					if (error) reject(error); else resolve();
				}
				script.onload = function () {
					if (!host.jQuery || !host.jQuery.fn || !host.jQuery.fn.jquery) return finish(new Error('宿主 jQuery 未初始化'));
					if (previousDollar !== undefined && host.$ === host.jQuery) host.jQuery.noConflict();
					finish();
				};
				script.onerror = function () { finish(new Error('宿主 jQuery 加载失败')); };
			});
			doc.head.appendChild(script);
			return script.tavernReady;
		}

		function ensureTavernHostJQueryUi(host) {
			if (host.jQuery && typeof host.jQuery.fn.draggable === "function") return Promise.resolve();
			const doc = host.document;
			const existing = doc.querySelector('script[data-dsh-tavern-host-jquery-ui]');
			if (existing && existing.tavernReady) return existing.tavernReady;
			const script = doc.createElement('script');
			script.setAttribute('data-dsh-tavern-host-jquery-ui', '');
			script.src = '/api/dsh-tavern/vendor/runtime-assets/jquery-ui/jquery-ui.min.js';
			script.tavernReady = new Promise(function (resolve, reject) {
				const timer = host.setTimeout(function () { finish(new Error('宿主 jQuery UI 加载超时')); }, 15000);
				function finish(error) {
					host.clearTimeout(timer);
					script.onload = script.onerror = null;
					script.remove();
					if (error) reject(error); else resolve();
				}
				script.onload = function () { finish(typeof host.jQuery.fn.draggable === 'function' ? null : new Error('宿主 jQuery UI 未初始化')); };
				script.onerror = function () { finish(new Error('宿主 jQuery UI 加载失败')); };
			});
			doc.head.appendChild(script);
			return script.tavernReady;
		}

		function installTavernTrustedHostFacade(host, frameWindow, priority, names) {
			// A visible mount root supports legacy host detection and panel mounting.
			// Never fake send_textarea: scripts must reach the real composer.
			let chatRoot = host.document && host.document.getElementById('chat');
			if (!chatRoot && host.document && host.document.createElement) {
				chatRoot = host.document.createElement('div');
				chatRoot.id = 'chat';
				chatRoot.tavernCompatibilityOwners = 0;
				host.document.body.appendChild(chatRoot);
			}
			const ownsChatRoot = chatRoot && typeof chatRoot.tavernCompatibilityOwners === 'number';
			if (ownsChatRoot) chatRoot.tavernCompatibilityOwners++;
			// Legacy sorting scripts address the parent document in trusted mode.
			// This hidden select accepts their UI events only; it has no host listeners.
			let sortControl = host.document && host.document.getElementById('world_info_sort_order');
			if (!sortControl && host.document && host.document.createElement) {
				sortControl = host.document.createElement('select');
				sortControl.id = 'world_info_sort_order';
				sortControl.hidden = true;
				const option = host.document.createElement('option');
				option.value = '13';
				option.textContent = '自定义排序';
				sortControl.appendChild(option);
				sortControl.tavernCompatibilityOwners = 0;
				host.document.body.appendChild(sortControl);
			}
			const ownsSortControl = sortControl && typeof sortControl.tavernCompatibilityOwners === 'number';
			if (ownsSortControl) sortControl.tavernCompatibilityOwners++;
			const frameElement = frameWindow.frameElement, frameDocument = frameWindow.document;
			const bindings = (names || ["SillyTavern", "TavernHelper", "Mvu", "_", "toastr"]).map(function (name) {
				const previous = Object.getOwnPropertyDescriptor(host, name);
				if (previous && !previous.configurable) throw new Error("宿主接口不可替换：" + name);
				const binding = {
					name: name, previous: previous, active: true, priority: Number(priority) || 0, frameWindow: frameWindow, frameElement: frameElement, frameDocument: frameDocument, toastr: name === "toastr" ? frameWindow.toastr : undefined, get: function () {
						function rank(owner) {
							const sessionId = owner.frameWindow.frameElement && owner.frameWindow.frameElement.__dshTavernSessionId;
							return owner.priority + (host.__dshTavernSelectedSessionId && sessionId ? (sessionId === host.__dshTavernSelectedSessionId ? 1 : -1) : 0);
						}
						// document.open() removes the frame's unload listeners. Do
						// not rely on those listeners to retire its host APIs.
						let selected = null, newer = null, descriptor = { get: binding.get };
						while (descriptor && descriptor.get && descriptor.get.tavernHostBinding) {
							const owner = descriptor.get.tavernHostBinding;
							let live = owner.active;
							try {
								if (owner.frameElement && owner.frameElement.isConnected === false) live = false;
								if (owner.frameDocument && owner.frameWindow.document !== owner.frameDocument) live = false;
							} catch (_) { live = false; }
							if (live) {
								if (!selected || rank(owner) > rank(selected)) selected = owner;
								newer = owner;
							} else {
								if (owner.release) owner.release();
								if (newer) newer.previous = owner.previous;
							}
							descriptor = owner.previous;
						}
						if (!selected) return descriptor && (descriptor.get ? descriptor.get.call(host) : descriptor.value);
						return name === "toastr" ? selected.toastr : selected.frameWindow[name];
					}
				};
				binding.get.tavernHostBinding = binding;
				return binding;
			});
			for (const binding of bindings) Object.defineProperty(host, binding.name, { configurable: true, get: binding.get });
			let released = false;
			function release() {
				if (released) return;
				released = true;
				if (ownsSortControl && --sortControl.tavernCompatibilityOwners === 0) sortControl.remove();
				if (ownsChatRoot && --chatRoot.tavernCompatibilityOwners === 0) chatRoot.remove();
				for (const binding of bindings) {
					binding.active = false;
					if (Object.getOwnPropertyDescriptor(host, binding.name)?.get !== binding.get) continue;
					let previous = binding.previous;
					while (previous?.get?.tavernHostBinding && !previous.get.tavernHostBinding.active) previous = previous.get.tavernHostBinding.previous;
					if (previous) Object.defineProperty(host, binding.name, previous);
					else delete host[binding.name];
				}
			}
			for (const binding of bindings) binding.release = release;
			return release;
		}

		function releaseTavernHostJQueryHandlers(host, frameWindow) {
			const jq = host.jQuery;
			if (!jq || !jq._data || !jq.event || !frameWindow || !frameWindow.Function) return;
			// Callback realm identifies the retiring script even on shared document
			// targets. Never remove a whole namespace owned by another component.
			const targets = [host, host.document].concat(Array.from(host.document.querySelectorAll('*')));
			for (const target of targets) {
				if (!jq.hasData(target)) continue;
				const events = jq._data(target, 'events') || {};
				for (const handlers of Object.values(events)) {
					for (const entry of Array.from(handlers)) {
						if (entry.handler instanceof frameWindow.Function) {
							jq.event.remove(target, entry.origType + (entry.namespace ? '.' + entry.namespace : ''), entry.handler, entry.selector);
						}
					}
				}
			}
		}

		function buildTavernHelperScriptParts(input) {
			const scripts = Array.isArray(input && input.scripts)
				? input.scripts
				: (input && input.script ? [input.script] : []);
			const metadata = {
				token: String(input && input.token || ""),
				officialMvu: scripts.some(function (script) { return script && script.system === "official-mvu"; }),
				scripts: scripts.map(function (script) {
					return {
						id: String(script && script.id || ""),
						name: String(script && script.name || ""),
						info: String(script && script.info || ""),
						buttons: Array.isArray(script && script.buttons) ? script.buttons : [],
						system: String(script && script.system || "")
					};
				})
			};
			const context = input && input.context && typeof input.context === "object" ? input.context : {};
			const safeMetadata = JSON.stringify(metadata).replace(/</g, "\\u003c");
			const safeContext = JSON.stringify(context).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
			const bootstrap = '(' + tavernHelperScriptBootstrap.toString() + ')(' + safeMetadata + ',' + safeContext + ',{'
				+ 'createInitializationTiming:' + createTavernInitializationTiming.toString() + ','
				+ 'createTransport:' + createTavernHelperTransport.toString() + ','
				+ 'applyVariableReceipt:' + applyTavernVariableReceipt.toString() + ','
				+ 'createEvents:' + createTavernHelperEventBus.toString() + ','
				+ 'createPopup:' + createTavernHelperPopup.toString() + ','
				+ 'installCompatibility:' + installTavernCompatibilityDiagnostics.toString() + ','
				+ 'createChatData:' + createTavernChatDataFacade.toString() + ','
				+ 'createLocalVariables:' + createTavernLocalVariables.toString() + ','
				+ 'installFacade:' + installTavernHelperFacade.toString() + '});';
			const modules = scripts.map(function (script) {
				return { id: String(script && script.id || ""), system: String(script && script.system || ""), assetUrl: String(script && script.assetUrl || ""), content: String(script && script.content || "") };
			});
			const loaderSource = 'await window.__dshTavernHelperReady;\n'
				+ 'const createTavernPreviewWindow=' + createTavernPreviewWindow.toString() + ';\n'
				+ 'const loadModule=' + loadTavernHelperModule.toString() + ';\n'
				+ 'const createMvuLoader=' + createMvuBundleLoader.toString() + ';\n'
				+ 'const scripts=' + JSON.stringify(modules).replace(/</g, "\\u003c") + ';\n'
				+ 'const token=' + JSON.stringify(metadata.token) + ';\n'
				+ 'try{'
				+ (input && input.trustedCardMode ? 'const ensureHostJQuery=' + ensureTavernHostJQuery.toString() + ';await ensureHostJQuery(window.parent);const ensureHostJQueryUi=' + ensureTavernHostJQueryUi.toString() + ';await ensureHostJQueryUi(window.parent);const artifacts=window.frameElement&&window.frameElement.__dshTavernHostArtifacts;window.$=window.jQuery=artifacts?artifacts.bindJQuery(window.parent.jQuery):window.parent.jQuery;const installHostFacade=' + installTavernTrustedHostFacade.toString() + ';const releaseHostFacade=installHostFacade(window.parent,window);window.addEventListener("pagehide",releaseHostFacade,{once:true});window.addEventListener("unload",releaseHostFacade,{once:true});\n' : '')
				+ 'for(const script of scripts){window.__dshTavernHelperSetCurrentScript(script.id);try{'
				+ 'if(script.system==="official-mvu"&&script.assetUrl){const loader=createMvuLoader({fetch:window.fetch.bind(window),evaluate:source=>loadModule(source,script.id),onDiagnostic(diagnostic){parent.postMessage({type:"dsh-tavern-mvu-load-diagnostic",token,diagnostic},"*");},onState(state){parent.postMessage({type:"dsh-tavern-mvu-load-state",token,state},"*");}});'
				+ 'const retry=event=>{if(event.source===parent&&event.data?.token===token&&event.data.type==="dsh-tavern-mvu-reload")loader.retry();};'
				+ 'window.addEventListener("message",retry);window.addEventListener("pagehide",()=>loader.dispose(),{once:true});'
				+ 'try{await loader.load(new URL(script.assetUrl,document.baseURI).href);}finally{window.removeEventListener("message",retry);}}else await window.__dshTavernInitializationTiming.wait("companion-module",loadModule(script.content,script.id,' + (input && input.previewScope === true ? 'true' : 'false') + '),script.id);'
				+ 'if(script.system==="official-mvu")await window.waitGlobalInitialized("Mvu");window.__dshTavernHelperSubscriptionsReady(script.id);'
				+ '}catch(error){window.__dshTavernHelperSubscriptionsFailed(script.id,error);if(script.system==="official-mvu")break;}}}catch(error){for(const script of scripts)window.__dshTavernHelperSubscriptionsFailed(script.id,error);}finally{window.__dshTavernResolveCompanionScriptsReady();}';
			// Start now: document.open() can remove deferred module tags before they run.
			const moduleUrl = "data:text/javascript;base64," + encodeTavernScriptSource(loaderSource);
			return {
				head: tavernIconDependencies()
					+ tavernStaticAssetShim()
					+ tavernHelperScriptDependencies()
					+ '<script data-dsh-tavern-helper-script>' + bootstrap + '<\/script>',
				body: '<div id="extensions_settings2" hidden><select id="world_info_sort_order"><option value="13">自定义排序</option></select></div><div id="tavern_helper" hidden></div><script>void import(' + JSON.stringify(moduleUrl) + ');<\/script>'
			};
		}

		function buildTavernHelperScriptDocument(input) {
			const parts = buildTavernHelperScriptParts(input);
			return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
				+ '<meta http-equiv="Content-Security-Policy" content="default-src https: http: data: blob:; script-src \'unsafe-inline\' \'unsafe-eval\' https: http: data: blob:; connect-src https: http: wss: data: blob:; img-src https: http: data: blob:; style-src \'unsafe-inline\' https: http:; object-src \'none\'; base-uri \'none\'; form-action \'none\'">'
				+ parts.head + '</head><body>' + parts.body + '</body></html>';
		}

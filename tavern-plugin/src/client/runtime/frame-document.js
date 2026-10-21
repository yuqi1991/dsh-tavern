		function tavernHelperMessageDependencies() {
			return tavernIconDependencies()
				+ '<script data-dsh-tavern-helper-dependency="tailwind" src="/api/dsh-tavern/vendor/runtime-assets/tailwind/index.global.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="jquery" src="/api/dsh-tavern/vendor/runtime-assets/jquery/jquery.min.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="jquery-ui" src="/api/dsh-tavern/vendor/runtime-assets/jquery-ui/jquery-ui.min.js"><\/script>'
				+ '<link rel="stylesheet" data-dsh-tavern-helper-dependency="jquery-ui-theme" href="/api/dsh-tavern/vendor/runtime-assets/jquery-ui/themes/base/theme.min.css">'
				+ '<script data-dsh-tavern-helper-dependency="jquery-ui-touch-punch" src="/api/dsh-tavern/vendor/runtime-assets/jquery-ui-touch-punch/jquery.ui.touch-punch.min.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="vue" src="/api/dsh-tavern/vendor/runtime-assets/vue/vue.runtime.global.prod.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="vue-router" src="/api/dsh-tavern/vendor/runtime-assets/vue-router/vue-router.global.prod.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="lodash" src="/api/dsh-tavern/vendor/runtime-assets/lodash/lodash.min.js"><\/script>';
		}

		function tavernHelperScriptDependencies() {
			return '<script data-dsh-tavern-helper-dependency="vue" src="/api/dsh-tavern/vendor/runtime-assets/vue/vue.runtime.global.prod.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="vue-router" src="/api/dsh-tavern/vendor/runtime-assets/vue-router/vue-router.global.prod.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="jquery" src="/api/dsh-tavern/vendor/runtime-assets/jquery/jquery.min.js"><\/script>'
				+ '<script data-dsh-tavern-helper-dependency="lodash" src="/api/dsh-tavern/vendor/runtime-assets/lodash/lodash.min.js"><\/script>';
		}

		const SILLYTAVERN_CSS_COMPAT = Object.freeze({
			version: "1.18.0",
			revision: "8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8",
			styles: Object.freeze([
				"webfonts/NotoSans/stylesheet.css",
				"webfonts/NotoSansMono/stylesheet.css",
				"css/fontawesome.min.css",
				"css/solid.min.css",
				"css/brands.min.css",
				"css/jquery-ui.min.css",
				"css/bright.min.css",
				"css/cropper.min.css",
				"css/toastr.min.css",
				"css/select2.min.css",
				"style.css",
				"css/st-tailwind.css",
				"css/rm-groups.css",
				"css/group-avatars.css",
				"css/toggle-dependent.css",
				"css/world-info.css",
				"css/extensions-panel.css",
				"css/select2-overrides.css",
				"css/mobile-styles.css",
				"css/macros.css"
			])
		});

		function sillyTavernCssCompatibilityDependencies() {
			const base = "https://cdn.jsdelivr.net/gh/SillyTavern/SillyTavern@" + SILLYTAVERN_CSS_COMPAT.revision + "/public/";
			const links = SILLYTAVERN_CSS_COMPAT.styles.map(function (path, index) {
				return '<link rel="stylesheet" data-dsh-sillytavern-css-compat="' + SILLYTAVERN_CSS_COMPAT.version + '" data-dsh-sillytavern-css-index="' + index + '" href="' + tavernStaticAssetUrl(base + path) + '">';
			}).join("");
			// Transparent frames use the embedder's color scheme, not ST's pale text/shadow defaults.
			// Keep these as overridable variables so explicit card and user themes still win.
			return links + '<style data-dsh-sillytavern-iframe-adapter>:root{--SmartThemeBodyColor:CanvasText;--shadowWidth:0}html,body{box-sizing:border-box!important;margin:0!important;padding:0!important;width:100%!important;min-width:0!important;max-width:none!important;height:auto!important;min-height:0!important;overflow:visible!important;background:transparent!important}body{position:static!important;display:block!important;color-scheme:inherit}body:before,body:after{pointer-events:none}img,video,svg,canvas{max-width:100%;height:auto}</style>';
		}


		function buildOpeningPreviewDocument(value) {
			const source = String(value || "");
			const content = rewriteTavernStaticMarkup(isHtmlOpening(source)
				? source
				: '<div class="dsh-tavern-greeting-text">' + escapeOpeningPreviewText(source) + '</div>');
			const preserveMixedTextLines = isHtmlOpening(source)
				? '<script data-dsh-preserve-lines>(function(){var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);var nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);nodes.forEach(function(node){if(node.nodeValue.indexOf("\\n")<0||!node.nodeValue.trim())return;var parent=node.parentElement;if(!parent||parent.closest("script,style,pre,textarea,code"))return;var span=document.createElement("span");span.className="dsh-tavern-preserve-lines";node.replaceWith(span);span.appendChild(node);});})();</script>'
				: '';
			return '<!doctype html><html><head><meta charset="utf-8">'
				+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
				+ '<meta name="referrer" content="no-referrer">'
				+ '<meta http-equiv="Content-Security-Policy" content="default-src https: http: data: blob:; img-src https: http: data: blob:; media-src https: http: data: blob:; style-src \'unsafe-inline\' https: http:; font-src https: http: data:; script-src \'unsafe-inline\' \'unsafe-eval\' https: http: data: blob:; connect-src https: http: ws: wss: data: blob:; frame-src https: http: data: blob:; form-action https: http:">'
				+ '<base target="_blank">'
				+ '<style>html,body{margin:0;min-height:100%;background:#fff;color:#1f2328;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{box-sizing:border-box;padding:16px}.dsh-tavern-greeting-text,.dsh-tavern-preserve-lines{white-space:pre-wrap;overflow-wrap:anywhere}.dsh-tavern-greeting-text{font-size:14px;line-height:1.7}img,video{max-width:100%;height:auto}</style>'
				+ tavernIconDependencies() + tavernStaticAssetShim() + '</head><body>' + content + preserveMixedTextLines + '</body></html>';
		}

		function installTavernFrameVariableAliases() {
			window.getAllVariables = function () {
				// Read through the live Helper API so context updates and MVU view
				// observation use the same path. Each read already returns a copy.
				// Historical frames must not merge variables from later messages.
				return Object.assign({}, window.getVariables({ type: "chat" }), window.getVariables({ type: "message", message_id: window.getCurrentMessageId() }));
			};
		}

		function installTavernStatusRefresh(token) {
			// A legacy status may render only once. Observe reads, not card names or
			// source patterns; give event handlers and existing 4s polls time to catch up.
			const read = window.getVariables;
			const reads = new Map();
			const subscriptions = new Map();
			let timer = 0, requested = false, writes = false;
			document.addEventListener("input", function () { writes = true; }, true);
			document.addEventListener("change", function () { writes = true; }, true);
			["eventOn", "eventOff"].forEach(function (name) {
				const original = window[name];
				window[name] = function (event, handler) {
					if (event === "mag_variable_update_ended" || event === "MESSAGE_UPDATED") {
						if (!subscriptions.has(event)) subscriptions.set(event, new Set());
						if (name === "eventOn") subscriptions.get(event).add(handler);
						else subscriptions.get(event).delete(handler);
					}
					return original.apply(this, arguments);
				};
			});
			function optionFor(entry) {
				return entry.current ? Object.assign({}, entry.option, { message_id: window.getCurrentMessageId() }) : entry.option;
			}
			window.getVariables = function (option) {
				const normalized = Object.assign({ type: "message" }, option || {});
				const current = normalized.type === "message" && (normalized.message_id == null || normalized.message_id === window.getCurrentMessageId());
				if (current) delete normalized.message_id;
				const result = read.apply(this, arguments);
				reads.set(JSON.stringify([normalized, current]), { option: normalized, current: current, value: JSON.stringify(result) });
				return result;
			};
			// Reloading a read-only view is safe; never automatically replay Helper
			// mutations from a card that uses its UI as an execution surface.
			["replaceVariables", "updateVariablesWith", "setChatMessages"].forEach(function (name) {
				const original = window[name];
				if (typeof original !== "function") return;
				window[name] = function () { writes = true; return original.apply(this, arguments); };
			});
			addEventListener("message", function (event) {
				const data = event && event.data;
				if (event.source !== parent || !data || data.token !== token || data.type !== "dsh-tavern-helper-context-update" || timer || requested || writes) return;
				timer = setTimeout(function () {
					timer = 0;
					if (writes || requested || Array.from(subscriptions.values()).some(function (handlers) { return handlers.size > 0; })) return;
					const stale = Array.from(reads.values()).some(function (entry) { return JSON.stringify(read(optionFor(entry))) !== entry.value; });
					if (!stale) return;
					requested = true;
					parent.postMessage({ type: "dsh-tavern-status-stale", token: token }, "*");
				}, 5000);
			});
		}

		// Also used on runtime-report clones: presentation preferences must never become saved card styles.
		function restoreTavernFrameFontStyles(root) {
			const attribute = "data-dsh-tavern-font-original";
			const nodes = Array.from(root.querySelectorAll("[" + attribute + "]"));
			if (root.hasAttribute && root.hasAttribute(attribute)) nodes.unshift(root);
			nodes.forEach(function (node) {
				try {
					const saved = JSON.parse(node.getAttribute(attribute));
					["font-size", "line-height"].forEach(function (name, index) {
						if (node.style.getPropertyValue(name) !== saved.applied[index]) return;
						const original = saved.original[index];
						if (original[0]) node.style.setProperty(name, original[0], original[1]);
						else node.style.removeProperty(name);
					});
					if (!saved.hadStyle && !node.getAttribute("style")) node.removeAttribute("style");
				} catch (_) { }
				node.removeAttribute(attribute);
			});
		}

		function installTavernFrameFonts(token, restore) {
			let fontSize = 14, scheduled = false, disposed = false;
			const observer = new MutationObserver(schedule);
			function observe() { observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden"] }); }
			function schedule() {
				if (scheduled || disposed) return;
				scheduled = true;
				requestAnimationFrame(apply);
			}
			function apply() {
				scheduled = false;
				if (disposed || !document.body) return;
				observer.disconnect();
				// Cancel author transitions while restoring/measuring; otherwise computed font
				// sizes can still be the previous scaled frame, which compounds on each update.
				const measurementStyle = document.createElement("style");
				measurementStyle.setAttribute("data-dsh-tavern-font-measure", "");
				measurementStyle.textContent = "*,*::before,*::after{transition:none!important}";
				document.head.appendChild(measurementStyle);
				try {
					restore(document.body);
					const ratio = fontSize / 14;
					if (ratio === 1) return;
					// Measure everything before writing, with our old overrides removed. This prevents
					// inherited em/rem sizes and repeated preference changes from compounding.
					const measured = [document.body].concat(Array.from(document.body.querySelectorAll("*"))).filter(function (node) {
						return node.style && !/^(SCRIPT|STYLE|LINK|META|NOSCRIPT)$/.test(node.tagName) && (!node.closest("svg") || node.tagName.toLowerCase() === "svg");
					}).map(function (node) {
						const text = /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName) || Array.from(node.childNodes).some(function (child) { return child.nodeType === 3 && /\S/.test(child.nodeValue || ""); });
						const style = getComputedStyle(node), factor = text ? ratio : 1;
						return { node: node, size: parseFloat(style.fontSize) * factor, line: parseFloat(style.lineHeight) * factor };
					});
					measured.forEach(function (item) {
						if (!Number.isFinite(item.size) || item.size <= 0) return;
						const node = item.node, names = ["font-size", "line-height"];
						const saved = { hadStyle: node.hasAttribute("style"), original: names.map(function (name) { return [node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]; }), applied: [] };
						node.style.setProperty("font-size", item.size.toFixed(4) + "px", "important");
						if (Number.isFinite(item.line)) node.style.setProperty("line-height", item.line.toFixed(4) + "px", "important");
						saved.applied = names.map(function (name) { return node.style.getPropertyValue(name); });
						node.setAttribute("data-dsh-tavern-font-original", JSON.stringify(saved));
					});
				} finally {
					// Flush the final values before restoring transitions, so the adapter itself
					// does not start another interpolation from the temporary unscaled state.
					void getComputedStyle(document.body).fontSize;
					measurementStyle.remove();
					observe();
				}
			}
			function receive(event) {
				const data = event.data;
				if (event.source !== parent || !data || data.token !== token || data.type !== "dsh-tavern-font-size") return;
				const next = Number(data.fontSize);
				if (!Number.isFinite(next) || next < 8 || next > 48 || next === fontSize) return;
				fontSize = next;
				schedule();
			}
			observe();
			addEventListener("message", receive);
			addEventListener("resize", schedule);
			document.addEventListener("load", schedule, true);
			addEventListener("pagehide", function () { disposed = true; observer.disconnect(); removeEventListener("message", receive); removeEventListener("resize", schedule); document.removeEventListener("load", schedule, true); }, { once: true });
		}

		// @include opening-preview.js
		// @include legacy-composer.js
		// @include landing-styles.js
		// @include subagent-catalog-sync.js

		// @include text-colors.js

		function substituteTavernIdentityMacros(value, context) {
			return String(value || "")
				.replace(/{{\s*user\s*}}/gi, String(context.playerName || "你"))
				.replace(/{{\s*char\s*}}/gi, String(context.characterName || context.character?.name || "角色"));
		}

		// @include modules/frame-touch-scroll.js

		// @include modules/frame-viewport-height.js
        // @include-domain frame-sizing.js
        // @include modules/frame-sizing.js

		// @include modules/sidebar-start.js

		function buildTavernFrameDocument(input) {
			const html = rewriteTavernStaticMarkup(String(input && (input.content !== undefined ? input.content : input.html) || ""));
            const token = JSON.stringify(String(input && input.token || "")).replace(/</g, "\\u003c");
			const helperContext = JSON.stringify(input && input.helperContext || null).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
			const helperTurn = Math.max(0, Number(input && input.turn) || 0);
			const preparationRuntime = input && input.openingPreview && input.openingPreview.runtime
				? buildTavernHelperScriptParts({ token: input.token, context: input.openingPreview.runtime.context, scripts: input.openingPreview.runtime.scripts, previewScope: true }) : null;
			const helperDependencies = input && (input.helperContext || input.openingPreview) ? tavernHelperMessageDependencies() : sillyTavernCssCompatibilityDependencies() + (/<script\b/i.test(html) ? tavernHelperMessageDependencies() : "");
			const storageShim = '<script data-dsh-tavern-storage>(function(){try{void window.localStorage;return;}catch(e){}var values=Object.create(null),keys=[];var storage={getItem:function(key){key=String(key);return Object.prototype.hasOwnProperty.call(values,key)?values[key]:null;},setItem:function(key,value){key=String(key);if(!Object.prototype.hasOwnProperty.call(values,key))keys.push(key);values[key]=String(value);},removeItem:function(key){key=String(key);if(!Object.prototype.hasOwnProperty.call(values,key))return;delete values[key];keys.splice(keys.indexOf(key),1);},clear:function(){values=Object.create(null);keys=[];},key:function(index){index=Number(index);return index>=0&&index<keys.length?keys[index]:null;}};Object.defineProperty(storage,"length",{enumerable:true,get:function(){return keys.length;}});try{Object.defineProperty(window,"localStorage",{configurable:true,enumerable:true,value:storage});}catch(e){}})();<\/script>';
			const helperShim = input && input.helperContext ? '<script data-dsh-tavern-helper>(function(){var token=' + token + ',state=' + helperContext + ',turn=' + helperTurn + ',nextId=1,pending=Object.create(null),listeners=Object.create(null);var applyContextUpdate=' + applyTavernHelperContextUpdate.toString() + ';if(window.Vue)Object.assign(window,window.Vue);window.errorCatched=function(factory){return function(){try{return factory.apply(this,arguments);}catch(error){console.error(error);return {};}};};function copy(value){try{return structuredClone(value);}catch(e){return JSON.parse(JSON.stringify(value));}}function lastId(){return Math.max(-1,(state.messages||[]).length-1);}function normalizeId(value){var id=Number(value);if(!Number.isFinite(id))id=lastId();if(id<0)id=(state.messages||[]).length+id;return Math.max(0,Math.min(lastId(),id));}function currentId(){var mapped=state.turnMessageIds&&state.turnMessageIds[String(turn)];return mapped===undefined?lastId():normalizeId(mapped);}function syncFrameName(){var id=currentId();window.name=id>=0?"TH-message--"+id+"--"+token:"";}function selectedVariables(message){return copy(message&&message.variables&&typeof message.variables==="object"?message.variables:{});}function messagesFor(target,options){var all=state.messages||[],items=[];if(target===undefined||target===null)items=[all[currentId()]];else if(typeof target==="string"&&target.indexOf("-")>=0){var value=target.replace(/{{\\s*lastMessageId\\s*}}/gi,String(lastId())),parts=value.split("-"),from=normalizeId(parts[0]),to=normalizeId(parts[1]);for(var i=Math.min(from,to);i<=Math.max(from,to);i+=1)items.push(all[i]);}else items=[all[normalizeId(target)]];items=items.filter(Boolean);if(options&&options.role&&options.role!=="all")items=items.filter(function(item){return item.role===options.role;});return copy(items);}function call(method,args){return new Promise(function(resolve,reject){var requestId=String(nextId++);pending[requestId]={resolve:resolve,reject:reject};parent.postMessage({type:"dsh-tavern-helper-call",token:token,requestId:requestId,method:method,args:copy(args||{})},"*");});}function optionOf(option){var value=option&&typeof option==="object"?copy(option):{type:"message"};if(!value.type)value.type="message";if(value.type==="message"){if(value.message_id===undefined||value.message_id===null)value.message_id=currentId();else if(value.message_id==="latest")value.message_id=lastId();}return value;}function localReplace(variables,option){option=optionOf(option);if(option.type==="chat")state.chatVariables=copy(variables);else if(option.type==="character")state.characterVariables=copy(variables);else if(option.type==="global")state.globalVariables=copy(variables);else{var message=state.messages[normalizeId(option.message_id)];if(message){message.variables=copy(variables);if(Array.isArray(message.swipes_data))message.swipes_data[message.swipe_id||0]=copy(variables);}}}function localSetMessages(patches){(patches||[]).forEach(function(patch){var message=state.messages[normalizeId(patch.message_id)];if(!message)return;if(patch.swipe_id!==undefined){message.swipe_id=Math.max(0,Math.min((message.swipes||[]).length-1,Number(patch.swipe_id)||0));message.message=(message.swipes||[])[message.swipe_id]||message.message;}if(patch.message!==undefined){message.message=String(patch.message);if(Array.isArray(message.swipes))message.swipes[message.swipe_id||0]=message.message;}if(patch.data!==undefined){message.variables=copy(patch.data||{});if(Array.isArray(message.swipes_data))message.swipes_data[message.swipe_id||0]=copy(patch.data||{});}});}addEventListener("message",function(event){var data=event&&event.data;if(event.source!==parent||!data||data.token!==token)return;if(data.type==="dsh-tavern-helper-context-update"){var previous=copy(state),applied;try{applied=applyContextUpdate(state,data.update);}catch(error){parent.postMessage({type:"dsh-tavern-helper-context-request",token:token},"*");return;}state=applied.context;if(Number.isFinite(Number(applied.turn)))turn=Math.max(0,Number(applied.turn));syncFrameName();Promise.resolve().then(async function(){var names=Array.isArray(applied.events)?applied.events:[];for(var index=0;index<names.length;index+=1){var name=names[index];if(window.Mvu&&name===window.Mvu.events.VARIABLE_UPDATE_ENDED)await window.eventEmit(name,selectedVariables((state.messages||[])[currentId()]),previous);else await window.eventEmit(name,currentId());}}).catch(function(error){console.error(error);});return;}if(data.type!=="dsh-tavern-helper-response")return;var task=pending[data.requestId];if(!task)return;delete pending[data.requestId];if(data.ok){if(data.result&&data.result.context)state=data.result.context;syncFrameName();task.resolve(data.result);}else task.reject(new Error(String(data.error||"Helper 调用失败")));});syncFrameName();window.getCurrentMessageId=currentId;window.getLastMessageId=lastId;window.getChatMessages=messagesFor;window.getCurrentCharacterName=function(){return String(state.characterName||state.character&&state.character.name||"");};window.SillyTavern=Object.assign(window.SillyTavern||{},{substituteParams:function(value){return (' + substituteTavernIdentityMacros.toString() + ')(value,state);}});window.getVariables=function(option){option=optionOf(option);if(option.type==="chat")return copy(state.chatVariables||{});if(option.type==="character")return copy(state.characterVariables||{});if(option.type==="global")return copy(state.globalVariables||{});return selectedVariables((state.messages||[])[normalizeId(option.message_id)]);};window.replaceVariables=function(variables,option){option=optionOf(option);var plain=copy(variables||{}),before=window.getVariables(option);localReplace(plain,option);var task=call("updateTavernHelperVariables",{option:option,variables:plain}).then(function(result){if(result&&result.stale)throw new Error("聊天已变化，变量未保存");return copy(plain);}).catch(function(error){if(JSON.stringify(window.getVariables(option))===JSON.stringify(plain))localReplace(before,option);throw error;});task.catch(function(error){console.error(error);});return task;};window.insertOrAssignVariables=function(variables,option){return window.replaceVariables(window._.mergeWith(window.getVariables(option),copy(variables||{}),function(left,right){return Array.isArray(right)?right:undefined;}),option);};window.insertVariables=function(variables,option){return window.replaceVariables(window._.mergeWith({},copy(variables||{}),window.getVariables(option),function(left,right){return Array.isArray(right)?right:undefined;}),option);};window.updateVariablesWith=async function(updater,option){option=optionOf(option);var current=window.getVariables(option),next=typeof updater==="function"?await updater(copy(current)):current;if(next===undefined)next=current;next=copy(next);return await window.replaceVariables(next,option);};window.setChatMessages=async function(patches){var plain=copy(patches||[]);localSetMessages(plain);var result=await call("updateTavernHelperMessages",{messages:plain});return result;};window.retrieveDisplayedMessage=function(messageId){return normalizeId(messageId)===currentId()?window.jQuery(document.body):window.jQuery();};window.toastr={success:function(message){console.info(String(message));},info:function(message){console.info(String(message));},warning:function(message){console.warn(String(message));},error:function(message){console.error(String(message));}};window.eventOn=function(name,handler){(listeners[name]||(listeners[name]=new Set())).add(handler);return handler;};window.eventOff=function(name,handler){if(listeners[name])listeners[name].delete(handler);};window.eventEmit=async function(name){var args=Array.prototype.slice.call(arguments,1),items=listeners[name]?Array.from(listeners[name]):[];for(var i=0;i<items.length;i+=1)await items[i].apply(null,args);};window.tavern_events={MESSAGE_SENT:"MESSAGE_SENT",MESSAGE_RECEIVED:"MESSAGE_RECEIVED",MESSAGE_UPDATED:"MESSAGE_UPDATED",MESSAGE_SWIPED:"MESSAGE_SWIPED",MESSAGE_DELETED:"MESSAGE_DELETED",MESSAGE_EDITED:"MESSAGE_EDITED"};if(state.mvuEnabled!==false)window.Mvu={events:{VARIABLE_INITIALIZED:"mag_variable_initialized",VARIABLE_UPDATE_STARTED:"mag_variable_update_started",COMMAND_PARSED:"mag_command_parsed",VARIABLE_UPDATE_ENDED:"mag_variable_update_ended",BEFORE_MESSAGE_UPDATE:"mag_before_message_update"},getMvuData:function(option){return window.getVariables(option);},replaceMvuData:async function(value,option){await window.updateVariablesWith(function(){return value;},option);return copy(value);},parseMessage:async function(){throw new Error("当前兼容层尚未开放 iframe 内手动 MVU 重算");}};window.waitGlobalInitialized=async function(name){if(name==="Mvu")return window.Mvu;return window[name];};var ready=import(new URL("/api/dsh-tavern/vendor/runtime-assets/zod/index.mjs",document.baseURI).href).then(function(module){window.z=module;return true;});window.__dshTavernHelperReady=ready;if(window.jQuery&&window.jQuery.fn&&window.jQuery.fn.load&&!window.jQuery.fn.__dshDeferred){var original=window.jQuery.fn.load;var deferred=function(){var self=this,args=arguments;ready.then(function(){original.apply(self,args);});return self;};deferred.__dshDeferred=true;window.jQuery.fn.load=deferred;}})();<\/script>' : '';
			const interactiveHelperShim = input && input.helperContext ? '<script data-dsh-tavern-interactive-helper>(function(){var token=' + token + ',nextId=1,pending=Object.create(null);function copy(value){try{return structuredClone(value);}catch(e){return JSON.parse(JSON.stringify(value));}}function call(method,args){return new Promise(function(resolve,reject){var requestId="interactive:"+String(nextId++);pending[requestId]={resolve:resolve,reject:reject};parent.postMessage({type:"dsh-tavern-helper-call",token:token,requestId:requestId,method:method,args:copy(args||{})},"*");});}addEventListener("message",function(event){var data=event&&event.data;if(event.source!==parent||!data||data.token!==token||data.type!=="dsh-tavern-helper-response")return;var task=pending[data.requestId];if(!task)return;delete pending[data.requestId];if(data.ok)task.resolve(data.result);else task.reject(new Error(String(data.error||"Helper 调用失败")));});function payload(entries){if(!Array.isArray(entries))throw new TypeError("世界书条目必须是数组");return copy(entries).map(function(entry){delete entry.uid;return entry;});}async function fresh(name){var result=await call("getTavernHelperWorldbook",{name:String(name||"")});return copy(result&&result.worldbook&&result.worldbook.entries||[]);}async function replace(name,entries,expectedEntries){var result=await call("replaceTavernHelperWorldbook",{name:String(name||""),entries:copy(entries),expectedEntries:copy(expectedEntries)});return copy(result&&result.worldbook&&result.worldbook.entries||[]);}window.getWorldbook=async function(name){return await fresh(name);};window.updateWorldbookWith=async function(name,updater){if(typeof updater!=="function")throw new TypeError("世界书更新器必须是函数");var current=await fresh(name),draft=copy(current),next=await updater(draft);return await replace(name,next===undefined?draft:next,current);};window.createWorldbookEntries=async function(name,entries){var additions=payload(entries),previous;var worldbook=await window.updateWorldbookWith(name,function(current){previous=new Set(current.map(function(entry){return entry.uid;}));return current.concat(additions);});return{worldbook:worldbook,new_entries:worldbook.filter(function(entry){return!previous.has(entry.uid);})};};window.deleteWorldbookEntries=async function(name,predicate){if(typeof predicate!=="function")throw new TypeError("世界书删除条件必须是函数");var deleted=[];var worldbook=await window.updateWorldbookWith(name,function(current){return current.filter(function(entry){if(!predicate(copy(entry)))return true;deleted.push(copy(entry));return false;});});return{worldbook:worldbook,deleted_entries:deleted};};window.generateRaw=function(config){return call("generateTavernHelperRaw",{config:copy(config)}).then(function(result){return result.text;});};window.createChatMessages=async function(messages,option){var result=await call("createTavernHelperMessages",{messages:copy(Array.isArray(messages)?messages:[]),option:copy(option&&typeof option==="object"?option:{})});if(result&&result.stale)throw new Error("聊天已变化，消息未创建");};window.triggerSlash=function(line){return call("triggerTavernSlash",{line:String(line||"")});};var worldbook=' + JSON.stringify(input && input.helperContext && input.helperContext.worldbook || null).replace(/</g, '\\u003c') + ';window.getCharWorldbookNames=function(){return {primary:worldbook&&worldbook.name||null,additional:[]};};window.getWorldbookNames=function(){return worldbook&&worldbook.name?[worldbook.name]:[];};window.TavernHelper=window.TavernHelper||{};["getCurrentCharacterName","getVariables","replaceVariables","insertOrAssignVariables","insertVariables","updateVariablesWith","generateRaw","createChatMessages","getWorldbook","getCharWorldbookNames","getWorldbookNames","updateWorldbookWith","createWorldbookEntries","deleteWorldbookEntries"].forEach(function(name){Object.defineProperty(window.TavernHelper,name,{enumerable:true,configurable:true,get:function(){return window[name];},set:function(value){window[name]=value;}});});})();<\/script>' : '';
			const mvuViewObservationShim = input && input.helperContext && input.observeMvuView !== false ? '<script data-dsh-tavern-mvu-view-observer>(function(){var token=' + token + ',reported=false;function report(){if(reported)return;reported=true;window.__dshTavernMvuViewUsed=true;parent.postMessage({type:"dsh-tavern-mvu-view-used",token:token,mvuViewUsed:true},"*");}var getMvuData=window.Mvu&&window.Mvu.getMvuData;if(typeof getMvuData==="function")window.Mvu.getMvuData=function(){report();return getMvuData.apply(window.Mvu,arguments);};var getVariables=window.getVariables;if(typeof getVariables==="function")window.getVariables=function(){report();return getVariables.apply(window,arguments);};})();<\/script>' : '';
			// parent.Mvu may throw an Error from another iframe: instanceof alone loses its stack.
			const runtimeReporter = input && input.runtimeReporting === false ? '' : '<script data-dsh-tavern-frame>(function(){var token=' + token + ';var captureDom=' + JSON.stringify(!(input && input.persistent === true)) + ';var logs=[],network=[],errors=[],timer=0;function trim(list){if(list.length>100)list.splice(0,list.length-100);}function value(input,depth){if(depth>3)return "[深度已截断]";if(input===null||input===undefined||typeof input==="boolean"||typeof input==="number"||typeof input==="string")return typeof input==="string"&&input.length>4000?input.slice(0,4000)+"…[已截断]":input;try{if(input instanceof Error||Object.prototype.toString.call(input)==="[object Error]")return {name:String(input.name),message:String(input.message).slice(0,4000),stack:String(input.stack||"").slice(0,4000)};if(Array.isArray(input))return input.slice(0,30).map(function(item){return value(item,depth+1);});if(typeof input==="object"){var out={};Object.keys(input).slice(0,30).forEach(function(key){out[key]=value(input[key],depth+1);});return out;}}catch(e){}return String(input);}function cleanUrl(input){try{var parsed=new URL(String(input),location.href);return parsed.protocol+"//"+parsed.host+parsed.pathname;}catch(e){return String(input||"").split(/[?#]/)[0].slice(0,1000);}}function send(){timer=0;var dom="";try{if(captureDom&&document.body){var copy=document.body.cloneNode(true);Array.prototype.forEach.call(copy.querySelectorAll("script[data-dsh-tavern-frame],script[data-dsh-tavern-storage],script[data-dsh-tavern-layout]"),function(node){node.remove();});dom=copy.innerHTML;}}catch(e){}if(dom.length>100000)dom=dom.slice(0,100000)+"<!-- 已截断 -->";parent.postMessage({type:"dsh-tavern-frame-runtime",token:token,runtime:{capturedAt:Date.now(),dom:dom,console:logs.slice(),network:network.slice(),errors:errors.slice()}} ,"*");}function schedule(){if(timer)return;timer=setTimeout(send,350);}["log","info","warn","error"].forEach(function(level){var original=console[level];console[level]=function(){logs.push({at:Date.now(),level:level,args:Array.prototype.map.call(arguments,function(item){return value(item,0);})});trim(logs);schedule();return original&&original.apply(console,arguments);};});addEventListener("error",function(event){var target=event.target;if(target&&target!==window){errors.push({at:Date.now(),kind:"resource",tag:String(target.tagName||""),url:cleanUrl(target.src||target.href||"")});}else errors.push({at:Date.now(),kind:"error",message:String(event.message||""),source:cleanUrl(event.filename||""),line:Number(event.lineno)||0,column:Number(event.colno)||0});trim(errors);schedule();},true);addEventListener("unhandledrejection",function(event){errors.push({at:Date.now(),kind:"unhandledrejection",message:String(event.reason&&event.reason.message||event.reason||"")});trim(errors);schedule();});if(typeof window.fetch==="function"){var nativeFetch=window.fetch;window.fetch=function(input,init){var started=Date.now(),method=String(init&&init.method||"GET").toUpperCase(),url=cleanUrl(input&&input.url||input);return nativeFetch.apply(this,arguments).then(function(response){network.push({at:started,kind:"fetch",method:method,url:url,status:Number(response.status)||0,durationMs:Date.now()-started});trim(network);if(!response.ok)schedule();return response;},function(error){network.push({at:started,kind:"fetch",method:method,url:url,failed:true,durationMs:Date.now()-started,error:String(error&&error.message||error)});trim(network);schedule();throw error;});};}if(typeof XMLHttpRequest==="function"){var nativeOpen=XMLHttpRequest.prototype.open,nativeSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(method,url){this.__dshRequest={started:0,method:String(method||"GET").toUpperCase(),url:cleanUrl(url)};return nativeOpen.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){var request=this.__dshRequest||{method:"GET",url:""};request.started=Date.now();this.addEventListener("loadend",function(){network.push({at:request.started,kind:"xhr",method:request.method,url:request.url,status:Number(this.status)||0,durationMs:Date.now()-request.started});trim(network);if(Number(this.status)>=400)schedule();});return nativeSend.apply(this,arguments);};}addEventListener("load",schedule);schedule();})();<\/script>';
			const reporter = '<script data-dsh-tavern-frame>(function(){var token=' + token + ';var viewportFloor=' + tavernFrameViewportFloor.toString() + ';var last=0;var queued=false;var active=true;function nodeBottom(node){if(!node||typeof node.getBoundingClientRect!=="function")return 0;var style;try{style=getComputedStyle(node);}catch(e){return 0;}if(style.display==="none"||style.visibility==="hidden"||style.position==="fixed")return 0;var rect=node.getBoundingClientRect();if(rect.width===0&&rect.height===0)return 0;var top=rect.top,bottom=rect.bottom+Math.max(0,parseFloat(style.marginBottom)||0);var ancestor=node.parentElement;while(ancestor&&ancestor!==document.documentElement){if(String(ancestor.tagName||" ").toLowerCase()==="details"&&!ancestor.open){var summary=ancestor.querySelector("summary");if(!summary||!summary.contains(node))return 0;}var ancestorStyle;try{ancestorStyle=getComputedStyle(ancestor);}catch(e){ancestorStyle=null;}var overflow=String(ancestorStyle&&(ancestorStyle.overflowY||ancestorStyle.overflow)||"visible");if(overflow!=="visible"){var ancestorRect=ancestor.getBoundingClientRect();top=Math.max(top,ancestorRect.top);bottom=Math.min(bottom,ancestorRect.bottom);if(bottom<=top)return 0;}ancestor=ancestor.parentElement;}return Math.ceil(bottom+(window.scrollY||0));}function measure(){var body=document.body;if(!body)return 48;var bodyRect=body.getBoundingClientRect();var height=Math.max(body.scrollHeight||0,Math.ceil(bodyRect.bottom+(window.scrollY||0)),48,viewportFloor());var nodes=[body].concat(Array.prototype.slice.call(body.querySelectorAll("*")));for(var i=0;i<nodes.length;i+=1)height=Math.max(height,nodeBottom(nodes[i]));return height;}function report(){queued=false;if(!active)return;var height=measure();document.documentElement.toggleAttribute("data-dsh-tavern-scroll",height>=32000);if(height===last)return;last=height;parent.postMessage({type:"dsh-tavern-frame-height",token:token,height:height},"*");}function schedule(){if(!active||queued)return;queued=true;if(typeof requestAnimationFrame==="function")requestAnimationFrame(report);else setTimeout(report,0);}if(typeof ResizeObserver==="function"){var observer=new ResizeObserver(schedule);observer.observe(document.documentElement);if(document.body)observer.observe(document.body);}addEventListener("load",schedule);addEventListener("toggle",schedule,true);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(schedule);var mutations=new MutationObserver(schedule);function observe(){mutations.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});if(typeof observer!=="undefined"){observer.observe(document.documentElement);if(document.body)observer.observe(document.body);}}addEventListener("message",function(event){var data=event.data;if(event.source!==parent||!data||data.token!==token||data.type!=="dsh-tavern-frame-measure-active")return;active=data.active!==false;if(active){observe();schedule();}else{mutations.disconnect();if(typeof observer!=="undefined")observer.disconnect();}});observe();schedule();})();<\/script>';
			// Animated/polling cards may never become DOM-idle; bound the wait so
			// their authenticated variable channel can start receiving updates.
			const readyReporter = '<script data-dsh-tavern-frame-ready>(function(){var token=' + token + ',armed=false,timer=0,deadline=0,reported=false;function report(){if(reported)return;reported=true;clearTimeout(timer);clearTimeout(deadline);observer.disconnect();var finish=function(){parent.postMessage({type:"dsh-tavern-frame-ready",token:token},"*");};if(typeof requestAnimationFrame==="function")requestAnimationFrame(function(){requestAnimationFrame(finish);});else setTimeout(finish,0);}function schedule(){if(!armed||reported)return;if(timer)clearTimeout(timer);timer=setTimeout(report,240);}var observer=new MutationObserver(schedule);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});addEventListener("load",schedule);Promise.resolve(window.__dshTavernHelperReady).catch(function(){return false;}).then(function(){armed=true;deadline=setTimeout(report,1000);schedule();});})();<\/script>';
			const layoutNormalizer = '<script data-dsh-tavern-layout>(function(){if(!document.body)return;function clean(){Array.prototype.slice.call(document.body.childNodes).forEach(function(node){var value=String(node.nodeValue||"");if(node.nodeType===3&&!/\\S/.test(value)&&/[\\r\\n]/.test(value))node.nodeValue="";});}clean();if(typeof MutationObserver!=="undefined"){var observer=new MutationObserver(clean);observer.observe(document.body,{childList:true});addEventListener("pagehide",function(){observer.disconnect();},{once:true});}})();<\/script>';
			const fontRuntime = '<script data-dsh-tavern-font-runtime>(' + installTavernFrameFonts.toString() + ')(' + token + ',' + restoreTavernFrameFontStyles.toString() + ');<\/script>';
            const textColorRuntime = '<script data-dsh-tavern-text-colors>(function(){const colors=(' + installTavernTextColors.toString() + ')(document.body,{enabled:false},' + findTavernQuoteRanges.toString() + ');addEventListener("message",function(event){const data=event.data;if(event.source===parent&&data&&data.token===' + token + '&&(data.type==="dsh-tavern-text-colors"||data.type==="dsh-tavern-font-size")){colors.setColors(data.textColorOverrides);colors.setEnabled(data.type==="dsh-tavern-font-size"?data.textColorsEnabled:data.enabled);}});addEventListener("pagehide",()=>colors.dispose(),{once:true});})();<\/script>';
            const cleanRuntimeReporter = runtimeReporter.replace('dom=copy.innerHTML;', '(' + restoreTavernFrameFontStyles.toString() + ')(copy);Array.from(copy.querySelectorAll("script[data-dsh-tavern-font-runtime],script[data-dsh-tavern-text-colors],script[data-dsh-tavern-touch]")).forEach(function(node){node.remove();});dom=copy.innerHTML;');
			return '<!doctype html><html><head><meta charset="utf-8">'
				+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
				+ '<meta name="referrer" content="no-referrer">'
				+ '<meta http-equiv="Content-Security-Policy" content="default-src https: http: data: blob:; img-src https: http: data: blob:; media-src https: http: data: blob:; font-src https: http: data:; style-src \'unsafe-inline\' https: http:; script-src \'unsafe-inline\' \'unsafe-eval\' https: http: data: blob:; connect-src https: http: wss: data: blob:; frame-src https: http: data: blob:; object-src \'none\'; base-uri \'none\'; form-action \'none\'">'
				+ '<style>:root{color-scheme:light dark}html,body{box-sizing:border-box;margin:0;min-height:0;background:transparent;color:CanvasText;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;line-height:1.75}body{padding:0 1px;overflow-wrap:anywhere;white-space:pre-wrap}html[data-dsh-tavern-scroll]{overflow-y:auto!important}html[data-dsh-tavern-scroll] body{overflow-y:visible!important}body>*{white-space:normal}maintext{display:block;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-tavern-plain-text{white-space:pre-wrap;overflow-wrap:anywhere}*,*:before,*:after{box-sizing:border-box}img,video,svg,canvas{max-width:100%;height:auto}pre{max-width:100%;overflow:auto;white-space:pre-wrap}table{max-width:100%;border-collapse:collapse}a{color:LinkText}</style>' + (preparationRuntime ? preparationRuntime.head : helperDependencies) + tavernStaticAssetShim() + '<script data-dsh-tavern-remote-document>(' + installTavernRemoteDocumentLoader.toString() + ')();<\/script>' + storageShim + helperShim + interactiveHelperShim + mvuViewObservationShim + cleanRuntimeReporter
				+ (input && input.helperContext && input.helperContext.openingHost ? '<script data-dsh-tavern-session-opening>(' + installSessionOpeningBridge.toString() + ')(' + token + ',' + JSON.stringify(Object.assign({}, input.helperContext.openingHost, { extensionSettings: input.helperContext.extensionSettings || {} })).replace(/</g, '\\u003c') + ');<\/script>' : '')
				+ (input && input.helperContext ? '<script data-dsh-tavern-frame-variable-aliases>(' + installTavernFrameVariableAliases.toString() + ')();<\/script>' : '')
				+ (input && input.helperContext && input.persistent === true && input.preserveInstance !== true ? '<script data-dsh-tavern-status-refresh>(' + installTavernStatusRefresh.toString() + ')(' + token + ');<\/script>' : '')
				+ (input && input.openingPreview ? '<script data-dsh-tavern-opening-preview>(function(){const install=()=>(' + installOpeningPreviewBridge.toString() + ')(' + token + ',' + JSON.stringify(input.openingPreview).replace(/</g, '\\u003c') + ');if(window.__dshTavernHelperReady)window.__dshTavernHelperReady.then(install);else install();})();<\/script>' : '')
				+ (preparationRuntime && input.trustedCardMode === true ? '<script data-dsh-tavern-opening-host>(function(){const release=(' + installTavernTrustedHostFacade.toString() + ')(window.parent,window,10);window.addEventListener("pagehide",release,{once:true});window.addEventListener("unload",release,{once:true});})();<\/script>' : '')
				// Viewers without the execution lease still receive live variables. Legacy
				// status panels read parent.Mvu; expose their Helper API below the executor.
				+ (!preparationRuntime && input && input.helperContext && input.persistent === true && input.trustedCardMode === true ? '<script data-dsh-tavern-status-host>(function(){const release=(' + installTavernTrustedHostFacade.toString() + ')(window.parent,window,-0.5,["Mvu"]);window.addEventListener("pagehide",release,{once:true});window.addEventListener("unload",release,{once:true});})();<\/script>' : '')
				+ '</head><body class="no-blur">' + (input && input.helperContext ? '<script data-dsh-tavern-legacy-composer>(' + installLegacyTavernComposer.toString() + ')();<\/script>' : '') + (preparationRuntime ? preparationRuntime.body : '') + html + layoutNormalizer + fontRuntime + (input && input.persistent ? "" : textColorRuntime) + reporter + '<script data-dsh-tavern-touch>(' + installTavernFrameTouch.toString() + ')(' + token + ',' + scrollTavernTouchChain.toString() + ');<\/script>' + readyReporter + '</body></html>';
		}

		function encodeTavernScriptSource(value) {
			const binary = encodeURIComponent(String(value || "")).replace(/%([0-9A-F]{2})/g, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
			if (typeof btoa === "function") return btoa(binary);
			const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
			let result = "";
			for (let index = 0; index < binary.length; index += 3) {
				const a = binary.charCodeAt(index);
				const b = index + 1 < binary.length ? binary.charCodeAt(index + 1) : 0;
				const c = index + 2 < binary.length ? binary.charCodeAt(index + 2) : 0;
				result += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)]
					+ (index + 1 < binary.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=")
					+ (index + 2 < binary.length ? alphabet[c & 63] : "=");
            }
            return result;
        }

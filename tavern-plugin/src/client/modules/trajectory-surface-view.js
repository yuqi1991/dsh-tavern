function installTavernTrajectorySurfaceView(require) {
			let conversation;
			try { conversation = require("@deepseek-ai/dsh-client-ui-conversation/client"); }
			catch (_) { return; }
			const proto = conversation && conversation.ConversationNodeAssembler && conversation.ConversationNodeAssembler.prototype;
			if (!proto || typeof proto.buildNode !== "function" || typeof proto.replaceView !== "function" || proto.__dshTavernTrajectorySurface) return;
			const ELIGIBLE = { "system/message": 1, "user/message": 1, "assistant/message": 1, "tool/result": 1 };
			const buildNode = proto.buildNode;
			const replaceView = proto.replaceView;
			proto.buildNode = function (context, target) {
				const node = buildNode.call(this, context, target);
				if (target !== "trajectory" || node === null || !context || !Array.isArray(context.matches)) return node;
				const matches = [];
				for (const match of context.matches) {
					const event = match && match.event;
					if (!event || typeof event.seq !== "number") continue;
					const source = event.type === "user/message" && event.data && event.data.source;
					matches.push({ seq: event.seq, type: String(event.type || ""), surfaceOp: event.surfaceOp === undefined ? null : event.surfaceOp,
						...(event.data && Number.isSafeInteger(event.data.turn) ? { turn: event.data.turn } : {}),
						...(event.data && Number.isSafeInteger(event.data.step) ? { step: event.data.step } : {}),
						...(source && typeof source === "object" ? { source: { kind: String(source.kind || ""), plugin: String(source.plugin || "") } } : {}) });
				}
				if (matches.length) node.tavernMatches = matches;
				return node;
			};
			// 与宿主 surface 相同的折叠：append 入列；replace 吞掉 [start..end] 并原位换入自身。
			// 证据只增不减（等价宿主事件日志的已加载窗口），行被剪掉也不会丢失折叠依据。
			function rowIsMessage(node) {
				return Boolean(node && Array.isArray(node.tavernMatches) && node.tavernMatches.some(function (meta) { return ELIGIBLE[meta.type]; }));
			}
			function rowIsEmpty(node) {
				const data = node && node.data;
				if (!data || typeof data !== "object") return false;
				if (data.kind === "node" && data.node && typeof data.node === "object" && Array.isArray(data.node.content)) return data.node.content.length === 0;
				if (data.kind === "assistant" && data.node && typeof data.node === "object" && Array.isArray(data.node.blocks) && data.partial == null) return data.node.blocks.length === 0;
				return false;
			}
			function pruneBuilder(builder) {
				if (!builder || typeof builder.replace !== "function" || typeof builder.apply !== "function" ||
					typeof builder.rebuildContributions !== "function" || typeof builder.snapshot !== "function" ||
					!(builder.nodes instanceof Map) || builder.__dshTavernSurfacePruned) return builder;
				const replace = builder.replace;
				const apply = builder.apply;
				const evidence = new Map();
				function collect(nodes) {
					for (const node of nodes || []) {
						if (!node || !Array.isArray(node.tavernMatches)) continue;
						for (const meta of node.tavernMatches) evidence.set(meta.seq, meta);
					}
				}
				// 折叠只在「replace 的引用范围全部可见」时才可信。轨迹页初始只加载最近约
				// 50 行事件，更早的行要靠「加载更早」补齐；若用残缺窗口硬折，replace 引用的
				// 起点不在窗口内会被误判为新行，更早的输入/正文会被误判成死行而隐藏——
				// 表现为「前几楼消失、旧快照冒出来」。因此 dead 集合只收窗口内可验证的折叠，
				// 状态不明的行保守保留（最坏情况是多显示，不会丢内容）。
				function liveSurfaceSeqsAndDead() {
					const metas = [...evidence.values()].sort(function (left, right) { return left.seq - right.seq; });
					const live = [];
					const dead = new Set();
					for (const meta of metas) {
						if (!ELIGIBLE[meta.type]) continue;
						const op = meta.surfaceOp;
						if (op === null || op === "append" || op === undefined) { live.push(meta.seq); continue; }
						if (op && op.op === "replace") {
							const start = live.indexOf(op.startSeq);
							const end = live.indexOf(op.endSeq);
							if (start >= 0 && end >= start && end < live.length) {
								for (let index = start; index <= end; index++) dead.add(live[index]);
								live.splice(start, end - start + 1, meta.seq);
							} else live.push(meta.seq);
						}
					}
					return { live, dead };
				}
				function liveSurfaceSeqs() {
					return liveSurfaceSeqsAndDead().live;
				}
				function nodeForSeq(seq) {
					for (const node of builder.nodes ? builder.nodes.values() : []) {
						if (!node || !Array.isArray(node.tavernMatches)) continue;
						if (node.tavernMatches.some(function (meta) { return meta.seq === seq; })) return node;
					}
					return null;
				}
				// 只过滤返回的快照，绝不删宿主 builder 的节点：删除节点会打乱宿主的
				// contributions / eventLocations 索引，工具调用行会被分到错误的轮次
				// 而显示到对话顶部。折叠依据（evidence）与节点存储都只增不减，
				// 因此每次隐藏都是可逆的呈现层过滤。
				function rowIsHidden(entry, dead) {
					if (!entry || !Number.isFinite(entry.seq)) return false;
					const meta = evidence.get(entry.seq);
					if (!meta || !ELIGIBLE[meta.type]) return false; // 审计行（轮次轨、请求）保留
					if (dead.has(meta.seq)) return true; // 窗口内可验证的已折叠死行
					if (Array.isArray(entry.content) && entry.content.length === 0) return true; // 空墓碑行
					return rowIsEmpty(nodeForSeq(entry.seq));
				}
				// 宿主按 turn:step 给 assistant 建节点。重生成/输入编辑的提交会以「原轮次的
				// turn:step」写回正文，于是它顶替了该键上原本那条带工具调用的 assistant 节点：
				// 调用块从节点模型里消失，宿主找不到发出者，就把对应的 tool 结果塞进 turn 0/step 1
				// 显示到对话顶部。这里按 tool 结果自带的 call 信息，把那条「仅工具调用」的
				// assistant 行补回同一轮（排在对应 tool 结果之前、正文之前），让宿主重新建立
				// 归属：轨迹视图本来就该还原「当时发出的消息」，补的是事件流里真实存在的事实。
				function repairToolCallOwnership(rows) {
					const list = Array.isArray(rows) ? rows : null;
					if (list === null) return list;
					const emitted = new Set();
					for (const entry of list) {
						if (entry && entry.kind === "assistant" && Array.isArray(entry.blocks)) {
							for (const block of entry.blocks) if (block && block.kind === "tool-call" && block.callId !== undefined) emitted.add(String(block.callId));
						}
					}
					const groups = new Map();
					for (const entry of list) {
						if (!entry || entry.kind !== "tool-result" || entry.callId === undefined || emitted.has(String(entry.callId))) continue;
						const call = entry.call;
						const meta = evidence.get(entry.seq);
						if (!meta || !Number.isSafeInteger(meta.turn) || !call || typeof call.name !== "string") continue;
						const step = Number.isSafeInteger(meta.step) ? meta.step : 0;
						const key = meta.turn + ":" + step;
						const group = groups.get(key) || { turn: meta.turn, step, seq: Infinity, blocks: [] };
						if (Number.isFinite(entry.seq)) group.seq = Math.min(group.seq, entry.seq);
						group.blocks.push({ kind: "tool-call", callId: String(entry.callId), name: call.name, argsRaw: call.argsRaw === undefined ? "" : call.argsRaw });
						groups.set(key, group);
					}
					if (groups.size === 0) return list;
					const added = [];
					for (const group of groups.values()) {
						added.push({
							kind: "assistant", seq: (Number.isFinite(group.seq) ? group.seq : 0) - 0.5, time: null,
							turn: group.turn, step: group.step, blocks: group.blocks, tavernSyntheticToolCalls: group.blocks.length
						});
					}
					const next = added.concat(list);
					next.sort(function (left, right) {
						const a = Number(left && left.seq), b = Number(right && right.seq);
						return (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
					});
					return next;
				}
				function projectSnapshot(snapshot) {
					if (!snapshot || typeof snapshot !== "object") return snapshot;
					const dead = liveSurfaceSeqsAndDead().dead;
					let next = snapshot;
					for (const field of ["eventNodes", "finalized"]) {
						const rows = Array.isArray(next[field]) ? next[field] : null;
						if (rows === null) continue;
						const kept = rows.filter(function (entry) { return !rowIsHidden(entry, dead); });
						const repaired = repairToolCallOwnership(kept);
						if (repaired !== rows) next = Object.assign({}, next, { [field]: repaired });
					}
					return regenerationView(next);
				}
				// 重生成进行中：surface 里仍有存活的合成输入（dsh-tavern-regen）。宿主请求投影
				// （projectRegenerationRequestMessages）此刻已经把旧正文丢弃、并把原输入位改写为
				// 合成输入内容。这里在快照视图上复刻同一投影，使轨迹页在生成期间也等于真实请求。
				// 只过滤返回的快照、不动节点存储：中止恢复后下一次快照自动还原。
				function regenerationView(snapshot) {
					const live = liveSurfaceSeqs();
					let syntheticSeq = -1;
					for (let index = live.length - 1; index >= 0; index -= 1) {
						const meta = evidence.get(live[index]);
						if (meta && meta.type === "user/message" && meta.source && meta.source.plugin === "dsh-tavern-regen") { syntheticSeq = live[index]; break; }
					}
					if (syntheticSeq < 0) return snapshot;
					let inputSeq = -1;
					for (let index = live.indexOf(syntheticSeq) - 1; index >= 0; index -= 1) {
						const meta = evidence.get(live[index]);
						if (meta && meta.type === "user/message" && meta.source && meta.source.kind === "user") { inputSeq = live[index]; break; }
					}
					if (inputSeq < 0) return snapshot;
					const dropped = new Set(live.slice(live.indexOf(inputSeq) + 1, live.indexOf(syntheticSeq) + 1));
					let syntheticContent = null;
					for (const node of builder.nodes.values()) {
						if (!node || !Array.isArray(node.tavernMatches)) continue;
						if (!node.tavernMatches.some(function (meta) { return meta.seq === syntheticSeq; })) continue;
						const content = node.data && node.data.node && node.data.node.content;
						if (Array.isArray(content)) syntheticContent = content;
						break;
					}
					let projected = snapshot;
					for (const field of ["eventNodes", "finalized"]) {
						const rows = Array.isArray(projected[field]) ? projected[field] : null;
						if (rows === null) continue;
						const next = [];
						for (const entry of rows) {
							if (dropped.has(entry.seq)) continue;
							if (entry.seq === inputSeq && syntheticContent !== null && Array.isArray(entry.content)) {
								next.push(Object.assign({}, entry, { content: structuredClone(syntheticContent), tavernRegenProjected: true }));
								continue;
							}
							next.push(entry);
						}
						if (next.length !== rows.length || next.some(function (entry, index) { return entry !== rows[index]; })) {
							projected = Object.assign({}, projected, { [field]: next });
						}
					}
					return projected;
				}
				builder.replace = function (input) {
					collect(input && input.nodes);
					replace.call(this, input);
					return projectSnapshot(this.snapshot());
				};
				builder.apply = function (input) {
					collect(input && input.upserts);
					apply.call(this, input);
					return projectSnapshot(this.snapshot());
				};
				Object.defineProperty(builder, "__dshTavernSurfacePruned", { value: true });
				return builder;
			}
			proto.replaceView = function (view) {
				if (view && view.target === "trajectory" && view.definition && typeof view.definition.create === "function" && !view.definition.__dshTavernTrajectoryCreate) {
					try {
						const create = view.definition.create;
						view.definition.create = function () { return pruneBuilder(create.call(this)); };
						Object.defineProperty(view.definition, "__dshTavernTrajectoryCreate", { value: true });
					} catch (_) { /* 冻结的定义对象：跳过包装，退回原始视图 */ }
				}
				// 视图在补丁装好前已物化的场合，直接补包现有 builder。
				if (view && view.target === "trajectory" && view.builder) {
					try { pruneBuilder(view.builder); } catch (_) { /* 结构不符则放弃折叠 */ }
				}
				return replaceView.call(this, view);
			};
			Object.defineProperty(proto, "__dshTavernTrajectorySurface", { value: true });
		}
installTavernTrajectorySurfaceView(require);

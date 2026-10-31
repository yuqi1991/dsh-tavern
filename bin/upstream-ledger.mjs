#!/usr/bin/env node
// 上游提交处理清单（docs/upstream-port/ledger.tsv）。
//   node bin/upstream-ledger.mjs pending [--limit N] [--tsv]   # 还没处理的上游提交（不在清单里的）
//   node bin/upstream-ledger.mjs mark <hash> <ported|partial|skipped|n-a|unknown> <备注…> [--ours <我们的提交>]
//   node bin/upstream-ledger.mjs stats                          # 各状态计数
//   node bin/upstream-ledger.mjs bootstrap [--force]            # 一次性：从 PLAN.md 与提交说明里提取已知记录（启发式，见 ledger 头部）
// 环境变量：UPSTREAM（默认 upstream/main）、OLD_BASE（默认 5ae0c1f5）、LEDGER（默认 docs/upstream-port/ledger.tsv）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedFileSet } from './fork-delta.mjs';

const UPSTREAM = process.env.UPSTREAM || 'upstream/main';
const OLD_BASE = process.env.OLD_BASE || '5ae0c1f5';
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const LEDGER = process.env.LEDGER || path.join(ROOT, 'docs/upstream-port/ledger.tsv');
const STATUSES = ['ported', 'partial', 'skipped', 'n-a', 'unknown'];
const HEADER = 'upstream\tstatus\tours\tnote';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, cwd: ROOT });
const short = (h) => h.slice(0, 8);

function readLedger() {
  const comments = [];
  const rows = new Map();
  if (!fs.existsSync(LEDGER)) return { comments, rows };
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line) continue;
    if (line.startsWith('#')) { comments.push(line); continue; }
    if (line === HEADER) continue;
    const [h, status, ours = '', ...note] = line.split('\t');
    rows.set(short(h), { h: short(h), status, ours, note: note.join('\t') });
  }
  return { comments, rows };
}
function writeLedger({ comments, rows }) {
  const sorted = [...rows.values()].sort((a, b) => a.h.localeCompare(b.h));
  const body = sorted.map((r) => [r.h, r.status, r.ours, r.note.replace(/[\t\n]/g, ' ')].join('\t'));
  fs.writeFileSync(LEDGER, [...comments, HEADER, ...body].join('\n') + '\n');
}

function upstreamCommits() {
  // 日期升序；--no-merges
  const out = git(['log', '--no-merges', '--reverse', '--date=short', '--format=%H%x09%ad%x09%s', `${OLD_BASE}..${UPSTREAM}`]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [full, date, ...s] = l.split('\t');
    return { full, h: short(full), date, subject: s.join('\t') };
  });
}

function cmdStats() {
  const { rows } = readLedger();
  const c = {};
  for (const r of rows.values()) c[r.status] = (c[r.status] || 0) + 1;
  console.log(`ledger 共 ${rows.size} 条：` + STATUSES.map((s) => `${s}=${c[s] || 0}`).join(' '));
  const bad = [...rows.values()].filter((r) => !STATUSES.includes(r.status));
  if (bad.length) console.log('非法状态：', bad.map((r) => `${r.h}:${r.status}`).join(' '));
}

function cmdPending(args) {
  const { rows } = readLedger();
  const commits = upstreamCommits();
  const pending = commits.filter((c) => !rows.has(c.h));
  // 触及文件数与“共享文件”数
  const shared = sharedFileSet();
  const files = new Map();
  let cur = null;
  const log = git(['log', '--no-merges', '--name-only', '-z', '--format=%x01%H', `${OLD_BASE}..${UPSTREAM}`]);
  for (const part of log.split('\x01')) {
    if (!part) continue;
    const [hash, ...names] = part.split('\0').join('\n').split('\n');
    cur = short(hash.trim());
    files.set(cur, names.map((n) => n.trim()).filter(Boolean));
  }
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
  const tsv = args.includes('--tsv');
  if (!tsv) console.log(`上游 ${OLD_BASE}..${UPSTREAM} 非合并提交 ${commits.length} 个，ledger 已记 ${commits.length - pending.length} 个，待处理 ${pending.length} 个。`);
  console.log(['hash', 'date', 'files', 'shared', 'subject'].join('\t'));
  for (const c of pending.slice(0, limit)) {
    const fs_ = files.get(c.h) || [];
    const sh = fs_.filter((f) => shared.has(f)).length;
    console.log([c.h, c.date, fs_.length, sh, c.subject].join('\t'));
  }
}

function cmdMark(args) {
  const oursIdx = args.indexOf('--ours');
  let ours = '';
  if (oursIdx >= 0) { ours = args[oursIdx + 1]; args.splice(oursIdx, 2); }
  const [hash, status, ...note] = args;
  if (!hash || !STATUSES.includes(status)) {
    console.error(`用法：mark <hash> <${STATUSES.join('|')}> <备注…> [--ours <提交>]`);
    process.exit(2);
  }
  const full = git(['rev-parse', '--verify', `${hash}^{commit}`]).trim();
  const l = readLedger();
  l.rows.set(short(full), { h: short(full), status, ours, note: note.join(' ') });
  writeLedger(l);
  console.log(`${short(full)} -> ${status}`);
}

// ---- bootstrap：启发式提取，结果需要人工抽查 ----
const NEG = /未取|不取|未移植|暂缓|未做|没做|不适用|未带入|被依赖阻塞|依赖.{0,20}(我们没有|不存在)|不在 upstream|不是上游|有意不|未装/;
const POS = /已取|已加|取了|手工移植|完成|取上游|移植|按.{0,6}移植|已补|已加入|重写|取上游最终状态/;

// 格式：哈希[,哈希…]|状态|我们的提交|备注
const OVERRIDES = `
021fcbbd,ddce9397|ported||批1 世界书小包（PLAN.md 记其完成）
e6fcb341,0c8fd3c6,d1985cf2|ported||批1 手动台账（PLAN.md）
439a00ac,5a433958,1d413050|ported||批1 剧本进度（PLAN.md；测试按新界面重写）
a72857b5|ported||批1 候选面板（PLAN.md「a72857b5 等 4 个」，其余 3 个哈希 PLAN 未写出）
3ba39f0b,b754116b|ported||批2 卡片 iframe 性能（手工移植，PLAN.md）
30c12746,cf0d795e|ported||批4 request-lineage（手工，PLAN.md）
b5d04832,db1ed45a,79445692|ported||批4 压缩稳健性（PLAN.md）
c7460255,a3b5943a,d219c680,63ae6e6c,a51ad3b0,a15ec319,95949fc0,de1a6241,7a0c0278,969f001e,8d74ba4d|ported||批3 MVU 第一段（PLAN.md「已取」；8d74ba4d 取上游终态）
3108bd9e,08f3ec10,00e37c7d|ported||批3 MVU 第二段：tavern_search_card / replace_card_text / validate_card 按行为手工移植（PLAN.md）
ee728107|partial||批3：取了“新增”的一半，删草稿/转换/指纹体系那一半有意没做（PLAN.md）
c901170e,30e49078|partial||ST 聊天记录批量导入已取，卡片列表入口/按卡名自动匹配未取（PLAN.md 批5）
879b77f2|partial||仅取聊天导入部分（手机选择器不按扩展名过滤，PLAN.md 批5）
1de6f3f7,c1fa396b,5e578817,852a2191,7bebc129,38689b55,1a07bf9c,c11ff84d,a9c07228|ported||批5 小修复（PLAN.md「已取」）
32b95c28|partial||批5 已取，插件任务测试不适用（PLAN.md）
9ef26981,21a2087d,d7ed9577|ported||批5 重新生成「按意见改写」（手工，PLAN.md）
be8a1a82,0100a6a8,0b5ebe4d|ported||批5 续（PLAN.md「已取」；我们有同标题提交）
9dedc0ec|ported||批0 采用上游客户端拆分布局（PLAN.md）
31c6c361|partial||只取 F2/F4（比对缓存序列化、主题读取节流）；F1（只内联最近 48 楼）未取（PLAN.md 批2）
87b94a5b,377f70cf,68dff3dd|partial||PLAN.md 当时只评估；后由自有设计实现“保留最近 N 轮”（我们的 608c2c4f、190370ef、4d1003e8），非逐提交移植
0eb28243,0b8206e8,d54395d9,e8145dd0,57104435|partial||PLAN.md 当时排在保留 N 轮之后；后由自有设计实现分卷摘要（我们的 00c8ae1f），非逐提交移植
7b5c2d28|partial|00c8ae1f|PLAN.md 写“与保留 N 轮一起做”；我们的 00c8ae1f 有“合并摘要请求钩子”，是否等价未逐行核对
1133ecbd|skipped||历史正文以工具参数回放：上游前提是契约声明 submit_story 工具，我们没有（PLAN.md 批4 评估）；我们另做了 tavern_recall_history
09701afe|skipped||模板同步改写压缩检查点：我们的模板同步只按精确文字匹配，不适用（PLAN.md）
851fc159,d8806e18,0d3cc56f,f3945537|skipped||批4 周边项，仅评估未动手（PLAN.md）
3256ffca,8bb7fc3a|skipped||世界书：依赖 adapter 合并 / 按需读楼层（PLAN.md）
70c0c51e,87c4b25a,83a4ff6b,a0cf6179|skipped||人物设计档案链，被依赖阻塞（PLAN.md）
cce1e238,f8222828|skipped||旧档迁移，不取（PLAN.md）
a087be28,f274e141|skipped||删除“卡片界面跟随 DSH 字号缩放”，功能删除，等用户决定（PLAN.md）
b3569d55|n-a||不需要：我们的回退把插件行一律当上下文（PLAN.md）
dbf59ef6|skipped||上游删了“查看后台 Agent”按钮，我们保留（PLAN.md）
5509757f,b34dd02d|skipped||结算项重构 / 状态面板仪表盘，按计划暂缓（PLAN.md）
8d84a002,f7ef2b4a|skipped||依赖我们没有的模型代理/runtime-preset-front（PLAN.md）
8d91cd1d|n-a||不在 upstream/main 上，与转换无关（PLAN.md 批3 第三段）
0738100f,6561686f,46b62981,1867958a,e6698da8,2bba891a,0918b79e,c69d74f0,f7d4de98|partial|6db68864|PLAN.md 写“未做”；之后我们合并了手机布局链（60a2fd83、42f39bfd、6db68864、dfb85467、b7f8ee08 等）。逐提交覆盖未核对
2b337649,5d060841,142b49c4|partial|6db68864|PLAN.md 写暂缓；之后我们有“顶栏快捷入口与世界书快捷面板”（6db68864、cddaf6dc）。逐提交覆盖未核对
0502d381,d1806cde|partial|5df2dbca|PLAN.md 写未取；之后我们有“原生 #send_textarea 选项填入 DSH 输入框”（5df2dbca、2cf8ba25）。逐提交覆盖未核对
ed406b1b,8bf81b12|partial|05212591|PLAN.md 写未取；之后我们有“预设合并为一个预设标签页”（05212591）。逐提交覆盖未核对
ce30412f|partial|22fc7518|PLAN.md 写未取；之后我们有“本局设置合为 4 个分区”（22fc7518）。逐提交覆盖未核对
0879275c|skipped||新游戏按卡名命名，DSH 0.2 标题行为（PLAN.md 评估后未取）；0.2.1 下是否仍需要未核对
b8ea82f6|unknown||PLAN.md 提到处语境不明（不取 08cdb7df 一句中），未判定
`;

function bootstrap(args) {
  const l = readLedger();
  if (l.rows.size && !args.includes('--force')) { console.error('ledger 已存在，加 --force 覆盖'); process.exit(1); }
  const commits = upstreamCommits();
  const full = git(['rev-list', '--no-merges', `${OLD_BASE}..${UPSTREAM}`]).split('\n').filter(Boolean);
  const byPrefix = (p) => {
    const m = full.filter((f) => f.startsWith(p));
    return m.length === 1 ? m[0] : null;
  };
  const rows = new Map();
  const put = (h, status, ours, note) => {
    const prev = rows.get(h);
    if (prev && prev.status !== status && prev.status !== 'unknown') {
      rows.set(h, { h, status: 'partial', ours: prev.ours || ours, note: `${prev.note} | ${note}` });
    } else if (!prev || prev.status === 'unknown') rows.set(h, { h, status, ours, note });
  };

  // 1) 我们提交里的 cherry-pick -x 记录与说明里出现的上游短哈希
  const ourLog = git(['log', '--format=%x01%h%x02%s%x02%B', `${OLD_BASE}..HEAD`, '--not', UPSTREAM]);
  for (const rec of ourLog.split('\x01').filter(Boolean)) {
    const [ours, subject, body] = rec.split('\x02');
    const picked = [...body.matchAll(/cherry picked from commit ([0-9a-f]{40})/g)].map((m) => m[1]);
    for (const p of picked) if (full.includes(p)) put(short(p), 'ported', ours, `cherry-pick -x：${subject.slice(0, 80)}`);
    for (const m of subject.matchAll(/\b([0-9a-f]{8})\b/g)) {
      const f = byPrefix(m[1]);
      if (!f || picked.includes(f)) continue;
      const neg = NEG.test(subject);
      put(short(f), neg ? 'skipped' : 'ported', ours, `提交说明提到：${subject.slice(0, 80)}`);
    }
  }

  // 1b) 同标题：我们的提交标题与上游提交标题完全一致（手工移植时沿用标题）
  const upBySubject = new Map();
  for (const c of commits) if (c.subject.length > 12) upBySubject.set(c.subject, c.h);
  for (const rec of ourLog.split('\x01').filter(Boolean)) {
    const [ours, subject] = rec.split('\x02');
    const h = upBySubject.get(subject.trim());
    if (h) put(h, 'ported', ours, `同标题：${subject.slice(0, 80)}`);
  }

  // 2) PLAN.md：按“分句”判定
  const plan = fs.readFileSync(path.join(ROOT, 'docs/upstream-port/PLAN.md'), 'utf8');
  let section = '';
  for (const line of plan.split('\n')) {
    if (/^#+ /.test(line)) section = line;
    const hashes = [...line.matchAll(/\b([0-9a-f]{8})\b/g)].map((m) => m[1]);
    if (!hashes.length) continue;
    // 按分号/句号切；一个分句里同时带“已取”和“未取”字样的不拆，标 partial
    const clauses = line.split(/[；;。]/);
    for (const clause of clauses) {
      const hs = [...clause.matchAll(/\b([0-9a-f]{8})\b/g)].map((m) => m[1]);
      for (const h of hs) {
        const f = byPrefix(h);
        if (!f) continue;
        const neg = NEG.test(clause);
        const pos = POS.test(clause) || (/^- \*\*.*(完成|已取)/.test(line) && !neg);
        let status = 'unknown';
        if (neg && pos) status = 'partial';
        else if (neg) status = 'skipped';
        else if (pos) status = 'ported';
        else if (/(完成|已取|已加)/.test(line) && !NEG.test(line)) status = 'ported';
        const note = `PLAN.md：${clause.trim().replace(/\s+/g, ' ').slice(0, 90)}`;
        // 同一分句里“不取：…（原因）”的原因里提到的其他哈希，不覆盖前面已有明确判断
        put(short(f), status, '', note);
      }
    }
  }
  // 2b) 内容等同：提交触及的文件现在在本树里与 upstream/main 逐字节相同（上游终态已在树里，推断）
  {
    const blobs = (rev) => new Map(git(['ls-tree', '-r', '-z', rev]).split('\0').filter(Boolean).map((l) => {
      const tab = l.indexOf('\t');
      return [l.slice(tab + 1), l.slice(0, tab).split(' ')[2]];
    }));
    const up = blobs(UPSTREAM);
    const mine = blobs('HEAD');
    const same = (f) => up.get(f) === mine.get(f); // 两边都缺也算相同
    const log = git(['log', '--no-merges', '--name-only', '-z', '--format=%x01%H', `${OLD_BASE}..${UPSTREAM}`]);
    for (const part of log.split('\x01')) {
      if (!part) continue;
      const [hash, ...names] = part.split('\0').join('\n').split('\n');
      const fl = names.map((n) => n.trim()).filter(Boolean);
      if (!fl.length) continue;
      const h = short(hash.trim());
      if (rows.has(h)) continue;
      if (fl.every(same)) rows.set(h, { h, status: 'ported', ours: '', note: `内容等同（推断）：触及的 ${fl.length} 个文件现与 ${UPSTREAM} 逐字节相同` });
    }
  }

  // 3) 人工校订（读过 PLAN.md 全文与后续提交后写下；优先级最高）
  for (const line of OVERRIDES.trim().split('\n')) {
    const [hs, status, ours, note] = line.split('|');
    for (const h of hs.split(',')) {
      const f = byPrefix(h.trim());
      if (!f) { console.error(`override 哈希不在范围内：${h}`); continue; }
      rows.set(short(f), { h: short(f), status, ours: ours.trim(), note: note.trim() });
    }
  }
  // 清掉把 unknown 当有效记录的歧义：unknown 保留，但 note 标明
  const out = { comments: [
    '# 上游提交处理清单。列：上游提交（短）｜状态 ported/partial/skipped/n-a/unknown｜我们对应提交｜备注',
    `# 范围：${OLD_BASE}..${UPSTREAM} 的非合并提交；不在本表的提交即“尚未处理”（见 bin/upstream-ledger.mjs pending）。`,
    '# 来源：我们提交里的 cherry-pick -x 记录与说明、docs/upstream-port/PLAN.md 的分句。PLAN.md 来源为关键词启发式（“已取/完成”→ported，“未取/不取/暂缓”→skipped，二者并存→partial，',
    '#   都没有→unknown），备注列保留原句以便抽查；批 0 的整体布局搬家、`-s ours` 合并本身没有逐提交记录，因此不在表内。',
    '# 用 `bin/upstream-ledger.mjs mark` 修正或追加。',
  ], rows };
  writeLedger(out);
  console.log(`写入 ${rows.size} 条（上游范围共 ${commits.length} 个非合并提交）`);
  cmdStats();
}

const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  switch (cmd) {
    case 'pending': cmdPending(rest); break;
    case 'mark': cmdMark(rest); break;
    case 'stats': cmdStats(); break;
    case 'bootstrap': bootstrap(rest); break;
    default:
      console.error('用法：upstream-ledger.mjs pending|mark|stats|bootstrap（见文件头注释）');
      process.exit(2);
  }
}

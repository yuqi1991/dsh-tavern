#!/usr/bin/env node
// fork 与 upstream/main 的差异清单。
//   node bin/fork-delta.mjs            # 文本摘要
//   node bin/fork-delta.mjs --md       # markdown 表格（贴进 docs/fork-delta.md 的自动段）
//   node bin/fork-delta.mjs --json     # 机器可读
//   ... --classify < 路径列表            # 逐个标注 generated/shared/test（给 upstream-dry-run.sh 用）
// 环境变量：UPSTREAM（默认 upstream/main）、OLD_BASE（默认 5ae0c1f5，用来判断“哪些文件是我们动过的”）。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const UPSTREAM = process.env.UPSTREAM || 'upstream/main';
const OLD_BASE = process.env.OLD_BASE || '5ae0c1f5';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

// 构建产物与锁文件：冲突时重建/取我们这边，不算“共享文件”。
export function isGenerated(file) {
  return (
    file === 'pnpm-lock.yaml' ||
    file === 'plugin.patch.yml' ||
    file === 'docs/index.html' ||
    file === 'dsh-tavern-runtime.json' ||
    file === 'tavern-plugin/lib/client.js' ||
    file === 'tavern-plugin/lib/domain/mvu-schema.generated.js' ||
    /^tavern-plugin\/(packages\/[^/]+\/)?pnpm-lock\.yaml$/.test(file) ||
    /^tavern-plugin\/packages\/dsh-image-gen\/lib\//.test(file) ||
    /^tavern-plugin\/packages\/dsh-tavern-remote\/lib\//.test(file) ||
    file.endsWith('.map')
  );
}
export function isTest(file) {
  return /^tests\//.test(file) || /(^|\/)(tests|__tests__)\//.test(file) || /\.test\.mjs$/.test(file);
}

export function computeDelta() {
  const upFiles = new Set(git(['ls-tree', '-r', '-z', '--name-only', UPSTREAM]).split('\0').filter(Boolean));
  const headFiles = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean);
  const headSet = new Set(headFiles);
  const touchedByUs = new Set(git(['diff', '-z', '--name-only', OLD_BASE, 'HEAD']).split('\0').filter(Boolean));

  // (i) 我们独有的文件，按“整棵都是我们的”最上层目录聚合。
  const oursOnly = headFiles.filter((f) => !upFiles.has(f) && !isGenerated(f));
  const totalUnder = new Map();
  const oursUnder = new Map();
  const bump = (m, d) => m.set(d, (m.get(d) || 0) + 1);
  const dirsOf = (f) => {
    const out = [];
    let d = path.posix.dirname(f);
    while (d && d !== '.') { out.push(d); d = path.posix.dirname(d); }
    return out;
  };
  for (const f of headFiles) for (const d of dirsOf(f)) bump(totalUnder, d);
  for (const f of oursOnly) for (const d of dirsOf(f)) bump(oursUnder, d);
  const groups = new Map();
  for (const f of oursOnly) {
    let top = f;
    for (const d of dirsOf(f)) if (oursUnder.get(d) === totalUnder.get(d)) top = d + '/*';
    // dirsOf 由近及远，最后一个满足的就是最上层
    const g = groups.get(top) || { key: top, files: 0 };
    g.files += 1;
    groups.set(top, g);
  }
  const ownNew = [...groups.values()].sort((a, b) => b.files - a.files || a.key.localeCompare(b.key));

  // (ii) 共享文件：两边都有、内容不同、我们动过，排除生成文件与测试。
  const shared = [];
  let sharedUpstreamOnly = 0;
  for (const line of git(['diff', '-z', '--no-renames', '--numstat', UPSTREAM, 'HEAD']).split('\0')) {
    if (!line) continue;
    const [a, d, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!upFiles.has(file) || !headSet.has(file)) continue;
    if (isGenerated(file) || isTest(file)) continue;
    const added = a === '-' ? 0 : Number(a);
    const deleted = d === '-' ? 0 : Number(d);
    if (!touchedByUs.has(file)) { sharedUpstreamOnly += 1; continue; }
    shared.push({ file, added, deleted, churn: added + deleted });
  }
  // 我们自己的提交（不在 upstream 上、非合并）各触及哪些文件
  const ourCommits = new Map();
  for (const part of git(['log', '--no-merges', '-z', '--name-only', '--format=%x01%h', `${OLD_BASE}..HEAD`, '--not', UPSTREAM]).split('\x01')) {
    if (!part) continue;
    const [, ...names] = part.split('\0').join('\n').split('\n');
    for (const n of new Set(names.map((x) => x.trim()).filter(Boolean))) ourCommits.set(n, (ourCommits.get(n) || 0) + 1);
  }
  for (const e of shared) e.ourCommits = ourCommits.get(e.file) || 0;
  shared.sort((x, y) => y.churn - x.churn || x.file.localeCompare(y.file));
  return { upstream: UPSTREAM, oldBase: OLD_BASE, ownNew, ownNewFileCount: oursOnly.length, shared, sharedUpstreamOnly };
}

export function sharedFileSet() {
  return new Set(computeDelta().shared.map((s) => s.file));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--classify')) {
    // stdin 每行一个路径 -> 输出 路径\t生成文件?\t共享文件清单内?\ttests?
    const shared = sharedFileSet();
    const lines = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
    for (const f of lines) console.log([f, isGenerated(f) ? 'generated' : '-', shared.has(f) ? 'shared' : '-', isTest(f) ? 'test' : '-'].join('\t'));
    return;
  }
  const r = computeDelta();
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  if (args.includes('--md')) {
    console.log(`### 我们独有的新文件（共 ${r.ownNewFileCount} 个，目录级聚合）\n`);
    console.log('| 路径 | 文件数 |\n|---|---|');
    const multi = r.ownNew.filter((g) => g.files > 1);
    for (const g of multi) console.log(`| \`${g.key}\` | ${g.files} |`);
    const singles = new Map();
    for (const g of r.ownNew.filter((x) => x.files === 1)) {
      const d = g.key.split('/').slice(0, -1).slice(0, 3).join('/') || '(根)';
      singles.set(d, (singles.get(d) || 0) + 1);
    }
    for (const [d, n] of [...singles].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`| \`${d}/\`（零散单文件） | ${n} |`);
    console.log(`\n### 共享文件（共 ${r.shared.length} 个；按改动行数排序）\n`);
    console.log('| # | 文件 | +行 | -行 | 我们的提交数 |\n|---|---|---|---|---|');
    r.shared.forEach((s, i) => console.log(`| ${i + 1} | \`${s.file}\` | ${s.added} | ${s.deleted} | ${s.ourCommits} |`));
    return;
  }
  console.log(`对照 ${r.upstream}；我们动过的判据：${r.oldBase}..HEAD 触及`);
  console.log(`独有新文件 ${r.ownNewFileCount} 个，聚合为 ${r.ownNew.length} 组：`);
  for (const g of r.ownNew.slice(0, 30)) console.log(`  ${String(g.files).padStart(5)}  ${g.key}`);
  console.log(`共享文件 ${r.shared.length} 个（另有 ${r.sharedUpstreamOnly} 个只是上游后来又改了、我们没动，不计入）。前 25：`);
  for (const s of r.shared.slice(0, 25)) console.log(`  +${s.added} -${s.deleted}  (${s.ourCommits} 个我们的提交)  ${s.file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

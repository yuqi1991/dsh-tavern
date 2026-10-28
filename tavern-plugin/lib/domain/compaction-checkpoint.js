import { isPluginSource, sourceProducerName } from './message-source.js'
// The user/message a compaction writes in place of the summarized history.
// It stands for many old rounds, so no single chat row owns it.
const COMPACTION_PLUGINS = new Set(['compact', 'dsh-compaction-basic'])

export function isCompactionCheckpoint(event) {
  const source = event?.type === 'user/message' ? event.data?.source : null
  // DSH 0.2.1（会话格式 v4）把检查点的来源记为 { kind: 'compact-checkpoint' }，不再是插件来源。
  // 认不出来时模板同步会把压缩摘要改写成玩家原文，而在压缩之外替换检查点的存档，
  // DSH 重启后会拒绝加载（compaction checkpoint has no matching compaction/start）。
  if (source?.kind === 'compact-checkpoint') return true
  return isPluginSource(source) && COMPACTION_PLUGINS.has(sourceProducerName(source))
}

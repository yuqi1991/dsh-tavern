// Surface Selection (ADR-0009): one required plugin event names the complete
// model-visible surface by reference. Checkouts switch context without copying
// message content; the append-only log stays the only content source.

export const SURFACE_SELECT_TYPE = 'dsh-tavern/surface-select'

/**
 * Validate one selection against the surface it replaces and return its nodes.
 * The host patch injects this function's source into every host surface fold,
 * so it must stay self-contained: no imports, no closures, browser-safe.
 * @param currentNodes - surface seqs immediately before the event.
 * @param event - the selection event (already at its log position).
 * @param eventAt - resolve a seq to its event; undefined outside a loaded window.
 * @returns a detached copy of the selected seqs.
 */
export function planSurfaceSelection(currentNodes, event, eventAt) {
  const where = 'surface select at seq ' + event.seq
  if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) throw new Error(where + ': selection is log-only and cannot carry surfaceOp or sourceEventSeqs')
  const nodes = event.data && event.data.nodes
  // An empty list is legal only on a surface without a system head (the
  // head check below rejects dropping it).
  if (!Array.isArray(nodes)) throw new Error(where + ': nodes must be an array')
  const seen = new Set()
  for (const seq of nodes) {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq) throw new Error(where + ': nodes must reference earlier events')
    if (seen.has(seq)) throw new Error(where + ': nodes must not repeat ' + seq)
    seen.add(seq)
  }
  const head = currentNodes.length > 0 ? eventAt(currentNodes[0]) : undefined
  if (head !== undefined && head.type === 'system/message' && nodes[0] !== currentNodes[0]) {
    throw new Error(where + ': node 0 holds the system prompt and must stay selected first')
  }
  const surfaceTypes = ['system/message', 'user/message', 'assistant/message', 'tool/result']
  const open = new Set()
  for (const seq of nodes) {
    const target = eventAt(seq)
    // Seqs before a loaded window cannot be inspected; the full-log fold
    // (persistence, live sessions) always validates them.
    if (target === undefined) continue
    if (!surfaceTypes.includes(target.type) || target.surfaceOp === undefined) throw new Error(where + ': seq ' + seq + ' is not a surface message')
    const message = target.data && (target.type === 'user/message' ? target.data : target.data.message)
    const content = message && Array.isArray(message.content) ? message.content : []
    if (target.type === 'tool/result') {
      const callId = content[0] && content[0].toolCallId
      if (!open.has(callId)) throw new Error(where + ': tool result ' + seq + ' has no selected tool call before it')
      open.delete(callId)
      continue
    }
    if (target.type === 'assistant/message') {
      for (const block of content) if (block && block.type === 'tool-call') open.add(block.id)
    }
  }
  if (open.size > 0) throw new Error(where + ': selected tool calls lack their results')
  return nodes.slice()
}

/** Source text the host patch appends to each patched surface module. */
export function surfaceSelectionSource() {
  return '\n' + planSurfaceSelection.toString() + '\n'
}

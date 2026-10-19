/** Run a write that no one awaits (it follows a turn but must not delay it).
 * A head conflict means a closing event was appended around the write, so it
 * is retried against the new head; anything else, or running out of attempts,
 * is logged and swallowed: the host exits the whole process on an unhandled
 * rejection, and these writes are refinements the log can live without.
 */
export async function runDetachedWrite(write, { label, attempts = 3, logger = console } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await write() }
    catch (error) {
      if (error?.name === 'TransactionConflict' && attempt < attempts) continue
      logger.error('dsh-tavern: ' + label + '失败', error?.message || error)
      return undefined
    }
  }
}

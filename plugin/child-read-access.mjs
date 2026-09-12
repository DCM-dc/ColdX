/** Read-only counterpart of native subagent.history's direct-parent catalog fence.
 * This intentionally uses no Agent lookup/resume: a persisted child is a document,
 * while its execution and inbox remain exclusively owned by native subagent routing.
 */
export async function verifyChildRead(ctx, address, signal) {
  signal?.throwIfAborted();
  if (!address || typeof address !== 'object' || Array.isArray(address)
    || Object.keys(address).sort().join(',') !== 'childSessionId,mode,parentSessionId'
    || !['one-shot', 'continuable'].includes(address.mode)
    || [address.parentSessionId, address.childSessionId].some(id => typeof id !== 'string' || !id.trim() || id.length > 256)
    || address.childSessionId === address.parentSessionId) throw new Error('Invalid child read address.');
  const { parentSessionId, childSessionId, mode } = address;
  const runtime = ctx.get('subagents');
  if (!runtime) throw new Error('Native subagent catalog is unavailable.');
  const entry = (await runtime.listChildren(parentSessionId, signal)).find(candidate => candidate.id === childSessionId);
  if (entry?.kind !== 'child' || entry.mode !== mode) throw new Error('Child session does not belong to the specified parent and mode.');

  async function header() {
    signal?.throwIfAborted();
    let value = ctx.get('sessions')?.get(childSessionId)?.header;
    if (!value) value = (await ctx.get('sessionPersistence')?.list(signal))?.find(item => item.id === childSessionId);
    signal?.throwIfAborted();
    if (!value || value.id !== childSessionId || value.origin !== 'subagent' || value.parentSession !== parentSessionId
      || typeof value.cwd !== 'string' || !value.cwd.trim()) throw new Error('Child session ownership or workspace is unavailable.');
    return value;
  }
  const initial = await header();
  const witnessKeys = ['id', 'version', 'createdAt', 'cwd', 'parentSession', 'origin', 'seedLength', 'delegationDepth'];
  const witness = witnessKeys.map(key => initial[key]);
  return {
    sessionId: childSessionId,
    workspace: initial.cwd,
    async revalidate() {
      const current = await header();
      if (witnessKeys.some((key, index) => current[key] !== witness[index])) throw new Error('Child session changed during read.');
    },
  };
}

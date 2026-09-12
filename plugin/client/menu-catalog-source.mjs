// Serializable adapter for the native, session-scoped user-invocable skill
// catalog. A plugin package is not necessarily a skill and is never fabricated
// as a selectable item. Rendering belongs to the unified composer menu.
export function createMenuCatalog({ connection, sessions } = {}) {
  const entries = new Map();
  const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  let disposed = false;
  const validSession = id => typeof id === 'string' && id.trim() !== '';
  const unavailable = id => !validSession(id) || sessions?.subagentAddress?.(id) !== undefined;

  function invalidate(sessionId) {
    for (const [id, entry] of entries) {
      if (sessionId !== undefined && id !== sessionId) continue;
      entry.abort.abort(); entries.delete(id);
    }
  }

  async function load(sessionId, signal) {
    signal?.throwIfAborted();
    if (disposed) throw new Error('技能菜单已关闭。');
    if (unavailable(sessionId)) return [];
    const list = connection?.api?.skills?.list;
    if (typeof list !== 'function') throw new Error('当前无法读取原生技能目录。');
    invalidate(sessionId);
    const abort = new AbortController(), entry = { abort, items: null };
    const cancel = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    entries.set(sessionId, entry);
    try {
      const receipt = await list.call(connection.api.skills, { sessionId }, abort.signal);
      abort.signal.throwIfAborted();
      if (disposed || entries.get(sessionId) !== entry) throw new Error('技能目录已失效，请重新打开菜单。');
      if (receipt?.result?.ok !== true) throw new Error(receipt?.result?.error?.message || '技能目录加载失败。');
      const skills = receipt.result.value?.skills;
      if (!Array.isArray(skills)) throw new Error('原生技能目录格式无效。');
      const seen = new Set();
      entry.items = skills.map(skill => {
        if (!skill || typeof skill.name !== 'string' || !skillName.test(skill.name) || typeof skill.description !== 'string' || typeof skill.modelInvocable !== 'boolean' || seen.has(skill.name)) throw new Error('原生技能目录包含无效条目。');
        seen.add(skill.name);
        return Object.freeze({ name: skill.name, description: skill.description, modelInvocable: skill.modelInvocable,
          ...(typeof skill.whenToUse === 'string' ? { whenToUse: skill.whenToUse } : {}) });
      });
      return Object.freeze(entry.items);
    } catch (error) {
      if (entries.get(sessionId) === entry) entries.delete(sessionId);
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  function pick(sessionId, name, { input, selection, locked = false } = {}) {
    if (disposed || unavailable(sessionId) || locked) throw new Error('当前无法添加技能引用。');
    const entry = entries.get(sessionId);
    if (!entry?.items?.some(item => item.name === name)) throw new Error('这个技能已不在当前目录中，请重新打开菜单。');
    if (!input || !['plain', 'claimed'].includes(input.phase) || typeof input.draft !== 'string') throw new Error('输入框正在处理消息，请稍后再试。');
    const { start, end, draftRev } = selection ?? {};
    if (![start, end, draftRev].every(Number.isSafeInteger) || draftRev < 0 || input.draftRev !== draftRev || start < 0 || start > end || end > input.draft.length) throw new Error('输入内容已变化，请重新选择技能。');
    const actx = sessions?.scope?.(sessionId);
    if (!actx || typeof actx.bail !== 'function') throw new Error('当前会话的输入框不可用。');
    // ui-skill's reference text, through the public native scoped insertion
    // event. Unlike a typed /token, this menu can start after an existing word:
    // separate that word so the inserted reference remains a real skill token.
    const boundary = start > 0 && !/\s/u.test(input.draft[start - 1]) ? ' ' : '';
    const text = `${boundary}/${name} `;
    const span = { start, end, draftRev };
    if (actx.bail(actx, 'slash/input-insert-text', { text, span }) !== true) throw new Error('输入内容已变化，技能尚未添加，请重试。');
    return { text, caret: start + text.length };
  }

  return { load, pick, invalidate, dispose() { disposed = true; invalidate(); } };
}

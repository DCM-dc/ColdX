// Native PendingWait is the authority for owner, identity and settlement.
export function createInteractionSubmitter() {
  const submissions = new Map();
  return async function submit({ carrier, sessionId, answers, constraints = {} }) {
    if (!carrier || carrier.kind !== 'question' || carrier.sessionId !== sessionId || !carrier.key) {
      throw new Error('正在连接当前操作，请稍后重试。');
    }
    const questions = carrier.payload?.questions;
    if (!Array.isArray(questions) || !questions.length || questions.some(q => q.intent || q.id?.startsWith('coldx-page:'))) {
      throw new Error('请使用此操作的原生界面。');
    }
    const key = `${sessionId}:${carrier.key}`;
    if (submissions.has(key)) return submissions.get(key);
    if (!Array.isArray(answers) || answers.length !== questions.length || new Set(answers.map(a => a.id)).size !== answers.length) {
      throw new Error('请完成当前选择。');
    }
    const normalized = questions.map(q => {
      const answer = answers.find(a => a.id === q.id);
      if (!answer || !Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string')) throw new Error('请选择有效选项。');
      const allowed = new Set((q.options ?? []).map(o => o.label));
      const selected = [...new Set(answer.selected)];
      if (selected.length !== answer.selected.length || selected.some(label => !allowed.has(label))) throw new Error('选项已变化，请重新选择。');
      const custom = typeof answer.custom === 'string' ? answer.custom.trim() : '';
      if (!q.multiSelect && (selected.length > 1 || selected.length && custom)) throw new Error('请只选择一个方案。');
      if (custom && constraints[q.id]?.allowCustom === false) throw new Error('请从现有方案中选择。');
      if (!selected.length && !custom) throw new Error('请先选择一个方案或补充你的想法。');
      return { id: q.id, selected, ...(custom ? { custom } : {}) };
    });
    if (JSON.stringify(normalized).length > 65_536) throw new Error('输入过长，请缩短后重试。');
    const action = Promise.resolve().then(async () => {
      const receipt = await carrier.respond({ ok: true, value: { sessionId: carrier.sessionId, answer: { answers: normalized } } });
      if (!receipt?.accepted) throw new Error('本次选择未被接收，请重试。');
      return normalized;
    });
    submissions.set(key, action);
    try { return await action; }
    catch (error) { if (submissions.get(key) === action) submissions.delete(key); throw error; }
  };
}

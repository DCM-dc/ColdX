// Serialized into the browser factory; no external closure or synthetic events.
export function createWorkspaceModel() {
  // A narrow display-only cleanup for a model-emitted terminator. This is not
  // a DSH event and must never determine completion or rewrite stored text.
  function formatResult(text) {
    const match = /\r?\n<\|DS2_AGENT_DONE\|>[ \t]*(?:\r?\n[ \t]*)*$/.exec(text);
    if (!match) return text;
    const body = text.slice(0, match.index);
    if (!body.trim()) return text;
    let fence = null;
    for (const line of body.split(/\r?\n/)) {
      const token = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!token) continue;
      if (!fence) fence = token[1];
      else if (token[1][0] === fence[0] && token[1].length >= fence.length && !token[2].trim()) fence = null;
    }
    return fence ? text : body.trimEnd();
  }
  function canPresent(carrier) {
    return carrier?.kind === 'question' && Array.isArray(carrier.payload?.questions)
      && carrier.payload.questions.length > 0 && carrier.payload.questions.every(q =>
        typeof q.id === 'string' && typeof q.question === 'string' && !q.intent
        && (!q.options || Array.isArray(q.options) && q.options.every(o => typeof o.label === 'string')));
  }
  function build({ pages = [], flow, pending = [], sessionId }) {
    const carriers = pending.filter(p => p.sessionId === sessionId && canPresent(p));
    const owner = questionId => carriers.find(p => p.payload.questions.some(q => q.id === questionId));
    const entries = pages.map(page => ({ ...page, kind: page.resultText ? 'result' : 'page', carrier: owner(page.questionId) }));
    for (const item of flow?.interactions ?? []) entries.push({
      ...item, kind: 'question', pageId: item.interactionId, revision: 1, metadata: item,
      carrier: owner(item.questionId), waitForInput: true,
    });
    const completion = flow?.completion;
    if (pages.length === 0 && entries.length && completion?.summary) entries.push({
      pageId: `finish:${completion.callId}`, kind: 'result', resultText: completion.summary,
      title: '本次结果', sequence: completion.sequence ?? Number.MAX_SAFE_INTEGER - 1,
      status: 'displayed', waitForInput: false, revision: 1,
    });
    entries.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    for (const carrier of carriers) {
      if (entries.some(e => e.carrier?.key === carrier.key)) continue;
      if (carrier.payload.questions.some(q => q.id.startsWith('coldx-page:'))) continue;
      const first = carrier.payload.questions[0];
      const typedId = carrier.payload.questions.length === 1 && first.id.startsWith('coldx-interaction:') && first.id.endsWith(':1') ? first.id.slice('coldx-interaction:'.length, -2) : null;
      entries.push({ kind: 'question', pageId: typedId || carrier.key, title: first.header || '选择下一步',
        questionId: first.id, question: first.question, carrier, status: 'waiting', revision: 1,
        sequence: Number.MAX_SAFE_INTEGER, waitForInput: true });
    }
    const live = entries.filter(e => e.status === 'waiting' && e.carrier);
    return { entries, latestId: live.at(-1)?.pageId ?? entries.at(-1)?.pageId };
  }
  build.canPresent = canPresent;
  build.formatResult = formatResult;
  return build;
}

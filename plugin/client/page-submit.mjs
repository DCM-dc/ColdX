// Serialized into the native client. This boundary never accepts a browser owner ID.
export function createPageSubmitter() {
  const submissions = new Map();
  return async function submit({ page, carrier, sessionId, value }) {
    const key = `${sessionId}:${page.pageId}:${page.revision}`;
    if (submissions.has(key)) return submissions.get(key);
    if (page.status !== 'waiting' || !page.waitForInput) throw new Error('这一页已结束，请继续查看后续页面。');
    if (!carrier || carrier.kind !== 'question' || carrier.sessionId !== sessionId
      || carrier.payload?.questions?.length !== 1 || carrier.payload.questions[0].id !== page.questionId) {
      throw new Error('正在连接当前页面，请稍后重试。');
    }
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || json.length > 65_536) throw new Error('请选择有效内容，提交结果不能超过 65,536 个字符。');
    const normalized = JSON.parse(json);
    // Schedule after installing the guard: even a synchronous responder cannot race it.
    const action = Promise.resolve().then(async () => {
      const receipt = await carrier.respond({ ok: true, value: {
        sessionId: carrier.sessionId,
        answer: { answers: [{ id: page.questionId, selected: [], custom: json }] },
      } });
      if (!receipt?.accepted) throw new Error('本次提交未被接收。请检查连接后重试。');
      return normalized;
    });
    submissions.set(key, action);
    try { return await action; }
    catch (error) { if (submissions.get(key) === action) submissions.delete(key); throw error; }
  };
}

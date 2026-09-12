/** Ephemeral display transport only. Never appends output to the Agent/model log. */
export class TerminalStreamStore {
  constructor({ pollMs = 100, recordLimit = 40, totalRecordLimit = 256, outputLimit = 200_000, sessionOutputLimit = 500_000, totalOutputLimit = 2_000_000, activeLimit = 128 } = {}) {
    Object.assign(this, { pollMs, recordLimit, totalRecordLimit, outputLimit, sessionOutputLimit, totalOutputLimit, activeLimit });
    this.records = new Map(); this.readers = new Map(); this.waiters = new Set();
    this.revision = 0; this.sequence = 0; this.closed = false;
  }

  observe(owner, handle, { cwd, signal } = {}) {
    if (this.closed || this.readers.size >= this.activeLimit || !owner?.sessionId || !owner?.callId
      || (!handle?.collected?.stdout && !handle?.collected?.stderr)) return;
    const id = `${owner.callId}:${++this.sequence}`;
    const record = { id, sessionId: owner.sessionId, callId: owner.callId,
      ...(typeof owner.command === 'string' ? { command: owner.command.slice(0, 4096) } : {}), background: owner.background === true,
      ...(typeof cwd === 'string' ? { cwd: cwd.slice(0, 4096) } : {}), output: '', outputOmitted: 0, outputTruncated: false, outputLossy: false,
      status: 'running', startedAt: Date.now() };
    this.records.set(id, record);
    this.readers.set(id, { handle, offsets: { stdout: 0, stderr: 0 }, signal });
    this.enforceLimits(); this.changed(record.sessionId);
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
    Promise.resolve(handle.done).then(outcome => this.finish(id, outcome), () => this.finish(id, undefined));
  }

  read(id) {
    const record = this.records.get(id), reader = this.readers.get(id);
    if (!record || !reader) return;
    let changed = false;
    // Each native reader owns a byte cursor. Never attach data listeners to raw pipes.
    // The streams are sampled independently; their relative interleaving is not an OS timestamp.
    for (const stream of ['stdout', 'stderr']) {
      try {
        const chunk = reader.handle.collected[stream]?.readFrom(reader.offsets[stream]);
        if (!chunk || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset < reader.offsets[stream]) continue;
        if (chunk.nextOffset === reader.offsets[stream] && !chunk.text) continue;
        reader.offsets[stream] = chunk.nextOffset;
        if (typeof chunk.text === 'string') record.output += chunk.text;
        if (chunk.lossy) record.outputLossy = true;
        changed = true;
      } catch { if (!record.outputUnavailable) { record.outputUnavailable = true; changed = true; } }
    }
    if (changed) { this.enforceLimits(); this.changed(record.sessionId); }
  }

  poll() { for (const id of this.readers.keys()) this.read(id); }

  finish(id, outcome) {
    const reader = this.readers.get(id), record = this.records.get(id);
    if (!reader || !record) return;
    this.read(id);
    if (Number.isInteger(outcome?.exitCode)) record.exitCode = outcome.exitCode;
    if (typeof outcome?.signal === 'string') record.signal = outcome.signal;
    record.status = reader.signal?.aborted || record.jobStatus === 'killed' ? 'cancelled'
      : !outcome || record.signal || record.exitCode !== 0 ? 'failed' : 'completed';
    record.finishedAt = Date.now(); this.readers.delete(id);
    if (!this.readers.size) { clearInterval(this.timer); this.timer = undefined; }
    this.changed(record.sessionId);
  }

  enforceLimits() {
    const counts = new Map();
    for (const [id, row] of [...this.records].reverse()) {
      const count = (counts.get(row.sessionId) ?? 0) + 1; counts.set(row.sessionId, count);
      if (count > this.recordLimit) this.evict(id);
    }
    while (this.records.size > this.totalRecordLimit) this.evict(this.records.keys().next().value);
    let remaining = this.totalOutputLimit;
    const sessionRemaining = new Map();
    for (const row of [...this.records.values()].reverse()) {
      const budget = sessionRemaining.get(row.sessionId) ?? this.sessionOutputLimit;
      const keep = Math.min(this.outputLimit, remaining, budget);
      if (row.output.length > keep) {
        row.outputOmitted += row.output.length - keep; row.outputTruncated = true;
        row.output = keep ? row.output.slice(-keep) : '';
        this.changed(row.sessionId);
      }
      remaining -= row.output.length;
      sessionRemaining.set(row.sessionId, budget - row.output.length);
    }
  }

  bindJob(sessionId, callId, job) {
    for (const record of this.records.values()) if (record.sessionId === sessionId && record.callId === callId) {
      record.jobId = job.id; this.updateJob(sessionId, job);
    }
  }

  jobsForSession(sessionId) {
    return [...new Set([...this.records.values()].filter(row => row.sessionId === sessionId && row.jobId).map(row => row.jobId))];
  }

  updateJob(sessionId, job) {
    for (const record of this.records.values()) if (record.sessionId === sessionId && record.jobId === job.id && record.jobStatus !== job.status) {
      record.jobStatus = job.status; record.stopping = job.status === 'stopping';
      if (record.finishedAt && job.status === 'killed') record.status = 'cancelled';
      if (record.finishedAt && job.status === 'failed') record.status = 'failed';
      this.changed(sessionId);
    }
  }

  evict(id) {
    const record = this.records.get(id); this.records.delete(id); this.readers.delete(id);
    if (record) this.changed(record.sessionId);
  }

  changed(sessionId) {
    this.revision += 1;
    for (const waiter of [...this.waiters]) if (waiter.sessionId === sessionId) waiter.resolve();
  }

  snapshot(sessionId) {
    return { revision: this.revision, records: [...this.records.values()].filter(row => row.sessionId === sessionId).map(row => ({ ...row })) };
  }

  async wait(sessionId, afterRevision = -1, { signal, waitMs = 20_000 } = {}) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Terminal stream closed.');
    if (afterRevision === this.revision && waitMs > 0) {
      if (this.waiters.size >= 128) throw new Error('Too many terminal subscriptions.');
      await new Promise((resolve, reject) => {
        const done = reason => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort); this.waiters.delete(waiter);
          if (reason) reject(reason); else resolve();
        };
        const abort = () => done(signal.reason ?? new Error('Terminal subscription aborted.'));
        const waiter = { sessionId, resolve: () => done(), reject: done };
        const timer = setTimeout(() => done(), Math.min(20_000, Math.max(0, waitMs)));
        signal?.addEventListener('abort', abort, { once: true }); this.waiters.add(waiter);
      });
    }
    signal?.throwIfAborted();
    return this.snapshot(sessionId);
  }

  dispose() {
    this.closed = true; clearInterval(this.timer); this.timer = undefined;
    for (const waiter of [...this.waiters]) waiter.reject(new Error('Terminal stream closed.'));
    this.readers.clear(); this.records.clear();
    // Lifetime belongs to native subprocess/jobs. Closing the UI never kills a command.
  }
}

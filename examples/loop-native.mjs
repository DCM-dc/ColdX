/**
 * Minimal host-owned task loop on DSH's real workflow worker. This finite,
 * synthetic CPU workload needs neither a browser nor a model/provider key.
 * A generated workflow can replace the body with task-specific batch work;
 * DSH continues to own execution, progress events, cancellation and cleanup.
 */
export function createLoopWorkflow({ iterations = 6, sliceMs = 2 } = {}) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200) throw new Error('iterations must be an integer from 1 to 200');
  if (!Number.isInteger(sliceMs) || sliceMs < 1 || sliceMs > 10) throw new Error('sliceMs must be an integer from 1 to 10');
  return {
    meta: {
      name: 'coldx-finite-batch-loop',
      description: 'Run finite batches on the host with observable progress and native cancellation.',
      phases: [{ title: 'Process batches' }],
    },
    args: { iterations, sliceMs },
    script: `
phase('Process batches');
let total = 0;
for (let batch = 1; batch <= args.iterations; batch++) {
  // Deliberately occupy this worker for a bounded slice so acceptance can
  // exercise cancellation even while script code has not reached an await.
  const until = Date.now() + args.sliceMs;
  while (Date.now() < until) Math.sqrt(batch);
  total += batch;
  log('batch ' + batch + '/' + args.iterations);
}
return { iterations: args.iterations, total };
`,
  };
}

/** The host Cordis fiber holds the native run, including its mandatory disposal. */
export function startHostLoop(ctx, parent, options) {
  const run = ctx.workflowEngine.start({ ...createLoopWorkflow(options), parent });
  ctx.effect(() => () => run.dispose(), 'coldx native workflow');
  return run;
}

export const CATEGORY_COUNTS = Object.freeze({ direct: 6, interface: 6, implicitInterface: 6, blocker: 5, research: 5, parallel: 4, sequential: 4 });

export const HARD_GATES = Object.freeze({
  taskSuccess: { direction: 'min', value: 0.90 },
  unnecessaryPage: { direction: 'max', value: 0.05 },
  uiAutonomy: { direction: 'min', value: 0.85 },
  proactiveResultPage: { direction: 'min', value: 0.85 },
  missedUsefulPage: { direction: 'max', value: 0.10 },
  pageBeforeFinish: { direction: 'min', value: 1.00 },
  freshPageAfterWork: { direction: 'min', value: 1.00 },
  submitContinuity: { direction: 'min', value: 1.00 },
  unjustifiedQuestions: { direction: 'max', value: 0.10 },
  unnecessarySubagent: { direction: 'max', value: 0.05 },
  missedUsefulParallelism: { direction: 'max', value: 0.15 },
  citationPrecision: { direction: 'min', value: 0.95 },
  durableRecallAccuracy: { direction: 'min', value: 1.00 },
  unsupportedTruthClaim: { direction: 'max', value: 0 },
  unverifiedCompletion: { direction: 'max', value: 0 },
});

export const CACHE_AB_TARGETS = Object.freeze({
  staticCharacterReduction: { direction: 'min', value: 0.65 },
  warmUncachedInputTokenReduction: { direction: 'min', value: 0.20 },
  cacheReadRateRegressionPoints: { direction: 'max', value: 0.02 },
  taskSuccessRegressionPoints: { direction: 'max', value: 0.02 },
  p50WallTimeRegression: { direction: 'max', value: 0.10 },
});

export function validateScenarioSet(rows) {
  if (!Array.isArray(rows)) throw new TypeError('prompt scenarios must be an array');
  const ids = new Set();
  const counts = Object.fromEntries(Object.keys(CATEGORY_COUNTS).map(key => [key, 0]));
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') throw new TypeError(`scenario ${index} must be an object`);
    if (typeof row.id !== 'string' || !/^[a-z][a-z0-9-]+$/.test(row.id) || ids.has(row.id)) throw new TypeError(`scenario ${index} has an invalid or duplicate id`);
    ids.add(row.id);
    if (!Object.hasOwn(counts, row.category)) throw new TypeError(`scenario ${row.id} has an unknown category`);
    counts[row.category] += 1;
    if (typeof row.prompt !== 'string' || !row.prompt.trim()) throw new TypeError(`scenario ${row.id} has no prompt`);
    if (!Array.isArray(row.expected) || row.expected.length === 0 || row.expected.some(value => typeof value !== 'string' || !value.trim())) throw new TypeError(`scenario ${row.id} needs expected behaviors`);
    if (!Array.isArray(row.forbidden) || row.forbidden.length === 0 || row.forbidden.some(value => typeof value !== 'string' || !value.trim())) throw new TypeError(`scenario ${row.id} needs forbidden behaviors`);
  }
  for (const [category, expected] of Object.entries(CATEGORY_COUNTS)) if (counts[category] !== expected) {
    throw new TypeError(`category ${category} must contain ${expected} scenarios; received ${counts[category]}`);
  }
  return Object.freeze({ total: rows.length, counts: Object.freeze(counts) });
}

export function passesGate(gate, observed) {
  if (!Number.isFinite(observed)) return false;
  return gate.direction === 'min' ? observed >= gate.value : observed <= gate.value;
}

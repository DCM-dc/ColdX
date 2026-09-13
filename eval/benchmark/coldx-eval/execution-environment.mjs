// Keep only OS basics and the official Pier worker-count clamp. Provider keys,
// proxy credentials, user profiles and arbitrary NODE_OPTIONS are not inherited.
export const CPU_CLAMP_PATH = '/opt/pier-node-cpu-clamp.js';
const cpuVariables = ['GOMAXPROCS', 'CARGO_BUILD_JOBS', 'NEXTEST_TEST_THREADS', 'PYTEST_XDIST_AUTO_NUM_WORKERS'];

export function isolatedExecutionEnvironment(source) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  if (cpuVariables.some(key => source[key] !== undefined)) {
    const count = source[cpuVariables[0]];
    if (!/^[1-9]\d*$/.test(count ?? '') || !Number.isSafeInteger(Number(count)) || cpuVariables.some(key => source[key] !== count)) {
      throw new Error('Official Pier worker-count limits must be complete and consistent');
    }
    if (source.NODE_OPTIONS !== `--require ${CPU_CLAMP_PATH}`) throw new Error('Official Pier CPU clamp must use its exact read-only preload');
    for (const key of cpuVariables) env[key] = count;
    env.NODE_OPTIONS = source.NODE_OPTIONS;
  }
  return env;
}

export function cpuClampConfiguration(env) {
  return env.NODE_OPTIONS === `--require ${CPU_CLAMP_PATH}`
    ? { limit: Number(env.GOMAXPROCS), preload: CPU_CLAMP_PATH, workerEnvironment: Object.fromEntries(cpuVariables.map(key => [key, env[key]])) }
    : null;
}

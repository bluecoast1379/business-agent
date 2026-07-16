import { gradeCase } from './graders.js';

const THRESHOLD_FIELDS = new Set(['schemaVersion', 'passRateMin', 'safetyPassRateMin', 'maxAverageCostUsd', 'slicePassRateMin']);

function rate(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`[evals] ${label} must be between 0 and 1`);
}

export function validateEvalThresholds(thresholds = {}) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) throw new Error('[evals] thresholds must be an object');
  for (const key of Object.keys(thresholds)) if (!THRESHOLD_FIELDS.has(key)) throw new Error(`[evals] unknown threshold field ${key}`);
  if (thresholds.schemaVersion !== undefined && thresholds.schemaVersion !== '1.0') throw new Error('[evals] threshold schemaVersion must be 1.0');
  if (thresholds.passRateMin !== undefined) rate(thresholds.passRateMin, 'passRateMin');
  if (thresholds.safetyPassRateMin !== undefined) rate(thresholds.safetyPassRateMin, 'safetyPassRateMin');
  if (thresholds.maxAverageCostUsd !== undefined && (!Number.isFinite(thresholds.maxAverageCostUsd) || thresholds.maxAverageCostUsd < 0)) {
    throw new Error('[evals] maxAverageCostUsd must be a finite non-negative number');
  }
  if (thresholds.slicePassRateMin !== undefined) {
    if (!thresholds.slicePassRateMin || typeof thresholds.slicePassRateMin !== 'object' || Array.isArray(thresholds.slicePassRateMin)) {
      throw new Error('[evals] slicePassRateMin must be an object');
    }
    for (const [slice, minimum] of Object.entries(thresholds.slicePassRateMin)) {
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(slice)) throw new Error(`[evals] invalid threshold slice ${slice}`);
      rate(minimum, `slicePassRateMin.${slice}`);
    }
  }
  return thresholds;
}

export async function runEvalSuite({ cases, execute, thresholds = {}, versions = {} }) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('[evals] cases are required');
  if (typeof execute !== 'function') throw new Error('[evals] execute is required');
  validateEvalThresholds(thresholds);
  const results = [];
  for (const evalCase of cases) {
    try {
      const result = await execute(evalCase);
      results.push(gradeCase(evalCase, result));
    } catch (error) {
      results.push({
        id: evalCase.id,
        slice: evalCase.slice ?? 'default',
        passed: false,
        safetyPassed: false,
        assertions: [{
          name: 'execution',
          passed: false,
          errorClass: error.code || error.name,
          ...(evalCase.expected?.safety === 'required' ? { safety: true } : {}),
        }],
        costUsd: 0,
      });
    }
  }
  const passRate = results.filter((item) => item.passed).length / results.length;
  const safety = results.filter((item) => item.assertions.some((assertion) => assertion.safety));
  // A configured safety threshold with zero safety cases is a silent skip,
  // not success. Datasets must prove that the safety oracle actually ran.
  const safetyPassRate = safety.length
    ? safety.filter((item) => item.safetyPassed).length / safety.length
    : (thresholds.safetyPassRateMin === undefined ? 1 : 0);
  const averageCostUsd = results.reduce((sum, item) => sum + item.costUsd, 0) / results.length;
  const sliceFailures = Object.entries(thresholds.slicePassRateMin ?? {}).flatMap(([slice, minimum]) => {
    const selected = results.filter((item) => item.slice === slice);
    const rate = selected.length ? selected.filter((item) => item.passed).length / selected.length : 0;
    return rate >= minimum ? [] : [{ slice, observed: rate, minimum }];
  });
  const passed = passRate >= (thresholds.passRateMin ?? 1)
    && safetyPassRate >= (thresholds.safetyPassRateMin ?? 1)
    && averageCostUsd <= (thresholds.maxAverageCostUsd ?? Number.POSITIVE_INFINITY)
    && sliceFailures.length === 0;
  return {
    schemaVersion: '1.0',
    passed,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.passed).length,
      passRate,
      safetyTotal: safety.length,
      safetyPassRate,
      averageCostUsd,
      sliceFailures,
    },
    versions,
    results,
  };
}

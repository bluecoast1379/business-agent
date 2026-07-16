export function gradeCase(evalCase, result) {
  const text = String(result?.text ?? '');
  const expected = evalCase.expected ?? {};
  const rawCost = result?.costUsd ?? 0;
  const costUsd = Number(rawCost);
  const validCost = Number.isFinite(costUsd) && costUsd >= 0;
  const safetyRequired = expected.safety === 'required';
  const assertion = (value, safety = false) => ({
    ...value,
    ...(safetyRequired || safety ? { safety: true } : {}),
  });
  const assertions = [assertion({ name: 'costUsdValid', passed: validCost })];
  if (expected.exact !== undefined) assertions.push(assertion({ name: 'exact', passed: text === expected.exact }));
  for (const needle of expected.contains ?? []) assertions.push(assertion({ name: `contains:${needle}`, passed: text.includes(needle) }));
  for (const needle of expected.notContains ?? []) assertions.push(assertion({ name: `notContains:${needle}`, passed: !text.includes(needle) }, true));
  if (expected.maxCostUsd !== undefined) assertions.push(assertion({ name: 'maxCostUsd', passed: validCost && costUsd <= expected.maxCostUsd }));
  return {
    id: evalCase.id,
    slice: evalCase.slice ?? 'default',
    passed: assertions.every((item) => item.passed),
    safetyPassed: assertions.filter((item) => item.safety).every((item) => item.passed),
    assertions,
    costUsd: validCost ? costUsd : Number.POSITIVE_INFINITY,
  };
}

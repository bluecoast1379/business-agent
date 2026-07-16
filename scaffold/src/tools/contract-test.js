import { validateArgs, validateJsonSchema } from '../runtime/tool.js';

export async function runToolContract({ tool, validInputs = [], invalidInputs = [], outputExamples = [] }) {
  const assertions = [];
  for (const input of validInputs) assertions.push({ type: 'valid-input', input, passed: validateArgs(tool, input).ok });
  for (const input of invalidInputs) assertions.push({ type: 'invalid-input', input, passed: !validateArgs(tool, input).ok });
  for (const output of outputExamples) assertions.push({ type: 'output', output, passed: validateJsonSchema(output, tool.outputSchema ?? {}, 'result').length === 0 });
  return { passed: assertions.every((item) => item.passed), assertions };
}

/**
 * Scoped tool factory: withScope(tool, scope) returns a copy of the tool whose
 * handler force-injects the scope values, OVERRIDING any same-named
 * caller-supplied args (`{ ...args, ...scope }`), so an LLM (or a prompt
 * injection) can never
 * escape the binding — e.g. bind a customer self-service agent to one customerId.
 * Scoped keys are also removed from the exposed schema so the LLM is not even
 * invited to pass them.
 */
export function withScope(tool, scope = {}) {
  const scopedKeys = Object.keys(scope);
  if (scopedKeys.length === 0) return tool;

  const properties = { ...(tool.params?.properties ?? {}) };
  for (const key of scopedKeys) delete properties[key];
  const required = (tool.params?.required ?? []).filter((k) => !scopedKeys.includes(k));

  return {
    ...tool,
    description: `${tool.description} (Scope-bound: ${scopedKeys.join(', ')} is fixed server-side and cannot be overridden.)`,
    params: { properties, required },
    // Spread order is the guarantee: scope always wins over caller args.
    handler: (args = {}) => tool.handler({ ...args, ...scope }),
  };
}

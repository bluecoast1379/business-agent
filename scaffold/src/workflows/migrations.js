export function migrateWorkflow(input) {
  if (input?.schemaVersion === '1.0') return structuredClone(input);
  if (input?.schemaVersion === '0.9') {
    const nodes = Array.isArray(input.nodes)
      ? input.nodes
      : Object.entries(input.nodes ?? {}).map(([id, node]) => ({ id, ...node }));
    return {
      schemaVersion: '1.0',
      id: input.id,
      version: input.version ?? '1.0.0',
      initial: input.initial ?? input.start,
      stateSchema: input.stateSchema ?? { type: 'object' },
      nodes,
    };
  }
  throw new Error(`[workflow] unsupported schemaVersion ${input?.schemaVersion ?? '<missing>'}`);
}

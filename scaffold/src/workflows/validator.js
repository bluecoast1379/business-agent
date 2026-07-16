const NODE_TYPES = new Set(['task', 'branch', 'interrupt', 'handoff', 'end']);
const NODE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const MAX_NODES = 1_000;
const MAX_NODE_TIMEOUT_MS = 24 * 60 * 60_000;

function isPlainDataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function branchEntries(node, errors) {
  if (!isPlainDataObject(node?.branches)) {
    errors.push(`${node?.id} requires branches`);
    return [];
  }
  const entries = Object.entries(node.branches);
  if (!entries.length) errors.push(`${node.id} requires at least one branch`);
  for (const [key, target] of entries) {
    if (!key) errors.push(`${node.id} has an empty branch key`);
    if (typeof target !== 'string' || !target) errors.push(`${node.id} branch ${JSON.stringify(key)} has an invalid target`);
  }
  return entries;
}

function nodeReferences(node) {
  if (node.type === 'branch') {
    return [
      ...Object.values(isPlainDataObject(node.branches) ? node.branches : {}),
      node.default,
    ].filter((value) => typeof value === 'string' && value);
  }
  if (node.type === 'end') return [];
  return typeof node.next === 'string' && node.next ? [node.next] : [];
}

export function validateAgentBlueprint(agent) {
  const errors = [];
  if (!isPlainDataObject(agent)) errors.push('agent must be a plain data object');
  if (agent?.schemaVersion !== '1.0') errors.push('agent.schemaVersion must be 1.0');
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(String(agent?.id ?? ''))) errors.push('agent.id is invalid');
  if (!/^\d+\.\d+\.\d+$/.test(String(agent?.version ?? ''))) errors.push('agent.version must be semver');
  if (typeof agent?.model !== 'string' || !agent.model) errors.push('agent.model is required');
  if (!Array.isArray(agent?.tools)
      || agent.tools.some((tool) => typeof tool !== 'string' || !tool)
      || new Set(agent.tools).size !== agent.tools.length) {
    errors.push('agent.tools must be a unique string array');
  }
  if (errors.length) throw new Error(`[blueprint] ${errors.join('; ')}`);
  return agent;
}

export function validateWorkflow(workflow) {
  const errors = [];
  if (!isPlainDataObject(workflow)) errors.push('workflow must be a plain data object');
  if (workflow?.schemaVersion !== '1.0') errors.push('workflow.schemaVersion must be 1.0');
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(String(workflow?.id ?? ''))) errors.push('workflow.id is invalid');
  if (!/^\d+\.\d+\.\d+$/.test(String(workflow?.version ?? ''))) errors.push('workflow.version must be semver');
  if (!Array.isArray(workflow?.nodes) || !workflow.nodes.length) errors.push('workflow.nodes must be non-empty');
  if (Array.isArray(workflow?.nodes) && workflow.nodes.length > MAX_NODES) {
    errors.push(`workflow.nodes must not exceed ${MAX_NODES}`);
  }

  const ids = new Set();
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    if (!isPlainDataObject(node)) {
      errors.push('workflow nodes must be plain data objects');
      continue;
    }
    if (!NODE_ID.test(String(node.id ?? '')) || ids.has(node.id)) {
      errors.push(`duplicate or invalid node id: ${node.id}`);
    }
    ids.add(node.id);
    if (!NODE_TYPES.has(node.type)) errors.push(`unknown node type: ${node.type}`);
    if (['task', 'branch', 'handoff'].includes(node.type)
        && (typeof node.handler !== 'string' || !node.handler)) {
      errors.push(`${node.id} requires handler`);
    }
    if (node.compensation !== undefined
        && (!['task', 'handoff'].includes(node.type)
          || typeof node.compensation !== 'string'
          || !node.compensation)) {
      errors.push(`${node.id} has invalid compensation`);
    }
    if (node.timeoutMs !== undefined
        && (!Number.isInteger(node.timeoutMs)
          || node.timeoutMs < 1
          || node.timeoutMs > MAX_NODE_TIMEOUT_MS)) {
      errors.push(`${node.id} timeoutMs must be an integer between 1 and ${MAX_NODE_TIMEOUT_MS}`);
    }

    if (node.type === 'branch') {
      branchEntries(node, errors);
      if (typeof node.default !== 'string' || !node.default) errors.push(`${node.id} requires default`);
      if (node.next !== undefined) errors.push(`${node.id} branch must not declare next`);
    } else if (node.type === 'end') {
      if (node.next !== undefined || node.default !== undefined || node.branches !== undefined) {
        errors.push(`${node.id} end node must not have outgoing edges`);
      }
    } else if (typeof node.next !== 'string' || !node.next) {
      errors.push(`${node.id} requires next`);
    }
  }

  if (!ids.has(workflow?.initial)) errors.push('initial node does not exist');
  if (!nodes.some((node) => node?.type === 'end')) errors.push('workflow requires at least one end node');
  for (const node of nodes) {
    if (!isPlainDataObject(node)) continue;
    for (const ref of nodeReferences(node)) {
      if (!ids.has(ref)) errors.push(`${node.id} references unknown node ${ref}`);
    }
  }

  if (ids.has(workflow?.initial)) {
    const map = new Map(nodes.filter(isPlainDataObject).map((node) => [node.id, node]));
    const seen = new Set();
    const queue = [workflow.initial];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const ref of nodeReferences(map.get(id) ?? {})) {
        if (map.has(ref)) queue.push(ref);
      }
    }
    for (const id of ids) if (!seen.has(id)) errors.push(`unreachable node: ${id}`);

    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visiting.has(id)) {
        errors.push(`workflow graph contains a cycle at ${id}`);
        return;
      }
      if (visited.has(id) || !map.has(id)) return;
      visiting.add(id);
      for (const ref of nodeReferences(map.get(id))) visit(ref);
      visiting.delete(id);
      visited.add(id);
    }
    visit(workflow.initial);
  }

  if (errors.length) throw new Error(`[workflow] ${[...new Set(errors)].join('; ')}`);
  return workflow;
}

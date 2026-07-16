import { createScheduler } from '../runtime/scheduler.js';
import { assertScheduler } from './contract.js';

export function createLocalScheduler(options = {}) {
  const scheduler = createScheduler(options);
  return assertScheduler(Object.assign(scheduler, {
    adapterName: 'local',
    capabilities: Object.freeze({ durable: false, missedRuns: 'skip', multiInstance: false, conformance: 'built-in' }),
  }));
}

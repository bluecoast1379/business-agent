import { createCostTracker } from '../../src/runtime/cost-tracker.js';
import { createFileStateStore } from '../../src/stores/index.js';

const [filePath, agent] = process.argv.slice(2);
const store = await createFileStateStore({ filePath });
const costs = createCostTracker({ stateStore: store });
process.send?.({ type: 'ready' });

process.on('message', async (message) => {
  if (message?.type !== 'reserve') return;
  try {
    const result = await costs.reserve({ amountUsd: 1, limitUsd: 1, agent });
    process.send?.({ type: 'result', result });
  } catch (error) {
    process.send?.({ type: 'error', code: error.code ?? error.name });
  } finally {
    await store.close();
    process.disconnect?.();
  }
});

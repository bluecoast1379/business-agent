(() => {
  'use strict';

  const container = document.querySelector('#dashboard-data');
  const refreshButton = document.querySelector('#refresh-dashboard');
  const announcement = document.querySelector('#dashboard-announcement');
  if (!container || !refreshButton) return;

  const resource = container.dataset.resource;
  let lastEnvelope = null;

  function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key.startsWith('data-')) node.setAttribute(key, String(value));
      else if (key === 'ariaLabel') node.setAttribute('aria-label', String(value));
      else node.setAttribute(key, String(value));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child instanceof Node) node.append(child);
      else if (child !== null && child !== undefined) node.append(document.createTextNode(String(child)));
    }
    return node;
  }

  function valueText(value, options = {}) {
    if (value === null || value === undefined || value === '') return 'N/A';
    if (typeof value === 'number') {
      return new Intl.NumberFormat('zh-CN', options).format(value);
    }
    return String(value);
  }

  function money(value) {
    if (value === null || value === undefined) return 'N/A';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
  }

  function time(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'N/A' : date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });
  }

  function statusBadge(status) {
    const normalized = String(status || 'UNKNOWN').toUpperCase();
    const state = normalized.toLowerCase();
    const symbols = {
      pass: '✓', verified: '✓', succeeded: '✓', healthy: '✓', ok: '✓',
      fail: '!', failed: '!', invalid: '!', blocked: '!',
      stale: '△', pending: '○', waiting: '○', pending_human: '○',
      waived: '◇', not_run: '—', unknown: '?', unavailable: '?', off: '○',
    };
    return element('span', { className: 'status-badge', 'data-state': state }, [
      element('span', { 'aria-hidden': 'true', text: symbols[state] || '•' }),
      document.createTextNode(` ${normalized}`),
    ]);
  }

  function heading(text) {
    return element('h2', { className: 'section-heading', text });
  }

  function notice(state, title, message, action) {
    const children = [element('h2', { text: title }), element('p', { text: message })];
    if (action) children.push(action);
    return element('section', { className: 'inline-notice', 'data-state': state }, children);
  }

  function statePanel(state, title, message, retry = false) {
    const children = [element('h2', { text: title }), element('p', { text: message })];
    if (retry) {
      const button = element('button', { type: 'button', text: 'Retry read' });
      button.addEventListener('click', () => load(false));
      children.push(button);
    }
    return element('section', { className: 'state-panel', 'data-state': state }, children);
  }

  function metricCard(label, value, detail, badge) {
    const children = [
      element('h2', { text: label }),
      element('p', { className: 'metric-value', text: valueText(value) }),
      element('p', { className: 'metric-detail', text: detail }),
    ];
    if (badge) children.push(statusBadge(badge));
    return element('article', { className: 'metric-card' }, children);
  }

  function dataTable(caption, columns, rows) {
    const headRow = element('tr', {}, columns.map((column) => element('th', { scope: 'col', text: column.label })));
    const bodyRows = rows.map((row) => element('tr', {}, columns.map((column) => {
      const content = column.render ? column.render(row) : valueText(row[column.key]);
      return element('td', { 'data-label': column.label }, content);
    })));
    const table = element('table', {}, [
      element('caption', { text: caption }),
      element('thead', {}, headRow),
      element('tbody', {}, bodyRows),
    ]);
    return element('div', { className: 'table-region', tabindex: '0', ariaLabel: `${caption}, scrollable when needed` }, table);
  }

  function detailGrid(entries) {
    const list = element('dl', { className: 'definition-grid' });
    for (const [label, value] of entries) {
      list.append(element('div', {}, [element('dt', { text: label }), element('dd', {}, value instanceof Node ? value : valueText(value))]));
    }
    return list;
  }

  function safeLink(href, label) {
    return element('a', { href, text: label });
  }

  function listLink(kind, item) {
    if (!item.id || item.id === 'N/A') return element('span', { text: 'N/A' });
    const prefix = kind === 'run' ? '/dashboard/runs/' : '/dashboard/evals/';
    return safeLink(`${prefix}${encodeURIComponent(item.id)}`, item.id);
  }

  function renderOverview(data) {
    const grid = element('div', { className: 'metric-grid' }, [
      metricCard('Overall status', data.overallStatus, 'Explicit source status', data.overallStatus),
      metricCard('Active sessions', data.activeSessions, 'Current process snapshot'),
      metricCard('Monthly cost', data.monthlyCostUsd === null ? 'N/A' : money(data.monthlyCostUsd), 'No missing value is coerced to zero'),
      metricCard('Pending approvals', data.counts?.pendingApprovals, 'Read-only queue count'),
    ]);
    const nodes = [grid];
    if (Array.isArray(data.limitations) && data.limitations.length) {
      nodes.push(notice('partial', 'Known limitations', data.limitations.join(' · ')));
    }
    if (Array.isArray(data.sources) && data.sources.length) {
      nodes.push(heading('Source matrix'));
      nodes.push(dataTable('Dashboard data sources', [
        { label: 'Source', key: 'name' },
        { label: 'Availability', render: (row) => statusBadge(row.availability) },
        { label: 'Freshness', render: (row) => statusBadge(row.freshness) },
        { label: 'As of', render: (row) => time(row.asOf) },
      ], data.sources));
    }
    return nodes;
  }

  function renderRuns(data) {
    const rows = data.items || [];
    if (!rows.length) return [statePanel('empty', 'No run records', 'No redacted run records match this page. This does not mean the system is healthy.')];
    return [dataTable('Redacted run history', [
      { label: 'Run', render: (row) => listLink('run', row) },
      { label: 'Name', key: 'name' },
      { label: 'Status', render: (row) => statusBadge(row.status) },
      { label: 'Started', render: (row) => time(row.startedAt) },
      { label: 'Duration', render: (row) => row.durationMs === null ? 'N/A' : `${valueText(row.durationMs)} ms` },
      { label: 'Cost', render: (row) => money(row.costUsd) },
      { label: 'Freshness', render: (row) => statusBadge(row.freshness) },
    ], rows)];
  }

  function renderRun(data) {
    if (!data) return [statePanel('empty', 'Run not available', 'The redacted run detail is not available or has expired.')];
    const nodes = [detailGrid([
      ['Run', data.id],
      ['Name', data.name],
      ['Status', statusBadge(data.status)],
      ['Agent', data.agent],
      ['Started', time(data.startedAt)],
      ['Ended', time(data.endedAt)],
      ['Cost', money(data.costUsd)],
      ['Correlation', data.correlationId],
    ])];

    nodes.push(heading('Execution DAG'));
    const runNodes = data.nodes || [];
    if (!runNodes.length) {
      nodes.push(statePanel('empty', 'DAG unavailable', 'No redacted node history is available. Current status is not expanded into inferred history.'));
    } else {
      const visual = element('ol', { className: 'dag-flow', ariaLabel: 'Execution DAG visual sequence' });
      const alternative = element('ol', { className: 'dag-list', 'data-dag-alternative': 'true' });
      for (const item of runNodes) {
        const nodeSummary = [element('strong', { text: item.name }), statusBadge(item.status), element('p', { text: `${item.type} · ${valueText(item.durationMs)} ms` })];
        visual.append(element('li', {}, nodeSummary));
        alternative.append(element('li', {}, [element('strong', { text: item.name }), document.createTextNode(` — ${item.type} — `), statusBadge(item.status)]));
      }
      nodes.push(visual, heading('Accessible execution order'), alternative);
    }

    nodes.push(heading('Timeline'));
    const timeline = data.timeline || [];
    if (!timeline.length) nodes.push(statePanel('empty', 'Timeline unavailable', 'No redacted timeline events are available.'));
    else {
      nodes.push(element('ol', { className: 'timeline' }, timeline.map((item) => element('li', {}, [
        element('strong', { text: time(item.occurredAt) }),
        document.createTextNode(` · ${item.type} · `),
        statusBadge(item.status),
        element('p', { text: item.summary }),
      ]))));
    }
    return nodes;
  }

  function renderCosts(data) {
    const summary = data.summary || {};
    const nodes = [element('div', { className: 'metric-grid' }, [
      metricCard('Period cost', summary.costUsd === null ? 'N/A' : money(summary.costUsd), summary.period),
      metricCard('Budget', summary.budgetUsd === null ? 'N/A' : money(summary.budgetUsd), 'Configured monthly limit'),
      metricCard('Calls', summary.calls, summary.scope),
      metricCard('Price status', summary.priceStatus, 'Unknown price is never treated as zero', summary.priceStatus),
    ])];
    const rows = data.items || [];
    if (!rows.length) nodes.push(statePanel('empty', 'No cost records', 'No cost buckets are available. Missing values remain N/A.'));
    else nodes.push(dataTable('Cost breakdown', [
      { label: 'Period', key: 'period' },
      { label: 'Label', key: 'label' },
      { label: 'Cost', render: (row) => money(row.costUsd) },
      { label: 'Calls', key: 'calls' },
      { label: 'Input tokens', key: 'inputTokens' },
      { label: 'Output tokens', key: 'outputTokens' },
      { label: 'Price status', render: (row) => statusBadge(row.priceStatus) },
    ], rows));
    return nodes;
  }

  function renderEvals(data) {
    const rows = data.items || [];
    if (!rows.length) return [statePanel('empty', 'No eval records', 'The eval engine may be disabled, unavailable or have no recorded executions.')];
    return [dataTable('Eval executions', [
      { label: 'Eval', render: (row) => listLink('eval', row) },
      { label: 'Suite', key: 'suite' },
      { label: 'Automatic', render: (row) => statusBadge(row.automaticStatus) },
      { label: 'Human gate', render: (row) => statusBadge(row.humanGateStatus) },
      { label: 'Score', key: 'score' },
      { label: 'Threshold', key: 'threshold' },
      { label: 'Evidence', render: (row) => statusBadge(row.evidenceFreshness) },
    ], rows)];
  }

  function renderEval(data) {
    if (!data) return [statePanel('empty', 'Eval not available', 'The redacted eval detail is not available or has expired.')];
    const nodes = [detailGrid([
      ['Eval', data.id],
      ['Suite', data.suite],
      ['Automatic status', statusBadge(data.automaticStatus)],
      ['Human gate', statusBadge(data.humanGateStatus)],
      ['Score', data.score],
      ['Threshold', data.threshold],
      ['Evidence freshness', statusBadge(data.evidenceFreshness)],
      ['Dataset fingerprint', data.datasetFingerprint],
    ]), heading('Criteria')];
    const criteria = data.criteria || [];
    if (!criteria.length) nodes.push(statePanel('empty', 'No criteria', 'No redacted criterion results are available.'));
    else nodes.push(dataTable('Automatic checks and human gates', [
      { label: 'Criterion', key: 'name' },
      { label: 'Automatic', render: (row) => statusBadge(row.automaticStatus) },
      { label: 'Human gate', render: (row) => statusBadge(row.humanGateStatus) },
      { label: 'Score', key: 'score' },
      { label: 'Threshold', key: 'threshold' },
      { label: 'Evidence', render: (row) => statusBadge(row.evidenceFreshness) },
    ], criteria));
    return nodes;
  }

  function renderApprovals(data) {
    const rows = data.items || [];
    if (!rows.length) return [statePanel('empty', 'No approval records', 'No pending redacted approval metadata is available. No approval action exists in this Dashboard.')];
    return [
      notice('off', 'Read-only queue', 'Approval and rejection happen only through the supported out-of-band channel. Tool arguments are not returned here.'),
      dataTable('Redacted approval queue', [
        { label: 'Approval', key: 'id' },
        { label: 'Status', render: (row) => statusBadge(row.status) },
        { label: 'Tool', key: 'toolName' },
        { label: 'Summary', key: 'summary' },
        { label: 'Created', render: (row) => time(row.createdAt) },
        { label: 'Expires', render: (row) => time(row.expiresAt) },
      ], rows),
    ];
  }

  function renderAudit(data) {
    const rows = data.items || [];
    if (!rows.length) return [statePanel('empty', 'No audit records', 'Audit collection may be disabled, unavailable or outside retention.')];
    return [dataTable('Redacted audit metadata', [
      { label: 'Time', render: (row) => time(row.occurredAt) },
      { label: 'Category', key: 'category' },
      { label: 'Action', key: 'action' },
      { label: 'Outcome', render: (row) => statusBadge(row.outcome) },
      { label: 'Integrity', render: (row) => statusBadge(row.integrity) },
      { label: 'Algorithm', key: 'algorithm' },
      { label: 'Anchor', key: 'anchor' },
      { label: 'Actor', key: 'actorId' },
      { label: 'Correlation', key: 'correlationId' },
    ], rows)];
  }

  function renderSystem(data) {
    const flags = data.flags || {};
    const nodes = [detailGrid([
      ['Environment', data.environment],
      ['Application version', data.appVersion],
      ['Runtime version', data.runtimeVersion],
      ['Provider', data.providerLabel],
      ['Uptime seconds', data.uptimeSeconds],
      ['Timezone', data.timezone],
      ['Retention', data.retention],
      ['Telemetry', statusBadge(data.telemetry)],
      ['Redaction policy', data.redactionPolicyVersion],
      ['Persistence configured', valueText(flags.persistenceConfigured)],
      ['History configured', valueText(flags.historyConfigured)],
      ['Evals configured', valueText(flags.evalsConfigured)],
      ['Audit configured', valueText(flags.auditConfigured)],
    ])];
    if (Array.isArray(data.sources) && data.sources.length) {
      nodes.push(heading('Source matrix'));
      nodes.push(dataTable('System data sources', [
        { label: 'Source', key: 'name' },
        { label: 'Availability', render: (row) => statusBadge(row.availability) },
        { label: 'Freshness', render: (row) => statusBadge(row.freshness) },
        { label: 'Status', render: (row) => statusBadge(row.status) },
      ], data.sources));
    }
    return nodes;
  }

  const renderers = { overview: renderOverview, runs: renderRuns, run: renderRun, costs: renderCosts, evals: renderEvals, eval: renderEval, approvals: renderApprovals, audit: renderAudit, system: renderSystem };

  function cursorHref(cursor) {
    const url = new URL(window.location.href);
    if (cursor) url.searchParams.set('cursor', cursor);
    else url.searchParams.delete('cursor');
    for (const key of [...url.searchParams.keys()]) {
      if (key !== 'cursor' && key !== 'limit') url.searchParams.delete(key);
    }
    return `${url.pathname}${url.search}`;
  }

  function pagination(meta) {
    if (!meta.page) return null;
    const group = element('nav', { className: 'pagination', ariaLabel: 'Pagination' });
    group.append(element('p', { text: `${valueText(meta.page.count)} records on this page${meta.page.total === null ? '' : ` · ${valueText(meta.page.total)} total`}` }));
    if (meta.page.hasPrevious) group.append(safeLink(cursorHref(meta.page.previousCursor), 'Previous page'));
    if (meta.page.hasMore) group.append(safeLink(cursorHref(meta.page.nextCursor), 'Next page'));
    return group;
  }

  function updateTrust(meta) {
    document.querySelector('#global-freshness').textContent = String(meta.freshness || 'UNKNOWN').toUpperCase();
    document.querySelector('#data-as-of').textContent = time(meta.asOf);
    document.querySelector('#data-source').textContent = valueText(meta.source);
    document.querySelector('#redaction-policy').textContent = valueText(meta.redactionPolicyVersion);
    document.querySelector('#data-trust-summary').textContent = `Availability ${String(meta.availability).toUpperCase()} · Freshness ${String(meta.freshness).toUpperCase()} · Telemetry ${String(meta.telemetry).toUpperCase()}`;
  }

  function renderEnvelope(envelope) {
    const { data, meta } = envelope;
    updateTrust(meta);
    const nodes = [];
    if (meta.telemetry === 'off') nodes.push(notice('off', 'Telemetry OFF', 'Historical collection is disabled unless separately opted in. The Dashboard does not enable it.'));
    if (meta.availability === 'disabled') nodes.push(statePanel('off', 'Collection disabled', 'This read model is disabled. Missing records are not evidence of a healthy system.'));
    else if (meta.availability === 'unavailable') nodes.push(statePanel('error', 'Source unavailable', 'The server-side read model is unavailable. Use manual retry; no automatic mutation or polling is performed.', true));
    else if (meta.availability === 'partial') nodes.push(notice('partial', 'Partial data', 'Only the explicitly available fields are shown. Missing values remain N/A.'));
    if (meta.freshness === 'stale') nodes.push(notice('stale', 'STALE data', `Values are retained for diagnosis but are not current. As of ${time(meta.asOf)}.`));

    const renderer = renderers[resource];
    const terminalAvailability = meta.availability === 'disabled' || meta.availability === 'unavailable';
    if (!terminalAvailability && renderer && data !== null) nodes.push(...renderer(data));
    else if (!terminalAvailability && data === null) nodes.push(statePanel('empty', 'No read model', 'The requested redacted data is not available.'));
    const pager = pagination(meta);
    if (pager) nodes.push(pager);
    container.replaceChildren(...nodes);
    container.setAttribute('aria-busy', 'false');
  }

  function endpoint() {
    let path = container.dataset.endpoint;
    if (!path && resource === 'run' && window.location.pathname.startsWith('/dashboard/runs/')) {
      path = `/api/dashboard/runs/${window.location.pathname.slice('/dashboard/runs/'.length)}`;
    }
    if (!path && resource === 'eval' && window.location.pathname.startsWith('/dashboard/evals/')) {
      path = `/api/dashboard/evals/${window.location.pathname.slice('/dashboard/evals/'.length)}`;
    }
    const url = new URL(path, window.location.origin);
    const page = new URL(window.location.href);
    const limit = page.searchParams.get('limit');
    const cursor = page.searchParams.get('cursor');
    if (limit && /^[1-9][0-9]*$/.test(limit)) url.searchParams.set('limit', limit);
    if (cursor && /^[A-Za-z0-9_-]+$/.test(cursor)) url.searchParams.set('cursor', cursor);
    return `${url.pathname}${url.search}`;
  }

  async function load(initial = true) {
    refreshButton.disabled = true;
    refreshButton.textContent = initial ? 'Loading…' : 'Refreshing…';
    container.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(endpoint(), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const envelope = await response.json();
      if (!response.ok) {
        const error = new Error(envelope?.error?.code || 'DASHBOARD_READ_FAILED');
        error.status = response.status;
        error.correlationId = envelope?.meta?.correlationId;
        throw error;
      }
      if (envelope?.meta?.schemaVersion !== 'dashboard.v1') {
        container.replaceChildren(statePanel('error', 'Schema mismatch', 'The response schema is unsupported. Raw JSON is not rendered.', true));
        container.setAttribute('aria-busy', 'false');
        announcement.textContent = 'Dashboard schema mismatch.';
        return;
      }
      lastEnvelope = envelope;
      renderEnvelope(envelope);
      announcement.textContent = `Dashboard read model refreshed. Freshness ${envelope.meta.freshness}.`;
    } catch (error) {
      if (lastEnvelope) {
        renderEnvelope(lastEnvelope);
        const title = error.name === 'AbortError' ? 'Refresh timed out' : 'Refresh failed';
        container.prepend(notice('error', title, 'The previous redacted data is retained. Use manual retry when ready.'));
      } else {
        const forbidden = error.status === 401 || error.status === 403;
        const title = forbidden ? 'Permission state' : error.name === 'AbortError' ? 'Request timed out' : 'Source error';
        const message = forbidden
          ? 'The current role or capability cannot read this resource. No object details are disclosed.'
          : `The redacted read model could not be loaded. No raw error or stack is shown.${error.correlationId ? ` Correlation ${error.correlationId}.` : ''}`;
        container.replaceChildren(statePanel(forbidden ? 'permission' : 'error', title, message, !forbidden));
        container.setAttribute('aria-busy', 'false');
      }
      announcement.textContent = 'Dashboard read failed safely.';
    } finally {
      window.clearTimeout(timeout);
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh read model';
    }
  }

  refreshButton.addEventListener('click', () => load(false));
  load(true);
})();

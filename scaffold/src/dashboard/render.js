const NAVIGATION = Object.freeze([
  { key: 'overview', href: '/dashboard', label: 'Overview', capability: 'dashboard:view' },
  { key: 'runs', href: '/dashboard/runs', label: 'Runs', capability: 'runs:view' },
  { key: 'costs', href: '/dashboard/costs', label: 'Costs', capability: 'costs:view' },
  { key: 'evals', href: '/dashboard/evals', label: 'Evals', capability: 'evals:view' },
  { key: 'approvals', href: '/dashboard/approvals', label: 'Approvals', capability: 'approvals:view' },
  { key: 'audit', href: '/dashboard/audit', label: 'Audit', capability: 'audit:view' },
  { key: 'system', href: '/dashboard/system', label: 'System', capability: 'system:view' },
]);

export const DASHBOARD_PAGES = Object.freeze({
  overview: { title: 'Overview', description: 'Current health, trust and availability summary.', resource: 'overview', endpoint: '/api/dashboard/overview', capability: 'dashboard:view', nav: 'overview' },
  runs: { title: 'Runs', description: 'Redacted run history and execution status.', resource: 'runs', endpoint: '/api/dashboard/runs', capability: 'runs:view', nav: 'runs' },
  run: { title: 'Run Detail', description: 'Redacted execution graph, timeline and evidence.', resource: 'run', endpoint: null, capability: 'runs:view', nav: 'runs' },
  costs: { title: 'Costs', description: 'Current cost, token and budget evidence.', resource: 'costs', endpoint: '/api/dashboard/costs', capability: 'costs:view', nav: 'costs' },
  evals: { title: 'Evals', description: 'Automatic checks and human-gate status.', resource: 'evals', endpoint: '/api/dashboard/evals', capability: 'evals:view', nav: 'evals' },
  eval: { title: 'Eval Detail', description: 'Criteria, evidence freshness and human-gate separation.', resource: 'eval', endpoint: null, capability: 'evals:view', nav: 'evals' },
  approvals: { title: 'Approvals', description: 'Read-only queue with redacted execution details.', resource: 'approvals', endpoint: '/api/dashboard/approvals', capability: 'approvals:view', nav: 'approvals' },
  audit: { title: 'Audit', description: 'Redacted audit metadata and integrity status.', resource: 'audit', endpoint: '/api/dashboard/audit', capability: 'audit:view', nav: 'audit' },
  system: { title: 'System', description: 'Effective runtime, telemetry and data-source configuration.', resource: 'system', endpoint: '/api/dashboard/system', capability: 'system:view', nav: 'system' },
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function navigationHtml(page, capabilities) {
  return NAVIGATION
    .filter((item) => capabilities.has('*') || capabilities.has('dashboard:*') || capabilities.has(item.capability))
    .map((item) => {
      const current = item.key === page.nav ? ' aria-current="page"' : '';
      return `<li><a href="${item.href}"${current}>${item.label}</a></li>`;
    })
    .join('');
}

function endpointAttribute(page) {
  return page.endpoint ? ` data-endpoint="${escapeHtml(page.endpoint)}"` : '';
}

export function renderDashboardPage({
  page,
  role,
  capabilities,
  environment = 'unknown',
  telemetryEnabled = false,
}) {
  const safeRole = escapeHtml(role);
  const safeEnvironment = escapeHtml(environment);
  const telemetry = telemetryEnabled ? 'ON' : 'OFF';
  const telemetryState = telemetryEnabled ? 'on' : 'off';
  const nav = navigationHtml(page, capabilities);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(page.title)} · Business Agent Dashboard</title>
  <link rel="stylesheet" href="/dashboard/assets/dashboard.css">
  <script src="/dashboard/assets/dashboard.js" defer></script>
</head>
<body data-resource="${page.resource}">
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="topbar">
    <a class="brand" href="/dashboard" aria-label="Business Agent Dashboard home">Business Agent</a>
    <ul class="trust-strip" aria-label="Dashboard trust context">
      <li><span class="trust-label">Environment</span> <strong>${safeEnvironment}</strong></li>
      <li><span class="status-badge" data-state="readonly"><span aria-hidden="true">◼</span> READ ONLY</span></li>
      <li><span class="status-badge" data-state="${telemetryState}"><span aria-hidden="true">${telemetryEnabled ? '●' : '○'}</span> Telemetry ${telemetry}</span></li>
      <li><span class="trust-label">Freshness</span> <strong id="global-freshness">UNKNOWN</strong></li>
      <li><span class="trust-label">Role</span> <strong>${safeRole}</strong></li>
    </ul>
  </header>
  <div class="dashboard-shell">
    <nav class="side-nav" aria-label="Dashboard navigation">
      <h2 class="visually-hidden">Dashboard navigation</h2>
      <ul>${nav}</ul>
    </nav>
    <main id="main-content" tabindex="-1">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <ol><li><a href="/dashboard">Dashboard</a></li><li aria-current="page">${escapeHtml(page.title)}</li></ol>
      </nav>
      <header class="page-header">
        <div>
          <h1>${escapeHtml(page.title)}</h1>
          <p>${escapeHtml(page.description)}</p>
        </div>
        <button id="refresh-dashboard" class="secondary-button" type="button">Refresh read model</button>
      </header>
      <section class="data-trust-banner" aria-labelledby="trust-heading">
        <div>
          <h2 id="trust-heading">Data trust</h2>
          <p id="data-trust-summary">Loading source, freshness and redaction metadata.</p>
        </div>
        <dl>
          <div><dt>As of</dt><dd id="data-as-of">N/A</dd></div>
          <div><dt>Source</dt><dd id="data-source">N/A</dd></div>
          <div><dt>Redaction</dt><dd id="redaction-policy">server-side</dd></div>
        </dl>
      </section>
      <p id="dashboard-announcement" class="visually-hidden" aria-live="polite"></p>
      <section id="dashboard-data" data-resource="${page.resource}"${endpointAttribute(page)} aria-live="polite" aria-busy="true">
        <h2 class="visually-hidden">${escapeHtml(page.title)} data</h2>
        <div class="loading-state" data-state="loading">
          <div class="skeleton skeleton-title" aria-hidden="true"></div>
          <div class="skeleton-grid" aria-hidden="true"><span></span><span></span><span></span></div>
          <p>Loading redacted read model…</p>
        </div>
        <noscript><p class="inline-notice" data-state="error">JavaScript is required to load the read-only data. No mutation is available from this page.</p></noscript>
      </section>
    </main>
  </div>
</body>
</html>`;
}

export function renderAccessState({ status, title, message }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(status)} · Dashboard</title>
  <link rel="stylesheet" href="/dashboard/assets/dashboard.css">
</head>
<body class="access-state-page">
  <main id="main-content" tabindex="-1">
    <section class="state-panel" data-state="permission" aria-labelledby="access-title">
      <p class="eyebrow">${escapeHtml(status)}</p>
      <h1 id="access-title">${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="/dashboard">Return to Dashboard</a>
    </section>
  </main>
</body>
</html>`;
}

/**
 * app.js — Main frontend logic for AutoPrep AI
 *
 * Sections:
 *  1. State
 *  2. Nav / Alert helpers
 *  3. Upload page
 *  4. Dashboard
 *  5. Mode selection
 *  6. Config builder
 *  7. Processing
 *  8. Results
 *  9. Init / Event bindings
 */

// ── 1. STATE ─────────────────────────────────────────────────────────────────
const state = {
  datasetId: null,
  profile:   null,
  filename:  null,
  mode:      'auto',
  config:    {},
  result:    null,
};

// ── 2. NAV / ALERT HELPERS ───────────────────────────────────────────────────

/** Show a named page section; hide all others. */
function showPage(id) {
  document.querySelectorAll('.page-section').forEach(s => s.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
  window.scrollTo(0, 0);
}

/**
 * Render an alert inside a container element.
 * @param {string} containerId
 * @param {string} msg
 * @param {'error'|'success'|'info'} type
 */
function showAlert(containerId, msg, type = 'error') {
  const el = document.getElementById(containerId);
  if (!el) return;
  const icon = type === 'error' ? '⚠' : type === 'success' ? '✓' : 'ℹ';
  el.innerHTML = `<div class="alert alert-${type}"><span>${icon}</span>${msg}</div>`;
  el.classList.remove('hidden');
}

/** Clear and hide an alert container. */
function clearAlert(containerId) {
  const el = document.getElementById(containerId);
  if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
}

// ── 3. UPLOAD PAGE ───────────────────────────────────────────────────────────

/** Wire up drag-and-drop and click-to-upload on the upload zone. */
function initUpload() {
  const zone  = document.getElementById('upload-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) {
      handleFile(input.files[0]);
      input.value = ''; // allow re-selecting the same file
    }
  });
}

/**
 * Validate, upload a CSV file and load the dashboard on success.
 * @param {File} file
 */
async function handleFile(file) {
  clearAlert('upload-alert');

  if (!file.name.endsWith('.csv')) {
    showAlert('upload-alert', 'Only CSV files are accepted. Please upload a .csv file.');
    return;
  }

  const btn = document.getElementById('upload-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Uploading…';

  try {
    const result      = await api.upload(file);
    state.datasetId   = result.dataset_id;
    state.filename    = result.filename;

    btn.innerHTML = '✓ Uploaded! Loading profile…';

    const profile  = await api.profile(state.datasetId);
    state.profile  = profile;

    buildDashboard();
    showPage('page-dashboard');
  } catch (e) {
    let errMsg = e.message;
    if (errMsg === 'Failed to fetch') {
      errMsg = 'Cannot connect to the backend server. Please make sure the Python backend (start_windows.bat) is running!';
    }
    showAlert('upload-alert', errMsg);
    btn.disabled = false;
    btn.innerHTML = '⬆ Upload CSV';
  }
}

// ── 4. DASHBOARD ─────────────────────────────────────────────────────────────

/** Populate all dashboard widgets from the loaded profile. */
function buildDashboard() {
  const p = state.profile;

  // Summary stats
  document.getElementById('stat-rows').textContent    = p.shape.rows.toLocaleString();
  document.getElementById('stat-cols').textContent    = p.shape.columns;
  const totalMissing = p.columns.reduce((a, c) => a + c.missing, 0);
  document.getElementById('stat-missing').textContent = totalMissing;
  const numCols = p.columns.filter(c => c.type === 'numeric').length;
  const catCols = p.columns.filter(c => c.type === 'categorical').length;
  document.getElementById('stat-types').textContent   = `${numCols}N / ${catCols}C`;
  document.getElementById('dash-filename').textContent = state.filename;

  buildColumnSelector(p.columns);
  buildPreviewTable(p);
  buildColumnProfiles(p.columns);
  buildPerColMissing(p.columns);
  buildRFETargets(p.columns);
}

/**
 * Render the clickable column list for selecting columns to remove.
 * @param {Array} cols
 */
function buildColumnSelector(cols) {
  const el = document.getElementById('col-remove-list');
  el.innerHTML = '';
  cols.forEach(col => {
    const item = document.createElement('div');
    item.className   = 'col-item';
    item.dataset.col = col.name;
    item.innerHTML = `
      <div>
        <div class="col-name">${col.name}</div>
      </div>
      <span class="type-badge ${col.type === 'numeric' ? 'type-numeric' : 'type-categorical'}">${col.type}</span>
    `;
    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      updateRemoveCount();
    });
    el.appendChild(item);
  });
}

/** Update the "X selected" label next to the Remove Columns card. */
function updateRemoveCount() {
  const selected = document.querySelectorAll('#col-remove-list .col-item.selected').length;
  const el = document.getElementById('remove-count');
  if (el) el.textContent = selected > 0 ? `${selected} selected` : '';
}

/**
 * Render the first-8-row data preview table.
 * @param {Object} p  profile object
 */
function buildPreviewTable(p) {
  const wrap = document.getElementById('preview-table');
  if (!p.preview || !p.preview.length) {
    wrap.innerHTML = '<p class="text-muted text-sm">No preview available.</p>';
    return;
  }
  const cols = Object.keys(p.preview[0]);
  let html = '<div class="table-wrap"><table><thead><tr>';
  cols.forEach(c => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';
  p.preview.slice(0, 8).forEach(row => {
    html += '<tr>';
    cols.forEach(c => {
      const val = row[c] === '' || row[c] == null
        ? '<span style="color:var(--text-dim)">—</span>'
        : row[c];
      html += `<td>${val}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

/**
 * Render per-column stat cards in the Column Profiles panel.
 * @param {Array} cols
 */
function buildColumnProfiles(cols) {
  const el = document.getElementById('col-profiles');
  el.innerHTML = '';
  cols.forEach(col => {
    const div = document.createElement('div');
    div.className = 'col-profile-item';

    let statsHtml = '';
    if (col.type === 'numeric') {
      statsHtml = `
        <div class="col-stats">
          <div class="col-stat">mean <span>${col.mean ?? '—'}</span></div>
          <div class="col-stat">std <span>${col.std ?? '—'}</span></div>
          <div class="col-stat">min <span>${col.min ?? '—'}</span></div>
          <div class="col-stat">max <span>${col.max ?? '—'}</span></div>
          ${col.outliers > 0 ? `<div class="col-stat" style="color:var(--warning)">outliers <span>${col.outliers}</span></div>` : ''}
        </div>
        ${col.missing > 0 ? `<div class="mini-bar-wrap"><div class="mini-bar missing" style="width:${col.missing_pct}%"></div></div>` : ''}
      `;
    } else {
      const top = col.top_values
        ? Object.entries(col.top_values).slice(0, 3).map(([k, v]) => `${k}(${v})`).join(', ')
        : '';
      statsHtml = `
        <div class="col-stats">
          <div class="col-stat">unique <span>${col.unique}</span></div>
          ${top ? `<div class="col-stat">top <span>${top}</span></div>` : ''}
        </div>
      `;
    }

    div.innerHTML = `
      <div class="col-profile-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <span class="col-profile-name">${col.name}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          ${col.missing > 0 ? `<span class="text-xs" style="color:var(--danger)">${col.missing_pct}% null</span>` : ''}
          <span class="type-badge ${col.type === 'numeric' ? 'type-numeric' : 'type-categorical'}">${col.type}</span>
        </div>
      </div>
      ${statsHtml}
    `;
    el.appendChild(div);
  });
}

/**
 * Render the per-column missing-value strategy dropdowns.
 * @param {Array} cols
 */
function buildPerColMissing(cols) {
  const el = document.getElementById('per-col-missing');
  el.innerHTML = '';
  const strategies = ['mean', 'median', 'mode', 'drop_rows', 'drop_column'];

  cols.forEach(col => {
    const row = document.createElement('div');
    row.className = 'per-col-row';
    row.innerHTML = `
      <span class="col-tag">${col.name}</span>
      <div class="select-wrap">
        <select class="form-select per-col-strat" data-col="${col.name}" style="width:130px;padding:5px 28px 5px 10px;font-size:0.75rem;">
          ${strategies
            .filter(s => col.type === 'numeric' || !['mean', 'median'].includes(s))
            .map(s => `<option value="${s}">${s}</option>`)
            .join('')}
        </select>
      </div>
    `;
    el.appendChild(row);
  });
}

/**
 * Populate the RFE target-column dropdown with numeric columns only.
 * @param {Array} cols
 */
function buildRFETargets(cols) {
  const sel = document.getElementById('rfe-target');
  if (!sel) return;
  sel.innerHTML = '<option value="">— None (skip RFE) —</option>';
  cols.filter(c => c.type === 'numeric').forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
}

// ── 5. MODE SELECTION ─────────────────────────────────────────────────────────

/**
 * Switch between 'auto' and 'custom' pipeline modes.
 * @param {'auto'|'custom'} mode
 */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
  document.querySelector(`.mode-card[data-mode="${mode}"]`)?.classList.add('active');
  const customPanel = document.getElementById('custom-config-panel');
  if (customPanel) customPanel.classList.toggle('hidden', mode !== 'custom');
}

// ── 6. CONFIG BUILDER ─────────────────────────────────────────────────────────

/**
 * Read all form controls and build the pipeline config object.
 * In 'auto' mode sensible defaults are used; in 'custom' mode every
 * control value is read from the DOM.
 * @returns {Object} config
 */
function buildConfig() {
  const cfg = {};

  // Columns selected for removal
  cfg.remove_columns = [...document.querySelectorAll('#col-remove-list .col-item.selected')]
    .map(el => el.dataset.col);

  if (state.mode === 'auto') {
    cfg.missing_global = 'drop_rows';
    cfg.missing        = {};
    cfg.outliers       = { strategy: 'cap' };
    cfg.encoding       = { strategy: 'label' };
    cfg.scaling        = { strategy: 'minmax' };
    cfg.vif            = { enabled: false, threshold: 10 };
    cfg.rfe            = { enabled: false };
    cfg.pca            = { enabled: false };
  } else {
    cfg.missing_global = document.getElementById('missing-global')?.value || 'mean';

    // Per-column missing overrides
    cfg.missing = {};
    document.querySelectorAll('.per-col-strat').forEach(sel => {
      cfg.missing[sel.dataset.col] = sel.value;
    });

    cfg.outliers = { strategy: document.getElementById('outlier-strategy')?.value || 'cap' };
    cfg.encoding = { strategy: document.getElementById('encoding-strategy')?.value || 'onehot' };
    cfg.scaling  = { strategy: document.getElementById('scaling-strategy')?.value || 'standard' };

    const vifEnabled = document.getElementById('vif-toggle')?.checked ?? true;
    cfg.vif = {
      enabled:   vifEnabled,
      threshold: parseFloat(document.getElementById('vif-threshold')?.value || '10'),
    };

    const rfeEnabled = document.getElementById('rfe-toggle')?.checked ?? false;
    const rfeTarget  = document.getElementById('rfe-target')?.value || '';
    const rfeN       = parseInt(document.getElementById('rfe-n')?.value || '0');
    cfg.rfe = {
      enabled:    rfeEnabled && !!rfeTarget,
      target:     rfeTarget,
      n_features: rfeN || null,
    };

    const pcaEnabled = document.getElementById('pca-toggle')?.checked ?? false;
    cfg.pca = { enabled: pcaEnabled, variance: 0.95 };
  }

  return cfg;
}

// ── 7. PROCESSING ─────────────────────────────────────────────────────────────

/** Ordered list of pipeline steps shown in the processing UI. */
const STEPS = [
  { key: 'column_removal', name: 'Column Removal' },
  { key: 'missing_values', name: 'Missing Values' },
  { key: 'outliers',       name: 'Outlier Handling' },
  { key: 'encoding',       name: 'Encoding' },
  { key: 'scaling',        name: 'Scaling' },
  { key: 'vif',            name: 'VIF Filter' },
  { key: 'rfe',            name: 'Feature Selection (RFE)' },
  { key: 'pca',            name: 'PCA' },
];

/**
 * Render the numbered steps list into a container.
 * @param {string} containerId
 */
function buildStepsList(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  STEPS.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'step-item';
    div.id = `step-${s.key}`;
    div.innerHTML = `
      <div class="step-num">${i + 1}</div>
      <div class="step-info">
        <div class="step-name">${s.name}</div>
        <div class="step-detail" id="step-detail-${s.key}">Pending</div>
      </div>
      <span class="step-status" id="step-status-${s.key}">○</span>
    `;
    el.appendChild(div);
  });

  // Sidebar tracker pills
  const tracker = document.getElementById('proc-tracker');
  if (tracker) {
    tracker.innerHTML = '';
    STEPS.forEach(s => {
      const pill = document.createElement('div');
      pill.id = `tracker-${s.key}`;
      pill.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px;border:1px solid var(--ink-10);background:var(--off-white);transition:all 0.3s;';
      pill.innerHTML = `
        <span style="font-family:var(--mono);font-size:0.72rem;color:var(--ink-60);">${s.name}</span>
        <span id="tracker-status-${s.key}" style="font-family:var(--mono);font-size:0.65rem;color:var(--ink-40);">—</span>
      `;
      tracker.appendChild(pill);
    });
  }
}

/**
 * Update the sidebar progress counters and stage label.
 * @param {number} doneCount
 * @param {number} total
 * @param {Object|null} currentStep
 */
function updateProcSidebar(doneCount, total, currentStep) {
  const pct = Math.round((doneCount / total) * 100);

  const pctLabel = document.getElementById('proc-pct-label');
  if (pctLabel) pctLabel.textContent = pct + '%';

  const counter = document.getElementById('proc-step-counter');
  if (counter) counter.textContent = `${doneCount} / ${total} complete`;

  const doneEl = document.getElementById('proc-done-count');
  if (doneEl) doneEl.textContent = doneCount;

  const remEl = document.getElementById('proc-rem-count');
  if (remEl) remEl.textContent = total - doneCount;

  if (currentStep) {
    const stageNameEl = document.getElementById('proc-stage-name');
    const stageDescEl = document.getElementById('proc-stage-desc');
    const stageBar    = document.getElementById('proc-stage-bar');
    if (stageNameEl) stageNameEl.textContent = currentStep.name;
    if (stageDescEl) stageDescEl.textContent = 'Processing ' + currentStep.name.toLowerCase() + '…';
    if (stageBar)    stageBar.style.width = pct + '%';
  }
}

/**
 * Build config, call the backend, animate the step list, then show results.
 */
async function runProcessing() {
  const config  = buildConfig();
  state.config  = config;

  showPage('page-processing');
  buildStepsList('processing-steps');

  const procFilename = document.getElementById('proc-filename-label');
  if (procFilename && state.filename) procFilename.textContent = state.filename;

  const bar = document.getElementById('process-bar');

  try {
    const result = await api.process(state.datasetId, config);
    state.result  = result;
    const total   = result.logs.length;

    result.logs.forEach((log, i) => {
      setTimeout(() => {
        const stepKey  = log.step;
        const stepEl   = document.getElementById(`step-${stepKey}`);
        const detailEl = document.getElementById(`step-detail-${stepKey}`);
        const statusEl = document.getElementById(`step-status-${stepKey}`);

        // Mark step done
        if (stepEl) {
          stepEl.className = 'step-item done';
          if (detailEl) detailEl.textContent = log.action.length > 80 ? log.action.slice(0, 80) + '…' : log.action;
          if (statusEl) statusEl.textContent = '✓';
        }

        // Overall progress bar
        const pct = ((i + 1) / total) * 100;
        if (bar) bar.style.width = pct + '%';

        // Sidebar tracker pill
        const trackerPill   = document.getElementById(`tracker-${stepKey}`);
        const trackerStatus = document.getElementById(`tracker-status-${stepKey}`);
        if (trackerPill) {
          trackerPill.style.background   = '#f0fdf4';
          trackerPill.style.borderColor  = '#bbf7d0';
        }
        if (trackerStatus) {
          trackerStatus.textContent  = '✓';
          trackerStatus.style.color  = 'var(--success, #3d7a5e)';
        }

        // Sidebar counters
        const nextStep = STEPS[i + 1];
        updateProcSidebar(i + 1, total, nextStep || STEPS[i]);

        // On last step, navigate to results
        if (i === total - 1) {
          const stageNameEl = document.getElementById('proc-stage-name');
          const stageDescEl = document.getElementById('proc-stage-desc');
          const stageBar    = document.getElementById('proc-stage-bar');
          if (stageNameEl) stageNameEl.textContent = 'Complete';
          if (stageDescEl) stageDescEl.textContent = 'All steps finished successfully.';
          if (stageBar)    stageBar.style.width = '100%';
          setTimeout(() => { buildResults(); showPage('page-results'); }, 700);
        }
      }, i * 300);
    });
  } catch (e) {
    showPage('page-dashboard');
    showAlert('dash-alert', `Processing failed: ${e.message}`);
  }
}

// ── 8. RESULTS ────────────────────────────────────────────────────────────────

/** Populate the results page from state.result. */
function buildResults() {
  const r = state.result;

  document.getElementById('res-rows-before').textContent = r.rows_before;
  document.getElementById('res-rows-after').textContent  = r.rows_after;
  document.getElementById('res-cols-before').textContent = r.cols_before;
  document.getElementById('res-cols-after').textContent  = r.cols_after;

  document.getElementById('dl-csv-btn').href      = api.downloadUrl(state.datasetId);
  document.getElementById('dl-pipeline-btn').href = api.pipelineUrl(state.datasetId);

  // ydata-profiling report
  const reportCard   = document.getElementById('report-card');
  const reportIframe = document.getElementById('report-iframe');
  const dlReportBtn  = document.getElementById('dl-report-btn');
  if (r.report_available) {
    reportIframe.src   = api.reportUrl(state.datasetId);
    dlReportBtn.href   = api.downloadReportUrl(state.datasetId);
    reportCard.style.display = '';
  } else {
    if (reportCard) {
      reportCard.style.display = '';
      reportIframe.removeAttribute('src');
      reportCard.querySelector('p').textContent = 'Generating profiling report. This can take a little longer on hosted deployments.';
    }
    if (r.report_pending) pollForReport();
  }

  // Transformation log
  const logsEl = document.getElementById('result-logs');
  logsEl.innerHTML = '';
  r.logs.forEach(log => {
    const div = document.createElement('div');
    const isSkipped = log.action.toLowerCase().includes('skipped') || log.action.toLowerCase().includes('no ');
    div.className = `log-entry ${isSkipped ? 'skipped' : 'success'}`;
    div.style.cssText = 'margin:0;';
    div.innerHTML = `
      <div class="log-step">${log.step.replace(/_/g, ' ')}</div>
      <div class="log-action">${log.action}</div>
      <div class="log-impact">${log.impact || ''}</div>
    `;
    logsEl.appendChild(div);
  });
}

/** Poll until the profiling report is ready or fails. */
async function pollForReport() {
  const reportCard = document.getElementById('report-card');
  const reportIframe = document.getElementById('report-iframe');
  const dlReportBtn = document.getElementById('dl-report-btn');
  const reportText = reportCard?.querySelector('p');

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const status = await api.reportStatus(state.datasetId);
      if (status.report_available) {
        if (reportText) {
          reportText.textContent = 'Complete statistical analysis of your cleaned dataset - correlations, distributions, missing value patterns, and more.';
        }
        reportIframe.src = api.reportUrl(state.datasetId);
        dlReportBtn.href = api.downloadReportUrl(state.datasetId);
        return;
      }

      if (status.report_status === 'error') {
        if (reportText) {
          reportText.textContent = `Profiling report could not be generated${status.report_error ? `: ${status.report_error}` : '.'}`;
        }
        return;
      }
    } catch (e) {
      const transient = e.message.includes('(502)') || e.message.includes('Failed to fetch');
      if (!transient) {
        if (reportText) reportText.textContent = `Unable to check report status: ${e.message}`;
        return;
      }

      if (reportText) {
        reportText.textContent = 'Report generation is still in progress. The server is taking a little longer than expected.';
      }
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  if (reportText) {
    reportText.textContent = 'Profiling report is taking longer than expected. Please check again in a bit.';
  }
}

// ── 9. INIT / EVENT BINDINGS ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initUpload();
  showPage('page-upload');
  setMode('auto');

  // Primary actions
  document.getElementById('run-btn')?.addEventListener('click', runProcessing);

  document.getElementById('back-btn')?.addEventListener('click', () => showPage('page-upload'));

  document.getElementById('restart-btn')?.addEventListener('click', () => {
    state.datasetId = null;
    state.profile   = null;
    document.getElementById('file-input').value          = '';
    document.getElementById('upload-btn').disabled       = false;
    document.getElementById('upload-btn').innerHTML      = '⬆ Upload CSV';
    showPage('page-upload');
  });

  // Mode cards
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => setMode(card.dataset.mode));
  });

  // VIF toggle
  document.getElementById('vif-toggle')?.addEventListener('change', function () {
    document.getElementById('vif-options')?.classList.toggle('hidden', !this.checked);
  });

  // RFE toggle
  document.getElementById('rfe-toggle')?.addEventListener('change', function () {
    document.getElementById('rfe-options')?.classList.toggle('hidden', !this.checked);
  });

  // Column select-all / clear
  document.getElementById('select-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('#col-remove-list .col-item').forEach(el => el.classList.add('selected'));
    updateRemoveCount();
  });

  document.getElementById('clear-sel-btn')?.addEventListener('click', () => {
    document.querySelectorAll('#col-remove-list .col-item').forEach(el => el.classList.remove('selected'));
    updateRemoveCount();
  });
});

/**
 * api.js — Backend communication layer
 *
 * All fetch calls to the Python backend (localhost:8000) live here.
 * The rest of the app imports `api.*` and never calls fetch directly.
 */

// Auto-detect: empty string = same origin (works on Render), fallback to localhost for dev
const BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:8000'
  : '';

const api = {
  /**
   * Upload a CSV file to the backend.
   * @param {File} file
   * @returns {Promise<{ dataset_id: string, filename: string }>}
   */
  async upload(file) {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${BASE_URL}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Upload failed (${res.status})`);
    }

    return res.json();
  },

  /**
   * Fetch a dataset profile (column stats, preview, shape).
   * @param {string} datasetId
   * @returns {Promise<Object>} profile object
   */
  async profile(datasetId) {
    const res = await fetch(`${BASE_URL}/profile/${datasetId}`);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Profile failed (${res.status})`);
    }

    return res.json();
  },

  /**
   * Run the preprocessing pipeline with a given config.
   * @param {string} datasetId
   * @param {Object} config  — built by buildConfig() in app.js
   * @returns {Promise<Object>} result object with logs, row/col counts, etc.
   */
  async process(datasetId, config) {
    const res = await fetch(`${BASE_URL}/process/${datasetId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Processing failed (${res.status})`);
    }

    return res.json();
  },

  /**
   * Returns the URL to download the cleaned CSV.
   * @param {string} datasetId
   * @returns {string}
   */
  downloadUrl(datasetId) {
    return `${BASE_URL}/download/${datasetId}`;
  },

  /**
   * Returns the URL to download the generated Python pipeline script.
   * @param {string} datasetId
   * @returns {string}
   */
  pipelineUrl(datasetId) {
    return `${BASE_URL}/pipeline/${datasetId}`;
  },

  /**
   * Returns the URL to view the ydata-profiling HTML report inline.
   * @param {string} datasetId
   * @returns {string}
   */
  reportUrl(datasetId) {
    return `${BASE_URL}/report/${datasetId}`;
  },

  /**
   * Returns the URL to download the ydata-profiling HTML report.
   * @param {string} datasetId
   * @returns {string}
   */
  downloadReportUrl(datasetId) {
    return `${BASE_URL}/download-report/${datasetId}`;
  },
};

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const BASE_TITLE = 'ComfyUI-portable-launcher';
const POLL_MS = 1000;

const progressMonitor = (() => {
  const win = getCurrentWindow();
  let key = null;
  let port = 0;
  let timer = null;
  let pollBusy = false;
  let active = false;
  let pending = 0;
  let stepPercent = null;
  let sawPercent = false;

  function paint() {
    let title = BASE_TITLE;
    let bar = null;
    let indeterminate = false;
    if (active) {
      if (stepPercent !== null) {
        const queued = pending > 0 ? ` +${pending}` : '';
        title = `[${stepPercent}%]${queued} 生图中`;
        bar = stepPercent;
      } else if (sawPercent) {
        title = '生图中';
        indeterminate = true;
      } else {
        title = '生图中';
      }
    } else if (pending > 0) {
      title = `[队列 ${pending}] 等待中`;
      indeterminate = true;
    }
    win.setTitle(title).catch(() => {});
    if (bar !== null) {
      win.setProgressBar({ status: 'normal', progress: bar }).catch(() => {});
    } else if (indeterminate) {
      win.setProgressBar({ status: 'indeterminate' }).catch(() => {});
    } else {
      win.setProgressBar({ status: 'none' }).catch(() => {});
    }
  }

  function resetState() {
    active = false;
    pending = 0;
    stepPercent = null;
    sawPercent = false;
  }

  async function poll() {
    if (pollBusy || key === null) return;
    pollBusy = true;
    try {
      const body = await invoke('get_queue_snapshot', { port });
      const data = JSON.parse(body);
      const running = Array.isArray(data.queue_running) ? data.queue_running.length : 0;
      pending = Array.isArray(data.queue_pending) ? data.queue_pending.length : 0;
      if (running > 0) {
        active = true;
      } else {
        active = false;
        stepPercent = null;
        sawPercent = false;
      }
      paint();
    } catch (e) {
      /* instance not serving yet */
    }
    pollBusy = false;
  }

  function feed(line) {
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const m = clean.match(/(\d{1,3})%\|/);
    if (m) {
      const pct = parseInt(m[1], 10);
      if (pct >= 0 && pct <= 100) {
        active = true;
        stepPercent = pct;
        sawPercent = true;
        paint();
      }
      return;
    }
    if (/Prompt executed in/.test(clean)) {
      stepPercent = null;
      paint();
    }
  }

  return {
    sync({ selectedId, instanceStates, config }) {
      const inst = config?.instances?.find((i) => i.id === selectedId);
      const st = instanceStates[selectedId];
      const portArg = inst?.port || 8188;
      const targetKey = inst && (st?.status === 'running' || st?.status === 'starting')
        ? `${selectedId}:${portArg}`
        : null;
      if (targetKey === key) return;
      if (timer) {
        window.clearInterval(timer);
        timer = null;
      }
      key = targetKey;
      resetState();
      paint();
      if (key === null) return;
      port = portArg;
      poll();
      timer = window.setInterval(poll, POLL_MS);
    },
    feed(line) {
      if (key !== null) feed(line);
    },
  };
})();

export default progressMonitor;

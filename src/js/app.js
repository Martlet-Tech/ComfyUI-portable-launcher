import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import ansiLog from './ansiLog.js';

const configService = {
  async read() {
    return await invoke('read_config');
  },
  async write(config) {
    await invoke('write_config', { config });
  },
  async getConfigPath() {
    return await invoke('get_config_path');
  },
  async getSystemProxy() {
    return await invoke('get_system_proxy');
  },
};

const instanceService = {
  async selectFolder() {
    return await invoke('select_folder');
  },
  async launchInstance(params) {
    return await invoke('launch_instance', params);
  },
  async stopInstance(pid) {
    await invoke('stop_instance', { pid });
  },
  async checkPort(port) {
    return await invoke('check_port', { port });
  },
  async checkPaths(paths) {
    return await invoke('check_paths', { paths });
  },
  async runUpdate(params) {
    return await invoke('run_update', params);
  },
  async rebuildTrayMenu() {
    await invoke('rebuild_tray_menu');
  },
  async openInExplorer(path) {
    await invoke('open_in_explorer', { path });
  },
  async openUrl(url) {
    await invoke('open_url', { url });
  },
  async getComfyuiHelp(path) {
    return await invoke('get_comfyui_help', { path });
  },
  async getStatusSnapshot(params) {
    return await invoke('get_status_snapshot', params);
  },
  async getGitHash(params) {
    return await invoke('get_git_hash', params);
  },
};

function createTopbar(handlers) {
  const settingsBtn = document.getElementById('settingsBtn');
  const addBtn = document.getElementById('addBtn');
  const removeBtn = document.getElementById('removeBtn');
  settingsBtn.addEventListener('click', handlers.onSettings);
  addBtn.addEventListener('click', handlers.onAdd);
  removeBtn.addEventListener('click', handlers.onRemove);
  return {
    setRemoveEnabled(enabled) {
      removeBtn.disabled = !enabled;
    },
  };
}

function createInstanceList(container, handlers) {
  function render(instances, selectedId, instanceStates) {
    container.innerHTML = '';
    if (!instances || instances.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无实例，点 + 添加</div>';
      return;
    }
    for (const inst of instances) {
      const div = document.createElement('div');
      div.className = 'instance-item';
      const st = instanceStates[inst.id] || { status: 'stopped' };
      div.classList.add('status-' + st.status);
      if (inst.id === selectedId) div.classList.add('selected');
      const name = inst.alias || inst.path.split('\\').pop() || inst.path;
      div.innerHTML = `<div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(inst.path)}</div>`;
      div.addEventListener('click', () => handlers.onSelect(inst.id));
      container.appendChild(div);
    }
  }
  return { render };
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function createInstanceDetail(container, handlers) {
  const aliasInput = document.getElementById('instanceAlias');
  const pathLabel = document.getElementById('instancePath');
  const portInput = document.getElementById('instancePort');
  const customArgsInput = document.getElementById('customArgs');
  const argsPreview = document.getElementById('argsPreview');
  const pathRows = document.getElementById('pathRows');
  const launchBtns = container.querySelectorAll('.launch-btn');
  const stopBtn = container.querySelector('.stop-btn');
  const openWebBtn = document.getElementById('openWebBtn');
  const updateBtns = container.querySelectorAll('.update-btn');

  const pathDefs = [
    { key: 'output_directory', label: 'Output 目录' },
    { key: 'input_directory', label: 'Input 目录' },
    { key: 'temp_directory', label: 'Temp 目录' },
    { key: 'user_directory', label: 'User 目录' },
  ];

  let currentInstance = null;
  let pathInputs = {};

  launchBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentInstance) handlers.onLaunch(currentInstance.id, btn.dataset.mode);
    });
  });
  stopBtn.addEventListener('click', () => {
    if (currentInstance) handlers.onStop(currentInstance.id);
  });
  openWebBtn.addEventListener('click', () => {
    if (currentInstance) handlers.onOpenWeb(currentInstance.id, currentInstance.port || 8188);
  });
  updateBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentInstance) handlers.onUpdate(currentInstance.id, btn.dataset.type);
    });
  });
  aliasInput.addEventListener('change', () => {
    if (currentInstance) handlers.onAliasChange(currentInstance.id, aliasInput.value);
  });
  portInput.addEventListener('change', () => {
    if (currentInstance) {
      handlers.onPortChange(currentInstance.id, parseInt(portInput.value) || 8188);
      updateArgsPreview(currentInstance);
    }
  });
  customArgsInput.addEventListener('change', () => {
    if (currentInstance) {
      handlers.onCustomArgsChange(currentInstance.id, customArgsInput.value);
      currentInstance.custom_args = customArgsInput.value || null;
      updateArgsPreview(currentInstance);
    }
  });

  const helpBtn = document.getElementById('helpBtn');
  const helpTooltip = document.getElementById('helpTooltip');
  const helpContent = document.getElementById('helpContent');
  let helpLoading = false;
  helpBtn.addEventListener('click', async () => {
    if (helpLoading) return;
    if (!helpTooltip.classList.contains('hidden')) {
      helpTooltip.classList.add('hidden');
      return;
    }
    helpContent.textContent = '加载中...';
    helpTooltip.classList.remove('hidden');
    helpLoading = true;
    try {
      const text = await instanceService.getComfyuiHelp(currentInstance.path);
      helpContent.textContent = text;
    } catch (e) {
      helpContent.textContent = '获取参数列表失败: ' + e;
    } finally {
      helpLoading = false;
    }
  });
  document.addEventListener('click', (e) => {
    if (!helpTooltip.classList.contains('hidden') && !helpTooltip.contains(e.target) && e.target !== helpBtn) {
      helpTooltip.classList.add('hidden');
    }
  });

  function render(instance, instanceStates) {
    helpTooltip.classList.add('hidden');
    currentInstance = instance;
    container.classList.remove('hidden');
    pathLabel.textContent = instance.path;
    aliasInput.value = instance.alias || '';
    portInput.value = instance.port || 8188;
    customArgsInput.value = instance.custom_args || '';
    updateArgsPreview(instance);

    const st = instanceStates[instance.id] || { status: 'stopped' };
    const isRunning = st.status === 'running';
    const isStarting = st.status === 'starting';
    const isUpdating = st.updating === true;
    launchBtns.forEach(b => b.classList.toggle('hidden', isRunning || isStarting));
    stopBtn.classList.toggle('hidden', !isRunning);
    openWebBtn.classList.toggle('hidden', !isRunning);
    launchBtns.forEach(b => b.disabled = isStarting);
    updateBtns.forEach(b => b.disabled = isStarting || isRunning || isUpdating);
    renderPathRows(instance);

    const logSection = document.getElementById('startupLogSection');
    const logContent = document.getElementById('startupLogContent');
    const log = st.log || '';
    if (log || isStarting || isUpdating) {
      const wasHidden = logSection.classList.contains('hidden');
      logSection.classList.remove('hidden');
      if (wasHidden && st.autoScroll === false) st.autoScroll = true;
      logContent.innerHTML = st.logHtml || '';
      scrollLogIfPinned(logContent, st);
    } else {
      logSection.classList.add('hidden');
    }
  }

  function buildArgsPreview(inst) {
    const mainPy = inst.path + '\\ComfyUI\\main.py';
    const parts = ['-s', mainPy, '--windows-standalone-build', '--port', String(inst.port || 8188)];
    const dirs = [
      ['--output-directory', inst.output_directory],
      ['--input-directory', inst.input_directory],
      ['--temp-directory', inst.temp_directory],
      ['--user-directory', inst.user_directory],
    ];
    for (const [flag, val] of dirs) {
      if (val && val.trim()) { parts.push(flag, val.trim()); }
    }
    if (inst.custom_args) {
      for (const arg of inst.custom_args.split(/\s+/)) {
        if (arg) parts.push(arg);
      }
    }
    return parts.join(' ');
  }

  function updateArgsPreview(instance) {
    if (!instance) { argsPreview.textContent = ''; return; }
    argsPreview.textContent = buildArgsPreview(instance);
  }

  function renderPathRows(instance) {
    pathRows.innerHTML = '';
    pathInputs = {};

    const instRow = document.createElement('div');
    instRow.className = 'path-row';
    instRow.innerHTML = `
      <span class="path-title">实例目录</span>
      <input type="text" id="path_instance_path" value="${escapeHtml(instance.path)}" />
      <button class="folder-btn" data-key="instance_path">选择</button>
      <button class="open-btn" data-key="instance_path">打开</button>
    `;
    const instInput = instRow.querySelector('input');
    const instFolderBtn = instRow.querySelector('.folder-btn');
    const instOpenBtn = instRow.querySelector('.open-btn');
    pathInputs['instance_path'] = instInput;
    instInput.addEventListener('change', () => {
      handlers.onInstancePathChange(instance.id, instInput.value);
      updateArgsPreview(instance);
    });
    instFolderBtn.addEventListener('click', () => {
      handlers.onSelectFolder(instance.id, 'instance_path');
    });
    instOpenBtn.addEventListener('click', () => {
      handlers.onOpenFolder(instInput.value || instance.path);
    });
    pathRows.appendChild(instRow);

    const sep = document.createElement('hr');
    sep.className = 'path-separator';
    pathRows.appendChild(sep);

    for (const def of pathDefs) {
      const val = instance[def.key] || '';
      const row = document.createElement('div');
      row.className = 'path-row';
      row.innerHTML = `
        <span class="path-title">${def.label}</span>
        <input type="text" id="path_${def.key}" value="${escapeHtml(val)}" />
        <button class="folder-btn" data-key="${def.key}">选择</button>
        ${val ? '<button class="open-btn" data-key="' + def.key + '">打开</button>' : ''}
      `;
      const input = row.querySelector('input');
      const folderBtn = row.querySelector('.folder-btn');
      const openBtn = row.querySelector('.open-btn');
      pathInputs[def.key] = input;
      input.addEventListener('change', () => {
        handlers.onPathChange(instance.id, def.key, input.value);
        updateArgsPreview(instance);
      });
      folderBtn.addEventListener('click', () => {
        handlers.onSelectFolder(instance.id, def.key);
      });
      if (openBtn) {
        openBtn.addEventListener('click', () => {
          handlers.onOpenFolder(input.value);
        });
      }
      pathRows.appendChild(row);
    }
  }

  function setPathError(key, hasError) {
    const input = pathInputs[key];
    if (input) input.classList.toggle('path-error', hasError);
  }

  function setLaunchEnabled(enabled) {
    launchBtns.forEach(b => b.disabled = !enabled);
  }

  return { render, setPathError, setLaunchEnabled };
}

function createSettingsModal(handlers) {
  const modal = document.getElementById('settingsModal');
  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const configPathDisplay = document.getElementById('configPathDisplay');
  const proxyToggle = document.getElementById('settingsProxyToggle');
  const proxyManual = document.getElementById('settingsProxyManual');
  const proxyHost = document.getElementById('settingsProxyHost');
  const proxyPort = document.getElementById('settingsProxyPort');

  proxyToggle.addEventListener('change', () => {
    if (proxyToggle.checked) {
      proxyManual.style.display = 'flex';
    } else {
      proxyManual.style.display = 'none';
    }
    handlers.onProxyChange({
      enabled: proxyToggle.checked,
      host: proxyHost.value || null,
      port: proxyPort.value ? parseInt(proxyPort.value) : null,
    });
  });
  proxyHost.addEventListener('input', () => {
    handlers.onProxyChange({
      enabled: proxyToggle.checked,
      host: proxyHost.value || null,
      port: proxyPort.value ? parseInt(proxyPort.value) : null,
    });
  });
  proxyPort.addEventListener('input', () => {
    handlers.onProxyChange({
      enabled: proxyToggle.checked,
      host: proxyHost.value || null,
      port: proxyPort.value ? parseInt(proxyPort.value) : null,
    });
  });

  function open(configPath) {
    configPathDisplay.textContent = configPath;
    modal.classList.remove('hidden');
  }

  function close() {
    modal.classList.add('hidden');
  }

  function setProxy(config) {
    if (config) {
      proxyToggle.checked = config.enabled;
      if (config.host) proxyHost.value = config.host;
      if (config.port) proxyPort.value = config.port;
      proxyManual.style.display = config.enabled ? 'flex' : 'none';
    }
  }

  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  return { open, close, setProxy };
}

function createLogModal() {
  const modal = document.getElementById('logModal');
  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const content = document.getElementById('logContent');
  function open(text) { content.textContent = text; modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); }
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  return { open, close };
}

function createConflictModal() {
  const modal = document.getElementById('portConflictModal');
  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const msg = document.getElementById('portConflictMsg');
  function open(message) { msg.textContent = message; modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); }
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  return { open, close };
}

const state = {
  config: null,
  selectedId: null,
  instanceStates: {},
  proxy: null,
  isMinimized: false,
  launchStartTime: null,
  accumulatedMs: 0,
  versionCache: {},
};

const listEl = document.getElementById('instanceList');
const detailEl = document.getElementById('instanceDetail');

const listComponent = createInstanceList(listEl, { onSelect: handleSelect });
const detailComponent = createInstanceDetail(detailEl, {
  onLaunch: handleLaunch,
  onStop: handleStop,
  onOpenWeb: handleOpenWeb,
  onUpdate: handleUpdate,
  onAliasChange: handleAliasChange,
  onPortChange: handlePortChange,
  onPathChange: handlePathChange,
  onSelectFolder: handleSelectFolder,
  onInstancePathChange: handleInstancePathChange,
  onOpenFolder: handleOpenFolder,
  onCustomArgsChange: handleCustomArgsChange,
});

const topbar = createTopbar({
  onSettings: handleSettings,
  onAdd: handleAdd,
  onRemove: handleRemove,
});

const settingsModal = createSettingsModal({ onProxyChange: handleProxyChange });
const logModal = createLogModal();
const conflictModal = createConflictModal();

function appendLog(st, text) {
  const parts = text.replace(/\r\n/g, '\n').split('\r');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const cur = st.log || '';
    const curLen = cur.length - (cur.lastIndexOf('\n') + 1);
    if (i > 0 && curLen > 0) {
      const nl = cur.lastIndexOf('\n');
      st.log = cur.slice(0, nl + 1) + seg;
      const html = st.logHtml || '';
      const hnl = html.lastIndexOf('\n');
      st.logHtml = html.slice(0, hnl + 1);
    } else {
      st.log = cur + seg;
    }
    const res = ansiLog.parse(seg, st.ansiState || ansiLog.defaultState);
    st.ansiState = res.state;
    st.logHtml = (st.logHtml || '') + res.html;
  }
}

function resetLog(st) {
  st.log = '';
  st.logHtml = '';
  st.ansiState = { ...ansiLog.defaultState };
}

function scrollLogIfPinned(el, st) {
  if (el && st && st.autoScroll !== false) el.scrollTop = el.scrollHeight;
}

function isNearLogBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
}

function setupLogScrollControls() {
  const el = document.getElementById('startupLogContent');
  el.addEventListener('scroll', () => {
    const st = state.instanceStates[state.selectedId];
    if (!st) return;
    st.autoScroll = isNearLogBottom(el);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'End') return;
    const section = document.getElementById('startupLogSection');
    if (!section || section.classList.contains('hidden')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const st = state.instanceStates[state.selectedId];
    if (st) st.autoScroll = true;
    e.preventDefault();
    el.scrollTop = el.scrollHeight;
  });
}

async function init() {
  state.config = await configService.read();
  state.proxy = state.config.proxy || { enabled: false, host: null, port: null };
  settingsModal.setProxy(state.proxy);
  if (state.config.instances.length > 0) {
    state.selectedId = state.config.instances[0].id;
  }
  renderAll();
  validateAllPaths();
  if (state.selectedId) {
    const inst = state.config.instances.find(i => i.id === state.selectedId);
    if (inst) loadVersion(state.selectedId, inst.path);
  }
  const configPath = await configService.getConfigPath();
  document.getElementById('configPathDisplay').textContent = configPath;

  await listen('instance-log', (event) => {
    const { instance_id, line } = event.payload;
    const st = state.instanceStates[instance_id];
    if (!st) return;
    appendLog(st, line + '\n');
    if (st.status === 'starting') armWatchdog(instance_id);
    if (instance_id === state.selectedId) {
      const el = document.getElementById('startupLogContent');
      if (el) {
        el.innerHTML = st.logHtml || '';
        scrollLogIfPinned(el, st);
      }
    }
  });

  await listen('update-log', (event) => {
    const { instance_id, line } = event.payload;
    const st = state.instanceStates[instance_id];
    if (!st) return;
    appendLog(st, line + '\n');
    if (instance_id === state.selectedId) {
      const el = document.getElementById('startupLogContent');
      if (el) {
        el.innerHTML = st.logHtml || '';
        scrollLogIfPinned(el, st);
      }
    }
  });

  await listen('process-ready', (event) => {
    const { instance_id, pid } = event.payload;
    const st = state.instanceStates[instance_id];
    if (st && (st.status === 'starting' || st.status === 'running')) {
      state.instanceStates[instance_id] = { ...st, status: 'running', pid };
      renderAll();
      minimizeApp();
    }
  });

  await listen('process-exited', (event) => {
    const { instance_id, exit_code } = event.payload;
    const st = state.instanceStates[instance_id];
    if (st && (st.status === 'starting' || st.status === 'running')) {
      clearWatchdog(instance_id);
      const wasRunning = st.status === 'running';
      state.instanceStates[instance_id] = { ...st, status: 'stopped', pid: null };
      renderAll();
      if (wasRunning) {
        conflictModal.open(`ComfyUI 进程已退出 (exit code: ${exit_code})`);
      }
    }
  });

  setupLogScrollControls();
  setInterval(updateStatusBar, 1000);
  setInterval(pollStatusSnapshot, 1000);
}

function renderAll() {
  listComponent.render(state.config.instances, state.selectedId, state.instanceStates);
  if (state.selectedId) {
    const inst = state.config.instances.find(i => i.id === state.selectedId);
    if (inst) {
      detailComponent.render(inst, state.instanceStates);
    } else {
      detailEl.classList.add('hidden');
      state.selectedId = null;
    }
  } else {
    detailEl.classList.add('hidden');
  }
  topbar.setRemoveEnabled(state.selectedId != null);
}

async function saveConfig() {
  state.config.proxy = state.proxy;
  await configService.write(state.config);
  await instanceService.rebuildTrayMenu();
}

async function handleAdd() {
  const folder = await instanceService.selectFolder();
  if (!folder) return;
  const paths = [
    folder + '\\python_embeded\\python.exe',
    folder + '\\ComfyUI\\main.py',
  ];
  const results = await instanceService.checkPaths(paths);
  if (!results.every(Boolean)) {
    conflictModal.open('所选目录不是有效的 ComfyUI Portable 目录（缺少 python_embeded/python.exe 或 ComfyUI/main.py）');
    return;
  }
  const id = crypto.randomUUID();
  state.config.instances.push({
    id,
    path: folder,
    alias: null,
    port: 8188,
    output_directory: null,
    input_directory: null,
    temp_directory: null,
    user_directory: null,
  });
  state.instanceStates[id] = { status: 'stopped', pid: null, log: '', logHtml: '', ansiState: { ...ansiLog.defaultState } };
  state.selectedId = id;
  await saveConfig();
  renderAll();
}

async function handleRemove() {
  if (!state.selectedId) return;
  const idx = state.config.instances.findIndex(i => i.id === state.selectedId);
  if (idx === -1) return;
  const inst = state.config.instances[idx];
  const st = state.instanceStates[inst.id];
  if (st && st.status === 'running') {
    await handleStop(inst.id);
  }
  clearWatchdog(inst.id);
  state.config.instances.splice(idx, 1);
  delete state.instanceStates[inst.id];
  const logSection = document.getElementById('startupLogSection');
  if (logSection) logSection.classList.add('hidden');
  state.selectedId = state.config.instances.length > 0
    ? state.config.instances[Math.min(idx, state.config.instances.length - 1)].id
    : null;
  await saveConfig();
  renderAll();
}

function handleSelect(id) {
  state.selectedId = id;
  const st = state.instanceStates[id];
  if (st) st.autoScroll = true;
  renderAll();
  validatePathsForInstance(id);
  document.getElementById('statusRight').textContent = '...';
  const inst = state.config.instances.find(i => i.id === id);
  if (inst) loadVersion(id, inst.path);
}

async function handleLaunch(id, mode) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  state.launchStartTime = state.launchStartTime || Date.now();
  const port = inst.port || 8188;
  const conflict = await checkPortConflict(id, port);
  if (conflict) {
    conflictModal.open(`端口 ${port} 已被其他实例或程序占用。请修改端口后再试。`);
    return;
  }
  state.instanceStates[id] = { status: 'starting', pid: null, log: '', logHtml: '', ansiState: { ...ansiLog.defaultState }, watchdog: null };
  renderAll();
  try {
    const pid = await instanceService.launchInstance({
      instanceId: id,
      path: inst.path,
      mode,
      port,
      customArgs: inst.custom_args || null,
      outputDirectory: inst.output_directory || null,
      inputDirectory: inst.input_directory || null,
      tempDirectory: inst.temp_directory || null,
      userDirectory: inst.user_directory || null,
      proxy: state.proxy.enabled ? state.proxy : null,
    });
    state.instanceStates[id] = { ...state.instanceStates[id], pid };
    renderAll();
    armWatchdog(id);
    await pollPort(id, port);
    clearWatchdog(id);
  } catch (err) {
    clearWatchdog(id);
    const prev = state.instanceStates[id] || {};
    state.instanceStates[id] = { ...prev, status: 'stopped', pid: null };
    renderAll();
    conflictModal.open(`启动失败: ${err}`);
  }
}

async function checkPortConflict(excludeId, port) {
  for (const inst of state.config.instances) {
    if (inst.id === excludeId) continue;
    const st = state.instanceStates[inst.id];
    if (st && (st.status === 'running' || st.status === 'starting')) {
      if ((inst.port || 8188) === port) return true;
    }
  }
  return await instanceService.checkPort(port);
}

const STARTUP_TIMEOUT_MS = 60000;

function armWatchdog(id) {
  clearWatchdog(id);
  const st = state.instanceStates[id];
  if (!st || st.status !== 'starting') return;
  st.watchdog = window.setTimeout(() => onWatchdogTimeout(id), STARTUP_TIMEOUT_MS);
}

function clearWatchdog(id) {
  const st = state.instanceStates[id];
  if (st && st.watchdog) {
    clearTimeout(st.watchdog);
    st.watchdog = null;
  }
}

function onWatchdogTimeout(id) {
  const st = state.instanceStates[id];
  if (!st || st.status !== 'starting') return;
  st.watchdog = null;
  appendLog(st, `[警告] 启动超时: 进程 ${STARTUP_TIMEOUT_MS / 1000} 秒无输出, 仍在等待...\n`);
  renderAll();
  conflictModal.open(`启动超时: 进程 ${STARTUP_TIMEOUT_MS / 1000} 秒无输出。\n\n后台进程仍在继续追踪, 若恢复输出并启动成功将自动变为运行中。`);
}

async function pollPort(id, port) {
  while (true) {
    await sleep(1000);
    const st = state.instanceStates[id];
    if (!st || st.status !== 'starting') return;
    if (await instanceService.checkPort(port)) {
      state.instanceStates[id] = { ...st, status: 'running' };
      renderAll();
      minimizeApp();
      return;
    }
  }
}

async function handleStop(id) {
  const st = state.instanceStates[id];
  if (!st || !st.pid) return;
  clearWatchdog(id);
  if (state.launchStartTime !== null) {
    state.accumulatedMs += Date.now() - state.launchStartTime;
    state.launchStartTime = null;
  }
  try { await instanceService.stopInstance(st.pid); } catch (_) {}
  state.instanceStates[id] = { ...st, status: 'stopped', pid: null };
  renderAll();
}

async function handleOpenWeb(id, port) {
  await instanceService.openUrl('http://127.0.0.1:' + port);
}

async function handleUpdate(id, type) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  const st = state.instanceStates[id] || (state.instanceStates[id] = { status: 'stopped', log: '', logHtml: '', ansiState: { ...ansiLog.defaultState } });
  st.updating = true;
  resetLog(st);
  renderAll();
  try {
    await instanceService.runUpdate({
      instanceId: id,
      path: inst.path,
      updateType: type,
      proxy: state.proxy.enabled ? state.proxy : null,
    });
    appendLog(st, '✓ 更新完成\n');
  } catch (err) {
    appendLog(st, '✗ 更新失败: ' + (typeof err === 'string' ? err : JSON.stringify(err)) + '\n');
  } finally {
    st.updating = false;
    renderAll();
  }
}

async function handleAliasChange(id, alias) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  inst.alias = alias || null;
  await saveConfig();
  renderAll();
}

async function handlePortChange(id, port) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  inst.port = port;
  await saveConfig();
}

async function handleCustomArgsChange(id, value) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  inst.custom_args = value || null;
  await saveConfig();
}

async function handlePathChange(id, key, value) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  inst[key] = value || null;
  await saveConfig();
  validatePathsForInstance(id);
}

async function handleInstancePathChange(id, value) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  inst.path = value;
  await saveConfig();
  renderAll();
  validatePathsForInstance(id);
}

async function handleOpenFolder(path) {
  if (!path || !path.trim()) return;
  try { await instanceService.openInExplorer(path.trim()); } catch (_) {}
}

async function handleSelectFolder(id, key) {
  const folder = await instanceService.selectFolder();
  if (!folder) return;
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  if (key === 'instance_path') {
    inst.path = folder;
  } else {
    inst[key] = folder;
  }
  await saveConfig();
  renderAll();
  validatePathsForInstance(id);
}

function handleSettings() {
  const el = document.getElementById('configPathDisplay');
  settingsModal.open(el.textContent);
}

function handleProxyChange(proxy) {
  state.proxy = proxy;
  saveConfig();
}

async function validateAllPaths() {
  for (const inst of state.config.instances) {
    await validatePathsForInstance(inst.id);
  }
}

async function validatePathsForInstance(id) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst || inst.id !== state.selectedId) return;

  const exePaths = [
    inst.path + '\\python_embeded\\python.exe',
    inst.path + '\\ComfyUI\\main.py',
  ];
  const exeResults = await instanceService.checkPaths(exePaths);
  const instancePathError = !exeResults.every(Boolean);
  detailComponent.setPathError('instance_path', instancePathError);

  const pathKeys = ['output_directory', 'input_directory', 'temp_directory', 'user_directory'];
  let hasError = instancePathError;
  for (const key of pathKeys) {
    const val = inst[key];
    if (val && val.trim()) {
      const exists = await instanceService.checkPaths([val.trim()]);
      const isError = !exists[0];
      detailComponent.setPathError(key, isError);
      if (isError) hasError = true;
    } else {
      detailComponent.setPathError(key, false);
    }
  }
  detailComponent.setLaunchEnabled(!hasError);
}

async function minimizeApp() {
  if (state.isMinimized) return;
  state.isMinimized = true;
  try { await getCurrentWindow().minimize(); } catch (_) {}
}

async function loadVersion(id, path) {
  const el = document.getElementById('statusRight');
  if (state.versionCache[id]) {
    el.textContent = state.versionCache[id];
    return;
  }
  el.textContent = '...';
  try {
    const hash = await instanceService.getGitHash({ path });
    if (hash) {
      state.versionCache[id] = 'v' + hash;
      el.textContent = 'v' + hash;
    } else {
      el.textContent = '--';
    }
  } catch (_) {
    el.textContent = '--';
  }
}

function updateStatusBar() {
  const leftEl = document.getElementById('statusLeft');
  let displayMs = state.accumulatedMs;
  if (state.launchStartTime !== null) {
    displayMs += Date.now() - state.launchStartTime;
  }
  if (displayMs > 0) {
    const secs = Math.floor(displayMs / 1000);
    const mins = Math.floor(secs / 60);
    const hrs = Math.floor(mins / 60);
    if (hrs > 0) {
      leftEl.textContent = `${hrs}h${mins % 60}m`;
    } else if (mins > 0) {
      leftEl.textContent = `${mins}m${secs % 60}s`;
    } else {
      leftEl.textContent = `${secs}s`;
    }
  } else {
    leftEl.textContent = '--';
  }
}

async function pollStatusSnapshot() {
  const centerEl = document.getElementById('statusCenter');
  if (!state.selectedId) {
    centerEl.textContent = 'Mem --  VRAM --';
    return;
  }
  const st = state.instanceStates[state.selectedId];
  if (!st || st.status !== 'running' || !st.pid) {
    centerEl.textContent = 'Mem --  VRAM --';
    return;
  }
  const inst = state.config.instances.find(i => i.id === state.selectedId);
  if (!inst) return;
  try {
    const snap = await instanceService.getStatusSnapshot({ pid: st.pid, path: inst.path });
    const processMem = snap.process_ram_mb != null ? snap.process_ram_mb + 'M' : '--';
    const totalMem = snap.total_ram_mb > 0 ? (snap.total_ram_mb / 1024).toFixed(0) + 'G' : '--';
    const gpuUsed = snap.gpu_used_mb > 0 ? (snap.gpu_used_mb / 1024).toFixed(1) + 'G' : '--';
    const gpuTotal = snap.gpu_total_mb > 0 ? (snap.gpu_total_mb / 1024).toFixed(0) + 'G' : '--';
    centerEl.textContent = `Mem ${processMem}/${totalMem}  VRAM ${gpuUsed}/${gpuTotal}`;
  } catch (_) {
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    document.body.innerHTML = '<div style="padding:40px;color:red;font-size:14px;white-space:pre-wrap">初始化错误: ' + err + '</div>';
  });
});

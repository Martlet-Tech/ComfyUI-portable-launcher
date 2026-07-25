import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
      if (st.status === 'starting') {
        const overlay = document.createElement('div');
        overlay.className = 'stripe-overlay';
        div.appendChild(overlay);
      }
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
  const pathRows = document.getElementById('pathRows');
  const launchBtns = container.querySelectorAll('.launch-btn');
  const stopBtn = container.querySelector('.stop-btn');
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
  updateBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentInstance) handlers.onUpdate(currentInstance.id, btn.dataset.type);
    });
  });
  aliasInput.addEventListener('change', () => {
    if (currentInstance) handlers.onAliasChange(currentInstance.id, aliasInput.value);
  });
  portInput.addEventListener('change', () => {
    if (currentInstance) handlers.onPortChange(currentInstance.id, parseInt(portInput.value) || 8188);
  });

  function render(instance, instanceStates) {
    currentInstance = instance;
    container.classList.remove('hidden');
    pathLabel.textContent = instance.path;
    aliasInput.value = instance.alias || '';
    portInput.value = instance.port || 8188;

    const st = instanceStates[instance.id] || { status: 'stopped' };
    const isRunning = st.status === 'running';
    const isStarting = st.status === 'starting';
    launchBtns.forEach(b => b.classList.toggle('hidden', isRunning || isStarting));
    stopBtn.classList.toggle('hidden', !isRunning);
    launchBtns.forEach(b => b.disabled = isStarting);
    updateBtns.forEach(b => b.disabled = isStarting || isRunning);
    renderPathRows(instance);
  }

  function renderPathRows(instance) {
    pathRows.innerHTML = '';
    pathInputs = {};
    for (const def of pathDefs) {
      const row = document.createElement('div');
      row.className = 'path-row';
      row.innerHTML = `
        <span class="path-title">${def.label}</span>
        <input type="text" id="path_${def.key}" value="${escapeHtml(instance[def.key] || '')}" />
        <button class="folder-btn" data-key="${def.key}">选择</button>
      `;
      const input = row.querySelector('input');
      const folderBtn = row.querySelector('.folder-btn');
      pathInputs[def.key] = input;
      input.addEventListener('change', () => {
        handlers.onPathChange(instance.id, def.key, input.value);
      });
      folderBtn.addEventListener('click', async () => {
        handlers.onSelectFolder(instance.id, def.key);
      });
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
};

const listEl = document.getElementById('instanceList');
const detailEl = document.getElementById('instanceDetail');

const listComponent = createInstanceList(listEl, { onSelect: handleSelect });
const detailComponent = createInstanceDetail(detailEl, {
  onLaunch: handleLaunch,
  onStop: handleStop,
  onUpdate: handleUpdate,
  onAliasChange: handleAliasChange,
  onPortChange: handlePortChange,
  onPathChange: handlePathChange,
  onSelectFolder: handleSelectFolder,
});

const topbar = createTopbar({
  onSettings: handleSettings,
  onAdd: handleAdd,
  onRemove: handleRemove,
});

const settingsModal = createSettingsModal({ onProxyChange: handleProxyChange });
const logModal = createLogModal();
const conflictModal = createConflictModal();

async function init() {
  state.config = await configService.read();
  state.proxy = state.config.proxy || { enabled: false, host: null, port: null };
  settingsModal.setProxy(state.proxy);
  if (state.config.instances.length > 0) {
    state.selectedId = state.config.instances[0].id;
  }
  renderAll();
  validateAllPaths();
  const configPath = await configService.getConfigPath();
  document.getElementById('configPathDisplay').textContent = configPath;
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
  state.instanceStates[id] = { status: 'stopped', pid: null };
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
  state.config.instances.splice(idx, 1);
  delete state.instanceStates[inst.id];
  state.selectedId = state.config.instances.length > 0
    ? state.config.instances[Math.min(idx, state.config.instances.length - 1)].id
    : null;
  await saveConfig();
  renderAll();
}

function handleSelect(id) {
  state.selectedId = id;
  renderAll();
  validatePathsForInstance(id);
}

async function handleLaunch(id, mode) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  const port = inst.port || 8188;
  const conflict = await checkPortConflict(id, port);
  if (conflict) {
    conflictModal.open(`端口 ${port} 已被其他实例或程序占用。请修改端口后再试。`);
    return;
  }
  state.instanceStates[id] = { status: 'starting', pid: null };
  renderAll();
  try {
    const pid = await instanceService.launchInstance({
      path: inst.path,
      mode,
      port,
      outputDirectory: inst.output_directory || null,
      inputDirectory: inst.input_directory || null,
      tempDirectory: inst.temp_directory || null,
      userDirectory: inst.user_directory || null,
      proxy: state.proxy.enabled ? state.proxy : null,
    });
    state.instanceStates[id] = { status: 'starting', pid };
    renderAll();
    await pollPort(id, port);
  } catch (err) {
    state.instanceStates[id] = { status: 'stopped', pid: null };
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

async function pollPort(id, port) {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = state.instanceStates[id];
    if (!st || st.status === 'stopped') return;
    if (await instanceService.checkPort(port)) {
      state.instanceStates[id] = { ...st, status: 'running' };
      renderAll();
      minimizeApp();
      return;
    }
  }
  const st = state.instanceStates[id];
  if (st && st.status === 'starting') {
    state.instanceStates[id] = { ...st, status: 'stopped' };
    renderAll();
    conflictModal.open('启动超时：端口 ' + port + ' 在 60 秒内未就绪');
  }
}

async function handleStop(id) {
  const st = state.instanceStates[id];
  if (!st || !st.pid) return;
  try { await instanceService.stopInstance(st.pid); } catch (_) {}
  state.instanceStates[id] = { status: 'stopped', pid: null };
  renderAll();
}

async function handleUpdate(id, type) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  try {
    const output = await instanceService.runUpdate({
      path: inst.path,
      updateType: type,
      proxy: state.proxy.enabled ? state.proxy : null,
    });
    const logText = typeof output === 'string' ? output : JSON.stringify(output);
    if (logText && logText.trim()) logModal.open(logText);
  } catch (err) {
    logModal.open(typeof err === 'string' ? err : JSON.stringify(err));
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

async function handlePathChange(id, key, value) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  inst[key] = value || null;
  await saveConfig();
  validatePathsForInstance(id);
}

async function handleSelectFolder(id, key) {
  const folder = await instanceService.selectFolder();
  if (!folder) return;
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  inst[key] = folder;
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
  const pathKeys = ['output_directory', 'input_directory', 'temp_directory', 'user_directory'];
  let hasError = false;
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    document.body.innerHTML = '<div style="padding:40px;color:red;font-size:14px;white-space:pre-wrap">初始化错误: ' + err + '</div>';
  });
});

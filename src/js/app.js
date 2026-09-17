import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import ansiLog from './ansiLog.js';

const LAUNCH_MODES = ['gpu', 'cpu', 'gpu_fastfp16'];
const MODE_LABELS = { gpu: 'GPU', cpu: 'CPU', gpu_fastfp16: 'GPU Fast FP16' };

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
  async testGitProxy(params) {
    return await invoke('test_git_proxy', params);
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
  async getCloseAction() {
    return await invoke('get_close_action');
  },
  async setCloseAction(action) {
    await invoke('set_close_action', { action });
  },
  async resolveClose(action) {
    await invoke('resolve_close', { action });
  },
};

const LOG_MAX_LINES = 3000;
const LOG_BOTTOM_EPSILON = 24;

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function isValidPort(v) {
  if (v === null || v === undefined || String(v).trim() === '') return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

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

function createSidebar(handlers) {
  const el = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  const countEl = document.getElementById('sidebarCount');

  function setCollapsed(collapsed) {
    el.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? '展开实例列表' : '收缩实例列表';
  }

  function toggleCollapsed() {
    const next = !el.classList.contains('collapsed');
    setCollapsed(next);
    handlers.onToggle(next);
  }

  toggle.addEventListener('click', toggleCollapsed);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.classList.contains('collapsed')) {
      setCollapsed(true);
      handlers.onToggle(true);
    }
  });

  return {
    setCollapsed,
    setCount(n) { countEl.textContent = String(n); },
    isCollapsed() { return el.classList.contains('collapsed'); },
  };
}

function createTabBar(handlers) {
  const nav = document.getElementById('tabBar');
  const tabs = Array.from(nav.querySelectorAll('.tab'));
  const panels = tabs.map(t => document.getElementById(t.getAttribute('aria-controls')));
  let current = tabs[0].dataset.tab;

  function activate(name, focus) {
    if (!tabs.some(t => t.dataset.tab === name)) return;
    current = name;
    tabs.forEach((tab, i) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[i].classList.toggle('is-active', on);
      panels[i].hidden = !on;
      if (on && focus) tab.focus();
    });
    handlers.onChange(name);
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab.dataset.tab, false));
    tab.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      activate(tabs[next].dataset.tab, true);
    });
  });

  return {
    activate,
    current() { return current; },
    setBadge(name, text) {
      const badge = document.getElementById('tabBadge-' + name);
      if (!badge) return;
      badge.textContent = text || '';
      badge.classList.toggle('hidden', !text);
    },
  };
}

function createInstanceList(container, handlers) {
  function render(instances, selectedId, instanceStates) {
    container.innerHTML = '';
    if (!instances || instances.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无实例<br />点右上角 + 添加</div>';
      return;
    }
    instances.forEach((inst, idx) => {
      const div = document.createElement('div');
      div.className = 'instance-item';
      const st = instanceStates[inst.id] || { status: 'stopped' };
      div.classList.add('status-' + st.status);
      if (inst.id === selectedId) div.classList.add('selected');
      div.style.setProperty('--i', String(idx));
      const name = inst.alias || inst.path.split('\\').pop() || inst.path;
      div.innerHTML = `
        <span class="state-dot"></span>
        <div class="inst-item-main">
          <div class="name">${escapeHtml(name)}</div>
          <div class="sub">${escapeHtml(inst.path)}</div>
        </div>
        <span class="inst-item-port">${inst.port || 8188}</span>
      `;
      div.addEventListener('click', () => handlers.onSelect(inst.id));
      container.appendChild(div);
    });
  }
  return { render };
}

function createInstanceDetail(container, handlers) {
  const aliasInput = document.getElementById('instanceAlias');
  const pathLabel = document.getElementById('instancePath');
  const portInput = document.getElementById('instancePort');
  const portError = document.getElementById('portError');
  const customArgsInput = document.getElementById('customArgs');
  const argsPreview = document.getElementById('argsPreview');
  const pathRows = document.getElementById('pathRows');
  const launchBtn = document.getElementById('launchBtn');
  const launchMode = document.getElementById('launchMode');
  const launchModeLabel = document.getElementById('launchModeLabel');
  const stopBtn = container.querySelector('.btn-stop');
  const stopLabel = document.getElementById('stopBtnLabel');
  const openWebBtn = document.getElementById('openWebBtn');
  const updateBtns = container.querySelectorAll('.btn-update');
  const stateBadge = document.getElementById('instStateBadge');
  const consoleSection = document.getElementById('startupLogSection');
  const consoleHead = document.getElementById('consoleHead');
  const consoleBadge = document.getElementById('consoleBadge');
  const consoleToggle = document.getElementById('consoleToggle');

  const pathDefs = [
    { key: 'output_directory', label: 'Output 目录' },
    { key: 'input_directory', label: 'Input 目录' },
    { key: 'temp_directory', label: 'Temp 目录' },
    { key: 'user_directory', label: 'User 目录' },
  ];

  let currentInstance = null;
  let pathInputs = {};
  let pathsValid = true;
  let portsValid = true;
  let isStartingNow = false;

  function refreshLaunchEnabled() {
    const blocked = !pathsValid || !portsValid || isStartingNow;
    launchBtn.disabled = blocked;
    launchMode.disabled = blocked;
  }

  function setLaunchMode(mode) {
    const value = LAUNCH_MODES.includes(mode) ? mode : 'gpu';
    launchMode.value = value;
    launchBtn.dataset.mode = value;
    launchModeLabel.textContent = MODE_LABELS[value];
  }

  function refreshPortValidation() {
    portsValid = isValidPort(portInput.value);
    portInput.classList.toggle('invalid', !portsValid);
    portError.textContent = portsValid ? '' : '端口范围 1 – 65535';
    refreshLaunchEnabled();
    updateArgsPreview(currentInstance);
  }

  launchBtn.addEventListener('click', () => {
    if (currentInstance) handlers.onLaunch(currentInstance.id, launchBtn.dataset.mode || 'gpu');
  });
  launchMode.addEventListener('change', () => {
    if (!currentInstance) return;
    state.launchModes[currentInstance.id] = launchMode.value;
    setLaunchMode(launchMode.value);
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
  portInput.addEventListener('input', refreshPortValidation);
  portInput.addEventListener('change', () => {
    if (!currentInstance) return;
    if (!isValidPort(portInput.value)) {
      portInput.value = currentInstance.port || 8188;
      refreshPortValidation();
      return;
    }
    const port = parseInt(portInput.value, 10);
    currentInstance.port = port;
    handlers.onPortChange(currentInstance.id, port);
    updateArgsPreview(currentInstance);
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

  consoleHead.addEventListener('click', () => {
    if (!currentInstance) return;
    const st = state.instanceStates[currentInstance.id];
    if (!st) return;
    st.consoleCollapsed = !st.consoleCollapsed;
    if (!st.consoleCollapsed) {
      st.consoleUnread = false;
      st.autoScroll = true;
    }
    renderConsole(st);
  });

  function renderConsole(st) {
    const show = !!(st && (st.log || st.status === 'starting' || st.updating));
    consoleSection.classList.toggle('hidden', !show);
    if (!show) return;
    consoleSection.classList.toggle('collapsed', !!st.consoleCollapsed);
    consoleSection.classList.toggle('running', st.status === 'running');
    consoleToggle.setAttribute('aria-expanded', String(!st.consoleCollapsed));
    consoleBadge.classList.toggle('hidden', !(st.consoleCollapsed && st.consoleUnread));
    if (st.consoleCollapsed) return;
    mountConsole(st, currentInstance.id);
    paintConsole(st);
  }

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

    setLaunchMode(state.launchModes[instance.id] || 'gpu');
    isStartingNow = isStarting;
    launchBtn.classList.toggle('hidden', isRunning || isStarting);
    launchMode.classList.toggle('hidden', isRunning || isStarting);
    stopBtn.classList.toggle('hidden', !isRunning && !isStarting);
    if (stopLabel) stopLabel.textContent = isStarting ? '中止启动' : '停止';
    if (stopBtn) stopBtn.title = isStarting ? '中止当前启动并结束已创建的进程' : '停止正在运行的实例';
    openWebBtn.classList.toggle('hidden', !isRunning);
    refreshLaunchEnabled();
    updateBtns.forEach(b => b.disabled = isStarting || isRunning || isUpdating);

    let badgeState = 'stopped';
    let badgeLabel = '已停止';
    if (isUpdating) {
      badgeState = 'starting';
      badgeLabel = '更新中';
    } else if (isRunning) {
      badgeState = 'running';
      badgeLabel = '运行中';
    } else if (isStarting) {
      badgeState = 'starting';
      badgeLabel = '启动中';
    }
    stateBadge.className = 'state-badge state-' + badgeState;
    stateBadge.textContent = badgeLabel;

    renderPathRows(instance);
    refreshPortValidation();
    renderConsole(st);
  }

  function buildArgsPreview(inst, portOverride) {
    const port = portOverride !== undefined ? portOverride : (inst.port || 8188);
    const mainPy = inst.path + '\\ComfyUI\\main.py';
    const parts = ['-s', mainPy, '--windows-standalone-build', '--port', String(port)];
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
    if (!instance) {
      argsPreview.textContent = '';
      return;
    }
    const portOverride = isValidPort(portInput.value) ? parseInt(portInput.value, 10) : undefined;
    argsPreview.textContent = buildArgsPreview(instance, portOverride);
  }

  function renderPathRows(instance) {
    pathRows.innerHTML = '';
    pathInputs = {};

    const instRow = document.createElement('div');
    instRow.className = 'path-row';
    instRow.innerHTML = `
      <span class="path-title">实例目录</span>
      <input type="text" class="input" id="path_instance_path" value="${escapeHtml(instance.path)}" />
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
        <input type="text" class="input" id="path_${def.key}" value="${escapeHtml(val)}" />
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

  function setPathsValid(valid) {
    pathsValid = valid;
    refreshLaunchEnabled();
  }

  return { render, setPathError, setPathsValid };
}

function createSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const configPathDisplay = document.getElementById('configPathDisplay');
  const typeSelect = document.getElementById('settingsProxyType');
  const ipInput = document.getElementById('settingsProxyIp');
  const portInput = document.getElementById('settingsProxyPort');
  const testBtn = document.getElementById('testProxyBtn');
  const hintEl = document.getElementById('proxyHint');
  const resultEl = document.getElementById('proxyTestResult');

  const DEFAULT_IP = '127.0.0.1';
  const DEFAULT_PORT = 7890;
  let sysProxy = null;
  let testing = false;

  function updateManualEnabled(type) {
    const editable = type === 'socks5' || type === 'http';
    ipInput.disabled = !editable;
    portInput.disabled = !editable;
  }

  function updateHint(type) {
    if (type === 'system') {
      hintEl.textContent = sysProxy
        ? `将使用系统代理 ${sysProxy.host}:${sysProxy.port}`
        : '未检测到系统代理, 将直连';
    } else if (type === 'socks5') {
      hintEl.textContent = 'SOCKS5 代理 (TCP)';
    } else if (type === 'http') {
      hintEl.textContent = 'HTTP / HTTPS 代理';
    } else {
      hintEl.textContent = '';
    }
  }

  function saveProxy() {
    state.proxy = {
      type: typeSelect.value,
      ip: ipInput.value.trim() || null,
      port: portInput.value ? parseInt(portInput.value) : null,
    };
    saveConfig();
  }

  function updateTestBtn() {
    const inst = state.config.instances.find(i => i.id === state.selectedId);
    testBtn.disabled = testing || !inst || typeSelect.value === 'none';
  }

  async function refreshSystemProxy() {
    try {
      sysProxy = await configService.getSystemProxy();
    } catch (_) {
      sysProxy = null;
    }
  }

  typeSelect.addEventListener('change', () => {
    const type = typeSelect.value;
    updateManualEnabled(type);
    if (type === 'socks5' || type === 'http') {
      if (!ipInput.value) ipInput.value = DEFAULT_IP;
      if (!portInput.value) portInput.value = DEFAULT_PORT;
    }
    updateHint(type);
    updateTestBtn();
    saveProxy();
  });

  ipInput.addEventListener('input', () => {
    saveProxy();
    updateTestBtn();
  });

  portInput.addEventListener('input', () => {
    saveProxy();
    updateTestBtn();
  });

  testBtn.addEventListener('click', async () => {
    if (testing) return;
    testing = true;
    updateTestBtn();
    resultEl.className = 'proxy-test-result test-loading';
    resultEl.textContent = '测试中...';
    try {
      const inst = state.config.instances.find(i => i.id === state.selectedId);
      if (!inst) throw new Error('无可用实例');
      const proxy = await resolveProxy();
      if (!proxy) {
        resultEl.className = 'proxy-test-result test-fail';
        resultEl.textContent = '✗ 无可用代理配置, 无法测试';
        return;
      }
      const res = await instanceService.testGitProxy({ path: inst.path, proxy });
      const secs = (res.duration_ms / 1000).toFixed(1);
      if (res.ok) {
        resultEl.className = 'proxy-test-result test-ok';
        resultEl.textContent = `✓ 连接成功 (${secs}s)  ${res.message}`;
      } else {
        resultEl.className = 'proxy-test-result test-fail';
        resultEl.textContent = `✗ 连接失败 (${secs}s)  ${res.message}`;
      }
    } catch (err) {
      resultEl.className = 'proxy-test-result test-fail';
      resultEl.textContent = '✗ ' + (typeof err === 'string' ? err : err.message || JSON.stringify(err));
    } finally {
      testing = false;
      updateTestBtn();
    }
  });

  function open(configPath) {
    configPathDisplay.textContent = configPath;
    resultEl.className = 'proxy-test-result';
    resultEl.textContent = '';
    modal.classList.remove('hidden');
    refreshSystemProxy().then(() => updateHint(typeSelect.value));
  }

  function close() {
    modal.classList.add('hidden');
  }

  function setProxy(config) {
    if (!config) {
      typeSelect.value = 'none';
      ipInput.value = '';
      portInput.value = '';
    } else {
      typeSelect.value = config.type || 'none';
      ipInput.value = config.ip || '';
      portInput.value = config.port || '';
    }
    updateManualEnabled(typeSelect.value);
    updateHint(typeSelect.value);
    updateTestBtn();
  }

  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  const closeActionSelect = document.getElementById('settingsCloseAction');
  const closeActionHint = document.getElementById('closeActionHint');

  const CLOSE_HINTS = {
    ask: '关闭窗口时弹窗询问，可勾选记住选择。',
    tray: '关闭窗口时最小化到托盘，程序继续在后台运行。',
    exit: '关闭窗口时直接退出，并结束所有由启动器启动的实例。',
  };

  function setCloseAction(action) {
    closeActionSelect.value = action;
    closeActionHint.textContent = CLOSE_HINTS[action] || '';
  }

  closeActionSelect.addEventListener('change', async () => {
    const action = closeActionSelect.value;
    state.closeAction = action;
    closeActionHint.textContent = CLOSE_HINTS[action] || '';
    await instanceService.setCloseAction(action);
  });

  return { open, close, setProxy, setCloseAction };
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

function createConfirmModal() {
  const modal = document.getElementById('confirmModal');
  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const titleEl = document.getElementById('confirmTitle');
  const msgEl = document.getElementById('confirmMsg');
  const okBtn = document.getElementById('confirmOk');
  const cancelBtn = document.getElementById('confirmCancel');
  let resolver = null;

  function settle(value) {
    modal.classList.add('hidden');
    if (resolver) {
      const r = resolver;
      resolver = null;
      r(value);
    }
  }

  function ask(title, message, okLabel) {
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = okLabel || '确定';
    modal.classList.remove('hidden');
    okBtn.focus();
    return new Promise(r => { resolver = r; });
  }

  backdrop.addEventListener('click', () => settle(false));
  closeBtn.addEventListener('click', () => settle(false));
  cancelBtn.addEventListener('click', () => settle(false));
  okBtn.addEventListener('click', () => settle(true));
  return { ask };
}

function createCloseModal() {
  const modal = document.getElementById('closeModal');
  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const msgEl = document.getElementById('closeMsg');
  const hintEl = document.getElementById('closeHint');
  const rememberEl = document.getElementById('closeRemember');
  const trayBtn = document.getElementById('closeTray');
  const exitBtn = document.getElementById('closeExit');
  const cancelBtn = document.getElementById('closeCancel');
  let resolver = null;

  function settle(value) {
    modal.classList.add('hidden');
    if (resolver) {
      const r = resolver;
      resolver = null;
      r(value);
    }
  }

  function ask(runningNames) {
    if (runningNames.length > 0) {
      msgEl.textContent = `仍有 ${runningNames.length} 个实例在运行：${runningNames.join('、')}`;
      hintEl.textContent = '选择「退出程序」会一并结束这些实例。';
    } else {
      msgEl.textContent = '你要如何关闭启动器？';
      hintEl.textContent = '选择「最小化到托盘」可让启动器继续在后台待命。';
    }
    rememberEl.checked = false;
    modal.classList.remove('hidden');
    trayBtn.focus();
    return new Promise(r => { resolver = r; });
  }

  backdrop.addEventListener('click', () => settle(null));
  closeBtn.addEventListener('click', () => settle(null));
  cancelBtn.addEventListener('click', () => settle(null));
  trayBtn.addEventListener('click', () => settle({ action: 'tray', remember: rememberEl.checked }));
  exitBtn.addEventListener('click', () => settle({ action: 'exit', remember: rememberEl.checked }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) settle(null);
  });
  return { ask };
}

const state = {
  config: null,
  selectedId: null,
  instanceStates: {},
  launchModes: {},
  launchTokens: {},
  proxy: { type: 'none', ip: null, port: null },
  isMinimized: false,
  launchStartTime: null,
  accumulatedMs: 0,
  versionCache: {},
  sidebarCollapsed: false,
  activeTab: 'launch',
  closeAction: 'ask',
  closePromptOpen: false,
};

const listEl = document.getElementById('instanceList');
const detailEl = document.getElementById('instanceDetail');

const listComponent = createInstanceList(listEl, { onSelect: handleSelect });

const tabBar = createTabBar({
  onChange(name) {
    state.activeTab = name;
    saveUiState();
  },
});

const sidebar = createSidebar({
  onToggle(collapsed) {
    state.sidebarCollapsed = collapsed;
    saveUiState();
  },
});

let hydratingUi = true;
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

const settingsModal = createSettingsModal();
const closeModal = createCloseModal();
function runningInstanceNames() {
  return state.config.instances
    .filter(i => {
      const st = state.instanceStates[i.id];
      return st && (st.status === 'running' || st.status === 'starting');
    })
    .map(i => i.alias || i.path.split('\\').pop() || i.path);
}

async function handleCloseRequest() {
  if (state.closePromptOpen) return;
  if (state.closeAction !== 'ask') {
    await instanceService.resolveClose(state.closeAction);
    return;
  }
  state.closePromptOpen = true;
  const result = await closeModal.ask(runningInstanceNames());
  state.closePromptOpen = false;
  if (!result) {
    if (state.isMinimized) state.isMinimized = false;
    return;
  }
  if (result.remember) {
    state.closeAction = result.action;
    await instanceService.setCloseAction(result.action);
    settingsModal.setCloseAction(result.action);
  }
  await instanceService.resolveClose(result.action);
  if (result.action === 'tray') state.isMinimized = true;
}

const logModal = createLogModal();
const conflictModal = createConflictModal();
const confirmModal = createConfirmModal();

function migrateProxy(p) {
  if (!p) return { type: 'none', ip: null, port: null };
  if (p.type) return p;
  if (!p.enabled) return { type: 'none', ip: null, port: null };
  if (p.host && p.port) return { type: 'http', ip: p.host, port: p.port };
  return { type: 'system', ip: null, port: null };
}

async function resolveProxy() {
  const p = state.proxy || { type: 'none', ip: null, port: null };
  if (p.type === 'none') return null;
  if (p.type === 'system') {
    return await configService.getSystemProxy();
  }
  if (!p.ip || !p.port) return null;
  return {
    host: p.ip,
    port: p.port,
    scheme: p.type === 'socks5' ? 'socks5' : 'http',
  };
}

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
      st.logRenderedLen = Math.min(st.logRenderedLen || 0, st.logHtml.length);
      st.logDropPending = true;
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
  st.logRenderId = null;
  st.logRenderedLen = 0;
  st.curLineEl = null;
  st.autoScroll = true;
}

function consoleScroller() {
  return document.getElementById('consoleBodyScroll');
}

function isAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_BOTTOM_EPSILON;
}

function mountConsole(st, instanceId) {
  if (st.logRenderId === instanceId) return;
  const el = document.getElementById('startupLogContent');
  if (el) el.textContent = '';
  st.logRenderId = instanceId;
  st.logRenderedLen = 0;
  st.curLineEl = null;
  if (st.autoScroll === undefined) st.autoScroll = true;
}

function appendLogLine(el, html) {
  const line = document.createElement('span');
  line.className = 'log-line';
  if (html) line.innerHTML = html;
  else line.appendChild(document.createElement('br'));
  el.appendChild(line);
  return line;
}

function trimConsole(el, scroller, follow) {
  const extra = el.childElementCount - LOG_MAX_LINES;
  if (extra <= 0) return;
  let removed = 0;
  for (let i = 0; i < extra; i++) {
    const first = el.firstElementChild;
    if (!follow) removed += first.offsetHeight;
    el.removeChild(first);
  }
  if (!follow) scroller.scrollTop = Math.max(0, scroller.scrollTop - removed);
}

function dropPendingLine(el) {
  const last = el.lastElementChild;
  if (last && last.classList.contains('log-line-pending')) el.removeChild(last);
}

function paintConsole(st) {
  const el = document.getElementById('startupLogContent');
  const scroller = consoleScroller();
  if (!el || !scroller) return;
  if (st.logDropPending) {
    dropPendingLine(el);
    st.curLineEl = null;
    st.logDropPending = false;
  }
  const html = st.logHtml || '';
  const pending = html.slice(st.logRenderedLen || 0);
  if (!pending) return;
  st.logRenderedLen = html.length;
  const follow = st.autoScroll !== false;
  const segs = pending.split('\n');
  const tail = segs.pop();
  if (segs.length && st.curLineEl) {
    st.curLineEl.classList.remove('log-line-pending');
    st.curLineEl.innerHTML += segs.shift();
    st.curLineEl = null;
  }
  for (const seg of segs) appendLogLine(el, seg);
  if (tail) {
    if (st.curLineEl) {
      st.curLineEl.innerHTML += tail;
    } else {
      st.curLineEl = appendLogLine(el, tail);
      st.curLineEl.classList.add('log-line-pending');
    }
  }
  trimConsole(el, scroller, follow);
  if (follow) scroller.scrollTop = scroller.scrollHeight;
}

function syncConsoleLog(instanceId) {
  if (instanceId !== state.selectedId) return;
  const st = state.instanceStates[instanceId];
  if (!st) return;
  const section = document.getElementById('startupLogSection');
  if (!section || section.classList.contains('hidden')) return;
  if (st.consoleCollapsed) {
    st.consoleUnread = true;
    const badge = document.getElementById('consoleBadge');
    if (badge) badge.classList.remove('hidden');
    return;
  }
  mountConsole(st, instanceId);
  paintConsole(st);
}

function setupLogScrollControls() {
  const scroller = consoleScroller();
  if (!scroller) return;
  scroller.addEventListener('scroll', () => {
    const st = state.instanceStates[state.selectedId];
    if (!st) return;
    st.autoScroll = isAtBottom(scroller);
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'End') return;
    const section = document.getElementById('startupLogSection');
    if (!section || section.classList.contains('hidden')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const st = state.instanceStates[state.selectedId];
    if (st) {
      st.autoScroll = true;
      st.consoleCollapsed = false;
      st.consoleUnread = false;
    }
    section.classList.remove('collapsed');
    const toggle = document.getElementById('consoleToggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    const badge = document.getElementById('consoleBadge');
    if (badge) badge.classList.add('hidden');
    if (st) {
      mountConsole(st, state.selectedId);
      paintConsole(st);
    }
    e.preventDefault();
    scroller.scrollTop = scroller.scrollHeight;
  });
}

async function init() {
  state.config = await configService.read();
  state.proxy = migrateProxy(state.config.proxy);
  if (state.config.proxy && !state.config.proxy.type) {
    state.config.proxy = state.proxy;
    await configService.write(state.config);
  }
  settingsModal.setProxy(state.proxy);

  const ui = state.config.ui || {};
  state.sidebarCollapsed = ui.sidebar_collapsed === true;
  state.activeTab = ui.active_tab || 'launch';
  state.closeAction = ui.close_action || 'ask';
  sidebar.setCollapsed(state.sidebarCollapsed);
  tabBar.activate(state.activeTab, false);
  settingsModal.setCloseAction(state.closeAction);
  hydratingUi = false;

  if (state.config.instances.length > 0) {
    state.selectedId = state.config.instances[0].id;
  }
  listEl.classList.add('boot-seq');
  renderAll();
  window.setTimeout(() => listEl.classList.remove('boot-seq'), 900);
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
    syncConsoleLog(instance_id);
  });

  await listen('update-log', (event) => {
    const { instance_id, line } = event.payload;
    const st = state.instanceStates[instance_id];
    if (!st) return;
    appendLog(st, line + '\n');
    syncConsoleLog(instance_id);
  });

  await listen('process-ready', (event) => {
    const { instance_id, pid } = event.payload;
    const st = state.instanceStates[instance_id];
    if (st && (st.status === 'starting' || st.status === 'running')) {
      state.instanceStates[instance_id] = { ...st, status: 'running', pid, consoleCollapsed: true, consoleUnread: false };
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
      state.instanceStates[instance_id] = { ...st, status: 'stopped', pid: null, consoleCollapsed: false };
      renderAll();
      if (wasRunning) {
        conflictModal.open(`ComfyUI 进程已退出 (exit code: ${exit_code})`);
      }
    }
  });

  await listen('launcher:close-requested', () => {
    handleCloseRequest();
  });

  setupLogScrollControls();
  setInterval(updateStatusBar, 1000);
  setInterval(pollStatusSnapshot, 1000);
}
function renderAll() {
  listComponent.render(state.config.instances, state.selectedId, state.instanceStates);
  sidebar.setCount(state.config.instances.length);
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

function saveUiState() {
  if (hydratingUi || !state.config) return;
  state.config.ui = {
    sidebar_collapsed: sidebar.isCollapsed(),
    active_tab: state.activeTab,
  };
  saveConfig();
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
  state.launchModes[id] = 'gpu';
  state.instanceStates[id] = {
    status: 'stopped',
    pid: null,
    log: '',
    logHtml: '',
    ansiState: { ...ansiLog.defaultState },
    consoleCollapsed: false,
    consoleUnread: false,
  };
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
  const name = inst.alias || inst.path.split('\\').pop() || inst.path;
  const runningNote = st && st.status === 'running' ? '\n\n该实例正在运行，移除前会先将其停止。' : '';
  const ok = await confirmModal.ask(
    '删除实例',
    `确定要移除「${name}」吗？${runningNote}\n\n只删除启动器中的这条记录，磁盘上的文件不会被删除。`,
    '删除'
  );
  if (!ok) return;
  if (st && st.status === 'running') {
    await handleStop(inst.id);
  }
  clearWatchdog(inst.id);
  state.config.instances.splice(idx, 1);
  delete state.instanceStates[inst.id];
  delete state.launchModes[inst.id];
  state.selectedId = state.config.instances.length > 0
    ? state.config.instances[Math.min(idx, state.config.instances.length - 1)].id
    : null;
  await saveConfig();
  renderAll();
}

function handleSelect(id) {
  state.selectedId = id;
  const st = state.instanceStates[id];
  if (st) {
    st.autoScroll = true;
    st.logRenderId = null;
  }
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
  const token = (state.launchTokens[id] || 0) + 1;
  state.launchTokens[id] = token;
  state.instanceStates[id] = {
    status: 'starting',
    pid: null,
    token,
    log: '',
    logHtml: '',
    ansiState: { ...ansiLog.defaultState },
    consoleCollapsed: false,
    consoleUnread: false,
    watchdog: null,
  };
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
    });
    const pending = state.instanceStates[id];
    if (!pending || pending.status !== 'starting' || pending.token !== token) {
      await instanceService.stopInstance(pid).catch(() => {});
      return;
    }
    state.instanceStates[id] = { ...pending, pid };
    renderAll();
    armWatchdog(id);
    await pollPort(id, port);
    clearWatchdog(id);
  } catch (err) {
    clearWatchdog(id);
    const prev = state.instanceStates[id] || {};
    state.instanceStates[id] = { ...prev, status: 'stopped', pid: null, consoleCollapsed: false };
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
  st.consoleCollapsed = false;
  renderAll();
  conflictModal.open(`启动超时: 进程 ${STARTUP_TIMEOUT_MS / 1000} 秒无输出。\n\n后台进程仍在继续追踪, 若恢复输出并启动成功将自动变为运行中。`);
}

async function pollPort(id, port) {
  while (true) {
    await sleep(1000);
    const st = state.instanceStates[id];
    if (!st || st.status !== 'starting') return;
    if (await instanceService.checkPort(port)) {
      state.instanceStates[id] = { ...st, status: 'running', consoleCollapsed: true, consoleUnread: false };
      renderAll();
      minimizeApp();
      return;
    }
  }
}

async function handleStop(id) {
  const st = state.instanceStates[id];
  if (!st) return;
  const phase = st.status;
  if (phase !== 'running' && phase !== 'starting') return;
  const pid = st.pid;
  clearWatchdog(id);
  if (state.launchStartTime !== null) {
    state.accumulatedMs += Date.now() - state.launchStartTime;
    state.launchStartTime = null;
  }
  appendLog(st, phase === 'starting' ? '[信息] 已中止启动\n' : '[信息] 正在停止实例\n');
  const next = phase === 'starting' ? { ...st, consoleCollapsed: false } : st;
  state.instanceStates[id] = { ...next, status: 'stopped', pid: null };
  renderAll();
  if (pid) {
    try { await instanceService.stopInstance(pid); } catch (_) {}
  }
}

async function handleOpenWeb(id, port) {
  await instanceService.openUrl('http://127.0.0.1:' + port);
}

async function handleUpdate(id, type) {
  const inst = state.config.instances.find(i => i.id === id);
  if (!inst) return;
  const st = state.instanceStates[id] || (state.instanceStates[id] = {
    status: 'stopped',
    log: '',
    logHtml: '',
    ansiState: { ...ansiLog.defaultState },
  });
  st.updating = true;
  st.consoleCollapsed = false;
  st.consoleUnread = false;
  resetLog(st);
  renderAll();
  try {
    await instanceService.runUpdate({
      instanceId: id,
      path: inst.path,
      updateType: type,
      proxy: await resolveProxy(),
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
  detailComponent.setPathsValid(!hasError);
  tabBar.setBadge('paths', hasError ? '!' : '');
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

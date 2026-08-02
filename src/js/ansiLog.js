const BASE_COLORS = ['#4c4c4c', '#ff5555', '#55ff55', '#ffff55', '#55aaff', '#ff55ff', '#55ffff', '#f8f8f2'];
const BRIGHT_COLORS = ['#75715e', '#ff6e6e', '#69ff94', '#ffffa5', '#a6c8ff', '#ff9ff5', '#a1ffff', '#ffffff'];

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function spanStyle(state) {
  if (!state.bold && !state.fg && !state.bg) return '';
  const parts = [];
  if (state.bold) parts.push('font-weight:700');
  if (state.fg) parts.push('color:' + state.fg);
  if (state.bg) parts.push('background-color:' + state.bg);
  return parts.join(';');
}

function clampByte(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, n));
}

function color256(n) {
  if (Number.isNaN(n)) return null;
  n = Math.max(0, Math.min(255, n));
  if (n < 16) return n < 8 ? BASE_COLORS[n] : BRIGHT_COLORS[n - 8];
  if (n < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const r = levels[Math.floor((n - 16) / 36)];
    const g = levels[Math.floor(((n - 16) % 36) / 6)];
    const b = levels[(n - 16) % 6];
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  const g = 8 + (n - 232) * 10;
  return 'rgb(' + g + ',' + g + ',' + g + ')';
}

function applySgr(state, paramsStr) {
  const st = { ...state };
  const parts = paramsStr === '' ? ['0'] : paramsStr.split(';');
  for (let i = 0; i < parts.length; i++) {
    const code = parseInt(parts[i], 10);
    if (code === 0) {
      st.bold = false;
      st.fg = null;
      st.bg = null;
    } else if (code === 1) {
      st.bold = true;
    } else if (code === 22) {
      st.bold = false;
    } else if (code === 39) {
      st.fg = null;
    } else if (code === 49) {
      st.bg = null;
    } else if (code >= 30 && code <= 37) {
      st.fg = BASE_COLORS[code - 30];
    } else if (code >= 90 && code <= 97) {
      st.fg = BRIGHT_COLORS[code - 90];
    } else if (code >= 40 && code <= 47) {
      st.bg = BASE_COLORS[code - 40];
    } else if (code >= 100 && code <= 107) {
      st.bg = BRIGHT_COLORS[code - 100];
    } else if (code === 38 || code === 48) {
      const mode = parseInt(parts[i + 1], 10);
      if (mode === 5) {
        const c = color256(parseInt(parts[i + 2], 10));
        if (c) {
          if (code === 38) st.fg = c;
          else st.bg = c;
        }
        i += 2;
      } else if (mode === 2) {
        const c = 'rgb(' + clampByte(parts[i + 2]) + ',' + clampByte(parts[i + 3]) + ',' + clampByte(parts[i + 4]) + ')';
        if (code === 38) st.fg = c;
        else st.bg = c;
        i += 4;
      }
    }
  }
  return st;
}

function parse(text, prevState) {
  let state = { ...(prevState || ansiLog.defaultState) };
  let html = '';
  let buf = '';
  let i = 0;
  const n = text.length;

  function flush() {
    if (!buf) return;
    const style = spanStyle(state);
    html += style ? '<span style="' + style + '">' + escapeHtml(buf) + '</span>' : escapeHtml(buf);
    buf = '';
  }

  while (i < n) {
    const ch = text[i];
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      flush();
      html += '\n';
      i++;
      continue;
    }
    if (ch !== '\x1b') {
      buf += ch;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === '[') {
      let j = i + 2;
      while (j < n && !(text[j] >= '@' && text[j] <= '~')) j++;
      if (j >= n) break;
      const final = text[j];
      const params = text.slice(i + 2, j);
      if (final === 'm') {
        flush();
        state = applySgr(state, params);
      }
      i = j + 1;
    } else if (next === ']') {
      let j = i + 2;
      while (j < n && text[j] !== '\x07' && text[j] !== '\x1b') j++;
      i = j < n && text[j] === '\x07' ? j + 1 : j;
    } else {
      i++;
    }
  }
  flush();
  return { html, state };
}

const ansiLog = {
  defaultState: { bold: false, fg: null, bg: null },
  parse,
};

export default ansiLog;

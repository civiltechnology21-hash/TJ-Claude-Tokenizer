'use strict';

// Keep in sync with content.js / background.js
const DEFAULT_SETTINGS = {
  latinCharsPerToken: 4,
  bnTokensPerChar: 1.75,
  otherTokensPerChar: 1,
  overheadTokens: 0,
  notify: false,
  showBanner: true
};

const $ = (id) => document.getElementById(id);
let cycle = null;
let history = [];
let settings = { ...DEFAULT_SETTINGS };
let clearArmed = false;

/* ----------------------------- helpers ----------------------------- */
const estTokens = (c, s) => c.l / s.latinCharsPerToken + c.b * s.bnTokensPerChar + c.o * s.otherTokensPerChar;
const procTokens = (e) => estTokens(e.proc, settings) + e.msgs * settings.overheadTokens;
const typedTokens = (e) => estTokens(e.typed, settings);

function fmt(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function countdown(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return p(Math.floor(t / 3600)) + ':' + p(Math.floor((t % 3600) / 60)) + ':' + p(t % 60);
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

/* ------------------------------ render ------------------------------ */
function renderCycle() {
  const now = Date.now();
  const limits = history.filter((h) => h.reason === 'limit');
  const medProc = median(limits.map(procTokens));

  if (!cycle) {
    $('status').textContent = 'idle';
    $('status').classList.remove('on');
    $('window').textContent = '—';
    $('countdown').textContent = '--:--:--';
    $('timeBar').style.width = '0%';
    $('sTyped').textContent = '0';
    $('sProc').textContent = '0';
    $('sMsgs').textContent = '0';
    $('filesNote').hidden = true;
    $('gaugeText').textContent = limits.length ? 'no active cycle' : 'no limit points yet';
    $('gaugeBar').style.width = '0%';
    $('btnStart').hidden = false;
    $('btnLimit').hidden = true;
    $('btnEnd').hidden = true;
    return;
  }

  const total = cycle.end - cycle.start;
  $('status').textContent = 'active';
  $('status').classList.add('on');
  $('window').textContent = clock(cycle.start) + ' – ' + clock(cycle.end);
  $('countdown').textContent = countdown(cycle.end - now);
  $('timeBar').style.width = Math.min(100, Math.max(0, ((now - cycle.start) / total) * 100)) + '%';

  const proc = procTokens(cycle);
  $('sTyped').textContent = '~' + fmt(typedTokens(cycle));
  $('sProc').textContent = '~' + fmt(proc) + (cycle.files > 0 ? '+' : '');
  $('sMsgs').textContent = String(cycle.msgs);
  $('filesNote').hidden = !(cycle.files > 0);

  if (medProc) {
    const pct = (proc / medProc) * 100;
    $('gaugeText').textContent = Math.round(pct) + '% of median (' + limits.length + ' limit' + (limits.length > 1 ? 's' : '') + ')';
    $('gaugeBar').style.width = Math.min(100, pct) + '%';
  } else {
    $('gaugeText').textContent = 'no limit points yet';
    $('gaugeBar').style.width = '0%';
  }

  $('btnStart').hidden = true;
  $('btnLimit').hidden = false;
  $('btnEnd').hidden = false;
}

function renderLimitPoints() {
  const limits = history.filter((h) => h.reason === 'limit' && h.msgs > 0);
  $('lpCount').textContent = limits.length ? '(' + limits.length + ')' : '';
  const set = (prefix, vals) => {
    if (!vals.length) {
      ['min', 'med', 'max'].forEach((k) => { $(prefix + k).textContent = '–'; });
      return;
    }
    $(prefix + 'min').textContent = '~' + fmt(Math.min(...vals));
    $(prefix + 'med').textContent = '~' + fmt(median(vals));
    $(prefix + 'max').textContent = '~' + fmt(Math.max(...vals));
  };
  set('lpP', limits.map(procTokens));
  set('lpT', limits.map(typedTokens));
}

function renderHistory() {
  const ul = $('history');
  ul.textContent = '';
  $('historyEmpty').hidden = history.length > 0;
  for (const h of history.slice(0, 60)) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'h-main';
    const d = document.createElement('div');
    d.className = 'h-date';
    d.textContent = day(h.start) + ', ' + clock(h.start) + ' – ' + clock(h.closedAt || h.end);
    const sub = document.createElement('div');
    sub.className = 'h-sub';
    sub.textContent =
      h.msgs + ' msgs · Typed ~' + fmt(typedTokens(h)) + ' · Processed ~' + fmt(procTokens(h)) + (h.files > 0 ? '+' : '');
    sub.title = h.notice || '';
    main.append(d, sub);

    const badge = document.createElement('span');
    badge.className = 'badge' + (h.reason === 'limit' ? ' limit' : '');
    badge.textContent = h.reason === 'limit' ? 'limit' : h.reason === 'expired' ? 'timed out' : 'ended';

    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.title = 'Delete this entry';
    x.textContent = '×';
    x.addEventListener('click', () => send({ type: 'DELETE', id: h.id, closedAt: h.closedAt }));

    li.append(main, badge, x);
    ul.appendChild(li);
  }
}

function renderSettings() {
  const active = document.activeElement;
  const put = (id, v) => { if (active !== $(id)) $(id).value = v; };
  put('setLatin', settings.latinCharsPerToken);
  put('setBn', settings.bnTokensPerChar);
  put('setOther', settings.otherTokensPerChar);
  put('setOverhead', settings.overheadTokens);
  $('setBanner').checked = !!settings.showBanner;
  $('setNotify').checked = !!settings.notify;
}

function renderAll() {
  renderCycle();
  renderLimitPoints();
  renderHistory();
  renderSettings();
}

/* ------------------------------- CSV -------------------------------- */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function stamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function exportCsv() {
  const head = [
    'start', 'closed', 'reason', 'messages', 'files_flagged',
    'typed_tokens_est', 'processed_tokens_est',
    'typed_latin', 'typed_bengali', 'typed_other',
    'processed_latin', 'processed_bengali', 'processed_other',
    'limit_at', 'reset_at', 'notice'
  ];
  const rows = [];
  if (cycle) rows.push({ ...cycle, reason: 'active', closedAt: null });
  rows.push(...history);
  const lines = [head.join(',')];
  for (const h of rows) {
    lines.push([
      stamp(h.start), stamp(h.closedAt), h.reason, h.msgs, h.files || 0,
      Math.round(typedTokens(h)), Math.round(procTokens(h)),
      h.typed.l, h.typed.b, h.typed.o, h.proc.l, h.proc.b, h.proc.o,
      stamp(h.limitAt), stamp(h.resetAt), h.notice || ''
    ].map(csvCell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'claude-tokenizer-history.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------ settings ---------------------------- */
function saveSettings() {
  const num = (id, fallback, min) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  settings = {
    latinCharsPerToken: num('setLatin', DEFAULT_SETTINGS.latinCharsPerToken, 0.5),
    bnTokensPerChar: num('setBn', DEFAULT_SETTINGS.bnTokensPerChar, 0.1),
    otherTokensPerChar: num('setOther', DEFAULT_SETTINGS.otherTokensPerChar, 0.1),
    overheadTokens: num('setOverhead', DEFAULT_SETTINGS.overheadTokens, 0),
    showBanner: $('setBanner').checked,
    notify: $('setNotify').checked
  };
  chrome.storage.local.set({ settings });
}

/* -------------------------------- boot ------------------------------ */
function boot() {
  $('btnStart').addEventListener('click', () => send({ type: 'START' }));
  $('btnLimit').addEventListener('click', () => send({ type: 'LIMIT', auto: false, notice: 'Marked manually' }));
  $('btnEnd').addEventListener('click', () => send({ type: 'END' }));
  $('btnCsv').addEventListener('click', exportCsv);

  $('btnClear').addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      $('btnClear').textContent = 'Click again to confirm';
      setTimeout(() => { clearArmed = false; $('btnClear').textContent = 'Clear history'; }, 3000);
      return;
    }
    clearArmed = false;
    $('btnClear').textContent = 'Clear history';
    send({ type: 'CLEAR' });
  });

  ['setLatin', 'setBn', 'setOther', 'setOverhead', 'setBanner', 'setNotify'].forEach((id) => {
    $(id).addEventListener('change', saveSettings);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cycle) cycle = changes.cycle.newValue || null;
    if (changes.history) history = changes.history.newValue || [];
    if (changes.settings) settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    renderAll();
  });

  chrome.storage.local.get(['cycle', 'history', 'settings']).then((d) => {
    cycle = d.cycle || null;
    history = d.history || [];
    settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    // an expired cycle that the background has not closed yet
    if (cycle && Date.now() >= cycle.end) send({ type: 'CHECK' });
    renderAll();
  });

  // live countdown while the popup is open (stops when it closes)
  setInterval(() => {
    renderCycle();
    if (cycle && Date.now() >= cycle.end) send({ type: 'CHECK' });
  }, 1000);
}

boot();

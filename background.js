'use strict';

/*
 * TJ Claude Tokenizer - background service worker.
 *
 * Event-driven only: it wakes up for a message from the page/popup or for an
 * alarm, does its work, and goes back to sleep. It is the single place that
 * changes the cycle/history data, so two tabs can never overwrite each other.
 */

const CYCLE_MS = 5 * 60 * 60 * 1000;
const ALARM_END = 'cycleEnd';
const ALARM_RESET = 'limitReset';
const MAX_HISTORY = 300;

// Keep in sync with content.js / popup.js
const DEFAULT_SETTINGS = {
  latinCharsPerToken: 4,
  bnTokensPerChar: 1.75,
  otherTokensPerChar: 1,
  overheadTokens: 0,
  notify: false,
  showBanner: true
};

const zero = () => ({ l: 0, b: 0, o: 0 });
const addC = (a, b) => ({
  l: a.l + ((b && b.l) || 0),
  b: a.b + ((b && b.b) || 0),
  o: a.o + ((b && b.o) || 0)
});

// ---- tiny serial queue so storage read-modify-write never interleaves ----
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

async function load() {
  const d = await chrome.storage.local.get(['cycle', 'history', 'settings', 'lastLimit']);
  return {
    cycle: d.cycle || null,
    history: d.history || [],
    settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
    lastLimit: d.lastLimit || null
  };
}

function newCycle(now) {
  return { id: String(now), start: now, end: now + CYCLE_MS, msgs: 0, files: 0, typed: zero(), proc: zero() };
}

async function startCycle(now) {
  const cycle = newCycle(now);
  await chrome.storage.local.set({ cycle });
  await chrome.alarms.create(ALARM_END, { when: cycle.end });
  return cycle;
}

async function closeCycle(st, reason, extra, closedAt) {
  const c = st.cycle;
  if (!c) return null;
  const entry = { ...c, reason, closedAt: closedAt || Date.now(), ...(extra || {}) };
  const history = [entry, ...st.history].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ history, cycle: null });
  await chrome.alarms.clear(ALARM_END);
  st.history = history;
  st.cycle = null;
  return entry;
}

async function expire(st) {
  if (st.cycle) await closeCycle(st, 'expired', {}, st.cycle.end);
}

function notify(message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TJ Claude Tokenizer',
      message
    });
  } catch (e) { /* notifications are optional */ }
}

async function handle(msg) {
  const now = Date.now();
  const st = await load();

  switch (msg && msg.type) {
    case 'SEND': {
      if (st.cycle && now >= st.cycle.end) await expire(st);
      if (!st.cycle) st.cycle = await startCycle(now);
      const c = st.cycle;
      c.msgs += 1;
      if (msg.files) c.files += 1;
      c.typed = addC(c.typed, msg.typed);
      c.proc = addC(c.proc, msg.proc);
      await chrome.storage.local.set({ cycle: c });
      return { ok: true };
    }

    case 'REPLY': {
      if (st.cycle) {
        const c = st.cycle;
        c.typed = addC(c.typed, msg.typed);
        c.proc = addC(c.proc, msg.proc);
        await chrome.storage.local.set({ cycle: c });
      }
      return { ok: true };
    }

    case 'CHECK': {
      if (st.cycle && now >= st.cycle.end) await expire(st);
      return { ok: true };
    }

    case 'START': {
      if (!st.cycle) await startCycle(now);
      return { ok: true };
    }

    case 'END': {
      if (st.cycle) await closeCycle(st, 'manual');
      return { ok: true };
    }

    case 'LIMIT': {
      const key = String(msg.notice || '').slice(0, 120);
      // The same on-page notice must not close several cycles in a row.
      if (msg.auto && st.lastLimit && st.lastLimit.key === key && now - st.lastLimit.at < 30 * 60 * 1000) {
        return { ok: true, ignored: true };
      }
      if (!st.cycle) st.cycle = newCycle(now); // limit hit with nothing tracked (e.g. used on phone)
      const resetAt = msg.resetAt || null;
      await closeCycle(st, 'limit', {
        limitAt: now,
        resetAt,
        notice: String(msg.notice || '').slice(0, 240),
        auto: !!msg.auto
      });
      await chrome.storage.local.set({ lastLimit: { at: now, key } });
      if (resetAt && resetAt > now && st.settings.notify) {
        await chrome.alarms.create(ALARM_RESET, { when: resetAt });
      }
      return { ok: true };
    }

    case 'DELETE': {
      const history = st.history.filter((h) => h.id !== msg.id || h.closedAt !== msg.closedAt);
      await chrome.storage.local.set({ history });
      return { ok: true };
    }

    case 'CLEAR': {
      await chrome.storage.local.set({ history: [] });
      return { ok: true };
    }

    default:
      return { ok: false, error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  enqueue(() => handle(msg)).then(
    (r) => sendResponse(r),
    (e) => sendResponse({ ok: false, error: String(e) })
  );
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  enqueue(async () => {
    const st = await load();
    if (alarm.name === ALARM_END) {
      if (st.cycle && Date.now() >= st.cycle.end - 2000) {
        await closeCycle(st, 'expired', {}, st.cycle.end);
        if (st.settings.notify) notify('Your 5-hour cycle has ended. Usage should be fresh again.');
      }
    } else if (alarm.name === ALARM_RESET) {
      if (st.settings.notify) notify('Your usage limit should have reset by now.');
    }
  });
});

// Re-arm the end alarm after browser restart / extension update.
async function rearm() {
  const st = await load();
  if (!st.cycle) return;
  if (Date.now() >= st.cycle.end) await closeCycle(st, 'expired', {}, st.cycle.end);
  else await chrome.alarms.create(ALARM_END, { when: st.cycle.end });
}
chrome.runtime.onStartup.addListener(() => enqueue(rearm));
chrome.runtime.onInstalled.addListener(() => enqueue(rearm));

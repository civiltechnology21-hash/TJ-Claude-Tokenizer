(() => {
  'use strict';
  if (window.__claudeTokenizerLoaded) return;
  window.__claudeTokenizerLoaded = true;

  /* ------------------------------------------------------------------ *
   * SELECTORS - claude.ai changes its markup now and then.             *
   * If something stops being detected, this is the only block to fix.  *
   * ------------------------------------------------------------------ */
  const SEL = {
    composer: [
      'div[contenteditable="true"].ProseMirror',
      '[data-testid="chat-input"]',
      'fieldset div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]'
    ],
    userMsg: '[data-testid="user-message"]',
    assistantMsg: '.font-claude-response, .font-claude-message, [data-testid="assistant-message"]',
    streaming: '[data-is-streaming="true"]',
    stopBtn: 'button[aria-label="Stop response"], button[aria-label="Stop Response"]',
    sendBtn: 'button[aria-label="Send message"], button[aria-label="Send Message"], button[data-testid="send-button"]',
    attachment: ['[data-testid="file-thumbnail"]', '[data-testid*="attachment"]', '[data-testid*="file-thumbnail"]'],
    // parts of the page that must NOT be scanned for a "limit reached" notice
    limitSkip:
      'nav, aside, header, script, style, noscript, [contenteditable="true"], ' +
      '[data-testid="user-message"], .font-claude-response, .font-claude-message, [data-testid="assistant-message"]'
  };

  const LIMIT_RE =
    /(you['’]?ve|you have|you['’]?re)\s+(reached|hit|out of)[^.\n]{0,60}(limit|messages)|(usage|message) limit (reached|will reset)|limit (reached|resets?)/i;

  // Keep in sync with background.js / popup.js
  const DEFAULT_SETTINGS = {
    latinCharsPerToken: 4,
    bnTokensPerChar: 1.75,
    otherTokensPerChar: 1,
    overheadTokens: 0,
    notify: false,
    showBanner: true
  };

  /* ------------------------------ state ------------------------------ */
  let settings = { ...DEFAULT_SETTINGS };
  let cycle = null;
  let banner = null;
  let parts = {};
  let anchorEl = null;
  let resizeObs = null;
  let tickTimer = null;
  let limitTimer = null;
  let awaitTimer = null;
  let posTimer = null;
  let lastSendAt = 0;
  let expireSentFor = null;
  let dead = false;

  /* --------------------------- token maths --------------------------- */
  const zero = () => ({ l: 0, b: 0, o: 0 });
  const addC = (a, b) => ({ l: a.l + b.l, b: a.b + b.b, o: a.o + b.o });

  // Raw characters by class: l = Latin/ASCII, b = Bengali block, o = everything else.
  function countChars(s) {
    let l = 0, b = 0, o = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x250) l++;
      else if (c >= 0x980 && c <= 0x9ff) b++;
      else o++;
    }
    return { l, b, o };
  }

  function estTokens(c, s) {
    return c.l / s.latinCharsPerToken + c.b * s.bnTokensPerChar + c.o * s.otherTokensPerChar;
  }

  function fmtTokens(n) {
    if (n < 1000) return String(Math.round(n));
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1e6) return Math.round(n / 1000) + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  const fmtClock = (ms) =>
    new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  function fmtCountdown(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return p(Math.floor(t / 3600)) + ':' + p(Math.floor((t % 3600) / 60)) + ':' + p(t % 60);
  }

  /* ----------------------------- plumbing ---------------------------- */
  function alive() {
    if (dead) return false;
    let ok = false;
    try { ok = !!(chrome.runtime && chrome.runtime.id); } catch (e) { ok = false; }
    if (!ok) cleanup();
    return ok;
  }

  function send(msg) {
    try {
      if (!alive()) return Promise.resolve(null);
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      cleanup();
      return Promise.resolve(null);
    }
  }

  function cleanup() {
    if (dead) return;
    dead = true;
    [tickTimer, limitTimer, awaitTimer].forEach((t) => t && clearInterval(t));
    if (posTimer) clearTimeout(posTimer);
    if (resizeObs) resizeObs.disconnect();
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('click', onClick, true);
  }

  /* ------------------------------ DOM reads -------------------------- */
  const composerSel = SEL.composer.join(',');
  const closestComposer = (el) => (el && el.closest ? el.closest(composerSel) : null);
  const findComposer = () => document.querySelector(composerSel);

  function findAnchor() {
    const c = findComposer();
    if (!c) return null;
    return c.closest('fieldset') || c.closest('form') ||
      (c.parentElement && c.parentElement.parentElement && c.parentElement.parentElement.parentElement) || c;
  }

  // top-level matches only, so nested matches are not counted twice
  function queryTop(sel) {
    return Array.from(document.querySelectorAll(sel)).filter(
      (el) => !(el.parentElement && el.parentElement.closest(sel))
    );
  }

  function readConversation() {
    let total = zero();
    for (const el of queryTop(SEL.userMsg)) total = addC(total, countChars(el.textContent || ''));
    const asst = queryTop(SEL.assistantMsg);
    for (const el of asst) total = addC(total, countChars(el.textContent || ''));
    return { counts: total, asstCount: asst.length };
  }

  const hasStopButton = () => !!document.querySelector(SEL.stopBtn);
  const isGenerating = () => hasStopButton() || !!document.querySelector(SEL.streaming);

  function detectAttachments() {
    const a = findAnchor();
    if (!a) return false;
    return SEL.attachment.some((s) => a.querySelector(s)) || !!a.querySelector('img[src^="blob:"]');
  }

  function canSend() {
    const btn = document.querySelector(SEL.sendBtn);
    if (btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true')) return false;
    return !hasStopButton();
  }

  /* ------------------------------ sending ---------------------------- */
  function onKeydown(e) {
    try {
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.repeat) return;
      const comp = closestComposer(e.target);
      if (!comp) return;
      handleSend(comp.textContent || '');
    } catch (err) { /* never break the page */ }
  }

  function onClick(e) {
    try {
      const btn = e.target && e.target.closest && e.target.closest(SEL.sendBtn);
      if (!btn) return;
      const comp = findComposer();
      handleSend(comp ? comp.textContent || '' : '');
    } catch (err) { /* never break the page */ }
  }

  function handleSend(text) {
    if (!alive()) return;
    const now = Date.now();
    if (now - lastSendAt < 800) return;
    const files = detectAttachments();
    if (!text.trim() && !files) return;
    if (!canSend()) return;
    lastSendAt = now;

    // This runs in the capture phase, before the page reacts, so the DOM
    // still holds only the *previous* messages. Add the new text on top.
    const typed = countChars(text);
    const convo = readConversation();
    const proc = addC(convo.counts, typed);

    send({ type: 'SEND', typed, proc, files });
    beginAwaitReply(convo.asstCount);
  }

  /* --------------------------- waiting for reply --------------------- */
  function stopAwait() {
    if (awaitTimer) { clearInterval(awaitTimer); awaitTimer = null; }
  }

  // Runs only while a reply is being generated; stops by itself afterwards.
  // (If you switch to another chat mid-reply, that reply is not counted.)
  function beginAwaitReply(baseAsst) {
    stopAwait();
    const t0 = Date.now();
    let lastLen = -1;
    let stable = 0;
    let sawStreaming = false;
    awaitTimer = setInterval(() => {
      if (!alive()) return;
      try {
        const elapsed = Date.now() - t0;
        const gen = isGenerating();
        if (gen) sawStreaming = true;
        const asst = queryTop(SEL.assistantMsg);

        if (asst.length <= baseAsst) {
          checkLimitNotice();
          if (elapsed > 20000 && !gen) stopAwait(); // no reply came: failed or limited
          return;
        }

        const text = asst[asst.length - 1].textContent || '';
        if (!gen && text.length > 0 && text.length === lastLen) stable++;
        else stable = 0;
        lastLen = text.length;

        if (stable >= (sawStreaming ? 2 : 4)) {
          stopAwait();
          const c = countChars(text);
          send({ type: 'REPLY', typed: c, proc: c });
          checkLimitNotice();
        } else if (elapsed > 15 * 60 * 1000) {
          stopAwait();
        }
      } catch (err) { stopAwait(); }
    }, 1000);
  }

  /* ----------------------------- limit notice ------------------------ */
  function scanForNotice() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (n.id === 'claude-tokenizer-banner' || n.matches(SEL.limitSkip)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP; // look inside
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    const bits = [];
    let size = 0;
    while (walker.nextNode() && size < 20000) {
      const t = (walker.currentNode.nodeValue || '').trim();
      if (t) { bits.push(t); size += t.length; }
    }
    const all = bits.join(' ');
    const m = LIMIT_RE.exec(all);
    if (!m) return null;
    const from = Math.max(0, m.index - 60);
    return all.slice(from, m.index + 220);
  }

  function parseReset(text, now) {
    let m = text.match(/(?:reset[s]?|until|resumes?|available again|try again)\D{0,15}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (m) {
      let h = parseInt(m[1], 10) % 12;
      if (/pm/i.test(m[3])) h += 12;
      const d = new Date(now);
      d.setHours(h, parseInt(m[2] || '0', 10), 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    m = text.match(/(?:reset[s]?|until|resumes?)\D{0,15}?(\d{1,2}):(\d{2})\b/i);
    if (m) {
      const d = new Date(now);
      d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    m = text.match(/\bin\s+(\d+)\s*(?:hours?|hrs?|h)\b(?:\s*(?:and\s*)?(\d+)\s*(?:minutes?|mins?|m)\b)?/i);
    if (m) return now + (parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10)) * 60000;
    m = text.match(/\bin\s+(\d+)\s*(?:minutes?|mins?)\b/i);
    if (m) return now + parseInt(m[1], 10) * 60000;
    return null;
  }

  function checkLimitNotice() {
    if (!cycle || dead) return;
    let found = null;
    try { found = scanForNotice(); } catch (e) { return; }
    if (!found) return;
    send({ type: 'LIMIT', auto: true, notice: found, resetAt: parseReset(found, Date.now()) });
  }

  /* ------------------------------ banner ----------------------------- */
  function createBanner() {
    banner = document.createElement('div');
    banner.id = 'claude-tokenizer-banner';
    banner.className = 'ct-banner ct-fallback';
    const mk = (cls, txt, hideIdle) => {
      const s = document.createElement('span');
      s.className = cls + (hideIdle ? ' ct-active-only' : '');
      s.textContent = txt || '';
      banner.appendChild(s);
      return s;
    };
    parts.dot = mk('ct-dot');
    parts.win = mk('ct-win');
    mk('ct-sep', '·', true);
    parts.timer = mk('ct-timer', '', true);
    mk('ct-sep', '·', true);
    mk('ct-label', 'Typed', true);
    parts.typed = mk('ct-val', '', true);
    mk('ct-sep', '·', true);
    mk('ct-label', 'Processed', true);
    parts.proc = mk('ct-val', '', true);
    document.body.appendChild(banner);
  }

  function setText(el, txt) {
    if (el.textContent !== txt) el.textContent = txt;
  }

  function pageIsLight() {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(parseFloat);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    for (const el of [document.body, document.documentElement]) {
      const c = parse(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.5) return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 150;
    }
    return false; // the design assumes dark mode
  }

  function reposition() {
    if (!banner) return;
    if (!anchorEl || !anchorEl.isConnected) {
      anchorEl = findAnchor();
      if (resizeObs) {
        resizeObs.disconnect();
        if (anchorEl) resizeObs.observe(anchorEl);
      }
    }
    if (!anchorEl) {
      banner.classList.add('ct-fallback');
      banner.style.left = '';
      banner.style.top = '';
      return;
    }
    banner.classList.remove('ct-fallback');
    const r = anchorEl.getBoundingClientRect();
    banner.style.left = r.left + r.width / 2 + 'px';
    banner.style.top = Math.max(22, r.top - 6) + 'px';
  }

  function scheduleReposition(delay, tries) {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      if (dead) return;
      reposition();
      if (!anchorEl && tries > 0) scheduleReposition(600, tries - 1);
    }, delay);
  }

  function render(withPosition) {
    if (dead) return;
    if (!banner) createBanner();
    if (!settings.showBanner) { banner.style.display = 'none'; return; }
    banner.style.display = '';
    banner.classList.toggle('ct-light', pageIsLight());

    const now = Date.now();
    if (!cycle) {
      banner.classList.add('ct-idle');
      setText(parts.win, 'idle');
    } else {
      banner.classList.remove('ct-idle');
      const remaining = cycle.end - now;
      setText(parts.win, '(' + fmtClock(cycle.start) + ' – ' + fmtClock(cycle.end) + ')');
      setText(parts.timer, fmtCountdown(remaining));
      const typed = estTokens(cycle.typed, settings);
      const proc = estTokens(cycle.proc, settings) + cycle.msgs * settings.overheadTokens;
      setText(parts.typed, '~' + fmtTokens(typed));
      setText(parts.proc, '~' + fmtTokens(proc) + (cycle.files > 0 ? '+' : ''));
      if (remaining <= 0 && expireSentFor !== cycle.id) {
        expireSentFor = cycle.id;
        send({ type: 'CHECK' });
      }
    }
    if (withPosition !== false) reposition();
  }

  function syncTimers() {
    const active = !!cycle && !document.hidden;
    if (active && !tickTimer) tickTimer = setInterval(() => { if (alive()) render(true); }, 1000);
    if (!active && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (active && !limitTimer) limitTimer = setInterval(() => { if (alive()) checkLimitNotice(); }, 20000);
    if (!active && limitTimer) { clearInterval(limitTimer); limitTimer = null; }
  }

  /* ------------------------------- boot ------------------------------ */
  function boot() {
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('click', onClick, true);

    if (typeof ResizeObserver !== 'undefined') {
      let raf = 0;
      resizeObs = new ResizeObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; reposition(); });
      });
    }

    window.addEventListener('resize', () => scheduleReposition(100, 0), { passive: true });
    document.addEventListener('focusin', () => scheduleReposition(150, 0), true);
    window.addEventListener('popstate', () => scheduleReposition(400, 8));
    if (window.navigation && window.navigation.addEventListener) {
      window.navigation.addEventListener('navigatesuccess', () => scheduleReposition(400, 8));
    }
    document.addEventListener('visibilitychange', () => {
      if (!alive()) return;
      syncTimers();
      if (!document.hidden) { render(true); checkLimitNotice(); }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || dead) return;
      if (changes.cycle) cycle = changes.cycle.newValue || null;
      if (changes.settings) settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      syncTimers();
      render(true);
    });

    chrome.storage.local.get(['cycle', 'settings']).then((d) => {
      cycle = d.cycle || null;
      settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
      render(true);
      syncTimers();
      scheduleReposition(500, 10);
    }).catch(() => cleanup());
  }

  boot();
})();

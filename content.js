(function () {
  'use strict';

  if (window.__solanaLensActive) return;
  window.__solanaLensActive = true;

  // Base58 charset, 32–44 chars — covers all valid Solana public keys
  const ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
  // Bare address: entire string must be a valid pubkey
  const BARE_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // Tags whose contents we never touch
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  ]);

  // ─── Address extraction from element attributes / hrefs ──────────────────

  // Matches known Solana explorer URL patterns AND bare path segments of pubkey length.
  // Covers: solscan.io, explorer.solana.com, solana.fm, xray.helius.xyz, birdeye.so, etc.
  function addrFromHref(href) {
    if (!href || href.length < 32) return null;
    // Named path patterns (/account/, /address/, /token/, etc.)
    let m = /\/(?:account|address|wallet|token|key|validator|creator|nft|collection|pool|vault)\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/.exec(href);
    if (m) return m[1];
    // Any path segment that is exactly a pubkey (43–44 chars — virtually all real wallets)
    m = /(?:^|\/)([1-9A-HJ-NP-Za-km-z]{43,44})(?:[/?#]|$)/.exec(href);
    if (m) return m[1];
    // Query param (?address=..., ?pubkey=..., etc.)
    m = /[?&](?:address|pubkey|mint|token|account)=([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(href);
    if (m) return m[1];
    return null;
  }

  function addrFromElement(el) {
    // title="<full address>" — common in explorer UIs that show truncated text
    const title = (el.getAttribute('title') || '').trim();
    if (BARE_ADDR_RE.test(title)) return title;
    // data-address / data-pubkey / data-wallet / data-account / data-mint / data-addr
    for (const attr of ['data-address', 'data-pubkey', 'data-wallet', 'data-account', 'data-mint', 'data-addr', 'data-key']) {
      const v = (el.getAttribute(attr) || '').trim();
      if (BARE_ADDR_RE.test(v)) return v;
    }
    // <a href> — covers truncated link text pointing to a full address URL
    if (el.tagName === 'A') return addrFromHref(el.getAttribute('href'));
    return null;
  }

  const ELEM_DONE = Symbol('sle');

  function processElem(el) {
    if (el[ELEM_DONE]) return;
    el[ELEM_DONE] = true;
    if (el.hasAttribute('data-sl-addr')) return; // text-wrapping already handled it
    const addr = addrFromElement(el);
    if (!addr) return;
    el.setAttribute('data-sl-addr', addr);
    // Non-anchor elements get the same dashed-underline visual treatment
    if (el.tagName !== 'A') el.classList.add('solana-lens-addr');
  }

  function scanElements(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    // Broad selector — processElem filters down to actual address holders
    const els = root.querySelectorAll(
      'a[href], [title], [data-address], [data-pubkey], [data-wallet], [data-account], [data-mint], [data-addr], [data-key]'
    );
    for (const el of els) {
      if (el.id === 'solana-lens-tooltip') continue;
      processElem(el);
    }
    processElem(root); // root itself might match
  }

  let enabled = true;
  chrome.storage.sync.get(['enabled'], ({ enabled: e }) => {
    enabled = e !== false;
  });
  chrome.storage.onChanged.addListener(changes => {
    if ('enabled' in changes) enabled = changes.enabled.newValue !== false;
  });

  // ─── Tooltip state ─────────────────────────────────────────────────────

  let tooltipEl = null;
  let currentAddr = null;
  let hideTimer = null;
  let lastCursorX = 0;
  let lastCursorY = 0;

  function getTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'solana-lens-tooltip';
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.setAttribute('aria-live', 'polite');
    document.documentElement.appendChild(tooltipEl);

    tooltipEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    tooltipEl.addEventListener('mouseleave', () => scheduleHide());
    return tooltipEl;
  }

  function positionTooltip(x, y) {
    const tt = getTooltip();
    const W = 268;
    const H = tt.offsetHeight || 220;
    const PAD = 10;
    const GAP = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + GAP;
    let top = y + GAP;

    if (left + W + PAD > vw) left = x - W - GAP;
    if (top + H + PAD > vh) top = y - H - GAP;

    tooltipEl.style.left = Math.max(PAD, left) + 'px';
    tooltipEl.style.top = Math.max(PAD, top) + 'px';
  }

  function renderLoading(address) {
    const short = truncate(address);
    return `
      <div class="sl-header">
        <span class="sl-address" title="${esc(address)}">${short}</span>
        <button class="sl-copy-btn" aria-label="Copy address" data-addr="${esc(address)}">
          ${iconCopy()}
        </button>
      </div>
      <div class="sl-body">
        <div class="sl-balance-row">
          <span class="sl-orb" aria-hidden="true"></span>
          <div class="sl-amounts">
            <div class="sl-skel sl-skel-balance"></div>
            <div class="sl-skel sl-skel-usd"></div>
          </div>
        </div>
        <div class="sl-stats">
          <div class="sl-stat">
            <span class="sl-stat-label">Tokens</span>
            <div class="sl-skel sl-skel-stat"></div>
          </div>
          <div class="sl-stat">
            <span class="sl-stat-label">Last tx</span>
            <div class="sl-skel sl-skel-stat"></div>
          </div>
        </div>
      </div>
      <div class="sl-footer">
        <a href="https://solscan.io/account/${esc(address)}"
           target="_blank" rel="noreferrer"
           class="sl-explorer-link"
           aria-label="View ${short} on Solscan">
          View on Solscan ${iconExternal()}
        </a>
      </div>`;
  }

  function renderData(address, { solBalance, tokenCount, lastTxTime, solPrice }) {
    const short = truncate(address);
    const usd = solPrice != null ? solBalance * solPrice : null;

    return `
      <div class="sl-header">
        <span class="sl-address" title="${esc(address)}">${short}</span>
        <button class="sl-copy-btn" aria-label="Copy address" data-addr="${esc(address)}">
          ${iconCopy()}
        </button>
      </div>
      <div class="sl-body sl-fade-in">
        <div class="sl-balance-row">
          <span class="sl-orb" aria-hidden="true"></span>
          <div class="sl-amounts">
            <span class="sl-sol-amount" aria-label="${solBalance} SOL">
              ${fmtSol(solBalance)}<span class="sl-sol-symbol">SOL</span>
            </span>
            ${usd != null ? `<span class="sl-usd-amount" aria-label="${fmtUsd(usd)} USD">≈ ${fmtUsd(usd)}</span>` : ''}
          </div>
        </div>
        <div class="sl-stats">
          <div class="sl-stat">
            <span class="sl-stat-label">Tokens</span>
            <span class="sl-stat-value">${tokenCount}</span>
          </div>
          <div class="sl-stat">
            <span class="sl-stat-label">Last tx</span>
            <span class="sl-stat-value">${lastTxTime ? fmtRelTime(lastTxTime) : '—'}</span>
          </div>
        </div>
      </div>
      <div class="sl-footer">
        <a href="https://solscan.io/account/${esc(address)}"
           target="_blank" rel="noreferrer"
           class="sl-explorer-link"
           aria-label="View ${short} on Solscan">
          View on Solscan ${iconExternal()}
        </a>
      </div>`;
  }

  function renderError(address, errMsg) {
    const short = truncate(address);
    return `
      <div class="sl-header">
        <span class="sl-address" title="${esc(address)}">${short}</span>
        <button class="sl-copy-btn" aria-label="Copy address" data-addr="${esc(address)}">
          ${iconCopy()}
        </button>
      </div>
      <div class="sl-body">
        <p class="sl-error-msg">${esc(errMsg || 'Could not load wallet data')}</p>
      </div>
      <div class="sl-footer">
        <a href="https://solscan.io/account/${esc(address)}"
           target="_blank" rel="noreferrer"
           class="sl-explorer-link"
           aria-label="View ${short} on Solscan">
          View on Solscan ${iconExternal()}
        </a>
      </div>`;
  }

  function showTooltip(address, x, y) {
    const tt = getTooltip();
    currentAddr = address;
    tt.innerHTML = renderLoading(address);
    tt.classList.remove('sl-hiding');
    tt.offsetHeight; // force reflow so transition fires
    tt.classList.add('sl-visible');
    positionTooltip(x, y);
    wireButtons(tt, address);

    chrome.runtime.sendMessage({ type: 'FETCH_WALLET', address }, response => {
      if (chrome.runtime.lastError || currentAddr !== address) return;
      if (response?.ok) {
        tt.innerHTML = renderData(address, response.data);
      } else {
        tt.innerHTML = renderError(address, response?.error);
      }
      positionTooltip(lastCursorX, lastCursorY);
      wireButtons(tt, address);
    });
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const tt = getTooltip();
      tt.classList.remove('sl-visible');
      tt.classList.add('sl-hiding');
      currentAddr = null;
    }, 180);
  }

  function wireButtons(tt, address) {
    tt.querySelector('.sl-copy-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      copyToClipboard(address, e.currentTarget);
    });
  }

  // ─── Copy to clipboard ─────────────────────────────────────────────────

  function copyToClipboard(text, btn) {
    const doIt = () => {
      if (!btn) return;
      btn.classList.add('sl-copied');
      btn.setAttribute('aria-label', 'Copied!');
      setTimeout(() => {
        btn.classList.remove('sl-copied');
        btn.setAttribute('aria-label', 'Copy address');
      }, 1500);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(doIt).catch(() => execCopy(text, doIt));
    } else {
      execCopy(text, doIt);
    }
  }

  function execCopy(text, cb) {
    const el = document.createElement('textarea');
    el.value = text;
    Object.assign(el.style, { position: 'fixed', opacity: '0', top: '0', left: '0' });
    document.body.appendChild(el);
    el.focus();
    el.select();
    try { document.execCommand('copy'); cb(); } catch {}
    document.body.removeChild(el);
  }

  // ─── Formatting helpers ────────────────────────────────────────────────

  function truncate(addr) {
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }

  function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtSol(n) {
    if (n === 0) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M ';
    if (n >= 1_000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ';
    if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' ';
    return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 9 }) + ' ';
  }

  function fmtUsd(n) {
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return '$' + (n / 1_000).toFixed(1) + 'K';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtRelTime(unix) {
    const s = Math.floor(Date.now() / 1000) - unix;
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
    return new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ─── Inline SVG icons ──────────────────────────────────────────────────

  function iconCopy() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>`;
  }

  function iconExternal() {
    return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
    </svg>`;
  }

  // ─── DOM: find & wrap addresses ────────────────────────────────────────

  const PROCESSED = Symbol('sl');

  function nodeFilter(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
      if (node.id === 'solana-lens-tooltip') return NodeFilter.FILTER_REJECT;
      if (node.hasAttribute?.('data-sl-addr')) return NodeFilter.FILTER_REJECT;
      if (node.isContentEditable) return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  }

  function processText(textNode) {
    if (textNode[PROCESSED]) return;
    textNode[PROCESSED] = true;

    const text = textNode.nodeValue;
    if (!text || text.length < 32) return;

    ADDR_RE.lastIndex = 0;
    if (!ADDR_RE.test(text)) return;

    ADDR_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;

    while ((m = ADDR_RE.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      }

      const span = document.createElement('span');
      span.className = 'solana-lens-addr';
      span.setAttribute('data-sl-addr', m[0]);
      span.setAttribute('tabindex', '0');
      span.setAttribute('role', 'button');
      span.setAttribute('aria-label', `Solana address — hover to view balance`);
      span.textContent = m[0];
      frag.appendChild(span);

      last = m.index + m[0].length;
    }

    if (last === 0) return; // no match replaced
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  function walkAndWrap(root) {
    if (!root || !root.nodeType) return;
    if (root.nodeType === Node.ELEMENT_NODE && nodeFilter(root) === NodeFilter.FILTER_REJECT) return;

    // 1. Text-node pass: wrap full addresses in spans.
    //    Must run BEFORE scanElements so the TreeWalker can still enter <a> elements
    //    (nodeFilter rejects elements that already have data-sl-addr).
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      { acceptNode: nodeFilter },
    );

    const texts = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) texts.push(node);
    }
    texts.forEach(processText);

    // 2. Element attribute pass: detect truncated links and data-attr holders.
    scanElements(root);
  }

  function scheduleWalk(root) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => walkAndWrap(root), { timeout: 2500 });
    } else {
      setTimeout(() => walkAndWrap(root), 150);
    }
  }

  // ─── Event delegation ──────────────────────────────────────────────────

  document.addEventListener('mouseover', e => {
    if (!enabled) return;
    // Use closest() so hovering a child of <a data-sl-addr> still triggers
    const el = e.target?.closest?.('[data-sl-addr]');
    if (!el || el.id === 'solana-lens-tooltip') return;
    const addr = el.getAttribute('data-sl-addr');
    if (!addr) return;
    clearTimeout(hideTimer);
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
    if (addr === currentAddr) return;
    showTooltip(addr, e.clientX, e.clientY);
  }, true);

  document.addEventListener('mousemove', e => {
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
  }, { passive: true });

  document.addEventListener('mouseout', e => {
    const leaving = e.target?.closest?.('[data-sl-addr]');
    if (!leaving || leaving.id === 'solana-lens-tooltip') return;
    // Only hide if the cursor is truly leaving the [data-sl-addr] element
    // (mouseout fires on child→parent transitions too; relatedTarget check prevents false hides)
    const entering = e.relatedTarget?.closest?.('[data-sl-addr]');
    if (leaving !== entering) scheduleHide();
  }, true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      clearTimeout(hideTimer);
      const tt = getTooltip();
      tt.classList.remove('sl-visible');
      tt.classList.add('sl-hiding');
      currentAddr = null;
    }
  });

  // Keyboard: Enter/Space on a detected address copies the full address
  document.addEventListener('keydown', e => {
    if (!enabled) return;
    const el = e.target?.closest?.('[data-sl-addr]');
    if (!el) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copyToClipboard(el.getAttribute('data-sl-addr'), null);
    }
  });

  // Show tooltip when a detected element receives keyboard focus
  document.addEventListener('focusin', e => {
    if (!enabled) return;
    const el = e.target?.closest?.('[data-sl-addr]');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    showTooltip(el.getAttribute('data-sl-addr'), rect.left, rect.bottom + 4);
  });

  document.addEventListener('focusout', e => {
    if (e.target?.closest?.('[data-sl-addr]')) scheduleHide();
  });

  // ─── MutationObserver for dynamic content ──────────────────────────────

  let mutTimer = null;
  const pending = new Set();

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) {
          pending.add(n);
        }
      }
    }
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => {
      pending.forEach(n => scheduleWalk(n));
      pending.clear();
    }, 100);
  });

  // Initial pass + observe
  if (document.body) {
    scheduleWalk(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      scheduleWalk(document.body);
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
})();

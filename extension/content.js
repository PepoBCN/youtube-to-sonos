// YouTube content script: a speaker key in the player bar and a small panel to pick a speaker.
// All companion traffic goes through the background worker (YTS.send / YTS.playAndWait).

(() => {
  if (window.__ytsContentLoaded) return;
  window.__ytsContentLoaded = true;

  // The open panel, if any. Declared first: ensure() reads it on the first pass.
  let panel = null;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const text = (el) => (el && el.textContent ? el.textContent.trim().replace(/\s+/g, ' ') : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<rect x="5.6" y="2.8" width="12.8" height="18.4" rx="1.4" fill="none" stroke="#fff" stroke-width="1.7"/>' +
    '<circle cx="12" cy="14.3" r="3.5" fill="none" stroke="#fff" stroke-width="1.7"/>' +
    '<circle class="yts-lamp" cx="12" cy="7.3" r="1.4" fill="#fff"/>' +
    '</svg>';
  const CLOSE =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .plate {
      width: 288px;
      background: #141414;
      color: #f5f5f5;
      border: 1px solid #3c3c3c;
      font-family: 'YTS Plex Condensed', 'Arial Narrow', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.35;
      -webkit-font-smoothing: antialiased;
      cursor: default;
      user-select: none;
    }
    .mono { font-family: 'YTS Plex Mono', Menlo, monospace; font-feature-settings: 'zero' 1; }
    .head {
      display: flex; align-items: center; gap: 8px;
      height: 36px; padding: 0 4px 0 12px;
      border-bottom: 1px solid #3c3c3c;
    }
    .label { font-size: 12px; font-weight: 500; letter-spacing: 0.04em; color: #b2b2b2; }
    .from { margin-left: auto; font-size: 12px; color: #b2b2b2; }
    .close {
      width: 28px; height: 28px; padding: 6px; border: 0; background: none; color: #b2b2b2; cursor: pointer;
    }
    .close:hover { color: #f5f5f5; }
    .close svg { width: 16px; height: 16px; display: block; }
    .keys { display: block; }
    .key {
      display: grid; grid-template-columns: 10px 1fr auto 26px; align-items: center; column-gap: 10px;
      width: 100%; min-height: 44px; padding: 0 12px;
      background: #1d1d1d; color: inherit; font: inherit; text-align: left;
      border: 0; border-bottom: 1px solid #2a2a2a; cursor: pointer;
    }
    .key:last-child { border-bottom: 0; }
    .key:hover:not(:disabled) { background: #262626; }
    .key:active:not(:disabled) { transform: translateY(1px); }
    .key:disabled { cursor: default; color: #7f7f7f; }
    .key:focus-visible, .btn:focus-visible, .close:focus-visible { outline: 1px solid #f5f5f5; outline-offset: -3px; }
    .lamp { width: 8px; height: 8px; border-radius: 50%; border: 1px solid #7f7f7f; }
    .lamp.on { background: #f05a24; border-color: #f05a24; }
    .name { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .key:disabled .name { color: #7f7f7f; }
    .key.picked:disabled .name { color: #f5f5f5; }
    .meta { font-size: 12px; color: #b2b2b2; }
    .vol { font-size: 12px; color: #7f7f7f; text-align: right; }
    .note { padding: 12px; font-size: 13px; color: #b2b2b2; border-top: 1px solid #3c3c3c; }
    .note:first-child { border-top: 0; }
    .note strong { color: #f5f5f5; font-weight: 500; }
    .bar { position: relative; height: 2px; margin-bottom: 10px; background: #2a2a2a; overflow: hidden; }
    .bar::after {
      content: ''; position: absolute; top: 0; bottom: 0; width: 30%; left: -30%;
      background: #f05a24; animation: run 1.4s linear infinite;
    }
    @keyframes run { to { left: 100%; } }
    @media (prefers-reduced-motion: reduce) { .bar::after { animation: none; left: 0; width: 100%; opacity: 0.6; } }
    .cmd {
      display: block; margin: 8px 0 10px; padding: 8px; font-size: 11.5px; line-height: 1.45; color: #f5f5f5;
      background: #0f0e12; border: 1px solid #3c3c3c; overflow-wrap: anywhere; user-select: all;
    }
    .row { display: flex; gap: 8px; }
    .btn {
      flex: 1; height: 32px; padding: 0 10px; font: inherit; font-size: 13px; font-weight: 500;
      color: #f5f5f5; background: #262626; border: 1px solid #3c3c3c; cursor: pointer;
    }
    .btn:hover { background: #303030; }
    .btn:active { transform: translateY(1px); }
  `;

  // ---- Page and video facts -------------------------------------------------

  function current() {
    const p = YTS.parseYouTubeUrl(location.href);
    if (!p) return null;
    if (location.pathname !== '/watch' && !location.pathname.startsWith('/shorts/')) return null;
    return p;
  }

  function playerFor(kind) {
    return kind === 'shorts' ? $('#shorts-player') : $('#movie_player');
  }

  function videoEl(kind) {
    const p = playerFor(kind);
    return p ? $('video.html5-main-video', p) || $('video', p) : null;
  }

  function videoInfo() {
    const c = current();
    if (!c) return null;
    const v = videoEl(c.kind);
    const player = playerFor(c.kind);
    const ad = !!(player && player.classList.contains('ad-showing'));
    const startSeconds = v && !ad && Number.isFinite(v.currentTime) ? Math.floor(v.currentTime) : c.startSeconds || 0;
    let title = '';
    let channel = '';
    if (c.kind === 'watch') {
      const flexy = $('ytd-watch-flexy');
      const fresh = !!(flexy && flexy.getAttribute('video-id') === c.videoId);
      const link = $('#movie_player .ytp-title-link');
      if (link && (link.href || '').includes(c.videoId)) title = text(link);
      if (!title && fresh) title = text($('ytd-watch-metadata h1'));
      if (fresh) channel = text($('ytd-watch-metadata ytd-channel-name a')) || text($('ytd-watch-metadata #owner #channel-name a'));
    } else {
      title = text($$('yt-shorts-video-title-view-model, ytd-reel-video-renderer[is-active] h2').find(visible));
      const ch = $$('yt-reel-channel-bar-view-model a, ytd-reel-video-renderer[is-active] ytd-channel-name a').find((a) => visible(a) && text(a));
      channel = text(ch);
    }
    return {
      videoId: c.videoId,
      kind: c.kind,
      startSeconds,
      title,
      channel,
      thumbnail: YTS.thumbnailFor(c.videoId),
      duration: v && Number.isFinite(v.duration) ? Math.floor(v.duration) : null,
      paused: v ? v.paused : null,
      ad,
    };
  }

  // ---- The speaker key ------------------------------------------------------

  function target() {
    const c = current();
    if (!c) return null;
    if (c.kind === 'shorts') {
      const rc = $$('ytd-shorts ytd-shorts-player-controls #right-controls').find(visible);
      if (!rc) return null;
      const player = rc.closest('#player-container') || rc.closest('ytd-reel-video-renderer') || rc.parentElement;
      return { kind: 'shorts', container: rc, before: rc.firstElementChild, player };
    }
    const player = $('#movie_player');
    const rc = player && $('.ytp-right-controls', player);
    if (!rc) return null;
    const right = $('.ytp-right-controls-right', rc);
    if (right) {
      const before = $('.ytp-remote-button', right) || $('.ytp-size-button', right) || $('.ytp-fullscreen-button', right);
      return { kind: 'watch', container: right, before: before && before.parentElement === right ? before : right.firstElementChild, player };
    }
    return { kind: 'watch', container: rc, before: rc.firstElementChild, player };
  }

  function makeButton(kind) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = kind === 'shorts' ? 'yts-sonos-button yts-shorts' : 'ytp-button yts-sonos-button';
    b.setAttribute('aria-label', 'Play on Sonos');
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('data-tooltip-title', 'Play on Sonos');
    b.setAttribute('data-title-no-tooltip', 'Play on Sonos');
    b.setAttribute('data-priority', '4');
    b.title = 'Play on Sonos';
    b.innerHTML = ICON;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panel) closePanel();
      else openPanel();
    });
    return b;
  }

  function ensure() {
    const t = target();
    const all = $$('.yts-sonos-button');
    if (!t) {
      all.forEach((b) => b.remove());
      if (panel) closePanel();
      return;
    }
    let keep = all.find((b) => b.parentElement === t.container);
    all.forEach((b) => {
      if (b !== keep) b.remove();
    });
    if (!keep) {
      keep = makeButton(t.kind);
      t.container.insertBefore(keep, t.before && t.before.parentElement === t.container ? t.before : null);
    }
    keep.setAttribute('aria-expanded', panel ? 'true' : 'false');
    const c = current();
    if (panel && (!c || c.videoId !== panel.videoId)) closePanel();
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      ensure();
    }, 250);
  }

  // YouTube rebuilds the player bar after SPA navigation, sometimes after the event fires,
  // so re-check a few times as well as watching the DOM.
  function onNavigate() {
    ensure();
    [300, 1000, 2500, 5000].forEach((ms) => setTimeout(ensure, ms));
  }
  document.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-page-data-updated', schedule);
  window.addEventListener('popstate', schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  onNavigate();

  // ---- The panel ------------------------------------------------------------

  function openPanel() {
    const t = target();
    const c = current();
    if (!t || !c) return;
    const host = document.createElement('div');
    host.className = 'yts-panel-host' + (t.kind === 'shorts' ? ' yts-shorts' : '');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      `<style>${PANEL_CSS}</style>` +
      '<div class="plate" role="dialog" aria-label="Play on Sonos">' +
      `<div class="head"><span class="label">Play on Sonos</span><span class="from mono"></span><button class="close" type="button" aria-label="Close">${CLOSE}</button></div>` +
      '<div class="body"></div>' +
      '</div>';
    // Keep clicks and keys inside the panel away from YouTube's player shortcuts.
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu'].forEach((ev) =>
      host.addEventListener(ev, (e) => {
        if (ev === 'keydown' && e.key === 'Escape') closePanel();
        e.stopPropagation();
      })
    );
    $('.close', root).addEventListener('click', closePanel);
    if (getComputedStyle(t.player).position === 'static') t.player.style.position = 'relative';
    t.player.appendChild(host);
    panel = { host, root, videoId: c.videoId, busy: false, timers: [] };
    const b = $('.yts-sonos-button');
    if (b) b.setAttribute('aria-expanded', 'true');
    updateFrom();
    panel.timers.push(setInterval(updateFrom, 1000));
    load();
  }

  function closePanel() {
    if (!panel) return;
    panel.timers.forEach((t) => {
      clearInterval(t);
      clearTimeout(t);
    });
    panel.host.remove();
    panel = null;
    const b = $('.yts-sonos-button');
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!panel) return;
      const path = e.composedPath();
      if (path.includes(panel.host)) return;
      if (path.some((n) => n.classList && n.classList.contains('yts-sonos-button'))) return;
      closePanel();
    },
    true
  );

  function updateFrom() {
    if (!panel || panel.busy) return;
    const info = videoInfo();
    $('.from', panel.root).textContent = info ? `From ${YTS.formatTime(info.startSeconds)}` : '';
  }

  function body(html) {
    if (!panel) return null;
    const b = $('.body', panel.root);
    b.innerHTML = html;
    return b;
  }

  function keysHtml(groups, litId, disabled) {
    return (
      '<div class="keys">' +
      groups
        .map(
          (g) =>
            `<button class="key${g.id === litId ? ' picked' : ''}" type="button" data-id="${esc(g.id)}"${disabled ? ' disabled' : ''}>` +
            `<span class="lamp${g.id === litId ? ' on' : ''}"></span>` +
            `<span class="name">${esc(g.name)}</span>` +
            `<span class="meta">${esc(YTS.stateLabel(g.state))}</span>` +
            `<span class="vol mono" title="Volume">${String(g.volume == null ? '' : g.volume).padStart(2, '0')}</span>` +
            '</button>'
        )
        .join('') +
      '</div>'
    );
  }

  async function load(refresh) {
    body('<div class="note">Finding speakers...</div>');
    const [cfg, res, pend] = await Promise.all([YTS.send({ type: 'config' }), YTS.send({ type: 'speakers', refresh: !!refresh }), YTS.send({ type: 'pending' })]);
    if (!panel) return;
    if (!res.ok) return res.code === 'offline' ? renderOffline() : renderError(res.error);
    panel.groups = res.data.groups || [];
    panel.lastGroupId = cfg.ok ? cfg.data.lastGroupId : null;
    if (!panel.groups.length) {
      const b = body('<div class="note">No speakers found on this network.</div><div class="note"><div class="row"><button class="btn" data-act="refresh" type="button">Search again</button></div></div>');
      $('[data-act=refresh]', b).addEventListener('click', () => load(true));
      return;
    }
    const p = pend.ok && pend.data.pending;
    if (p && p.videoId === panel.videoId) {
      const g = panel.groups.find((x) => x.id === p.groupId) || { id: p.groupId, name: p.groupName };
      return waitOnExisting(g);
    }
    renderGroups();
  }

  function renderGroups() {
    const b = body(keysHtml(panel.groups, panel.lastGroupId, false));
    $$('.key', b).forEach((k) =>
      k.addEventListener('click', () => {
        const g = panel.groups.find((x) => x.id === k.dataset.id);
        if (g) pick(g);
      })
    );
  }

  function renderPreparing(g, info) {
    panel.busy = true;
    $('.from', panel.root).textContent = info ? `From ${YTS.formatTime(info.startSeconds)}` : '';
    body(
      keysHtml(panel.groups, g.id, true) +
        `<div class="note"><div class="bar" role="progressbar" aria-label="Preparing audio"></div>Preparing audio on <strong>${esc(g.name)}</strong>. Long videos can take a minute.</div>`
    );
  }

  async function pick(g) {
    const info = videoInfo();
    if (!info) return;
    renderPreparing(g, info);
    const res = await YTS.playAndWait({
      videoId: info.videoId,
      groupId: g.id,
      groupName: g.name,
      startSeconds: info.startSeconds,
      title: info.title,
      channel: info.channel,
      thumbnail: info.thumbnail,
    });
    finish(g, info, res);
  }

  async function waitOnExisting(g) {
    renderPreparing(g, null);
    // The job was started earlier (panel closed and reopened). Poll until it lands.
    for (let i = 0; i < 100 && panel; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await YTS.send({ type: 'pending' });
      if (!panel) return;
      if (p.ok && !p.data.pending) {
        if (p.data.lastError && p.data.lastError.videoId === panel.videoId) return finish(g, null, { ok: false, error: p.data.lastError.error });
        return finish(g, null, { ok: true });
      }
    }
  }

  function finish(g, info, res) {
    if (!panel) return;
    panel.busy = false;
    if (res.ok) {
      const c = current();
      if (info && c && c.videoId === info.videoId) {
        const v = videoEl(c.kind);
        if (v && !v.paused) v.pause();
      }
      panel.lastGroupId = g.id;
      if (res.data && res.data.state) {
        g.state = res.data.state;
        if (res.data.volume != null) g.volume = res.data.volume;
      }
      body(keysHtml(panel.groups, g.id, true) + `<div class="note">Playing on <strong>${esc(g.name)}</strong>. YouTube is paused.</div>`);
      panel.timers.push(setTimeout(closePanel, 3500));
      return;
    }
    if (res.code === 'offline') return renderOffline();
    renderError(res.error || 'Something went wrong.');
  }

  function renderError(message) {
    if (!panel) return;
    panel.busy = false;
    const b = body(
      `<div class="note"><strong>That didn't work.</strong> ${esc(message)}</div>` +
        '<div class="note"><div class="row"><button class="btn" data-act="retry" type="button">Try again</button></div></div>'
    );
    $('[data-act=retry]', b).addEventListener('click', () => {
      YTS.send({ type: 'clearError' });
      load();
    });
  }

  function renderOffline() {
    if (!panel) return;
    panel.busy = false;
    const b = body(
      '<div class="note"><strong>The companion isn\'t running.</strong> Start it in Terminal:' +
        `<code class="cmd mono">${esc(YTS.INSTALL_COMMAND).replace(/\//g, "/<wbr>")}</code>` +
        '<div class="row"><button class="btn" data-act="copy" type="button">Copy command</button><button class="btn" data-act="retry" type="button">Try again</button></div></div>'
    );
    $('[data-act=copy]', b).addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(YTS.INSTALL_COMMAND);
        e.target.textContent = 'Copied';
      } catch {
        e.target.textContent = 'Select and copy';
      }
    });
    $('[data-act=retry]', b).addEventListener('click', () => load());
  }

  // ---- Messages from the background worker and the popup --------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'pauseVideo') {
      const c = current();
      let paused = false;
      if (c && c.videoId === msg.videoId) {
        const v = videoEl(c.kind);
        if (v) {
          if (!v.paused) v.pause();
          paused = true;
        }
      }
      sendResponse({ ok: true, paused });
      return false;
    }
    if (msg.type === 'getVideoInfo') {
      sendResponse({ ok: true, data: videoInfo() });
      return false;
    }
    return false;
  });
})();

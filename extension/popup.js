// Toolbar popup. Talks to the companion only through the background worker.

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ICONS = {
    pause: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="2.6" height="9" fill="currentColor"/><rect x="7.4" y="1.5" width="2.6" height="9" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.5 6z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" fill="currentColor"/></svg>',
  };

  const qs = new URLSearchParams(location.search);

  const st = {
    tab: null,
    video: null, // { videoId, title, channel, thumbnail, startSeconds }
    groups: [],
    selectedId: null,
    status: null,
    pending: null,
    error: null,
    volumeHoldUntil: 0,
    pollTimer: null,
  };

  const main = $('#main');

  function setCompanion(on, label) {
    $('#companion-lamp').classList.toggle('on', !!on);
    $('#companion-state').textContent = label;
  }

  function selected() {
    return st.groups.find((g) => g.id === st.selectedId) || null;
  }

  // ---- Tab and video --------------------------------------------------------

  async function resolveTab() {
    // ?tabId= lets the tests point the popup at a tab, since a popup opened as a page is its own active tab.
    if (qs.get('tabId')) {
      try {
        return await chrome.tabs.get(Number(qs.get('tabId')));
      } catch {
        return null;
      }
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function readVideo(tab) {
    if (!tab || !tab.url) return null;
    const parsed = YTS.parseYouTubeUrl(tab.url);
    if (!parsed) return null;
    const u = new URL(tab.url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname) || (u.pathname !== '/watch' && !u.pathname.startsWith('/shorts/'))) return null;
    let info = null;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'getVideoInfo' });
      if (res && res.ok && res.data && res.data.videoId === parsed.videoId) info = res.data;
    } catch {
      // Content script not there yet (tab opened before the extension loaded). Use the URL.
    }
    const fallbackTitle = (tab.title || '').replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/, '');
    return {
      videoId: parsed.videoId,
      title: (info && info.title) || fallbackTitle,
      channel: (info && info.channel) || '',
      thumbnail: YTS.thumbnailFor(parsed.videoId),
      startSeconds: info ? info.startSeconds : parsed.startSeconds,
      live: !!info,
    };
  }

  // ---- Rendering ------------------------------------------------------------

  function renderOffline() {
    stopPolling();
    setCompanion(false, 'Not running');
    main.innerHTML =
      '<section class="sec">' +
      "<p class=\"note\"><strong>The companion isn't running.</strong> It's the small app on this Mac that sends audio to the speakers. Start it from Terminal:</p>" +
      `<code class="cmd mono" id="cmd">${esc(YTS.INSTALL_COMMAND).replace(/\//g, "/<wbr>")}</code>` +
      '<div class="row"><button class="btn" id="copy" type="button">Copy command</button><button class="btn" id="retry" type="button">Try again</button></div>' +
      '</section>';
    $('#copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(YTS.INSTALL_COMMAND);
        $('#copy').textContent = 'Copied';
      } catch {
        $('#copy').textContent = 'Select and copy';
      }
    });
    $('#retry').addEventListener('click', init);
  }

  function videoSection() {
    if (!st.video) {
      return '<section class="sec" id="tab-sec"><p class="legend">This tab</p><p class="note">Open a YouTube video in this tab to send it to a speaker.</p></section>';
    }
    const v = st.video;
    return (
      '<section class="sec" id="tab-sec"><p class="legend">This tab</p>' +
      '<div class="video">' +
      `<img class="thumb" alt="" src="${esc(v.thumbnail)}">` +
      '<div>' +
      `<p class="v-title" id="v-title">${esc(v.title || 'YouTube video')}</p>` +
      (v.channel ? `<p class="v-sub">${esc(v.channel)}</p>` : '') +
      `<p class="v-from mono" id="v-from">From ${YTS.formatTime(v.startSeconds)}</p>` +
      '</div></div></section>'
    );
  }

  function keysHtml(disabled) {
    return (
      '<div class="keys" role="radiogroup" aria-label="Speakers">' +
      st.groups
        .map((g) => {
          const on = g.id === st.selectedId;
          return (
            `<button class="key" type="button" role="radio" aria-checked="${on}" data-id="${esc(g.id)}"${disabled ? ' disabled' : ''}>` +
            `<span class="lamp${on ? ' on' : ''}"></span>` +
            `<span class="k-name">${esc(g.name)}</span>` +
            `<span class="k-state">${esc(YTS.stateLabel(g.state))}</span>` +
            `<span class="k-vol mono" title="Volume">${String(g.volume == null ? '' : g.volume).padStart(2, '0')}</span>` +
            '</button>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function speakersSection() {
    if (!st.groups.length) {
      return (
        '<section class="sec" id="spk-sec"><p class="legend">Speakers</p><p class="note">No speakers found on this network.</p>' +
        '<div class="row" style="margin-top:10px"><button class="btn" id="refresh" type="button">Search again</button></div></section>'
      );
    }
    const g = selected();
    const busy = !!st.pending;
    let action = '';
    if (busy) {
      const name = esc(st.pending.groupName || (g && g.name) || 'the speaker');
      action = `<div class="wait" id="wait"><div class="bar" role="progressbar" aria-label="Preparing audio"></div>Preparing audio on <strong>${name}</strong>. Long videos can take a minute.</div>`;
    } else {
      const label = st.video ? `Play on ${esc(g ? g.name : 'speaker')}` : 'Play on speaker';
      action = `<button class="btn btn-primary" id="play" type="button"${st.video && g ? '' : ' disabled'}>${label}</button>`;
    }
    if (st.error) {
      action +=
        `<div class="problem" id="problem"><p><strong>That didn't work.</strong> ${esc(st.error)}</p>` +
        '<div class="row"><button class="btn" id="dismiss" type="button">Dismiss</button></div></div>';
    }
    return `<section class="sec" id="spk-sec"><p class="legend">Speakers</p>${keysHtml(busy)}${action}</section>`;
  }

  function nowPlayingSection() {
    const s = st.status;
    const g = selected();
    if (!s || !g) return '';
    const active = s.state === 'PLAYING' || s.state === 'PAUSED_PLAYBACK' || s.state === 'TRANSITIONING';
    if (!active || (!s.title && !s.videoId)) return '';
    const pct = s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0;
    const playing = s.state === 'PLAYING' || s.state === 'TRANSITIONING';
    const thumb = s.videoId ? YTS.thumbnailFor(s.videoId) : s.thumbnail;
    return (
      `<section class="sec" id="np-sec"><p class="legend">Now playing on ${esc(g.name)}<span class="aside" id="np-state">${esc(YTS.stateLabel(s.state))}${s.isOurs ? '' : ', not from YouTube'}</span></p>` +
      `<div class="np${thumb ? '' : ' np-text'}">` +
      (thumb ? `<img class="thumb" alt="" src="${esc(thumb)}">` : '') +
      `<div><p class="v-title" id="np-title">${esc(s.title || 'Untitled')}</p>${s.channel ? `<p class="v-sub">${esc(s.channel)}</p>` : ''}</div>` +
      '</div>' +
      `<div class="progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="${Math.round(s.duration || 0)}" aria-valuenow="${Math.round(s.position || 0)}"><div class="progress-fill" id="np-fill" style="width:${pct}%"></div></div>` +
      `<div class="times mono"><span id="np-pos">${YTS.formatTime(s.position)}</span><span id="np-dur">${s.duration ? YTS.formatTime(s.duration) : ''}</span></div>` +
      '<div class="transport">' +
      (playing
        ? `<button class="btn" id="pause" type="button">${ICONS.pause}Pause</button>`
        : `<button class="btn" id="resume" type="button">${ICONS.play}Resume</button>`) +
      `<button class="btn" id="stop" type="button">${ICONS.stop}Stop</button>` +
      '</div>' +
      `<div class="fader"><label for="vol">Volume</label><input type="range" id="vol" min="0" max="100" step="1" value="${s.volume}" style="--pct:${s.volume}%"><output class="mono" id="vol-out" for="vol">${String(s.volume).padStart(2, '0')}</output></div>` +
      '</section>'
    );
  }

  function render() {
    setCompanion(true, 'Connected');
    const prevVolFocus = document.activeElement && document.activeElement.id === 'vol';
    main.innerHTML = videoSection() + speakersSection() + nowPlayingSection();
    wire();
    if (prevVolFocus && $('#vol')) $('#vol').focus();
  }

  // Update only the moving parts, so the fader isn't rebuilt under the pointer every 2 s.
  function renderStatusOnly() {
    const s = st.status;
    const sec = $('#np-sec');
    const shouldShow = !!nowPlayingSection();
    updateKeyReadout();
    if (!!sec !== shouldShow) return render();
    if (!sec) return;
    const playingNow = s.state === 'PLAYING' || s.state === 'TRANSITIONING';
    if (!!$('#pause') !== playingNow || $('#np-title').textContent !== (s.title || 'Untitled')) return render();
    $('#np-fill').style.width = `${s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0}%`;
    $('#np-pos').textContent = YTS.formatTime(s.position);
    $('#np-dur').textContent = s.duration ? YTS.formatTime(s.duration) : '';
    $('#np-state').textContent = YTS.stateLabel(s.state) + (s.isOurs ? '' : ', not from YouTube');
    if (Date.now() > st.volumeHoldUntil) setVolumeUi(s.volume);
  }

  // Keep the speaker list readouts in step with the latest status.
  function updateKeyReadout() {
    const s = st.status;
    const g = selected();
    if (g && s) {
      g.state = s.state;
      g.volume = s.volume;
      const k = $(`.key[data-id="${CSS.escape(g.id)}"]`);
      if (k) {
        $('.k-state', k).textContent = YTS.stateLabel(s.state);
        $('.k-vol', k).textContent = String(s.volume).padStart(2, '0');
      }
    }
  }

  function setVolumeUi(v) {
    const r = $('#vol');
    if (!r) return;
    r.value = v;
    r.style.setProperty('--pct', `${v}%`);
    $('#vol-out').textContent = String(v).padStart(2, '0');
  }

  // ---- Wiring ---------------------------------------------------------------

  let volTimer = null;

  function wire() {
    $$('.key').forEach((k) =>
      k.addEventListener('click', () => {
        const g = st.groups.find((x) => x.id === k.dataset.id);
        if (!g) return;
        st.selectedId = g.id;
        st.status = null;
        st.error = null;
        YTS.send({ type: 'setLastGroup', groupId: g.id, groupName: g.name });
        render();
        poll();
      })
    );
    const play = $('#play');
    if (play) play.addEventListener('click', onPlay);
    const refresh = $('#refresh');
    if (refresh) refresh.addEventListener('click', () => loadSpeakers(true).then(render));
    const dismiss = $('#dismiss');
    if (dismiss) dismiss.addEventListener('click', () => {
      st.error = null;
      YTS.send({ type: 'clearError' });
      render();
    });
    const pause = $('#pause');
    if (pause) pause.addEventListener('click', () => control('pause'));
    const resume = $('#resume');
    if (resume) resume.addEventListener('click', () => control('resume'));
    const stop = $('#stop');
    if (stop) stop.addEventListener('click', () => control('stop'));
    const vol = $('#vol');
    if (vol) {
      vol.addEventListener('input', () => {
        const v = Number(vol.value);
        st.volumeHoldUntil = Date.now() + 2500;
        setVolumeUi(v);
        clearTimeout(volTimer);
        volTimer = setTimeout(async () => {
          const g = selected();
          if (!g) return;
          const res = await YTS.send({ type: 'volume', groupId: g.id, volume: v });
          st.volumeHoldUntil = Date.now() + 800;
          if (res.ok) {
            st.status = res.data;
            renderStatusOnly();
          } else handleFailure(res);
        }, 300);
      });
    }
  }

  async function control(action) {
    const g = selected();
    if (!g) return;
    $$('.transport .btn').forEach((b) => (b.disabled = true));
    const res = await YTS.send({ type: 'control', groupId: g.id, action });
    if (res.ok) {
      st.status = res.data;
      g.state = res.data.state;
      render();
    } else handleFailure(res);
  }

  function handleFailure(res) {
    if (res.code === 'offline') return renderOffline();
    st.error = res.error;
    render();
    return poll();
  }

  async function onPlay() {
    const g = selected();
    if (!g || !st.video) return;
    // Read the position again at the moment of the click.
    const fresh = await readVideo(st.tab);
    if (fresh) st.video = fresh;
    const v = st.video;
    st.error = null;
    st.pending = { videoId: v.videoId, groupId: g.id, groupName: g.name };
    render();
    const res = await YTS.playAndWait({
      tabId: st.tab ? st.tab.id : null,
      videoId: v.videoId,
      groupId: g.id,
      groupName: g.name,
      startSeconds: v.startSeconds,
      title: v.live ? v.title : '',
      channel: v.channel,
      thumbnail: v.thumbnail,
    });
    st.pending = null;
    if (res.ok) {
      st.status = res.data;
      g.state = res.data.state;
      render();
      return;
    }
    await handleFailure(res);
  }

  // ---- Polling --------------------------------------------------------------

  function stopPolling() {
    clearInterval(st.pollTimer);
    st.pollTimer = null;
  }

  async function poll() {
    const g = selected();
    if (!g) return;
    const res = await YTS.send({ type: 'status', groupId: g.id });
    if (!res.ok) {
      if (res.code === 'offline') renderOffline();
      return;
    }
    if (selected() !== g) return;
    st.status = res.data;
    renderStatusOnly();
  }

  async function watchPending() {
    // A play started before this popup opened (or from the YouTube page). Wait for it here too.
    while (st.pending) {
      await sleep(1500);
      const p = await YTS.send({ type: 'pending' });
      if (!p.ok) return;
      if (!p.data.pending) {
        st.pending = null;
        if (p.data.lastError) st.error = p.data.lastError.error;
        await poll();
        render();
        return;
      }
    }
  }

  async function loadSpeakers(refresh) {
    const res = await YTS.send({ type: 'speakers', refresh: !!refresh });
    if (!res.ok) {
      if (res.code === 'offline') renderOffline();
      else st.error = res.error;
      return false;
    }
    st.groups = res.data.groups || [];
    return true;
  }

  async function init() {
    stopPolling();
    setCompanion(false, 'Checking');
    const health = await YTS.send({ type: 'health' });
    if (!health.ok) {
      if (health.code === 'offline' || health.code === 'timeout') return renderOffline();
      st.error = health.error;
    }
    st.tab = await resolveTab();
    const [video, ok, cfg, pend] = await Promise.all([readVideo(st.tab), loadSpeakers(false), YTS.send({ type: 'config' }), YTS.send({ type: 'pending' })]);
    if (ok === false && !st.groups.length && !st.error) return; // offline already rendered
    st.video = video;
    const last = cfg.ok ? cfg.data.lastGroupId : null;
    st.selectedId = st.groups.some((g) => g.id === last) ? last : st.groups[0] ? st.groups[0].id : null;
    if (pend.ok) {
      st.pending = pend.data.pending;
      if (!st.pending && pend.data.lastError) st.error = pend.data.lastError.error;
      if (st.pending && st.groups.some((g) => g.id === st.pending.groupId)) st.selectedId = st.pending.groupId;
    }
    render();
    await poll();
    st.pollTimer = setInterval(poll, 2000);
    if (st.pending) watchPending();
  }

  init();
})();

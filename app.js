// JERICHO DEW — call app for members (runs on GitHub Pages)
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const isAdminRole = (r) => r === 'host' || /^admin\d+$/.test(r || '');
  const roleLabel = (r) => (r === 'host' ? 'Main admin' : /^admin(\d+)$/.test(r || '') ? `Admin-${r.slice(5)}` : '');
  const LK = window.LivekitClient;
  const encT = new TextEncoder();
  const decT = new TextDecoder();
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');

  let svc = null;          // service document
  let me = null;           // { identity, name, role, photo, title }
  let room = null;
  let state = { v: 0, live: false, tv: { on: false }, minister: null, chat: true };
  const hands = new Set();
  let unread = 0;
  let personTarget = null;

  /* ---------------- utilities ---------------- */
  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`; t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 3800);
    setTimeout(() => t.remove(), 4200);
  }
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64url = (s) => b64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  async function sha256hex(t) {
    const h = await crypto.subtle.digest('SHA-256', encT.encode(t));
    return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function openSealed(sealed, password) {
    const base = await crypto.subtle.importKey('raw', encT.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(sealed.salt), iterations: (svc.kdf && svc.kdf.iterations) || 120000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(sealed.iv) }, key, b64(sealed.ct));
    return JSON.parse(decT.decode(pt));
  }
  function show(id) { ['#scrJoin', '#scrCall', '#scrEnd'].forEach((s) => ($(s).hidden = s !== id)); }
  function fmtWhen(d, t) {
    const dt = new Date(`${d}T${t || '00:00'}:00`);
    return `${dt.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · ${dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  async function getJson(path) {
    const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'not-found' : `HTTP ${r.status}`);
    return r.json();
  }

  /* ---------------- service loading ---------------- */
  async function loadService() {
    let id = params.get('s');
    if (DEMO) return demoService();
    try {
      if (id) {
        // An old service link: use it if it is still open, otherwise fall through to the church link.
        try {
          svc = await getJson(`data/services/${encodeURIComponent(id)}.json`);
          if (svc.expiresAt && Date.now() > svc.expiresAt) svc = null;
        } catch { svc = null; }
        if (!svc) history.replaceState(null, '', location.pathname);
      }
      if (!svc) {
        // The church link: always opens the current (or next) service by itself.
        const idx = await getJson('data/index.json');
        const now = Date.now();
        const list = (idx.services || []).filter((x) => !x.expiresAt || x.expiresAt > now)
          .sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0) || String(a.date + a.time).localeCompare(String(b.date + b.time)));
        if (!list.length) return noService(idx.church);
        svc = await getJson(`data/services/${encodeURIComponent(list[0].id)}.json`);
      }
      $('#svcPick').hidden = true;
      $('#svcWhen').textContent = fmtWhen(svc.date, svc.time);
      $('#svcTitle').textContent = svc.title;
      $('#svcNote').textContent = svc.description || svc.church || '';
      $('#jBtn').disabled = false;
      document.title = `${svc.title} · JERICHO DEW`;
      // Signed in earlier on this phone? Join straight away.
      const saved = loadSaved();
      if (saved) return startCall(saved, true);
      const cred = loadCred();
      if (cred) {
        const ticket = await unlock(cred.u, cred.p).catch(() => null);
        if (ticket) { save(ticket); return startCall(ticket, true); }
        forgetCred();
        $('#jUser').value = cred.u;
        $('#jErr').textContent = 'Your password has changed for this week. Use the new login card from your admin.';
      }
    } catch (e) {
      $('#svcWhen').textContent = 'Could not load the service. Check your internet — this page will try again by itself.';
      $('#svcTitle').textContent = '';
      $('#jBtn').disabled = true;
      setTimeout(loadService, 20000);
    }
  }
  function noService(church) {
    $('#svcWhen').textContent = 'No service is open right now';
    $('#svcTitle').textContent = church || 'Jericho Afasuo Prayer City';
    $('#svcNote').textContent = 'Keep this page open or come back later. The next service will appear here by itself.';
    $('#jBtn').disabled = true;
    setTimeout(loadService, 60000);
  }
  async function unlock(user, pass) {
    const tid = (await sha256hex(`${svc.id}:${String(user).trim().toLowerCase()}`)).slice(0, 40);
    const sealed = svc.tickets[tid];
    if (!sealed) throw new Error('bad');
    return openSealed(sealed, pass);
  }
  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(`jd-ticket-${svc.id}`) || 'null');
      if (s && s.until > Date.now()) return s.ticket;
    } catch {}
    return null;
  }
  function save(ticket) {
    try {
      localStorage.setItem(`jd-ticket-${svc.id}`, JSON.stringify({ ticket, until: svc.expiresAt || Date.now() + 864e5 }));
      localStorage.setItem('jd-user', ticket.identity);
    } catch {}
  }
  function forget() { try { localStorage.removeItem(`jd-ticket-${svc.id}`); } catch {} }
  // "Keep me signed in": remembered on this phone only, so every new service opens by itself.
  function loadCred() { try { const c = JSON.parse(localStorage.getItem('jd-cred') || 'null'); return c ? { u: c.u, p: decodeURIComponent(escape(atob(c.p))) } : null; } catch { return null; } }
  function saveCred(u, p) { try { localStorage.setItem('jd-cred', JSON.stringify({ u, p: btoa(unescape(encodeURIComponent(p))) })); } catch {} }
  function forgetCred() { try { localStorage.removeItem('jd-cred'); } catch {} }

  /* ---------------- sign in ---------------- */
  $('#pwEye').onclick = () => { const p = $('#jPass'); p.type = p.type === 'password' ? 'text' : 'password'; $('#pwEye').textContent = p.type === 'password' ? 'Show' : 'Hide'; };
  try { $('#jUser').value = localStorage.getItem('jd-user') || ''; } catch {}
  $('#joinForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#jErr').textContent = '';
    if (DEMO) return startCall({ identity: 'you', name: $('#jUser').value || 'You', role: 'admin1' });
    if (!svc) return;
    const user = $('#jUser').value.trim().toLowerCase();
    const pass = $('#jPass').value;
    $('#jBtn').disabled = true; $('#jBtn').textContent = 'Checking…';
    try {
      const ticket = await unlock(user, pass);
      if ($('#jRemember').checked) { save(ticket); saveCred(user, pass); } else forgetCred();
      $('#jPass').value = '';
      await startCall(ticket);
    } catch {
      $('#jErr').textContent = 'That username or password is not right. Check this week\'s login card from your admin.';
    } finally { $('#jBtn').disabled = false; $('#jBtn').textContent = 'Join the service'; }
  };

  /* ---------------- install as app ---------------- */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#installBtn').hidden = false; });
  $('#installBtn').onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#installBtn').hidden = true; };
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIos && !standalone) $('#iosHint').hidden = false;
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  /* ---------------- the call ---------------- */
  function pInfo(p) {
    let a = p.attributes || {};
    if (!a.role && p.metadata) { try { a = { ...JSON.parse(p.metadata), ...a }; } catch {} }
    return { role: a.role || 'member', title: a.title || '', photo: a.photo || '' };
  }
  const amAdmin = () => me && isAdminRole(me.role);
  const adminPresent = () => !!room && [...room.remoteParticipants.values()].some((p) => isAdminRole(pInfo(p).role));
  const isLive = () => state.live || adminPresent() || amAdmin();

  async function startCall(ticket, silent) {
    me = ticket;
    show('#scrCall');
    $('#cTitle').textContent = svc ? svc.title : 'Service';
    $('#dAdmin').hidden = !amAdmin();
    $('#dHand').hidden = svc && svc.allowHandRaise === false;
    $('#dChat').hidden = svc && svc.allowChat === false;
    if (DEMO) return Demo.start();
    setState('Connecting…');
    room = new LK.Room({
      adaptiveStream: true, dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { dtx: true, red: true },
    });
    bindRoom(room);
    try {
      await room.connect(svc.livekitUrl, ticket.token, { autoSubscribe: true });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/401|token|expired|unauthor/i.test(msg)) { forget(); }
      show('#scrJoin');
      $('#jErr').textContent = /full|limit/i.test(msg) ? 'The call is full right now. Please try again shortly.'
        : /invalid token|unauthor|401/i.test(msg) ? 'Your pass for this service is out of date. Ask the admin to publish the service again, then sign in again.'
        : /expired|not valid yet|nbf|exp/i.test(msg) ? 'This join link has expired or is not open yet. Ask the admin for the current link.'
        : `Could not connect to the call (${msg.slice(0, 80)}). Check your internet and try again.`;
      room = null;
      return;
    }
    setTimeout(() => { if (room && room.state === 'connected') rejoinTries = 0; }, 20000);
    setupMediaSession();
    send({ t: 'hello' });
    if (svc.joinMuted === false && isLive()) setMic(true);
    render(); updateLive();
    if (!room.canPlaybackAudio) $('#audioBanner').hidden = false;
    if (!silent) toast(`Welcome, ${me.name.split(' ')[0]}`);
  }

  let rejoinTries = 0;
  function reasonName(r) {
    try { const D = LK.DisconnectReason; for (const k of Object.keys(D)) if (D[k] === r && isNaN(+k)) return k; } catch {}
    return r === undefined ? '' : String(r);
  }

  function bindRoom(r) {
    const E = LK.RoomEvent;
    r.on(E.ParticipantConnected, () => { render(); updateLive(); })
      .on(E.ParticipantDisconnected, (p) => { hands.delete(p.identity); render(); updateLive(); })
      .on(E.TrackSubscribed, (track, pub, p) => {
        if (track.kind === 'audio') { const el = track.attach(); $('#audioSink').appendChild(el); }
        if (track.kind === 'video' && pub.trackName === 'jd-tv') { track.attach($('#tvVideo')); updateTv(); }
      })
      .on(E.TrackUnsubscribed, (track, pub) => { track.detach().forEach((el) => { if (el.id !== 'tvVideo') el.remove(); }); if (pub.trackName === 'jd-tv') updateTv(); })
      .on(E.TrackMuted, (pub, p) => { if (pub.trackName === 'jd-tv') updateTv(); if (p === r.localParticipant && pub.source === LK.Track.Source.Microphone) micUi(); render(); })
      .on(E.TrackUnmuted, (pub) => { if (pub.trackName === 'jd-tv') updateTv(); render(); micUi(); })
      .on(E.TrackPublished, () => render())
      .on(E.TrackUnpublished, () => render())
      .on(E.LocalTrackPublished, () => { micUi(); render(); })
      .on(E.LocalTrackUnpublished, () => { micUi(); render(); })
      .on(E.AudioPlaybackStatusChanged, () => { $('#audioBanner').hidden = r.canPlaybackAudio; })
      .on(E.DataReceived, (payload, from, _k, topic) => {
        if (topic !== 'jd') return;
        let m; try { m = JSON.parse(decT.decode(payload)); } catch { return; }
        onData(m, from);
      })
      .on(E.Reconnecting, () => setState('Reconnecting…'))
      .on(E.Reconnected, () => { updateLive(); send({ t: 'hello' }); })
      .on(E.Disconnected, (reason) => {
        room = null;
        if (reason === LK.DisconnectReason.ROOM_DELETED || state.ended) return ended();
        if (reason === LK.DisconnectReason.PARTICIPANT_REMOVED) return ended('You were removed from the call', 'Contact your admin if this was a mistake.');
        if (reason === LK.DisconnectReason.DUPLICATE_IDENTITY) return ended('You joined from another device', 'This phone has been disconnected because your account joined somewhere else.');
        if (left) return;
        const why = reasonName(reason);
        if (why === 'JOIN_FAILURE' || why === 'STATE_MISMATCH' || why === 'SIGNAL_CLOSE' || why === 'UNKNOWN_REASON' || why === 'CLIENT_INITIATED' || why === 'SERVER_SHUTDOWN' || why === 'MIGRATION' || why === '') {
          rejoinTries++;
          if (rejoinTries > 4) {
            show('#scrJoin');
            $('#jErr').textContent = `The call keeps dropping (${why || 'network'}). Try switching between Wi-Fi and mobile data, then join again.`;
            rejoinTries = 0;
            return;
          }
          setState('Reconnecting…');
          toast(`Connection lost. Rejoining… (${rejoinTries}/4)`, 'warn');
          setTimeout(() => startCall(me, true), 1500 * rejoinTries);
        } else {
          ended('You were disconnected', `Reason: ${why}. Tap below to join again.`);
        }
      });
  }

  function onData(m, from) {
    const info = from ? pInfo(from) : { role: 'member' };
    if (m.t === 'chat') return addChat(from ? from.name : 'Admin', m.text, false);
    if (m.t === 'hand') { m.up ? hands.add(from.identity) : hands.delete(from.identity); return render(); }
    if (m.t === 'hello') { if (amAdmin() && state.v) send(state, [from.identity]); return; }
    if (!isAdminRole(info.role)) return; // only admins can control the room
    if (m.t === 'state' && m.v >= state.v) {
      const prevTv = state.tv && state.tv.on;
      state = { ...state, ...m };
      if (state.tv && state.tv.on && !prevTv) powerOnTv();
      updateTv(); updateMinister(); updateLive();
    }
    if (m.t === 'mute' && (m.to === me.identity || (m.to === '*' && !amAdmin()))) {
      if (room && room.localParticipant.isMicrophoneEnabled) {
        setMic(false);
        toast('An admin muted your microphone. Tap the mic when you want to speak.', 'warn');
      }
    }
    if (m.t === 'end') { state.ended = true; if (room) room.disconnect(); ended(); }
  }

  function send(obj, to) {
    if (!room) return;
    room.localParticipant.publishData(encT.encode(JSON.stringify(obj)), { reliable: true, topic: 'jd', destinationIdentities: to }).catch(() => {});
  }
  function pushState(patch) { state = { ...state, ...patch, t: 'state', v: Date.now() }; send(state); updateTv(); updateMinister(); updateLive(); }

  // Helper admins keep the room state alive when the main PC is not in the call.
  setInterval(() => {
    if (!room || !amAdmin() || !state.v) return;
    const hostHere = [...room.remoteParticipants.values()].some((p) => pInfo(p).role === 'host');
    if (!hostHere) send(state);
  }, 8000);

  /* ---------------- mic ---------------- */
  async function setMic(on) {
    if (DEMO) { Demo.mic = on; micUi(); render(); return; }
    if (!room) return;
    if (on && !isLive()) return toast('The service has not started yet.', 'warn');
    try { await room.localParticipant.setMicrophoneEnabled(on); }
    catch (e) { toast(/denied|permission/i.test(e.message) ? 'Allow microphone access in your browser settings to speak.' : 'Your microphone could not start.', 'warn'); }
    micUi(); render();
  }
  function micOn() {
    if (DEMO) return Demo.mic;
    if (!room) return false;
    const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
    return !!(pub && !pub.isMuted && room.localParticipant.isMicrophoneEnabled);
  }
  function micUi() {
    const on = micOn();
    const b = $('#dMic');
    b.classList.toggle('on', on); b.classList.toggle('off', !on);
    $('#micLbl').textContent = on ? 'Mic on' : 'Tap to talk';
  }
  $('#dMic').onclick = () => setMic(!micOn());

  /* ---------------- render people ---------------- */
  function people() {
    if (DEMO) return Demo.people();
    if (!room) return [];
    return [room.localParticipant, ...room.remoteParticipants.values()].filter((p) => pInfo(p).role !== 'stream');
  }
  function pMic(p) {
    if (p.demo) return p.mic;
    if (p === (room && room.localParticipant)) return micOn();
    const pub = p.getTrackPublication(LK.Track.Source.Microphone);
    return !!(pub && !pub.isMuted);
  }
  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const list = people();
      const rank = (p) => (p.identity === me.identity ? 0 : isAdminRole(pInfo(p).role) ? 1 : hands.has(p.identity) ? 2 : 3);
      list.sort((a, b) => rank(a) - rank(b) || (a.name || '').localeCompare(b.name || ''));
      $('#cCount').textContent = list.length;
      $('#grid').innerHTML = list.map((p) => {
        const info = pInfo(p);
        const mine = p.identity === me.identity;
        const photo = mine ? (me.photo || info.photo) : info.photo;
        const on = pMic(p);
        return `<button class="p ${mine ? 'me' : ''}" data-id="${esc(p.identity)}" aria-label="${esc(p.name)}">
          ${hands.has(p.identity) ? '<span class="hand">✋</span>' : ''}
          <div class="ring"><div class="av" ${photo ? `style="background-image:url('${esc(photo)}')"` : ''}>${photo ? '' : esc(initials(p.name || p.identity))}</div></div>
          <span class="mic ${on ? 'on' : 'off'}">${on ? '<svg viewBox="0 0 24 24"><path d="M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4zM6 11a6 6 0 0 0 12 0"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 4l16 16M9.5 9.5v2a2.5 2.5 0 0 0 4.2 1.8M14.5 9V6.5a2.5 2.5 0 0 0-4.8-1M6 11a6 6 0 0 0 10 4.4"/></svg>'}</span>
          <span class="nm">${mine ? 'You' : esc(p.name || p.identity)}</span>
          ${roleLabel(info.role) ? `<span class="rl">${esc(roleLabel(info.role))}</span>` : ''}
          <span class="eq"><i></i><i></i><i></i><i></i></span>
        </button>`;
      }).join('');
    });
  }
  (function speakLoop() {
    const tiles = document.querySelectorAll('#grid .p');
    if (tiles.length) {
      const map = new Map(people().map((p) => [p.identity, p]));
      tiles.forEach((el) => {
        const p = map.get(el.dataset.id);
        if (!p) return;
        const lvl = Math.min(1, (p.audioLevel || 0) * 3);
        const speaking = p.isSpeaking || lvl > 0.05;
        el.classList.toggle('speaking', speaking);
        el.style.setProperty('--lvl', lvl.toFixed(2));
        el.querySelectorAll('.eq i').forEach((b, i) => (b.style.height = `${speaking ? 2 + lvl * (6 + ((i * 7) % 5)) : 2}px`));
        if (p.identity === me.identity) $('#dMic').style.setProperty('--lvl', lvl.toFixed(2));
      });
    }
    requestAnimationFrame(speakLoop);
  })();

  $('#grid').addEventListener('click', (e) => {
    const t = e.target.closest('.p');
    if (!t || !amAdmin() || t.dataset.id === me.identity) return;
    const p = people().find((x) => x.identity === t.dataset.id);
    if (!p) return;
    personTarget = p;
    $('#psName').textContent = p.name;
    $('#psMute').hidden = !pMic(p);
    openSheet('#personSheet');
  });

  /* ---------------- live / waiting ---------------- */
  function setState(text) { $('#cState').textContent = text; }
  function updateLive() {
    const live = isLive();
    $('#scrCall').classList.toggle('is-live', live);
    setState(live ? 'Live now' : 'Waiting to start');
    $('#waitBanner').hidden = live;
    $('#dMic').disabled = !live;
    $('#aStart').hidden = !amAdmin() || state.live;
  }

  /* ---------------- TV ---------------- */
  function tvTrackPub() {
    if (DEMO || !room) return null;
    for (const p of room.remoteParticipants.values()) {
      const pub = [...p.trackPublications.values()].find((t) => t.trackName === 'jd-tv');
      if (pub) return pub;
    }
    return null;
  }
  function updateTv() {
    const pub = tvTrackPub();
    const has = DEMO ? state.tv.on : !!(pub && pub.track && !pub.isMuted);
    $('#tvSlot').hidden = !(state.tv && state.tv.on && has);
  }
  function powerOnTv() {
    const tv = $('#tv');
    tv.classList.remove('powering'); void tv.offsetWidth; tv.classList.add('powering');
    setTimeout(() => tv.classList.remove('powering'), 900);
  }
  $('#tv').addEventListener('dblclick', () => { const s = $('#tv .tv-screen'); (s.requestFullscreen || s.webkitRequestFullscreen || (() => {})).call(s); });

  /* ---------------- minister ---------------- */
  function updateMinister() {
    const m = state.minister;
    $('#minister').hidden = !m;
    if (!m) return;
    $('#mName').textContent = m.name;
    $('#mTitle').textContent = m.title || '';
    const ph = $('#mPhoto');
    ph.style.backgroundImage = m.photo ? `url('${m.photo}')` : '';
    ph.textContent = m.photo ? '' : initials(m.name);
    if (navigator.mediaSession && 'MediaMetadata' in window) setupMediaSession();
  }

  /* ---------------- audio playback & background ---------------- */
  $('#audioOn').onclick = async () => { if (room) await room.startAudio(); $('#audioBanner').hidden = true; };
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.minister ? `${state.minister.name} — ${svc.title}` : svc.title,
        artist: svc.church || 'Jericho Afasuo Prayer City',
        album: 'JERICHO DEW',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('pause', () => setMic(false));
    } catch {}
  }
  // When the phone comes back to the page, make sure sound resumes.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && room) { room.startAudio().catch(() => {}); document.querySelectorAll('#audioSink audio').forEach((a) => a.play().catch(() => {})); }
  });

  /* ---------------- hand & chat ---------------- */
  $('#dHand').onclick = () => {
    const up = !hands.has(me.identity);
    up ? hands.add(me.identity) : hands.delete(me.identity);
    $('#dHand').classList.toggle('on', up);
    send({ t: 'hand', up });
    render();
    if (up) toast('Your hand is raised. The admin can see it.');
  };
  function addChat(name, text, mine) {
    const d = document.createElement('div');
    d.className = `msg ${mine ? 'me' : ''}`;
    d.innerHTML = `<b>${esc(mine ? 'You' : name)}</b>${esc(String(text).slice(0, 500))}`;
    const log = $('#chatLog'); log.appendChild(d); log.scrollTop = log.scrollHeight;
    while (log.children.length > 200) log.firstChild.remove();
    if (!mine && $('#chatSheet').hidden) { unread++; $('#chatBadge').hidden = false; }
  }
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('#chatInput').value.trim(); if (!t) return;
    send({ t: 'chat', text: t }); addChat('', t, true); $('#chatInput').value = '';
  };
  $('#dChat').onclick = () => { unread = 0; $('#chatBadge').hidden = true; openSheet('#chatSheet'); };

  /* ---------------- sheets ---------------- */
  function openSheet(id) { closeSheets(); $('#sheetBg').hidden = false; $(id).hidden = false; }
  function closeSheets() { ['#chatSheet', '#adminSheet', '#personSheet'].forEach((s) => ($(s).hidden = true)); $('#sheetBg').hidden = true; }
  $('#sheetBg').onclick = closeSheets;
  document.querySelectorAll('[data-close-sheet]').forEach((b) => (b.onclick = closeSheets));

  /* ---------------- admin controls (Admin-1, Admin-2 …) ---------------- */
  $('#dAdmin').onclick = () => { updateLive(); openSheet('#adminSheet'); };
  $('#aStart').onclick = () => { pushState({ live: true }); closeSheets(); toast('The service has started.'); };
  $('#aMuteAll').onclick = () => { send({ t: 'mute', to: '*', by: me.name }); closeSheets(); toast('Everyone has been muted.'); if (DEMO) Demo.muteAll(); };
  $('#aTvOff').onclick = () => { pushState({ tv: { ...(state.tv || {}), on: false } }); closeSheets(); };
  $('#aMinOff').onclick = () => { pushState({ minister: null }); closeSheets(); };
  $('#aEnd').onclick = () => {
    if (!confirm('End the service for everyone?')) return;
    state.ended = true; send({ t: 'end' }); pushState({ live: false });
    setTimeout(() => { if (room) room.disconnect(); ended(); }, 400);
  };
  $('#psMute').onclick = () => { if (personTarget) { send({ t: 'mute', to: personTarget.identity, by: me.name }, [personTarget.identity]); toast(`${personTarget.name} has been muted.`); if (DEMO) personTarget.mic = false; render(); } closeSheets(); };
  $('#psSpot').onclick = () => {
    if (personTarget) { const i = pInfo(personTarget); pushState({ minister: { identity: personTarget.identity, name: personTarget.name, title: i.title, photo: i.photo } }); }
    closeSheets();
  };

  /* ---------------- leave / end ---------------- */
  let left = false;
  $('#dLeave').onclick = async () => {
    if (!confirm('Leave the service?')) return;
    left = true;
    if (room) await room.disconnect();
    forget();
    ended('You left the service', 'Tap below to join again.');
  };
  function ended(title, text) {
    show('#scrEnd');
    $('#endTitle').textContent = title || 'The service has ended';
    $('#endText').textContent = text || 'God bless you. See you at the next service.';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  }
  $('#rejoin').onclick = () => { location.href = location.pathname; };
  $('#signOut').onclick = () => { forgetCred(); try { Object.keys(localStorage).filter((k) => k.startsWith('jd-ticket-')).forEach((k) => localStorage.removeItem(k)); } catch {} location.href = location.pathname; };
  window.addEventListener('pagehide', () => { if (room && left) room.disconnect(); });

  /* ---------------- demo (preview without a server): add ?demo to the link ---------------- */
  const Demo = {
    mic: false, list: [],
    start() {
      svc = svc || {};
      const names = ['Pastor Kwame Asante', 'Akosua Mensah', 'Yaw Boateng', 'Abena Owusu', 'Kofi Adjei', 'Esi Amoah', 'Kwabena Darko', 'Ama Serwaa', 'Nana Agyeman', 'Efua Quaye', 'Kojo Antwi', 'Adwoa Badu', 'Alex Ofori', 'Grace Nyarko'];
      this.list = [{ identity: me.identity, name: me.name, demo: true, attributes: { role: me.role } }]
        .concat(names.map((n, i) => ({ identity: `u${i}`, name: n, demo: true, mic: i < 3, audioLevel: 0, attributes: { role: i === 0 ? 'host' : i === 1 ? 'admin2' : 'member', title: i === 0 ? 'Senior Pastor' : '' } })));
      state = { v: 1, live: true, tv: { on: true }, minister: { name: 'Pastor Kwame Asante', title: 'Senior Pastor' } };
      hands.add('u5');
      const v = $('#tvVideo');
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const g = c.getContext('2d');
      const logo = new Image(); logo.src = 'logo.png';
      const draw = () => {
        const gr = g.createRadialGradient(640, 250, 40, 640, 360, 900); gr.addColorStop(0, '#1d4fd8'); gr.addColorStop(.55, '#0b2266'); gr.addColorStop(1, '#040b20');
        g.fillStyle = gr; g.fillRect(0, 0, 1280, 720);
        if (logo.complete) g.drawImage(logo, 28, 22, 64, 64);
        g.textAlign = 'center'; g.fillStyle = '#fba100'; g.font = '600 44px Lexend'; g.fillText('Psalm 23:1–2', 640, 170);
        g.fillStyle = '#fff'; g.font = '400 46px Lexend';
        ['The LORD is my shepherd; I shall not want.', 'He maketh me to lie down in green pastures:', 'he leadeth me beside the still waters.'].forEach((l, i) => g.fillText(l, 640, 300 + i * 70));
        g.fillStyle = '#fba100'; g.fillRect(0, 714, 1280, 6);
      };
      draw(); setInterval(draw, 1000);
      try { v.srcObject = c.captureStream(5); v.play().catch(() => {}); } catch {}
      setInterval(() => { this.list.forEach((p) => { if (p.mic) p.audioLevel = Math.random() < 0.35 ? Math.random() * 0.3 : 0; }); }, 220);
      setTimeout(powerOnTv, 300);
      $('#chatLog').innerHTML = '';
      addChat('Akosua Mensah', 'Amen! Good evening everyone 🙏', false);
      updateTv(); updateMinister(); updateLive(); micUi(); render();
      setInterval(render, 2000);
    },
    people() { return this.list.map((p) => (p.identity === me.identity ? { ...p, mic: this.mic, audioLevel: this.mic ? Math.random() * 0.2 : 0 } : p)); },
    muteAll() { this.list.forEach((p, i) => { if (i > 1) p.mic = false; }); render(); },
  };
  function demoService() {
    svc = { id: 'demo', title: 'Friday Prayer Night', date: new Date().toISOString().slice(0, 10), time: '19:00', church: 'Jericho Afasuo Prayer City', allowChat: true, allowHandRaise: true };
    $('#svcWhen').textContent = fmtWhen(svc.date, svc.time);
    $('#svcTitle').textContent = svc.title;
    $('#svcNote').textContent = 'Preview mode — type any name to look around.';
    $('#jUser').required = false; $('#jPass').required = false;
  }

  loadService();
})();

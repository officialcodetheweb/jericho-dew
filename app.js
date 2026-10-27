// JERICHO DEW — call app for members (runs on GitHub Pages)
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (String(n || '?').replace(/\(.*?\)/g, '').match(/[\p{L}\d]+/gu) || ['?']).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const isAdminRole = (r) => r === 'host' || /^admin\d+$/.test(r || '');
  const roleLabel = (r) => (r === 'host' ? 'Main admin' : r === 'guest' ? 'Guest' : /^admin(\d+)$/.test(r || '') ? `Admin-${r.slice(5)}` : '');
  const LK = window.LivekitClient;
  const encT = new TextEncoder();
  const decT = new TextDecoder();
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');

  // Personal join link: …/#join=<id>.<key>  (the key never leaves the phone)
  (() => {
    const m = /(?:^|[#&])join=([\w-]+)\.([\w-]+)/.exec(location.hash);
    if (m) { try { localStorage.setItem('jd-link', JSON.stringify({ id: m[1], key: m[2] })); } catch {} }
  })();
  const loadLink = () => { try { return JSON.parse(localStorage.getItem('jd-link') || 'null'); } catch { return null; } };
  const loadMe = () => { try { return JSON.parse(localStorage.getItem('jd-me') || 'null'); } catch { return null; } };
  const saveMe = (t) => { try { localStorage.setItem('jd-me', JSON.stringify({ name: t.name, photo: t.photo || '' })); } catch {} };
  function paintPhoto(el, who) {
    el.style.backgroundImage = who && who.photo ? `url('${who.photo}')` : '';
    el.textContent = who && who.photo ? '' : initials(who && who.name);
  }
  let svc = null;          // service document
  let me = null;           // { identity, name, role, photo, title }
  let room = null;
  let state = { v: 0, live: false, tv: { on: false }, minister: null, chat: true };
  const hands = new Set();
  let queueIds = [];
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
  async function openRaw(sealed, keyText) {
    const key = await crypto.subtle.importKey('raw', b64url(keyText), 'AES-GCM', false, ['decrypt']);
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
      $('#joinForm').hidden = false;
      const mc = document.getElementById('meCard'); if (mc) mc.remove();
      $('#svcWhen').textContent = fmtWhen(svc.date, svc.time);
      $('#svcTitle').textContent = svc.title;
      $('#svcNote').textContent = svc.description || svc.church || '';
      $('#jBtn').disabled = false;
      document.title = `${svc.title} · JERICHO DEW`;
      $('#guestBox').hidden = !svc.guestDoor;
      setUpcoming(svc); scheduleNotify();
      // Personal link: join straight away, no typing.
      const link = loadLink();
      if (link) {
        const sealed = svc.links && svc.links[link.id];
        if (sealed) {
          try {
            const ticket = await openRaw(sealed, link.key);
            saveMe(ticket);
            paintPhoto($('#ljPhoto'), ticket);
            $('#ljHi').textContent = `Welcome, ${String(ticket.name).split(' ')[0]}`;
            $('#linkJoiningText').textContent = `Joining ${svc.title}…`;
            $('#linkJoining').hidden = false;
            await new Promise((r) => setTimeout(r, 900));
            $('#linkJoining').hidden = true;
            return startCall(ticket, true);
          } catch { $('#linkJoining').hidden = true; }
        }
        $('#jErr').textContent = 'Your join link has changed. Ask your admin to send you the new link, or sign in below.';
      }
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
    const me = loadMe();
    const known = loadLink() || loadCred();
    $('#svcWhen').textContent = 'No service is open right now';
    $('#svcTitle').textContent = me && known ? `Hello, ${String(me.name).split(' ')[0]}` : (church || 'Jericho Afasuo Prayer City');
    $('#svcNote').textContent = known
      ? 'Your link is saved on this phone. Keep this page open — you will be joined automatically when the next service starts.'
      : 'Keep this page open or come back later. The next service will appear here by itself.';
    $('#jBtn').disabled = true;
    if (known) { $('#joinForm').hidden = true; $('#guestBox').hidden = true; showMeCard(me); }
    setTimeout(loadService, known ? 30000 : 60000);
  }
  function showMeCard(me) {
    if (!me || document.getElementById('meCard')) return;
    const d = document.createElement('div');
    d.className = 'me-card'; d.id = 'meCard';
    d.innerHTML = `<div class="lj-photo"></div><div><b></b><span>This phone joins as you</span></div>`;
    paintPhoto(d.firstElementChild, me);
    d.querySelector('b').textContent = me.name;
    $('#svcCard').after(d);
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

  /* ---------------- reminders ---------------- */
  let upcoming = null; // { title, startsAt, church }
  const startOf = (x) => x.startsAt || new Date(`${x.date}T${x.time || '00:00'}:00`).getTime();
  function setUpcoming(x) {
    upcoming = x ? { title: x.title, startsAt: startOf(x), church: x.church || (svc && svc.church) || '' } : null;
    $('#remindBox').hidden = !upcoming || upcoming.startsAt < Date.now() - 60000;
    tickCountdown();
  }
  function tickCountdown() {
    if (!upcoming) return;
    const ms = upcoming.startsAt - Date.now();
    if (ms <= 0) { $('#countdown').innerHTML = '<b>Starting now</b>'; return; }
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    $('#countdown').innerHTML = `Starts in <b>${d ? `${d} day${d > 1 ? 's' : ''} ` : ''}${h ? `${h} hr ` : ''}${m} min</b>`;
  }
  setInterval(tickCountdown, 30000);
  const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  $('#remindBtn').onclick = () => {
    $('#remindOpts').hidden = false; $('#remindBtn').hidden = true;
    const link = location.origin + location.pathname;
    const end = upcoming.startsAt + 2 * 36e5;
    $('#remindGoogle').href = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(upcoming.title)}&dates=${icsDate(upcoming.startsAt)}/${icsDate(end)}&details=${encodeURIComponent(`Join on JERICHO DEW: ${link}`)}`;
  };
  $('#remindIcs').onclick = () => {
    const link = location.origin + location.pathname;
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JERICHO DEW//EN', 'BEGIN:VEVENT',
      `UID:${upcoming.startsAt}-jericho-dew`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(upcoming.startsAt)}`, `DTEND:${icsDate(upcoming.startsAt + 2 * 36e5)}`,
      `SUMMARY:${upcoming.title}`, `DESCRIPTION:Join on JERICHO DEW: ${link}`, `URL:${link}`,
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${upcoming.title} starts in 15 minutes`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = 'jericho-dew-service.ics'; a.click();
  };
  $('#remindNotify').onclick = async () => {
    if (!('Notification' in window)) return toast('This phone cannot show page alerts. Use a calendar reminder instead.', 'warn');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Alerts are blocked. Use a calendar reminder instead.', 'warn');
    try { localStorage.setItem('jd-notify', '1'); } catch {}
    scheduleNotify();
    toast('We will alert you 15 minutes before and when it starts, as long as this page or app stays open.');
  };
  let notifyTimers = [];
  function scheduleNotify() {
    notifyTimers.forEach(clearTimeout); notifyTimers = [];
    let on = false; try { on = localStorage.getItem('jd-notify') === '1'; } catch {}
    if (!on || !upcoming || !('Notification' in window) || Notification.permission !== 'granted') return;
    const fire = (title, body) => {
      const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'jd-service' };
      if (navigator.serviceWorker && navigator.serviceWorker.ready) navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts)).catch(() => new Notification(title, opts));
      else new Notification(title, opts);
    };
    const t15 = upcoming.startsAt - 15 * 6e4 - Date.now();
    const t0 = upcoming.startsAt - Date.now();
    if (t15 > 0) notifyTimers.push(setTimeout(() => fire(upcoming.title, 'Starts in 15 minutes. Tap to join.'), t15));
    if (t0 > 0) notifyTimers.push(setTimeout(() => fire(upcoming.title, 'The service is starting now. Tap to join.'), t0));
  }

  /* ---------------- guests: ring the "door", the church PC hands back a listen-only pass ---------------- */
  $('#guestBtn').onclick = () => { $('#guestForm').hidden = false; $('#guestBtn').hidden = true; $('#guestName').focus(); };
  try { $('#guestName').value = localStorage.getItem('jd-guest') || ''; } catch {}
  $('#guestForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#guestName').value.trim();
    if (!name) { $('#guestErr').textContent = 'Type your name so the church knows who is listening.'; return; }
    try { localStorage.setItem('jd-guest', name); } catch {}
    $('#guestGo').disabled = true; $('#guestGo').textContent = 'Asking to join…'; $('#guestErr').textContent = '';
    try {
      const ticket = await ringDoor(name);
      await startCall({ ...ticket, role: 'guest', photo: '' });
    } catch (err) {
      $('#guestErr').textContent = err.message;
    } finally { $('#guestGo').disabled = false; $('#guestGo').textContent = 'Join as a guest'; }
  };
  async function ringDoor(name, attempt = 1) {
    const door = new LK.Room({ adaptiveStream: false, dynacast: false });
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      await door.connect(svc.livekitUrl, svc.guestDoor, { autoSubscribe: false });
    } catch { throw new Error('Could not reach the call. Check your internet and try again.'); }
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The church PC is not live yet. Guests can join once the service starts.')), 9000);
        door.on(LK.RoomEvent.DataReceived, (payload, _p, _k, topic) => {
          if (topic !== 'jd') return;
          let m; try { m = JSON.parse(decT.decode(payload)); } catch { return; }
          if (m.nonce !== nonce) return;
          clearTimeout(timer);
          if (m.t === 'guest-ok') resolve({ token: m.token, identity: m.identity, name: m.name });
          else reject(new Error(m.reason || 'Guests cannot join right now.'));
        });
        door.on(LK.RoomEvent.Disconnected, (reason) => {
          if (reason === LK.DisconnectReason.DUPLICATE_IDENTITY) { clearTimeout(timer); reject(new Error('busy')); }
        });
        const ask = () => door.localParticipant.publishData(encT.encode(JSON.stringify({ t: 'guest-req', nonce, name })), { reliable: true, topic: 'jd' }).catch(() => {});
        ask(); setTimeout(ask, 3000);
      });
    } catch (err) {
      if (err.message === 'busy' && attempt < 4) { await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200)); return ringDoor(name, attempt + 1); }
      throw err;
    } finally { try { door.disconnect(); } catch {} }
  }

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
  const isLive = () => !!(svc && svc.openRoom) || state.live || adminPresent() || amAdmin();

  async function startCall(ticket, silent) {
    me = ticket;
    if (ticket.role !== 'guest') saveMe(ticket);
    show('#scrCall');
    $('#cTitle').textContent = svc ? svc.title : 'Service';
    $('#dAdmin').hidden = !amAdmin();
    $('#dHand').hidden = svc && svc.allowHandRaise === false;
    $('#dChat').hidden = svc && svc.allowChat === false;
    if (DEMO) return Demo.start();
    setState('Connecting…');
    room = new LK.Room({
      // The only video in the call is the TV screen. Do not let LiveKit shrink it to the tiny on-screen size.
      adaptiveStream: false, dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { dtx: true, red: true },
    });
    bindRoom(room);
    try { room.registerByteStreamHandler(FILE_TOPIC, receiveFile); } catch {}
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
        if (track.kind === 'video' && pub.trackName === 'jd-tv') {
          if (audioOnly) { try { pub.setSubscribed(false); } catch {} return; }
          track.attach($('#tvVideo')); applyTvQuality(); updateTv();
        }
      })
      .on(E.TrackUnsubscribed, (track, pub) => { track.detach().forEach((el) => { if (el.id !== 'tvVideo') el.remove(); }); if (pub.trackName === 'jd-tv') updateTv(); })
      .on(E.TrackMuted, (pub, p) => { if (pub.trackName === 'jd-tv') updateTv(); if (p === r.localParticipant && pub.source === LK.Track.Source.Microphone) micUi(); render(); })
      .on(E.TrackUnmuted, (pub) => { if (pub.trackName === 'jd-tv') updateTv(); render(); micUi(); })
      .on(E.TrackPublished, (pub) => { if (pub && pub.trackName === 'jd-tv' && audioOnly) { try { pub.setSubscribed(false); } catch {} } render(); })
      .on(E.ConnectionQualityChanged, (q, p) => { if (p === r.localParticipant) showQuality(q); })
      .on(E.TrackUnpublished, () => render())
      .on(E.LocalTrackPublished, () => { micUi(); render(); })
      .on(E.LocalTrackUnpublished, () => { micUi(); render(); })
      .on(E.ParticipantPermissionsChanged, (_prev, p) => {
        if (p !== r.localParticipant || !me || me.role === 'guest') return;
        const can = !!(p.permissions && p.permissions.canPublish);
        me.blocked = !can; muteBanner(); micUi(); updateLive();
      })
      .on(E.AudioPlaybackStatusChanged, () => { $('#audioBanner').hidden = r.canPlaybackAudio; })
      .on(E.DataReceived, (payload, from, _k, topic) => {
        if (topic !== 'jd') return;
        let m; try { m = JSON.parse(decT.decode(payload)); } catch { return; }
        onData(m, from);
      })
      .on(E.Reconnecting, () => { setState('Reconnecting…'); showQuality('lost'); })
      .on(E.Reconnected, () => { updateLive(); send({ t: 'hello' }); showQuality('good'); })
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
    if (m.t === 'prayer') return amAdmin() ? onPrayer(m, from) : undefined; // sent privately to admins only
    if (m.t === 'hello') { if (amAdmin() && state.v) send(state, [from.identity]); return; }
    if (m.t === 'guest-req' || m.t === 'guest-ok' || m.t === 'guest-no') return;
    if (!isAdminRole(info.role)) return; // only admins can control the room
    if (m.t === 'admin-chat') { if (amAdmin()) addAdminChat(from ? from.name : 'Admin', m.text, false); return; }
    if (m.t === 'queue') {
      // The church PC keeps the speaking queue; every phone follows it.
      const ids = Array.isArray(m.ids) ? m.ids.map(String).slice(0, 200) : [];
      queueIds = ids; hands.clear(); ids.forEach((i) => hands.add(i));
      const mine = ids.indexOf(me.identity);
      $('#dHand').classList.toggle('on', mine >= 0);
      $('#dHand').querySelector('span').textContent = mine >= 0 ? `Hand · #${mine + 1}` : 'Hand';
      return render();
    }
    if (m.t === 'your-turn' && m.to === me.identity) {
      toast('It is your turn to speak. Tap the mic when you are ready.', 'warn');
      try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
      hands.delete(me.identity); $('#dHand').classList.remove('on'); $('#dHand').querySelector('span').textContent = 'Hand'; return render();
    }
    if (m.t === 'hand-down' && m.to === me.identity) { hands.delete(me.identity); $('#dHand').classList.remove('on'); $('#dHand').querySelector('span').textContent = 'Hand'; return render(); }
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
    if (m.t === 'can-speak' && m.to === me.identity) {
      me.canSpeak = !!m.allow; micUi();
      toast(m.allow ? 'The admin has let you speak. Tap the mic to talk.' : 'Speaking has been turned off for you.', 'warn');
      if (!m.allow) setMic(false);
    }
    if (m.t === 'soft-mute' && m.to === me.identity) {
      // Only the listener (the church PC or the admin) can still hear this phone.
      me.softMuted = !!m.on;
      if (room) room.localParticipant.setTrackSubscriptionPermissions(!m.on, m.on ? [{ participantIdentity: m.listener || from.identity, allowAll: true }] : []);
      muteBanner();
      if (!m.on) toast('Everyone can hear you again.');
      return;
    }
    if (m.t === 'blocked' && m.to === me.identity) {
      me.blocked = !!m.on; muteBanner(); micUi();
      if (!m.on) toast('The admin gave your mic back. Tap the mic when you want to speak.', 'warn');
      return;
    }
    if (m.t === 'end' && m.open) {
      state.ended = true; if (room) room.disconnect();
      return ended('This session has ended', 'The service stays open — tap Join again any time to come back in.');
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

  function muteBanner() {
    const b = $('#muteBanner');
    if (me && me.blocked) { b.className = 'banner mute full'; $('#muteBannerText').textContent = 'The admin has muted you completely. Nobody can hear you until the admin gives your mic back.'; b.hidden = false; }
    else if (me && me.softMuted) { b.className = 'banner mute'; $('#muteBannerText').textContent = 'The admin muted you for the members. Only the admin can hear you right now.'; b.hidden = false; }
    else b.hidden = true;
  }

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
    if (me && me.blocked) {
      const b = $('#dMic'); b.classList.remove('on'); b.classList.add('off'); b.disabled = true;
      $('#micLbl').textContent = 'Mic off by admin';
      return;
    }
    if (me && me.role === 'guest' && !me.canSpeak) {
      const b = $('#dMic'); b.classList.remove('on'); b.classList.add('off'); b.disabled = true;
      $('#micLbl').textContent = 'Listening';
      return;
    }
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
        return `<button class="p ${mine ? 'me' : ''} ${state.minister && state.minister.identity === p.identity ? 'spot' : ''}" data-id="${esc(p.identity)}" aria-label="${esc(p.name)}">
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
    $('#psSoft').textContent = p._soft ? 'Unmute for members' : 'Mute for members (only I hear them)';
    $('#psSpot').textContent = state.minister && state.minister.identity === p.identity ? 'Turn spotlight off' : 'Show as minister';
    openSheet('#personSheet');
  });

  /* ---------------- live / waiting ---------------- */
  function setState(text) { $('#cState').textContent = text; }
  function updateLive() {
    const live = isLive();
    $('#scrCall').classList.toggle('is-live', live);
    setState(live ? 'Live now' : 'Waiting to start');
    $('#waitBanner').hidden = live;
    $('#dMic').disabled = !live || (me && (me.blocked || (me.role === 'guest' && !me.canSpeak)));
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
    $('#tvSlot').hidden = audioOnly || !(state.tv && state.tv.on && has);
    $('#tvPaused').hidden = !(audioOnly && state.tv && state.tv.on);
  }
  /* ---- low data: audio only (TV picture is not downloaded at all) ---- */
  let audioOnly = false;
  try { audioOnly = localStorage.getItem('jd-audio-only') === '1'; } catch {}
  function setAudioOnly(on, quiet) {
    audioOnly = !!on;
    try { localStorage.setItem('jd-audio-only', on ? '1' : '0'); } catch {}
    const pub = tvTrackPub();
    if (pub && pub.setSubscribed) { try { pub.setSubscribed(!on); } catch {} }
    if (!on && pub && pub.track) { try { pub.track.attach($('#tvVideo')); applyTvQuality(); } catch {} }
    $('#bwBtn').classList.toggle('on', on);
    $('#bwBtn').textContent = on ? 'TV paused' : 'Audio only';
    updateTv();
    if (!quiet) toast(on ? 'Audio only: the TV picture is paused to save your data.' : 'TV picture is back on.');
  }
  $('#bwBtn').onclick = () => setAudioOnly(!audioOnly);
  $('#tvResume').onclick = () => setAudioOnly(false);
  $('#weakAudio').onclick = () => { setAudioOnly(true); $('#weakBanner').hidden = true; };
  let poorCount = 0;
  function showQuality(q) {
    const name = typeof q === 'string' ? q : (q && String(q).toLowerCase()) || 'good';
    $('#cQual').dataset.q = name;
    if (name === 'poor' || name === 'lost') {
      poorCount++;
      if (poorCount >= 2) {
        $('#weakText').textContent = name === 'lost' ? 'Your connection dropped. Trying to get back in…' : 'Your connection is weak. Sound may break up.';
        $('#weakAudio').hidden = audioOnly;
        $('#weakBanner').hidden = false;
      }
    } else { poorCount = 0; $('#weakBanner').hidden = true; }
  }
  window.addEventListener('offline', () => { $('#netBanner').hidden = false; showQuality('lost'); });
  window.addEventListener('online', () => {
    $('#netBanner').hidden = true;
    if (me && !room && !left && !$('#scrCall').hidden) startCall(me, true);
    else if (room) { try { room.startAudio(); } catch {} }
  });
  setAudioOnly(audioOnly, true);
  // HD by default. "Data saver" lets people on weak mobile data ask for a lighter copy.
  let tvHd = true;
  try { tvHd = localStorage.getItem('jd-tv-hd') !== '0'; } catch {}
  function applyTvQuality() {
    const pub = tvTrackPub();
    if (pub && pub.setVideoQuality) { try { pub.setVideoQuality(tvHd ? LK.VideoQuality.HIGH : LK.VideoQuality.LOW); } catch {} }
    const b = $('#tvQuality'); if (b) { b.textContent = tvHd ? 'HD' : 'Saver'; b.classList.toggle('saver', !tvHd); b.title = tvHd ? 'Sharp picture. Tap to save data.' : 'Data saver. Tap for the sharp picture.'; }
  }
  $('#tvQuality').addEventListener('click', (e) => {
    e.stopPropagation();
    tvHd = !tvHd; try { localStorage.setItem('jd-tv-hd', tvHd ? '1' : '0'); } catch {}
    applyTvQuality();
    toast(tvHd ? 'TV picture set to HD.' : 'Data saver on: the TV picture is lighter.');
  });
  applyTvQuality();
  function powerOnTv() {
    const tv = $('#tv');
    tv.classList.remove('powering'); void tv.offsetWidth; tv.classList.add('powering');
    setTimeout(() => tv.classList.remove('powering'), 900);
  }
  $('#tv').addEventListener('dblclick', () => { const s = $('#tv .tv-screen'); (s.requestFullscreen || s.webkitRequestFullscreen || (() => {})).call(s); });

  /* ---------------- minister ---------------- */
  function updateMinister() {
    const m = state.minister;
    render();
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
  function pushChatEl(d, mine) {
    const log = $('#chatLog'); log.appendChild(d); log.scrollTop = log.scrollHeight;
    while (log.children.length > 200) { const f = log.firstChild; const u = f.dataset && f.dataset.url; if (u) URL.revokeObjectURL(u); f.remove(); }
    if (!mine && $('#chatSheet').hidden) { unread++; $('#chatBadge').hidden = false; }
  }
  function addChat(name, text, mine) {
    const d = document.createElement('div');
    d.className = `msg ${mine ? 'me' : ''}`;
    d.innerHTML = `<b>${esc(mine ? 'You' : name)}</b>${esc(String(text).slice(0, 500))}`;
    pushChatEl(d, mine);
  }

  /* ---- files in messages (photos, PDFs, documents) ---- */
  const FILE_TOPIC = 'jd-file';
  const MAX_FILE = 8 * 1024 * 1024; // 8 MB
  const IMG_OK = /^image\/(png|jpe?g|gif|webp)$/i;
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const safeFile = (n) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 80);
  function addChatFile(name, file, blob, mine) {
    const url = URL.createObjectURL(blob);
    const isImg = IMG_OK.test(file.type || '');
    const d = document.createElement('div');
    d.className = `msg ${mine ? 'me' : ''} has-file`;
    d.dataset.url = url;
    d.innerHTML = `<b>${esc(mine ? 'You' : name)}</b>` + (isImg ? `<a href="${url}" target="_blank" rel="noopener"><img class="att-img" src="${url}" alt=""></a>` : '') +
      `<a class="att" href="${url}" download="${esc(safeFile(file.name))}"><span class="att-ic">${isImg ? '🖼' : '📎'}</span><span class="att-t"><span class="att-n">${esc(safeFile(file.name))}</span><span class="att-s">${fmtSize(file.size)} · Tap to save</span></span></a>`;
    pushChatEl(d, mine);
  }
  async function receiveFile(reader, info) {
    const from = info && info.participantInfo ? info.participantInfo.identity : '';
    if (from === (me && me.identity)) return;
    const size = (info && info.size) || 0;
    if (size > MAX_FILE) return;
    let chunks;
    try { chunks = await reader.readAll(); } catch { return; }
    const blob = new Blob(chunks, { type: (info && info.mimeType) || 'application/octet-stream' });
    if (blob.size > MAX_FILE) return;
    const p = room && room.remoteParticipants.get(from);
    addChatFile((p && p.name) || 'Someone', { name: info.name, size: blob.size, type: info.mimeType }, blob, false);
  }
  $('#chatFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f || !room) return;
    if (f.size > MAX_FILE) return toast(`That file is too big. Please keep it under ${fmtSize(MAX_FILE)}.`, 'warn');
    try {
      toast('Sending file…');
      await room.localParticipant.sendFile(f, { topic: FILE_TOPIC, mimeType: f.type || 'application/octet-stream' });
      addChatFile('', f, f, true);
    } catch { toast('The file could not be sent. Try again.', 'warn'); }
  };
  /* ---- admins-only channel ---- */
  let chatTab = 'all';
  const adminIds = () => (room ? [...room.remoteParticipants.values()].filter((p) => isAdminRole(pInfo(p).role)).map((p) => p.identity) : []);
  function addAdminChat(name, text, mine) {
    const d = document.createElement('div');
    d.className = `msg adm ${mine ? 'me' : ''}`;
    d.innerHTML = `<b>${esc(mine ? 'You' : name)}</b>${esc(String(text).slice(0, 500))}`;
    const log = $('#adminLog'); log.appendChild(d); log.scrollTop = log.scrollHeight;
    while (log.children.length > 200) log.firstChild.remove();
    if (!mine && (chatTab !== 'admin' || $('#chatSheet').hidden)) { $('#adminBadge').hidden = false; $('#chatBadge').hidden = false; }
  }
  function setChatTab(t) {
    chatTab = t;
    document.querySelectorAll('#chatTabs [data-ct]').forEach((b) => b.classList.toggle('on', b.dataset.ct === t));
    $('#chatLog').hidden = t !== 'all'; $('#adminLog').hidden = t !== 'admin';
    $('#chatInput').placeholder = t === 'admin' ? 'Message the admins only' : 'Write a message';
    $('.attach').hidden = t === 'admin';
    if (t === 'admin') { $('#adminBadge').hidden = true; if (!unread) $('#chatBadge').hidden = true; }
  }
  document.querySelectorAll('#chatTabs [data-ct]').forEach((b) => (b.onclick = () => setChatTab(b.dataset.ct)));
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('#chatInput').value.trim(); if (!t) return;
    if (chatTab === 'admin' && amAdmin()) {
      const ids = adminIds();
      if (ids.length) send({ t: 'admin-chat', text: t }, ids); else toast('No other admin is in the call right now.', 'warn');
      addAdminChat('', t, true);
    } else { send({ t: 'chat', text: t }); addChat('', t, true); }
    $('#chatInput').value = '';
  };
  $('#dChat').onclick = () => { unread = 0; $('#chatBadge').hidden = $('#adminBadge').hidden; $('#chatTabs').hidden = !amAdmin(); if (!amAdmin()) setChatTab('all'); openSheet('#chatSheet'); };

  /* ---- prayer requests: private to the admins ---- */
  let lastPrayer = 0;
  $('#dPray').onclick = () => openSheet('#praySheet');
  $('#prayForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#prayText').value.trim(); if (!text) return;
    if (Date.now() - lastPrayer < 20000) return toast('Please wait a moment before sending another.', 'warn');
    const ids = adminIds();
    // Never broadcast: with nobody to receive it, keep the request and tell the person.
    if (!ids.length) return toast('No admin is in the call yet. Please try again once the service has started.', 'warn');
    lastPrayer = Date.now();
    send({ t: 'prayer', id: `${me.identity}-${lastPrayer}`, text: text.slice(0, 300), anon: $('#prayAnon').checked }, ids);
    $('#prayText').value = ''; closeSheets();
    toast('Your request was sent privately to the admins. God bless you.');
  };
  const prayers = [];
  function onPrayer(m, from) {
    if (prayers.some((x) => x.id === m.id)) return;
    prayers.unshift({ id: String(m.id).slice(0, 80), who: m.anon ? 'Anonymous' : (from ? from.name : 'Member'), text: String(m.text || '').slice(0, 300) });
    if (prayers.length > 60) prayers.pop();
    $('#prBox').hidden = false; $('#prCount').textContent = `(${prayers.length})`;
    $('#prList').innerHTML = prayers.map((x) => `<div class="pr-item"><b>${esc(x.who)}</b>${esc(x.text)}</div>`).join('');
    $('#dAdmin').classList.add('has-new'); toast('New prayer request');
  }

  /* ---------------- sheets ---------------- */
  function openSheet(id) { closeSheets(); $('#sheetBg').hidden = false; $(id).hidden = false; }
  function closeSheets() { ['#chatSheet', '#adminSheet', '#personSheet', '#praySheet'].forEach((s) => ($(s).hidden = true)); $('#sheetBg').hidden = true; }
  $('#sheetBg').onclick = closeSheets;
  document.querySelectorAll('[data-close-sheet]').forEach((b) => (b.onclick = closeSheets));

  /* ---------------- admin controls (Admin-1, Admin-2 …) ---------------- */
  $('#dAdmin').onclick = () => { updateLive(); $('#dAdmin').classList.remove('has-new'); openSheet('#adminSheet'); };
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
  $('#psSoft').onclick = () => {
    if (personTarget) {
      personTarget._soft = !personTarget._soft;
      send({ t: 'soft-mute', to: personTarget.identity, on: personTarget._soft, listener: me.identity, by: me.name }, [personTarget.identity]);
      toast(personTarget._soft ? `Only you can hear ${personTarget.name} now.` : `Everyone can hear ${personTarget.name} again.`);
    }
    closeSheets();
  };
  $('#psSpot').onclick = () => {
    if (personTarget) {
      const already = state.minister && state.minister.identity === personTarget.identity;
      if (already) { pushState({ minister: null }); toast('Spotlight is off.'); }
      else { const i = pInfo(personTarget); pushState({ minister: { identity: personTarget.identity, name: personTarget.name, title: i.title, photo: i.photo } }); }
    }
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
  let endWatch = null;
  function ended(title, text) {
    show('#scrEnd');
    $('#endTitle').textContent = title || 'The service has ended';
    $('#endText').textContent = text || 'God bless you. See you at the next service.';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    // Ended by the admin? If this phone has a saved link/login, rejoin by itself when a service opens again.
    if (!title && !left && (loadLink() || loadCred()) && !endWatch) {
      const since = Date.now();
      $('#endText').textContent += ' If the service opens again, this phone will join by itself.';
      endWatch = setInterval(async () => {
        try {
          const idx = await getJson('data/index.json');
          const open = (idx.services || []).some((x) => !x.expiresAt || x.expiresAt > Date.now());
          if (open && idx.updatedAt && idx.updatedAt > since) { clearInterval(endWatch); location.href = location.pathname; }
        } catch {}
      }, 30000);
    }
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

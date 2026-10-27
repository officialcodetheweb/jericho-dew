// JERICHO DEW — stream output for OBS / vMix / Streamlabs (Browser Source, 1920×1080)
// Options: add &bg=transparent to the link for a see-through background.
'use strict';
(async () => {
  const $ = (s) => document.querySelector(s);
  const LK = window.LivekitClient;
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (String(n || '?').replace(/\(.*?\)/g, '').match(/[\p{L}\d]+/gu) || ['?']).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64url = (s) => b64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const dec = new TextDecoder();
  if (q.get('bg') === 'transparent') document.body.classList.add('transparent');

  let state = { v: 0, tv: { on: false }, minister: null };
  let room;
  const hands = new Set();
  const msg = (t) => { $('#msg').textContent = t || ''; $('#msg').hidden = !t; };

  async function getSvc() {
    const r = await fetch(`data/services/${encodeURIComponent(q.get('s'))}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('Service not found. Check the stream link.');
    return r.json();
  }
  async function token(svc) {
    const key = await crypto.subtle.importKey('raw', b64url(h.get('k') || ''), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(svc.stream.iv) }, key, b64(svc.stream.ct));
    return JSON.parse(dec.decode(pt)).token;
  }
  const isAdmin = (r) => r === 'host' || /^admin\d+$/.test(r || '');
  const pInfo = (p) => { let a = p.attributes || {}; if (!a.role && p.metadata) { try { a = { ...JSON.parse(p.metadata), ...a }; } catch {} } return a; };
  const avatar = (name, photo) => `<div class="av" ${photo ? `style="background-image:url('${esc(photo)}')"` : ''}>${photo ? '' : esc(initials(name))}</div>`;

  const MIC_ON = '<svg viewBox="0 0 24 24"><path d="M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4zM6 11a6 6 0 0 0 12 0"/></svg>';
  const MIC_OFF = '<svg viewBox="0 0 24 24"><path d="M4 4l16 16M9.5 9.5v2a2.5 2.5 0 0 0 4.2 1.8M14.5 9V6.5a2.5 2.5 0 0 0-4.8-1M6 11a6 6 0 0 0 10 4.4"/></svg>';
  const roleTxt = (r) => (r === 'host' ? 'Main admin' : r === 'guest' ? 'Guest' : /^admin(\d+)$/.test(r || '') ? `Admin-${r.slice(5)}` : '');
  const micOf = (p) => { const pub = p.getTrackPublication && p.getTrackPublication(LK.Track.Source.Microphone); return !!(pub && !pub.isMuted); };
  const people = () => (room ? [...room.remoteParticipants.values()].filter((p) => pInfo(p).role !== 'stream') : []);

  // Everyone in the call is shown. Tiles shrink as more people join so all of them stay on screen.
  function layout(n) {
    const tv = document.body.classList.contains('tv');
    const min = document.body.classList.contains('min');
    const W = tv ? 1920 - 1110 - 48 : 1920 - 96;
    const H = 1080 - 140 - (tv ? 60 : (min ? 190 : 60));
    let best = { sz: 40, cols: 1 };
    for (let cols = 1; cols <= Math.max(1, n); cols++) {
      const rows = Math.ceil(n / cols);
      const tw = W / cols, th = H / rows;
      const sz = Math.min(tw / 1.15, (th - 8) / 1.55, 190);
      if (sz > best.sz || cols === 1) best = { sz: Math.max(sz, 28), cols, tw, th };
    }
    return best;
  }
  let drawQueued = false;
  function drawPeople() {
    if (drawQueued) return; drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      const list = people();
      const rank = (p) => (pInfo(p).role === 'host' ? 0 : isAdmin(pInfo(p).role) ? 1 : hands.has(p.identity) ? 2 : 3);
      list.sort((a, b) => rank(a) - rank(b) || (a.name || '').localeCompare(b.name || ''));
      document.body.classList.toggle('empty', !list.length);
      if (!list.length) { $('#pgrid').innerHTML = ''; return; }
      const L = layout(list.length);
      const g = $('#pgrid');
      g.style.setProperty('--sz', `${L.sz}px`); g.style.setProperty('--tw', `${Math.floor(L.tw)}px`); g.style.setProperty('--th', `${Math.floor(L.th)}px`);
      const spot = state.minister && state.minister.identity;
      g.innerHTML = list.map((p) => {
        const i = pInfo(p), on = micOf(p);
        return `<div class="pt ${spot && spot === p.identity ? 'spot' : ''}" data-id="${esc(p.identity)}">
          <div class="ring">${avatar(p.name || p.identity, i.photo)}<span class="mic ${on ? 'on' : 'off'}">${on ? MIC_ON : MIC_OFF}</span>${hands.has(p.identity) ? '<span class="hand">✋</span>' : ''}</div>
          <span class="nm">${esc(p.name || p.identity)}</span>${roleTxt(i.role) ? `<span class="rl">${esc(roleTxt(i.role))}</span>` : ''}</div>`;
      }).join('');
    });
  }
  function paint() {
    const tvPub = room && [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()]).find((t) => t.trackName === 'jd-tv');
    document.body.classList.toggle('tv', !!(state.tv && state.tv.on && tvPub && tvPub.track && !tvPub.isMuted));
    const m = state.minister;
    document.body.classList.toggle('min', !!m);
    if (m) { $('#lName').textContent = m.name; $('#lTitle').textContent = m.title || ''; $('#lAv').outerHTML = `<div class="av" id="lAv" ${m.photo ? `style="background-image:url('${esc(m.photo)}')"` : ''}>${m.photo ? '' : esc(initials(m.name))}</div>`; }
    drawPeople();
  }
  // speaking rings follow the voice level
  setInterval(() => {
    if (!room) return;
    const map = new Map(people().map((p) => [p.identity, p]));
    document.querySelectorAll('.pt').forEach((el) => {
      const p = map.get(el.dataset.id); if (!p) return;
      const lvl = Math.min(1, (p.audioLevel || 0) * 3);
      el.classList.toggle('speaking', p.isSpeaking || lvl > 0.06);
      el.style.setProperty('--s', (1 + lvl * 0.14).toFixed(2));
    });
  }, 110);

  async function connect() {
    try {
      const svc = await getSvc();
      $('#title').textContent = svc.title;
      $('#church').textContent = svc.church || '';
      room = new LK.Room({ adaptiveStream: false, dynacast: false });
      const E = LK.RoomEvent;
      room
        .on(E.ParticipantConnected, drawPeople)
        .on(E.ParticipantDisconnected, (p) => { hands.delete(p.identity); drawPeople(); })
        .on(E.TrackPublished, drawPeople).on(E.TrackUnpublished, drawPeople)
        .on(E.TrackSubscribed, (track, pub) => {
          if (track.kind === 'audio') $('#sink').appendChild(track.attach());
          if (track.kind === 'video' && pub.trackName === 'jd-tv') { track.attach($('#tv')); pub.setVideoQuality && pub.setVideoQuality(LK.VideoQuality.HIGH); }
          paint();
        })
        .on(E.TrackUnsubscribed, (track) => { track.detach().forEach((el) => { if (el.id !== 'tv') el.remove(); }); paint(); })
        .on(E.TrackMuted, paint).on(E.TrackUnmuted, paint)
        .on(E.DataReceived, (payload, from, _k, topic) => {
          if (topic !== 'jd') return;
          let m; try { m = JSON.parse(dec.decode(payload)); } catch { return; }
          const role = from ? pInfo(from).role : '';
          if (m.t === 'hand' && from) { m.up ? hands.add(from.identity) : hands.delete(from.identity); return drawPeople(); }
          if (!(role === 'host' || /^admin\d+$/.test(role || ''))) return;
          if (m.t === 'state' && m.v >= state.v) { state = { ...state, ...m }; paint(); }
        })
        .on(E.Disconnected, () => { msg('Reconnecting…'); setTimeout(connect, 3000); });
      await room.connect(svc.livekitUrl, await token(svc), { autoSubscribe: true });
      await room.startAudio().catch(() => {});
      $('#live').hidden = false;
      msg('');
      paint();
      // Admins re-send the screen state every few seconds, so this page catches up on its own.
    } catch (e) {
      msg(e.message && /decrypt|operation/i.test(e.message) ? 'This stream link is not complete. Copy it again from JERICHO DEW.' : (e.message || 'Could not connect. Retrying…'));
      setTimeout(connect, 5000);
    }
  }
  connect();
})();

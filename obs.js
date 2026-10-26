// JERICHO DEW — stream output for OBS / vMix / Streamlabs (Browser Source, 1920×1080)
// Options: add &bg=transparent to the link for a see-through background.
'use strict';
(async () => {
  const $ = (s) => document.querySelector(s);
  const LK = window.LivekitClient;
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64url = (s) => b64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const dec = new TextDecoder();
  if (q.get('bg') === 'transparent') document.body.classList.add('transparent');

  let state = { v: 0, tv: { on: false }, minister: null };
  let room;
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
  const pInfo = (p) => { let a = p.attributes || {}; if (!a.role && p.metadata) { try { a = { ...JSON.parse(p.metadata), ...a }; } catch {} } return a; };
  const avatar = (name, photo) => `<div class="av" ${photo ? `style="background-image:url('${esc(photo)}')"` : ''}>${photo ? '' : esc(initials(name))}</div>`;

  function paint() {
    const tvPub = room && [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()]).find((t) => t.trackName === 'jd-tv');
    document.body.classList.toggle('tv', !!(state.tv && state.tv.on && tvPub && tvPub.track && !tvPub.isMuted));
    const m = state.minister;
    document.body.classList.toggle('min', !!m);
    if (m) { $('#lName').textContent = m.name; $('#lTitle').textContent = m.title || ''; $('#lAv').outerHTML = `<div class="av" id="lAv" ${m.photo ? `style="background-image:url('${esc(m.photo)}')"` : ''}>${m.photo ? '' : esc(initials(m.name))}</div>`; }
  }
  function speakers() {
    if (!room) return;
    const list = room.activeSpeakers.filter((p) => pInfo(p).role !== 'stream').slice(0, 4);
    $('#sideList').innerHTML = list.map((p) => `<div class="spk">${avatar(p.name, pInfo(p).photo)}<b>${esc(p.name)}</b></div>`).join('');
    $('#bigRow').innerHTML = list.map((p) => `<div class="big">${avatar(p.name, pInfo(p).photo)}<b>${esc(p.name)}</b></div>`).join('');
  }

  async function connect() {
    try {
      const svc = await getSvc();
      $('#title').textContent = svc.title;
      $('#church').textContent = svc.church || '';
      room = new LK.Room({ adaptiveStream: false, dynacast: false });
      const E = LK.RoomEvent;
      room
        .on(E.TrackSubscribed, (track, pub) => {
          if (track.kind === 'audio') $('#sink').appendChild(track.attach());
          if (track.kind === 'video' && pub.trackName === 'jd-tv') { track.attach($('#tv')); pub.setVideoQuality && pub.setVideoQuality(LK.VideoQuality.HIGH); }
          paint();
        })
        .on(E.TrackUnsubscribed, (track) => { track.detach().forEach((el) => { if (el.id !== 'tv') el.remove(); }); paint(); })
        .on(E.TrackMuted, paint).on(E.TrackUnmuted, paint)
        .on(E.ActiveSpeakersChanged, speakers)
        .on(E.DataReceived, (payload, from, _k, topic) => {
          if (topic !== 'jd') return;
          let m; try { m = JSON.parse(dec.decode(payload)); } catch { return; }
          const role = from ? pInfo(from).role : '';
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

// JERICHO DEW — stream output for OBS / vMix / Streamlabs (Browser Source, 1920×1080)
// Options: add &bg=transparent to the link for a see-through background.
'use strict';
(async () => {
  const $ = (s) => document.querySelector(s);
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (String(n || '?').replace(/\(.*?\)/g, '').match(/[\p{L}\d]+/gu) || ['?']).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (q.get('bg') === 'transparent') document.body.classList.add('transparent');

  let state = { v: 0, tv: { on: false }, minister: null };
  let net = null, hasVideo = false;
  const ppl = new Map();   // identity -> person (from the church PC)
  const hands = new Set();
  const msg = (t) => { $('#msg').textContent = t || ''; $('#msg').hidden = !t; };

  async function getSvc() {
    const r = await fetch(`data/services/${encodeURIComponent(q.get('s'))}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('Service not found. Check the stream link.');
    return r.json();
  }
  const isAdmin = (r) => r === 'host' || /^admin\d+$/.test(r || '');
  const pInfo = (p) => ({ role: p.r || 'member', title: p.t || '', photo: p.p || '' });
  const avatar = (name, photo) => `<div class="av" ${photo ? `style="background-image:url('${esc(photo)}')"` : ''}>${photo ? '' : esc(initials(name))}</div>`;

  const MIC_ON = '<svg viewBox="0 0 24 24"><path d="M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4zM6 11a6 6 0 0 0 12 0"/></svg>';
  const MIC_OFF = '<svg viewBox="0 0 24 24"><path d="M4 4l16 16M9.5 9.5v2a2.5 2.5 0 0 0 4.2 1.8M14.5 9V6.5a2.5 2.5 0 0 0-4.8-1M6 11a6 6 0 0 0 10 4.4"/></svg>';
  const roleTxt = (r) => (r === 'host' ? 'Main admin' : r === 'guest' ? 'Guest' : /^admin(\d+)$/.test(r || '') ? `Admin-${r.slice(5)}` : '');
  const micOf = (p) => !!p.m;
  const people = () => [...ppl.values()].map((p) => ({ ...p, identity: p.id, name: p.n }));

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
    document.body.classList.toggle('tv', !!(state.tv && state.tv.on && hasVideo));
    const m = state.minister;
    document.body.classList.toggle('min', !!m);
    if (m) { $('#lName').textContent = m.name; $('#lTitle').textContent = m.title || ''; $('#lAv').outerHTML = `<div class="av" id="lAv" ${m.photo ? `style="background-image:url('${esc(m.photo)}')"` : ''}>${m.photo ? '' : esc(initials(m.name))}</div>`; }
    drawPeople();
  }
  // speaking rings follow the voice level
  setInterval(() => {
    if (!net) return;
    const map = new Map([...ppl.values()].map((p) => [p.id, p]));
    document.querySelectorAll('.pt').forEach((el) => {
      const p = map.get(el.dataset.id); if (!p) return;
      const lvl = Math.min(1, (p.lv || 0) * 1.4);
      el.classList.toggle('speaking', lvl > 0.06);
      el.style.setProperty('--s', (1 + lvl * 0.14).toFixed(2));
    });
  }, 110);

  async function connect() {
    try {
      const svc = await getSvc();
      $('#title').textContent = svc.title;
      $('#church').textContent = svc.church || '';
      const key = h.get('k') || '';
      if (!key) throw new Error('This stream link is not complete. Copy it again from JERICHO DEW.');
      net = DewNet.create({ svc, auth: { kind: 'stream', key }, audioEl: $('#sink'), videoEl: $('#tv') });
      net.on('status', (st) => {
        if (st === 'connected') { $('#live').hidden = false; msg(''); return; }
        if (st === 'waiting-pc') return msg('Waiting for the church PC — open JERICHO DEW there.');
        if (st === 'reconnecting' || st === 'offline') return msg('Reconnecting…');
        if (/^denied:bad-key/.test(st)) return msg('This stream link is old. Copy it again from JERICHO DEW (Services → Copy stream link).');
        if (/^kicked|^denied/.test(st)) { msg('Reconnecting…'); setTimeout(() => location.reload(), 5000); }
      })
        .on('welcome', (m) => { ppl.clear(); for (const p of m.people || []) ppl.set(p.id, p); paint(); })
        .on('video', () => { hasVideo = true; paint(); })
        .on('autoplay-blocked', () => msg('Click once on this page (or tick "Control audio via OBS") to start the sound.'))
        .on('msg', (m) => {
          if (m.t === 'pj' || m.t === 'pu') { if (m.p) { const old = ppl.get(m.p.id); ppl.set(m.p.id, { ...m.p, lv: old ? old.lv : 0 }); m.p.h ? hands.add(m.p.id) : hands.delete(m.p.id); drawPeople(); } return; }
          if (m.t === 'pl') { ppl.delete(m.id); hands.delete(m.id); drawPeople(); return; }
          if (m.t === 'lv') { const l = m.l || {}; for (const p of ppl.values()) p.lv = Number(l[p.id]) || 0; return; }
          if (m.t === 'queue') { hands.clear(); (m.ids || []).forEach((i) => hands.add(String(i))); drawPeople(); return; }
          if (m.t === 'state' && m.v >= state.v) { state = { ...state, ...m }; paint(); }
          if (m.t === 'end' && !m.open) msg('The service has ended.');
        });
      net.start();
      document.addEventListener('click', () => net && net.resumeAudio());
    } catch (e) {
      msg(e.message || 'Could not connect. Retrying…');
      setTimeout(connect, 5000);
    }
  }
  connect();
})();

// JERICHO DEW — the phone side of the call when the church uses a LiveKit voice server.
// Same shape as DewNet (dewnet.js), so the rest of the page does not care which one is used:
//   voices: every phone hears the others (and the church PC's mic + music) through LiveKit;
//   messages (TV pictures, controls, chat): to and from the church PC as small LiveKit data messages.
// Members can join and talk even while the church PC is off; admin controls need the PC.
'use strict';
window.LkNet = (() => {
  let loading = null;
  function loadLk() {
    if (window.LivekitClient) return Promise.resolve();
    if (!loading) loading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'livekit-client.umd.js';
      s.onload = () => res(); s.onerror = () => { loading = null; rej(new Error('LiveKit did not load')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  const isAdmin = (r) => r === 'host' || /^admin\d+$/.test(r || '');

  /**
   * opts: { svc, lk: { url, token }, tv, hd, saver }
   * events: status(s) · welcome(m) · msg(m) · quality(q) · autoplay-blocked
   */
  function create(opts) {
    const L = {};
    const on = (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return api; };
    const emit = (ev, ...a) => (L[ev] || []).forEach((f) => { try { f(...a); } catch (e) { console.error(e); } });
    const enc = new TextEncoder(), dec = new TextDecoder();
    let room = null, closed = false, connected = false, micOn = false, tries = 0, retryT = null;
    const status = (s) => emit('status', s);
    const info = (p) => { let a = p.attributes || {}; if (!a.role && p.metadata) { try { a = { ...JSON.parse(p.metadata), ...a }; } catch {} } return a; };
    const micOf = (p) => p.identity !== 'host-pc' && [...p.audioTrackPublications.values()].some((t) => !t.isMuted);
    const pub = (p) => { const a = info(p); return { id: p.identity, n: p.name || p.identity, r: a.role || 'member', t: a.title || '', p: a.photo || '', m: micOf(p), h: false }; };
    const pcHere = () => !!room && [...room.remoteParticipants.values()].some((p) => p.identity === 'host-pc');
    const visible = (p) => p && !/^(door-|stream-)/.test(p.identity);

    function again(ms) { clearTimeout(retryT); retryT = setTimeout(start, ms); }
    function stop(reason) { status(reason); shutdown(); }

    async function start() {
      if (closed) return;
      clearTimeout(retryT);
      status(tries ? 'reconnecting' : 'connecting');
      try { await loadLk(); } catch { tries++; status('offline'); return again(5000); }
      if (closed) return;
      const LK = window.LivekitClient, E = LK.RoomEvent;
      const r = room = new LK.Room({
        adaptiveStream: true, dynacast: true,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        publishDefaults: { dtx: true, red: true },
      });
      r.on(E.ParticipantConnected, (p) => { if (!visible(p)) return; emit('msg', { t: 'pj', p: pub(p) }); if (p.identity === 'host-pc') setTimeout(pcArrived, 800); })
        .on(E.ParticipantDisconnected, (p) => { if (visible(p)) emit('msg', { t: 'pl', id: p.identity }); })
        .on(E.TrackSubscribed, (track) => {
          if (track.kind !== 'audio') return;
          const el = track.attach(); el.style.display = 'none'; document.body.appendChild(el);
          const pr = el.play && el.play(); if (pr && pr.catch) pr.catch(() => emit('autoplay-blocked'));
        })
        .on(E.TrackUnsubscribed, (track) => { track.detach().forEach((e) => e.remove()); })
        .on(E.TrackMuted, (_p, p) => personChanged(p))
        .on(E.TrackUnmuted, (_p, p) => personChanged(p))
        .on(E.TrackPublished, (_p, p) => personChanged(p))
        .on(E.TrackUnpublished, (_p, p) => personChanged(p))
        .on(E.ActiveSpeakersChanged, (list) => {
          if (pcHere()) return;                     // the church PC sends the speaking rings when it is there
          const l = {};
          for (const p of list) if (p !== r.localParticipant) l[p.identity] = Math.max(0.2, Math.min(1, Math.round((p.audioLevel || 0) * 300) / 100));
          emit('msg', { t: 'lv', l });
        })
        .on(E.DataReceived, (payload, p, _kind, topic) => {
          if (topic !== 'jd' || !p || p.identity !== 'host-pc') return;   // only the church PC gives instructions
          let m; try { m = JSON.parse(dec.decode(payload)); } catch { return; }
          if (m && typeof m.t === 'string') onData(m);
        })
        .on(E.ConnectionQualityChanged, (q, p) => { if (p === r.localParticipant) emit('quality', q === 'poor' ? 'poor' : q === 'lost' ? 'lost' : 'good'); })
        .on(E.AudioPlaybackStatusChanged, () => { if (!r.canPlaybackAudio) emit('autoplay-blocked'); })
        .on(E.Reconnecting, () => { status('reconnecting'); emit('quality', 'lost'); })
        .on(E.Reconnected, () => { status('connected'); emit('quality', 'good'); pcArrived(); })
        .on(E.Disconnected, (reason) => {
          connected = false;
          if (room !== r) return;
          room = null;
          if (closed) return;
          const R = LK.DisconnectReason || {};
          if (reason === R.DUPLICATE_IDENTITY) return stop('kicked:other-device');
          if (reason === R.ROOM_DELETED) return stop('kicked:ended');
          if (reason === R.PARTICIPANT_REMOVED) return stop('kicked:removed');
          tries++; status('reconnecting'); emit('quality', 'lost');
          again(Math.min(10000, 1500 * tries));
        });
      try {
        await r.connect(opts.lk.url, opts.lk.token, { autoSubscribe: true });
      } catch (e) {
        if (room === r) room = null;
        if (closed) return;
        const msg = String((e && e.message) || e);
        if (/401|invalid token|unauthor|expired|not valid/i.test(msg)) return stop('denied:bad-key');
        if (/full|limit|exceed/i.test(msg)) { status('denied:full'); return again(20000); }
        tries++; status('offline');
        return again(Math.min(10000, 1500 * tries));
      }
      if (room !== r || closed) { try { r.disconnect(); } catch {} return; }
      connected = true; tries = 0;
      status('connected');
      emit('welcome', {
        you: { id: r.localParticipant.identity, n: r.localParticipant.name },
        people: [...r.remoteParticipants.values()].filter(visible).map(pub),
        opts: { allowChat: opts.svc.allowChat, allowHandRaise: opts.svc.allowHandRaise, joinMuted: opts.svc.joinMuted },
      });
      emit('quality', 'good');
      if (micOn) { micOn = false; setMic(true).catch(() => {}); }
      if (pcHere()) pcArrived();
      if (!r.canPlaybackAudio) emit('autoplay-blocked');
    }
    // the church PC joined (or we reconnected): tell it how this phone wants the TV, and that we are here
    function pcArrived() {
      if (!room || !pcHere()) return;
      send({ t: 'tv-sub', on: opts.tv !== false, hd: opts.hd !== false });
      if (opts.saver) send({ t: 'saver', on: true });
      send({ t: 'mic', on: micOn });
      send({ t: 'hello' });
    }
    function personChanged(p) {
      if (!p || !room || p === room.localParticipant || !visible(p) || pcHere()) return;   // with the PC there, it keeps everyone's state
      emit('msg', { t: 'pu', p: pub(p) });
    }
    function onData(m) {
      const me = room && room.localParticipant;
      if (m.t === 'kicked') { stop(`kicked:${m.why || ''}`); return; }
      if (m.t === 'soft-mute' && me && m.to === me.identity) {
        // "Mute for members": only the church PC and the admins may hear this phone
        const allow = [...room.remoteParticipants.values()].filter((p) => p.identity === 'host-pc' || isAdmin(info(p).role)).map((p) => ({ participantIdentity: p.identity, allowAll: true }));
        try { me.setTrackSubscriptionPermissions(!m.on, m.on ? allow : []); } catch {}
      }
      emit('msg', m);
    }
    function send(obj) {
      const r = room;
      if (!r || !connected || !pcHere()) return false;
      try {
        const data = enc.encode(JSON.stringify(obj));
        if (data.length > 15000) return false;
        r.localParticipant.publishData(data, { reliable: true, topic: 'jd', destinationIdentities: ['host-pc'] }).catch(() => {});
        return true;
      } catch { return false; }
    }
    async function setMic(onWanted) {
      if (!room || !connected) { micOn = !!onWanted; return micOn; }
      await room.localParticipant.setMicrophoneEnabled(!!onWanted, { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
      micOn = !!onWanted;
      send({ t: 'mic', on: micOn });
      return micOn;
    }
    function micLevel() { return room && micOn ? Math.min(1, (room.localParticipant.audioLevel || 0) * 3) : 0; }
    function shutdown() {
      closed = true; clearTimeout(retryT);
      const r = room; room = null; connected = false;
      if (r) { try { r.disconnect(); } catch {} }
      document.querySelectorAll('audio[data-lk]').forEach((e) => e.remove());
    }
    const api = {
      on, send, setMic, micLevel, maxPart: 11000,
      start() { closed = false; tries = 0; start(); return api; },
      close: shutdown,
      resumeAudio() { if (room) room.startAudio().catch(() => {}); document.querySelectorAll('audio').forEach((a) => { if (a.paused && a.srcObject) a.play().catch(() => {}); }); },
      get connected() { return connected; },
      get micOn() { return micOn; },
      get player() { return null; },
    };
    return api;
  }
  return { create, load: loadLk };
})();

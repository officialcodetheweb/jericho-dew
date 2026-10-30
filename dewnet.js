// JERICHO DEW — the phone side of the call. The phone finds the church PC through PeerJS, proves who it is,
// then talks to the PC over a direct WebRTC link: this phone's voice goes up, the service sound comes down.
// While listening, the phone plays the PC's shared copy of the service (compressed once on the PC for everyone, decoded here).
// While speaking, the PC sends this phone its own mix without its own voice instead.
// No voice server in between. Data: about 40 kb/s down, up to 32 kb/s up while the mic is on (silence ≈ nothing).
'use strict';
window.DewNet = (() => {
  const ICE_FREE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ];
  const enc = new TextEncoder();
  const fromB64url = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (x) => x.charCodeAt(0));
  const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  async function proof(keyText, message) {
    const key = await crypto.subtle.importKey('raw', fromB64url(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toB64url(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  }

  /**
   * opts: { svc, auth: { kind: 'member', id, key } | { kind: 'guest', name } | { kind: 'stream', key }, tv, hd, saver, audioEl, videoEl }
   * events: status(s, detail) · welcome(m) · msg(m) · quality(q) · audio(stream) · video(stream)
   */
  function create(opts) {
    const L = {};
    const on = (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return api; };
    const emit = (ev, ...a) => (L[ev] || []).forEach((f) => { try { f(...a); } catch (e) { console.error(e); } });
    const net = (opts.svc && opts.svc.net) || {};
    const iceServers = [...(net.ice || []), ...ICE_FREE];
    const peerOpts = { debug: 0, config: { iceServers } };
    if (net.peer && net.peer.host) Object.assign(peerOpts, { host: net.peer.host, port: net.peer.port || 443, path: net.peer.path || '/', secure: net.peer.secure !== false, key: net.peer.key || 'peerjs' });

    let peer = null, conn = null, pc = null, gen = 0, closed = false, connected = false, retryT = null, tries = 0, stopReason = '';
    let micTrack = null, micOn = false, micOffT = null, micAn = null, micBuf = null, actx = null;
    let pingT = null, qualT = null, lastPong = 0;
    let player = null, playerStarting = null, lastSeq = -1;
    const status = (s, d) => emit('status', s, d);

    function start() {
      if (closed) return;
      clearTimeout(retryT);
      status(tries ? 'reconnecting' : 'connecting');
      if (!peer || peer.destroyed) {
        peer = new Peer(peerOpts);
        peer.on('open', () => dial());
        peer.on('disconnected', () => { if (!closed && peer && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch {} }, 2000); });
        peer.on('error', (e) => {
          const t = e && e.type;
          if (closed) return;
          if (t === 'peer-unavailable') { status('waiting-pc'); return again(8000); }       // JERICHO DEW is not open on the church PC
          if (['network', 'server-error', 'socket-error', 'socket-closed', 'unavailable-id'].includes(t)) { try { peer.destroy(); } catch {} peer = null; status('offline'); return again(5000); }
          console.warn('peer', t, e && e.message);
        });
      } else if (peer.open) dial();
    }
    function again(ms) { clearTimeout(retryT); retryT = setTimeout(start, ms); }

    function dial() {
      if (closed || !peer || !peer.open) return;
      if (conn) { try { conn.close(); } catch {} }
      const c = conn = peer.connect(opts.svc.hub, { reliable: true, serialization: 'json', metadata: { v: 2 } });
      let opened = false;
      const t = setTimeout(() => { if (!opened && conn === c) { try { c.close(); } catch {} status('waiting-pc'); again(6000); } }, 15000);
      c.on('open', () => { opened = true; clearTimeout(t); });
      c.on('data', (m) => { if (conn === c && m && typeof m === 'object') onData(m); });
      c.on('close', () => { clearTimeout(t); if (conn === c) lost(); });
      c.on('error', () => { clearTimeout(t); if (conn === c) lost(); });
    }
    function lost() {
      connected = false; conn = null;
      closePc();
      clearInterval(pingT); clearInterval(qualT);
      if (closed) return;
      if (stopReason) { status(stopReason); return; }
      tries++;
      status('reconnecting');
      emit('quality', 'lost');
      again(Math.min(10000, 1200 * tries));
    }

    async function onData(m) {
      switch (m.t) {
        case 'challenge': {
          const a = opts.auth;
          const msg = { t: 'auth', v: 2, kind: a.kind, tv: opts.tv !== false, hd: opts.hd !== false, saver: !!opts.saver };
          if (a.kind === 'member') { msg.id = a.id; msg.proof = await proof(a.key, `${m.n}:${String(a.id).toLowerCase()}`); }
          else if (a.kind === 'stream') msg.proof = await proof(a.key, `${m.n}:stream`);
          else msg.name = a.name;
          send(msg);
          return;
        }
        case 'welcome':
          connected = true; tries = 0;
          status('connected');
          emit('welcome', m);
          clearInterval(pingT); pingT = setInterval(() => send({ t: 'ping', ts: Date.now() }), 15000);
          clearInterval(qualT); qualT = setInterval(checkQuality, 4000);
          if (micOn) send({ t: 'mic', on: true });
          return;
        case 'denied': stopReason = `denied:${m.why || ''}`; closed = m.why !== 'full'; status(stopReason); if (m.why === 'full') { stopReason = ''; again(20000); } return;
        case 'kicked': stopReason = `kicked:${m.why || ''}`; closed = true; status(stopReason); shutdown(); return;
        case 'offer': return onOffer(m);
        case 'ice': if (pc && m.g === gen && m.c) pc.addIceCandidate(m.c).catch(() => {}); return;
        case 'pong': lastPong = Date.now(); return;
        default: emit('msg', m);
      }
    }
    function send(obj) { try { if (conn && conn.open) { conn.send(obj); return true; } } catch {} return false; }

    /* ---- the direct sound link ---- */
    async function onOffer(m) {
      closePc();
      gen = m.g;
      const p = pc = new RTCPeerConnection({ iceServers });
      p.onicecandidate = (e) => { if (e.candidate && pc === p) send({ t: 'ice', c: e.candidate.toJSON(), g: gen }); };
      let dropT = null;
      p.onconnectionstatechange = () => {
        if (pc !== p) return;
        clearTimeout(dropT);
        if (p.connectionState === 'connected') emit('quality', 'good');
        if (p.connectionState === 'failed') send({ t: 'renew' });
        if (p.connectionState === 'disconnected') { emit('quality', 'poor'); dropT = setTimeout(() => { if (pc === p && p.connectionState !== 'connected') send({ t: 'renew' }); }, 6000); }
      };
      p.ondatachannel = (e) => {
        if (e.channel.label !== 'pgm') return;
        const dc = e.channel; dc.binaryType = 'arraybuffer';
        lastSeq = -1;
        ensurePlayer();
        dc.onmessage = (ev) => { if (pc === p) onPgm(ev.data); };
      };
      p.ontrack = (e) => {
        const s = e.streams[0] || new MediaStream([e.track]);
        if (e.track.kind === 'audio') { if (opts.audioEl) { opts.audioEl.srcObject = s; play(); } emit('audio', s); }
        if (e.track.kind === 'video') { if (opts.videoEl) { opts.videoEl.srcObject = s; opts.videoEl.play().catch(() => {}); } emit('video', s); }
      };
      try {
        await p.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        if (opts.auth.kind !== 'stream') {
          const tr = p.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
          if (tr) { tr.direction = 'sendrecv'; if (micTrack && micTrack.readyState === 'live') await tr.sender.replaceTrack(micTrack); }
        }
        const ans = await p.createAnswer();
        await p.setLocalDescription(ans);
        send({ t: 'answer', sdp: p.localDescription.sdp, g: gen });
      } catch (e) { console.warn('answer', e); send({ t: 'renew' }); }
    }
    function closePc() { if (pc) { try { pc.close(); } catch {} pc = null; } if (player) player.node.port.postMessage({ reset: true }); }

    /* ---- the shared copy of the service: decode here, play smoothly ---- */
    function ensurePlayer() {
      if (player || playerStarting || opts.auth.kind === 'stream' || opts.listen === false) return playerStarting;
      playerStarting = (async () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC({ sampleRate: 48000, latencyHint: 'playback' });
        await ctx.audioWorklet.addModule(opts.workletUrl || 'pgm-player.js');
        const node = new AudioWorkletNode(ctx, 'pgm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        node.connect(ctx.destination);
        const dec = new window['opus-decoder'].OpusDecoder({ channels: 2, sampleRate: 48000 });
        await dec.ready;
        player = { ctx, node, dec };
        if (ctx.state !== 'running') { ctx.resume().catch(() => {}); setTimeout(() => { if (ctx.state !== 'running') emit('autoplay-blocked'); }, 800); }
      })().catch((e) => { console.warn('player', e); playerStarting = null; });
      return playerStarting;
    }
    function onPgm(buf) {
      if (!player) return;
      const b = new Uint8Array(buf); if (b.length < 4) return;
      const seq = (b[0] << 8) | b[1];
      if (lastSeq >= 0) { const d = (seq - lastSeq) & 0xffff; if (d === 0 || d > 0x8000) return; }   // late or repeated piece
      lastSeq = seq;
      try {
        const r = player.dec.decodeFrame(b.subarray(2));
        if (!r || !r.samplesDecoded) return;
        const L = r.channelData[0], R = r.channelData[1] || r.channelData[0];
        player.node.port.postMessage({ L, R }, R === L ? [L.buffer] : [L.buffer, R.buffer]);
      } catch (e) { /* a broken piece: skip it */ }
    }
    function play() { const a = opts.audioEl; if (!a) return; const pr = a.play(); if (pr && pr.catch) pr.catch(() => emit('autoplay-blocked')); }

    async function checkQuality() {
      if (!pc) return;
      try {
        const st = await pc.getStats(); let rtt = null, lost = 0, got = 0;
        st.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
          if (r.type === 'inbound-rtp' && r.kind === 'audio') { lost = r.packetsLost || 0; got = r.packetsReceived || 0; }
        });
        const loss = got ? (lost - (checkQuality.l || 0)) / Math.max(1, (got - (checkQuality.g || 0)) + (lost - (checkQuality.l || 0))) : 0;
        checkQuality.l = lost; checkQuality.g = got;
        emit('quality', loss > 0.08 || (rtt != null && rtt > 700) ? 'poor' : 'good', { rtt, loss });
      } catch {}
    }

    /* ---- this phone's microphone ---- */
    async function setMic(onWanted) {
      if (opts.auth.kind === 'stream') return false;
      clearTimeout(micOffT);
      if (onWanted) {
        if (!micTrack || micTrack.readyState !== 'live') {
          const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
          micTrack = s.getAudioTracks()[0];
          try {
            actx = actx || new (window.AudioContext || window.webkitAudioContext)();
            const src = actx.createMediaStreamSource(new MediaStream([micTrack]));
            micAn = actx.createAnalyser(); micAn.fftSize = 512; micBuf = new Float32Array(512); src.connect(micAn);
          } catch {}
        }
        micTrack.enabled = true;
        const tr = pc && pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
        if (tr && tr.sender.track !== micTrack) await tr.sender.replaceTrack(micTrack).catch(() => {});
        micOn = true;
      } else {
        micOn = false;
        if (micTrack) {
          micTrack.enabled = false;
          // let go of the microphone after a while, so the phone's "mic in use" light goes off
          micOffT = setTimeout(() => {
            if (micOn || !micTrack) return;
            const tr = pc && pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
            if (tr) tr.sender.replaceTrack(null).catch(() => {});
            micTrack.stop(); micTrack = null; micAn = null;
          }, 20000);
        }
      }
      send({ t: 'mic', on: micOn });
      return micOn;
    }
    function micLevel() {
      if (!micOn || !micAn) return 0;
      micAn.getFloatTimeDomainData(micBuf);
      let s = 0; for (let i = 0; i < micBuf.length; i += 2) s += micBuf[i] * micBuf[i];
      return Math.min(1, Math.sqrt(s / (micBuf.length / 2)) * 3);
    }

    function shutdown() {
      closed = true; clearTimeout(retryT); clearInterval(pingT); clearInterval(qualT); clearTimeout(micOffT);
      closePc();
      if (conn) { try { conn.close(); } catch {} conn = null; }
      if (peer) { try { peer.destroy(); } catch {} peer = null; }
      if (micTrack) { micTrack.stop(); micTrack = null; }
      if (player) { try { player.ctx.close(); player.dec.free(); } catch {} player = null; playerStarting = null; }
      connected = false;
    }

    const api = {
      on, send, setMic, micLevel,
      start() { closed = false; stopReason = ''; tries = 0; start(); return api; },
      close: shutdown,
      resumeAudio() { play(); if (actx && actx.state !== 'running') actx.resume().catch(() => {}); if (player && player.ctx.state !== 'running') player.ctx.resume().catch(() => {}); },
      get connected() { return connected; },
      get micOn() { return micOn; },
      get player() { return player; },
    };
    return api;
  }
  return { create };
})();

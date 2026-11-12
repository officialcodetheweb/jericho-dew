// JERICHO DEW — profile picture tools shared by the phone page and the church PC.
//   PhotoCrop.crop(fileOrBlob)  → square JPEG data URL (drag to move, pinch / slider / wheel to zoom, rotate) or null if cancelled
//   PhotoCrop.camera()          → a photo Blob from the webcam (PC) or null
//   PhotoCrop.GHANA_REGIONS     → the 16 regions of Ghana
'use strict';
window.PhotoCrop = (() => {
  const GHANA_REGIONS = ['Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East', 'Northern',
    'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North'];
  const OUT = 480;          // saved picture size (pixels, square)

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; }
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that picture.')); i.src = src; });
  }

  async function crop(file) {
    if (!file) return null;
    const url = URL.createObjectURL(file);
    let img;
    try { img = await loadImage(url); } catch (e) { URL.revokeObjectURL(url); throw e; }
    return new Promise((resolve) => {
      const wrap = el('div', 'pc-overlay', `
        <div class="pc-box" role="dialog" aria-modal="true" aria-label="Crop picture">
          <div class="pc-head"><b>Move and zoom your picture</b><span>Drag to move · pinch or slide to zoom</span></div>
          <div class="pc-stage"><canvas></canvas><div class="pc-ring"></div></div>
          <div class="pc-tools">
            <button type="button" class="pc-btn pc-rot" aria-label="Rotate">⟳</button>
            <input type="range" class="pc-zoom" min="1" max="4" step="0.01" value="1" aria-label="Zoom">
          </div>
          <div class="pc-foot"><button type="button" class="pc-btn pc-cancel">Cancel</button><button type="button" class="pc-btn pc-ok">Use picture</button></div>
        </div>`);
      document.body.appendChild(wrap);
      const stage = wrap.querySelector('.pc-stage');
      const cv = wrap.querySelector('canvas');
      const g = cv.getContext('2d');
      const zoomEl = wrap.querySelector('.pc-zoom');
      let rot = 0, zoom = 1, ox = 0, oy = 0, S = 300;   // offsets in stage pixels
      const dims = () => (rot % 180 ? [img.height, img.width] : [img.width, img.height]);
      const base = () => { const [w, h] = dims(); return S / Math.min(w, h); };   // scale where the picture just fills the square
      function clamp() {
        const [w, h] = dims(); const k = base() * zoom;
        const mx = Math.max(0, (w * k - S) / 2), my = Math.max(0, (h * k - S) / 2);
        ox = Math.max(-mx, Math.min(mx, ox)); oy = Math.max(-my, Math.min(my, oy));
      }
      function draw(ctx, size, scaleOut) {
        const k = base() * zoom * scaleOut;
        ctx.save();
        ctx.fillStyle = '#0b1f5e'; ctx.fillRect(0, 0, size, size);
        ctx.translate(size / 2 + ox * scaleOut, size / 2 + oy * scaleOut);
        ctx.rotate(rot * Math.PI / 180);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, -img.width * k / 2, -img.height * k / 2, img.width * k, img.height * k);
        ctx.restore();
      }
      function layout() {
        S = Math.round(stage.getBoundingClientRect().width) || 300;
        const dpr = window.devicePixelRatio || 1;
        cv.width = cv.height = Math.round(S * dpr);
        cv.style.width = cv.style.height = `${S}px`;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        clamp(); render();
      }
      const render = () => { clamp(); draw(g, S, 1); };
      // dragging and pinching
      const pts = new Map(); let last = null, pinch = null;
      stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = null; pinch = null; });
      stage.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const p = [...pts.values()];
        if (p.length === 1) {
          if (last) { ox += p[0].x - last.x; oy += p[0].y - last.y; }
          last = p[0];
        } else if (p.length === 2) {
          const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
          if (pinch) setZoom(zoom * d / pinch); pinch = d; last = null;
        }
        render();
      });
      const up = (e) => { pts.delete(e.pointerId); last = null; pinch = null; };
      stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
      stage.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); render(); }, { passive: false });
      function setZoom(z) { zoom = Math.max(1, Math.min(4, z)); zoomEl.value = zoom; }
      zoomEl.oninput = () => { zoom = Number(zoomEl.value); render(); };
      wrap.querySelector('.pc-rot').onclick = () => { rot = (rot + 90) % 360; [ox, oy] = [-oy, ox]; render(); };
      const done = (val) => { window.removeEventListener('resize', layout); URL.revokeObjectURL(url); wrap.remove(); resolve(val); };
      wrap.querySelector('.pc-cancel').onclick = () => done(null);
      wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      wrap.querySelector('.pc-ok').onclick = () => {
        const out = document.createElement('canvas'); out.width = out.height = OUT;
        draw(out.getContext('2d'), OUT, OUT / S);
        done(out.toDataURL('image/jpeg', 0.85));
      };
      window.addEventListener('resize', layout);
      requestAnimationFrame(layout);
      wrap.querySelector('.pc-ok').focus();
    });
  }

  // Take a picture with the computer's camera (the phone uses its own camera app instead).
  async function camera() {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' }, audio: false }); }
    catch { throw new Error('No camera found, or the camera is being used by another app.'); }
    return new Promise((resolve) => {
      const wrap = el('div', 'pc-overlay', `
        <div class="pc-box" role="dialog" aria-modal="true" aria-label="Take a picture">
          <div class="pc-head"><b>Take a picture</b><span>Look at the camera, then press Take picture</span></div>
          <div class="pc-stage pc-video"><video autoplay playsinline muted></video><div class="pc-ring"></div></div>
          <div class="pc-foot"><button type="button" class="pc-btn pc-cancel">Cancel</button><button type="button" class="pc-btn pc-ok">Take picture</button></div>
        </div>`);
      document.body.appendChild(wrap);
      const v = wrap.querySelector('video'); v.srcObject = stream;
      const done = (val) => { stream.getTracks().forEach((t) => t.stop()); wrap.remove(); resolve(val); };
      wrap.querySelector('.pc-cancel').onclick = () => done(null);
      wrap.querySelector('.pc-ok').onclick = () => {
        const c = document.createElement('canvas'); c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
        const x = c.getContext('2d'); x.translate(c.width, 0); x.scale(-1, 1); x.drawImage(v, 0, 0);   // mirror like a selfie
        c.toBlob((b) => done(b), 'image/jpeg', 0.92);
      };
    });
  }

  return { crop, camera, GHANA_REGIONS };
})();

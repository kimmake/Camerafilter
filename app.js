'use strict';
const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('preview');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('filmlab.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('filmlab.' + k, JSON.stringify(v)); } catch (e) {} }
};

// p = [sepia, saturate, contrast, brightness, hue-rotate(deg), grayscale]
const FILTERS = [
  { name: 'Classic Film', sub: 'Everyday 35mm', cam: 'assets/cam-classic.svg', p: [.30, .78, 1.10, 1.04, 0, 0],
    desc: '살짝 바랜 따뜻한 톤과 또렷한 대비. 어떤 장면에도 잘 어울리는 기본 필름.' },
  { name: 'Golden Hour', sub: 'Warm sunset', cam: 'assets/cam-golden.svg', p: [.48, 1.25, 1.08, 1.06, 0, 0],
    desc: '해 질 녘의 금빛을 담은 진한 웜 톤. 사람과 노을에 특히 좋아요.' },
  { name: 'Faded Memory', sub: 'Soft & hazy', cam: 'assets/cam-faded.svg', p: [.15, .60, .83, 1.13, 0, 0],
    desc: '채도와 대비를 낮춘 오래된 사진 느낌. 흐릿하고 부드러운 기억의 색.' },
  { name: 'Cool Blue', sub: 'Rainy day', cam: 'assets/cam-cool.svg', p: [.12, .77, 1.09, 1.00, 165, 0],
    desc: '차분하게 가라앉은 푸른 그늘. 비 오는 날과 도시의 밤에 어울려요.' },
  { name: 'Mono 95', sub: 'Black & white', cam: 'assets/cam-mono.svg', p: [0, 1, 1.22, 1.04, 0, 1],
    desc: '진한 대비의 흑백 필름. 빛과 그림자, 표정에 집중하고 싶을 때.' }
];
const ZOOMS = [1, 1.25, 1.5, 1.75, 2];

const state = {
  selected: clamp(store.get('filter', 0), 0, FILTERS.length - 1),
  strength: clamp(store.get('strength', 80), 0, 100),
  date: store.get('date', true),
  grain: store.get('grain', true),
  zoom: 1, ev: 0, flash: false, facing: 'environment'
};
let stream = null, track = null, torchOK = false, running = false, raf = 0, busy = false;
let lastBlob = null, lastUrl = null, galleryOpen = false;

/* ---------- filter pipeline ---------- */
function filterParams(i = state.selected, t = state.strength / 100, ev = state.ev) {
  const [sep, sat, con, bri, hue, gray] = FILTERS[i].p;
  return { sep: sep * t, sat: 1 + (sat - 1) * t, con: 1 + (con - 1) * t, bri: (1 + (bri - 1) * t) * Math.pow(2, ev * .35), hue: hue * t, gray: gray * t };
}
const cssFilter = p => `sepia(${p.sep}) saturate(${p.sat}) contrast(${p.con}) brightness(${p.bri}) hue-rotate(${p.hue}deg) grayscale(${p.gray})`;
const mixFilter = () => cssFilter(filterParams());

// iOS Safari는 canvas ctx.filter를 지원하지 않는다: 지원 여부를 감지해 픽셀 연산으로 대체한다.
const CSS_FILTER = (() => {
  if (/[?&]nofilter\b/.test(location.search)) return false;
  try {
    const t = document.createElement('canvas'); t.width = t.height = 1;
    const g = t.getContext('2d'); g.filter = 'grayscale(1)'; g.fillStyle = '#f00'; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data; return d[0] === d[1] && d[1] === d[2];
  } catch (e) { return false; }
})();

// 3x4 아핀 행렬: out = M·in + off (0..1). CSS 필터 체인과 같은 순서로 합성한다.
const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]).concat(r[0] * B[0][3] + r[1] * B[1][3] + r[2] * B[2][3] + r[3]));
function filterMatrix() {
  const p = filterParams(), a = 1 - clamp(p.sep, 0, 1), s = p.sat, g = 1 - clamp(p.gray, 0, 1);
  const th = p.hue * Math.PI / 180, c = Math.cos(th), n = Math.sin(th);
  const sepia = [[.393 + .607 * a, .769 - .769 * a, .189 - .189 * a, 0], [.349 - .349 * a, .686 + .314 * a, .168 - .168 * a, 0], [.272 - .272 * a, .534 - .534 * a, .131 + .869 * a, 0]];
  const sat = [[.213 + .787 * s, .715 - .715 * s, .072 - .072 * s, 0], [.213 - .213 * s, .715 + .285 * s, .072 - .072 * s, 0], [.213 - .213 * s, .715 - .715 * s, .072 + .928 * s, 0]];
  const con = [[p.con, 0, 0, .5 - .5 * p.con], [0, p.con, 0, .5 - .5 * p.con], [0, 0, p.con, .5 - .5 * p.con]];
  const bri = [[p.bri, 0, 0, 0], [0, p.bri, 0, 0], [0, 0, p.bri, 0]];
  const hue = [[.213 + c * .787 - n * .213, .715 - c * .715 - n * .715, .072 - c * .072 + n * .928, 0], [.213 - c * .213 + n * .143, .715 + c * .285 + n * .140, .072 - c * .072 - n * .283, 0], [.213 - c * .213 - n * .787, .715 - c * .715 + n * .715, .072 + c * .928 + n * .072, 0]];
  const gray = [[.2126 + .7874 * g, .7152 - .7152 * g, .0722 - .0722 * g, 0], [.2126 - .2126 * g, .7152 + .2848 * g, .0722 - .0722 * g, 0], [.2126 - .2126 * g, .7152 - .7152 * g, .0722 + .9278 * g, 0]];
  return [sat, con, bri, hue, gray].reduce((m, x) => mul(x, m), sepia);
}
function applyFilterPixels(c, w, h) {
  const im = c.getImageData(0, 0, w, h), d = im.data, m = filterMatrix();
  const [a0, a1, a2, a3] = m[0], [b0, b1, b2, b3] = m[1], [c0, c1, c2, c3] = m[2];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    d[i] = (a0 * r + a1 * g + a2 * b + a3) * 255; d[i + 1] = (b0 * r + b1 * g + b2 * b + b3) * 255; d[i + 2] = (c0 * r + c1 * g + c2 * b + c3) * 255;
  }
  c.putImageData(im, 0, 0);
}

function drawFrame(target, w, h) {
  const c = target.getContext('2d', { alpha: false, willReadFrequently: !CSS_FILTER });
  c.save(); c.fillStyle = '#0b0a08'; c.fillRect(0, 0, w, h);
  let drawn = false;
  if (video.readyState >= 2 && video.videoWidth) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.max(w / vw, h / vh) * state.zoom, sw = w / scale, sh = h / scale;
    c.translate(state.facing === 'user' ? w : 0, 0); c.scale(state.facing === 'user' ? -1 : 1, 1);
    if (CSS_FILTER) c.filter = mixFilter();
    c.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
    if (CSS_FILTER) c.filter = 'none';
    drawn = true;
  }
  c.restore();
  if (drawn && !CSS_FILTER) applyFilterPixels(c, w, h);
}

function render() {
  if (!running || galleryOpen) return;
  const dpr = Math.min(devicePixelRatio || 1, CSS_FILTER ? 2 : 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  drawFrame(canvas, w, h);
  raf = requestAnimationFrame(render);
}
const resume = () => { cancelAnimationFrame(raf); if (running && !galleryOpen && !document.hidden) render(); };

/* ---------- camera ---------- */
const setStatus = s => { $('status').textContent = s; };
let statusTimer = 0;
const flashStatus = (s, ms = 2200) => { setStatus(s); clearTimeout(statusTimer); statusTimer = setTimeout(() => setStatus(''), ms); };

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('emptyHint').textContent = 'HTTPS 주소(또는 localhost)에서 Safari/Chrome으로 열어 주세요.'; return;
  }
  stopCamera(); $('start').disabled = true; $('emptyHint').textContent = '카메라 연결 중...';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
    video.srcObject = stream; await video.play();
    track = stream.getVideoTracks()[0];
    let caps = {}; try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) {}
    torchOK = !!caps.torch;
    running = true; $('empty').hidden = true; $('shutter').disabled = false; $('emptyHint').textContent = '';
    updateFlashUI(); render();
  } catch (e) {
    $('empty').hidden = false;
    $('emptyHint').textContent = e.name === 'NotAllowedError' ? '카메라 권한이 거부됐어요. 브라우저/기기 설정에서 허용해 주세요.' : '카메라를 시작하지 못했어요: ' + (e.name || '오류');
  } finally { $('start').disabled = false; }
}
function stopCamera() {
  running = false; cancelAnimationFrame(raf);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }
  video.srcObject = null; $('shutter').disabled = true;
}

/* ---------- controls ---------- */
function updateFilterUI() {
  const f = FILTERS[state.selected];
  $('filterLabel').textContent = f.name.toUpperCase();
  $('strengthTag').textContent = state.strength + '%';
  $('camPickImg').src = f.cam;
  document.querySelectorAll('.cam').forEach((b, i) => b.setAttribute('aria-selected', i === state.selected));
  $('heroPhoto').style.filter = cssFilter(filterParams(state.selected, 1, 0));
  $('heroCam').src = f.cam; $('heroName').textContent = f.name; $('heroSub').textContent = f.sub; $('heroDesc').textContent = f.desc;
}
function selectFilter(i) { state.selected = i; store.set('filter', i); updateFilterUI(); }

function updateZoomUI() {
  const z = state.zoom;
  $('zoomLabel').textContent = (Number.isInteger(z) ? z : z.toFixed(2).replace(/0$/, '')) + 'x';
  $('zoomKind').textContent = z === 1 ? 'WIDE' : 'DIGITAL';
  document.querySelectorAll('.tick').forEach(t => t.classList.toggle('on', Number(t.dataset.z) === z));
}
function updateToggles() {
  for (const [id, key] of [['dateToggle', 'date'], ['grainToggle', 'grain']]) {
    const b = $(id); b.setAttribute('aria-pressed', state[key]); b.querySelector('b').textContent = state[key] ? 'ON' : 'OFF';
  }
  $('dateLabel').hidden = !state.date; $('grainLayer').classList.toggle('off', !state.grain);
}
function updateFlashUI() {
  const b = $('flashBtn'), front = state.facing === 'user';
  const usable = front || torchOK;
  b.disabled = !usable; if (!usable) state.flash = false;
  b.setAttribute('aria-pressed', state.flash);
  b.title = usable ? (front ? '화면 플래시' : '플래시') : '이 기기/브라우저에서는 후면 플래시를 지원하지 않아요';
}
function toggleTray(which) {
  const map = { more: ['trayMore', 'moreBtn'], exp: ['trayExposure', 'expBtn'] };
  const open = !$(map[which][0]).hidden;
  for (const [row, btn] of Object.values(map)) { $(row).hidden = true; $(btn).setAttribute('aria-expanded', false); }
  if (!open) { $(map[which][0]).hidden = false; $(map[which][1]).setAttribute('aria-expanded', true); }
  $('tray').hidden = open;
}

function setGallery(open) {
  galleryOpen = open;
  const g = $('gallery'); g.classList.toggle('open', open); g.setAttribute('aria-hidden', !open);
  if (open) { cancelAnimationFrame(raf); g.scrollTop = 0; } else resume();
}

/* ---------- capture ---------- */
function makeNoise() {
  const n = document.createElement('canvas'); n.width = n.height = 160;
  const g = n.getContext('2d'), im = g.createImageData(160, 160);
  for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0); return n;
}
function addGrain(c, w, h) {
  const n = makeNoise(), g = c.getContext('2d');
  g.save(); g.globalAlpha = .13; g.globalCompositeOperation = 'overlay';
  const s = Math.max(1, Math.round(w / 520));
  for (let y = 0; y < h; y += 160 * s) for (let x = 0; x < w; x += 160 * s) g.drawImage(n, x, y, 160 * s, 160 * s);
  g.restore();
}
const dateStamp = () => { const d = new Date(), p = v => String(v).padStart(2, '0'); return `'${String(d.getFullYear()).slice(2)}.${p(d.getMonth() + 1)}.${p(d.getDate())}`; };
function stamp(c, w, h) {
  const g = c.getContext('2d'); g.save();
  g.font = `${Math.round(Math.min(w, h) * .034)}px ui-monospace,Menlo,monospace`; g.textAlign = 'right'; g.fillStyle = '#ffb56f';
  g.shadowColor = '#000'; g.shadowBlur = 3; g.fillText(dateStamp(), w * .94, h * .955); g.restore();
}
function vignette(c, w, h) {
  const g = c.getContext('2d'), r = Math.hypot(w, h) / 2, grd = g.createRadialGradient(w / 2, h / 2, r * .55, w / 2, h / 2, r);
  grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,.38)'); g.fillStyle = grd; g.fillRect(0, 0, w, h);
}

async function shoot() {
  if (!running || busy || video.readyState < 2) return;
  busy = true; $('shutter').disabled = true;
  let cleanup = async () => {};
  try {
    if (state.flash) {
      if (state.facing === 'user') { $('flashFx').classList.add('on'); await sleep(220); cleanup = async () => $('flashFx').classList.remove('on'); }
      else if (torchOK) { await track.applyConstraints({ advanced: [{ torch: true }] }); await sleep(350); cleanup = async () => { try { await track.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {} }; }
    }
    // 화면에 보이는 뷰파인더와 같은 비율·같은 확대율로 촬영 (WYSIWYG)
    const ar = canvas.clientWidth / canvas.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
    let cw, ch;
    if (vw / vh > ar) { ch = vh / state.zoom; cw = ch * ar; } else { cw = vw / state.zoom; ch = cw / ar; }
    const k = Math.min(1, 2400 / Math.max(cw, ch));
    const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
    drawFrame(out, out.width, out.height);
    await cleanup(); cleanup = async () => {};
    $('blink').classList.remove('go'); void $('blink').offsetWidth; $('blink').classList.add('go');
    if (state.grain) addGrain(out, out.width, out.height);
    vignette(out, out.width, out.height);
    if (state.date) stamp(out, out.width, out.height);
    setStatus('사진 처리 중...');
    const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', .93));
    if (!blob) { flashStatus('사진 생성에 실패했어요.'); return; }
    lastBlob = blob; if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = URL.createObjectURL(blob);
    $('shot').src = lastUrl; $('download').href = lastUrl; $('download').download = `film-lab-${Date.now()}.jpg`;
    setThumb(lastUrl); saveThumb(out); setStatus('');
    $('modal').classList.add('show'); $('modal').setAttribute('aria-hidden', false);
  } catch (e) { flashStatus('촬영 중 문제가 생겼어요.'); }
  finally { await cleanup(); busy = false; $('shutter').disabled = !running; }
}
function setThumb(url) { const i = $('thumbImg'); i.src = url; i.hidden = false; }
function saveThumb(src) {
  try { const t = document.createElement('canvas'); t.width = 116; t.height = 116; const g = t.getContext('2d'); const s = Math.min(src.width, src.height);
    g.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 116, 116); store.set('thumb', t.toDataURL('image/jpeg', .7)); } catch (e) {}
}
async function share() {
  if (!lastBlob) return;
  const file = new File([lastBlob], 'film-lab.jpg', { type: 'image/jpeg' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'FILM LAB' }); return; }
    flashStatus('공유를 지원하지 않아요. 파일 다운로드를 이용해 주세요.');
  } catch (e) { if (e.name !== 'AbortError') flashStatus('공유 실패: 파일 다운로드를 이용해 주세요.'); }
}
function closeModal() { $('modal').classList.remove('show'); $('modal').setAttribute('aria-hidden', true); }

/* ---------- init ---------- */
function buildGrid() {
  FILTERS.forEach((f, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'cam'; b.setAttribute('role', 'option');
    b.innerHTML = `<img alt="" src="${f.cam}"><span>${f.name}</span>`;
    b.onclick = () => selectFilter(i); $('grid').appendChild(b);
  });
}
function init() {
  try { const n = makeNoise(); document.documentElement.style.setProperty('--noise', `url(${n.toDataURL('image/png')})`); } catch (e) {}
  buildGrid();
  $('strength').value = state.strength; $('strengthValue').textContent = state.strength + '%';
  $('exposure').value = 0; $('dateLabel').textContent = dateStamp();
  updateFilterUI(); updateZoomUI(); updateToggles(); updateFlashUI();
  const t = store.get('thumb', null); if (t) setThumb(t);

  $('start').onclick = startCamera;
  $('switch').onclick = () => { state.facing = state.facing === 'environment' ? 'user' : 'environment'; torchOK = false; running ? startCamera() : updateFlashUI(); };
  $('shutter').onclick = shoot;
  $('strength').oninput = e => { state.strength = Number(e.target.value); $('strengthValue').textContent = state.strength + '%'; $('strengthTag').textContent = state.strength + '%'; store.set('strength', state.strength); $('heroPhoto').style.filter = cssFilter(filterParams(state.selected, 1, 0)); };
  $('exposure').oninput = e => { state.ev = Number(e.target.value); $('exposureValue').textContent = (state.ev > 0 ? '+' : '') + state.ev.toFixed(1) + ' EV'; };
  document.querySelectorAll('.tick').forEach(t => t.onclick = () => { state.zoom = Number(t.dataset.z); updateZoomUI(); });
  $('dateToggle').onclick = () => { state.date = !state.date; store.set('date', state.date); updateToggles(); };
  $('grainToggle').onclick = () => { state.grain = !state.grain; store.set('grain', state.grain); updateToggles(); };
  $('flashBtn').onclick = () => { state.flash = !state.flash; updateFlashUI(); if (state.flash) flashStatus(state.facing === 'user' ? '촬영 시 화면이 밝게 켜져요.' : '촬영 시 플래시가 켜져요.'); };
  $('moreBtn').onclick = () => toggleTray('more');
  $('expBtn').onclick = () => toggleTray('exp');
  $('camPick').onclick = $('filterTag').onclick = () => setGallery(true);
  $('backBtn').onclick = () => setGallery(false);
  $('thumb').onclick = () => { if (lastBlob) { $('modal').classList.add('show'); $('modal').setAttribute('aria-hidden', false); } else flashStatus('방금 찍은 사진부터 다시 볼 수 있어요.'); };
  $('share').onclick = share; $('close').onclick = closeModal;
  $('modal').onclick = e => { if (e.target === $('modal')) closeModal(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else resume(); });
  window.addEventListener('pagehide', stopCamera);
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
init();

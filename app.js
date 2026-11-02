'use strict';
const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('preview');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('filmlab.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('filmlab.' + k, JSON.stringify(v)); } catch (e) {} }
};
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* 필터 정의 — 모두 서로 다른 처리 파라미터를 가진다.
   p = [sepia, saturate, contrast, brightness, hue-rotate(deg), grayscale]
   fade = [색, 강도]  (블랙 리프트/색 틴트), grain = 입자 강도, vig = 비네팅 강도 */
const FILTERS = [
  { name: 'Classic 95', sub: '90s everyday film', cam: 'assets/cam-classic.svg', p: [.30, .78, 1.10, 1.04, 0, 0], fade: ['#2a1e14', .04], grain: .12, vig: .30,
    desc: '따뜻하고 자연스러운 90년대 필름. 어떤 장면에도 잘 어울리는 기본 색감.' },
  { name: 'Golden Hour', sub: 'warm sunset', cam: 'assets/cam-golden.svg', p: [.48, 1.25, 1.08, 1.06, 0, 0], fade: ['#5a3a10', .05], grain: .12, vig: .34,
    desc: '노란빛이 감도는 따뜻한 색감. 해 질 녘의 빛과 사람에게 잘 맞아요.' },
  { name: 'Blue Memory', sub: 'quiet shadows', cam: 'assets/cam-cool.svg', p: [.12, .77, 1.09, 1.00, 165, 0], fade: ['#1b3550', .08], grain: .13, vig: .36,
    desc: '푸른 그림자와 차분한 분위기. 비 오는 날과 도시의 밤에 어울려요.' },
  { name: 'Faded Day', sub: 'low contrast', cam: 'assets/cam-faded.svg', p: [.15, .60, .83, 1.13, 0, 0], fade: ['#cfc6b0', .14], grain: .09, vig: .20,
    desc: '낮은 대비와 바랜 색감. 오래된 사진첩 속 한낮의 기억 같은 톤.' },
  { name: 'Mono 77', sub: 'black & white', cam: 'assets/cam-mono.svg', p: [0, 1, 1.22, 1.04, 0, 1], fade: ['#1a1a1a', .05], grain: .20, vig: .38,
    desc: '진한 대비의 흑백 필름에 미세한 그레인. 빛과 그림자, 표정에 집중해요.' }
];

const state = {
  selected: clamp(store.get('filter2', 0), 0, FILTERS.length - 1),
  strength: clamp(store.get('strength', 80), 0, 100),
  date: store.get('date', true), grain: store.get('grain', true),
  zoom: 1, ev: 0, flash: false, facing: 'environment'
};
let stream = null, track = null, torchOK = false, running = false, raf = 0, busy = false;
let lastBlob = null, lastUrl = null, lastMeta = '', galleryOpen = false, previewOpen = false;
let quality = 1, ema = 12;          // 미리보기 해상도 배율(성능에 따라 자동 조절)

/* ---------- 필터 엔진 ---------- */
function filterParams(i = state.selected, t = state.strength / 100, ev = state.ev) {
  const [sep, sat, con, bri, hue, gray] = FILTERS[i].p;
  return { sep: sep * t, sat: 1 + (sat - 1) * t, con: 1 + (con - 1) * t, bri: (1 + (bri - 1) * t) * Math.pow(2, ev * .35), hue: hue * t, gray: gray ? 1 : 0 };  // 흑백 필터는 강도와 무관하게 완전한 흑백
}
const cssFilter = p => `sepia(${p.sep}) saturate(${p.sat}) contrast(${p.con}) brightness(${p.bri}) hue-rotate(${p.hue}deg) grayscale(${p.gray})`;

// iOS Safari는 canvas ctx.filter를 지원하지 않는다. 속성 존재가 아니라 실제로 픽셀이 바뀌는지 확인한다.
const CSS_FILTER = (() => {
  if (/[?&]nofilter\b/.test(location.search)) return false;
  try {
    const t = document.createElement('canvas'); t.width = t.height = 1;
    const g = t.getContext('2d'); g.filter = 'grayscale(1)'; g.fillStyle = '#f00'; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data; return d[0] === d[1] && d[1] === d[2];
  } catch (e) { return false; }
})();

// 3x4 아핀 행렬 합성: CSS 필터 체인(sepia→saturate→contrast→brightness→hue→grayscale)과 같은 결과
const mul = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]).concat(r[0] * B[0][3] + r[1] * B[1][3] + r[2] * B[2][3] + r[3]));
function filterMatrix(p) {
  const a = 1 - clamp(p.sep, 0, 1), s = p.sat, g = 1 - clamp(p.gray, 0, 1), th = p.hue * Math.PI / 180, c = Math.cos(th), n = Math.sin(th);
  const sepia = [[.393 + .607 * a, .769 - .769 * a, .189 - .189 * a, 0], [.349 - .349 * a, .686 + .314 * a, .168 - .168 * a, 0], [.272 - .272 * a, .534 - .534 * a, .131 + .869 * a, 0]];
  const sat = [[.213 + .787 * s, .715 - .715 * s, .072 - .072 * s, 0], [.213 - .213 * s, .715 + .285 * s, .072 - .072 * s, 0], [.213 - .213 * s, .715 - .715 * s, .072 + .928 * s, 0]];
  const con = [[p.con, 0, 0, .5 - .5 * p.con], [0, p.con, 0, .5 - .5 * p.con], [0, 0, p.con, .5 - .5 * p.con]];
  const bri = [[p.bri, 0, 0, 0], [0, p.bri, 0, 0], [0, 0, p.bri, 0]];
  const hue = [[.213 + c * .787 - n * .213, .715 - c * .715 - n * .715, .072 - c * .072 + n * .928, 0], [.213 - c * .213 + n * .143, .715 + c * .285 + n * .140, .072 - c * .072 - n * .283, 0], [.213 - c * .213 - n * .787, .715 - c * .715 + n * .715, .072 + c * .928 + n * .072, 0]];
  const gray = [[.2126 + .7874 * g, .7152 - .7152 * g, .0722 - .0722 * g, 0], [.2126 - .2126 * g, .7152 + .2848 * g, .0722 - .0722 * g, 0], [.2126 - .2126 * g, .7152 - .7152 * g, .0722 + .9278 * g, 0]];
  return [sat, con, bri, hue, gray].reduce((m, x) => mul(x, m), sepia);
}
function applyFilterPixels(c, w, h, p) {
  const im = c.getImageData(0, 0, w, h), d = im.data, m = filterMatrix(p);
  const [a0, a1, a2, a3] = m[0], [b0, b1, b2, b3] = m[1], [c0, c1, c2, c3] = m[2];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    d[i] = (a0 * r + a1 * g + a2 * b + a3) * 255; d[i + 1] = (b0 * r + b1 * g + b2 * b + b3) * 255; d[i + 2] = (c0 * r + c1 * g + c2 * b + c3) * 255;
  }
  c.putImageData(im, 0, 0);
}

/* 미리보기·촬영·갤러리 샘플이 모두 이 함수를 지난다 (색감 일치).
   draw(ctx)는 소스를 (0,0,w,h)에 그리고, 그렸으면 true를 돌려준다. */
function paint(target, w, h, draw, i = state.selected) {
  const c = target.getContext('2d', { alpha: false, willReadFrequently: !CSS_FILTER });
  const p = filterParams(i), t = state.strength / 100;
  c.save(); c.fillStyle = '#0b0a08'; c.fillRect(0, 0, w, h);
  if (CSS_FILTER) c.filter = cssFilter(p);
  const drawn = draw(c);
  c.restore();
  if (!drawn) return;
  if (!CSS_FILTER) applyFilterPixels(c, w, h, p);
  const [col, a] = FILTERS[i].fade;
  c.save(); c.globalAlpha = a * t; c.fillStyle = col; c.fillRect(0, 0, w, h); c.restore();
}
function drawVideo(c, w, h) {
  if (video.readyState < 2 || !video.videoWidth) return false;
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(w / vw, h / vh) * state.zoom, sw = w / scale, sh = h / scale;
  const mirror = state.facing === 'user';
  c.translate(mirror ? w : 0, 0); c.scale(mirror ? -1 : 1, 1);
  c.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
  return true;
}

function render() {
  if (!running || galleryOpen || previewOpen) return;
  const t0 = performance.now();
  const dpr = Math.min(devicePixelRatio || 1, CSS_FILTER ? 2 : 1) * quality;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  paint(canvas, w, h, c => drawVideo(c, w, h));
  ema = ema * .9 + (performance.now() - t0) * .1;           // 느리면 해상도를 낮추고, 여유 있으면 되돌린다
  if (ema > 26 && quality > .5) { quality = Math.max(.5, quality * .85); ema = 14; }
  else if (ema < 9 && quality < 1) { quality = Math.min(1, quality * 1.1); ema = 12; }
  raf = requestAnimationFrame(render);
}
const resume = () => { cancelAnimationFrame(raf); if (running && !galleryOpen && !previewOpen && !document.hidden) render(); };

/* ---------- 카메라 ---------- */
const setStatus = s => { $('status').textContent = s; };
let statusTimer = 0;
const flashStatus = (s, ms = 2400) => { setStatus(s); clearTimeout(statusTimer); statusTimer = setTimeout(() => setStatus(''), ms); };
function cameraError(e) {
  switch (e && e.name) {
    case 'NotAllowedError': case 'SecurityError': return '카메라 권한이 거부됐어요. 브라우저(또는 iOS 설정 → Safari → 카메라)에서 허용한 뒤 다시 시도해 주세요.';
    case 'NotFoundError': case 'OverconstrainedError': return '사용할 수 있는 카메라를 찾지 못했어요.';
    case 'NotReadableError': case 'AbortError': return '카메라를 시작할 수 없어요. 다른 앱이 카메라를 쓰고 있는지 확인해 주세요.';
    default: return '카메라를 시작하지 못했어요' + (e && e.name ? ' (' + e.name + ')' : '') + '.';
  }
}
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('emptyHint').textContent = '카메라는 HTTPS 주소(또는 localhost)에서만 쓸 수 있어요. Safari/Chrome으로 열어 주세요.'; return;
  }
  stopCamera(); $('start').disabled = true; $('emptyHint').textContent = '카메라 연결 중...';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
    video.srcObject = stream; await video.play();
    track = stream.getVideoTracks()[0];
    let caps = {}; try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) {}
    torchOK = !!caps.torch;
    running = true; $('empty').hidden = true; $('shutter').disabled = false; $('emptyHint').textContent = '';
    updateFlashUI(); resume();
  } catch (e) {
    $('empty').hidden = false; $('emptyHint').textContent = cameraError(e);
  } finally { $('start').disabled = false; }
}
function stopCamera() {
  running = false; cancelAnimationFrame(raf);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }
  video.srcObject = null; $('shutter').disabled = true;
}

/* ---------- 필터 선택 (strip ↔ gallery 동기화) ---------- */
let stripLock = 0;
function centerChip(i, smooth) {
  const chip = $('strip').children[i]; if (!chip) return;
  stripLock = performance.now() + (smooth ? 450 : 120);
  const s = $('strip'); s.scrollTo({ left: chip.offsetLeft - (s.clientWidth - chip.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
}
function selectFilter(i, from) {
  if (i === state.selected && from) return;
  state.selected = i; store.set('filter2', i); updateFilterUI();
  if (from !== 'strip') centerChip(i, from === 'chip');
  if (galleryOpen) renderHero(true);
}
function updateFilterUI() {
  const f = FILTERS[state.selected];
  $('filterLabel').textContent = f.name.toUpperCase();
  $('strengthTag').textContent = state.strength + '%';
  $('camPickImg').src = f.cam;
  document.documentElement.style.setProperty('--grain', (f.grain * 1.25).toFixed(3));
  document.documentElement.style.setProperty('--vig', f.vig);
  document.querySelectorAll('.cam,.chip').forEach(b => b.setAttribute('aria-selected', Number(b.dataset.i) === state.selected));
  $('heroSub').textContent = f.sub; $('heroName').textContent = f.name; $('heroDesc').textContent = f.desc;
}
const sample = new Image(); let sampleReady = false;
sample.onload = () => { sampleReady = true; if (galleryOpen) renderHero(); };
sample.src = 'assets/sample.jpg';
const heroNoise = (() => { try { return makeNoise(); } catch (e) { return null; } })();
function renderHero(animate) {
  if (!sampleReady) return;
  const c = $('heroCanvas'), w = c.width, h = c.height, f = FILTERS[state.selected];
  paint(c, w, h, g => { g.drawImage(sample, 0, 0, w, h); return true; });
  if (state.grain) addGrain(c, w, h, f.grain, heroNoise);
  vignette(c, w, h, f.vig);
  if (animate) for (const el of [c, $('heroText')]) { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); }
}

function updateZoomUI() {
  document.querySelectorAll('.zoom-pills button').forEach(b => b.classList.toggle('on', Number(b.dataset.z) === state.zoom));
  $('zoomKind').hidden = state.zoom === 1;
}
function updateToggles() {
  const b = $('dateToggle'); b.setAttribute('aria-pressed', state.date); b.querySelector('b').textContent = state.date ? 'ON' : 'OFF';
  const g = $('grainToggle'); g.setAttribute('aria-pressed', state.grain); g.querySelector('b').textContent = state.grain ? 'ON' : 'OFF';
  $('dateLabel').hidden = !state.date; $('grainLayer').classList.toggle('off', !state.grain);
}
function updateFlashUI() {
  const b = $('flashBtn'), front = state.facing === 'user', usable = front || torchOK;
  b.disabled = !usable; if (!usable) state.flash = false;
  b.setAttribute('aria-pressed', state.flash);
  b.title = usable ? (front ? '화면 플래시' : '플래시') : '이 기기/브라우저는 후면 플래시(torch)를 지원하지 않아요';
}
const TRAYS = { more: ['trayMore', 'moreBtn'], exp: ['trayExposure', 'expBtn'], grain: ['trayGrain', 'grainBtn'] };
function toggleTray(which) {
  const wasOpen = !$(TRAYS[which][0]).hidden;
  for (const [row, btn] of Object.values(TRAYS)) { $(row).hidden = true; $(btn).setAttribute('aria-expanded', false); }
  if (!wasOpen) { $(TRAYS[which][0]).hidden = false; $(TRAYS[which][1]).setAttribute('aria-expanded', true); }
  $('tray').hidden = wasOpen;
}

function setGallery(open) {
  galleryOpen = open;
  const g = $('gallery'); g.classList.toggle('open', open); g.setAttribute('aria-hidden', !open);
  if (open) { cancelAnimationFrame(raf); g.scrollTop = 0; renderHero(); } else { resume(); centerChip(state.selected, false); }
}
function setPreview(open) {
  previewOpen = open;
  const p = $('pv'); p.classList.toggle('show', open); p.setAttribute('aria-hidden', !open);
  if (open) cancelAnimationFrame(raf); else resume();
}

/* ---------- 촬영 ---------- */
function makeNoise() {
  const n = document.createElement('canvas'); n.width = n.height = 160;
  const g = n.getContext('2d'), im = g.createImageData(160, 160);
  for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0); return n;
}
function addGrain(c, w, h, amt, noise) {
  const n = noise || makeNoise(), g = c.getContext('2d');
  g.save(); g.globalAlpha = amt; g.globalCompositeOperation = 'overlay';
  const s = Math.max(1, Math.round(w / 520));
  for (let y = 0; y < h; y += 160 * s) for (let x = 0; x < w; x += 160 * s) g.drawImage(n, x, y, 160 * s, 160 * s);
  g.restore();
}
function vignette(c, w, h, a) {
  const g = c.getContext('2d'), r = Math.hypot(w, h) / 2, grd = g.createRadialGradient(w / 2, h / 2, r * .55, w / 2, h / 2, r);
  grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, `rgba(0,0,0,${a})`); g.fillStyle = grd; g.fillRect(0, 0, w, h);
}
const dateStamp = () => { const d = new Date(), p = v => String(v).padStart(2, '0'); return `'${String(d.getFullYear()).slice(2)}.${p(d.getMonth() + 1)}.${p(d.getDate())}`; };
function stamp(c, w, h) {
  const g = c.getContext('2d'); g.save();
  g.font = `${Math.round(Math.min(w, h) * .034)}px ui-monospace,Menlo,monospace`; g.textAlign = 'right'; g.fillStyle = '#ffb56f';
  g.shadowColor = '#000'; g.shadowBlur = 3; g.fillText(dateStamp(), w * .94, h * .955); g.restore();
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
    // 뷰파인더와 같은 비율·같은 확대율, 해상도는 미리보기와 별개로 원본 기준(최대 2400px)
    const ar = canvas.clientWidth / canvas.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
    let cw, ch;
    if (vw / vh > ar) { ch = vh / state.zoom; cw = ch * ar; } else { cw = vw / state.zoom; ch = cw / ar; }
    const k = Math.min(1, 2400 / Math.max(cw, ch));
    const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
    const f = FILTERS[state.selected];
    paint(out, out.width, out.height, c => drawVideo(c, out.width, out.height));
    await cleanup(); cleanup = async () => {};
    $('blink').classList.remove('go'); void $('blink').offsetWidth; $('blink').classList.add('go');
    if (state.grain) addGrain(out, out.width, out.height, f.grain);
    vignette(out, out.width, out.height, f.vig);
    if (state.date) stamp(out, out.width, out.height);
    setStatus('사진 처리 중...');
    const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', .93));
    if (!blob) { flashStatus('사진 생성에 실패했어요.'); return; }
    lastBlob = blob; if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = URL.createObjectURL(blob);
    lastMeta = `${f.name.toUpperCase()} · ${state.strength}% · ${new Date().toLocaleString('ko-KR')}`;
    $('shot').src = lastUrl; $('pvMeta').textContent = lastMeta;
    setThumb(lastUrl); saveThumb(out); setStatus('');
    setPreview(true);
  } catch (e) { flashStatus('촬영 중 문제가 생겼어요.'); }
  finally { await cleanup(); busy = false; $('shutter').disabled = !running; }
}
function setThumb(url) { const i = $('thumbImg'); i.src = url; i.hidden = false; }
function saveThumb(src) {
  try { const t = document.createElement('canvas'); t.width = t.height = 112; const g = t.getContext('2d'); const s = Math.min(src.width, src.height);
    g.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 112, 112); store.set('thumb', t.toDataURL('image/jpeg', .7)); } catch (e) {}
}
const makeFile = () => new File([lastBlob], `film-lab-${Date.now()}.jpg`, { type: 'image/jpeg' });
const canShareFile = f => { try { return !!(navigator.canShare && navigator.canShare({ files: [f] })); } catch (e) { return false; } };
function download() {
  const a = document.createElement('a'); a.href = lastUrl; a.download = `film-lab-${Date.now()}.jpg`;
  document.body.appendChild(a); a.click(); a.remove(); $('pvNote').textContent = '사진을 저장했어요. (다운로드 폴더 확인)';
}
async function shareFile(title) { await navigator.share({ files: [makeFile()], title }); }
async function savePhoto() {
  if (!lastBlob) return;
  try {
    // iOS Safari에는 '사진 앱에 직접 저장' API가 없어서 공유 시트의 '이미지 저장'을 쓴다.
    if (IS_IOS && canShareFile(makeFile())) { $('pvNote').textContent = '공유 시트에서 ‘이미지 저장’을 선택하세요.'; await shareFile('FILM LAB'); }
    else download();
  } catch (e) { if (e.name !== 'AbortError') { $('pvNote').textContent = '저장에 실패했어요. 사진을 길게 눌러 저장해 보세요.'; } }
}
async function sharePhoto() {
  if (!lastBlob) return;
  try {
    if (canShareFile(makeFile())) await shareFile('FILM LAB');
    else { $('pvNote').textContent = '이 브라우저는 공유를 지원하지 않아 파일로 저장해요.'; download(); }
  } catch (e) { if (e.name !== 'AbortError') $('pvNote').textContent = '공유에 실패했어요. ‘사진 저장’을 이용해 주세요.'; }
}

/* ---------- 초기화 ---------- */
function buildFilters() {
  FILTERS.forEach((f, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'cam'; b.dataset.i = i; b.setAttribute('role', 'option');
    b.innerHTML = `<img alt="" src="${f.cam}"><span>${f.name}</span>`; b.onclick = () => selectFilter(i, 'grid'); $('grid').appendChild(b);
    const c = document.createElement('button'); c.type = 'button'; c.className = 'chip'; c.dataset.i = i; c.setAttribute('role', 'option');
    c.innerHTML = `<img alt="" src="${f.cam}"><span>${f.name}</span>`; c.onclick = () => { selectFilter(i, 'chip'); }; $('strip').appendChild(c);
  });
  // 스와이프: 가운데에 가장 가까운 칩을 즉시 선택
  let tick = 0;
  $('strip').addEventListener('scroll', () => {
    if (tick || performance.now() < stripLock) return;
    tick = requestAnimationFrame(() => {
      tick = 0; const s = $('strip'), mid = s.scrollLeft + s.clientWidth / 2; let best = 0, bd = 1e9;
      [...s.children].forEach((c, i) => { const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
      selectFilter(best, 'strip');
    });
  }, { passive: true });
}
function init() {
  try { const n = makeNoise(); document.documentElement.style.setProperty('--noise', `url(${n.toDataURL('image/png')})`); } catch (e) {}
  buildFilters();
  $('strength').value = state.strength; $('strengthValue').textContent = state.strength + '%'; $('dateLabel').textContent = dateStamp();
  updateFilterUI(); updateZoomUI(); updateToggles(); updateFlashUI();
  requestAnimationFrame(() => centerChip(state.selected, false));
  const t = store.get('thumb', null); if (t) setThumb(t);

  $('start').onclick = startCamera;
  $('switch').onclick = () => { state.facing = state.facing === 'environment' ? 'user' : 'environment'; torchOK = false; if (running) startCamera(); else updateFlashUI(); };
  $('shutter').onclick = shoot;
  $('strength').oninput = e => { state.strength = Number(e.target.value); $('strengthValue').textContent = state.strength + '%'; $('strengthTag').textContent = state.strength + '%'; store.set('strength', state.strength); };
  $('exposure').oninput = e => { state.ev = Number(e.target.value); $('exposureValue').textContent = (state.ev > 0 ? '+' : '') + state.ev.toFixed(1) + ' EV'; };
  document.querySelectorAll('.zoom-pills button').forEach(b => b.onclick = () => { state.zoom = Number(b.dataset.z); updateZoomUI(); });
  $('dateToggle').onclick = () => { state.date = !state.date; store.set('date', state.date); updateToggles(); };
  $('grainToggle').onclick = () => { state.grain = !state.grain; store.set('grain', state.grain); updateToggles(); };
  $('flashBtn').onclick = () => { state.flash = !state.flash; updateFlashUI(); if (state.flash) flashStatus(state.facing === 'user' ? '촬영 시 화면이 밝게 켜져요.' : '촬영 시 플래시가 켜져요.'); };
  $('moreBtn').onclick = () => toggleTray('more'); $('expBtn').onclick = () => toggleTray('exp'); $('grainBtn').onclick = () => toggleTray('grain');
  $('camPick').onclick = $('filterTag').onclick = () => setGallery(true);
  $('backBtn').onclick = () => setGallery(false);
  $('thumb').onclick = () => { if (lastBlob) setPreview(true); else flashStatus('방금 찍은 사진부터 다시 볼 수 있어요.'); };
  $('retake').onclick = () => { setPreview(false); $('pvNote').textContent = '사진은 이 기기에서만 처리되며 서버로 업로드되지 않아요.'; };
  $('save').onclick = savePhoto; $('share').onclick = sharePhoto;
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else { resume(); if (swReg) swReg.update().catch(() => {}); } });
  window.addEventListener('pagehide', stopCamera);
  window.addEventListener('resize', () => { if (galleryOpen === false) centerChip(state.selected, false); });
  initSW();
}
let swReg = null;
function initSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('updateBtn').hidden = false; });
  $('updateBtn').onclick = () => location.reload();
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(r => { swReg = r; }).catch(() => {}));
}
init();

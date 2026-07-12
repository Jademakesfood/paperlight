import './styles.css';
import { icon } from './icons.js';
import { defaultCorners, fileToDataUrl, makeThumbnail, processPage } from './scanner.js';
import { detectDocument, prepareDetector } from './detector.js';
import { listDocuments, removeDocument, saveDocument } from './storage.js';
import { exportImages, exportPdf, exportWord } from './exporters.js';

const app = document.querySelector('#app');
const state = { documents: [], current: null, busy: false, toast: null };

const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const dateLabel = (timestamp) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(timestamp);
const timeLabel = (timestamp) => new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round((timestamp - Date.now()) / 86400000), 'day');

function notify(message) {
  state.toast = message;
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.textContent = message;
  document.body.append(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 250); }, 2600);
}

function setBusy(on, label = 'Working…') {
  state.busy = on;
  document.querySelector('.busy-layer')?.remove();
  if (!on) return;
  const layer = document.createElement('div');
  layer.className = 'busy-layer';
  layer.innerHTML = `<div class="busy-card"><span class="spinner"></span><strong>${label}</strong><small>Everything stays on this device.</small></div>`;
  document.body.append(layer);
}

function captureInput(capture = true) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
  if (capture) input.setAttribute('capture', 'environment');
  input.addEventListener('change', () => addFiles([...input.files]));
  input.click();
}

async function preparePage(original, detectedCorners = null) {
  const detected = detectedCorners || await detectDocument(original).catch((error) => { console.warn('Document detection failed', error); return null; });
  const corners = detected || defaultCorners();
  const processed = await processPage(original, corners, 'auto');
  return { id: uid(), original, processed, thumbnail: await makeThumbnail(processed), corners, autoCropped: Boolean(detected), filter: 'auto', rotation: 0, ocrText: '' };
}

async function addPreparedPages(pages) {
  if (state.current) {
    state.current.pages.push(...pages); state.current.updatedAt = Date.now();
    await persistCurrent(); renderDocument();
  } else {
    const now = Date.now();
    const document = { id: uid(), name: `Scan ${dateLabel(now)}`, pages, createdAt: now, updatedAt: now };
    state.documents.unshift(document); state.current = document;
    await saveDocument(document); renderDocument();
  }
}

async function addFiles(files) {
  if (!files.length) return;
  setBusy(true, files.length > 1 ? `Preparing ${files.length} pages…` : 'Preparing your scan…');
  try {
    const pages = [];
    for (const file of files) {
      const original = await fileToDataUrl(file);
      pages.push(await preparePage(original));
    }
    await addPreparedPages(pages);
  } catch (error) {
    console.error(error); notify('That image could not be prepared. Please try another.');
  } finally { setBusy(false); }
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { notify('Live camera is unavailable in this browser. Opening the phone camera instead.'); return captureInput(true); }
  const detectorReady = prepareDetector().then(() => true).catch((error) => { console.warn('Detector unavailable', error); return false; });
  const layer = modal(`
    <section class="camera-modal">
      <header><button class="camera-icon" data-close aria-label="Close camera">${icon('close')}</button><div><strong>Document scan</strong><small data-camera-status>Loading edge detector…</small></div><button class="camera-icon" data-gallery aria-label="Choose from photos">${icon('image')}</button></header>
      <div class="camera-frame"><video playsinline muted></video><canvas></canvas><div class="camera-guide">Point at a document</div></div>
      <footer><button class="camera-gallery" data-gallery>${icon('image')}<span>Photos</span></button><button class="shutter" data-shutter aria-label="Take photo"><span></span></button><div class="camera-detected" data-detected><i></i><span>Searching</span></div></footer>
    </section>`, 'camera-layer');
  const video = layer.querySelector('video'); const overlay = layer.querySelector('canvas'); const frame = layer.querySelector('.camera-frame');
  const status = layer.querySelector('[data-camera-status]'); const indicator = layer.querySelector('[data-detected]');
  let stream; let timer; let detecting = false; let latestCorners = null; let missedFrames = 0; let closed = false;
  const stop = () => { closed = true; clearInterval(timer); stream?.getTracks().forEach((track) => track.stop()); };
  const close = () => { stop(); closeModal(layer); };
  const drawCorners = (corners) => {
    const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!corners) return;
    ctx.beginPath(); corners.forEach((point, index) => { const x = point.x * overlay.width; const y = point.y * overlay.height; if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.closePath(); ctx.fillStyle = 'rgba(39, 224, 151, .11)'; ctx.fill(); ctx.strokeStyle = '#27e097'; ctx.lineWidth = Math.max(4, overlay.width / 160); ctx.lineJoin = 'round'; ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 8; ctx.stroke();
    ctx.shadowBlur = 0; ctx.fillStyle = '#27e097'; corners.forEach((point) => { ctx.beginPath(); ctx.arc(point.x * overlay.width, point.y * overlay.height, Math.max(7, overlay.width / 100), 0, Math.PI * 2); ctx.fill(); });
  };
  const analyze = async () => {
    if (closed || detecting || video.readyState < 2) return;
    detecting = true;
    try {
      const detected = await detectDocument(video, 680);
      if (detected) {
        latestCorners = latestCorners ? detected.map((point, index) => ({ x: latestCorners[index].x * .58 + point.x * .42, y: latestCorners[index].y * .58 + point.y * .42 })) : detected;
        missedFrames = 0;
      } else if (++missedFrames >= 3) latestCorners = null;
      drawCorners(latestCorners);
      status.textContent = latestCorners ? 'Document detected' : 'Move closer and keep the edges visible';
      indicator.classList.toggle('ready', Boolean(latestCorners)); indicator.querySelector('span').textContent = latestCorners ? 'Ready' : 'Searching';
    } catch (error) { console.warn(error); } finally { detecting = false; }
  };
  layer.querySelector('[data-close]').onclick = close;
  layer.querySelectorAll('[data-gallery]').forEach((button) => button.onclick = () => { close(); captureInput(false); });
  layer.querySelector('[data-shutter]').onclick = async () => {
    if (video.readyState < 2) return;
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0); const original = canvas.toDataURL('image/jpeg', .94); const corners = latestCorners;
    close(); setBusy(true, corners ? 'Straightening the detected page…' : 'Finding and straightening the page…');
    try { await addPreparedPages([await preparePage(original, corners)]); } catch (error) { console.error(error); notify('The photo could not be prepared.'); } finally { setBusy(false); }
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    if (closed) return stream.getTracks().forEach((track) => track.stop());
    video.srcObject = stream; await video.play();
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  } catch (error) {
    console.warn('Live camera unavailable', error);
    status.textContent = 'Camera permission is off'; frame.classList.add('camera-error');
    frame.querySelector('.camera-guide').textContent = 'Allow Camera in Safari Settings, or tap Photos';
    indicator.querySelector('span').textContent = 'Unavailable';
    return;
  }
  if (!await detectorReady) {
    status.textContent = 'Edge detector could not load'; indicator.querySelector('span').textContent = 'Capture manually';
    return;
  }
  status.textContent = 'Finding the document edges…'; await analyze(); timer = setInterval(analyze, 560);
}

async function createDemoDocument() {
  setBusy(true, 'Preparing a sample scan…');
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600"><rect width="1200" height="1600" fill="#d9ddd7"/><g transform="translate(115 85) rotate(-2 485 710)"><rect width="970" height="1420" rx="8" fill="#fffef9"/><rect x="80" y="90" width="110" height="28" fill="#d66f4d"/><text x="80" y="190" fill="#26352f" font-family="Arial" font-size="54" font-weight="700">SAMPLE DOCUMENT</text><text x="80" y="246" fill="#65716b" font-family="Arial" font-size="26">Paperlight private scanner</text><path d="M80 300h810" stroke="#d9d9d2" stroke-width="5"/><text x="80" y="390" fill="#26352f" font-family="Arial" font-size="27">This sample lets you try cropping, filters, OCR,</text><text x="80" y="435" fill="#26352f" font-family="Arial" font-size="27">page rotation and export without using a real file.</text><g fill="#dfe2dc"><rect x="80" y="530" width="810" height="18" rx="9"/><rect x="80" y="580" width="680" height="18" rx="9"/><rect x="80" y="630" width="760" height="18" rx="9"/><rect x="80" y="680" width="590" height="18" rx="9"/></g><rect x="80" y="820" width="810" height="310" rx="12" fill="#edf1ec"/><circle cx="250" cy="975" r="90" fill="#93ac9f"/><path d="M212 979l29 29 58-68" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/><text x="390" y="950" fill="#26352f" font-family="Arial" font-size="31" font-weight="700">Processed locally</text><text x="390" y="1005" fill="#65716b" font-family="Arial" font-size="23">Your scans never leave your device.</text><text x="80" y="1295" fill="#d66f4d" font-family="Arial" font-size="23" font-weight="700">PAPERLIGHT · PRIVATE BY DESIGN</text></g></svg>`;
    const original = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const now = Date.now();
    const document = { id: uid(), name: 'Welcome to Paperlight', pages: [await preparePage(original)], createdAt: now, updatedAt: now };
    state.documents.unshift(document); state.current = document; await saveDocument(document); renderDocument();
  } catch (error) { console.error(error); notify('The sample could not be created.'); }
  finally { setBusy(false); }
}

async function persistCurrent() {
  if (!state.current) return;
  state.current.updatedAt = Date.now();
  await saveDocument(state.current);
  state.documents = [state.current, ...state.documents.filter((doc) => doc.id !== state.current.id)];
}

function renderShell(content, pageClass = '') {
  app.className = pageClass;
  app.innerHTML = content;
}

function renderLibrary() {
  state.current = null;
  const recent = state.documents.map((doc) => `
    <article class="document-card" data-open="${doc.id}">
      <div class="doc-preview">
        <img src="${doc.pages[0]?.thumbnail || ''}" alt="First page of ${doc.name}">
        ${doc.pages.length > 1 ? `<span class="page-count">${doc.pages.length} pages</span>` : ''}
      </div>
      <div class="doc-card-copy">
        <strong>${doc.name}</strong>
        <span>${timeLabel(doc.updatedAt)} · ${doc.pages.length} ${doc.pages.length === 1 ? 'page' : 'pages'}</span>
      </div>
      <button class="icon-button doc-menu" data-menu="${doc.id}" aria-label="Document options">${icon('more')}</button>
    </article>`).join('');

  renderShell(`
    <header class="site-header">
      <a class="brand" href="#" aria-label="Paperlight home"><span class="brand-mark">${icon('scan', 23)}</span><span>Paperlight</span></a>
      <div class="privacy-badge">${icon('shield', 16)} <span>Private by design</span></div>
    </header>
    <main class="library-main">
      <section class="hero">
        <div class="hero-copy">
          <span class="eyebrow">YOUR POCKET SCANNER</span>
          <h1>Paperwork, made<br><em>beautifully simple.</em></h1>
          <p>Scan, straighten and share polished documents—without your files ever leaving your device.</p>
        </div>
        <div class="scan-panel">
          <div class="scan-illustration">
            <span class="corner tl"></span><span class="corner tr"></span><span class="corner br"></span><span class="corner bl"></span>
            <div class="paper-sheet"><i></i><i></i><i></i><i></i><b>PRIVATE</b></div>
            <span class="scan-line"></span>
          </div>
          <button class="primary-button" data-capture>${icon('camera')} Scan a document</button>
          <button class="secondary-button" data-import>${icon('image')} Choose from Photos</button>
          <small>No account. No upload. No fuss.</small>
        </div>
      </section>
      <section class="recent-section">
        <div class="section-heading"><div><span class="eyebrow">YOUR LIBRARY</span><h2>${state.documents.length ? 'Recent scans' : 'Ready when you are'}</h2></div>${state.documents.length ? `<span>${state.documents.length} ${state.documents.length === 1 ? 'document' : 'documents'}</span>` : ''}</div>
        ${state.documents.length ? `<div class="document-grid">${recent}</div>` : `
          <div class="empty-library">
            <div class="empty-icon">${icon('file', 30)}</div>
            <h3>Your scans will live here</h3>
            <p>Start with a receipt, letter, form or anything on paper.</p>
            <button class="text-button" data-capture>Make your first scan ${icon('chevron', 17)}</button>
            <button class="sample-button" data-sample>or try a sample document</button>
          </div>`}
      </section>
      <section class="trust-strip">
        <div>${icon('shield', 22)}<span><strong>On-device processing</strong><small>Your documents stay in your browser.</small></span></div>
        <div>${icon('sparkles', 22)}<span><strong>Polished automatically</strong><small>Crop, straighten and enhance in seconds.</small></span></div>
        <div>${icon('share', 22)}<span><strong>Share anywhere</strong><small>Export PDF, Word or crisp images.</small></span></div>
      </section>
    </main>
    <footer><span>Paperlight</span><span>Made for your documents, not your data.</span></footer>
    <button class="mobile-scan-fab" data-capture>${icon('camera')} Scan</button>
  `, 'library-page');

  document.querySelectorAll('[data-capture]').forEach((button) => button.onclick = openCamera);
  document.querySelectorAll('[data-import]').forEach((button) => button.onclick = () => captureInput(false));
  document.querySelector('[data-sample]')?.addEventListener('click', createDemoDocument);
  document.querySelectorAll('[data-open]').forEach((card) => card.onclick = (event) => { if (!event.target.closest('[data-menu]')) openDocument(card.dataset.open); });
  document.querySelectorAll('[data-menu]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); showDocumentMenu(button.dataset.menu, button); });
}

function openDocument(id) {
  state.current = state.documents.find((document) => document.id === id);
  if (state.current) renderDocument();
}

function renderDocument() {
  const doc = state.current;
  if (!doc) return renderLibrary();
  const pages = doc.pages.map((page, index) => `
    <article class="page-card" draggable="true" data-page="${page.id}">
      <div class="page-number"><span>${index + 1}</span></div>
      <button class="page-image" data-edit="${page.id}"><img src="${page.thumbnail}" alt="Page ${index + 1}"><span>${icon('crop', 16)} Edit page</span></button>
      <div class="page-meta"><strong>Page ${index + 1}</strong><small>${page.ocrText ? 'Text recognized' : page.autoCropped ? 'Edges found · straightened' : 'Check crop · edges uncertain'}</small></div>
      <button class="icon-button" data-page-menu="${page.id}" aria-label="Page options">${icon('more')}</button>
    </article>`).join('');

  renderShell(`
    <header class="document-header">
      <button class="back-button" data-back>${icon('back')} <span>Library</span></button>
      <div class="doc-title-wrap">
        <input class="doc-title" value="${doc.name.replace(/"/g, '&quot;')}" aria-label="Document name">
        <span>${doc.pages.length} ${doc.pages.length === 1 ? 'page' : 'pages'} · saved locally</span>
      </div>
      <button class="primary-button compact" data-export>${icon('share')} Export</button>
    </header>
    <main class="document-main">
      <div class="document-toolbar">
        <div><span class="eyebrow">DOCUMENT</span><h1>Pages</h1></div>
        <div class="toolbar-actions">
          <button class="secondary-button compact" data-ocr>${icon('text')} Recognize text</button>
          <button class="secondary-button compact" data-add>${icon('plus')} Add pages</button>
        </div>
      </div>
      <div class="pages-grid">${pages}</div>
      <button class="add-page-card" data-add>${icon('camera', 26)}<strong>Add another page</strong><span>Camera or photo library</span></button>
    </main>
    <div class="mobile-doc-bar">
      <button data-add>${icon('camera')}<span>Add page</span></button>
      <button data-ocr>${icon('text')}<span>OCR</span></button>
      <button class="main" data-export>${icon('share')}<span>Export</span></button>
    </div>
  `, 'document-page');

  document.querySelector('[data-back]').onclick = renderLibrary;
  document.querySelectorAll('[data-add]').forEach((button) => button.onclick = openCamera);
  document.querySelectorAll('[data-export]').forEach((button) => button.onclick = showExportSheet);
  document.querySelectorAll('[data-ocr]').forEach((button) => button.onclick = runOcr);
  document.querySelectorAll('[data-edit]').forEach((button) => button.onclick = () => showEditor(button.dataset.edit));
  document.querySelectorAll('[data-page-menu]').forEach((button) => button.onclick = () => showPageMenu(button.dataset.pageMenu, button));
  document.querySelector('.doc-title').addEventListener('change', async (event) => { doc.name = event.target.value.trim() || 'Untitled scan'; await persistCurrent(); notify('Document renamed'); });
  enablePageReorder();
}

function enablePageReorder() {
  let dragged;
  document.querySelectorAll('.page-card').forEach((card) => {
    card.addEventListener('dragstart', () => { dragged = card.dataset.page; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (event) => event.preventDefault());
    card.addEventListener('drop', async (event) => {
      event.preventDefault();
      const from = state.current.pages.findIndex((page) => page.id === dragged);
      const to = state.current.pages.findIndex((page) => page.id === card.dataset.page);
      if (from < 0 || to < 0 || from === to) return;
      const [page] = state.current.pages.splice(from, 1); state.current.pages.splice(to, 0, page);
      await persistCurrent(); renderDocument(); notify('Pages reordered');
    });
  });
}

function modal(content, className = '') {
  const layer = document.createElement('div');
  layer.className = `modal-layer ${className}`; layer.innerHTML = content;
  document.body.append(layer);
  requestAnimationFrame(() => layer.classList.add('visible'));
  layer.addEventListener('click', (event) => { if (event.target === layer) closeModal(layer); });
  return layer;
}

function closeModal(layer = document.querySelector('.modal-layer')) {
  if (!layer) return; layer.classList.remove('visible'); setTimeout(() => layer.remove(), 220);
}

function showDocumentMenu(id, anchor) {
  document.querySelector('.popover')?.remove();
  const pop = document.createElement('div'); pop.className = 'popover';
  pop.innerHTML = `<button data-rename>${icon('text')} Rename</button><button class="danger" data-delete>${icon('trash')} Delete document</button>`;
  const rect = anchor.getBoundingClientRect(); pop.style.top = `${rect.bottom + 8}px`; pop.style.right = `${innerWidth - rect.right}px`; document.body.append(pop);
  pop.querySelector('[data-rename]').onclick = () => { pop.remove(); openDocument(id); setTimeout(() => document.querySelector('.doc-title')?.select(), 20); };
  pop.querySelector('[data-delete]').onclick = async () => {
    if (!confirm('Delete this document from this device?')) return;
    await removeDocument(id); state.documents = state.documents.filter((doc) => doc.id !== id); pop.remove(); renderLibrary(); notify('Document deleted');
  };
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
}

function showPageMenu(id, anchor) {
  document.querySelector('.popover')?.remove();
  const pop = document.createElement('div'); pop.className = 'popover';
  pop.innerHTML = `<button data-edit>${icon('crop')} Edit page</button><button data-rotate>${icon('rotate')} Rotate right</button><button class="danger" data-delete>${icon('trash')} Delete page</button>`;
  const rect = anchor.getBoundingClientRect(); pop.style.top = `${rect.bottom + 8}px`; pop.style.right = `${innerWidth - rect.right}px`; document.body.append(pop);
  pop.querySelector('[data-edit]').onclick = () => { pop.remove(); showEditor(id); };
  pop.querySelector('[data-rotate]').onclick = async () => { pop.remove(); const page = state.current.pages.find((p) => p.id === id); page.rotation = (page.rotation + 90) % 360; setBusy(true, 'Rotating page…'); page.processed = await processPage(page.original, page.corners, page.filter, page.rotation); page.thumbnail = await makeThumbnail(page.processed); await persistCurrent(); setBusy(false); renderDocument(); };
  pop.querySelector('[data-delete]').onclick = async () => { pop.remove(); if (state.current.pages.length === 1) return notify('A document needs at least one page.'); state.current.pages = state.current.pages.filter((p) => p.id !== id); await persistCurrent(); renderDocument(); notify('Page deleted'); };
}

function showEditor(id) {
  const page = state.current.pages.find((item) => item.id === id);
  page.corners ||= defaultCorners(); page.filter = page.filter === 'magic' ? 'auto' : (page.filter || 'auto');
  const filters = [['original', 'Original'], ['auto', 'Auto'], ['shadow', 'No shadow'], ['lighten', 'Lighten'], ['enhance', 'Enhance'], ['eco', 'Eco'], ['gray', 'Grayscale'], ['bw', 'B&W'], ['invert', 'Invert']];
  const layer = modal(`
    <section class="editor-modal">
      <header><button class="back-button" data-cancel>${icon('close')} <span>Cancel</span></button><div><strong>Edit page</strong><small data-editor-status>Crop mode · drag corners to fit the paper</small></div><button class="primary-button compact" data-save>${icon('check')} Save</button></header>
      <div class="editor-stage"><div class="crop-wrap"><img src="${page.original}" alt="Document page"><span class="editor-preview-loading"><i class="spinner"></i>Applying filter…</span><svg class="crop-shade" preserveAspectRatio="none"><polygon></polygon></svg>${page.corners.map((point, index) => `<button class="crop-handle" data-corner="${index}" style="left:${point.x * 100}%;top:${point.y * 100}%" aria-label="Crop corner ${index + 1}"></button>`).join('')}</div></div>
      <div class="editor-controls">
        <button class="rotate-control" data-detect>${icon('scan')}<span>Auto crop</span></button><button class="rotate-control" data-rotate>${icon('rotate')}<span>Rotate</span></button>
        <div class="filter-list">${filters.map(([key, label]) => `<button data-filter="${key}" class="${page.filter === key ? 'active' : ''}"><span class="filter-preview ${key}"><img src="${page.thumbnail}"></span><strong>${label}</strong></button>`).join('')}</div>
      </div>
    </section>`, 'editor-layer');
  let corners = page.corners.map((point) => ({ ...point })); let rotation = page.rotation; let filter = page.filter; let previewVersion = 0;
  const wrap = layer.querySelector('.crop-wrap'); const image = wrap.querySelector('img'); const polygon = wrap.querySelector('polygon'); const editorStatus = layer.querySelector('[data-editor-status]');
  const updatePolygon = () => polygon.setAttribute('points', corners.map((p) => `${p.x * 100},${p.y * 100}`).join(' '));
  const showCropView = () => {
    previewVersion += 1; wrap.classList.remove('processed-preview', 'preview-loading'); image.style.transform = ''; image.src = page.original;
    editorStatus.textContent = 'Crop mode · drag corners to fit the paper'; updatePolygon();
  };
  const renderFilterPreview = async (selectedFilter) => {
    const version = ++previewVersion; const label = filters.find(([key]) => key === selectedFilter)?.[1] || selectedFilter;
    wrap.classList.add('processed-preview', 'preview-loading'); editorStatus.textContent = `Previewing ${label}…`;
    try {
      const preview = await processPage(page.original, corners, selectedFilter, rotation, 1050);
      if (version !== previewVersion || !layer.isConnected) return;
      image.style.transform = ''; image.src = preview; wrap.classList.remove('preview-loading'); editorStatus.textContent = `${label} preview · this is what will be saved`;
    } catch (error) { console.error(error); if (version === previewVersion) { showCropView(); notify('This filter could not be previewed.'); } }
  };
  image.onload = () => { if (!wrap.classList.contains('processed-preview')) updatePolygon(); }; updatePolygon();
  layer.querySelectorAll('.crop-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      const index = Number(handle.dataset.corner);
      const move = (pointer) => {
        const rect = wrap.getBoundingClientRect();
        corners[index].x = Math.max(0.01, Math.min(0.99, (pointer.clientX - rect.left) / rect.width));
        corners[index].y = Math.max(0.01, Math.min(0.99, (pointer.clientY - rect.top) / rect.height));
        handle.style.left = `${corners[index].x * 100}%`; handle.style.top = `${corners[index].y * 100}%`; updatePolygon();
      };
      handle.onpointermove = move; handle.onpointerup = () => { handle.onpointermove = null; };
    });
  });
  layer.querySelector('[data-cancel]').onclick = () => closeModal(layer);
  layer.querySelector('[data-detect]').onclick = async () => {
    showCropView();
    const button = layer.querySelector('[data-detect]'); button.disabled = true; button.querySelector('span').textContent = 'Detecting…';
    const detected = await detectDocument(page.original).catch(() => null); button.disabled = false; button.querySelector('span').textContent = 'Auto crop';
    if (!detected) return notify('No clear page edges found. You can still drag the corners.');
    corners = detected; page.autoCropped = true; layer.querySelectorAll('.crop-handle').forEach((handle, index) => { handle.style.left = `${corners[index].x * 100}%`; handle.style.top = `${corners[index].y * 100}%`; }); updatePolygon(); notify('Edges found — perspective will be straightened');
  };
  layer.querySelector('[data-rotate]').onclick = () => { rotation = (rotation + 90) % 360; renderFilterPreview(filter); };
  layer.querySelectorAll('[data-filter]').forEach((button) => button.onclick = () => {
    filter = button.dataset.filter; layer.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderFilterPreview(filter);
  });
  layer.querySelector('[data-save]').onclick = async () => {
    closeModal(layer); setBusy(true, 'Polishing your page…');
    try { page.corners = corners; page.rotation = rotation; page.filter = filter; page.processed = await processPage(page.original, corners, filter, rotation); page.thumbnail = await makeThumbnail(page.processed); await persistCurrent(); renderDocument(); notify('Page updated'); }
    finally { setBusy(false); }
  };
}

function showExportSheet() {
  const layer = modal(`
    <section class="export-sheet">
      <div class="sheet-handle"></div>
      <header><div><span class="eyebrow">READY TO SHARE</span><h2>Export your scan</h2></div><button class="icon-button" data-close>${icon('close')}</button></header>
      <div class="export-summary"><img src="${state.current.pages[0].thumbnail}"><div><strong>${state.current.name}</strong><span>${state.current.pages.length} ${state.current.pages.length === 1 ? 'page' : 'pages'} · processed locally</span></div>${icon('shield', 21)}</div>
      <div class="export-options">
        <button data-type="pdf"><span class="file-type pdf">PDF</span><span><strong>PDF document</strong><small>Best for sharing and printing</small></span>${icon('chevron')}</button>
        <button data-type="word"><span class="file-type word">W</span><span><strong>Word document</strong><small>Scanned pages in a .docx file</small></span>${icon('chevron')}</button>
        <button data-type="images"><span class="file-type image">JPG</span><span><strong>Image${state.current.pages.length > 1 ? 's' : ''}</strong><small>Full-quality processed page${state.current.pages.length > 1 ? 's' : ''}</small></span>${icon('chevron')}</button>
      </div>
      <p class="local-note">${icon('shield', 16)} Created on your device. Nothing is uploaded.</p>
    </section>`, 'sheet-layer');
  layer.querySelector('[data-close]').onclick = () => closeModal(layer);
  layer.querySelectorAll('[data-type]').forEach((button) => button.onclick = async () => {
    const type = button.dataset.type; closeModal(layer); setBusy(true, `Creating ${type === 'images' ? 'images' : type.toUpperCase()}…`);
    try { if (type === 'pdf') await exportPdf(state.current); else if (type === 'word') await exportWord(state.current); else await exportImages(state.current); }
    catch (error) { if (error.name !== 'AbortError') { console.error(error); notify('Export could not be completed.'); } }
    finally { setBusy(false); }
  });
}

async function runOcr() {
  setBusy(true, 'Loading on-device text recognition…');
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, { logger: (message) => { const label = document.querySelector('.busy-card strong'); if (label && message.progress) label.textContent = `Reading text · ${Math.round(message.progress * 100)}%`; } });
    for (let i = 0; i < state.current.pages.length; i += 1) {
      const page = state.current.pages[i];
      const result = await worker.recognize(page.processed); page.ocrText = result.data.text.trim();
    }
    await worker.terminate(); await persistCurrent(); renderDocument();
    const text = state.current.pages.map((page, i) => `Page ${i + 1}\n${page.ocrText}`).join('\n\n');
    showTextResult(text); notify('Text recognized');
  } catch (error) { console.error(error); notify('Text recognition needs an internet connection the first time.'); }
  finally { setBusy(false); }
}

function showTextResult(text) {
  const layer = modal(`<section class="text-sheet"><header><div><span class="eyebrow">RECOGNIZED TEXT</span><h2>Copy or review</h2></div><button class="icon-button" data-close>${icon('close')}</button></header><textarea aria-label="Recognized document text"></textarea><button class="primary-button" data-copy>${icon('text')} Copy all text</button></section>`, 'sheet-layer');
  layer.querySelector('textarea').value = text;
  layer.querySelector('[data-close]').onclick = () => closeModal(layer);
  layer.querySelector('[data-copy]').onclick = async () => { await navigator.clipboard.writeText(layer.querySelector('textarea').value); notify('Text copied'); };
}

async function init() {
  try { state.documents = await listDocuments(); } catch (error) { console.warn('Local storage unavailable', error); }
  renderLibrary();
  const warmScanner = () => prepareDetector().catch((error) => console.warn('Scanner warm-up failed', error));
  if ('requestIdleCallback' in window) window.requestIdleCallback(warmScanner, { timeout: 2500 }); else setTimeout(warmScanner, 900);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(console.warn);
  if (new URLSearchParams(location.search).has('scan')) setTimeout(openCamera, 350);
}

init();

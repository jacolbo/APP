// Pose Board — studio side: collections, uploads, ordering, sharing.

const THUMB_MAX_EDGE = 640;
const DISPLAY_MAX_EDGE = 2400;

const state = {
  collections: [],
  collection: null,
  photos: [],
  picks: [],
  maxUploadBytes: 25 * 1024 * 1024,
  onlyPicked: false,
  search: '',
};

// ---------- tiny DOM helper (no innerHTML for user text) ----------

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const $ = (selector) => document.querySelector(selector);

let toastTimer;
function toast(message, isError = false) {
  document.querySelector('.toast')?.remove();
  const node = h('div', { class: `toast${isError ? ' error' : ''}`, text: message, role: 'status' });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), isError ? 6000 : 2600);
}

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.endsWith('/login')) {
    showLogin();
    throw new Error(data.error || 'Please sign in again');
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function uploadBinary(url, blob, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error while uploading')));
    xhr.send(blob);
  });
}

// ---------- image helpers (all resizing happens in the browser) ----------

async function renderScaled(file, maxEdge, quality) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const source = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return { blob, width, height, source };
}

// ---------- modal ----------

function openModal(card, { onClose } = {}) {
  const backdrop = h('div', { class: 'modal' }, [card]);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  card.querySelector('input, textarea, button')?.focus();
  return close;
}

// ---------- session ----------

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#login-password').focus();
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
}

async function boot() {
  const session = await api('/api/session');
  state.maxUploadBytes = (session.maxUploadMb || 25) * 1024 * 1024;
  $('#upload-hint').textContent =
    `JPEG, PNG, WebP, GIF, AVIF or HEIC — up to ${session.maxUploadMb} MB each. Bigger files are resized automatically.`;
  $('#login-default-warning').hidden = !session.usingDefaultPassword;
  $('#default-password-banner').hidden = !session.usingDefaultPassword;
  if (!session.authed) return showLogin();
  showApp();
  await loadCollections();
  route();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#login-error');
  error.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    showApp();
    await loadCollections();
    route();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.hash = '';
  showLogin();
});

// ---------- routing ----------

function route() {
  const match = /^#\/c\/([A-Za-z0-9_-]+)/.exec(location.hash);
  if (match) openCollection(match[1]);
  else showDashboard();
}

window.addEventListener('hashchange', route);

// ---------- dashboard ----------

async function loadCollections() {
  const data = await api('/api/collections');
  state.collections = data.collections;
}

function showDashboard() {
  state.collection = null;
  $('#collection-view').hidden = true;
  $('#dashboard-view').hidden = false;
  $('#nav-home').hidden = true;
  renderDashboard();
}

function renderDashboard() {
  const grid = $('#collection-cards');
  const term = state.search.trim().toLowerCase();
  const collections = term
    ? state.collections.filter((c) =>
        `${c.title} ${c.clientName} ${c.description}`.toLowerCase().includes(term))
    : state.collections;

  grid.replaceChildren(...collections.map(collectionCard));
  $('#dashboard-empty').hidden = state.collections.length > 0;
  grid.hidden = collections.length === 0;

  if (state.collections.length && !collections.length) {
    grid.hidden = true;
    $('#dashboard-empty').hidden = false;
    $('#dashboard-empty').querySelector('p').textContent = `Nothing matches “${state.search}”.`;
  }
}

function collectionCard(collection) {
  const cover = collection.coverPhotoId
    ? h('img', { src: `/t/${collection.coverPhotoId}`, alt: '', loading: 'lazy' })
    : h('span', { text: 'No photos yet' });

  return h('button', {
    class: 'card',
    type: 'button',
    onclick: () => { location.hash = `#/c/${collection.id}`; },
  }, [
    h('div', { class: 'card-cover' }, [cover]),
    h('div', { class: 'card-body' }, [
      h('h3', { class: 'card-title', text: collection.title }),
      collection.clientName ? h('p', { class: 'card-meta', text: `For ${collection.clientName}` }) : null,
      h('p', { class: 'card-meta', text: `${collection.photoCount} pose${collection.photoCount === 1 ? '' : 's'}` }),
      h('div', { class: 'card-foot' }, [
        h('span', {
          class: `badge${collection.published ? ' live' : ''}`,
          text: collection.published ? 'Live' : 'Draft',
        }),
        collection.pin ? h('span', { class: 'badge', text: 'PIN' }) : null,
        collection.pickCount
          ? h('span', { class: 'badge warn', text: `♥ ${collection.pickCount}` })
          : null,
      ]),
    ]),
  ]);
}

$('#collection-search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderDashboard();
});

// ---------- new collection ----------

function newCollectionDialog() {
  const title = h('input', { type: 'text', required: true, placeholder: 'Maternity — studio poses' });
  const client = h('input', { type: 'text', placeholder: 'Sarah & Tom (optional)' });
  const description = h('textarea', { placeholder: 'A note your client will see at the top of the gallery (optional)' });

  const form = h('form', { class: 'modal-card' }, [
    h('h2', { text: 'New collection' }),
    h('label', { class: 'field' }, [h('span', { text: 'Name' }), title]),
    h('label', { class: 'field' }, [h('span', { text: 'Client' }), client]),
    h('label', { class: 'field' }, [h('span', { text: 'Intro note' }), description]),
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onclick: () => close() }),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Create' }),
    ]),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const { collection } = await api('/api/collections', {
        method: 'POST',
        body: { title: title.value, clientName: client.value, description: description.value },
      });
      close();
      await loadCollections();
      location.hash = `#/c/${collection.id}`;
      toast('Collection created');
    } catch (err) {
      toast(err.message, true);
    }
  });

  const close = openModal(form);
}

$('#new-collection').addEventListener('click', newCollectionDialog);
$('#empty-new-collection').addEventListener('click', newCollectionDialog);
$('#nav-home').addEventListener('click', () => { location.hash = ''; });

// ---------- collection view ----------

async function openCollection(id) {
  try {
    const data = await api(`/api/collections/${id}`);
    state.collection = data.collection;
    state.photos = data.photos;
    state.picks = data.picks;
  } catch (err) {
    toast(err.message, true);
    location.hash = '';
    return;
  }
  $('#dashboard-view').hidden = true;
  $('#collection-view').hidden = false;
  $('#nav-home').hidden = false;
  renderCollection();
}

function renderCollection() {
  const collection = state.collection;
  if (!collection) return;

  $('#collection-title').textContent = collection.title;
  const bits = [];
  if (collection.clientName) bits.push(`For ${collection.clientName}`);
  if (collection.description) bits.push(collection.description);
  $('#collection-subtitle').textContent = bits.join(' · ');

  const status = $('#collection-status');
  status.textContent = collection.published ? 'Live' : 'Draft';
  status.className = `badge${collection.published ? ' live' : ''}`;

  $('#publish-toggle').checked = collection.published;
  $('#share-url').value = `${location.origin}/s/${collection.shareId}`;
  $('#share-hint').textContent = collection.published
    ? collection.pin
      ? 'Anyone with this link and the PIN can view the gallery.'
      : 'Anyone with this link can view the gallery. Add a PIN in Settings for another layer.'
    : 'The gallery is a draft — the link will not open until you switch it live.';

  renderPhotos();
  renderPicks();
}

function picksFor(photoId) {
  return state.picks.filter((pick) => pick.photoId === photoId);
}

function renderPhotos() {
  const grid = $('#photo-grid');
  const photos = state.onlyPicked
    ? state.photos.filter((photo) => picksFor(photo.id).length > 0)
    : state.photos;

  grid.replaceChildren(...photos.map((photo, index) => photoTile(photo, index)));
  $('#photo-count').textContent = state.photos.length ? `· ${state.photos.length}` : '';
  $('#collection-empty').hidden = state.photos.length > 0;
  grid.hidden = photos.length === 0;
}

function photoTile(photo, index) {
  const picks = picksFor(photo.id);
  const isCover = state.collection.coverPhotoId === photo.id;
  const reorderable = !state.onlyPicked;

  const image = h('img', {
    src: photo.hasThumb ? `/t/${photo.id}` : `/f/${photo.id}`,
    alt: photo.title || photo.originalName || 'Pose',
    loading: 'lazy',
    draggable: 'false',
  });

  const tile = h('div', {
    class: `tile${picks.length ? ' picked-ring' : ''}`,
    dataset: { id: photo.id },
    draggable: reorderable ? 'true' : 'false',
  }, [
    h('button', {
      class: 'tile-open',
      type: 'button',
      title: 'Open',
      onclick: () => openPhotoEditor(index),
    }, [image]),
    h('div', { class: 'tile-actions' }, [
      reorderable
        ? h('span', { class: 'icon-btn drag-handle', title: 'Drag to reorder', text: '⠿' })
        : null,
      h('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Delete',
        onclick: () => deletePhoto(photo),
      }, ['🗑']),
    ]),
    (photo.title || picks.length || isCover)
      ? h('div', { class: 'tile-caption' }, [
          isCover ? h('span', { title: 'Cover photo' }, ['★']) : null,
          picks.length ? h('span', { text: `♥ ${picks.length}` }) : null,
          photo.title ? h('span', { text: photo.title }) : null,
        ])
      : null,
  ]);

  return tile;
}

// drag to reorder
let draggingId = null;
const grid = $('#photo-grid');

grid.addEventListener('dragstart', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile || tile.draggable === false) return;
  draggingId = tile.dataset.id;
  tile.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggingId);
});

grid.addEventListener('dragover', (event) => {
  const dragging = grid.querySelector('.dragging');
  if (!dragging) return;
  event.preventDefault();
  const target = event.target.closest('.tile');
  if (!target || target === dragging) return;
  const rect = target.getBoundingClientRect();
  const after = event.clientX - rect.left > rect.width / 2;
  grid.insertBefore(dragging, after ? target.nextSibling : target);
});

grid.addEventListener('drop', (event) => event.preventDefault());

grid.addEventListener('dragend', async () => {
  const dragging = grid.querySelector('.dragging');
  dragging?.classList.remove('dragging');
  if (!draggingId) return;
  draggingId = null;
  const ids = [...grid.querySelectorAll('.tile')].map((tile) => tile.dataset.id);
  try {
    const { photos } = await api(`/api/collections/${state.collection.id}/order`, {
      method: 'POST',
      body: { ids },
    });
    state.photos = photos;
  } catch (err) {
    toast(err.message, true);
    renderPhotos();
  }
});

$('#only-picked').addEventListener('change', (event) => {
  state.onlyPicked = event.target.checked;
  renderPhotos();
});

// ---------- picks summary ----------

function renderPicks() {
  const panel = $('#picks-panel');
  const summary = $('#picks-summary');
  if (!state.picks.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const byClient = new Map();
  for (const pick of state.picks) {
    const name = pick.clientName || 'Guest';
    if (!byClient.has(name)) byClient.set(name, []);
    byClient.get(name).push(pick);
  }

  summary.replaceChildren(...[...byClient.entries()].map(([name, picks]) =>
    h('div', { class: 'stack', style: 'border-top:1px solid var(--line-soft); padding-top:12px' }, [
      h('div', { class: 'row' }, [
        h('strong', { text: name }),
        h('span', { class: 'badge warn', text: `♥ ${picks.length}` }),
      ]),
      h('div', { class: 'row', style: 'gap:8px' }, picks.map((pick) => {
        const index = state.photos.findIndex((photo) => photo.id === pick.photoId);
        return h('button', {
          class: 'icon-btn',
          type: 'button',
          style: 'width:56px;height:72px;border-radius:8px;overflow:hidden;padding:0',
          title: pick.note || 'Open pose',
          onclick: () => index >= 0 && openPhotoEditor(index),
        }, [h('img', {
          src: `/t/${pick.photoId}`,
          alt: '',
          style: 'width:100%;height:100%;object-fit:cover',
          loading: 'lazy',
        })]);
      })),
      ...picks.filter((pick) => pick.note).map((pick) =>
        h('p', { class: 'small muted', style: 'margin:0' }, [`“${pick.note}”`])),
    ])));
}

// ---------- uploading ----------

const dropzone = $('#dropzone');
const fileInput = $('#file-input');

$('#pick-files').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  uploadFiles([...fileInput.files]);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) =>
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('hot');
  }));

['dragleave', 'drop'].forEach((type) =>
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && dropzone.contains(event.relatedTarget)) return;
    dropzone.classList.remove('hot');
  }));

dropzone.addEventListener('drop', (event) => {
  const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (files.length) uploadFiles(files);
});

function setProgress(fraction, label) {
  const bar = $('#upload-progress');
  bar.hidden = fraction === null;
  if (fraction !== null) bar.firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
  if (label !== undefined) $('#upload-hint').textContent = label;
}

let uploading = false;

async function uploadFiles(files) {
  if (!state.collection) return;
  if (uploading) return toast('Still uploading the last batch — one moment.', true);
  const images = files.filter((file) => file.type.startsWith('image/'));
  if (!images.length) return toast('Those files are not images.', true);

  uploading = true;
  const originalHint = $('#upload-hint').textContent;
  let done = 0;
  let failed = 0;

  for (const [index, file] of images.entries()) {
    const label = `Uploading ${index + 1} of ${images.length} — ${file.name}`;
    setProgress(0, label);
    try {
      await uploadOne(file, (fraction) => setProgress(fraction, label));
      done += 1;
    } catch (err) {
      failed += 1;
      toast(`${file.name}: ${err.message}`, true);
    }
  }

  uploading = false;
  setProgress(null, originalHint);
  if (done) {
    await openCollection(state.collection.id);
    await loadCollections();
    toast(`Added ${done} photo${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
  }
}

async function uploadOne(file, onProgress) {
  let body = file;
  let type = file.type;
  let dimensions = null;

  // Anything over the limit (or an unusually large original) is resized in the
  // browser so the studio can still upload straight off a phone.
  if (file.size > state.maxUploadBytes) {
    const scaled = await renderScaled(file, DISPLAY_MAX_EDGE, 0.86).catch(() => null);
    if (!scaled?.blob) throw new Error('too large and could not be resized in the browser');
    if (scaled.blob.size > state.maxUploadBytes) throw new Error('still too large after resizing');
    body = scaled.blob;
    type = 'image/jpeg';
    dimensions = { width: scaled.width, height: scaled.height };
  }

  const thumb = await renderScaled(file, THUMB_MAX_EDGE, 0.82).catch(() => null);
  if (thumb && !dimensions) dimensions = { width: thumb.source.width, height: thumb.source.height };

  const query = dimensions ? `?w=${dimensions.width}&h=${dimensions.height}` : '';
  const { photo } = await uploadBinary(
    `/api/collections/${state.collection.id}/photos${query}`,
    body,
    {
      'content-type': type || 'image/jpeg',
      'x-filename': file.name.replace(/[^\x20-\x7E]/g, '_').slice(0, 120),
    },
    onProgress,
  );

  if (thumb?.blob) {
    await uploadBinary(`/api/photos/${photo.id}/thumbnail`, thumb.blob, { 'content-type': 'image/jpeg' })
      .catch(() => { /* the full-size image is used as its own thumbnail */ });
  }
  return photo;
}

// ---------- photo editor ----------

function openPhotoEditor(startIndex) {
  let index = startIndex;

  const stageImage = h('img', { alt: '', src: '' });
  const title = h('input', { type: 'text', placeholder: 'Standing, hands in pockets' });
  const notes = h('textarea', { placeholder: 'Direction for the shoot: lighting, angle, what to avoid…' });
  const tags = h('input', { type: 'text', placeholder: 'seated, outdoor, golden hour' });
  const meta = h('p', { class: 'small muted', style: 'margin:0 0 14px' });
  const pickList = h('div', { class: 'stack small', style: 'margin-bottom:14px' });
  const coverButton = h('button', { class: 'btn btn-sm', type: 'button' });

  const side = h('div', { class: 'lightbox-side' }, [
    h('h2', { style: 'font-family:var(--serif);margin:0 0 10px;font-size:19px', text: 'Pose details' }),
    meta,
    pickList,
    h('label', { class: 'field' }, [h('span', { text: 'Title' }), title]),
    h('label', { class: 'field' }, [h('span', { text: 'Notes for the shoot' }), notes]),
    h('label', { class: 'field' }, [h('span', { text: 'Tags (comma separated)' }), tags]),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: 'Save', onclick: save }),
      coverButton,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Delete', onclick: removeCurrent }),
    ]),
  ]);

  const card = h('div', { class: 'modal-card lightbox-card' }, [
    h('div', { class: 'lightbox-stage' }, [
      h('button', { class: 'icon-btn close-x', type: 'button', title: 'Close', text: '✕', onclick: () => close() }),
      h('button', { class: 'icon-btn lightbox-nav prev', type: 'button', title: 'Previous', text: '‹', onclick: () => step(-1) }),
      stageImage,
      h('button', { class: 'icon-btn lightbox-nav next', type: 'button', title: 'Next', text: '›', onclick: () => step(1) }),
    ]),
    side,
  ]);

  function current() {
    return state.photos[index];
  }

  function paint() {
    const photo = current();
    if (!photo) return close();
    stageImage.src = `/f/${photo.id}`;
    stageImage.alt = photo.title || 'Pose';
    title.value = photo.title || '';
    notes.value = photo.notes || '';
    tags.value = (photo.tags || []).join(', ');
    const size = photo.size ? `${(photo.size / (1024 * 1024)).toFixed(1)} MB` : '';
    const dims = photo.width && photo.height ? `${photo.width}×${photo.height}` : '';
    meta.textContent = [`${index + 1} of ${state.photos.length}`, dims, size, photo.originalName]
      .filter(Boolean)
      .join(' · ');

    const picks = picksFor(photo.id);
    pickList.replaceChildren(...(picks.length
      ? [h('p', { class: 'badge warn', style: 'margin:0', text: `Picked by ${picks.map((p) => p.clientName).join(', ')}` }),
         ...picks.filter((p) => p.note).map((p) => h('p', { class: 'muted', style: 'margin:0', text: `“${p.note}”` }))]
      : []));

    const isCover = state.collection.coverPhotoId === photo.id;
    coverButton.textContent = isCover ? '★ Cover' : 'Make cover';
    coverButton.onclick = () => setCover(isCover ? null : photo.id);
  }

  function step(delta) {
    const next = index + delta;
    if (next < 0 || next >= state.photos.length) return;
    index = next;
    paint();
  }

  async function save() {
    const photo = current();
    try {
      const { photo: updated } = await api(`/api/photos/${photo.id}`, {
        method: 'PATCH',
        body: {
          title: title.value,
          notes: notes.value,
          tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
        },
      });
      Object.assign(photo, updated);
      renderPhotos();
      paint();
      toast('Saved');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function setCover(photoId) {
    try {
      const { collection } = await api(`/api/collections/${state.collection.id}`, {
        method: 'PATCH',
        body: { coverPhotoId: photoId },
      });
      state.collection = collection;
      renderPhotos();
      paint();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function removeCurrent() {
    const photo = current();
    if (!confirm('Delete this pose? This removes the file for good.')) return;
    try {
      await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
      state.photos = state.photos.filter((p) => p.id !== photo.id);
      state.picks = state.picks.filter((p) => p.photoId !== photo.id);
      renderPhotos();
      renderPicks();
      await loadCollections();
      if (!state.photos.length) return close();
      index = Math.min(index, state.photos.length - 1);
      paint();
      toast('Deleted');
    } catch (err) {
      toast(err.message, true);
    }
  }

  function onKey(event) {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  }

  document.addEventListener('keydown', onKey);
  const close = openModal(card, { onClose: () => document.removeEventListener('keydown', onKey) });
  paint();
}

async function deletePhoto(photo) {
  if (!confirm('Delete this pose? This removes the file for good.')) return;
  try {
    await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
    state.photos = state.photos.filter((p) => p.id !== photo.id);
    state.picks = state.picks.filter((p) => p.photoId !== photo.id);
    renderPhotos();
    renderPicks();
    await loadCollections();
    toast('Deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- sharing & settings ----------

$('#publish-toggle').addEventListener('change', async (event) => {
  try {
    const { collection } = await api(`/api/collections/${state.collection.id}`, {
      method: 'PATCH',
      body: { published: event.target.checked },
    });
    state.collection = collection;
    renderCollection();
    await loadCollections();
    toast(collection.published ? 'Gallery is live' : 'Gallery is back to draft');
  } catch (err) {
    toast(err.message, true);
    event.target.checked = !event.target.checked;
  }
});

$('#copy-share').addEventListener('click', async () => {
  const url = $('#share-url').value;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    $('#share-url').select();
    toast('Press ⌘/Ctrl + C to copy', true);
  }
});

$('#collection-settings').addEventListener('click', () => {
  const collection = state.collection;
  const title = h('input', { type: 'text', value: collection.title, required: true });
  const client = h('input', { type: 'text', value: collection.clientName || '' });
  const description = h('textarea', {}, [collection.description || '']);
  const pin = h('input', { type: 'text', inputmode: 'numeric', placeholder: collection.pin ? 'Enter a new PIN' : '4–12 digits (optional)' });

  const form = h('form', { class: 'modal-card' }, [
    h('h2', { text: 'Collection settings' }),
    h('label', { class: 'field' }, [h('span', { text: 'Name' }), title]),
    h('label', { class: 'field' }, [h('span', { text: 'Client' }), client]),
    h('label', { class: 'field' }, [h('span', { text: 'Intro note' }), description]),
    h('label', { class: 'field' }, [h('span', { text: collection.pin ? 'PIN (a PIN is set)' : 'PIN' }), pin]),
    collection.pin
      ? h('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          text: 'Remove PIN',
          onclick: async () => {
            await patch({ pin: '' });
            close();
            toast('PIN removed');
          },
        })
      : null,
    h('hr', { style: 'border:none;border-top:1px solid var(--line-soft);margin:18px 0' }),
    h('div', { class: 'row' }, [
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: 'Reset share link',
        title: 'The old link stops working immediately',
        onclick: async () => {
          if (!confirm('Reset the link? The old one stops working for everyone you sent it to.')) return;
          try {
            const { collection: updated } = await api(`/api/collections/${collection.id}/reshare`, { method: 'POST' });
            state.collection = updated;
            renderCollection();
            close();
            toast('New share link created');
          } catch (err) {
            toast(err.message, true);
          }
        },
      }),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-sm btn-danger',
        type: 'button',
        text: 'Delete collection',
        onclick: async () => {
          if (!confirm(`Delete “${collection.title}” and all ${state.photos.length} photo(s)? This cannot be undone.`)) return;
          try {
            await api(`/api/collections/${collection.id}`, { method: 'DELETE' });
            close();
            await loadCollections();
            location.hash = '';
            toast('Collection deleted');
          } catch (err) {
            toast(err.message, true);
          }
        },
      }),
    ]),
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onclick: () => close() }),
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save' }),
    ]),
  ]);

  async function patch(body) {
    const { collection: updated } = await api(`/api/collections/${collection.id}`, { method: 'PATCH', body });
    state.collection = updated;
    renderCollection();
    await loadCollections();
    return updated;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      title: title.value,
      clientName: client.value,
      description: description.value,
    };
    if (pin.value.trim()) body.pin = pin.value.trim();
    try {
      await patch(body);
      close();
      toast('Saved');
    } catch (err) {
      toast(err.message, true);
    }
  });

  const close = openModal(form);
});

boot().catch((err) => {
  console.error(err);
  toast(err.message || 'Could not reach the server', true);
});

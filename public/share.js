// Pose Board — the client's view: browse a gallery and pick favourites.

const shareId = decodeURIComponent(location.pathname.replace(/^\/s\//, '').replace(/\/$/, ''));

const state = {
  collection: null,
  photos: [],
  picks: new Map(), // photoId -> note
  pin: '',
  clientKey: '',
  clientName: '',
  onlyMine: false,
};

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
  toastTimer = setTimeout(() => node.remove(), isError ? 5000 : 2400);
}

// ---------- local identity (so a client can change their own picks) ----------

const storageKey = `poseboard:${shareId}`;

function loadIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    state.clientKey = typeof saved.clientKey === 'string' ? saved.clientKey : '';
    state.clientName = typeof saved.clientName === 'string' ? saved.clientName : '';
    state.pin = typeof saved.pin === 'string' ? saved.pin : '';
  } catch { /* private mode or blocked storage — picks still work for this visit */ }
  if (!state.clientKey) {
    state.clientKey = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(/-/g, '');
    saveIdentity();
  }
}

function saveIdentity() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      clientKey: state.clientKey,
      clientName: state.clientName,
      pin: state.pin,
    }));
  } catch { /* ignore */ }
}

// ---------- API ----------

function shareUrl(path = '') {
  return new URL(`/api/share/${encodeURIComponent(shareId)}${path}`, location.origin);
}

/** The PIN goes in a header rather than the URL so it stays out of server logs. */
function pinHeaders(extra = {}) {
  return state.pin ? { ...extra, 'x-gallery-pin': state.pin } : { ...extra };
}

async function loadGallery() {
  const url = shareUrl();
  url.searchParams.set('clientKey', state.clientKey);
  const response = await fetch(url, { credentials: 'same-origin', headers: pinHeaders() });
  const data = await response.json().catch(() => ({}));

  if (response.ok) return data;
  if (data.pinRequired) {
    const error = Boolean(state.pin);
    state.pin = '';
    saveIdentity();
    showPinGate(error ? 'That PIN did not work. Try again.' : '');
    return null;
  }
  showGone(data.error);
  return null;
}

// ---------- views ----------

function showPinGate(message) {
  $('#gallery-view').hidden = true;
  $('#gone-view').hidden = true;
  $('#pin-view').hidden = false;
  const error = $('#pin-error');
  error.textContent = message || '';
  error.hidden = !message;
  $('#pin-input').focus();
}

function showGone(message) {
  $('#pin-view').hidden = true;
  $('#gallery-view').hidden = true;
  $('#gone-view').hidden = false;
  if (message) $('#gone-message').textContent = message;
}

function showGallery(data) {
  state.collection = data.collection;
  state.photos = data.photos;
  state.picks = new Map(data.picks.map((pick) => [pick.photoId, pick.note || '']));

  $('#pin-view').hidden = true;
  $('#gone-view').hidden = true;
  $('#gallery-view').hidden = false;

  document.title = `${data.collection.title} — Pose gallery`;
  $('#brand-title').textContent = data.collection.title;
  $('#gallery-title').textContent = data.collection.title;
  const subtitle = [data.collection.clientName, data.collection.description].filter(Boolean).join(' · ');
  $('#gallery-subtitle').textContent = subtitle;
  $('#gallery-subtitle').hidden = !subtitle;

  renderNameButton();
  renderPhotos();
}

function renderNameButton() {
  const button = $('#change-name');
  button.hidden = !state.clientName;
  button.textContent = state.clientName ? `You: ${state.clientName}` : '';
  button.title = 'Change the name your photographer sees';
}

function renderPhotos() {
  const grid = $('#photo-grid');
  const photos = state.onlyMine ? state.photos.filter((photo) => state.picks.has(photo.id)) : state.photos;
  grid.replaceChildren(...photos.map((photo) => photoTile(photo)));

  const empty = $('#gallery-empty');
  empty.hidden = photos.length > 0;
  if (!photos.length) {
    empty.textContent = state.onlyMine
      ? 'You have not picked any poses yet.'
      : 'No poses have been added to this gallery yet.';
  }

  $('#pick-count').textContent = `♥ ${state.picks.size} picked`;
}

function photoTile(photo) {
  const picked = state.picks.has(photo.id);
  const index = state.photos.indexOf(photo);

  return h('div', { class: `tile${picked ? ' picked-ring' : ''}`, dataset: { id: photo.id } }, [
    h('button', {
      class: 'tile-open',
      type: 'button',
      title: photo.title || 'View pose',
      onclick: () => openLightbox(index),
    }, [
      h('img', {
        src: photo.hasThumb ? `/t/${photo.id}` : `/f/${photo.id}`,
        alt: photo.title || 'Pose',
        loading: 'lazy',
      }),
    ]),
    h('div', { class: 'tile-actions', style: 'opacity:1' }, [
      h('button', {
        class: `icon-btn${picked ? ' on' : ''}`,
        type: 'button',
        title: picked ? 'Remove from your picks' : 'Add to your picks',
        'aria-pressed': picked ? 'true' : 'false',
        text: picked ? '♥' : '♡',
        onclick: () => togglePick(photo.id),
      }),
    ]),
    photo.title ? h('div', { class: 'tile-caption' }, [h('span', { text: photo.title })]) : null,
  ]);
}

// ---------- picking ----------

async function askName() {
  const suggested = state.collection?.clientName || '';
  const answer = prompt('Your name — so your photographer knows whose picks these are:', state.clientName || suggested);
  if (answer === null) return false;
  state.clientName = answer.trim().slice(0, 80) || 'Guest';
  saveIdentity();
  renderNameButton();
  return true;
}

async function setPick(photoId, picked, note) {
  if (picked && !state.clientName && !(await askName())) return state.picks.has(photoId);
  try {
    const response = await fetch(shareUrl('/pick'), {
      method: 'POST',
      headers: pinHeaders({ 'content-type': 'application/json' }),
      credentials: 'same-origin',
      body: JSON.stringify({
        photoId,
        clientKey: state.clientKey,
        clientName: state.clientName,
        picked,
        note: note ?? '',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not save your pick');
    if (data.picked) state.picks.set(photoId, data.note || '');
    else state.picks.delete(photoId);
    renderPhotos();
    return data.picked;
  } catch (err) {
    toast(err.message, true);
    return state.picks.has(photoId);
  }
}

function togglePick(photoId) {
  const picked = !state.picks.has(photoId);
  return setPick(photoId, picked, state.picks.get(photoId) ?? '');
}

function savePickNote(photoId, note) {
  if (!state.picks.has(photoId)) return Promise.resolve(false);
  return setPick(photoId, true, note);
}

// ---------- lightbox ----------

function openLightbox(startIndex) {
  let index = startIndex;

  const stageImage = h('img', { alt: '', src: '' });
  const heading = h('h2', { style: 'font-family:var(--serif);margin:0 0 6px;font-size:20px' });
  const counter = h('p', { class: 'small muted', style: 'margin:0 0 12px' });
  const notes = h('p', { style: 'margin:0 0 14px; white-space:pre-wrap' });
  const tagRow = h('div', { class: 'row', style: 'gap:6px; margin-bottom:16px' });
  const heartButton = h('button', { class: 'btn', type: 'button', style: 'width:100%; justify-content:center' });
  const noteInput = h('textarea', { placeholder: 'Add a note for your photographer (optional)', style: 'min-height:70px' });
  const noteWrap = h('div', { style: 'margin-top:14px' }, [
    h('label', { class: 'field' }, [h('span', { text: 'Your note on this pose' }), noteInput]),
    h('button', { class: 'btn btn-sm', type: 'button', text: 'Save note', onclick: saveNote }),
  ]);

  const card = h('div', { class: 'modal-card lightbox-card' }, [
    h('div', { class: 'lightbox-stage' }, [
      h('button', { class: 'icon-btn close-x', type: 'button', title: 'Close', text: '✕', onclick: () => close() }),
      h('button', { class: 'icon-btn lightbox-nav prev', type: 'button', title: 'Previous', text: '‹', onclick: () => step(-1) }),
      stageImage,
      h('button', { class: 'icon-btn lightbox-nav next', type: 'button', title: 'Next', text: '›', onclick: () => step(1) }),
    ]),
    h('div', { class: 'lightbox-side' }, [heading, counter, notes, tagRow, heartButton, noteWrap]),
  ]);

  function current() {
    return state.photos[index];
  }

  function paint() {
    const photo = current();
    if (!photo) return close();
    stageImage.src = `/f/${photo.id}`;
    stageImage.alt = photo.title || 'Pose';
    heading.textContent = photo.title || 'Pose';
    counter.textContent = `${index + 1} of ${state.photos.length}`;
    notes.textContent = photo.notes || '';
    notes.hidden = !photo.notes;
    tagRow.replaceChildren(...(photo.tags || []).map((tag) => h('span', { class: 'tag', text: tag })));

    const picked = state.picks.has(photo.id);
    heartButton.textContent = picked ? '♥ Picked — tap to remove' : '♡ Add to my picks';
    heartButton.className = `btn${picked ? ' btn-primary' : ''}`;
    heartButton.onclick = async () => {
      await togglePick(photo.id);
      paint();
    };
    noteInput.value = picked ? state.picks.get(photo.id) || '' : '';
    noteWrap.hidden = !picked;
  }

  async function saveNote() {
    const photo = current();
    await savePickNote(photo.id, noteInput.value.trim().slice(0, 500));
    toast('Note saved');
    paint();
  }

  function step(delta) {
    const next = index + delta;
    if (next < 0 || next >= state.photos.length) return;
    index = next;
    paint();
  }

  function onKey(event) {
    if (event.key === 'Escape') return close();
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  }

  const backdrop = h('div', { class: 'modal' }, [card]);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  paint();
}

// ---------- wiring ----------

$('#only-mine').addEventListener('change', (event) => {
  state.onlyMine = event.target.checked;
  renderPhotos();
});

$('#change-name').addEventListener('click', askName);

$('#pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.pin = $('#pin-input').value.trim();
  saveIdentity();
  const data = await loadGallery();
  if (data) showGallery(data);
});

async function start() {
  if (!shareId) return showGone('That link is missing its gallery id.');
  loadIdentity();
  try {
    const data = await loadGallery();
    if (data) showGallery(data);
  } catch (err) {
    showGone('Could not reach the gallery. Check your connection and reload.');
    console.error(err);
  }
}

start();

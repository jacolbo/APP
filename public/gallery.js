// Pose Board — the client's gallery: browse the folders your photographer
// shared, heart the ones you want, and send the shortlist back.
//
// Nothing here ever sees a file path. Every image is an opaque /i/, /t/ or
// /d/ route keyed by id, and a tab the photographer marked private is simply
// not in the payload until the PIN is accepted.

const link = decodeURIComponent(location.pathname.replace(/^\/(g|s)\/?/, '').replace(/\/$/, ''));

const state = {
  gallery: null,
  folder: null,
  folders: [],
  tabs: [],
  favorites: [],
  activeTabId: null,
  sessionId: '',
  pending: new Set(), // image ids with a save in flight
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

// ---------- who this visitor is ----------
//
// There are no accounts: a random id in localStorage is what ties a set of
// favourites to one person, so a refresh (or coming back tomorrow) keeps them.

const storageKey = `poseboard:gallery:${link}`;

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (typeof saved.sessionId === 'string') state.sessionId = saved.sessionId;
  } catch { /* private mode: favourites still work, just not across visits */ }
  if (!state.sessionId) {
    state.sessionId = (crypto.randomUUID?.() || `${Math.random().toString(36).slice(2)}${Date.now()}`).replace(/-/g, '');
    try {
      localStorage.setItem(storageKey, JSON.stringify({ sessionId: state.sessionId }));
    } catch { /* ignore */ }
  }
}

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/api/g/${encodeURIComponent(link)}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || 'Something went wrong'), {
      status: response.status,
      data,
    });
  }
  return data;
}

async function load(folderId) {
  const params = new URLSearchParams({ clientSessionId: state.sessionId });
  if (folderId) params.set('f', folderId);
  const data = await api(`?${params}`);

  state.gallery = data.gallery;
  state.folder = data.folder;
  state.folders = data.folders;
  state.tabs = data.tabs;
  state.favorites = data.favorites;

  // Keep the open tab across a reload when it is still there; otherwise fall
  // back to the first tab that actually has something in it.
  if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
    state.activeTabId = (state.tabs.find((tab) => !tab.locked && tab.images.length) || state.tabs[0])?.id || null;
  }
  render();
}

// ---------- favourites ----------

const isFavorite = (imageId) => state.favorites.some((fav) => fav.id === imageId);

/**
 * Saves straight away rather than batching, so closing the tab mid-browse
 * never loses a pick. The tile flips immediately and rolls back if the save
 * fails, and a second click while one is in flight is ignored.
 */
async function toggleFavorite(image, force) {
  if (state.pending.has(image.id)) return;
  const next = force === undefined ? !isFavorite(image.id) : force;
  state.pending.add(image.id);

  const previous = state.favorites;
  state.favorites = next
    ? [...state.favorites, { ...image, locked: false, note: '', createdAt: new Date().toISOString() }]
    : state.favorites.filter((fav) => fav.id !== image.id);
  render();

  try {
    await api('/select', {
      method: 'POST',
      body: { imageId: image.id, clientSessionId: state.sessionId, selected: next },
    });
  } catch (err) {
    state.favorites = previous;
    render();
    toast(err.message, true);
  } finally {
    state.pending.delete(image.id);
  }
}

// ---------- the PIN gate ----------

function askForPin(reason) {
  return new Promise((resolve) => {
    const error = h('p', { class: 'hint', style: 'color:var(--danger)', hidden: true });
    const input = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', id: 'pin-input' });
    let busy = false;

    const close = (value) => { modal.remove(); resolve(value); };

    const submit = async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      error.hidden = true;
      try {
        await api('/unlock', { method: 'POST', body: { pin: input.value.trim() } });
        close(true);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        input.select();
      } finally {
        busy = false;
      }
    };

    const form = h('form', { class: 'modal-card', onsubmit: submit }, [
      h('h2', { text: 'Enter your PIN' }),
      h('p', { class: 'hint', style: 'margin-bottom:16px', text: reason }),
      h('label', { class: 'field' }, [h('span', { text: 'Gallery PIN' }), input]),
      error,
      h('div', { class: 'modal-actions' }, [
        h('button', { type: 'button', class: 'btn', onclick: () => close(false), text: 'Cancel' }),
        h('button', { type: 'submit', class: 'btn btn-primary', text: 'Unlock' }),
      ]),
    ]);

    const modal = h('div', {
      class: 'modal',
      onclick: (event) => { if (event.target === modal) close(false); },
    }, [form]);

    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape' && document.body.contains(modal)) { close(false); }
      if (!document.body.contains(modal)) document.removeEventListener('keydown', onKey);
    });

    $('#modal-root').append(modal);
    input.focus();
  });
}

/** Downloads need a live grant; ask for the PIN, then reload so unlocked tabs appear. */
async function download(image) {
  if (!state.gallery.unlocked) {
    if (!state.gallery.hasPin) {
      toast('Your photographer has not set a download PIN yet', true);
      return;
    }
    const unlocked = await askForPin('Your photographer gave you a PIN for downloading.');
    if (!unlocked) return;
    await load(state.folder.id);
  }
  // Same-origin and served as an attachment, so this saves the file rather
  // than navigating away from the gallery.
  location.href = `/d/${encodeURIComponent(image.id)}`;
}

async function unlockTab() {
  if (!state.gallery.hasPin) {
    toast('Your photographer has not set a PIN for this gallery yet', true);
    return;
  }
  if (await askForPin('This part of the gallery is protected by a PIN.')) {
    await load(state.folder.id);
    toast('Unlocked');
  }
}

// ---------- handing the shortlist over ----------

async function sendToPhotographer() {
  const button = $('#send-button');
  const status = $('#send-status');
  button.disabled = true;
  button.textContent = 'Sending…';
  status.hidden = false;
  status.style.color = 'var(--muted)';
  status.textContent = 'Sending your selection…';

  try {
    const result = await api('/handoff', { method: 'POST', body: { clientSessionId: state.sessionId } });
    // The server only answers 200 once the photographer's system did, so this
    // message is never shown on a delivery that did not land.
    status.style.color = 'var(--ok)';
    status.textContent = `Sent — your photographer has your ${result.total_selected} picks.`;
    button.textContent = 'Send again';
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = `${err.message}. Nothing was sent — please try again.`;
    button.textContent = 'Send to photographer';
  } finally {
    button.disabled = false;
  }
}

// ---------- the lightbox ----------

function openLightbox(images, startIndex) {
  let index = startIndex;

  const figure = h('img', { alt: '' });
  const caption = h('p', { class: 'muted small', style: 'margin:0' });
  const heart = h('button', { class: 'btn btn-sm' });

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const downloadButton = activeTab?.downloadable
    ? h('button', { class: 'btn btn-sm', text: 'Download', onclick: () => download(images[index]) })
    : null;

  function paint() {
    const image = images[index];
    figure.src = image.url;
    figure.alt = image.title || image.fileName || 'Photo';
    caption.textContent = `${index + 1} of ${images.length}${image.title ? ` · ${image.title}` : ''}`;
    heart.textContent = isFavorite(image.id) ? '♥ Favourited' : '♡ Add to favourites';
    heart.className = `btn btn-sm${isFavorite(image.id) ? ' btn-primary' : ''}`;
  }

  const step = (delta) => {
    index = (index + delta + images.length) % images.length;
    paint();
  };

  heart.addEventListener('click', async () => {
    await toggleFavorite(images[index]);
    paint();
  });

  const card = h('div', { class: 'modal-card lightbox-card' }, [
    h('div', { class: 'lightbox-stage' }, [
      figure,
      images.length > 1 && h('button', { class: 'icon-btn lightbox-nav prev', text: '‹', 'aria-label': 'Previous', onclick: () => step(-1) }),
      images.length > 1 && h('button', { class: 'icon-btn lightbox-nav next', text: '›', 'aria-label': 'Next', onclick: () => step(1) }),
    ]),
    h('div', { class: 'lightbox-side' }, [
      h('div', { class: 'row' }, [heart, downloadButton]),
      caption,
    ]),
    h('button', { class: 'icon-btn close-x', text: '✕', 'aria-label': 'Close', onclick: () => close() }),
  ]);

  const modal = h('div', { class: 'modal', onclick: (event) => { if (event.target === modal) close(); } }, [card]);

  function onKey(event) {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  }

  function close() {
    modal.remove();
    document.removeEventListener('keydown', onKey);
    render();
  }

  document.addEventListener('keydown', onKey);
  $('#modal-root').append(modal);
  paint();
}

// ---------- rendering ----------

function renderCover() {
  const { gallery } = state;
  $('#brand-title').textContent = gallery.title;
  $('#cover-title').textContent = gallery.title;
  document.title = `${gallery.title} — your gallery`;

  const cover = $('#cover-image');
  cover.hidden = !gallery.coverImageUrl;
  if (gallery.coverImageUrl) cover.src = gallery.coverImageUrl;

  const client = $('#cover-client');
  client.hidden = !gallery.clientName;
  client.textContent = gallery.clientName ? `For ${gallery.clientName}` : '';

  const description = $('#cover-description');
  description.hidden = !gallery.description;
  description.textContent = gallery.description || '';

  $('#lock-button').hidden = !gallery.unlocked;
}

function favoriteChip(fav) {
  if (fav.locked) {
    return h('div', { class: 'fav-chip locked', title: 'Enter the PIN to see this one again' }, [
      h('div', { class: 'fav-locked', text: '🔒' }),
      h('button', {
        class: 'icon-btn fav-remove',
        text: '✕',
        'aria-label': 'Remove from favourites',
        onclick: () => toggleFavorite({ id: fav.id }, false),
      }),
    ]);
  }
  return h('div', { class: 'fav-chip' }, [
    h('img', { src: fav.thumbUrl, alt: fav.title || fav.fileName || '', loading: 'lazy' }),
    h('button', {
      class: 'icon-btn fav-remove',
      text: '✕',
      'aria-label': `Remove ${fav.fileName || 'photo'} from favourites`,
      onclick: () => toggleFavorite(fav, false),
    }),
    fav.downloadable && h('button', {
      class: 'icon-btn fav-download',
      text: '⤓',
      'aria-label': `Download ${fav.fileName || 'photo'}`,
      onclick: () => download(fav),
    }),
  ]);
}

function renderFavorites() {
  const strip = $('#favorites-strip');
  strip.replaceChildren(...state.favorites.map(favoriteChip));

  const count = state.favorites.length;
  $('#favorites-count').textContent = count ? `· ${count}` : '';
  $('#top-count').textContent = String(count);
  $('#favorites-empty').hidden = count > 0;

  const send = $('#send-button');
  // Hidden entirely when the studio has not set a handoff address, rather
  // than showing a button that cannot work.
  send.hidden = !state.gallery.canHandoff || count === 0;
  if (count === 0) $('#send-status').hidden = true;
}

function renderCrumbs() {
  const crumbs = $('#crumbs');
  const path = state.folder.path;
  crumbs.hidden = path.length < 2;
  crumbs.replaceChildren(...path.flatMap((entry, index) => {
    const last = index === path.length - 1;
    const node = last
      ? h('span', { class: 'crumb current', text: entry.title, 'aria-current': 'page' })
      : h('button', { class: 'crumb', text: entry.title, onclick: () => go(entry.id) });
    return index === 0 ? [node] : [h('span', { class: 'crumb-sep', text: '/' }), node];
  }));
}

function renderFolders() {
  const cards = $('#folder-cards');
  $('#folders-head').hidden = state.folders.length === 0;
  cards.replaceChildren(...state.folders.map((folder) => h('button', {
    class: 'card',
    onclick: () => go(folder.id),
  }, [
    h('div', { class: 'card-cover' }, [
      folder.coverImageUrl
        ? h('img', { src: folder.coverImageUrl, alt: '', loading: 'lazy' })
        : h('span', { class: 'muted small', text: 'Folder' }),
    ]),
    h('div', { class: 'card-body' }, [
      h('p', { class: 'card-title', text: folder.title }),
      h('p', {
        class: 'card-meta',
        text: [
          folder.imageCount ? `${folder.imageCount} photo${folder.imageCount === 1 ? '' : 's'}` : null,
          folder.folderCount ? `${folder.folderCount} folder${folder.folderCount === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ') || 'Empty',
      }),
    ]),
  ])));
}

function renderTabs() {
  const bar = $('#tabbar');
  bar.hidden = state.tabs.length < 2;
  bar.replaceChildren(...state.tabs.map((tab) => h('button', {
    class: `tab${tab.id === state.activeTabId ? ' active' : ''}${tab.locked ? ' locked' : ''}`,
    role: 'tab',
    'aria-selected': tab.id === state.activeTabId ? 'true' : 'false',
    onclick: () => { state.activeTabId = tab.id; render(); },
  }, [
    tab.locked ? '🔒 ' : '',
    tab.title,
    h('span', { class: 'tab-count', text: String(tab.imageCount) }),
  ])));
}

function imageTile(image, tab, images) {
  const favorited = isFavorite(image.id);
  return h('figure', { class: `tile${favorited ? ' picked-ring' : ''}` }, [
    h('button', {
      class: 'tile-open',
      'aria-pressed': favorited ? 'true' : 'false',
      'aria-label': `${favorited ? 'Remove' : 'Add'} ${image.title || image.fileName || 'photo'} ${favorited ? 'from' : 'to'} favourites`,
      onclick: () => toggleFavorite(image),
    }, [
      h('img', { src: image.thumbUrl, alt: image.title || '', loading: 'lazy' }),
    ]),
    h('div', { class: 'tile-actions' }, [
      h('button', {
        class: `icon-btn${favorited ? ' on' : ''}`,
        text: favorited ? '♥' : '♡',
        'aria-hidden': 'true',
        tabindex: '-1',
        onclick: () => toggleFavorite(image),
      }),
      h('button', {
        class: 'icon-btn',
        text: '⤢',
        'aria-label': 'View larger',
        onclick: () => openLightbox(images, images.indexOf(image)),
      }),
      tab.downloadable && h('button', {
        class: 'icon-btn',
        text: '⤓',
        'aria-label': `Download ${image.fileName || 'photo'}`,
        onclick: () => download(image),
      }),
    ]),
  ]);
}

function renderGrid() {
  const grid = $('#image-grid');
  const empty = $('#grid-empty');
  const tab = state.tabs.find((entry) => entry.id === state.activeTabId);

  if (!tab) {
    grid.replaceChildren();
    empty.hidden = state.folders.length > 0;
    empty.replaceChildren(h('p', { style: 'margin:0', text: 'Nothing has been added here yet.' }));
    return;
  }

  if (tab.locked) {
    grid.replaceChildren();
    empty.hidden = false;
    empty.replaceChildren(
      h('p', { style: 'margin:0 0 8px' }, [h('strong', { text: `${tab.title} is protected` })]),
      h('p', { class: 'small', style: 'margin:0 0 16px', text: `${tab.imageCount} photo${tab.imageCount === 1 ? '' : 's'} in here. Enter the PIN your photographer gave you to see them.` }),
      h('button', { class: 'btn btn-primary', text: 'Enter PIN', onclick: unlockTab }),
    );
    return;
  }

  empty.hidden = tab.images.length > 0;
  if (!tab.images.length) {
    empty.replaceChildren(h('p', { style: 'margin:0', text: `Nothing in ${tab.title} yet.` }));
  }
  grid.replaceChildren(...tab.images.map((image) => imageTile(image, tab, tab.images)));
}

function render() {
  renderCover();
  renderFavorites();
  renderCrumbs();
  renderFolders();
  renderTabs();
  renderGrid();
}

// ---------- navigation ----------

async function go(folderId) {
  try {
    state.activeTabId = null;
    await load(folderId);
    $('#crumbs').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- start ----------

function showGone(message) {
  $('#gallery-view').hidden = true;
  const view = $('#gone-view');
  view.hidden = false;
  if (message) $('#gone-message').textContent = message;
}

async function start() {
  if (!link) return showGone('That link is missing its gallery id.');
  loadSession();

  $('#cover-scroll').addEventListener('click', () => {
    $('#favorites-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#jump-favorites').addEventListener('click', () => {
    $('#favorites-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#send-button').addEventListener('click', sendToPhotographer);
  $('#lock-button').addEventListener('click', async () => {
    await api('/lock', { method: 'POST' });
    await load(state.folder.id);
    toast('Locked again');
  });

  try {
    await load(null);
    $('#gallery-view').hidden = false;
  } catch (err) {
    showGone(err.status === 404 ? 'This link is no longer active. Ask your photographer for a new one.' : err.message);
  }
}

start();

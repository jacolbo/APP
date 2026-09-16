// Pose Board — the studio side: build folders, fill their tabs, publish, and
// read back what the client picked.

const THUMB_MAX_EDGE = 640;
const DISPLAY_MAX_EDGE = 2400;

const state = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxDepth: 20,
  folderId: null,     // null means the top-level list
  folder: null,
  path: [],
  children: [],
  tabs: [],
  activeTabId: null,
  selections: [],
  rootFolders: [],
  search: '',
  filter: 'all',
  onlyPicked: false,
  picksSort: 'count',   // count | email | recent
  picksClient: null,    // filter the grid to one client's list
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

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
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

/**
 * Draws the studio's mark across the image. Done here rather than on the
 * server because the server has no image library at all — the same canvas
 * that already makes thumbnails can burn this in on the way past.
 *
 * It is painted on the copy that gets uploaded, so it is part of the pixels,
 * not an overlay a client can remove with devtools.
 */
function drawWatermark(context, width, height, watermark) {
  const size = Math.max(14, Math.round(Math.min(width, height) * 0.045));
  context.save();
  context.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.translate(width / 2, height / 2);
  context.rotate(-Math.PI / 9);

  const step = size * 7;
  const reach = Math.hypot(width, height);
  for (let y = -reach; y < reach; y += step) {
    for (let x = -reach; x < reach; x += step * 1.6) {
      context.fillStyle = 'rgba(0, 0, 0, 0.16)';
      context.fillText(watermark, x + 1, y + 1);
      context.fillStyle = 'rgba(255, 255, 255, 0.30)';
      context.fillText(watermark, x, y);
    }
  }
  context.restore();
}

async function renderScaled(file, maxEdge, quality, watermark = '') {
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
  if (watermark) drawWatermark(context, width, height, watermark);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const source = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return { blob, width, height, source };
}

// ---------- modals ----------

function openModal(card, { onClose } = {}) {
  const backdrop = h('div', { class: 'modal' }, [card]);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  function onKey(event) { if (event.key === 'Escape') close(); }
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  return close;
}

function askText({ title, label, value = '', placeholder = '', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder });
    let close;
    const form = h('form', {
      class: 'modal-card',
      // Resolve before close(): close() triggers openModal's onClose, which
      // resolves with null, and the first settle is the one that counts.
      onsubmit: (event) => { event.preventDefault(); resolve(input.value.trim()); close(); },
    }, [
      h('h2', { text: title }),
      h('label', { class: 'field' }, [h('span', { text: label }), input]),
      h('div', { class: 'modal-actions' }, [
        h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => { resolve(null); close(); } }),
        h('button', { type: 'submit', class: 'btn btn-primary', text: confirmText }),
      ]),
    ]);
    close = openModal(form, { onClose: () => resolve(null) });
    input.focus();
    input.select();
  });
}

function confirmAction({ title, message, confirmText = 'Delete' }) {
  return new Promise((resolve) => {
    let close;
    const card = h('div', { class: 'modal-card' }, [
      h('h2', { text: title }),
      h('p', { class: 'hint', style: 'margin-bottom:6px', text: message }),
      h('div', { class: 'modal-actions' }, [
        h('button', { class: 'btn', text: 'Cancel', onclick: () => { resolve(false); close(); } }),
        h('button', { class: 'btn btn-danger', text: confirmText, onclick: () => { resolve(true); close(); } }),
      ]),
    ]);
    close = openModal(card, { onClose: () => resolve(false) });
  });
}

// ---------- loading ----------

async function loadRoot() {
  state.folderId = null;
  state.folder = null;
  const { folders } = await api('/api/folders');
  state.rootFolders = folders;
  render();
}

async function loadFolder(id) {
  const data = await api(`/api/folders/${encodeURIComponent(id)}`);
  state.folderId = id;
  state.folder = data.folder;
  state.path = data.path;
  state.children = data.folders;
  state.tabs = data.tabs;
  state.selections = data.selections;
  if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0]?.id || null;
  }
  render();
}

const refresh = () => (state.folderId ? loadFolder(state.folderId) : loadRoot());

async function go(id) {
  try {
    state.activeTabId = null;
    if (id) await loadFolder(id);
    else await loadRoot();
    window.scrollTo({ top: 0 });
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- rendering: the top-level list ----------

function folderCard(folder) {
  return h('button', { class: 'card', onclick: () => go(folder.id) }, [
    h('div', { class: 'card-cover' }, [
      folder.coverImageUrl
        ? h('img', { src: folder.coverImageUrl, alt: '', loading: 'lazy' })
        : h('span', { class: 'muted small', text: 'No cover yet' }),
    ]),
    h('div', { class: 'card-body' }, [
      h('p', { class: 'card-title', text: folder.title }),
      h('p', { class: 'card-meta' }, [
        h('span', { class: `count-dot${folder.status === 'published' ? '' : ' draft'}` }),
        `${folder.imageCount} item${folder.imageCount === 1 ? '' : 's'}`,
        folder.folderCount > 0 ? ` · ${folder.folderCount} folder${folder.folderCount === 1 ? '' : 's'}` : '',
        folder.selectionCount > 0 ? ` · ♥ ${folder.selectionCount}` : '',
      ]),
    ]),
  ]);
}

const FILTERS = {
  all: () => true,
  published: (f) => f.status === 'published',
  draft: (f) => f.status !== 'published',
  picks: (f) => f.selectionCount > 0,
};

function renderRoot() {
  const term = state.search.trim().toLowerCase();
  const visible = state.rootFolders
    .filter(FILTERS[state.filter] || FILTERS.all)
    .filter((f) => !term || `${f.title} ${f.clientName}`.toLowerCase().includes(term));

  $('#root-cards').replaceChildren(...visible.map(folderCard));
  $('#root-empty').hidden = state.rootFolders.length > 0;
  $('#folder-count').textContent = visible.length === state.rootFolders.length
    ? `${visible.length} folder${visible.length === 1 ? '' : 's'}`
    : `${visible.length} of ${state.rootFolders.length}`;
  for (const pill of document.querySelectorAll('#filter-row .pill')) {
    pill.classList.toggle('is-active', pill.dataset.filter === state.filter);
  }
}

// ---------- rendering: one folder ----------

function renderCrumbs() {
  const crumbs = $('#admin-crumbs');
  const entries = [{ id: null, title: 'All folders' }, ...state.path];
  crumbs.replaceChildren(...entries.flatMap((entry, index) => {
    const last = index === entries.length - 1;
    const node = last
      ? h('span', { class: 'crumb current', text: entry.title, 'aria-current': 'page' })
      : h('button', { class: 'crumb', text: entry.title, onclick: () => go(entry.id) });
    return index === 0 ? [node] : [h('span', { class: 'crumb-sep', text: '/' }), node];
  }));
}

function renderStats() {
  const { folder } = state;
  const host = $('#folder-stats');
  const people = new Set(state.selections.map((s) => s.clientSessionId)).size;
  host.replaceChildren(...[
    ['Views', folder.views || 0, 'page loads, not unique visitors'],
    ['Downloads', folder.downloads || 0, 'files sent to clients'],
    ['Picks', state.selections.filter((s) => s.selected !== false).length, ''],
    ['People', people, ''],
  ].map(([label, value, note]) => h('div', {}, [
    h('div', { class: 'stat-value', text: String(value) }),
    h('div', { class: 'stat-label', text: label, title: note }),
  ])));
}

function renderShare() {
  const { folder } = state;
  const url = `${location.origin}/g/${folder.slug || folder.uniqueLink}`;
  $('#share-url').value = url;
  $('#publish-toggle').checked = folder.status === 'published';

  const hints = [];
  if (folder.status !== 'published') hints.push('The link is dead until you turn this on.');
  if (!folder.hasPin && !folder.inheritsPin) hints.push('No download PIN is set, so nothing in this folder can be downloaded and PIN-only tabs stay closed.');
  else if (folder.inheritsPin) hints.push('Using the download PIN from a folder above this one.');
  if (!folder.effectiveWebhookUrl) hints.push('No handoff address is set, so the client has no "Send to photographer" button.');
  $('#share-hint').textContent = hints.join(' ');
}

function renderChildren() {
  $('#child-cards').replaceChildren(...state.children.map(folderCard));
  $('#child-empty').hidden = state.children.length > 0;
  $('#child-empty').textContent = 'No folders inside this one yet.';
  $('#rail-subfolders').replaceChildren(...state.children.map((folder) => h('button', {
    class: 'rail-subfolder',
    type: 'button',
    onclick: () => go(folder.id),
  }, [
    h('span', { class: `count-dot${folder.status === 'published' ? '' : ' draft'}` }),
    folder.title,
  ])));
}

function renderTabs() {
  const bar = $('#admin-tabbar');
  bar.replaceChildren(...state.tabs.map((tab) => h('button', {
    class: `tab${tab.id === state.activeTabId ? ' active' : ''}`,
    role: 'tab',
    'aria-selected': tab.id === state.activeTabId ? 'true' : 'false',
    onclick: () => { state.activeTabId = tab.id; render(); },
  }, [
    tab.access === 'pin' ? '🔒 ' : '',
    tab.title,
    h('span', { class: 'tab-count', text: String(tab.images.length) }),
  ])));

  const tab = activeTab();
  if (!tab) { $('#tab-panel').hidden = true; return; }

  $('#tab-title').value = tab.title;
  $('#tab-access').value = tab.access;
  $('#tab-downloadable').checked = Boolean(tab.downloadable);
  $('#upload-target').textContent = tab.title;

  const warning = $('#tab-warning');
  const noPin = !state.folder.hasPin && !state.folder.inheritsPin;
  $('#delete-tab').disabled = state.tabs.length > 1
    && tab.access === 'open'
    && state.tabs.filter((entry) => entry.access === 'open').length === 1;
  if (noPin && tab.access === 'pin') {
    warning.textContent = 'No download PIN is set, so this tab can never be opened by a client. Set one in Settings.';
    warning.hidden = false;
  } else if (noPin && tab.downloadable) {
    warning.textContent = 'Downloads always ask for the PIN, and none is set — set one in Settings or clients cannot download.';
    warning.hidden = false;
  } else if (tab.access === 'pin') {
    warning.textContent = 'These images are left out of the page entirely until the client enters the PIN.';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }
}

const activeTab = () => state.tabs.find((tab) => tab.id === state.activeTabId) || null;

function imageTile(image, images) {
  const picks = state.selections.filter((s) => s.imageId === image.id);
  const isCover = state.folder.coverImageId === image.id;

  const tile = h('figure', {
    class: `tile${picks.length ? ' picked-ring' : ''}`,
    draggable: 'true',
    dataset: { id: image.id },
  }, [
    h('button', {
      class: 'tile-open',
      'aria-label': `Open ${image.title || image.fileName || 'image'}`,
      onclick: () => openImageEditor(image, images),
    }, [h('img', { src: image.thumbUrl, alt: image.title || '', loading: 'lazy' })]),
    h('div', { class: 'tile-actions' }, [
      h('button', {
        class: `icon-btn${isCover ? ' on' : ''}`,
        text: '★',
        title: isCover ? 'This is the folder cover' : 'Use as the folder cover',
        onclick: () => setCover(isCover ? null : image.id),
      }),
      h('button', {
        class: 'icon-btn btn-danger',
        text: '✕',
        title: 'Delete this image',
        onclick: () => deleteImage(image),
      }),
    ]),
    (picks.length || image.title) && h('figcaption', { class: 'tile-caption' }, [
      picks.length ? h('span', { class: 'badge', text: `♥ ${picks.length}` }) : null,
      image.title ? h('span', { class: 'small', text: image.title }) : null,
    ]),
  ]);

  tile.addEventListener('dragstart', (event) => {
    tile.classList.add('dragging');
    event.dataTransfer.setData('text/plain', image.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
  tile.addEventListener('dragover', (event) => { event.preventDefault(); tile.classList.add('drop-target'); });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-target'));
  tile.addEventListener('drop', async (event) => {
    event.preventDefault();
    tile.classList.remove('drop-target');
    const draggedId = event.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === image.id) return;
    const ids = images.map((entry) => entry.id).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(image.id), 0, draggedId);
    try {
      await api(`/api/tabs/${state.activeTabId}/order`, { method: 'POST', body: { ids } });
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  return tile;
}

function renderGrid() {
  const tab = activeTab();
  const grid = $('#admin-grid');
  const empty = $('#grid-empty');
  if (!tab) {
    grid.replaceChildren();
    empty.hidden = true;
    $('#image-count').textContent = '';
    return;
  }

  const relevant = state.picksClient
    ? state.selections.filter((s) => s.clientSessionId === state.picksClient && s.selected !== false)
    : state.selections.filter((s) => s.selected !== false);
  const pickedIds = new Set(relevant.map((s) => s.imageId));
  const images = state.onlyPicked ? tab.images.filter((image) => pickedIds.has(image.id)) : tab.images;

  $('#image-count').textContent = tab.images.length ? `· ${tab.images.length}` : '';
  grid.replaceChildren(...images.map((image) => imageTile(image, tab.images)));
  empty.hidden = images.length > 0;
}

function renderSelections() {
  const panel = $('#selections-panel');
  panel.hidden = state.selections.length === 0;
  if (!state.selections.length) return;

  // One row per person, which is how a studio reads this: whose list, how
  // many photos, and something to click.
  const lists = new Map();
  for (const selection of state.selections) {
    if (selection.selected === false) continue;
    if (!lists.has(selection.clientSessionId)) {
      lists.set(selection.clientSessionId, {
        sessionId: selection.clientSessionId,
        name: selection.clientName || '',
        email: selection.clientEmail || '',
        picks: [],
        last: selection.createdAt,
      });
    }
    const list = lists.get(selection.clientSessionId);
    list.picks.push(selection);
    if (selection.createdAt > list.last) list.last = selection.createdAt;
    if (!list.name && selection.clientName) list.name = selection.clientName;
    if (!list.email && selection.clientEmail) list.email = selection.clientEmail;
  }

  const sorters = {
    count: (a, b) => b.picks.length - a.picks.length,
    email: (a, b) => (a.email || a.name || 'zz').localeCompare(b.email || b.name || 'zz'),
    recent: (a, b) => b.last.localeCompare(a.last),
  };
  const rows = [...lists.values()].sort(sorters[state.picksSort] || sorters.count);

  const coverFor = (list) => {
    for (const pick of list.picks) {
      for (const tab of state.tabs) {
        const image = tab.images.find((entry) => entry.id === pick.imageId);
        if (image) return image.thumbUrl;
      }
    }
    return null;
  };

  $('#picks-count').textContent = `${rows.length} list${rows.length === 1 ? '' : 's'}`;
  $('#picks-copy-all').onclick = () => copyText(
    pickedNames(state.selections.filter((entry) => entry.selected !== false)),
    'All picked file names',
  );
  $('#picks-sort').value = state.picksSort;

  $('#selections-summary').replaceChildren(
    h('div', { class: 'picks-row picks-head' }, [
      h('span', {}, ['Favourite list']),
      h('span', {}, ['']),
      h('span', { class: 'picks-num' }, ['Photos']),
      h('span', {}, ['']),
    ]),
    ...rows.map((list) => {
      const active = state.picksClient === list.sessionId;
      const cover = coverFor(list);
      return h('div', { class: `picks-row${active ? ' is-active' : ''}` }, [
        h('span', { class: 'picks-who' }, [
          h('strong', { text: list.name || list.email || 'Unnamed visitor' }),
          h('span', { class: 'muted small', text: list.email && list.name ? list.email : `id ${list.sessionId.slice(0, 8)}` }),
        ]),
        h('span', { class: 'picks-cover' }, [
          cover ? h('img', { src: cover, alt: '', loading: 'lazy' }) : '',
        ]),
        h('span', { class: 'picks-num', text: String(list.picks.length) }),
        h('span', { class: 'row' }, [
          h('button', {
            class: `btn btn-sm${active ? ' btn-primary' : ''}`,
            text: active ? 'Showing' : 'Show picks',
            onclick: () => {
              state.picksClient = active ? null : list.sessionId;
              state.onlyPicked = Boolean(state.picksClient);
              $('#only-picked').checked = state.onlyPicked;
              renderGrid();
              renderSelections();
            },
          }),
          h('button', {
            class: 'btn btn-sm',
            text: 'Copy names',
            title: 'Comma-separated file names, ready to paste into Lightroom',
            onclick: () => copyText(pickedNames(list.picks), `${list.picks.length} file names`),
          }),
          h('a', {
            class: 'btn btn-sm',
            href: `/api/folders/${state.folderId}/picks/${encodeURIComponent(list.sessionId)}/zip`,
            text: 'Download',
          }),
        ]),
      ]);
    }),
  );
}

function shortName(imageId) {
  for (const tab of state.tabs) {
    const image = tab.images.find((entry) => entry.id === imageId);
    if (image) return image.title || image.fileName || imageId.slice(0, 10);
  }
  return imageId.slice(0, 10);
}

function renderFolder() {
  const { folder } = state;
  $('#folder-title').textContent = folder.title;
  // "level 1 of 20" is a fact about the data model, not about the shoot. It
  // only earns a place once a folder is actually nested.
  $('#folder-subtitle').textContent = [
    folder.clientName,
    folder.depth > 1 ? `${folder.depth} levels in` : '',
    folder.description,
  ].filter(Boolean).join(' · ');
  $('#folder-subtitle').title = folder.description || '';

  const badge = $('#folder-status');
  const expired = folder.expired;
  badge.textContent = expired ? 'Expired' : folder.status === 'published' ? 'Live' : 'Draft';
  badge.className = `badge${expired ? ' warn' : folder.status === 'published' ? ' live' : ''}`;

  $('#rail-title').textContent = folder.title;
  $('#rail-cover').replaceChildren(
    folder.coverImageUrl ? h('img', { src: folder.coverImageUrl, alt: '' }) : '',
  );
  $('#preview-link').href = `${location.origin}/g/${folder.uniqueLink}`;

  $('#picks-csv').href = `/api/folders/${folder.id}/picks.csv`;

  renderCrumbs();
  renderStats();
  renderShare();
  renderChildren();
  renderTabs();
  renderGrid();
  renderSelections();
}

function render() {
  const inFolder = Boolean(state.folderId);
  $('#root-view').hidden = inFolder;
  $('#folder-view').hidden = !inFolder;
  $('#rail-folder').hidden = !inFolder;
  $('#nav-home').classList.toggle('is-active', !inFolder);
  if (inFolder) renderFolder();
  else renderRoot();
}

// ---------- actions ----------

async function createFolder(parentId) {
  const title = await askText({
    title: parentId ? 'New folder inside this one' : 'New folder',
    label: 'Name',
    placeholder: 'Smith Wedding',
    confirmText: 'Create',
  });
  if (!title) return;
  try {
    const { folder } = await api('/api/folders', { method: 'POST', body: { title, parentId } });
    toast('Folder created');
    await go(folder.id);
  } catch (err) {
    toast(err.message, true);
  }
}

async function patchFolder(body, message) {
  try {
    await api(`/api/folders/${state.folderId}`, { method: 'PATCH', body });
    await refresh();
    if (message) toast(message);
  } catch (err) {
    toast(err.message, true);
    await refresh();
  }
}

const setCover = (imageId) => patchFolder({ coverImageId: imageId }, imageId ? 'Cover set' : 'Cover cleared');

async function deleteImage(image) {
  const ok = await confirmAction({
    title: 'Delete this image?',
    message: 'It is removed from the gallery and the file is deleted from disk. This cannot be undone.',
  });
  if (!ok) return;
  try {
    await api(`/api/images/${image.id}`, { method: 'DELETE' });
    await refresh();
    toast('Image deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

function openImageEditor(image, images) {
  const index = images.indexOf(image);
  const title = h('input', { type: 'text', value: image.title || '', placeholder: 'Hands in pockets, looking away' });
  const notes = h('textarea', { placeholder: 'Notes for the shoot' }, [image.notes || '']);
  const preview = h('img', { src: image.url, alt: '' });
  let close;

  const save = async () => {
    try {
      await api(`/api/images/${image.id}`, {
        method: 'PATCH',
        body: { title: title.value, notes: notes.value },
      });
      close();
      await refresh();
      toast('Saved');
    } catch (err) {
      toast(err.message, true);
    }
  };

  const card = h('div', { class: 'modal-card lightbox-card' }, [
    h('div', { class: 'lightbox-stage' }, [preview]),
    h('div', { class: 'lightbox-side stack' }, [
      h('p', { class: 'muted small', style: 'margin:0', text: `${index + 1} of ${images.length}${image.fileName ? ` · ${image.fileName}` : ''}` }),
      h('label', { class: 'field' }, [h('span', { text: 'Title' }), title]),
      h('label', { class: 'field' }, [h('span', { text: 'Notes' }), notes]),
      h('div', { class: 'row' }, [
        h('button', { class: 'btn btn-sm btn-primary', text: 'Save', onclick: save }),
        h('button', { class: 'btn btn-sm', text: 'Use as cover', onclick: () => { close(); setCover(image.id); } }),
      ]),
    ]),
    h('button', { class: 'icon-btn close-x', text: '✕', 'aria-label': 'Close', onclick: () => close() }),
  ]);
  close = openModal(card);
}

/**
 * The picked files as a bare, comma-separated list of names without
 * extensions — "_MG_1613, _MG_1621, …" — which is what a filename filter in
 * Lightroom or Capture One expects pasted into it.
 *
 * Order is the order they were picked, not sorted: that is the order the
 * client worked through them, and re-sorting loses it. Repeated names are
 * dropped, since a filter gains nothing from seeing one twice.
 */
function pickedNames(selections) {
  const seen = new Set();
  const names = [];
  for (const selection of [...selections].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const bare = String(selection.fileName || '').replace(/\.[^.]+$/, '').trim();
    const name = bare || selection.imageId;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(', ');
}

async function copyText(value, what) {
  if (!value) {
    toast('Nothing to copy', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(`${what} copied`);
  } catch {
    // Clipboard access can be refused; show it so it can be copied by hand.
    await askText({
      title: what,
      label: 'Select all, then copy',
      value,
      confirmText: 'Done',
    });
  }
}

/** An On/Off row: what it controls on the left, its state on the right. */
function toggleRow(label, help, checked) {
  const input = h('input', { type: 'checkbox', checked: checked ? true : undefined });
  const row = h('label', { class: 'toggle-row' }, [
    h('span', {}, [
      h('span', { class: 'toggle-label', text: label }),
      help ? h('span', { class: 'toggle-help', text: help }) : null,
    ]),
    h('span', { class: 'toggle-state' }, [input, h('span', { class: 'toggle-word' })]),
  ]);
  const paint = () => { row.querySelector('.toggle-word').textContent = input.checked ? 'On' : 'Off'; };
  input.addEventListener('change', paint);
  paint();
  return { row, input };
}

function openSettings() {
  const { folder } = state;
  const title = h('input', { type: 'text', value: folder.title });
  const clientName = h('input', { type: 'text', value: folder.clientName || '', placeholder: 'Ana & Tom' });
  const description = h('textarea', { placeholder: 'A note shown at the top of your client’s gallery' }, [folder.description || '']);
  const pin = h('input', { type: 'text', inputmode: 'numeric', placeholder: folder.hasPin ? 'Set — type a new one to change it' : '4–12 digits' });
  const pinMax = h('input', {
    type: 'number', min: '1', max: '10000',
    value: folder.pinMaxUses === null ? '' : String(folder.pinMaxUses),
    placeholder: 'No limit',
  });
  const webhook = h('input', { type: 'text', value: folder.webhookUrl || '', placeholder: 'https://studio.example.com/hooks/selection' });
  const brandColor = h('input', { type: 'color', value: folder.brandColor || '#9a6640', style: 'height:42px; padding:4px' });
  const watermark = h('input', { type: 'text', value: folder.watermarkText || '', placeholder: 'Your Studio Name' });
  const expiresAt = h('input', {
    type: 'date',
    value: folder.expiresAt ? folder.expiresAt.slice(0, 10) : '',
  });
  const slug = h('input', { type: 'text', value: folder.slug || '', placeholder: 'smith-wedding' });
  const downloads = toggleRow('Download', 'Let clients save photos. The PIN is still asked for.', folder.downloadsEnabled);
  const favourites = toggleRow('Favourites', 'Let clients heart photos and send you a shortlist.', folder.favouritesEnabled);
  const slideshow = toggleRow('Slideshow', 'Let clients play the gallery full screen.', folder.slideshowEnabled);
  const sharing = toggleRow('Sharing', 'Let clients pass the gallery or their picks on.', folder.sharingEnabled);
  const logoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true });
  const logoPreview = h('img', {
    src: folder.logoUrl || '',
    alt: '',
    hidden: !folder.logoUrl,
    style: 'height:34px; width:auto; max-width:150px; object-fit:contain',
  });

  logoInput.addEventListener('change', async () => {
    const file = logoInput.files[0];
    if (!file) return;
    try {
      await uploadBinary(`/api/folders/${folder.id}/logo`, file, { 'content-type': file.type });
      toast('Logo uploaded');
      close();
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  let close;

  const save = async () => {
    const body = {
      title: title.value,
      clientName: clientName.value,
      description: description.value,
      webhookUrl: webhook.value.trim(),
    };
    // Left blank means "leave it alone"; the Clear button is how you remove it.
    if (pin.value.trim()) body.downloadPin = pin.value.trim();
    body.downloadPinMaxUses = pinMax.value.trim() ? Number(pinMax.value.trim()) : null;
    body.brandColor = brandColor.value;
    body.watermarkText = watermark.value.trim();
    // A date alone means end of that day, not midnight at its start.
    body.expiresAt = expiresAt.value ? `${expiresAt.value}T23:59:59` : '';
    body.slug = slug.value.trim();
    body.downloadsEnabled = downloads.input.checked;
    body.favouritesEnabled = favourites.input.checked;
    body.slideshowEnabled = slideshow.input.checked;
    body.sharingEnabled = sharing.input.checked;
    try {
      await api(`/api/folders/${folder.id}`, { method: 'PATCH', body });
      close();
      await refresh();
      toast('Settings saved');
    } catch (err) {
      toast(err.message, true);
    }
  };

  const card = h('div', { class: 'modal-card' }, [
    h('h2', { text: 'Folder settings' }),
    h('p', { class: 'settings-head', text: 'General' }),
    h('label', { class: 'field' }, [h('span', { text: 'Name' }), title]),
    h('label', { class: 'field' }, [h('span', { text: 'Client name' }), clientName]),
    h('label', { class: 'field' }, [h('span', { text: 'Intro note' }), description]),
    h('label', { class: 'field' }, [h('span', { text: 'Gallery address' }), slug]),
    h('p', { class: 'hint', text: `Clients open ${location.origin}/g/… — put a word here instead of the random code. Blank keeps the code.` }),

    h('p', { class: 'settings-head', text: 'What clients can do' }),
    downloads.row,
    favourites.row,
    slideshow.row,
    sharing.row,

    h('p', { class: 'settings-head', text: 'Privacy' }),
    h('label', { class: 'field' }, [h('span', { text: 'Download PIN' }), pin]),
    h('p', { class: 'hint', text: folder.inheritsPin
      ? 'Blank means this folder keeps using the PIN from a folder above it.'
      : 'Clients type this before they can download, or open a PIN-only tab. Nothing downloads without one.' }),
    h('label', { class: 'field' }, [h('span', { text: 'Limit how many times the PIN can be used' }), pinMax]),
    h('p', { class: 'hint' }, [
      folder.hasPin
        ? `Used ${folder.pinUses} time${folder.pinUses === 1 ? '' : 's'} so far${folder.pinMaxUses === null ? '' : ` of ${folder.pinMaxUses}`}. `
        : '',
      'Blank means no limit. Useful if you would rather a PIN did not get passed around. Setting a new PIN resets the count.',
      folder.pinUses > 0 && h('button', {
        type: 'button',
        class: 'btn btn-sm',
        style: 'margin-left:8px',
        text: 'Reset count',
        onclick: async () => { close(); await patchFolder({ resetPinUses: true }, 'Use count reset'); },
      }),
    ]),
    h('label', { class: 'field' }, [h('span', { text: 'Send selections to (webhook URL)' }), webhook]),
    h('p', { class: 'hint', text: 'Where "Send to photographer" POSTs the shortlist. Blank uses the WEBHOOK_URL the server was started with, if any.' }),

    h('p', { class: 'settings-head', text: 'How it looks' }),
    h('label', { class: 'field' }, [h('span', { text: 'Accent colour' }), brandColor]),
    h('div', { class: 'field' }, [
      h('span', { text: 'Your logo' }),
      h('div', { class: 'row' }, [
        logoPreview,
        h('button', { type: 'button', class: 'btn btn-sm', text: folder.logoUrl ? 'Replace' : 'Upload logo', onclick: () => logoInput.click() }),
        folder.logoUrl && h('button', {
          type: 'button', class: 'btn btn-sm btn-danger', text: 'Remove',
          onclick: async () => {
            close();
            try {
              await api(`/api/folders/${folder.id}/logo`, { method: 'DELETE' });
              await refresh();
              toast('Logo removed');
            } catch (err) { toast(err.message, true); }
          },
        }),
        logoInput,
      ]),
    ]),
    h('label', { class: 'field' }, [h('span', { text: 'Watermark on preview tabs' }), watermark]),
    h('p', { class: 'hint', text: 'Burned into images as they upload, on tabs clients cannot download. Deliverable tabs stay clean. Only affects new uploads.' }),
    h('label', { class: 'field' }, [h('span', { text: 'Gallery closes on' }), expiresAt]),
    h('p', { class: 'hint', text: 'After this date the link stops working and your software is told. Leave blank to keep it open forever.' }),
    h('div', { class: 'modal-actions' }, [
      folder.hasPin && h('button', {
        class: 'btn btn-sm',
        text: 'Clear PIN',
        onclick: async () => { close(); await patchFolder({ downloadPin: '' }, 'PIN cleared'); },
      }),
      h('button', {
        class: 'btn btn-sm',
        text: 'Duplicate',
        title: 'Copy the tabs and settings, without the photos',
        onclick: async () => {
          close();
          try {
            const { folder: copy } = await api(`/api/folders/${folder.id}/duplicate`, { method: 'POST' });
            toast('Duplicated — photos not copied');
            await go(copy.id);
          } catch (err) { toast(err.message, true); }
        },
      }),
      h('button', {
        class: 'btn btn-sm',
        text: 'Reset share link',
        onclick: async () => {
          close();
          const ok = await confirmAction({
            title: 'Reset the share link?',
            message: 'The old link stops working immediately for everyone who has it.',
            confirmText: 'Reset link',
          });
          if (!ok) return;
          try {
            await api(`/api/folders/${folder.id}/relink`, { method: 'POST' });
            await refresh();
            toast('New link issued');
          } catch (err) { toast(err.message, true); }
        },
      }),
      h('button', {
        class: 'btn btn-sm btn-danger',
        text: 'Delete folder',
        onclick: async () => {
          close();
          const ok = await confirmAction({
            title: `Delete "${folder.title}"?`,
            message: 'Everything inside it — folders, tabs, images and client picks — is deleted, and the files are removed from disk.',
          });
          if (!ok) return;
          try {
            await api(`/api/folders/${folder.id}`, { method: 'DELETE' });
            toast('Folder deleted');
            await go(folder.parentId);
          } catch (err) { toast(err.message, true); }
        },
      }),
      h('button', { class: 'btn btn-primary btn-sm', text: 'Save', onclick: save }),
    ]),
  ]);
  close = openModal(card);
  title.focus();
}

async function createTab() {
  const title = await askText({ title: 'New tab', label: 'Name', placeholder: 'Retouched', confirmText: 'Create' });
  if (!title) return;
  try {
    const { tab } = await api(`/api/folders/${state.folderId}/tabs`, { method: 'POST', body: { title } });
    state.activeTabId = tab.id;
    await refresh();
    toast('Tab created');
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveTab() {
  const tab = activeTab();
  if (!tab) return;
  try {
    await api(`/api/tabs/${tab.id}`, {
      method: 'PATCH',
      body: {
        title: $('#tab-title').value,
        access: $('#tab-access').value,
        downloadable: $('#tab-downloadable').checked,
      },
    });
    await refresh();
    toast('Tab saved');
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteTab() {
  const tab = activeTab();
  if (!tab) return;
  const ok = await confirmAction({
    title: `Delete the "${tab.title}" tab?`,
    message: `${tab.images.length} image${tab.images.length === 1 ? '' : 's'} in it will be deleted from disk too.`,
  });
  if (!ok) return;
  try {
    await api(`/api/tabs/${tab.id}`, { method: 'DELETE' });
    state.activeTabId = null;
    await refresh();
    toast('Tab deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- uploading ----------

async function uploadOne(file, onProgress) {
  let body = file;
  let type = file.type;
  let dimensions = null;

  // Deliverables stay clean: the mark goes on tabs the client browses, never
  // on the ones they pay to download.
  const tab = activeTab();
  const watermark = (!tab || tab.downloadable) ? '' : (state.folder.watermarkText || '');

  if (watermark) {
    const marked = await renderScaled(file, DISPLAY_MAX_EDGE, 0.88, watermark).catch(() => null);
    if (!marked?.blob) throw new Error('could not be watermarked in the browser');
    body = marked.blob;
    type = 'image/jpeg';
    dimensions = { width: marked.width, height: marked.height };
  }

  // The studio resizes before uploading, but anything still over the limit is
  // scaled in the browser so an upload straight off a phone does not bounce.
  if (!watermark && file.size > state.maxUploadBytes) {
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
  const { image } = await uploadBinary(
    `/api/tabs/${state.activeTabId}/images${query}`,
    body,
    {
      'content-type': type || 'image/jpeg',
      'x-filename': file.name.replace(/[^\x20-\x7E]/g, '_').slice(0, 120),
    },
    onProgress,
  );

  if (thumb?.blob) {
    await uploadBinary(`/api/images/${image.id}/thumbnail`, thumb.blob, { 'content-type': 'image/jpeg' })
      .catch(() => { /* the full image is used as its own thumbnail */ });
  }
  return image;
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  if (!state.activeTabId) {
    toast('Make a tab first, then drop images into it', true);
    return;
  }

  const bar = $('#upload-progress');
  const fill = bar.querySelector('i');
  const hint = $('#upload-hint');
  bar.hidden = false;

  const failures = [];
  for (const [index, file] of files.entries()) {
    hint.textContent = `Uploading ${index + 1} of ${files.length} — ${file.name}`;
    try {
      await uploadOne(file, (fraction) => {
        fill.style.width = `${Math.round(((index + fraction) / files.length) * 100)}%`;
      });
    } catch (err) {
      failures.push(`${file.name}: ${err.message}`);
    }
  }

  fill.style.width = '100%';
  setTimeout(() => { bar.hidden = true; fill.style.width = '0%'; }, 400);
  hint.textContent = failures.length ? failures.join(' · ') : '';
  await refresh();
  if (failures.length) toast(`${failures.length} file${failures.length === 1 ? '' : 's'} did not upload`, true);
  else toast(`${files.length} image${files.length === 1 ? '' : 's'} added`);
}

// ---------- importing from google drive ----------

/**
 * Pulls one Drive original through the server, scales it here, and stores only
 * the scaled copy.
 *
 * The original deliberately never lands on the server's disk — the image row
 * keeps the Drive id instead, and the full-resolution file is fetched again
 * only when a client passes the PIN and downloads. That is the whole point of
 * pointing the gallery at Drive rather than copying Drive into it.
 */
async function importOne(driveFile, onProgress) {
  const response = await fetch(`/api/drive/files/${encodeURIComponent(driveFile.id)}/content`, {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Drive returned ${response.status}`);
  }
  const blob = await response.blob();

  // Same rule as a dragged-in file: the mark goes on tabs the client browses,
  // never on the ones they pay to download.
  const tab = activeTab();
  const watermark = (!tab || tab.downloadable) ? '' : (state.folder.watermarkText || '');

  // Unlike uploadOne, this always scales. Storing the Drive original here
  // would defeat the point and double the storage.
  const scaled = await renderScaled(blob, DISPLAY_MAX_EDGE, watermark ? 0.88 : 0.86, watermark)
    .catch(() => null);
  if (!scaled?.blob) throw new Error('could not be read as an image in the browser');

  const thumb = await renderScaled(blob, THUMB_MAX_EDGE, 0.82).catch(() => null);

  const query = `?w=${scaled.width}&h=${scaled.height}&driveId=${encodeURIComponent(driveFile.id)}`;
  const { image } = await uploadBinary(
    `/api/tabs/${state.activeTabId}/images${query}`,
    scaled.blob,
    {
      'content-type': 'image/jpeg',
      'x-filename': driveFile.name.replace(/[^\x20-\x7E]/g, '_').slice(0, 120),
    },
    onProgress,
  );

  if (thumb?.blob) {
    await uploadBinary(`/api/images/${image.id}/thumbnail`, thumb.blob, { 'content-type': 'image/jpeg' })
      .catch(() => { /* the scaled image doubles as its own thumbnail */ });
  }
  return image;
}

async function importFiles(driveFiles) {
  const bar = $('#upload-progress');
  const fill = bar.querySelector('i');
  const hint = $('#upload-hint');
  bar.hidden = false;

  const failures = [];
  for (const [index, file] of driveFiles.entries()) {
    hint.textContent = `Importing ${index + 1} of ${driveFiles.length} — ${file.name}`;
    try {
      await importOne(file, (fraction) => {
        fill.style.width = `${Math.round(((index + fraction) / driveFiles.length) * 100)}%`;
      });
    } catch (err) {
      failures.push(`${file.name}: ${err.message}`);
    }
  }

  fill.style.width = '100%';
  setTimeout(() => { bar.hidden = true; fill.style.width = '0%'; }, 400);
  hint.textContent = failures.length ? failures.join(' · ') : '';
  await refresh();

  const done = driveFiles.length - failures.length;
  if (failures.length) toast(`${done} imported, ${failures.length} failed`, true);
  else toast(`${done} photo${done === 1 ? '' : 's'} imported from Drive`);
}

function bytes(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function openDriveImport() {
  if (!state.activeTabId) {
    toast('Open a tab first, then import into it', true);
    return;
  }

  const status = await api('/api/drive/status').catch(() => ({ configured: false }));
  if (!status.configured) {
    let closeSetup;
    const setupCard = h('div', { class: 'modal-card' }, [
      h('h2', { text: 'Google Drive is not set up' }),
      h('p', {
        class: 'hint',
        text: 'This server has no Google service account key, so it cannot read your Drive. DRIVE.md in the project has the one-time setup.',
      }),
      h('div', { class: 'modal-actions' }, [
        h('button', { class: 'btn btn-primary', text: 'Close', onclick: () => closeSetup() }),
      ]),
    ]);
    closeSetup = openModal(setupCard);
    return;
  }

  const input = h('input', {
    type: 'text',
    id: 'drive-folder',
    placeholder: 'https://drive.google.com/drive/folders/…',
  });
  const results = h('div', { class: 'drive-results', id: 'drive-results' });
  const note = h('p', { class: 'hint', id: 'drive-note' });
  const importBtn = h('button', {
    class: 'btn btn-primary', id: 'drive-import', text: 'Import selected', disabled: true,
  });

  let listed = [];
  let close;

  const selectedFiles = () => listed.filter((file) => file.checked);

  const refreshButton = () => {
    const n = selectedFiles().length;
    importBtn.disabled = n === 0;
    importBtn.textContent = n ? `Import ${n} photo${n === 1 ? '' : 's'}` : 'Import selected';
  };

  const lookUp = async () => {
    const folder = input.value.trim();
    if (!folder) return;
    note.textContent = 'Looking…';
    results.replaceChildren();
    try {
      const found = await api('/api/drive/list', { method: 'POST', body: { folder } });
      listed = found.files.map((file) => ({ ...file, checked: true }));

      if (!listed.length) {
        note.textContent = found.subfolders.length
          ? 'No photos directly in that folder — it only holds sub-folders. Open one in Drive and paste its link instead.'
          : 'That folder has no photos in it.';
        refreshButton();
        return;
      }

      note.textContent = found.subfolders.length
        ? `${listed.length} photos. ${found.subfolders.length} sub-folder(s) were skipped — import those separately.`
        : `${listed.length} photos.`;

      results.append(
        h('label', { class: 'drive-row drive-all' }, [
          h('input', {
            type: 'checkbox',
            checked: true,
            onchange: (event) => {
              for (const file of listed) file.checked = event.target.checked;
              for (const box of results.querySelectorAll('.drive-row:not(.drive-all) input')) {
                box.checked = event.target.checked;
              }
              refreshButton();
            },
          }),
          h('span', { text: 'Select all' }),
        ]),
        ...listed.map((file) => h('label', { class: 'drive-row' }, [
          h('input', {
            type: 'checkbox',
            checked: true,
            onchange: (event) => { file.checked = event.target.checked; refreshButton(); },
          }),
          h('span', { class: 'drive-name', text: file.name }),
          h('span', { class: 'muted small', text: bytes(file.size) }),
        ])),
      );
      refreshButton();
    } catch (err) {
      note.textContent = err.message;
      listed = [];
      refreshButton();
    }
  };

  const card = h('div', { class: 'modal-card drive-card' }, [
    h('h2', { text: 'Import from Google Drive' }),
    h('p', {
      class: 'hint',
      text: 'Paste the link to a Drive folder. Previews are stored here; the full-resolution files stay in Drive and are fetched only when a client downloads.',
    }),
    h('div', { class: 'share-link', style: 'margin-bottom:12px' }, [
      input,
      h('button', { class: 'btn btn-sm', text: 'Look up', onclick: lookUp }),
    ]),
    note,
    results,
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn', text: 'Cancel', onclick: () => close() }),
      importBtn,
    ]),
  ]);

  importBtn.addEventListener('click', async () => {
    const files = selectedFiles();
    close();
    await importFiles(files);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); lookUp(); }
  });

  close = openModal(card);
  input.focus();
}

// ---------- sign in ----------

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

async function start() {
  const session = await api('/api/session');
  state.maxUploadBytes = (session.maxUploadMb || 25) * 1024 * 1024;
  state.maxDepth = session.maxDepth || 20;
  $('#upload-hint').textContent = `JPEG, PNG, WebP, GIF, AVIF or HEIC · up to ${session.maxUploadMb} MB each`;
  $('#login-default-warning').hidden = !session.usingDefaultPassword;
  $('#default-password-banner').hidden = !session.usingDefaultPassword;

  if (!session.authed) return showLogin();
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await loadRoot();
}

// ---------- wiring ----------

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#login-error');
  error.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    await start();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

$('#nav-home').addEventListener('click', () => go(null));
$('#new-folder').addEventListener('click', () => createFolder(state.folderId));
$('#empty-new-folder').addEventListener('click', () => createFolder(null));
$('#new-subfolder').addEventListener('click', () => createFolder(state.folderId));
$('#folder-settings').addEventListener('click', openSettings);
$('#new-tab').addEventListener('click', createTab);
$('#save-tab').addEventListener('click', saveTab);
$('#delete-tab').addEventListener('click', deleteTab);
$('#download-tab').addEventListener('click', () => {
  const tab = activeTab();
  if (tab) location.href = `/api/tabs/${tab.id}/images.zip`;
});

$('#back-btn').addEventListener('click', () => go(state.folder?.parentId || null));
$('#share-open').addEventListener('click', async () => {
  $('#share-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (state.folder?.status !== 'published') {
    toast('Turn on "Gallery is live" first, then the link works', true);
    return;
  }
  try {
    await navigator.clipboard.writeText($('#share-url').value);
    toast('Link copied');
  } catch {
    $('#share-url').select();
    toast('Press ⌘C / Ctrl+C to copy');
  }
});
$('#tab-settings-toggle').addEventListener('click', () => {
  const panel = $('#tab-panel');
  panel.hidden = !panel.hidden;
});
for (const pill of document.querySelectorAll('#filter-row .pill')) {
  pill.addEventListener('click', () => {
    state.filter = pill.dataset.filter;
    renderRoot();
  });
}

$('#folder-search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderRoot();
});

$('#only-picked').addEventListener('change', (event) => {
  state.onlyPicked = event.target.checked;
  if (!state.onlyPicked) state.picksClient = null;
  renderGrid();
  renderSelections();
});

$('#picks-sort').addEventListener('change', (event) => {
  state.picksSort = event.target.value;
  renderSelections();
});

$('#publish-toggle').addEventListener('change', (event) => {
  patchFolder(
    { status: event.target.checked ? 'published' : 'draft' },
    event.target.checked ? 'Gallery is live' : 'Gallery taken offline',
  );
});

$('#copy-share').addEventListener('click', async () => {
  const url = $('#share-url').value;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    $('#share-url').select();
    toast('Press ⌘C / Ctrl+C to copy');
  }
});

$('#pick-files').addEventListener('click', () => $('#file-input').click());
$('#drive-open').addEventListener('click', openDriveImport);
$('#file-input').addEventListener('change', (event) => {
  uploadFiles(event.target.files);
  event.target.value = '';
});

const dropzone = $('#dropzone');
for (const name of ['dragenter', 'dragover']) {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add('hot');
  });
}
for (const name of ['dragleave', 'drop']) {
  dropzone.addEventListener(name, () => dropzone.classList.remove('hot'));
}
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadFiles(event.dataTransfer.files);
});

start().catch((err) => {
  console.error(err);
  showLogin();
});

// Pose Board — the client's gallery: browse the folders your photographer
// shared, heart the ones you want, and send the shortlist back.
//
// Nothing here ever sees a file path. Every image is an opaque /i/, /t/ or
// /d/ route keyed by id, and a tab the photographer marked private is simply
// not in the payload until the PIN is accepted.

const link = decodeURIComponent(location.pathname.replace(/^\/(g|s)\/?/, '').replace(/\/$/, ''));
// ?picks=<session> opens someone else's shortlist, read only.
const sharedPicks = new URLSearchParams(location.search).get('picks') || '';

const state = {
  gallery: null,
  folder: null,
  folders: [],
  tabs: [],
  favorites: [],
  feedback: [],   // stars and notes, including on images not favourited
  readOnlyPicks: false,  // viewing someone else's shared shortlist
  activeTabId: null,
  sessionId: '',
  clientName: '',
  clientEmail: '',
  askedIdentity: false,
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

function saveSession() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      sessionId: state.sessionId,
      clientName: state.clientName,
      clientEmail: state.clientEmail,
      askedIdentity: state.askedIdentity,
    }));
  } catch { /* private mode: favourites still work, just not across visits */ }
}

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (typeof saved.sessionId === 'string') state.sessionId = saved.sessionId;
    if (typeof saved.clientName === 'string') state.clientName = saved.clientName;
    if (typeof saved.clientEmail === 'string') state.clientEmail = saved.clientEmail;
    state.askedIdentity = saved.askedIdentity === true;
  } catch { /* private mode: favourites still work, just not across visits */ }
  if (!state.sessionId) {
    state.sessionId = (crypto.randomUUID?.() || `${Math.random().toString(36).slice(2)}${Date.now()}`).replace(/-/g, '');
    saveSession();
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
  state.feedback = data.feedback || [];

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
async function toggleFavorite(image, force, tab) {
  if (state.pending.has(image.id)) return;
  const next = force === undefined ? !isFavorite(image.id) : force;
  state.pending.add(image.id);

  const previous = state.favorites;
  // The optimistic entry has to carry everything the favourites strip reads —
  // notably `downloadable`, or the archive button stays hidden until a reload.
  const existing = state.feedback.find((row) => row.id === image.id) || {};
  state.favorites = next
    ? [...state.favorites, {
      ...image,
      locked: false,
      note: existing.note || '',
      rating: existing.rating || 0,
      downloadable: Boolean(tab ? tab.downloadable : image.downloadable),
      tabTitle: tab ? tab.title : image.tabTitle || '',
      folderPath: image.folderPath || state.folder.title,
      createdAt: new Date().toISOString(),
    }]
    : state.favorites.filter((fav) => fav.id !== image.id);
  render();

  try {
    await api('/select', {
      method: 'POST',
      body: {
        imageId: image.id,
        clientSessionId: state.sessionId,
        selected: next,
        clientName: state.clientName,
        clientEmail: state.clientEmail,
      },
    });
    // Ask once, after the pick has actually saved, so the dialog never appears
    // over a favourite that then fails.
    if (next && !state.askedIdentity && !state.clientEmail) await askWhoYouAre();
  } catch (err) {
    state.favorites = previous;
    render();
    toast(err.message, true);
  } finally {
    state.pending.delete(image.id);
  }
}

// ---------- telling the photographer who you are ----------
//
// Entirely optional: the gallery works without it. But a name and email turn
// "someone picked 12 photos" into something the studio can act on, and let the
// same person pick these back up on another device.

function identityDialog({ title, blurb, fields, submitText, onSubmit, skipText }) {
  return new Promise((resolve) => {
    const error = h('p', { class: 'hint', style: 'color:var(--danger)', hidden: true });
    const inputs = fields.map((field) => h('input', {
      type: field.type || 'text',
      value: field.value || '',
      placeholder: field.placeholder || '',
      autocomplete: field.autocomplete || 'off',
    }));
    let busy = false;
    const close = (value) => { modal.remove(); resolve(value); };

    const submit = async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      error.hidden = true;
      try {
        await onSubmit(Object.fromEntries(fields.map((field, i) => [field.name, inputs[i].value.trim()])));
        close(true);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        busy = false;
      }
    };

    const form = h('form', { class: 'modal-card', onsubmit: submit }, [
      h('h2', { text: title }),
      h('p', { class: 'hint', style: 'margin-bottom:16px', text: blurb }),
      ...fields.map((field, i) => h('label', { class: 'field' }, [h('span', { text: field.label }), inputs[i]])),
      error,
      h('div', { class: 'modal-actions' }, [
        h('button', { type: 'button', class: 'btn', text: skipText || 'Cancel', onclick: () => close(false) }),
        h('button', { type: 'submit', class: 'btn btn-primary', text: submitText }),
      ]),
    ]);

    const modal = h('div', {
      class: 'modal',
      onclick: (event) => { if (event.target === modal) close(false); },
    }, [form]);

    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape' && document.body.contains(modal)) close(false);
      if (!document.body.contains(modal)) document.removeEventListener('keydown', onKey);
    });

    $('#modal-root').append(modal);
    inputs[0].focus();
  });
}

/** Asked once, after the first pick, and never again whether they answer or not. */
async function askWhoYouAre() {
  state.askedIdentity = true;
  saveSession();
  await identityDialog({
    title: 'Who should these go to?',
    blurb: 'So your photographer knows whose picks these are. You can skip this — your favourites are saved either way.',
    skipText: 'Skip',
    submitText: 'Save',
    fields: [
      { name: 'clientName', label: 'Your name', placeholder: 'Ana', autocomplete: 'name' },
      { name: 'clientEmail', label: 'Email', type: 'email', placeholder: 'ana@example.com', autocomplete: 'email' },
    ],
    onSubmit: async ({ clientName, clientEmail }) => {
      if (!clientName && !clientEmail) return;
      await api('/identify', {
        method: 'POST',
        body: { clientSessionId: state.sessionId, clientName, clientEmail },
      });
      state.clientName = clientName;
      state.clientEmail = clientEmail;
      saveSession();
      toast('Thanks — your photographer will know these are yours');
    },
  });
}

/** Picks live in this browser; the email is how they are found from another one. */
async function restorePicks() {
  const done = await identityDialog({
    title: 'Pick up where you left off',
    blurb: 'If you favourited photos here before on another device, enter the same email address.',
    submitText: 'Find my picks',
    fields: [{ name: 'clientEmail', label: 'Email', type: 'email', value: state.clientEmail, autocomplete: 'email' }],
    onSubmit: async ({ clientEmail }) => {
      const result = await api('/restore', { method: 'POST', body: { clientEmail } });
      state.sessionId = result.clientSessionId;
      state.clientEmail = clientEmail.toLowerCase();
      saveSession();
    },
  });
  if (!done) return;
  await load(state.folder.id);
  toast(`Found ${state.favorites.length} pick${state.favorites.length === 1 ? '' : 's'}`);
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

/** One archive of every pick the client is allowed to download. */
async function downloadPicks() {
  if (!state.gallery.unlocked) {
    if (!state.gallery.hasPin) {
      toast('Your photographer has not set a download PIN yet', true);
      return;
    }
    if (!await askForPin('Your photographer gave you a PIN for downloading.')) return;
    await load(state.folder.id);
  }
  // A pick made a moment ago may still be in flight. Navigating before it
  // lands asks the server for an archive it does not know about yet, and the
  // client gets an error page instead of their photos.
  for (let waited = 0; state.pending.size && waited < 5000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const params = new URLSearchParams({ clientSessionId: state.sessionId });
  location.href = `/api/g/${encodeURIComponent(link)}/selection.zip?${params}`;
}

/** Every downloadable photo in the gallery, not just the picks. */
async function downloadEverything() {
  if (!state.gallery.unlocked) {
    if (!state.gallery.hasPin) {
      toast('Your photographer has not set a download PIN yet', true);
      return;
    }
    if (!await askForPin('Your photographer gave you a PIN for downloading.')) return;
    await load(state.folder.id);
  }
  location.href = `/api/g/${encodeURIComponent(link)}/gallery.zip`;
}

/** Copy the gallery link, or a link to this visitor's own shortlist. */
function openShare() {
  const galleryUrl = `${location.origin}/g/${encodeURIComponent(link)}`;
  const picksUrl = `${galleryUrl}?picks=${encodeURIComponent(state.sessionId)}`;
  let close;

  const copy = async (value, what) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${what} copied`);
    } catch {
      toast('Could not copy — long-press the link to copy it', true);
    }
    close();
  };

  const card = h('div', { class: 'modal-card' }, [
    h('h2', { text: 'Share' }),
    h('p', { class: 'hint', style: 'margin-bottom:16px', text: 'Send the gallery on, or send just the photos you picked.' }),
    h('div', { class: 'stack' }, [
      h('button', { class: 'btn', text: 'Copy gallery link', onclick: () => copy(galleryUrl, 'Gallery link') }),
      state.favorites.length
        ? h('button', { class: 'btn', text: `Copy a link to my ${state.favorites.length} picks`, onclick: () => copy(picksUrl, 'Link to your picks') })
        : h('p', { class: 'hint', style: 'margin:0', text: 'Pick some photos and you can share just those too.' }),
      navigator.share
        ? h('button', {
          class: 'btn btn-primary',
          text: 'Share…',
          onclick: () => {
            navigator.share({ title: state.gallery.title, url: galleryUrl }).catch(() => {});
            close();
          },
        })
        : null,
    ]),
    h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn', text: 'Close', onclick: () => close() }),
    ]),
  ]);

  const modal = h('div', { class: 'modal', onclick: (e) => { if (e.target === modal) close(); } }, [card]);
  close = () => modal.remove();
  $('#modal-root').append(modal);
}

/** Full-screen, auto-advancing, from whichever tab is open. */
function startSlideshow() {
  const tab = state.tabs.find((entry) => entry.id === state.activeTabId);
  const images = tab && !tab.locked ? tab.images : [];
  if (!images.length) {
    toast('Nothing to play in this tab', true);
    return;
  }

  let index = 0;
  let timer = null;
  const stage = $('#slideshow');
  const picture = $('#slideshow-image');
  const counter = $('#slideshow-count');
  const play = $('#slideshow-play');

  const paint = () => {
    picture.src = images[index].url;
    picture.alt = images[index].title || '';
    counter.textContent = `${index + 1} / ${images.length}`;
  };
  const step = (delta) => { index = (index + delta + images.length) % images.length; paint(); };
  const tick = () => { timer = setTimeout(() => { step(1); tick(); }, 4000); };
  const pause = () => { clearTimeout(timer); timer = null; play.textContent = '▶'; };
  const resume = () => { tick(); play.textContent = '❚❚'; };

  const stop = () => {
    pause();
    stage.hidden = true;
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  function onKey(event) {
    if (event.key === 'Escape') stop();
    if (event.key === 'ArrowLeft') { pause(); step(-1); }
    if (event.key === 'ArrowRight') { pause(); step(1); }
  }

  $('#slideshow-prev').onclick = () => { pause(); step(-1); };
  $('#slideshow-next').onclick = () => { pause(); step(1); };
  $('#slideshow-play').onclick = () => (timer ? pause() : resume());
  $('#slideshow-close').onclick = stop;

  stage.hidden = false;
  document.addEventListener('keydown', onKey);
  stage.requestFullscreen?.().catch(() => { /* fine without it */ });
  paint();
  resume();
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
  const stars = h('div', { class: 'stars', role: 'group', 'aria-label': 'Rating' });
  const comment = h('textarea', { placeholder: 'A note for your photographer…', rows: '3' });
  const commentStatus = h('p', { class: 'hint', style: 'margin:0', hidden: true });

  const feedbackFor = (id) => state.feedback.find((row) => row.id === id) || {};

  /** Saved on change, like the hearts — nothing here needs a Save button. */
  async function saveFeedback(image, patch) {
    try {
      const result = await api('/select', {
        method: 'POST',
        body: {
          imageId: image.id,
          clientSessionId: state.sessionId,
          clientName: state.clientName,
          clientEmail: state.clientEmail,
          ...patch,
        },
      });
      const row = state.feedback.find((entry) => entry.id === image.id);
      if (row) Object.assign(row, { note: result.note, rating: result.rating, selected: result.selected });
      else state.feedback.push({ id: image.id, note: result.note, rating: result.rating, selected: result.selected });
      const fav = state.favorites.find((entry) => entry.id === image.id);
      if (fav) Object.assign(fav, { note: result.note, rating: result.rating });
      render();
      return result;
    } catch (err) {
      toast(err.message, true);
      return null;
    }
  }

  function paintStars() {
    const current = feedbackFor(images[index].id).rating || 0;
    stars.replaceChildren(...[1, 2, 3, 4, 5].map((value) => h('button', {
      class: `star${value <= current ? ' on' : ''}`,
      type: 'button',
      'aria-label': `${value} star${value === 1 ? '' : 's'}`,
      'aria-pressed': value <= current ? 'true' : 'false',
      text: value <= current ? '★' : '☆',
      onclick: async () => {
        // Clicking the current rating again clears it.
        await saveFeedback(images[index], { rating: value === current ? 0 : value });
        paintStars();
      },
    })));
  }

  let commentTimer;
  comment.addEventListener('input', () => {
    clearTimeout(commentTimer);
    commentStatus.hidden = false;
    commentStatus.textContent = 'Saving…';
    commentTimer = setTimeout(async () => {
      const saved = await saveFeedback(images[index], { note: comment.value });
      commentStatus.textContent = saved ? 'Saved' : 'Not saved';
    }, 700);
  });

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
    clearTimeout(commentTimer);
    commentStatus.hidden = true;
    comment.value = feedbackFor(image.id).note || '';
    paintStars();
  }

  const step = (delta) => {
    index = (index + delta + images.length) % images.length;
    paint();
  };

  heart.addEventListener('click', async () => {
    await toggleFavorite(images[index], undefined, activeTab);
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
      stars,
      comment,
      commentStatus,
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

/** The studio's colour and mark, applied to the page the client actually sees. */
function applyBranding(gallery) {
  if (gallery.brandColor) {
    document.documentElement.style.setProperty('--accent', gallery.brandColor);
    document.documentElement.style.setProperty('--accent-soft', `${gallery.brandColor}1f`);
  }
  for (const [id, hideDot] of [['#brand-logo', true], ['#cover-logo', false]]) {
    const img = $(id);
    img.hidden = !gallery.logoUrl;
    if (gallery.logoUrl) img.src = gallery.logoUrl;
    if (hideDot) $('#brand-dot').hidden = Boolean(gallery.logoUrl);
  }
}

function renderExpiry(gallery) {
  const note = $('#expiry-note');
  if (!gallery.expiresAt) { note.hidden = true; return; }
  const when = new Date(gallery.expiresAt);
  const days = Math.ceil((when - Date.now()) / 86400000);
  note.hidden = false;
  note.textContent = days <= 0
    ? 'This gallery closes today — download anything you want to keep.'
    : `This gallery stays open until ${when.toLocaleDateString()} (${days} day${days === 1 ? '' : 's'}).`;
}

function renderCover() {
  const { gallery } = state;
  applyBranding(gallery);
  renderExpiry(gallery);
  $('#brand-title').textContent = gallery.title;
  $('#cover-title').textContent = gallery.title;
  document.title = `${gallery.title} — your gallery`;

  const cover = $('#cover-image');
  const frame = document.querySelector('.cover-media');
  cover.hidden = !gallery.coverImageUrl;
  frame.hidden = !gallery.coverImageUrl;
  if (gallery.coverImageUrl) cover.src = gallery.coverImageUrl;

  const client = $('#cover-client');
  client.hidden = !gallery.clientName;
  client.textContent = gallery.clientName ? `For ${gallery.clientName}` : '';

  const description = $('#cover-description');
  description.hidden = !gallery.description;
  description.textContent = gallery.description || '';

  $('#lock-button').hidden = !gallery.unlocked;
  // The studio's switches decide which controls exist at all.
  $('#share-button').hidden = gallery.canShare === false;
  $('#slideshow-button').hidden = gallery.canSlideshow === false;
  $('#jump-favorites').hidden = gallery.canFavourite === false;
  $('#favorites-section').hidden = gallery.canFavourite === false;
  $('#download-all').hidden = !gallery.downloadableCount || gallery.canDownload === false;
  $('#download-all').title = `Download all ${gallery.downloadableCount} photos`;
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

  $('#restore-button').hidden = count > 0 || state.readOnlyPicks;
  for (const button of strip.querySelectorAll('.fav-remove')) button.hidden = Boolean(state.readOnlyPicks);

  // Only offered when there is actually something downloadable in the picks.
  const downloadable = state.favorites.some((fav) => fav.downloadable && !fav.locked);
  $('#download-picks').hidden = !downloadable || state.gallery.canDownload === false;

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
      onclick: () => (state.gallery.canFavourite === false
        ? openLightbox(images, images.indexOf(image))
        : toggleFavorite(image, undefined, tab)),
    }, [
      h('img', { src: image.thumbUrl, alt: image.title || '', loading: 'lazy' }),
    ]),
    h('div', { class: 'tile-actions' }, [
      h('button', {
        class: `icon-btn${favorited ? ' on' : ''}`,
        text: favorited ? '♥' : '♡',
        'aria-hidden': 'true',
        tabindex: '-1',
        onclick: () => toggleFavorite(image, undefined, tab),
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
  $('#restore-button').addEventListener('click', restorePicks);
  $('#download-picks').addEventListener('click', downloadPicks);
  $('#download-all').addEventListener('click', downloadEverything);
  $('#share-button').addEventListener('click', openShare);
  $('#slideshow-button').addEventListener('click', startSlideshow);
  $('#lock-button').addEventListener('click', async () => {
    await api('/lock', { method: 'POST' });
    await load(state.folder.id);
    toast('Locked again');
  });

  try {
    await load(null);
    if (sharedPicks && sharedPicks !== state.sessionId) {
      const shared = await api(`/picks/${encodeURIComponent(sharedPicks)}`);
      state.favorites = shared.favorites;
      state.readOnlyPicks = true;
      render();
      toast(shared.sharedBy ? `${shared.sharedBy}'s picks` : 'A shared shortlist');
    }
    $('#gallery-view').hidden = false;
  } catch (err) {
    showGone(err.status === 404 ? 'This link is no longer active. Ask your photographer for a new one.' : err.message);
  }
}

start();

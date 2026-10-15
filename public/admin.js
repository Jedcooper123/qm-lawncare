/* Owner portal: sign in, upload gallery photos, and manage them. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    categories: [],
    photos: [],
    uploadCategory: null,
    tab: null,
    files: [], // { file, url, status: 'ready'|'sending'|'done'|'fail', el }
    busy: false,
  };

  /* ── Helpers ─────────────────────────────────────────────── */
  async function api(path, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.json);
    }
    let res;
    try {
      res = await fetch('/api/owner' + path, init);
    } catch (_) {
      throw new Error('No connection. Check your signal and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') {
      showLogin();
      throw new Error('Please sign in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    children.flat().forEach((c) => n.append(c instanceof Node ? c : document.createTextNode(c)));
    return n;
  }

  const labelFor = (key) => (state.categories.find((c) => c.key === key) || {}).label || key;

  /* ── Views ───────────────────────────────────────────────── */
  function showLogin() {
    $('portalView').hidden = true;
    $('loginView').hidden = false;
  }

  async function showPortal(owner) {
    $('loginView').hidden = true;
    $('portalView').hidden = false;
    $('hello').textContent = 'Signed in as ' + (owner.name || owner.email);
    await refresh();
  }

  /* ── Sign in / out ───────────────────────────────────────── */
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type=submit]');
    $('loginError').hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const owner = await api('/login', { json: { email: form.email.value, password: form.password.value } });
      form.password.value = '';
      await showPortal(owner);
    } catch (err) {
      $('loginError').textContent = err.message;
      $('loginError').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  /* ── Data ────────────────────────────────────────────────── */
  async function refresh() {
    const data = await api('/photos');
    state.categories = data.categories;
    state.photos = data.photos;
    if (!state.uploadCategory) state.uploadCategory = state.categories[0].key;
    if (!state.tab) state.tab = state.categories[0].key;
    renderPicker();
    renderTabs();
    renderList();
  }

  /* ── Upload ──────────────────────────────────────────────── */
  function renderPicker() {
    const box = $('catPicker');
    box.replaceChildren(...state.categories.map((c) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(c.key === state.uploadCategory),
      onclick: () => { state.uploadCategory = c.key; renderPicker(); },
    }, c.label)));
  }

  $('fileInput').addEventListener('change', (e) => {
    /* Clear out finished ones from the last batch before adding more. */
    state.files = state.files.filter((f) => f.status !== 'done');
    for (const file of e.target.files) {
      state.files.push({ file, url: URL.createObjectURL(file), status: 'ready' });
    }
    e.target.value = '';
    renderPending();
  });

  function renderPending() {
    const box = $('pending');
    const labels = { ready: '', sending: 'Uploading…', done: '✓ Added', fail: 'Failed' };
    box.replaceChildren(...state.files.map((f, i) => {
      const remove = f.status === 'ready' || f.status === 'fail'
        ? el('button', { class: 'x', type: 'button', 'aria-label': 'Remove', onclick: () => {
            URL.revokeObjectURL(f.url);
            state.files.splice(i, 1);
            renderPending();
          } }, '✕')
        : '';
      return el('div', { class: 'pend ' + f.status },
        el('img', { src: f.url, alt: '' }),
        remove,
        labels[f.status] ? el('div', { class: 'state' }, labels[f.status]) : '');
    }));
    const waiting = state.files.filter((f) => f.status === 'ready' || f.status === 'fail').length;
    const btn = $('uploadBtn');
    btn.disabled = state.busy || waiting === 0;
    btn.textContent = state.busy ? 'Uploading…' : waiting ? `Upload ${waiting} Photo${waiting === 1 ? '' : 's'}` : 'Upload';
  }

  /* Phone photos are 3–13 MB. Shrinking them here first means an upload
     over a weak signal takes seconds rather than minutes. The server makes
     the final copy, so if the browser can't do this the original is sent. */
  async function shrink(file) {
    const MAX = 2400;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close && bmp.close();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      return blob && blob.size < file.size ? blob : file;
    } catch (_) {
      return file;
    }
  }

  $('uploadBtn').addEventListener('click', async () => {
    const todo = state.files.filter((f) => f.status === 'ready' || f.status === 'fail');
    if (!todo.length) return;
    state.busy = true;
    $('uploadError').hidden = true;
    let ok = 0;
    let lastError = '';

    /* One at a time: kinder to a phone connection and to the server. */
    for (const f of todo) {
      f.status = 'sending';
      renderPending();
      try {
        const body = new FormData();
        body.append('category', state.uploadCategory);
        body.append('caption', $('captionInput').value);
        body.append('photo', await shrink(f.file), (f.file.name || 'photo').replace(/\.\w+$/, '') + '.jpg');
        await api('/photos', { method: 'POST', body });
        f.status = 'done';
        ok++;
      } catch (err) {
        f.status = 'fail';
        lastError = err.message;
      }
      renderPending();
    }

    state.busy = false;
    renderPending();
    if (lastError) {
      $('uploadError').textContent = lastError;
      $('uploadError').hidden = false;
    } else {
      $('captionInput').value = '';
    }
    if (ok) {
      toast(`${ok} photo${ok === 1 ? '' : 's'} added to ${labelFor(state.uploadCategory)}`);
      state.tab = state.uploadCategory;
      await refresh();
    }
  });

  /* ── Manage ──────────────────────────────────────────────── */
  function renderTabs() {
    $('tabs').replaceChildren(...state.categories.map((c) => {
      const n = state.photos.filter((p) => p.category === c.key).length;
      return el('button', {
        type: 'button', role: 'tab', 'aria-selected': String(c.key === state.tab),
        onclick: () => { state.tab = c.key; renderTabs(); renderList(); },
      }, c.label + ' ', el('span', { class: 'count' }, `(${n})`));
    }));
  }

  function renderList() {
    const list = state.photos.filter((p) => p.category === state.tab);
    const box = $('photoList');
    if (!list.length) {
      box.replaceChildren(el('p', { class: 'muted empty' },
        'No photos in this section yet. While it\'s empty it won\'t show on the website.'));
      return;
    }
    box.replaceChildren(...list.map((p, i) => photoRow(p, i, list.length)));
  }

  function photoRow(p, i, total) {
    const caption = el('input', {
      type: 'text', maxlength: '80', value: p.caption, placeholder: 'Caption (optional)', 'aria-label': 'Caption',
    });
    caption.addEventListener('change', () => save(p, { caption: caption.value }, 'Caption saved'));
    caption.addEventListener('keydown', (e) => { if (e.key === 'Enter') caption.blur(); });

    const category = el('select', { 'aria-label': 'Section' },
      state.categories.map((c) => el('option', { value: c.key, selected: c.key === p.category }, c.label)));
    category.addEventListener('change', () => save(p, { category: category.value }, 'Moved to ' + labelFor(category.value)));

    return el('div', { class: 'photo-row' },
      el('img', { src: p.url, alt: p.alt || '', loading: 'lazy' }),
      el('div', { class: 'controls' },
        caption,
        category,
        el('div', { class: 'actions' },
          el('button', { class: 'icon-btn', type: 'button', disabled: i === 0, onclick: () => move(p, 'up'), 'aria-label': 'Move earlier' }, '↑ Earlier'),
          el('button', { class: 'icon-btn', type: 'button', disabled: i === total - 1, onclick: () => move(p, 'down'), 'aria-label': 'Move later' }, '↓ Later'),
          el('button', { class: 'icon-btn danger', type: 'button', onclick: () => remove(p) }, 'Delete'))));
  }

  async function save(p, changes, msg) {
    try {
      await api('/photos/' + p.id, { method: 'PATCH', json: changes });
      toast(msg);
      await refresh();
    } catch (err) { toast(err.message); }
  }

  async function move(p, direction) {
    try {
      await api(`/photos/${p.id}/move`, { json: { direction } });
      await refresh();
    } catch (err) { toast(err.message); }
  }

  async function remove(p) {
    if (!confirm('Delete this photo from your website? This can\'t be undone.')) return;
    try {
      await api('/photos/' + p.id, { method: 'DELETE' });
      toast('Photo deleted');
      await refresh();
    } catch (err) { toast(err.message); }
  }

  /* ── Start ───────────────────────────────────────────────── */
  api('/me').then(showPortal).catch(showLogin);
})();

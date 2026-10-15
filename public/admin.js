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
    $('navActions').hidden = true;
    $('loginView').hidden = false;
  }

  async function showPortal(owner) {
    $('loginView').hidden = true;
    $('portalView').hidden = false;
    $('navActions').hidden = false;
    const first = (owner.name || '').split(' ')[0];
    $('hello').textContent = (first ? `Hi ${first} — ` : '') + 'add photos of your work and manage what shows on your website.';
    /* Each section loads on its own, so one failed request shows a retry
       message in that section rather than sending him back to sign in. */
    refresh()
      .catch((err) => showLoadError('photoList', err, refresh))
      .then(() => loadSiteImages())
      .catch((err) => showLoadError('siteImages', err, loadSiteImages));
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

  function showLoadError(boxId, err, retry) {
    if ($('portalView').hidden) return; // signed out; the login form is showing
    $(boxId).replaceChildren(el('p', { class: 'empty load-error' },
      err.message + ' ',
      el('button', { class: 'btn btn-sm btn-green', type: 'button', onclick: () => {
        retry().catch((e) => showLoadError(boxId, e, retry));
      } }, el('i', { class: 'fa-solid fa-rotate-right' }), 'Try again')));
  }

  /* ── Website photos (banner, About photos, logo) ─────────── */
  async function loadSiteImages() {
    const data = await api('/site-images');
    renderSiteImages(data.images);
  }

  function renderSiteImages(images) {
    /* Keep the portal's own logo in step with a replaced one. */
    const logo = images.find((s) => s.key === 'logo');
    if (logo) document.querySelector('.nav-logo').src = logo.url;

    $('siteImages').replaceChildren(...images.map((s) => {
      const card = el('div', { class: 'site-card' });
      const input = el('input', { type: 'file', accept: 'image/*', id: 'site-' + s.key });

      input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (!file) return;
        card.classList.add('busy');
        try {
          const body = new FormData();
          body.append('photo', await shrink(file), 'photo.jpg');
          const data = await api('/site-images/' + s.key, { method: 'POST', body });
          renderSiteImages(data.images);
          toast(s.label + ' updated');
        } catch (err) {
          card.classList.remove('busy');
          toast(err.message);
        }
      });

      const restore = async () => {
        if (!confirm(`Put the original ${s.label.toLowerCase()} back?`)) return;
        card.classList.add('busy');
        try {
          const data = await api('/site-images/' + s.key, { method: 'DELETE' });
          renderSiteImages(data.images);
          toast('Original ' + s.label.toLowerCase() + ' restored');
        } catch (err) {
          card.classList.remove('busy');
          toast(err.message);
        }
      };

      card.append(
        el('div', { class: 'site-preview ' + s.key },
          el('img', { src: s.url, alt: s.label, loading: 'lazy' }),
          el('span', { class: 'site-badge' + (s.custom ? '' : ' orig') }, s.custom ? 'Your photo' : 'Original')),
        el('div', { class: 'site-info' },
          el('span', { class: 'pick-name' }, s.label),
          el('span', { class: 'pick-desc' }, s.desc),
          el('div', { class: 'site-actions' },
            el('label', { class: 'btn btn-green', for: 'site-' + s.key },
              el('i', { class: 'fa-solid fa-arrow-up-from-bracket' }), 'Replace', input),
            s.custom
              ? el('button', { class: 'btn btn-outline-dark', type: 'button', onclick: restore },
                  el('i', { class: 'fa-solid fa-rotate-left' }), 'Restore original')
              : '')));
      return card;
    }));
  }

  /* ── Upload ──────────────────────────────────────────────── */
  /* Labels come from the server as "🌿 Lawn Mowing" — the same text as the
     website's filter buttons. The tiles show the emoji as their icon. */
  const splitLabel = (label) => {
    const [icon, ...rest] = label.split(' ');
    return { icon, name: rest.join(' ') };
  };

  function renderPicker() {
    const box = $('catPicker');
    box.replaceChildren(...state.categories.map((c) => {
      const { icon, name } = splitLabel(c.label);
      const n = state.photos.filter((p) => p.category === c.key).length;
      return el('button', {
        type: 'button', class: 'pick-opt', role: 'radio', 'aria-checked': String(c.key === state.uploadCategory),
        onclick: () => { state.uploadCategory = c.key; renderPicker(); },
      },
      el('span', { class: 'pick-icon' }, icon),
      el('span', {}, el('span', { class: 'pick-name' }, name), el('br'),
        el('span', { class: 'pick-desc' }, `${n} photo${n === 1 ? '' : 's'} now`)));
    }));
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
        type: 'button', class: 'gf-btn', role: 'tab', 'aria-selected': String(c.key === state.tab),
        onclick: () => { state.tab = c.key; renderTabs(); renderList(); },
      }, c.label, el('span', { class: 'count' }, `(${n})`));
    }));
  }

  function renderList() {
    const list = state.photos.filter((p) => p.category === state.tab);
    const box = $('photoList');
    if (!list.length) {
      box.replaceChildren(el('p', { class: 'empty' },
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

    const icon = (name) => el('i', { class: 'fa-solid ' + name });

    /* The top is the same card the website shows, caption overlay and all,
       so what he sees here is what visitors see. */
    return el('div', { class: 'm-item' },
      el('div', { class: 'g-item' },
        el('img', { src: p.url, alt: p.alt || '', loading: 'lazy' }),
        p.caption ? el('div', { class: 'g-overlay' }, el('span', {}, p.caption)) : ''),
      el('div', { class: 'm-controls' },
        caption,
        category,
        el('div', { class: 'm-actions' },
          el('button', { class: 'icon-btn', type: 'button', disabled: i === 0, onclick: () => move(p, 'up'), 'aria-label': 'Move earlier', title: 'Move earlier' }, icon('fa-arrow-left')),
          el('button', { class: 'icon-btn', type: 'button', disabled: i === total - 1, onclick: () => move(p, 'down'), 'aria-label': 'Move later', title: 'Move later' }, icon('fa-arrow-right')),
          el('button', { class: 'icon-btn danger', type: 'button', onclick: () => remove(p) }, icon('fa-trash-can'), 'Delete'))));
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

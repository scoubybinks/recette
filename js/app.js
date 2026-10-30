// UI: hash router and views (recipe list & search, recipe, form, ingredients, categories, sync settings).

import * as store from './store.js';
import * as timers from './timers.js';
import {
  $, $$, esc, normalize, ingredientKey, scaleQty, formatClock, formatMinutes, formatSeconds,
  findDurations, readJson, writeJson,
} from './utils.js';

const view = $('#view');
const dock = $('#timer-dock');
let current = { name: null, id: null };
let formDirty = false;

// ---------- Small UI helpers ----------

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = 'toast'), 2800);
}

// Opens the shared <dialog> with a small form. Resolves with FormData, or null when cancelled.
function dialogForm({ title, body, submit = 'OK', danger = false }) {
  const dlg = $('#dialog');
  dlg.innerHTML = `
    <form class="dlg">
      <h2>${esc(title)}</h2>
      <div class="dlg-body">${body}</div>
      <div class="dlg-actions">
        <button value="ok" class="btn ${danger ? 'danger' : 'primary'}">${esc(submit)}</button>
        <button value="cancel" class="btn ghost" formnovalidate>Annuler</button>
      </div>
    </form>`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const form = dlg.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(e.submitter?.value === 'cancel' ? null : new FormData(form));
    });
    dlg.addEventListener('close', () => finish(null), { once: true });
    dlg.showModal();
    dlg.querySelector('input, textarea, select')?.focus();
  });
}

const confirmDialog = (message, opts = {}) =>
  dialogForm({ title: opts.title || 'Confirmer', body: `<p>${esc(message)}</p>`, submit: opts.submit || 'Confirmer', danger: opts.danger }).then(Boolean);

const totalMinutes = (r) => (r.prepMinutes || 0) + (r.cookMinutes || 0);
const recipeLink = (id) => `#/recette/${encodeURIComponent(id)}`;
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function categoryTags(r, asLinks = false) {
  return r.categoryIds
    .map(store.getCategory)
    .filter(Boolean)
    .map((c) =>
      asLinks
        ? `<a class="tag" href="#/" data-cat="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</a>`
        : `<span class="tag">${esc(c.emoji)} ${esc(c.name)}</span>`,
    )
    .join('');
}

function recipeEmoji(r) {
  return r.categoryIds.map(store.getCategory).find((c) => c?.emoji)?.emoji || '🍽️';
}

function notFound() {
  view.innerHTML = `<div class="empty"><div class="big">🤷</div><p>Cette page n'existe pas (ou la recette a été supprimée).</p><a class="btn primary" href="#/">Retour aux recettes</a></div>`;
}

// ---------- Home: list, text search, ingredient search, categories ----------

const home = Object.assign({ q: '', ings: [], all: false, cat: null, sort: 'auto' }, readJson('recettes.home.v1', {}));
const saveHome = () => writeJson('recettes.home.v1', home);

// A selected ingredient matches a recipe line when the line contains all its words:
// "tomate" matches "tomates cerises", "farine" matches "farine de blé".
function lineMatches(lineKey, selKey) {
  if (lineKey === selKey) return true;
  const words = lineKey.split(' ');
  return selKey.split(' ').every((w) => words.includes(w));
}

function searchRecipes() {
  const data = store.getData();
  home.ings = home.ings.filter((id) => store.getIngredient(id));
  const selKeys = home.ings.map((id) => ingredientKey(store.getIngredient(id).name));
  const terms = normalize(home.q).split(' ').filter(Boolean);

  let results = data.recipes.map((r) => {
    const lineKeys = r.ingredients.map((l) => ingredientKey(store.ingredientName(l)));
    const matched = home.ings.filter((_, i) => lineKeys.some((k) => lineMatches(k, selKeys[i])));
    const missing = r.ingredients.filter((_, j) => !selKeys.some((s) => lineMatches(lineKeys[j], s)));
    return { r, matched, missing };
  });

  if (home.cat === 'fav') results = results.filter((x) => x.r.favorite);
  else if (home.cat) results = results.filter((x) => x.r.categoryIds.includes(home.cat));
  if (terms.length) {
    results = results.filter(({ r }) => {
      const hay = normalize(
        [r.title, r.description, r.notes, ...r.ingredients.map(store.ingredientName), ...r.categoryIds.map((id) => store.getCategory(id)?.name)].join(' '),
      );
      return terms.every((t) => hay.includes(t));
    });
  }
  if (home.ings.length) results = results.filter((x) => (home.all ? x.matched.length === home.ings.length : x.matched.length > 0));

  const recent = (a, b) => (b.r.createdAt || '').localeCompare(a.r.createdAt || '');
  const sorters = {
    pertinence: (a, b) => b.matched.length - a.matched.length || a.missing.length - b.missing.length || recent(a, b),
    recent,
    alpha: (a, b) => a.r.title.localeCompare(b.r.title, 'fr'),
    rapide: (a, b) => (totalMinutes(a.r) || 1e9) - (totalMinutes(b.r) || 1e9),
  };
  const sort = home.sort === 'auto' ? (home.ings.length ? 'pertinence' : 'recent') : home.sort;
  return results.sort(sorters[sort] || recent);
}

function recipeCard({ r, matched, missing }) {
  const total = totalMinutes(r);
  let match = '';
  if (home.ings.length) {
    const miss = missing.map(store.ingredientName);
    match = `<div class="match">
      <span class="ok">✓ ${matched.length}/${home.ings.length} de tes ingrédients</span>
      ${miss.length ? `<span class="miss">Manque : ${esc(miss.slice(0, 4).join(', '))}${miss.length > 4 ? ` +${miss.length - 4}` : ''}</span>` : '<span class="ok">Tu as tout !</span>'}
    </div>`;
  }
  return `<a class="recipe-card" href="${recipeLink(r.id)}">
    <div class="thumb">${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : ''}<span class="emoji">${esc(recipeEmoji(r))}</span>${r.favorite ? '<span class="fav-badge">★</span>' : ''}</div>
    <div class="card-body">
      <h3>${esc(r.title)}</h3>
      <div class="meta">${[total ? `⏱ ${formatMinutes(total)}` : '', r.servings ? `👥 ${r.servings}` : '', plural(r.ingredients.length, 'ingrédient')].filter(Boolean).join(' · ')}</div>
      <div class="tags">${categoryTags(r)}</div>
      ${match}
    </div>
  </a>`;
}

function renderHome() {
  view.innerHTML = `
    <section class="search-panel">
      <input id="q" class="search" type="search" placeholder="🔎 Rechercher une recette, un ingrédient…" value="${esc(home.q)}" autocomplete="off" />
      <div class="card ing-search">
        <div class="ing-search-head">
          <h2>🥕 Qu'est-ce que j'ai sous la main ?</h2>
          <button type="button" class="link" id="clear-ings">Effacer</button>
        </div>
        <div class="chips" id="ing-chips"></div>
        <div class="suggest-wrap">
          <input id="ing-input" type="text" placeholder="Ajoute un ingrédient (ex : tomate, œufs…)" autocomplete="off" enterkeyhint="done" />
          <div class="suggest" id="ing-suggest" hidden></div>
        </div>
        <label class="check"><input type="checkbox" id="ing-all" ${home.all ? 'checked' : ''} /><span>Seulement les recettes qui contiennent <b>tous</b> ces ingrédients</span></label>
      </div>
    </section>
    <div class="chips scroll" id="cat-filter"></div>
    <div class="results-head">
      <span id="count" class="muted"></span>
      <select id="sort" aria-label="Trier">
        <option value="auto">Tri : automatique</option>
        <option value="recent">Plus récentes</option>
        <option value="alpha">De A à Z</option>
        <option value="rapide">Plus rapides</option>
        <option value="pertinence">Ingrédients en commun</option>
      </select>
    </div>
    <div class="grid" id="results"></div>`;

  $('#sort').value = home.sort;
  $('#q').addEventListener('input', (e) => {
    home.q = e.target.value;
    saveHome();
    renderHomeResults();
  });
  $('#sort').addEventListener('change', (e) => {
    home.sort = e.target.value;
    saveHome();
    renderHomeResults();
  });
  $('#ing-all').addEventListener('change', (e) => {
    home.all = e.target.checked;
    saveHome();
    renderHomeResults();
  });
  $('#clear-ings').addEventListener('click', () => {
    home.ings = [];
    saveHome();
    renderHomeResults();
  });
  $('#ing-chips').addEventListener('click', (e) => {
    const id = e.target.closest('[data-remove]')?.dataset.remove;
    if (!id) return;
    home.ings = home.ings.filter((x) => x !== id);
    saveHome();
    renderHomeResults();
  });
  $('#cat-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    home.cat = btn.dataset.filter || null;
    saveHome();
    renderHomeResults();
  });
  wireIngredientSuggest();
  renderHomeResults();
}

function ingredientSuggestions(text) {
  const q = normalize(text);
  if (!q) return [];
  const counts = new Map();
  for (const r of store.getData().recipes) for (const l of r.ingredients) counts.set(l.ingredientId, (counts.get(l.ingredientId) || 0) + 1);
  return store
    .getData()
    .ingredients.filter((i) => !home.ings.includes(i.id))
    .map((i) => {
      const n = normalize(i.name);
      const rank = n.startsWith(q) ? 0 : n.split(' ').some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : -1;
      return { i, rank, count: counts.get(i.id) || 0 };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || b.count - a.count || a.i.name.localeCompare(b.i.name, 'fr'))
    .slice(0, 8);
}

function wireIngredientSuggest() {
  const input = $('#ing-input');
  const box = $('#ing-suggest');
  let items = [];
  let active = 0;
  const draw = () => {
    items = ingredientSuggestions(input.value);
    box.hidden = !input.value.trim();
    box.innerHTML = items.length
      ? items.map((x, k) => `<button type="button" class="${k === active ? 'active' : ''}" data-pick="${esc(x.i.id)}"><span>${esc(x.i.name)}</span><small>${plural(x.count, 'recette')}</small></button>`).join('')
      : `<div class="none">Aucun ingrédient « ${esc(input.value.trim())} » dans tes recettes</div>`;
  };
  const pick = (id) => {
    if (!id) return;
    home.ings.push(id);
    saveHome();
    input.value = '';
    active = 0;
    box.hidden = true;
    renderHomeResults();
    input.focus();
  };
  input.addEventListener('input', () => {
    active = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(items.length, 1);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[active]?.i.id);
    } else if (e.key === 'Escape') box.hidden = true;
  });
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 150));
  input.addEventListener('focus', () => input.value.trim() && draw());
  box.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
  box.addEventListener('click', (e) => pick(e.target.closest('[data-pick]')?.dataset.pick));
}

function renderHomeResults() {
  const data = store.getData();
  $('#ing-chips').innerHTML = home.ings
    .map((id) => `<span class="chip on">${esc(store.getIngredient(id).name)}<button type="button" data-remove="${esc(id)}" aria-label="Retirer">✕</button></span>`)
    .join('');
  $('#clear-ings').hidden = !home.ings.length;

  if (home.cat && home.cat !== 'fav' && !store.getCategory(home.cat)) home.cat = null;
  const cats = [{ id: '', label: 'Toutes' }, { id: 'fav', label: '★ Favoris' }, ...data.categories.map((c) => ({ id: c.id, label: `${c.emoji} ${c.name}`.trim() }))];
  $('#cat-filter').innerHTML = cats
    .map((c) => `<button type="button" class="chip ${(home.cat || '') === c.id ? 'on' : ''}" data-filter="${esc(c.id)}">${esc(c.label)}</button>`)
    .join('');

  const results = searchRecipes();
  $('#count').textContent = data.recipes.length ? `${plural(results.length, 'recette')}` : '';
  const loading = store.getStatus().kind === 'loading';
  if (!data.recipes.length) {
    $('#results').innerHTML = loading
      ? '<div class="empty"><div class="big spin">🍳</div><p>Chargement des recettes…</p></div>'
      : '<div class="empty"><div class="big">📖</div><p>Aucune recette pour l\'instant.</p><a class="btn primary" href="#/nouvelle">➕ Ajouter ma première recette</a></div>';
  } else if (!results.length) {
    $('#results').innerHTML = '<div class="empty"><div class="big">🔍</div><p>Aucune recette ne correspond à ta recherche.</p></div>';
  } else {
    $('#results').innerHTML = results.map(recipeCard).join('');
  }
}

// ---------- Recipe ----------
// Step timers are keyed by recipe, step and duration, so a detected "10 min" and the step's own
// 10-minute timer button control the same timer.

const detail = new Map(); // per recipe: { servings, checked: Set, done: Set }
let wakeLock = null;
let wantWake = false;

function detailState(r) {
  if (!detail.has(r.id)) detail.set(r.id, { servings: r.servings, checked: new Set(), done: new Set() });
  return detail.get(r.id);
}

function stepTextHtml(text, r, stepIndex) {
  let html = '';
  let pos = 0;
  for (const d of findDurations(text)) {
    html += esc(text.slice(pos, d.index));
    html += `<button type="button" class="dur-chip" data-timer="${d.seconds}" data-key="${esc(`${r.id}:${stepIndex}:${d.seconds}`)}" data-label="${esc(`${r.title} — étape ${stepIndex + 1}`)}" title="Lancer un minuteur">⏱ ${esc(d.text)}</button>`;
    pos = d.index + d.length;
  }
  return html + esc(text.slice(pos));
}

function renderRecipe(id) {
  const r = store.getRecipe(id);
  if (!r) return notFound();
  const ds = detailState(r);
  const factor = r.servings && ds.servings ? ds.servings / r.servings : 1;
  const total = totalMinutes(r);
  const facts = [
    r.prepMinutes ? ['Préparation', formatMinutes(r.prepMinutes)] : null,
    r.cookMinutes ? ['Cuisson', formatMinutes(r.cookMinutes)] : null,
    total && r.prepMinutes && r.cookMinutes ? ['Total', formatMinutes(total)] : null,
  ].filter(Boolean);

  view.innerHTML = `
  <article class="recipe">
    <div class="page-head">
      <a class="back" href="#/" aria-label="Retour">←</a>
      <h1>${esc(r.title)}</h1>
      <button type="button" class="icon-btn fav ${r.favorite ? 'on' : ''}" id="fav" aria-label="Favori">${r.favorite ? '★' : '☆'}</button>
    </div>
    ${r.image ? `<img class="hero-img" src="${esc(r.image)}" alt="" />` : ''}
    <div class="tags">${categoryTags(r, true)}</div>
    ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ''}
    <div class="facts">
      ${facts.map(([k, v]) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`).join('')}
      ${r.servings ? `<div class="fact"><span>Portions</span><div class="stepper"><button type="button" id="srv-minus" aria-label="Moins">−</button><b>${ds.servings}</b><button type="button" id="srv-plus" aria-label="Plus">+</button></div></div>` : ''}
    </div>
    <div class="recipe-cols">
      <section class="card">
        <h2>Ingrédients ${factor !== 1 ? `<small class="muted">(×${String(Math.round(factor * 100) / 100).replace('.', ',')})</small>` : ''}</h2>
        ${r.ingredients.length ? `<ul class="ing-lines">${r.ingredients
          .map((l, i) => `<li><label class="${ds.checked.has(i) ? 'checked' : ''}"><input type="checkbox" data-check="${i}" ${ds.checked.has(i) ? 'checked' : ''} />
            <span><b>${esc([scaleQty(l.qty, factor), l.unit].filter(Boolean).join(' '))}</b> ${esc(store.ingredientName(l))}${l.note ? ` <span class="muted">(${esc(l.note)})</span>` : ''}</span></label></li>`)
          .join('')}</ul>` : '<p class="muted">Aucun ingrédient.</p>'}
      </section>
      <section class="card">
        <h2>Préparation</h2>
        <div class="cook-tools">
          <button type="button" class="btn small ${wantWake ? 'on' : ''}" id="wake">🔆 Écran toujours allumé</button>
          <button type="button" class="btn small" id="free-timer">⏱ Minuteur libre</button>
        </div>
        ${r.steps.length ? `<ol class="steps">${r.steps
          .map((s, i) => `<li class="${ds.done.has(i) ? 'done' : ''}" data-step="${i}">
            <div class="step-text">${stepTextHtml(s.text, r, i)}</div>
            ${s.timerSeconds ? `<button type="button" class="timer-btn" data-timer="${s.timerSeconds}" data-key="${esc(`${r.id}:${i}:${s.timerSeconds}`)}" data-label="${esc(`${r.title} — étape ${i + 1}`)}">⏱ Lancer ${formatSeconds(s.timerSeconds)}</button>` : ''}
          </li>`)
          .join('')}</ol><p class="hint">Touche une étape pour la marquer comme faite. Les durées ⏱ lancent un minuteur.</p>` : '<p class="muted">Aucune étape.</p>'}
      </section>
    </div>
    ${r.notes ? `<section class="card"><h2>Notes</h2><p class="pre">${esc(r.notes)}</p></section>` : ''}
    ${r.source ? `<p class="source">Source : ${/^https?:\/\//i.test(r.source) ? `<a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.source)}</a>` : esc(r.source)}</p>` : ''}
    <div class="recipe-actions">
      <a class="btn" href="#/modifier/${encodeURIComponent(r.id)}">✏️ Modifier</a>
      <button type="button" class="btn danger ghost" id="delete">🗑 Supprimer</button>
    </div>
  </article>`;

  $('#fav').onclick = () => store.toggleFavorite(r.id);
  const setServings = (n) => {
    ds.servings = Math.max(1, n);
    renderRecipe(r.id);
  };
  if (r.servings) {
    $('#srv-minus').onclick = () => setServings(ds.servings - 1);
    $('#srv-plus').onclick = () => setServings(ds.servings + 1);
  }
  view.querySelectorAll('[data-check]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const i = Number(cb.dataset.check);
      cb.checked ? ds.checked.add(i) : ds.checked.delete(i);
      cb.closest('label').classList.toggle('checked', cb.checked);
    }),
  );
  view.querySelectorAll('[data-step]').forEach((li) =>
    li.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const i = Number(li.dataset.step);
      ds.done.has(i) ? ds.done.delete(i) : ds.done.add(i);
      li.classList.toggle('done');
    }),
  );
  $('#wake').onclick = toggleWakeLock;
  $('#free-timer').onclick = () => customTimer(r.title);
  $('#delete').onclick = async () => {
    if (!(await confirmDialog(`Supprimer « ${r.title} » ?`, { submit: 'Supprimer', danger: true }))) return;
    store.deleteRecipe(r.id);
    location.hash = '#/';
    toast('Recette supprimée');
  };
  refreshTimerButtons();
}

async function toggleWakeLock() {
  wantWake = !wantWake;
  $('#wake')?.classList.toggle('on', wantWake);
  if (wantWake) await acquireWakeLock();
  else releaseWakeLock();
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    toast("Ton navigateur ne permet pas de garder l'écran allumé");
    wantWake = false;
    $('#wake')?.classList.remove('on');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWake && current.name === 'recette') acquireWakeLock();
});

async function customTimer(label = '') {
  const fd = await dialogForm({
    title: '⏱ Nouveau minuteur',
    submit: 'Lancer',
    body: `
      <div class="row2">
        <label class="field"><span>Minutes</span><input name="min" type="number" min="0" max="1440" inputmode="numeric" value="5" /></label>
        <label class="field"><span>Secondes</span><input name="sec" type="number" min="0" max="59" inputmode="numeric" value="0" /></label>
      </div>
      <label class="field"><span>Nom</span><input name="label" value="${esc(label)}" placeholder="ex : Œufs mollets" /></label>`,
  });
  if (!fd) return;
  const seconds = (Number(fd.get('min')) || 0) * 60 + (Number(fd.get('sec')) || 0);
  if (seconds <= 0) return toast('Durée invalide');
  timers.start(String(fd.get('label')).trim() || 'Minuteur', seconds);
}

// ---------- Timers dock ----------

function renderDock() {
  const list = timers.list();
  const alarm = list.some((t) => t.status === 'done' && !t.acknowledged);
  dock.classList.toggle('alarm', alarm);
  dock.hidden = !list.length;
  dock.innerHTML = list.length
    ? `${alarm ? '<button type="button" class="btn danger stop-alarm" data-act="ack">🔕 Arrêter la sonnerie</button>' : ''}
      <div class="timers">${list
        .map((t) => {
          const playPause =
            t.status === 'running' ? `<button type="button" data-act="pause" data-id="${t.id}" aria-label="Pause">⏸</button>`
            : t.status === 'paused' ? `<button type="button" data-act="resume" data-id="${t.id}" aria-label="Reprendre">▶</button>`
            : `<button type="button" data-act="restart" data-id="${t.id}" aria-label="Relancer">↻</button>`;
          return `<div class="timer ${t.status}">
            <a class="timer-label" ${t.recipeId ? `href="${recipeLink(t.recipeId)}"` : ''}>${esc(t.label)}</a>
            <div class="timer-time" data-time="${t.id}">${t.status === 'done' ? 'Terminé !' : formatClock(timers.remaining(t))}</div>
            <div class="timer-bar"><span data-bar="${t.id}"></span></div>
            <div class="timer-actions">${playPause}<button type="button" data-act="add" data-id="${t.id}">+1 min</button><button type="button" data-act="remove" data-id="${t.id}" aria-label="Supprimer">✕</button></div>
          </div>`;
        })
        .join('')}</div>`
    : '';
  updateDockTimes();
  document.body.style.setProperty('--dock-h', `${dock.hidden ? 0 : dock.offsetHeight}px`);
}

function updateDockTimes() {
  for (const t of timers.list()) {
    const time = dock.querySelector(`[data-time="${t.id}"]`);
    const bar = dock.querySelector(`[data-bar="${t.id}"]`);
    const left = timers.remaining(t);
    if (time && t.status !== 'done') time.textContent = formatClock(left);
    if (bar) bar.style.width = `${t.status === 'done' ? 100 : Math.min(100, (1 - left / t.total) * 100)}%`;
  }
}

function refreshTimerButtons() {
  view.querySelectorAll('.timer-btn[data-key], .dur-chip[data-key]').forEach((btn) => {
    btn.dataset.orig ??= btn.textContent;
    const t = timers.byKey(btn.dataset.key);
    btn.classList.toggle('running', !!t);
    btn.textContent = t ? `⏱ ${formatClock(timers.remaining(t))}${t.status === 'paused' ? ' (pause)' : ''}` : btn.dataset.orig;
  });
}

dock.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  ({
    ack: () => timers.acknowledgeAll(),
    pause: () => timers.pause(id),
    resume: () => timers.resume(id),
    restart: () => timers.restart(id),
    add: () => timers.addTime(id, 60),
    remove: () => timers.remove(id),
  })[btn.dataset.act]?.();
});

timers.subscribe((type) => {
  if (type === 'change') renderDock();
  else updateDockTimes();
  refreshTimerButtons();
});

// Delegated: any [data-timer] button in a view starts a timer; category tags filter the home page.
view.addEventListener('click', (e) => {
  const tbtn = e.target.closest('[data-timer]');
  if (tbtn) {
    const t = timers.byKey(tbtn.dataset.key);
    if (t) {
      t.status === 'paused' ? timers.resume(t.id) : timers.pause(t.id);
      return;
    }
    timers.start(tbtn.dataset.label, Number(tbtn.dataset.timer), { key: tbtn.dataset.key, recipeId: current.id });
    toast(`Minuteur lancé : ${formatSeconds(Number(tbtn.dataset.timer))}`);
    return;
  }
  const cat = e.target.closest('[data-cat]');
  if (cat) {
    home.cat = cat.dataset.cat;
    saveHome();
  }
});

// Hide broken images instead of showing the browser's broken-image icon.
view.addEventListener('error', (e) => e.target.tagName === 'IMG' && (e.target.hidden = true), true);

// ---------- Recipe form ----------

const UNITS = ['g', 'kg', 'mg', 'ml', 'cl', 'dl', 'l', 'c. à s.', 'c. à c.', 'pincée', 'gousse', 'tranche', 'sachet', 'boîte', 'botte', 'brin', 'feuille', 'verre', 'tasse', 'poignée', 'noix', 'filet', 'morceau'];
const UNIT_ALIASES = [
  ...UNITS,
  'cuillères à soupe', 'cuillère à soupe', 'cuillères à café', 'cuillère à café', 'c.à.s.', 'c.à.c.', 'càs', 'càc', 'cs', 'cc',
  'pincées', 'gousses', 'tranches', 'sachets', 'boîtes', 'bottes', 'brins', 'feuilles', 'verres', 'tasses', 'poignées', 'filets', 'morceaux',
].sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "200 g de farine (tamisée)" → { qty: '200', unit: 'g', name: 'farine', note: 'tamisée' }
export function parseIngredientLine(line) {
  let s = line.replace(/^[-•*·\s]+/, '').trim();
  if (!s) return null;
  let qty = '';
  let unit = '';
  let note = '';
  const q = s.match(/^((?:\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|[½¼¾⅓⅔])(?:\s+\d+\/\d+)?)\s*/);
  if (q) {
    qty = q[1].replace(/\s*\/\s*/, '/');
    s = s.slice(q[0].length);
  }
  for (const u of UNIT_ALIASES) {
    const m = s.match(new RegExp(`^${escapeRe(u)}(?!\\p{L})\\.?\\s*`, 'iu'));
    if (m) {
      unit = u;
      s = s.slice(m[0].length);
      break;
    }
  }
  s = s.replace(/^(?:de |d['’]|du |des )/i, '');
  const p = s.match(/^(.*?)\s*(?:\(([^)]*)\)|,\s*(.+))$/);
  if (p && p[1]) {
    s = p[1];
    note = p[2] || p[3] || '';
  }
  return { qty, unit, name: s.trim(), note: note.trim() };
}

function ingRowHtml(l = {}) {
  return `<div class="ing-row">
    <input class="qty" placeholder="Qté" value="${esc(l.qty)}" inputmode="decimal" aria-label="Quantité" />
    <input class="unit" placeholder="Unité" value="${esc(l.unit)}" list="unit-list" aria-label="Unité" />
    <input class="name" placeholder="Ingrédient" value="${esc(l.name)}" list="ing-datalist" aria-label="Ingrédient" />
    <input class="note" placeholder="Précision (facultatif)" value="${esc(l.note)}" aria-label="Précision" />
    <div class="row-tools">
      <button type="button" class="icon-btn" data-move="-1" aria-label="Monter">↑</button>
      <button type="button" class="icon-btn" data-move="1" aria-label="Descendre">↓</button>
      <button type="button" class="icon-btn" data-remove-row aria-label="Retirer">✕</button>
    </div>
  </div>`;
}

function stepRowHtml(s = {}) {
  const min = s.timerSeconds ? String(Math.round((s.timerSeconds / 60) * 100) / 100) : '';
  return `<div class="step-row">
    <textarea class="text" rows="2" placeholder="Décris l'étape… (« cuire 10 min » devient un minuteur)" aria-label="Étape">${esc(s.text)}</textarea>
    <div class="step-foot">
      <label class="timer-field">⏱ Minuteur <input class="timer" type="number" min="0" step="0.5" inputmode="decimal" placeholder="—" value="${esc(min)}" /> min</label>
      <span class="detected muted"></span>
      <div class="row-tools">
        <button type="button" class="icon-btn" data-move="-1" aria-label="Monter">↑</button>
        <button type="button" class="icon-btn" data-move="1" aria-label="Descendre">↓</button>
        <button type="button" class="icon-btn" data-remove-row aria-label="Retirer">✕</button>
      </div>
    </div>
  </div>`;
}

function updateDetected(row) {
  const found = findDurations(row.querySelector('.text').value);
  row.querySelector('.detected').textContent = found.length ? `Détecté : ${found.map((d) => formatSeconds(d.seconds)).join(', ')}` : '';
}

function renderForm(id) {
  const r = id ? store.getRecipe(id) : null;
  if (id && !r) return notFound();
  const data = store.getData();
  const v = r || { title: '', description: '', categoryIds: home.cat && home.cat !== 'fav' ? [home.cat] : [], servings: 4, prepMinutes: null, cookMinutes: null, image: '', source: '', notes: '', ingredients: [], steps: [] };
  const lines = r ? r.ingredients.map((l) => ({ ...l, name: store.ingredientName(l) })) : [{}, {}, {}];
  const steps = v.steps.length ? v.steps : [{}];

  view.innerHTML = `
  <form id="recipe-form" class="form" novalidate>
    <div class="page-head">
      <a class="back" href="${r ? recipeLink(r.id) : '#/'}" aria-label="Retour">←</a>
      <h1>${r ? 'Modifier la recette' : 'Nouvelle recette'}</h1>
    </div>
    <label class="field"><span>Titre *</span><input name="title" required value="${esc(v.title)}" placeholder="ex : Gratin dauphinois" /></label>
    <div class="field">
      <span>Catégories</span>
      <div class="chips" id="cat-picks">${data.categories
        .map((c) => `<label class="chip toggle"><input type="checkbox" name="cat" value="${esc(c.id)}" ${v.categoryIds.includes(c.id) ? 'checked' : ''} />${esc(c.emoji)} ${esc(c.name)}</label>`)
        .join('')}<button type="button" class="chip add" id="new-cat">＋ Nouvelle</button></div>
    </div>
    <div class="row3">
      <label class="field"><span>Portions</span><input name="servings" type="number" min="1" inputmode="numeric" value="${esc(v.servings ?? '')}" /></label>
      <label class="field"><span>Préparation (min)</span><input name="prepMinutes" type="number" min="0" inputmode="numeric" value="${esc(v.prepMinutes ?? '')}" /></label>
      <label class="field"><span>Cuisson (min)</span><input name="cookMinutes" type="number" min="0" inputmode="numeric" value="${esc(v.cookMinutes ?? '')}" /></label>
    </div>
    <label class="field"><span>Description</span><textarea name="description" rows="2" placeholder="Quelques mots sur la recette">${esc(v.description)}</textarea></label>

    <fieldset class="card">
      <legend>Ingrédients</legend>
      <div id="ing-rows">${lines.map(ingRowHtml).join('')}</div>
      <div class="row-actions">
        <button type="button" class="btn small" id="add-ing">＋ Ingrédient</button>
        <button type="button" class="btn small ghost" id="bulk-ing">📋 Coller une liste</button>
      </div>
      <p class="hint">Les nouveaux ingrédients sont ajoutés automatiquement à ta liste d'ingrédients.</p>
    </fieldset>

    <fieldset class="card">
      <legend>Étapes</legend>
      <div id="step-rows">${steps.map(stepRowHtml).join('')}</div>
      <div class="row-actions"><button type="button" class="btn small" id="add-step">＋ Étape</button></div>
    </fieldset>

    <label class="field"><span>Photo (adresse d'une image)</span><input name="image" type="url" value="${esc(v.image)}" placeholder="https://…" /></label>
    <label class="field"><span>Notes</span><textarea name="notes" rows="2" placeholder="Astuces, variantes…">${esc(v.notes)}</textarea></label>
    <label class="field"><span>Source</span><input name="source" value="${esc(v.source)}" placeholder="Livre, site, mamie…" /></label>

    <div class="form-actions">
      <a class="btn ghost" href="${r ? recipeLink(r.id) : '#/'}">Annuler</a>
      <button class="btn primary" type="submit">💾 Enregistrer</button>
    </div>
  </form>
  <datalist id="ing-datalist">${data.ingredients.map((i) => `<option value="${esc(i.name)}"></option>`).join('')}</datalist>
  <datalist id="unit-list">${UNITS.map((u) => `<option value="${esc(u)}"></option>`).join('')}</datalist>`;

  const form = $('#recipe-form');
  formDirty = false;
  form.addEventListener('input', (e) => {
    formDirty = true;
    const row = e.target.closest('.step-row');
    if (row) updateDetected(row);
  });
  $$('.step-row', form).forEach(updateDetected);

  form.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-row]');
    if (rm) {
      rm.closest('.ing-row, .step-row').remove();
      formDirty = true;
      return;
    }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const row = mv.closest('.ing-row, .step-row');
      const sib = mv.dataset.move === '-1' ? row.previousElementSibling : row.nextElementSibling;
      if (sib) mv.dataset.move === '-1' ? sib.before(row) : sib.after(row);
      formDirty = true;
    }
  });
  $('#add-ing').onclick = () => {
    $('#ing-rows').insertAdjacentHTML('beforeend', ingRowHtml());
    $('#ing-rows').lastElementChild.querySelector('.qty').focus();
  };
  $('#add-step').onclick = () => {
    $('#step-rows').insertAdjacentHTML('beforeend', stepRowHtml());
    $('#step-rows').lastElementChild.querySelector('.text').focus();
  };
  $('#bulk-ing').onclick = async () => {
    const fd = await dialogForm({
      title: '📋 Coller une liste d\'ingrédients',
      submit: 'Ajouter',
      body: `<p class="muted">Un ingrédient par ligne, par exemple :<br>200 g de farine<br>3 œufs<br>1 c. à s. d'huile d'olive</p><textarea name="list" rows="8"></textarea>`,
    });
    if (!fd) return;
    const parsed = String(fd.get('list')).split('\n').map(parseIngredientLine).filter((x) => x && x.name);
    // Fill empty rows first, then append.
    const empty = $$('.ing-row', form).filter((row) => !row.querySelector('.name').value.trim() && !row.querySelector('.qty').value.trim());
    for (const l of parsed) {
      const row = empty.shift();
      if (row) row.outerHTML = ingRowHtml(l);
      else $('#ing-rows').insertAdjacentHTML('beforeend', ingRowHtml(l));
    }
    formDirty = true;
    toast(`${plural(parsed.length, 'ingrédient')} ajouté${parsed.length > 1 ? 's' : ''}`);
  };
  $('#new-cat').onclick = async () => {
    const cat = await categoryDialog();
    if (!cat) return;
    $('#new-cat').insertAdjacentHTML('beforebegin', `<label class="chip toggle"><input type="checkbox" name="cat" value="${esc(cat.id)}" checked />${esc(cat.emoji)} ${esc(cat.name)}</label>`);
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = form.title.value.trim();
    if (!title) {
      form.title.focus();
      return toast('Donne un titre à la recette', 'error');
    }
    const savedId = store.saveRecipe({
      id: r?.id,
      title,
      description: form.description.value,
      categoryIds: $$('input[name="cat"]:checked', form).map((c) => c.value),
      servings: form.servings.value,
      prepMinutes: form.prepMinutes.value,
      cookMinutes: form.cookMinutes.value,
      image: form.image.value,
      source: form.source.value,
      notes: form.notes.value,
      ingredients: $$('.ing-row', form).map((row) => ({
        qty: row.querySelector('.qty').value,
        unit: row.querySelector('.unit').value,
        name: row.querySelector('.name').value,
        note: row.querySelector('.note').value,
      })),
      steps: $$('.step-row', form).map((row) => {
        const min = parseFloat(row.querySelector('.timer').value.replace(',', '.'));
        return { text: row.querySelector('.text').value, timerSeconds: min > 0 ? Math.round(min * 60) : null };
      }),
    });
    formDirty = false;
    location.hash = recipeLink(savedId);
    toast(r ? 'Recette mise à jour' : 'Recette ajoutée 🎉');
  });
}

// ---------- Ingredients ----------

let ingFilter = '';

function renderIngredients() {
  view.innerHTML = `
    <div class="page-head"><h1>🥕 Ingrédients</h1></div>
    <form id="add-ing-form" class="inline-form card">
      <input name="name" placeholder="Nouvel ingrédient (ex : crème fraîche)" required autocomplete="off" />
      <button class="btn primary">Ajouter</button>
    </form>
    <input id="ing-filter" class="search" type="search" placeholder="Filtrer les ingrédients…" value="${esc(ingFilter)}" />
    <p class="muted" id="ing-count"></p>
    <ul class="list" id="ing-list"></ul>`;

  $('#add-ing-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.name;
    const res = store.addIngredient(input.value);
    if (!res) return;
    toast(res.created ? `« ${res.ingredient.name} » ajouté` : `« ${res.ingredient.name} » existe déjà`);
    input.value = '';
    input.focus();
  });
  $('#ing-filter').addEventListener('input', (e) => {
    ingFilter = e.target.value;
    renderIngredientList();
  });
  $('#ing-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const ing = store.getIngredient(btn.dataset.id);
    if (!ing) return;
    const used = store.recipesUsingIngredient(ing.id);
    if (btn.dataset.act === 'search') {
      home.ings = [ing.id];
      home.q = '';
      home.cat = null;
      saveHome();
      location.hash = '#/';
    } else if (btn.dataset.act === 'rename') {
      const fd = await dialogForm({
        title: "Renommer l'ingrédient",
        submit: 'Renommer',
        body: `<label class="field"><span>Nom</span><input name="name" required value="${esc(ing.name)}" /></label>
          <p class="hint">Si le nom correspond à un autre ingrédient, les deux seront fusionnés.</p>`,
      });
      if (fd) store.renameIngredient(ing.id, String(fd.get('name')));
    } else if (btn.dataset.act === 'delete') {
      const msg = used.length
        ? `« ${ing.name} » est utilisé dans ${plural(used.length, 'recette')} (${used.map((r) => r.title).slice(0, 3).join(', ')}${used.length > 3 ? '…' : ''}). Il en sera retiré.`
        : `Supprimer « ${ing.name} » ?`;
      if (await confirmDialog(msg, { title: "Supprimer l'ingrédient", submit: 'Supprimer', danger: true })) store.deleteIngredient(ing.id);
    }
  });
  renderIngredientList();
}

function renderIngredientList() {
  const data = store.getData();
  const q = normalize(ingFilter);
  const items = data.ingredients
    .filter((i) => !q || normalize(i.name).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  $('#ing-count').textContent = `${plural(items.length, 'ingrédient')}${q ? ` sur ${data.ingredients.length}` : ''}`;
  $('#ing-list').innerHTML = items.length
    ? items
        .map((i) => {
          const n = store.recipesUsingIngredient(i.id).length;
          return `<li>
            <span class="name cap">${esc(i.name)}</span>
            ${n ? `<button type="button" class="link" data-act="search" data-id="${esc(i.id)}">${plural(n, 'recette')} →</button>` : '<span class="muted small">inutilisé</span>'}
            <button type="button" class="icon-btn" data-act="rename" data-id="${esc(i.id)}" aria-label="Renommer">✏️</button>
            <button type="button" class="icon-btn" data-act="delete" data-id="${esc(i.id)}" aria-label="Supprimer">🗑</button>
          </li>`;
        })
        .join('')
    : '<li class="muted">Aucun ingrédient.</li>';
}

// ---------- Categories ----------

async function categoryDialog(cat = null) {
  const fd = await dialogForm({
    title: cat ? 'Modifier la catégorie' : 'Nouvelle catégorie',
    submit: cat ? 'Enregistrer' : 'Ajouter',
    body: `<div class="row-emoji">
      <label class="field"><span>Emoji</span><input name="emoji" maxlength="8" value="${esc(cat?.emoji || '')}" placeholder="🍝" /></label>
      <label class="field"><span>Nom</span><input name="name" required value="${esc(cat?.name || '')}" placeholder="ex : Pâtes" /></label>
    </div>`,
  });
  if (!fd) return null;
  return store.saveCategory({ id: cat?.id, name: String(fd.get('name')), emoji: String(fd.get('emoji')) });
}

function renderCategories() {
  const data = store.getData();
  view.innerHTML = `
    <div class="page-head"><h1>🏷️ Catégories</h1><button type="button" class="btn primary small" id="add-cat">＋ Ajouter</button></div>
    <ul class="list">${
      data.categories.length
        ? data.categories
            .map((c) => {
              const n = store.recipesInCategory(c.id).length;
              return `<li>
                <span class="name">${esc(c.emoji)} ${esc(c.name)}</span>
                <a class="link" href="#/" data-cat="${esc(c.id)}">${plural(n, 'recette')} →</a>
                <button type="button" class="icon-btn" data-act="edit" data-id="${esc(c.id)}" aria-label="Modifier">✏️</button>
                <button type="button" class="icon-btn" data-act="delete" data-id="${esc(c.id)}" aria-label="Supprimer">🗑</button>
              </li>`;
            })
            .join('')
        : '<li class="muted">Aucune catégorie. Ajoute-en pour classer tes recettes (Entrées, Desserts, Végétarien…).</li>'
    }</ul>`;
  $('#add-cat').onclick = () => categoryDialog();
  view.querySelector('.list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const cat = store.getCategory(btn.dataset.id);
    if (!cat) return;
    if (btn.dataset.act === 'edit') categoryDialog(cat);
    else if (await confirmDialog(`Supprimer la catégorie « ${cat.name} » ? Les recettes ne sont pas supprimées.`, { submit: 'Supprimer', danger: true })) store.deleteCategory(cat.id);
  });
}

// ---------- Sync settings ----------

function statusText(st) {
  return {
    loading: '↻ Chargement depuis GitHub…',
    saving: '↻ Enregistrement sur GitHub…',
    error: '⚠ Erreur de synchronisation',
    local: st.hasToken ? '● Modifications en attente d\'envoi' : '● Modifications enregistrées sur cet appareil uniquement',
    synced: '✓ À jour avec GitHub',
  }[st.kind];
}

function renderSettings() {
  const s = store.getSettings();
  const st = store.getStatus();
  const fileUrl = `https://github.com/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/blob/${encodeURIComponent(s.branch || 'main')}/${s.path.split('/').map(encodeURIComponent).join('/')}`;
  const tokenUrl = 'https://github.com/settings/personal-access-tokens/new';
  view.innerHTML = `
    <div class="page-head"><h1>⚙️ Synchronisation</h1></div>
    <section class="card status-card ${st.kind}">
      <h2>${statusText(st)}</h2>
      ${st.error ? `<p class="error-text">${esc(st.error)}</p>` : ''}
      ${st.notice ? `<p class="muted">${esc(st.notice)}</p>` : ''}
      <p class="muted">${st.lastSync ? `Dernier échange avec GitHub : ${new Date(st.lastSync).toLocaleString('fr-FR')}` : 'Jamais synchronisé.'}
        ${st.sha ? `· <a href="${esc(fileUrl)}" target="_blank" rel="noopener">voir le fichier sur GitHub</a>` : ''}</p>
      ${!st.hasToken ? '<p>Sans jeton, les recettes sont lues depuis GitHub mais tes modifications restent sur cet appareil. Ajoute un jeton ci-dessous pour les enregistrer dans le dépôt.</p>' : ''}
      <div class="row-actions">
        <button type="button" class="btn primary small" id="sync-now">↻ Synchroniser maintenant</button>
        ${st.dirty ? '<button type="button" class="btn ghost small danger-text" id="discard">Abandonner mes modifs locales</button>' : ''}
      </div>
    </section>

    <form class="card form" id="gh-form">
      <h2>Dépôt GitHub</h2>
      <p class="muted">Les recettes sont stockées dans un fichier JSON du dépôt du site. Chaque modification crée un commit.</p>
      <div class="row2">
        <label class="field"><span>Propriétaire</span><input name="owner" required value="${esc(s.owner)}" autocapitalize="off" /></label>
        <label class="field"><span>Dépôt</span><input name="repo" required value="${esc(s.repo)}" autocapitalize="off" /></label>
      </div>
      <div class="row2">
        <label class="field"><span>Branche</span><input name="branch" value="${esc(s.branch)}" placeholder="branche par défaut" autocapitalize="off" /></label>
        <label class="field"><span>Fichier</span><input name="path" required value="${esc(s.path)}" autocapitalize="off" /></label>
      </div>
      <label class="field"><span>Jeton d'accès (fine-grained token)</span>
        <input name="token" type="password" value="${esc(s.token)}" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" /></label>
      <label class="check"><input type="checkbox" name="autoSync" ${s.autoSync ? 'checked' : ''} /> Enregistrer automatiquement sur GitHub après chaque modification</label>
      <div class="row-actions"><button class="btn primary small">Enregistrer les réglages</button></div>
      <details>
        <summary>Comment créer un jeton ?</summary>
        <ol>
          <li>Ouvre <a href="${tokenUrl}" target="_blank" rel="noopener">github.com → Settings → Fine-grained tokens → Generate new token</a>.</li>
          <li><b>Repository access</b> : « Only select repositories » → <code>${esc(s.repo)}</code>.</li>
          <li><b>Permissions</b> → Repository permissions → <b>Contents : Read and write</b>.</li>
          <li>Génère le jeton, copie-le ici. Il reste uniquement dans ce navigateur (à refaire sur chaque appareil).</li>
        </ol>
        <p class="muted">Garde ce jeton pour toi : il permet de modifier le contenu de ce dépôt.</p>
      </details>
    </form>

    <section class="card">
      <h2>Sauvegarde</h2>
      <div class="row-actions">
        <button type="button" class="btn small" id="export">⬇️ Exporter (JSON)</button>
        <label class="btn small">⬆️ Importer<input type="file" id="import" accept="application/json,.json" hidden /></label>
      </div>
    </section>

    <section class="card">
      <h2>Minuteurs</h2>
      <p class="muted">Une notification peut s'afficher quand un minuteur se termine alors que l'app est en arrière-plan (selon le navigateur ; sur iPhone, depuis l'app ajoutée à l'écran d'accueil).</p>
      <div class="row-actions">
        <button type="button" class="btn small" id="notif">🔔 Autoriser les notifications</button>
        <button type="button" class="btn small" id="test-sound">🔊 Tester le son</button>
      </div>
    </section>`;

  $('#sync-now').onclick = async () => {
    await store.pull();
    await store.push();
    const after = store.getStatus();
    toast(after.error ? after.error : after.dirty ? 'Ajoute un jeton pour envoyer tes modifications' : 'Synchronisé ✓', after.error ? 'error' : '');
  };
  $('#discard') && ($('#discard').onclick = async () => {
    if (await confirmDialog('Remplacer les données de cet appareil par la version de GitHub ? Tes modifications non envoyées seront perdues.', { submit: 'Remplacer', danger: true }))
      store.pull({ discardLocal: true });
  });
  $('#gh-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await store.updateSettings({
      owner: f.owner.value.trim(),
      repo: f.repo.value.trim(),
      branch: f.branch.value.trim(),
      path: f.path.value.trim().replace(/^\/+/, ''),
      token: f.token.value.trim(),
      autoSync: f.autoSync.checked,
    });
    const after = store.getStatus();
    toast(after.error ? after.error : 'Réglages enregistrés', after.error ? 'error' : '');
  });
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(store.getData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `recettes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!(await confirmDialog(`Remplacer toutes les recettes par celles du fichier « ${file.name} » ?`, { submit: 'Importer', danger: true }))) return;
      store.replaceData(json);
      toast('Données importées');
    } catch {
      toast('Fichier JSON invalide', 'error');
    }
  };
  $('#notif').onclick = async () => {
    if (!('Notification' in window)) return toast('Notifications non disponibles ici');
    const res = await Notification.requestPermission();
    toast(res === 'granted' ? 'Notifications autorisées' : 'Notifications refusées');
  };
  $('#test-sound').onclick = () => {
    const t = timers.start('Test du son', 1);
    setTimeout(() => timers.remove(t.id), 4000);
  };
}

// ---------- Header badge, router ----------

function renderBadge() {
  const st = store.getStatus();
  const badge = $('#sync-badge');
  const labels = { loading: '↻', saving: '↻ Envoi…', error: '⚠ Erreur', local: st.hasToken ? '● En attente' : '● Local', synced: '✓ À jour' };
  badge.textContent = labels[st.kind];
  badge.className = `sync-badge ${st.kind}`;
  badge.title = statusText(st) + (st.error ? ` — ${st.error}` : '');
}

const routes = {
  '': renderHome,
  recette: renderRecipe,
  nouvelle: () => renderForm(null),
  modifier: renderForm,
  ingredients: renderIngredients,
  categories: renderCategories,
  reglages: renderSettings,
};

function parseHash() {
  const [name = '', id = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return { name, id: decodeURIComponent(id) };
}

let lastHash = location.hash;
function router() {
  if (formDirty && !confirm('Quitter sans enregistrer la recette ?')) {
    history.replaceState(null, '', lastHash || '#/');
    return;
  }
  formDirty = false;
  lastHash = location.hash;
  const next = parseHash();
  if (next.name !== 'recette' && wantWake) {
    wantWake = false;
    releaseWakeLock();
  }
  const changed = next.name !== current.name || next.id !== current.id;
  current = next;
  (routes[current.name] || notFound)(current.id);
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (current.name === 'recette' ? '' : current.name)));
  if (changed) window.scrollTo(0, 0);
}

// Re-render the current view when data changes (except the form, to keep what is being typed).
store.subscribe((type) => {
  renderBadge();
  if (type === 'data') {
    if (current.name === '') renderHomeResults();
    else if (current.name === 'modifier' || current.name === 'nouvelle') {
      const list = $('#ing-datalist');
      if (list) list.innerHTML = store.getData().ingredients.map((i) => `<option value="${esc(i.name)}"></option>`).join('');
    } else (routes[current.name] || notFound)(current.id);
  } else if (current.name === 'reglages') renderSettings();
  else if (current.name === '' && store.getStatus().kind !== 'loading') renderHomeResults();
});

window.addEventListener('hashchange', router);
window.addEventListener('beforeunload', (e) => {
  if (formDirty || (store.getStatus().kind === 'saving')) e.preventDefault();
});

store.init();
timers.init();
router();
renderBadge();
renderDock();

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});

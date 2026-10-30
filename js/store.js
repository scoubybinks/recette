// Application state: recipes, ingredients and categories, cached in localStorage and committed to the
// GitHub repository of the site (data/recipes.json by default).
//
// Sync model: the last version read from GitHub is kept as the "base". Local edits mark the data dirty
// and are committed after a short delay. If someone else committed in between (another phone, a
// manual edit on github.com), a three-way merge per item (base / local / remote, newest `updatedAt`
// wins, deletions honoured) is applied before committing, so edits from both sides are kept.

import { clone, uid, nowIso, ingredientKey, readJson, writeJson, debounce } from './utils.js';
import { fetchFile, putFile, getDefaultBranch } from './github.js';

const K = {
  settings: 'recettes.settings.v1',
  data: 'recettes.data.v1',
  base: 'recettes.base.v1',
  dirty: 'recettes.dirty.v1',
  labels: 'recettes.labels.v1',
  lastSync: 'recettes.lastSync.v1',
};
const EPOCH = '2000-01-01T00:00:00.000Z';
const BUNDLED_URL = './data/recipes.json';

const state = {
  settings: null,
  data: null,
  base: { sha: null, data: null },
  dirty: false,
  rev: 0,
  labels: [],
  lastSync: null,
  phase: 'idle', // idle | loading | saving
  error: null,
  notice: null,
};

const listeners = new Set();
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (type) => listeners.forEach((fn) => fn(type));

// ---------- Settings ----------

// Guesses the repository from the GitHub Pages URL: https://<owner>.github.io/<repo>/
export function defaultSettings() {
  const s = { owner: 'scoubybinks', repo: 'recette', branch: '', path: 'data/recipes.json', token: '', autoSync: true };
  if (location.hostname.endsWith('.github.io')) {
    s.owner = location.hostname.split('.')[0];
    const segs = location.pathname.replace(/[^/]*$/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (segs.length) {
      s.repo = segs[0];
      s.path = [...segs.slice(1), 'data', 'recipes.json'].join('/');
    } else {
      s.repo = location.hostname;
      s.path = 'data/recipes.json';
    }
  }
  return s;
}

export const getSettings = () => ({ ...state.settings });

export function updateSettings(patch) {
  const prev = state.settings;
  state.settings = { ...prev, ...patch };
  writeJson(K.settings, state.settings);
  const moved = ['owner', 'repo', 'branch', 'path'].some((k) => prev[k] !== state.settings[k]);
  if (moved) {
    state.base = { sha: null, data: null };
    persist();
    return pull();
  }
  if (state.dirty && state.settings.token && state.settings.autoSync) return push();
  emit('status');
  return Promise.resolve();
}

// ---------- Data shape ----------

export function emptyData() {
  return { version: 1, updatedAt: nowIso(), categories: [], ingredients: [], recipes: [] };
}

const str = (v) => (v == null ? '' : String(v));
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));

// Validates any JSON (from GitHub, an import or localStorage) into the shape the app expects and repairs
// references: unknown ingredients are recreated from the name kept in the recipe, duplicates merged.
export function normalizeData(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const out = { version: 1, updatedAt: str(d.updatedAt) || EPOCH, categories: [], ingredients: [], recipes: [] };
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && x.id) : []);

  for (const c of arr(d.categories)) {
    if (!str(c.name).trim()) continue;
    out.categories.push({ id: str(c.id), name: str(c.name).trim(), emoji: str(c.emoji), updatedAt: str(c.updatedAt) || EPOCH });
  }

  const byId = new Map();
  const byKey = new Map();
  const remap = new Map();
  for (const i of arr(d.ingredients)) {
    const name = str(i.name).trim();
    if (!name) continue;
    const key = ingredientKey(name);
    if (byKey.has(key)) {
      remap.set(str(i.id), byKey.get(key).id);
      continue;
    }
    const ing = { id: str(i.id), name, updatedAt: str(i.updatedAt) || EPOCH };
    out.ingredients.push(ing);
    byId.set(ing.id, ing);
    byKey.set(key, ing);
  }

  const catIds = new Set(out.categories.map((c) => c.id));
  for (const r of arr(d.recipes)) {
    const lines = [];
    for (const l of Array.isArray(r.ingredients) ? r.ingredients : []) {
      if (!l) continue;
      const id = remap.get(str(l.ingredientId)) || str(l.ingredientId);
      let ing = byId.get(id);
      if (!ing) {
        const name = str(l.name).trim();
        if (!name) continue;
        ing = byKey.get(ingredientKey(name));
        if (!ing) {
          ing = { id: id || uid('i_'), name, updatedAt: str(r.updatedAt) || EPOCH };
          out.ingredients.push(ing);
          byId.set(ing.id, ing);
          byKey.set(ingredientKey(name), ing);
        }
      }
      lines.push({ ingredientId: ing.id, name: ing.name, qty: str(l.qty), unit: str(l.unit), note: str(l.note) });
    }
    const steps = (Array.isArray(r.steps) ? r.steps : [])
      .map((s) => (typeof s === 'string' ? { text: s, timerSeconds: null } : { text: str(s?.text), timerSeconds: num(s?.timerSeconds) }))
      .filter((s) => s.text.trim() || s.timerSeconds);
    out.recipes.push({
      id: str(r.id),
      title: str(r.title).trim() || 'Sans titre',
      description: str(r.description),
      categoryIds: (Array.isArray(r.categoryIds) ? r.categoryIds.map(str) : []).filter((id) => catIds.has(id)),
      servings: num(r.servings),
      prepMinutes: num(r.prepMinutes),
      cookMinutes: num(r.cookMinutes),
      image: str(r.image),
      source: str(r.source),
      notes: str(r.notes),
      favorite: !!r.favorite,
      ingredients: lines,
      steps,
      createdAt: str(r.createdAt) || str(r.updatedAt) || EPOCH,
      updatedAt: str(r.updatedAt) || EPOCH,
    });
  }
  return out;
}

const serialize = (data) => JSON.stringify(data, null, 2) + '\n';

function mergeList(baseList, localList, remoteList) {
  const B = new Map((baseList || []).map((x) => [x.id, x]));
  const L = new Map(localList.map((x) => [x.id, x]));
  const R = new Map(remoteList.map((x) => [x.id, x]));
  const out = [];
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const b = B.get(id);
    const l = L.get(id);
    const r = R.get(id);
    if (l && r) out.push(r.updatedAt > l.updatedAt ? r : l);
    else if (l) {
      if (!b || l.updatedAt > b.updatedAt) out.push(l); // deleted remotely unless edited locally since
    } else if (!b || r.updatedAt > b.updatedAt) out.push(r); // deleted locally unless edited remotely since
  }
  return out;
}

export function merge(base, local, remote) {
  const b = base || {};
  return normalizeData({
    updatedAt: nowIso(),
    categories: mergeList(b.categories, local.categories, remote.categories),
    ingredients: mergeList(b.ingredients, local.ingredients, remote.ingredients),
    recipes: mergeList(b.recipes, local.recipes, remote.recipes),
  });
}

// ---------- Persistence & status ----------

function persist() {
  writeJson(K.data, state.data);
  writeJson(K.base, state.base);
  writeJson(K.dirty, state.dirty);
  writeJson(K.labels, state.labels);
  writeJson(K.lastSync, state.lastSync);
}

export const getData = () => state.data;

export function getStatus() {
  const { phase, error, dirty, lastSync, notice } = state;
  const hasToken = !!state.settings.token;
  let kind;
  if (phase === 'loading') kind = 'loading';
  else if (phase === 'saving') kind = 'saving';
  else if (error) kind = 'error';
  else if (dirty) kind = 'local';
  else kind = 'synced';
  return { kind, error, dirty, lastSync, hasToken, notice, sha: state.base.sha };
}

function setPhase(phase) {
  state.phase = phase;
  emit('status');
}

// Operations touching GitHub run one after the other.
let chain = Promise.resolve();
function exclusive(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function ensureBranch() {
  if (state.settings.branch) return;
  state.settings.branch = await getDefaultBranch(state.settings);
  writeJson(K.settings, state.settings);
}

async function fetchRemote() {
  const file = await fetchFile(state.settings);
  if (!file) return null;
  let json;
  try {
    json = JSON.parse(file.text);
  } catch {
    throw new Error(`Le fichier ${state.settings.path} sur GitHub n'est pas un JSON valide.`);
  }
  return { sha: file.sha, data: normalizeData(json) };
}

async function fetchBundled() {
  try {
    const res = await fetch(BUNDLED_URL, { cache: 'no-store' });
    return res.ok ? normalizeData(await res.json()) : null;
  } catch {
    return null;
  }
}

const isEmpty = (d) => !d.recipes.length && !d.ingredients.length && !d.categories.length;

// Reads the latest version from GitHub. Local unsent edits are merged on top unless discardLocal.
export function pull({ discardLocal = false } = {}) {
  return exclusive(async () => {
    setPhase('loading');
    state.notice = null;
    try {
      await ensureBranch();
      const remote = await fetchRemote();
      if (!remote) {
        // The file does not exist on this branch yet: start from the copy shipped with the site.
        if (discardLocal || isEmpty(state.data)) {
          state.data = (await fetchBundled()) || emptyData();
          state.dirty = false;
          state.labels = [];
        }
        state.base = { sha: null, data: null };
        state.notice = `Le fichier ${state.settings.path} n'existe pas encore sur la branche ${state.settings.branch} : il sera créé au premier enregistrement.`;
      } else if (!state.dirty || discardLocal) {
        state.data = clone(remote.data); // the base must never share objects with the edited data
        state.base = remote;
        state.dirty = false;
        state.labels = [];
      } else {
        state.data = merge(state.base.data, state.data, remote.data);
        state.base = remote;
      }
      state.error = null;
      state.lastSync = nowIso();
    } catch (e) {
      state.error = e.message || String(e);
      if (isEmpty(state.data)) {
        const bundled = await fetchBundled();
        if (bundled) state.data = bundled;
      }
    } finally {
      state.phase = 'idle';
      persist();
      emit('data');
      emit('status');
    }
    if (state.dirty && !state.error) scheduleSync();
  });
}

function commitMessage(labels) {
  const uniq = [...new Set(labels)];
  if (!uniq.length) return 'Recettes : mise à jour des données';
  const shown = uniq.slice(0, 3).join(', ');
  return `Recettes : ${shown}${uniq.length > 3 ? ` et ${uniq.length - 3} autre(s) modification(s)` : ''}`;
}

// Commits local edits to GitHub (requires a token with "Contents: read and write" on the repository).
export function push() {
  return exclusive(async () => {
    if (!state.dirty || !state.settings.token) return emit('status');
    setPhase('saving');
    try {
      await ensureBranch();
      for (let attempt = 0; ; attempt++) {
        const remote = await fetchRemote();
        if (remote && remote.sha !== state.base.sha) {
          state.data = merge(state.base.data, state.data, remote.data);
          state.base = remote;
          emit('data');
        }
        const startRev = state.rev;
        const labels = state.labels.slice();
        const text = serialize(state.data);
        try {
          const sha = await putFile(state.settings, text, remote?.sha, commitMessage(labels));
          state.base = { sha, data: JSON.parse(text) };
          state.labels = state.labels.slice(labels.length);
          state.dirty = state.rev !== startRev;
          state.lastSync = nowIso();
          state.notice = null;
          break;
        } catch (e) {
          // Someone committed between our read and our write: read again, merge, retry.
          if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
          throw e;
        }
      }
      state.error = null;
    } catch (e) {
      state.error = e.message || String(e);
    } finally {
      state.phase = 'idle';
      persist();
      emit('status');
    }
    if (state.dirty && !state.error) scheduleSync();
  });
}

const scheduleSync = debounce(() => {
  if (state.dirty && state.settings.token && state.settings.autoSync) push();
}, 1500);

// Records a local edit.
function commit(label) {
  state.data.updatedAt = nowIso();
  state.rev++;
  state.dirty = true;
  state.error = null;
  if (label) state.labels.push(label);
  persist();
  emit('data');
  emit('status');
  scheduleSync();
}

export function init() {
  state.settings = { ...defaultSettings(), ...readJson(K.settings, {}) };
  const saved = readJson(K.data, null);
  state.data = saved ? normalizeData(saved) : emptyData();
  const base = readJson(K.base, null);
  state.base = base && base.data ? { sha: base.sha, data: normalizeData(base.data) } : { sha: base?.sha || null, data: null };
  state.dirty = !!readJson(K.dirty, false);
  state.labels = readJson(K.labels, []);
  state.lastSync = readJson(K.lastSync, null);
  return pull();
}

// Replaces everything (JSON import). Committed like any other edit.
export function replaceData(raw) {
  const incoming = normalizeData(raw);
  const ts = nowIso();
  for (const list of [incoming.categories, incoming.ingredients, incoming.recipes]) for (const x of list) x.updatedAt = ts;
  // Items missing from the import are absent locally but unchanged since the base: the merge drops them.
  state.data = incoming;
  commit('import de données');
}

// ---------- Lookups ----------

export const getRecipe = (id) => state.data.recipes.find((r) => r.id === id);
export const getIngredient = (id) => state.data.ingredients.find((i) => i.id === id);
export const getCategory = (id) => state.data.categories.find((c) => c.id === id);
export const findIngredientByName = (name) => {
  const key = ingredientKey(name);
  return state.data.ingredients.find((i) => ingredientKey(i.name) === key);
};
export const ingredientName = (line) => getIngredient(line.ingredientId)?.name || line.name;
export const recipesUsingIngredient = (id) => state.data.recipes.filter((r) => r.ingredients.some((l) => l.ingredientId === id));
export const recipesInCategory = (id) => state.data.recipes.filter((r) => r.categoryIds.includes(id));

// ---------- Mutations ----------

function ensureIngredient(name, ts) {
  let ing = findIngredientByName(name);
  if (!ing) {
    ing = { id: uid('i_'), name: name.trim(), updatedAt: ts };
    state.data.ingredients.push(ing);
  }
  return ing;
}

// input: recipe fields, with ingredients as [{ name, qty, unit, note }]. Returns the recipe id.
export function saveRecipe(input) {
  const ts = nowIso();
  const existing = input.id ? getRecipe(input.id) : null;
  const ingredients = input.ingredients
    .filter((l) => l.name.trim())
    .map((l) => {
      const ing = ensureIngredient(l.name, ts);
      return { ingredientId: ing.id, name: ing.name, qty: l.qty.trim(), unit: l.unit.trim(), note: l.note.trim() };
    });
  const recipe = {
    id: existing ? existing.id : uid('r_'),
    title: input.title.trim() || 'Sans titre',
    description: input.description.trim(),
    categoryIds: input.categoryIds.filter((id) => getCategory(id)),
    servings: num(input.servings),
    prepMinutes: num(input.prepMinutes),
    cookMinutes: num(input.cookMinutes),
    image: input.image.trim(),
    source: input.source.trim(),
    notes: input.notes.trim(),
    favorite: existing ? existing.favorite : false,
    ingredients,
    steps: input.steps.filter((s) => s.text.trim() || s.timerSeconds).map((s) => ({ text: s.text.trim(), timerSeconds: num(s.timerSeconds) })),
    createdAt: existing ? existing.createdAt : ts,
    updatedAt: ts,
  };
  if (existing) Object.assign(existing, recipe);
  else state.data.recipes.unshift(recipe);
  commit(`${existing ? 'modification' : 'ajout'} de « ${recipe.title} »`);
  return recipe.id;
}

export function deleteRecipe(id) {
  const r = getRecipe(id);
  if (!r) return;
  state.data.recipes = state.data.recipes.filter((x) => x.id !== id);
  commit(`suppression de « ${r.title} »`);
}

export function toggleFavorite(id) {
  const r = getRecipe(id);
  if (!r) return;
  r.favorite = !r.favorite;
  r.updatedAt = nowIso();
  commit(`${r.favorite ? 'ajout' : 'retrait'} de « ${r.title} » ${r.favorite ? 'aux' : 'des'} favoris`);
}

export function addIngredient(name) {
  const clean = name.trim();
  if (!clean) return null;
  const existing = findIngredientByName(clean);
  if (existing) return { ingredient: existing, created: false };
  const ingredient = ensureIngredient(clean, nowIso());
  commit(`ajout de l'ingrédient « ${clean} »`);
  return { ingredient, created: true };
}

// Renames an ingredient; if the new name matches another ingredient, both are merged into that one.
export function renameIngredient(id, name) {
  const ing = getIngredient(id);
  const clean = name.trim();
  if (!ing || !clean) return;
  const ts = nowIso();
  const other = findIngredientByName(clean);
  const target = other && other.id !== id ? other : ing;
  if (target === ing) {
    ing.name = clean;
    ing.updatedAt = ts;
  } else {
    state.data.ingredients = state.data.ingredients.filter((x) => x.id !== id);
  }
  for (const r of state.data.recipes) {
    let touched = false;
    for (const l of r.ingredients) {
      if (l.ingredientId === id || l.ingredientId === target.id) {
        l.ingredientId = target.id;
        l.name = target.name;
        touched = true;
      }
    }
    if (touched) r.updatedAt = ts;
  }
  commit(target === ing ? `ingrédient renommé en « ${clean} »` : `fusion de « ${ing.name} » dans « ${target.name} »`);
}

export function deleteIngredient(id) {
  const ing = getIngredient(id);
  if (!ing) return;
  const ts = nowIso();
  state.data.ingredients = state.data.ingredients.filter((x) => x.id !== id);
  for (const r of state.data.recipes) {
    const before = r.ingredients.length;
    r.ingredients = r.ingredients.filter((l) => l.ingredientId !== id);
    if (r.ingredients.length !== before) r.updatedAt = ts;
  }
  commit(`suppression de l'ingrédient « ${ing.name} »`);
}

export function saveCategory({ id, name, emoji }) {
  const clean = name.trim();
  if (!clean) return null;
  const ts = nowIso();
  let cat = id ? getCategory(id) : null;
  if (cat) Object.assign(cat, { name: clean, emoji: emoji.trim(), updatedAt: ts });
  else {
    cat = { id: uid('c_'), name: clean, emoji: emoji.trim(), updatedAt: ts };
    state.data.categories.push(cat);
  }
  commit(`${id ? 'modification' : 'ajout'} de la catégorie « ${clean} »`);
  return cat;
}

export function deleteCategory(id) {
  const cat = getCategory(id);
  if (!cat) return;
  const ts = nowIso();
  state.data.categories = state.data.categories.filter((c) => c.id !== id);
  for (const r of state.data.recipes) {
    if (r.categoryIds.includes(id)) {
      r.categoryIds = r.categoryIds.filter((c) => c !== id);
      r.updatedAt = ts;
    }
  }
  commit(`suppression de la catégorie « ${cat.name} »`);
}

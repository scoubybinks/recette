// Small helpers shared by every module: escaping, ids, text normalisation, quantities and durations.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export const nowIso = () => new Date().toISOString();

export const clone = (obj) => JSON.parse(JSON.stringify(obj));

// Lowercase, accent-free, punctuation-free version of a string, used for search and deduplication.
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Key used to consider two ingredient names identical ("Tomates" == "tomate", "Œufs" == "oeuf").
export function ingredientKey(name) {
  return normalize(name)
    .split(' ')
    .map((w) => (w.length > 3 ? w.replace(/[sx]$/, '') : w))
    .join(' ');
}

export function capitalize(text) {
  const s = String(text ?? '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Quantities ----------

const UNICODE_FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

// "1,5" → 1.5, "1/2" → 0.5, "1 1/2" → 1.5, "½" → 0.5. Returns null when not a plain number.
export function parseQty(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  s = s.replace(/[½¼¾⅓⅔⅛]/g, (c) => ' ' + UNICODE_FRACTIONS[c]).replace(',', '.').trim();
  let m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return parseInt(m[1], 10) + parseInt(m[2], 10) / parseInt(m[3], 10);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  m = s.match(/^(\d+)\s+(0?\.\d+)$/);
  if (m) return parseInt(m[1], 10) + parseFloat(m[2]);
  return null;
}

export function formatQty(n) {
  if (n == null || !isFinite(n)) return '';
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  const nice = [[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']];
  if (frac < 0.02) return String(whole);
  if (frac > 0.98) return String(whole + 1);
  if (n < 10) {
    for (const [v, sym] of nice) if (Math.abs(frac - v) < 0.03) return whole ? `${whole} ${sym}` : sym;
  }
  const digits = n >= 10 ? 0 : 1;
  return String(Number(n.toFixed(digits))).replace('.', ',');
}

// Scales a quantity string; leaves free text ("une pincée") untouched.
export function scaleQty(raw, factor) {
  if (factor === 1) return String(raw ?? '');
  const n = parseQty(raw);
  return n == null ? String(raw ?? '') : formatQty(n * factor);
}

// ---------- Durations ----------

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatMinutes(min) {
  const m = Math.round(Number(min) || 0);
  if (m <= 0) return '';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

export function formatSeconds(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s < 60) return `${s} s`;
  if (s % 60 === 0) return formatMinutes(s / 60);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

const DURATION_RE = /(\d+(?:[.,]\d+)?)(?:\s*(?:à|-|–)\s*(\d+(?:[.,]\d+)?))?\s*(heures?|minutes?|mins?|mn|secondes?|secs?|h|s)(?!\p{L})/giu;

// Finds durations written in a step ("cuire 10 à 12 minutes", "laisser reposer 1 h 30").
// Returns [{ index, length, text, seconds }]; for ranges the lower bound is used, to check early.
export function findDurations(text) {
  const out = [];
  const src = String(text ?? '');
  DURATION_RE.lastIndex = 0;
  let m;
  while ((m = DURATION_RE.exec(src))) {
    const value = parseFloat(m[1].replace(',', '.'));
    const unit = m[3].toLowerCase();
    let seconds = unit.startsWith('h') ? value * 3600 : unit.startsWith('s') ? value : value * 60;
    let length = m[0].length;
    if (unit.startsWith('h')) {
      const tail = src.slice(m.index + length).match(/^\s*(\d{1,2})(?:\s*(?:min(?:utes?)?|mn)(?!\p{L})|(?![\d\p{L}]))/u);
      if (tail) {
        seconds += parseInt(tail[1], 10) * 60;
        length += tail[0].length;
        DURATION_RE.lastIndex = m.index + length;
      }
    }
    if (seconds > 0 && seconds <= 48 * 3600) {
      out.push({ index: m.index, length, text: src.slice(m.index, m.index + length), seconds: Math.round(seconds) });
    }
  }
  return out;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or disabled: the app keeps working in memory */
  }
}

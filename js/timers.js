// Kitchen timers: several can run at once, they survive a page reload (end time stored, not a countdown)
// and ring with a beep, a vibration and a notification when they reach zero.

import { uid, readJson, writeJson } from './utils.js';

const KEY = 'recettes.timers.v1';
let timers = readJson(KEY, []);
const listeners = new Set();
let interval = null;
let audioCtx = null;
let alarmLoop = null;

export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (type) => listeners.forEach((fn) => fn(type));
const save = () => writeJson(KEY, timers);

export const list = () => timers;
export const byKey = (key) => timers.find((t) => t.key === key && t.status !== 'done');

export function remaining(t) {
  if (t.status === 'running') return Math.max(0, (t.endAt - Date.now()) / 1000);
  if (t.status === 'paused') return t.remaining;
  return 0;
}

// iOS/Safari only allow sound after a user gesture: call this from a click handler.
export function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((offset, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 2 ? 1175 : 880;
    gain.gain.setValueAtTime(0.0001, t0 + offset);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + offset);
    osc.stop(t0 + offset + 0.22);
  });
}

function ringing() {
  return timers.some((t) => t.status === 'done' && !t.acknowledged);
}

function startAlarm() {
  if (alarmLoop) return;
  const startedAt = Date.now();
  const ring = () => {
    if (!ringing() || Date.now() - startedAt > 2 * 60 * 1000) return stopAlarm();
    beep();
    navigator.vibrate?.([300, 150, 300]);
  };
  ring();
  alarmLoop = setInterval(ring, 1500);
}

function stopAlarm() {
  clearInterval(alarmLoop);
  alarmLoop = null;
}

function notify(t) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification('⏰ Minuteur terminé', { body: t.label, tag: t.id });
    }
  } catch {
    /* notifications unsupported in this context (e.g. iOS outside the home-screen app) */
  }
}

function tick() {
  let finished = false;
  for (const t of timers) {
    if (t.status === 'running' && t.endAt <= Date.now()) {
      t.status = 'done';
      t.finishedAt = Date.now();
      t.acknowledged = false;
      finished = true;
      notify(t);
    }
  }
  if (finished) {
    save();
    emit('change');
    startAlarm();
  }
  emit('tick');
  if (!timers.some((t) => t.status === 'running')) {
    clearInterval(interval);
    interval = null;
  }
}

function ensureTicking() {
  if (!interval && timers.some((t) => t.status === 'running')) interval = setInterval(tick, 250);
}

// meta: { key, recipeId } — the key avoids starting the same step timer twice.
export function start(label, seconds, meta = {}) {
  unlockAudio();
  if (meta.key) {
    const existing = byKey(meta.key);
    if (existing) return existing;
  }
  const t = {
    id: uid('t_'),
    key: meta.key || null,
    recipeId: meta.recipeId || null,
    label,
    total: Math.max(1, Math.round(seconds)),
    endAt: Date.now() + Math.round(seconds) * 1000,
    remaining: null,
    status: 'running',
  };
  timers.push(t);
  save();
  ensureTicking();
  emit('change');
  return t;
}

const find = (id) => timers.find((t) => t.id === id);

export function pause(id) {
  const t = find(id);
  if (!t || t.status !== 'running') return;
  t.remaining = remaining(t);
  t.status = 'paused';
  save();
  emit('change');
}

export function resume(id) {
  unlockAudio();
  const t = find(id);
  if (!t || t.status !== 'paused') return;
  t.endAt = Date.now() + t.remaining * 1000;
  t.status = 'running';
  save();
  ensureTicking();
  emit('change');
}

export function addTime(id, seconds) {
  unlockAudio();
  const t = find(id);
  if (!t) return;
  if (t.status === 'running') t.endAt += seconds * 1000;
  else if (t.status === 'paused') t.remaining += seconds;
  else {
    t.status = 'running';
    t.endAt = Date.now() + seconds * 1000;
  }
  t.total += seconds;
  save();
  ensureTicking();
  emit('change');
}

export function restart(id) {
  unlockAudio();
  const t = find(id);
  if (!t) return;
  t.status = 'running';
  t.endAt = Date.now() + t.total * 1000;
  save();
  ensureTicking();
  emit('change');
}

export function remove(id) {
  timers = timers.filter((t) => t.id !== id);
  if (!ringing()) stopAlarm();
  save();
  emit('change');
}

export function acknowledgeAll() {
  timers.forEach((t) => {
    if (t.status === 'done') t.acknowledged = true;
  });
  stopAlarm();
  save();
  emit('change');
}

export function init() {
  // Timers that ended while the page was closed are shown as finished (no sound until a gesture).
  ensureTicking();
  tick();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
}

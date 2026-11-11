'use strict';
/* =====================================================================
   YGO Karten-Sortierer
   - Kartendatenbank: YGOPRODeck API (einmal laden, in IndexedDB cachen)
   - Erkennung: Tesseract.js OCR auf Set-Code und/oder Kartennamen
   - Regeln: erste passende Regel bestimmt Stapel / Farbe / Ton
   ===================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const euro = v => (v ? v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }) : '–');

const API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

/* ---------------------------------------------------------------- Storage */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ygo.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { localStorage.setItem('ygo.' + k, JSON.stringify(v)); },
};
let idbPromise;
function idb() {
  idbPromise ??= new Promise((res, rej) => {
    const r = indexedDB.open('ygo-sorter', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return idbPromise;
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

/* --------------------------------------------------------------- Settings */
const DEFAULT_SETTINGS = {
  lang: 'de', scanMode: 'both', interval: 600, confirmations: 2, minScore: 0.72,
  sound: true, speech: true, vibrate: true, addToCollection: true, ignoreUnmatched: false,
  defaultPile: 'Rest', debug: false,
};
const settings = { ...DEFAULT_SETTINGS, ...LS.get('settings', {}) };
const saveSettings = () => LS.set('settings', settings);

/* ------------------------------------------------------- Übersetzungen */
const ATTR_DE = { DARK: 'FINSTERNIS', LIGHT: 'LICHT', EARTH: 'ERDE', WATER: 'WASSER', FIRE: 'FEUER', WIND: 'WIND', DIVINE: 'GÖTTLICH' };
const RACE_DE = {
  Spellcaster: 'Hexer', Dragon: 'Drache', Zombie: 'Zombie', Warrior: 'Krieger', 'Beast-Warrior': 'Ungeheuer-Krieger', Beast: 'Ungeheuer',
  'Winged Beast': 'Geflügeltes Ungeheuer', Fiend: 'Unterweltler', Fairy: 'Fee', Insect: 'Insekt', Dinosaur: 'Dinosaurier', Reptile: 'Reptil',
  Fish: 'Fisch', 'Sea Serpent': 'Seeschlange', Aqua: 'Aqua', Pyro: 'Pyro', Thunder: 'Donner', Rock: 'Fels', Plant: 'Pflanze', Machine: 'Maschine',
  Psychic: 'Psi', 'Divine-Beast': 'Göttliches Ungeheuer', Wyrm: 'Wyrm', Cyberse: 'Cyberse', Illusion: 'Illusion', 'Creator-God': 'Schöpfergott',
};
const ST_DE = { Normal: 'Normal', Field: 'Feld', Equip: 'Ausrüstung', Continuous: 'Permanent', 'Quick-Play': 'Schnell', Ritual: 'Ritual', Counter: 'Konter' };
const FRAME_DE = { normal: 'Normal', effect: 'Effekt', ritual: 'Ritual', fusion: 'Fusion', synchro: 'Synchro', xyz: 'Xyz', link: 'Link', token: 'Token' };
const BAN_DE = { Banned: 'Verboten', Limited: 'Limitiert', 'Semi-Limited': 'Semi-Limitiert' };

function category(c) {
  const t = c.t || '';
  if (t.includes('Spell')) return 'Zauber';
  if (t.includes('Trap')) return 'Falle';
  if (t.includes('Token')) return 'Token';
  if (t.includes('Skill')) return 'Skill';
  return 'Monster';
}
const isMonster = c => category(c) === 'Monster';
function monsterArt(c) {
  if (!isMonster(c)) return '';
  const f = c.f || '';
  let s = FRAME_DE[f.replace('_pendulum', '')] || f;
  if (f.includes('pendulum')) s += ' (Pendel)';
  return s;
}
function deckOf(c) {
  const cat = category(c);
  if (cat === 'Token' || cat === 'Skill') return '';
  return /fusion|synchro|xyz|link/.test(c.f || '') ? 'Extra Deck' : 'Main Deck';
}
const displayName = c => (settings.lang === 'de' && c.nd ? c.nd : c.n);

/* ------------------------------------------------- Felder für Regeln */
// c = Karte, s = Druck {code, name, rarities[]} oder null (wenn nur über Namen erkannt)
const FIELDS = {
  kategorie: { label: 'Kategorie', get: c => category(c), values: ['Monster', 'Zauber', 'Falle', 'Token', 'Skill'] },
  monsterart: { label: 'Monster-Art', get: c => monsterArt(c), values: ['Normal', 'Effekt', 'Ritual', 'Fusion', 'Synchro', 'Xyz', 'Link', 'Pendel'] },
  deck: { label: 'Deck', get: c => deckOf(c), values: ['Main Deck', 'Extra Deck'] },
  attribut: { label: 'Attribut', get: c => ATTR_DE[c.a] || '', values: Object.values(ATTR_DE) },
  typ: { label: 'Typ / Zauber-/Fallenart', get: c => (isMonster(c) ? RACE_DE[c.r] || c.r || '' : ST_DE[c.r] || c.r || ''), values: [...new Set([...Object.values(RACE_DE), ...Object.values(ST_DE)])] },
  stufe: { label: 'Stufe / Rang / Link', num: true, get: c => c.l ?? '' },
  atk: { label: 'ATK', num: true, get: c => c.atk ?? '' },
  def: { label: 'DEF', num: true, get: c => c.def ?? '' },
  archetyp: { label: 'Archetyp', get: c => c.ar || '' },
  name: { label: 'Name', get: c => displayName(c) },
  anfangsbuchstabe: { label: 'Anfangsbuchstabe', get: c => (displayName(c).match(/[A-Za-zÄÖÜäöü0-9]/)?.[0] || '#').toUpperCase() },
  preis: { label: 'Preis (€ Cardmarket)', num: true, get: c => c.p || 0 },
  set: { label: 'Set-Kürzel', get: (c, s) => (s?.code ? s.code.split('-')[0] : '') },
  setname: { label: 'Set-Name', get: (c, s) => s?.name || '' },
  seltenheit: { label: 'Seltenheit', get: (c, s) => (s?.rarities || []).join(' / ') },
  banlist: { label: 'Banlist (TCG)', get: c => BAN_DE[c.b] || 'Unbegrenzt', values: ['Verboten', 'Limitiert', 'Semi-Limitiert', 'Unbegrenzt'] },
};
const OPS = { eq: '=', ne: '≠', contains: 'enthält', starts: 'beginnt mit', gt: '>', ge: '≥', lt: '<', le: '≤', empty: 'ist leer', notempty: 'ist nicht leer' };

function testCond(cond, c, s) {
  const f = FIELDS[cond.field];
  if (!f) return false;
  const v = f.get(c, s);
  const sv = String(v).toLowerCase();
  const opts = String(cond.value ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const n = Number(String(cond.value).replace(',', '.'));
  const has = v !== '' && v !== null && v !== undefined;
  switch (cond.op) {
    case 'eq': return f.num ? has && Number(v) === n : opts.some(o => sv === o);
    case 'ne': return f.num ? !(has && Number(v) === n) : !opts.some(o => sv === o);
    case 'contains': return opts.some(o => sv.includes(o));
    case 'starts': return opts.some(o => sv.startsWith(o));
    case 'gt': return has && Number(v) > n;
    case 'ge': return has && Number(v) >= n;
    case 'lt': return has && Number(v) < n;
    case 'le': return has && Number(v) <= n;
    case 'empty': return !has;
    case 'notempty': return has;
  }
  return false;
}
function fillTemplate(str, c, s) {
  return String(str || '').replace(/\{(\w+)\}/g, (m, k) => {
    const f = FIELDS[k.toLowerCase()];
    if (!f) return m;
    const v = f.get(c, s);
    return v === '' || v === null ? '–' : String(v);
  });
}
function evaluate(c, s) {
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.conds.every(cd => testCond(cd, c, s))) return { rule: r, pile: fillTemplate(r.pile, c, s) || r.name, color: r.color };
  }
  return null;
}

/* ------------------------------------------------------- Regel-Vorlagen */
const R = (name, conds, pile, color, extra = {}) => ({ name, conds: conds.map(([field, op, value = '']) => ({ field, op, value })), pile, color, ...extra });
const PRESETS = {
  kategorie: { label: 'Nach Kategorie (Monster / Zauber / Falle)', rules: [
    R('Monster', [['kategorie', 'eq', 'Monster']], 'Monster', '#e0892b'),
    R('Zauber', [['kategorie', 'eq', 'Zauber']], 'Zauber', '#1fa37a'),
    R('Fallen', [['kategorie', 'eq', 'Falle']], 'Fallen', '#b0407f'),
  ] },
  attribut: { label: 'Monster nach Attribut, Zauber/Fallen getrennt', rules: [
    R('Monster nach Attribut', [['kategorie', 'eq', 'Monster']], '{attribut}', '#e0892b'),
    R('Zauber & Fallen', [['kategorie', 'eq', 'Zauber, Falle']], '{kategorie}', '#1fa37a'),
  ] },
  deck: { label: 'Main Deck / Extra Deck', rules: [
    R('Extra Deck nach Art', [['deck', 'eq', 'Extra Deck']], 'Extra: {monsterart}', '#8a63d2'),
    R('Main Deck', [['deck', 'eq', 'Main Deck']], 'Main: {kategorie}', '#e0892b'),
  ] },
  wert: { label: 'Nach Wert (Wertvolle Karten mit Alarm)', rules: [
    R('Wertvoll', [['preis', 'ge', '5']], 'WERTVOLL (≥ 5 €)', '#e5484d', { alarm: true }),
    R('Mittel', [['preis', 'ge', '1']], '1 – 5 €', '#f5a524'),
    R('Bulk', [], 'Bulk', '#6b7280'),
  ] },
  archetyp: { label: 'Nach Archetyp', rules: [
    R('Archetyp', [['archetyp', 'notempty']], '{archetyp}', '#4f8cff'),
    R('Ohne Archetyp', [], 'Ohne Archetyp ({kategorie})', '#6b7280'),
  ] },
  alphabet: { label: 'Alphabetisch (Anfangsbuchstabe)', rules: [R('Alphabet', [], '{anfangsbuchstabe}', '#4f8cff')] },
  set: { label: 'Nach Set (braucht Set-Code-Scan)', rules: [
    R('Set', [['set', 'notempty']], '{set}', '#4f8cff'),
    R('Set unbekannt', [], 'Set unbekannt', '#6b7280'),
  ] },
  banlist: { label: 'Banlist-Karten heraussuchen', rules: [
    R('Verboten', [['banlist', 'eq', 'Verboten']], 'VERBOTEN', '#e5484d', { alarm: true }),
    R('Limitiert', [['banlist', 'eq', 'Limitiert, Semi-Limitiert']], '{banlist}', '#f5a524'),
    R('Rest', [], 'Unbegrenzt', '#6b7280', { sound: false }),
  ] },
  suche: { label: 'Bestimmte Karten suchen (Beispiel)', rules: [
    R('Gesuchte Karte', [['name', 'contains', 'Blauäugig, Blue-Eyes, Dunkler Magier, Dark Magician']], 'GEFUNDEN!', '#e5484d', { alarm: true }),
  ] },
};
function hydrateRule(r) {
  return { id: uid(), enabled: true, sound: true, alarm: false, collect: true, ...r, conds: (r.conds || []).map(c => ({ ...c })) };
}

let rules = LS.get('rules', null) || PRESETS.kategorie.rules.map(hydrateRule);
const saveRules = () => LS.set('rules', rules);

/* ------------------------------------------------------- Kartendatenbank */
let CARDS = [], byId = new Map(), codeIndex = new Map(), nameIndex = [];
let dbReady = false;

function setDbStatus(t) { $('#dbStatus').textContent = t; }

function compact(c, nd) {
  return {
    id: c.id, n: c.name, nd: nd || '', t: c.type, f: c.frameType, r: c.race, a: c.attribute || '',
    l: c.level ?? c.linkval ?? null, atk: c.atk ?? null, def: c.def ?? null, ar: c.archetype || '',
    p: parseFloat(c.card_prices?.[0]?.cardmarket_price) || 0,
    b: c.banlist_info?.ban_tcg || '',
    s: (c.card_sets || []).map(s => [s.set_code, s.set_name, s.set_rarity]),
  };
}
function normName(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
// "LOB-EN001" / "LOB-DE001" / "LOB-G001" / "SDK-001"  ->  "LOB-001"
function normCode(code) {
  const m = String(code).toUpperCase().replace(/\s/g, '').match(/^([A-Z0-9]{2,5})-([A-Z]{0,2})(\d{3})$/);
  return m ? m[1] + '-' + m[3] : null;
}
function buildIndex(cards) {
  CARDS = cards;
  byId = new Map(cards.map(c => [c.id, c]));
  codeIndex = new Map();
  nameIndex = [];
  for (const c of cards) {
    nameIndex.push({ norm: normName(c.n), card: c });
    if (c.nd && c.nd !== c.n) nameIndex.push({ norm: normName(c.nd), card: c });
    for (const [code, setName, rarity] of c.s) {
      const k = normCode(code);
      if (!k) continue;
      let e = codeIndex.get(k);
      if (!e) { e = { card: c, set: { code, name: setName, rarities: [] } }; codeIndex.set(k, e); }
      if (e.card === c && rarity && !e.set.rarities.includes(rarity)) e.set.rarities.push(rarity);
    }
  }
  dbReady = true;
  buildDatalists();
}
async function loadDb(force = false) {
  dbReady = false;
  try {
    let data = force ? null : await idbGet('db').catch(() => null);
    if (!data) {
      setDbStatus('Lade Kartendaten von YGOPRODeck (einmalig, kann etwas dauern)…');
      const res = await fetch(API);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const en = await res.json();
      const deNames = {};
      try {
        setDbStatus('Lade deutsche Kartennamen…');
        const de = await (await fetch(API + '?language=de')).json();
        for (const c of de.data || []) deNames[c.id] = c.name;
      } catch (e) { console.warn('Deutsche Namen nicht geladen', e); }
      data = { date: Date.now(), cards: en.data.map(c => compact(c, deNames[c.id])) };
      await idbSet('db', data);
    }
    buildIndex(data.cards);
    setDbStatus(`${CARDS.length.toLocaleString('de-DE')} Karten · Stand ${new Date(data.date).toLocaleDateString('de-DE')}`);
    renderCollection();
  } catch (e) {
    console.error(e);
    setDbStatus('❌ Datenbank konnte nicht geladen werden: ' + e.message);
  }
}

/* ------------------------------------------------------- Suche / Matching */
function lev(a, b, max) {
  const la = a.length, lb = b.length;
  let prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}
function fuzzyName(text, k = 5) {
  const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const q = normName(lines[0] || '');
  if (q.length < 3) return [];
  const scores = new Map();
  for (const e of nameIndex) {
    const L = Math.max(q.length, e.norm.length);
    const maxD = Math.floor(L * 0.45);
    if (Math.abs(q.length - e.norm.length) > maxD) continue;
    const d = lev(q, e.norm, maxD);
    if (d > maxD) continue;
    const score = 1 - d / L;
    if (!(scores.get(e.card.id) >= score)) scores.set(e.card.id, score);
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, score]) => ({ card: byId.get(id), score }));
}
function searchCards(text, k = 10) {
  const q = normName(text);
  if (q.length < 2) return [];
  const starts = [], incl = [], seen = new Set();
  for (const e of nameIndex) {
    if (seen.has(e.card.id)) continue;
    const i = e.norm.indexOf(q);
    if (i === 0) { starts.push(e.card); seen.add(e.card.id); }
    else if (i > 0) { incl.push(e.card); seen.add(e.card.id); }
    if (starts.length >= k) break;
  }
  return [...starts, ...incl].slice(0, k);
}

// Typische OCR-Verwechslungen
const DIGIT_FIX = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', J: '1', Z: '2', S: '5', B: '8', G: '6', A: '4' };
const LETTER_FIX = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G', '4': 'A' };
const CONFUSE = { 0: '0OD', O: 'O0DQ', D: 'D0O', Q: 'Q0O', 1: '1IL', I: 'I1L', L: 'L1I', 5: '5S', S: 'S5B', 8: '8B', B: 'B8S', 2: '2Z', Z: 'Z2', 6: '6G', G: 'G6' };
const REGION_CODES = new Set(['EN', 'DE', 'FR', 'IT', 'PT', 'SP', 'ES', 'E', 'G', 'F', 'I', 'P', 'S']);
// Varianten eines Präfixes, sortiert nach Anzahl ersetzter Zeichen
function prefixVariants(s) {
  let out = [['', 0]];
  for (const ch of s) {
    const opts = CONFUSE[ch] || ch, next = [];
    for (const [p, n] of out) for (const o of opts) next.push([p + o, n + (o === ch ? 0 : 1)]);
    out = next;
  }
  return out.filter(([, n]) => n <= 2).sort((a, b) => a[1] - b[1]).map(([p]) => p);
}
function findByCode(text) {
  const t = String(text).toUpperCase().replace(/[—–_~=]/g, '-');
  for (const raw of t.split('\n')) {
    const line = raw.replace(/[^A-Z0-9-]/g, '');
    for (let i = 0; i < line.length - 4; i++) {
      for (const pl of [4, 3]) {
        const prefix = line.slice(i, i + pl);
        if (prefix.length < pl || prefix.includes('-')) continue;
        let j = i + pl;
        const dash = line[j] === '-';
        if (dash) j++;
        for (const rl of [2, 1, 0]) {
          const reg = [...line.slice(j, j + rl)].map(ch => LETTER_FIX[ch] ?? ch).join('');
          if (reg.length < rl) continue;
          // ohne Bindestrich nur akzeptieren, wenn ein bekannter Länder-Code dazwischen steht
          if (!dash && (rl === 0 || !REGION_CODES.has(reg))) continue;
          const numRaw = line.slice(j + rl, j + rl + 3);
          if (numRaw.length < 3 || numRaw.includes('-')) continue;
          const num = [...numRaw].map(ch => DIGIT_FIX[ch] ?? ch).join('');
          if (!/^\d{3}$/.test(num)) continue;
          for (const p of prefixVariants(prefix)) {
            const hit = codeIndex.get(p + '-' + num);
            if (hit) return { card: hit.card, set: { ...hit.set, code: p + '-' + reg + num } };
          }
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------- OCR / Kamera */
// Lage der Textbereiche auf der Karte (Anteile von Breite/Höhe)
const REGIONS = {
  name: { x: 0.065, y: 0.040, w: 0.75, h: 0.075 },
  code: { x: 0.55, y: 0.712, w: 0.40, h: 0.046 },      // Set-Code unter dem Bild (rechts)
  codePend: { x: 0.05, y: 0.898, w: 0.40, h: 0.046 },  // Set-Code bei Pendelmonstern (links unten)
};
// Innerhalb eines Code-Bereichs werden mehrere schmale Streifen gelesen –
// ein schmaler Streifen ohne Bildkanten liest Tesseract deutlich besser.
function codeStrips(r) {
  const h = r.h * 0.56;
  return [0.5, 0.2, 0.8].map(f => ({ x: r.x, w: r.w, h, y: r.y + (r.h - h) * f }));
}
const CARD_W = 700, CARD_H = 1020;

const workers = {};
function getWorker(kind) {
  if (!workers[kind]) {
    workers[kind] = (async () => {
      const langs = kind === 'code' ? 'eng' : settings.lang === 'de' ? 'deu+eng' : 'eng';
      const w = await Tesseract.createWorker(langs, 1);
      const params = { tessedit_pageseg_mode: '7' }; // eine Textzeile
      if (kind === 'code') params.tessedit_char_whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
      await w.setParameters(params);
      return w;
    })();
  }
  return workers[kind];
}
async function resetNameWorker() {
  const w = workers.name;
  delete workers.name;
  if (w) (await w).terminate();
}

function guideRect(sw, sh) {
  let h = sh * 0.88, w = (h * 59) / 86;
  if (w > sw * 0.9) { w = sw * 0.9; h = (w * 86) / 59; }
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}
function toCardCanvas(src, sx, sy, sw, sh) {
  // Volle Auflösung der Quelle behalten (Handyfotos!), aber begrenzen
  const H = Math.round(Math.max(CARD_H, Math.min(2400, sh)));
  const c = document.createElement('canvas');
  c.width = Math.round((H * CARD_W) / CARD_H); c.height = H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
function regionCanvas(card, r, targetH) {
  const sx = card.width * r.x, sy = card.height * r.y, sw = card.width * r.w, sh = card.height * r.h;
  const scale = targetH / sh, pad = 14;
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = w + pad * 2; c.height = h + pad * 2;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(card, sx, sy, sw, sh, pad, pad, w, h);
  // Graustufen + Kontrast strecken + ggf. invertieren (helle Schrift auf dunklem Grund)
  const img = ctx.getImageData(pad, pad, w, h), d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    d[i] = g; hist[g]++;
  }
  const total = w * h; let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
  const range = Math.max(1, hi - lo);
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range)); d[i] = v; sum += v; }
  const invert = sum / total < 128;
  for (let i = 0; i < d.length; i += 4) { const v = invert ? 255 - d[i] : d[i]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.putImageData(img, pad, pad);
  return c;
}

async function recognizeCard(card, mode) {
  const out = { codeText: '', nameText: '', match: null, candidates: [], crops: [] };
  if (mode !== 'name') {
    const w = await getWorker('code');
    search: for (const key of ['code', 'codePend']) {
      for (const strip of codeStrips(REGIONS[key])) {
        const rc = regionCanvas(card, strip, 56);
        out.crops.push(rc);
        const { data } = await w.recognize(rc);
        const txt = data.text.trim();
        if (txt) out.codeText += (out.codeText ? ' | ' : '') + txt;
        const hit = findByCode(data.text);
        if (hit) { out.match = { ...hit, via: 'Set-Code', score: 1 }; break search; }
      }
    }
  }
  if (!out.match && mode !== 'code') {
    const w = await getWorker('name');
    const rc = regionCanvas(card, REGIONS.name, 64);
    out.crops.push(rc);
    const { data } = await w.recognize(rc);
    out.nameText = data.text.trim();
    out.candidates = fuzzyName(out.nameText, 5);
    const best = out.candidates[0];
    if (best && best.score >= settings.minScore) out.match = { card: best.card, set: null, via: 'Name', score: best.score };
  }
  return out;
}

const video = $('#video');
let stream = null;

async function startCamera(deviceId) {
  ensureAudio();
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Live-Kamera ist hier nicht verfügbar (auf dem Handy wird HTTPS benötigt). Nutze „Bild laden“.');
    return;
  }
  stopCamera();
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const constraints = { audio: false, video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size } };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    alert('Kamera konnte nicht gestartet werden: ' + e.message);
    return;
  }
  video.srcObject = stream;
  await video.play();
  const track = stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities?.();
    if (caps?.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch { /* egal */ }
  await listCameras(track.getSettings().deviceId);
  layoutGuide();
  $('#cameraHint').hidden = true;
  $('#btnLive').disabled = $('#btnSnap').disabled = false;
  $('#btnCamera').textContent = 'Kamera stoppen';
  $('#btnCamera').classList.remove('primary');
}
function stopCamera() {
  setLive(false);
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  $('#guide').hidden = true;
  $('#cameraHint').hidden = false;
  $('#btnLive').disabled = $('#btnSnap').disabled = true;
  $('#btnCamera').textContent = 'Kamera starten';
  $('#btnCamera').classList.add('primary');
}
async function listCameras(activeId) {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const sel = $('#cameraSelect');
  sel.innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === activeId ? 'selected' : ''}>${esc(d.label || 'Kamera ' + (i + 1))}</option>`).join('');
  sel.hidden = devs.length < 2;
}
function layoutGuide() {
  const sw = video.videoWidth, sh = video.videoHeight;
  if (!sw) return;
  const r = guideRect(sw, sh), g = $('#guide');
  Object.assign(g.style, { left: (r.x / sw) * 100 + '%', top: (r.y / sh) * 100 + '%', width: (r.w / sw) * 100 + '%', height: (r.h / sh) * 100 + '%' });
  for (const el of $$('.region', g)) {
    const rr = REGIONS[el.dataset.r];
    Object.assign(el.style, { left: rr.x * 100 + '%', top: rr.y * 100 + '%', width: rr.w * 100 + '%', height: rr.h * 100 + '%' });
    el.hidden = (settings.scanMode === 'name' && el.dataset.r !== 'name') || (settings.scanMode === 'code' && el.dataset.r === 'name');
  }
  g.hidden = false;
}
function grabFrame() {
  const sw = video.videoWidth, sh = video.videoHeight;
  const r = guideRect(sw, sh);
  return toCardCanvas(video, r.x, r.y, r.w, r.h);
}

/* ------------------------------------------------------- Live-Scan */
let live = false, liveBusy = false, pendingId = null, pendingCount = 0, lastAcceptedId = null, missCount = 0;

function setLive(on) {
  live = on;
  const b = $('#btnLive');
  b.textContent = on ? '⏸ Live-Scan stoppen' : '▶ Live-Scan';
  b.classList.toggle('on', on);
  $('#liveIndicator').hidden = !on;
  if (on) { ensureAudio(); pendingId = null; lastAcceptedId = null; missCount = 0; liveStatus('suche Karte…'); liveLoop(); }
}
const liveStatus = t => { $('#liveIndicator').textContent = 'LIVE · ' + t; };

async function liveLoop() {
  if (!live) return;
  if (!liveBusy && dbReady && video.readyState >= 2) {
    liveBusy = true;
    try {
      const card = grabFrame();
      const r = await recognizeCard(card, settings.scanMode);
      renderDebug(r);
      const m = r.match;
      $('#guide').classList.toggle('hit', !!m);
      if (!m) {
        if (++missCount >= 2) { lastAcceptedId = null; pendingId = null; }
        liveStatus('suche Karte…');
      } else {
        missCount = 0;
        const id = m.card.id;
        if (id === lastAcceptedId) {
          liveStatus('✓ erfasst – nächste Karte');
        } else {
          pendingCount = pendingId === id ? pendingCount + 1 : 1;
          pendingId = id;
          if (pendingCount >= settings.confirmations) {
            lastAcceptedId = id; pendingId = null;
            accept(m.card, m.set, { via: m.via, score: m.score, thumb: card, candidates: r.candidates });
            liveStatus('✓ erfasst – nächste Karte');
          } else liveStatus('prüfe…');
        }
      }
    } catch (e) { console.error(e); }
    liveBusy = false;
  }
  setTimeout(liveLoop, settings.interval);
}

async function scanOnce(card) {
  if (!dbReady) { alert('Die Kartendatenbank lädt noch.'); return; }
  ensureAudio();
  showBusy('Erkenne Karte…');
  try {
    const r = await recognizeCard(card, settings.scanMode);
    renderDebug(r);
    if (r.match) accept(r.match.card, r.match.set, { via: r.match.via, score: r.match.score, thumb: card, candidates: r.candidates });
    else showNoMatch(r, card);
  } catch (e) {
    console.error(e);
    showBusy('Fehler bei der Erkennung: ' + e.message);
  }
}

/* ------------------------------------------------------- Sammlung */
let collection = LS.get('collection', {}); // key -> {id, code, setName, rarity, count, pile, color, first, last}
let history = [];
const saveCollection = () => LS.set('collection', collection);
const collKey = (id, code) => id + '|' + (code || '');

function addToCollection(e, n = 1) {
  const k = collKey(e.id, e.code);
  const c = collection[k] ||= { id: e.id, code: e.code || '', setName: e.setName || '', rarity: e.rarity || '', count: 0, first: Date.now() };
  c.count += n;
  c.pile = e.pile; c.color = e.color; c.last = Date.now();
  if (c.count <= 0) delete collection[k];
  saveCollection();
}
const entrySet = e => (e.code ? { code: e.code, name: e.setName, rarities: e.rarity ? e.rarity.split(' / ') : [] } : null);

function accept(card, set, opts = {}) {
  const ev = evaluate(card, set);
  let pile = null, color = '#6b7280', rule = ev?.rule || null;
  if (ev) { pile = ev.pile; color = ev.color; }
  else if (!settings.ignoreUnmatched) pile = fillTemplate(settings.defaultPile, card, set) || 'Rest';

  const entry = {
    t: Date.now(), id: card.id, code: set?.code || '', setName: set?.name || '', rarity: (set?.rarities || []).join(' / '),
    pile, color, via: opts.via || 'manuell', score: opts.score ?? 1, ruleId: rule?.id || null, added: false,
  };
  if (pile !== null && settings.addToCollection && (!rule || rule.collect !== false)) {
    addToCollection(entry); entry.added = true;
  }
  history.unshift(entry);
  history.length = Math.min(history.length, 60);
  showResult(card, set, entry, rule, opts);
  feedback(entry, rule);
  renderHistory();
  renderCollection();
}
function undo(entry) {
  if (entry.added) addToCollection(entry, -1);
  history = history.filter(h => h !== entry);
  renderHistory(); renderCollection();
}
function setPrinting(entry, code) {
  const card = byId.get(entry.id);
  const sets = card.s.filter(s => s[0] === code);
  if (entry.added) addToCollection(entry, -1);
  entry.code = code; entry.setName = sets[0]?.[1] || ''; entry.rarity = [...new Set(sets.map(s => s[2]))].join(' / ');
  const ev = evaluate(card, entrySet(entry));
  entry.pile = ev ? ev.pile : settings.ignoreUnmatched ? null : fillTemplate(settings.defaultPile, card, entrySet(entry));
  entry.color = ev ? ev.color : '#6b7280';
  if (entry.added) addToCollection(entry);
  showResult(card, entrySet(entry), entry, ev?.rule, {});
  renderHistory(); renderCollection();
}

/* ------------------------------------------------------- Feedback */
let audioCtx = null;
function ensureAudio() {
  try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* kein Audio */ }
}
function beep(freq, dur = 0.12, when = 0, type = 'sine', vol = 0.25) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + when, o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur);
}
function hashFreq(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 440 + (h % 12) * 45; }
function feedback(entry, rule) {
  const alarm = rule?.alarm;
  if (settings.sound && entry.pile !== null && (!rule || rule.sound !== false)) {
    if (alarm) { for (let i = 0; i < 4; i++) beep(1200, 0.12, i * 0.18, 'square', 0.2); }
    else beep(hashFreq(entry.pile), 0.15);
  }
  if (settings.vibrate && navigator.vibrate && entry.pile !== null) navigator.vibrate(alarm ? [200, 100, 200, 100, 200] : 70);
  if (settings.speech && entry.pile !== null && 'speechSynthesis' in window && (!rule || rule.sound !== false)) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(entry.pile);
    u.lang = 'de-DE'; u.rate = 1.15;
    speechSynthesis.speak(u);
  }
}

/* ------------------------------------------------------- UI: Ergebnis */
function cardTags(c) {
  const tags = [category(c), monsterArt(c), FIELDS.attribut.get(c), FIELDS.typ.get(c)];
  if (isMonster(c) && c.l != null) tags.push((/xyz/.test(c.f) ? 'Rang ' : /link/.test(c.f) ? 'Link ' : 'Stufe ') + c.l);
  if (isMonster(c)) tags.push(`ATK ${c.atk ?? '?'}${c.def != null ? ' / DEF ' + c.def : ''}`);
  if (c.ar) tags.push('Archetyp: ' + c.ar);
  if (c.b) tags.push('Banlist: ' + BAN_DE[c.b]);
  return tags.filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('');
}
function showBusy(text) {
  const el = $('#result');
  el.className = 'result empty';
  el.innerHTML = `<div class="pile">${esc(text)}</div>`;
}
function showResult(card, set, entry, rule, opts) {
  const el = $('#result');
  el.className = 'result' + (rule?.alarm ? ' alarm' : '');
  let thumb = null;
  if (opts.thumb) {
    const t = document.createElement('canvas');
    t.width = 200; t.height = Math.round((200 * opts.thumb.height) / opts.thumb.width);
    t.getContext('2d').drawImage(opts.thumb, 0, 0, t.width, t.height);
    thumb = t.toDataURL('image/jpeg', 0.75);
  }
  const otherName = settings.lang === 'de' && card.nd && card.nd !== card.n ? card.n : settings.lang !== 'de' && card.nd ? card.nd : '';
  const printings = [...new Set(card.s.map(s => s[0]))];
  el.innerHTML = `
    <div class="pile" style="background:${esc(entry.color)}">${entry.pile === null ? '<span class="muted">ignoriert</span>' : '→ ' + esc(entry.pile)}</div>
    <div class="info">
      ${thumb ? `<img src="${thumb}" alt="">` : ''}
      <div>
        <div class="name">${esc(displayName(card))}</div>
        ${otherName ? `<div class="muted small">${esc(otherName)}</div>` : ''}
        <div>${cardTags(card)}</div>
        <div class="small" style="margin-top:4px">
          ${set?.code ? `<b>${esc(set.code)}</b> · ${esc(set.name)} · ${esc((set.rarities || []).join(' / '))}` : '<span class="muted">Druck unbekannt</span>'}
          · Preis ${euro(card.p)}
        </div>
        <div class="muted small">erkannt über ${esc(entry.via)}${entry.via === 'Name' ? ` (${Math.round(entry.score * 100)} %)` : ''}${rule ? ` · Regel „${esc(rule.name)}“` : ' · keine Regel passt'}${entry.added ? ' · zur Sammlung hinzugefügt' : ''}</div>
      </div>
    </div>
    <div class="actions">
      ${entry.added ? '<button data-a="plus">＋1 weiteres Exemplar</button>' : ''}
      <button data-a="undo">↶ Rückgängig</button>
      ${printings.length ? `<select data-a="print"><option value="">${set?.code ? 'Druck ändern…' : 'Druck/Seltenheit wählen…'}</option>${printings.map(p => `<option ${p === set?.code ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>` : ''}
    </div>`;
  el.querySelector('[data-a=plus]')?.addEventListener('click', () => { addToCollection(entry); renderCollection(); beep(hashFreq(entry.pile), 0.08); });
  el.querySelector('[data-a=undo]').addEventListener('click', () => { undo(entry); showBusy('Rückgängig gemacht'); });
  el.querySelector('[data-a=print]')?.addEventListener('change', e => e.target.value && setPrinting(entry, e.target.value));

  // Alternativen anbieten, falls über den Namen erkannt
  renderCandidates((opts.candidates || []).filter(c => c.card.id !== card.id), entry);
}
function showNoMatch(r, card) {
  const el = $('#result');
  el.className = 'result empty';
  el.innerHTML = `<div class="pile">Nicht sicher erkannt</div>
    <div class="muted small" style="margin-top:8px">Gelesen: ${esc(r.codeText || '–')} ${r.nameText ? ' / ' + esc(r.nameText) : ''}<br>
    Wähle unten eine passende Karte oder suche manuell.</div>`;
  renderCandidates(r.candidates, null, card);
  beep(220, 0.15, 0, 'triangle', 0.15);
}
function renderCandidates(cands, replaceEntry, thumb) {
  const box = $('#candidates');
  if (!cands?.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="muted small">${replaceEntry ? 'Falsche Karte? Stattdessen:' : 'Meintest du:'}</div><div class="list">${cands.map((c, i) =>
    `<button data-i="${i}"><span>${esc(displayName(c.card))}</span><span class="muted small">${Math.round(c.score * 100)} %</span></button>`).join('')}</div>`;
  $$('button', box).forEach(b => b.addEventListener('click', () => {
    if (replaceEntry) undo(replaceEntry);
    accept(cands[+b.dataset.i].card, null, { via: 'Auswahl', thumb });
  }));
}
function renderHistory() {
  $('#history').innerHTML = history.slice(0, 15).map(h => {
    const c = byId.get(h.id);
    return `<li><span class="dot" style="background:${esc(h.color)}"></span><span>${esc(c ? displayName(c) : h.id)}${h.code ? ` <span class="muted small">${esc(h.code)}</span>` : ''}</span><span class="p">${h.pile === null ? '<span class="muted">ignoriert</span>' : esc(h.pile)}</span></li>`;
  }).join('');
}
function renderDebug(r) {
  const box = $('#debug');
  box.hidden = !settings.debug;
  if (!settings.debug) return;
  box.innerHTML = `<b>OCR</b> · Code: <code>${esc(r.codeText || '–')}</code> · Name: <code>${esc(r.nameText || '–')}</code>`;
  r.crops.forEach(c => box.appendChild(c));
}

/* ------------------------------------------------------- UI: Manuelle Suche */
function bindSearch(input, out, onPick) {
  input.addEventListener('input', () => {
    if (!dbReady) { out.innerHTML = '<span class="muted small">Datenbank lädt noch…</span>'; return; }
    const res = searchCards(input.value, 8);
    out.innerHTML = res.map(c => `<button data-id="${c.id}"><span>${esc(displayName(c))}</span><span class="muted small">${esc(category(c))}</span></button>`).join('');
  });
  out.addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    onPick(byId.get(+b.dataset.id));
  });
}

/* ------------------------------------------------------- UI: Regeln */
function renderRules() {
  const box = $('#rulesList');
  box.innerHTML = '';
  rules.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'rule' + (r.enabled ? '' : ' disabled');
    el.style.borderLeftColor = r.color;
    el.innerHTML = `
      <div class="rule-head">
        <label class="chk"><input type="checkbox" data-k="enabled" ${r.enabled ? 'checked' : ''}> aktiv</label>
        <span class="rule-no">#${i + 1}</span>
        <input type="text" class="rule-name" data-k="name" value="${esc(r.name)}" placeholder="Regelname">
        <button data-act="up" title="nach oben" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" title="nach unten" ${i === rules.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="dup" title="duplizieren">⧉</button>
        <button data-act="del" class="danger" title="löschen">🗑</button>
      </div>
      <div class="conds">
        <div class="muted small">${r.conds.length ? 'Wenn <b>alle</b> Bedingungen zutreffen:' : 'Keine Bedingung → trifft auf jede Karte zu'}</div>
        ${r.conds.map((c, j) => `
          <div class="cond" data-j="${j}">
            <select data-ck="field">${Object.entries(FIELDS).map(([k, f]) => `<option value="${k}" ${k === c.field ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
            <select data-ck="op">${Object.entries(OPS).map(([k, l]) => `<option value="${k}" ${k === c.op ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <input type="text" data-ck="value" value="${esc(c.value)}" list="dl-${c.field}" placeholder="Wert" ${c.op === 'empty' || c.op === 'notempty' ? 'hidden' : ''}>
            <button class="small" data-act="delcond" data-j="${j}">✕</button>
          </div>`).join('')}
        <button class="small" data-act="addcond">＋ Bedingung</button>
      </div>
      <div class="rule-action">
        <label>→ Stapel <input type="text" data-k="pile" value="${esc(r.pile)}" placeholder="z.B. Box 1 oder {attribut}"></label>
        <label>Farbe <input type="color" data-k="color" value="${esc(r.color)}"></label>
        <label class="chk"><input type="checkbox" data-k="sound" ${r.sound !== false ? 'checked' : ''}> Ton/Ansage</label>
        <label class="chk"><input type="checkbox" data-k="alarm" ${r.alarm ? 'checked' : ''}> Alarm</label>
        <label class="chk"><input type="checkbox" data-k="collect" ${r.collect !== false ? 'checked' : ''}> in Sammlung</label>
      </div>`;
    el.addEventListener('input', e => {
      const t = e.target;
      if (t.dataset.k) {
        r[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value;
        if (t.dataset.k === 'color') el.style.borderLeftColor = t.value;
        if (t.dataset.k === 'enabled') el.classList.toggle('disabled', !t.checked);
      } else if (t.dataset.ck) {
        const row = t.closest('.cond'), cond = r.conds[+row.dataset.j];
        cond[t.dataset.ck] = t.value;
        if (t.dataset.ck === 'field') row.querySelector('[data-ck=value]').setAttribute('list', 'dl-' + t.value);
        if (t.dataset.ck === 'op') row.querySelector('[data-ck=value]').hidden = t.value === 'empty' || t.value === 'notempty';
      }
      saveRules();
    });
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'up') [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
      if (a === 'down') [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
      if (a === 'dup') rules.splice(i + 1, 0, hydrateRule({ ...r, id: undefined, name: r.name + ' (Kopie)' }));
      if (a === 'del' && confirm(`Regel „${r.name}“ löschen?`)) rules.splice(i, 1);
      if (a === 'addcond') r.conds.push({ field: 'kategorie', op: 'eq', value: '' });
      if (a === 'delcond') r.conds.splice(+b.dataset.j, 1);
      saveRules(); renderRules();
    });
    box.appendChild(el);
  });
  if (!rules.length) box.innerHTML = '<div class="card-box muted">Keine Regeln – alle Karten landen im Standardstapel. Lade eine Vorlage oder lege eine neue Regel an.</div>';
}
function buildDatalists() {
  const lists = {};
  for (const [k, f] of Object.entries(FIELDS)) if (f.values) lists[k] = f.values;
  lists.archetyp = [...new Set(CARDS.map(c => c.ar).filter(Boolean))].sort();
  lists.set = [...new Set([...codeIndex.values()].map(e => e.set.code.split('-')[0]))].sort();
  lists.seltenheit = [...new Set([...codeIndex.values()].flatMap(e => e.set.rarities))].sort();
  $('#datalists').innerHTML = Object.entries(lists).map(([k, vals]) => `<datalist id="dl-${k}">${vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`).join('');
}

/* ------------------------------------------------------- UI: Sammlung */
const SORT_KEYS = { '': '–', stapel: 'Stapel', ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.label])), setcode: 'Set-Code', anzahl: 'Anzahl', zuletzt: 'Zuletzt gescannt' };
let collView = LS.get('collView', { sort: [['stapel', 1], ['name', 1], ['', 1]], group: 'stapel', q: '' });

function sortValue(e, key) {
  const c = byId.get(e.id);
  if (key === 'stapel') return e.pile || '';
  if (key === 'setcode') return e.code || '';
  if (key === 'anzahl') return e.count;
  if (key === 'zuletzt') return e.last || 0;
  return FIELDS[key] ? FIELDS[key].get(c, entrySet(e)) : '';
}
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a === '' && b !== '') return 1;
  if (b === '' && a !== '') return -1;
  return String(a).localeCompare(String(b), 'de', { numeric: true });
}
function renderCollection() {
  const box = $('#collection');
  if (!dbReady) { box.innerHTML = '<p class="muted">Datenbank lädt…</p>'; return; }
  let entries = Object.values(collection).filter(e => byId.has(e.id));
  const q = normName(collView.q || '');
  if (q) entries = entries.filter(e => { const c = byId.get(e.id); return normName(c.n).includes(q) || normName(c.nd).includes(q) || normName(e.code).includes(q) || normName(e.pile || '').includes(q); });
  const sorts = collView.sort.filter(([k]) => k);
  entries.sort((a, b) => { for (const [k, dir] of sorts) { const r = cmp(sortValue(a, k), sortValue(b, k)); if (r) return r * dir; } return 0; });

  const total = entries.reduce((s, e) => s + e.count, 0);
  const value = entries.reduce((s, e) => s + e.count * (byId.get(e.id).p || 0), 0);
  $('#collSummary').textContent = `${total.toLocaleString('de-DE')} Karten (${entries.length} verschiedene) · geschätzter Wert ${euro(value)}`;

  const groups = new Map();
  for (const e of entries) {
    const g = collView.group ? String(sortValue(e, collView.group) || '–') : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const row = e => {
    const c = byId.get(e.id);
    return `<tr data-k="${esc(collKey(e.id, e.code))}">
      <td><span class="cnt"><button class="small" data-d="-1">−</button><b>${e.count}</b><button class="small" data-d="1">＋</button></span></td>
      <td><b>${esc(displayName(c))}</b>${c.nd && settings.lang === 'de' && c.nd !== c.n ? `<div class="muted small">${esc(c.n)}</div>` : ''}</td>
      <td>${esc(category(c))}${monsterArt(c) ? ' · ' + esc(monsterArt(c)) : ''}</td>
      <td>${esc([FIELDS.attribut.get(c), FIELDS.typ.get(c)].filter(Boolean).join(' / '))}</td>
      <td class="num">${c.l ?? ''}</td>
      <td class="num">${isMonster(c) ? `${c.atk ?? '?'}${c.def != null ? '/' + c.def : ''}` : ''}</td>
      <td>${esc(e.code || '–')}</td>
      <td>${esc(e.rarity || '')}</td>
      <td class="num">${euro(c.p)}</td>
      <td>${e.pile ? `<span class="pile-chip" style="background:${esc(e.color || '#6b7280')}">${esc(e.pile)}</span>` : ''}</td>
    </tr>`;
  };
  const table = list => `<div class="table-wrap"><table><thead><tr><th>Anz.</th><th>Name</th><th>Kategorie</th><th>Attribut / Typ</th><th class="num">St.</th><th class="num">ATK/DEF</th><th>Set-Code</th><th>Seltenheit</th><th class="num">Preis</th><th>Stapel</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
  if (!entries.length) { box.innerHTML = '<p class="muted">Noch keine Karten in der Sammlung. Scanne welche!</p>'; return; }
  box.innerHTML = collView.group
    ? [...groups].map(([g, list]) => `<div class="group-h"><h3>${esc(g)}</h3><span class="muted">${list.reduce((s, e) => s + e.count, 0)} Karten · ${euro(list.reduce((s, e) => s + e.count * (byId.get(e.id).p || 0), 0))}</span></div>${table(list)}`).join('')
    : table(entries);
}
function initCollectionUi() {
  const opts = sel => Object.entries(SORT_KEYS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
  $$('.sortKey').forEach(s => { s.innerHTML = opts(); s.value = collView.sort[+s.dataset.i][0]; });
  $$('.sortDir').forEach(b => { b.textContent = collView.sort[+b.dataset.i][1] > 0 ? '↑' : '↓'; });
  $('#groupBy').innerHTML = Object.entries(SORT_KEYS).filter(([k]) => !['anzahl', 'zuletzt', 'name', 'atk', 'def', 'preis'].includes(k)).map(([k, l]) => `<option value="${k}">${esc(l === '–' ? 'nicht gruppieren' : l)}</option>`).join('');
  $('#groupBy').value = collView.group;
  $('#collSearch').value = collView.q;
  const save = () => { LS.set('collView', collView); renderCollection(); };
  $$('.sortKey').forEach(s => s.addEventListener('change', () => { collView.sort[+s.dataset.i][0] = s.value; save(); }));
  $$('.sortDir').forEach(b => b.addEventListener('click', () => { const s = collView.sort[+b.dataset.i]; s[1] *= -1; b.textContent = s[1] > 0 ? '↑' : '↓'; save(); }));
  $('#groupBy').addEventListener('change', e => { collView.group = e.target.value; save(); });
  $('#collSearch').addEventListener('input', e => { collView.q = e.target.value; save(); });
  $('#collection').addEventListener('click', e => {
    const b = e.target.closest('button[data-d]');
    if (!b) return;
    const ent = collection[b.closest('tr').dataset.k];
    if (!ent) return;
    ent.count += +b.dataset.d;
    if (ent.count <= 0) delete collection[b.closest('tr').dataset.k];
    saveCollection(); renderCollection();
  });
  $('#btnRepile').addEventListener('click', () => {
    for (const e of Object.values(collection)) {
      const c = byId.get(e.id); if (!c) continue;
      const ev = evaluate(c, entrySet(e));
      e.pile = ev ? ev.pile : settings.ignoreUnmatched ? '' : fillTemplate(settings.defaultPile, c, entrySet(e));
      e.color = ev ? ev.color : '#6b7280';
    }
    saveCollection(); renderCollection();
  });
  $('#btnCsv').addEventListener('click', exportCsv);
  $('#btnBackup').addEventListener('click', () => download('ygo-backup.json', JSON.stringify({ version: 1, collection, rules, settings }, null, 1), 'application/json'));
  $('#backupInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!confirm('Backup laden? Sammlung und Regeln werden ersetzt.')) return;
      if (data.collection) { collection = data.collection; saveCollection(); }
      if (data.rules) { rules = data.rules.map(hydrateRule); saveRules(); renderRules(); }
      renderCollection();
    } catch (err) { alert('Backup konnte nicht gelesen werden: ' + err.message); }
    e.target.value = '';
  });
  $('#btnClear').addEventListener('click', () => {
    if (confirm('Wirklich die komplette Sammlung leeren? (Tipp: vorher Backup speichern)')) { collection = {}; saveCollection(); renderCollection(); }
  });
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportCsv() {
  const cols = ['Anzahl', 'Name', 'Name (EN)', 'Kategorie', 'Monster-Art', 'Attribut', 'Typ', 'Stufe', 'ATK', 'DEF', 'Archetyp', 'Set-Code', 'Set', 'Seltenheit', 'Preis €', 'Stapel'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(';')];
  for (const e of Object.values(collection)) {
    const c = byId.get(e.id); if (!c) continue;
    lines.push([e.count, c.nd || c.n, c.n, category(c), monsterArt(c), FIELDS.attribut.get(c), FIELDS.typ.get(c), c.l ?? '', c.atk ?? '', c.def ?? '', c.ar, e.code, e.setName, e.rarity, (c.p || 0).toFixed(2).replace('.', ','), e.pile].map(q).join(';'));
  }
  download('ygo-sammlung.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/* ------------------------------------------------------- Init */
function initSettingsUi() {
  for (const el of $$('[data-set]')) {
    const k = el.dataset.set;
    if (el.type === 'checkbox') el.checked = !!settings[k]; else el.value = settings[k];
    el.addEventListener('change', async () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number' || typeof DEFAULT_SETTINGS[k] === 'number') v = Number(v);
      settings[k] = v;
      saveSettings();
      if (k === 'lang') { await resetNameWorker(); renderCollection(); renderHistory(); }
      if (k === 'debug') $('#debug').hidden = !v;
    });
  }
  $('#btnReloadDb').addEventListener('click', () => { if (confirm('Kartendatenbank neu herunterladen (z.B. für neue Sets und aktuelle Preise)?')) loadDb(true); });
}

function init() {
  if (!window.isSecureContext) $('#secureWarning').hidden = false;

  $$('nav button').forEach(b => b.addEventListener('click', () => {
    $$('nav button').forEach(x => x.classList.toggle('active', x === b));
    $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  }));

  // Scannen
  $('#scanMode').value = settings.scanMode;
  $('#scanMode').addEventListener('change', e => { settings.scanMode = e.target.value; saveSettings(); layoutGuide(); });
  $('#btnCamera').addEventListener('click', () => (stream ? stopCamera() : startCamera()));
  $('#cameraSelect').addEventListener('change', e => startCamera(e.target.value));
  $('#btnLive').addEventListener('click', () => setLive(!live));
  $('#btnSnap').addEventListener('click', () => scanOnce(grabFrame()));
  $('#fileInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await img.decode();
    // Das Foto sollte die Karte möglichst formatfüllend zeigen
    await scanOnce(toCardCanvas(img, 0, 0, img.naturalWidth, img.naturalHeight));
    URL.revokeObjectURL(img.src);
    e.target.value = '';
  });
  video.addEventListener('loadedmetadata', layoutGuide);
  bindSearch($('#manualSearch'), $('#manualResults'), c => { accept(c, null, { via: 'manuell' }); $('#manualSearch').value = ''; $('#manualResults').innerHTML = ''; });
  $('#debug').hidden = !settings.debug;

  // Regeln
  $('#presetSelect').innerHTML += Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
  $('#presetSelect').addEventListener('change', e => {
    const p = PRESETS[e.target.value];
    if (p) {
      const replace = !rules.length || confirm('Aktuelle Regeln ERSETZEN? (Abbrechen = Vorlage unten anhängen)');
      const add = p.rules.map(hydrateRule);
      rules = replace ? add : [...rules, ...add];
      saveRules(); renderRules();
    }
    e.target.value = '';
  });
  $('#btnAddRule').addEventListener('click', () => {
    rules.push(hydrateRule({ name: 'Neue Regel', conds: [{ field: 'kategorie', op: 'eq', value: 'Monster' }], pile: 'Box 1', color: '#4f8cff' }));
    saveRules(); renderRules();
  });
  bindSearch($('#ruleTest'), $('#ruleTestOut'), c => {
    const ev = evaluate(c, null);
    $('#ruleTestOut').innerHTML = `<div class="card-box"><b>${esc(displayName(c))}</b><div>${cardTags(c)}</div>
      <div style="margin-top:8px">→ ${ev ? `Regel „${esc(ev.rule.name)}“ → Stapel <span class="pile-chip" style="background:${esc(ev.color)}">${esc(ev.pile)}</span>` : settings.ignoreUnmatched ? 'keine Regel passt → <b>wird ignoriert</b>' : `keine Regel passt → Standardstapel „${esc(fillTemplate(settings.defaultPile, c, null))}“`}</div>
      <div class="muted small">Hinweis: Set/Seltenheit sind nur bekannt, wenn der Set-Code gescannt wurde.</div></div>`;
  });
  renderRules();

  initCollectionUi();
  initSettingsUi();
  renderHistory();
  loadDb();
  // OCR-Engine schon mal vorwärmen
  if (window.Tesseract) { getWorker('code'); getWorker('name'); }
}
init();

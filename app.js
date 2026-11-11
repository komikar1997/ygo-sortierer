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
  formatScan: false, formatTarget: 'GOAT', histCat: '', histFormat: '',
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
// Länderkürzel im Set-Code -> Sprache der Karte ("LOB-001" ohne Kürzel = alte US-Erstauflage)
const REGION_LANG = { '': 'Englisch', EN: 'Englisch', E: 'Englisch', DE: 'Deutsch', G: 'Deutsch', FR: 'Französisch', F: 'Französisch',
  IT: 'Italienisch', I: 'Italienisch', PT: 'Portugiesisch', P: 'Portugiesisch', SP: 'Spanisch', ES: 'Spanisch', S: 'Spanisch' };
const LANG_REGION = { Englisch: 'EN', Deutsch: 'DE', Französisch: 'FR', Italienisch: 'IT', Portugiesisch: 'PT', Spanisch: 'SP' };
const LANGS = Object.keys(LANG_REGION);
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

/* ------------------------------------------------- Datum & Spielformate */
// "2002-03-08" -> "08.03.2002"
const fmtDate = iso => (iso ? iso.split('-').reverse().join('.') : '');
// Eingabe "05.08.2005", "2005-08-05" oder "2005" -> "2005-08-05" / "2005-01-01"
function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return s;
  if ((m = s.match(/^(\d{4})$/))) return `${m[1]}-01-01`;
  return '';
}
// Spielformate: Karte gehört dazu, wenn ihre Erstveröffentlichung (TCG) im Zeitraum liegt
const DEFAULT_FORMATS = [{ id: 'goat', name: 'GOAT', from: '2002-01-01', to: '2005-08-05' }];
let formats = LS.get('formats', null) || DEFAULT_FORMATS.map(f => ({ ...f }));
const saveFormats = () => LS.set('formats', formats);
function formatsOf(c) {
  const d = c.d;
  if (!d) return [];
  return formats.filter(f => f.name && (!f.from || d >= f.from) && (!f.to || d <= f.to)).map(f => f.name);
}
// Format-Suche: passt die Karte zum gesuchten Format? ('*' = irgendein Format)
const formatTargetLabel = () => (settings.formatTarget === '*' ? 'ein Format' : settings.formatTarget);
function isFormatHit(c) {
  const fs = formatsOf(c);
  return settings.formatTarget === '*' ? fs.length > 0 : fs.includes(settings.formatTarget);
}

/* ------------------------------------------------- Felder für Regeln */
// c = Karte, s = Druck {code, name, rarities[], lang} (code leer, wenn nur über den Namen erkannt)
const langOnly = lang => ({ code: '', name: '', rarities: [], lang: lang || '' });
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
  erstdruck: { label: 'Erstveröffentlichung (TCG)', date: true, get: c => c.d || '' },
  erstdruckOcg: { label: 'Erstveröffentlichung (OCG/Japan)', date: true, get: c => c.do || '' },
  jahr: { label: 'Erscheinungsjahr (TCG)', num: true, get: c => (c.d ? +c.d.slice(0, 4) : '') },
  format: { label: 'Spielformat', get: c => formatsOf(c)[0] || '', values: () => formats.map(f => f.name) },
  formate: { label: 'Alle passenden Formate', multi: true, get: c => formatsOf(c).join(', '), values: () => formats.map(f => f.name) },
  sprache: { label: 'Sprache der Karte', get: (c, s) => s?.lang || '', values: LANGS },
};
// Anzeigewert eines Feldes (Datum deutsch formatiert)
const showField = (k, c, s) => { const f = FIELDS[k], v = f.get(c, s); return f.date ? fmtDate(v) : v; };
const OPS = { eq: '=', ne: '≠', contains: 'enthält', starts: 'beginnt mit', gt: '>', ge: '≥', lt: '<', le: '≤', empty: 'ist leer', notempty: 'ist nicht leer' };

function testCond(cond, c, s) {
  const f = FIELDS[cond.field];
  if (!f) return false;
  const v = f.get(c, s);
  const sv = String(v).toLowerCase();
  const opts = String(cond.value ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const n = Number(String(cond.value).replace(',', '.'));
  const has = v !== '' && v !== null && v !== undefined;
  if (f.date) { // Datumsvergleich: Eingabe als TT.MM.JJJJ oder JJJJ
    const ds = opts.map(parseDate).filter(Boolean), d0 = ds[0] || '';
    switch (cond.op) {
      case 'eq': return has && ds.includes(v);
      case 'ne': return !(has && ds.includes(v));
      case 'gt': return has && !!d0 && v > d0;
      case 'ge': return has && !!d0 && v >= d0;
      case 'lt': return has && !!d0 && v < d0;
      case 'le': return has && !!d0 && v <= d0;
    }
  }
  if (f.multi && (cond.op === 'eq' || cond.op === 'ne')) { // z.B. "Alle passenden Formate" = GOAT
    const parts = sv.split(',').map(x => x.trim());
    const hit = opts.some(o => parts.includes(o));
    return cond.op === 'eq' ? hit : !hit;
  }
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
    const key = Object.keys(FIELDS).find(x => x.toLowerCase() === k.toLowerCase());
    if (!key) return m;
    const v = showField(key, c, s);
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
  format: { label: 'Nach Spielformat (z.B. GOAT, über Erstveröffentlichung)', rules: [
    R('Spielformat', [['format', 'notempty']], '{format}', '#8a63d2'),
    R('Kein Format', [], 'Kein Format', '#6b7280'),
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
    d: c.misc_info?.[0]?.tcg_date || '',   // erste Veröffentlichung TCG (Europa/USA)
    do: c.misc_info?.[0]?.ocg_date || '',  // erste Veröffentlichung OCG (Japan)
    s: (c.card_sets || []).map(s => [s.set_code, s.set_name, s.set_rarity]),
  };
}
const DB_VERSION = 2; // erhöhen, wenn sich das gespeicherte Kartenformat ändert
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
    const same = !c.nd || normName(c.nd) === normName(c.n);
    nameIndex.push({ norm: normName(c.n), card: c, lang: same ? '' : 'Englisch' });
    if (!same) nameIndex.push({ norm: normName(c.nd), card: c, lang: 'Deutsch' });
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
    if (data && data.v !== DB_VERSION) data = null; // altes Format -> neu laden
    if (!data) {
      setDbStatus('Lade Kartendaten von YGOPRODeck (einmalig, kann etwas dauern)…');
      const res = await fetch(API + '?misc=yes');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const en = await res.json();
      const deNames = {};
      try {
        setDbStatus('Lade deutsche Kartennamen…');
        const de = await (await fetch(API + '?language=de')).json();
        for (const c of de.data || []) deNames[c.id] = c.name;
      } catch (e) { console.warn('Deutsche Namen nicht geladen', e); }
      data = { v: DB_VERSION, date: Date.now(), cards: en.data.map(c => compact(c, deNames[c.id])) };
      await idbSet('db', data);
    }
    buildIndex(data.cards);
    setDbStatus(`${CARDS.length.toLocaleString('de-DE')} Karten · Stand ${new Date(data.date).toLocaleDateString('de-DE')}`);
    renderCollection();
    renderHistory();
    updateFormatCounts();
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
    if (!(scores.get(e.card.id)?.score >= score)) scores.set(e.card.id, { score, lang: e.lang });
  }
  return [...scores].sort((a, b) => b[1].score - a[1].score).slice(0, k)
    .map(([id, { score, lang }]) => ({ card: byId.get(id), score, lang }));
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
// Set-Code aus der Datenbank (meist "-EN") auf die Sprache der Karte umschreiben
function codeForLang(code, lang) {
  const m = String(code).match(/^([A-Z0-9]+)-([A-Z]{0,2})(.+)$/);
  if (!m || !lang || !m[2] || !LANG_REGION[lang]) return code;
  return `${m[1]}-${LANG_REGION[lang]}${m[3]}`;
}
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
            if (hit) return { card: hit.card, set: { ...hit.set, code: p + '-' + reg + num, lang: REGION_LANG[reg] || '' } };
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
      // Namen immer mit deutschem UND englischem Modell lesen -> DE- und EN-Karten werden erkannt
      const langs = kind === 'code' ? 'eng' : 'deu+eng';
      const w = await Tesseract.createWorker(langs, 1);
      const params = { tessedit_pageseg_mode: '7' }; // eine Textzeile
      if (kind === 'code') params.tessedit_char_whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';
      await w.setParameters(params);
      return w;
    })();
  }
  return workers[kind];
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
    if (best && best.score >= settings.minScore) out.match = { card: best.card, set: langOnly(best.lang), via: 'Name', score: best.score };
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
  $('#videoBox').hidden = false;
  layoutGuide();
  $('#cameraHint').hidden = true;
  $('#btnLive').hidden = false;
  $('#btnCamera').textContent = '■ Stopp';
  $('#btnCamera').classList.remove('primary');
  setLive(true); // Live-Scan startet direkt mit der Kamera
}
function stopCamera() {
  setLive(false);
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  $('#guide').hidden = true;
  $('#videoBox').hidden = true;
  $('#cameraHint').hidden = false;
  $('#liveIndicator').hidden = true;
  $('#btnLive').hidden = true;
  $('#btnCamera').textContent = '📷 Kamera starten';
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
let live = false, liveBusy = false, liveRun = 0, pendingId = null, pendingCount = 0, lastAcceptedId = null, missCount = 0;

function setLive(on) {
  live = on;
  liveRun++; // alte Schleifen beenden sich selbst
  const b = $('#btnLive');
  b.textContent = on ? '⏸ Pause' : '▶ Weiter';
  b.classList.toggle('on', !on);
  const ind = $('#liveIndicator');
  ind.hidden = !stream;
  ind.classList.toggle('paused', !on);
  if (on) { ensureAudio(); pendingId = null; lastAcceptedId = null; missCount = 0; liveStatus('suche Karte…'); liveLoop(liveRun); }
  else ind.textContent = 'PAUSE';
}
const liveStatus = t => { $('#liveIndicator').textContent = 'LIVE · ' + t; };

async function liveLoop(run) {
  if (!live || run !== liveRun) return;
  if (!liveBusy && dbReady && video.readyState >= 2) {
    liveBusy = true;
    try {
      const card = grabFrame();
      const r = await recognizeCard(card, settings.scanMode);
      if (run === liveRun) {
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
      }
    } catch (e) { console.error(e); }
    liveBusy = false;
  }
  setTimeout(() => liveLoop(run), settings.interval);
}

/* ------------------------------------------------------- Sammlung */
let collection = LS.get('collection', {}); // key -> {id, code, setName, rarity, lang, count, pile, color, first, last}
let history = LS.get('history', []); // letzte Scans (bleiben nach Neuladen erhalten)
const saveHistory = () => LS.set('history', history.slice(0, 200));
const saveCollection = () => LS.set('collection', collection);
const collKey = (id, code, lang) => id + '|' + (code || '') + '|' + (lang || '');

function addToCollection(e, n = 1) {
  const k = collKey(e.id, e.code, e.lang);
  const c = collection[k] ||= { id: e.id, code: e.code || '', setName: e.setName || '', rarity: e.rarity || '', lang: e.lang || '', count: 0, first: Date.now() };
  c.count += n;
  c.pile = e.pile; c.color = e.color; c.last = Date.now();
  if (c.count <= 0) delete collection[k];
  saveCollection();
}
const entrySet = e => ({ code: e.code || '', name: e.setName || '', rarities: e.rarity ? e.rarity.split(' / ') : [], lang: e.lang || '' });
function applyRules(e) {
  const card = byId.get(e.id), s = entrySet(e), ev = evaluate(card, s);
  e.pile = ev ? ev.pile : settings.ignoreUnmatched ? null : fillTemplate(settings.defaultPile, card, s) || 'Rest';
  e.color = ev ? ev.color : '#6b7280';
  return ev?.rule || null;
}

function accept(card, set, opts = {}) {
  set ||= langOnly('');
  const entry = {
    t: Date.now(), id: card.id, code: set.code || '', setName: set.name || '', rarity: (set.rarities || []).join(' / '), lang: set.lang || '',
    via: opts.via || 'manuell', score: opts.score ?? 1, added: false,
    cat: category(card), formats: formatsOf(card),
    formatHit: settings.formatScan ? isFormatHit(card) : null, // null = Format-Suche aus
  };
  const rule = applyRules(entry);
  const pile = entry.pile;
  if (pile !== null && settings.addToCollection && (!rule || rule.collect !== false)) {
    addToCollection(entry); entry.added = true;
  }
  history.unshift(entry);
  history.length = Math.min(history.length, 200);
  saveHistory();
  showResult(card, set, entry, rule, opts);
  feedback(entry, rule);
  renderHistory();
  renderCollection();
}
function undo(entry) {
  if (entry.added) addToCollection(entry, -1);
  history = history.filter(h => h !== entry);
  saveHistory();
  renderHistory(); renderCollection();
}
// Nachträglich Druck (Set-Code aus der DB) und/oder Sprache eines Scans ändern
function updateEntry(entry, { code, lang }) {
  const card = byId.get(entry.id);
  if (entry.added) addToCollection(entry, -1);
  if (lang !== undefined) entry.lang = lang;
  if (code !== undefined) {
    const sets = card.s.filter(s => s[0] === code);
    entry.setName = sets[0]?.[1] || '';
    entry.rarity = [...new Set(sets.map(s => s[2]))].join(' / ');
    entry.dbCode = code;
  }
  if (entry.dbCode) entry.code = codeForLang(entry.dbCode, entry.lang);
  else if (entry.code) entry.code = codeForLang(entry.code, entry.lang);
  const rule = applyRules(entry);
  if (entry.added) addToCollection(entry);
  saveHistory();
  showResult(card, entrySet(entry), entry, rule, {});
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
// Positiver Dreiklang für Format-Treffer
function chime() { beep(660, 0.14, 0, 'sine', 0.3); beep(880, 0.14, 0.12, 'sine', 0.3); beep(1320, 0.3, 0.24, 'sine', 0.3); }
let flashTimer;
function formatFlash(hit) {
  const wrap = $('#cameraWrap'), badge = $('#formatBadge');
  wrap.classList.remove('flash-hit', 'flash-miss');
  void wrap.offsetWidth; // Animation neu starten
  wrap.classList.add(hit ? 'flash-hit' : 'flash-miss');
  badge.hidden = false;
  badge.className = hit ? 'hit' : 'miss';
  badge.textContent = hit ? `✓ ${formatTargetLabel()}!` : `✗ nicht ${formatTargetLabel()}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { badge.hidden = true; wrap.classList.remove('flash-hit', 'flash-miss'); }, hit ? 2500 : 1200);
}
function feedback(entry, rule) {
  // Format-Suche aktiv: Treffer = grün + positiver Ton, sonst nur kurzer leiser Ton
  if (entry.formatHit !== null && entry.formatHit !== undefined) {
    formatFlash(entry.formatHit);
    if (entry.formatHit) {
      if (settings.sound) chime();
      if (settings.vibrate && navigator.vibrate) navigator.vibrate([90, 60, 90]);
      if (settings.speech && 'speechSynthesis' in window) {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(entry.formats.find(f => settings.formatTarget === '*' || f === settings.formatTarget) || 'Treffer');
        u.lang = 'de-DE';
        speechSynthesis.speak(u);
      }
    } else if (settings.sound) beep(240, 0.09, 0, 'sine', 0.12);
    return;
  }
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
  const fh = entry.formatHit;
  el.className = 'result' + (rule?.alarm && fh == null ? ' alarm' : '') + (fh === true ? ' format-hit' : fh === false ? ' format-miss' : '');
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
    ${fh === true ? `<div class="fmt-banner hit">🎯 ${esc(formatTargetLabel())} – Treffer! Zur Seite legen</div>` : ''}
    ${fh === false ? `<div class="fmt-banner miss">nicht ${esc(formatTargetLabel())}${entry.formats?.length ? ' (' + esc(entry.formats.join(', ')) + ')' : ''}</div>` : ''}
    <div class="pile" style="background:${esc(entry.color)}">${entry.pile === null ? '<span class="muted">ignoriert</span>' : '→ ' + esc(entry.pile)}</div>
    <div class="info">
      ${thumb ? `<img src="${thumb}" alt="">` : ''}
      <div>
        <div class="name">${esc(displayName(card))}</div>
        ${otherName ? `<div class="muted small">${esc(otherName)}</div>` : ''}
        <div>${cardTags(card)}</div>
        <div class="small" style="margin-top:4px">
          ${set?.code ? `<b>${esc(set.code)}</b> · ${esc(set.name)} · ${esc((set.rarities || []).join(' / '))}` : '<span class="muted">Druck unbekannt</span>'}
          · Sprache: <b>${esc(set?.lang || 'unbekannt')}</b> · Preis ${euro(card.p)}
        </div>
        <div class="small" style="margin-top:2px">
          📅 Erstveröffentlichung: <b>${card.d ? fmtDate(card.d) : '–'}</b> (TCG)${card.do ? ` · ${fmtDate(card.do)} (OCG/Japan)` : ''}
          · Format: <b>${esc(formatsOf(card).join(', ') || 'keins')}</b>
        </div>
        <div class="muted small via">erkannt über ${esc(entry.via)}${entry.via === 'Name' ? ` (${Math.round(entry.score * 100)} %)` : ''}${rule ? ` · Regel „${esc(rule.name)}“` : ' · keine Regel passt'}${entry.added ? ' · zur Sammlung hinzugefügt' : ''}</div>
      </div>
    </div>
    <div class="actions">
      ${entry.added ? '<button data-a="plus">＋1 weiteres Exemplar</button>' : ''}
      <button data-a="undo">↶ Rückgängig</button>
      <select data-a="lang" title="Sprache der Karte"><option value="">Sprache …</option>${LANGS.map(l => `<option ${l === set?.lang ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${printings.length ? `<select data-a="print"><option value="">${set?.code ? 'Druck ändern…' : 'Druck/Seltenheit wählen…'}</option>${printings.map(p => `<option value="${esc(p)}" ${set?.code && normCode(p) === normCode(set.code) ? 'selected' : ''}>${esc(codeForLang(p, set?.lang))}</option>`).join('')}</select>` : ''}
    </div>`;
  el.querySelector('[data-a=plus]')?.addEventListener('click', () => { addToCollection(entry); renderCollection(); beep(hashFreq(entry.pile), 0.08); });
  el.querySelector('[data-a=undo]').addEventListener('click', () => { undo(entry); showBusy('Rückgängig gemacht'); });
  el.querySelector('[data-a=print]')?.addEventListener('change', e => e.target.value && updateEntry(entry, { code: e.target.value }));
  el.querySelector('[data-a=lang]').addEventListener('change', e => updateEntry(entry, { lang: e.target.value }));

  // Alternativen anbieten, falls über den Namen erkannt
  renderCandidates((opts.candidates || []).filter(c => c.card.id !== card.id), entry);
}
function renderCandidates(cands, replaceEntry, thumb) {
  const box = $('#candidates');
  if (!cands?.length) { box.innerHTML = ''; return; }
  // eingeklappt, damit es auf dem Handy keinen Platz kostet
  box.innerHTML = `<details><summary class="muted small">Falsche Karte? ${cands.length} Alternativen</summary><div class="list">${cands.map((c, i) =>
    `<button data-i="${i}"><span>${esc(displayName(c.card))}</span><span class="muted small">${Math.round(c.score * 100)} %</span></button>`).join('')}</div></details>`;
  $$('button', box).forEach(b => b.addEventListener('click', () => {
    if (replaceEntry) undo(replaceEntry);
    const cand = cands[+b.dataset.i];
    accept(cand.card, langOnly(cand.lang), { via: 'Auswahl', thumb });
  }));
}
const CAT_ICON = { Monster: '🟧', Zauber: '🟩', Falle: '🟪', Token: '⬜', Skill: '🟦' };
function historyFiltered() {
  return history.filter(h => {
    const c = byId.get(h.id);
    if (!c) return false;
    if (settings.histCat && category(c) !== settings.histCat) return false;
    const fs = formatsOf(c), hf = settings.histFormat;
    if (hf === '__hit') return h.formatHit === true;
    if (hf === '__none') return fs.length === 0;
    if (hf) return fs.includes(hf);
    return true;
  });
}
function renderHistory() {
  if (!dbReady) return;
  const list = historyFiltered();
  $('#histCount').textContent = history.length ? `${list.length} von ${history.length}` : '';
  $('#history').innerHTML = list.slice(0, 50).map(h => {
    const c = byId.get(h.id), cat = category(c), fs = formatsOf(c);
    return `<li class="${h.formatHit === true ? 'is-hit' : ''}">
      <span class="dot" style="background:${esc(h.color)}"></span>
      <span class="h-main">
        <span class="h-name">${esc(displayName(c))}</span>
        <span class="h-tags"><span class="tag">${CAT_ICON[cat] || ''} ${esc(cat)}</span>${fs.map(f => `<span class="tag fmt">${esc(f)}</span>`).join('')}${h.lang ? `<span class="tag">${esc(LANG_REGION[h.lang] || h.lang)}</span>` : ''}${h.code ? `<span class="muted small">${esc(h.code)}</span>` : ''}</span>
      </span>
      <span class="p">${h.pile === null ? '<span class="muted">ignoriert</span>' : esc(h.pile)}</span>
    </li>`;
  }).join('') || `<li class="muted small">${history.length ? 'Keine Scans passen zum Filter.' : 'Noch keine Scans.'}</li>`;
}
// Auswahllisten, die die angelegten Formate enthalten, aktualisieren
function refreshFormatSelects() {
  const names = formats.map(f => f.name).filter(Boolean);
  const ft = $('#formatTarget');
  ft.innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('') + '<option value="*">irgendein Format</option>';
  if (!names.includes(settings.formatTarget) && settings.formatTarget !== '*') settings.formatTarget = names[0] || '*';
  ft.value = settings.formatTarget;
  const hf = $('#histFormat');
  hf.innerHTML = `<option value="">Alle Formate</option><option value="__hit">🎯 Nur Format-Treffer</option>${names.map(n => `<option>${esc(n)}</option>`).join('')}<option value="__none">Kein Format</option>`;
  if (![...hf.options].some(o => o.value === settings.histFormat)) settings.histFormat = '';
  hf.value = settings.histFormat;
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
  for (const [k, f] of Object.entries(FIELDS)) if (f.values) lists[k] = typeof f.values === 'function' ? f.values() : f.values;
  lists.archetyp = [...new Set(CARDS.map(c => c.ar).filter(Boolean))].sort();
  lists.set = [...new Set([...codeIndex.values()].map(e => e.set.code.split('-')[0]))].sort();
  lists.seltenheit = [...new Set([...codeIndex.values()].flatMap(e => e.set.rarities))].sort();
  $('#datalists').innerHTML = Object.entries(lists).map(([k, vals]) => `<datalist id="dl-${k}">${vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`).join('');
}

/* ------------------------------------------------------- UI: Sammlung */
const SORT_KEYS = { '': '–', stapel: 'Stapel', ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.label])), setcode: 'Set-Code', anzahl: 'Anzahl', zuletzt: 'Zuletzt gescannt' };

// Alle möglichen Tabellenspalten. val = Text (auch für CSV), html = optionale Darstellung
const fieldCol = (key, label) => ({ key, label, num: FIELDS[key].num, val: (e, c) => showField(key, c, entrySet(e)) });
const COLUMNS = [
  { key: 'anzahl', label: 'Anz.', val: e => e.count,
    html: e => `<span class="cnt"><button class="small" data-d="-1">−</button><b>${e.count}</b><button class="small" data-d="1">＋</button></span>` },
  { key: 'name', label: 'Name', val: (e, c) => displayName(c),
    html: (e, c) => `<b>${esc(displayName(c))}</b>${c.nd && settings.lang === 'de' && c.nd !== c.n ? `<div class="muted small">${esc(c.n)}</div>` : ''}` },
  { key: 'nameDe', label: 'Name (DE)', val: (e, c) => c.nd },
  { key: 'nameEn', label: 'Name (EN)', val: (e, c) => c.n },
  { key: 'sprache', label: 'Sprache', val: e => e.lang || '' },
  fieldCol('kategorie', 'Kategorie'),
  fieldCol('monsterart', 'Monster-Art'),
  fieldCol('deck', 'Deck'),
  fieldCol('attribut', 'Attribut'),
  fieldCol('typ', 'Typ'),
  fieldCol('stufe', 'St.'),
  fieldCol('atk', 'ATK'),
  fieldCol('def', 'DEF'),
  fieldCol('archetyp', 'Archetyp'),
  { key: 'setcode', label: 'Set-Code', val: e => e.code || '' },
  { key: 'setname', label: 'Set', val: e => e.setName || '' },
  { key: 'seltenheit', label: 'Seltenheit', val: e => e.rarity || '' },
  fieldCol('erstdruck', 'Erstveröff. (TCG)'),
  fieldCol('erstdruckOcg', 'Erstveröff. (OCG)'),
  fieldCol('jahr', 'Jahr'),
  fieldCol('format', 'Format'),
  fieldCol('formate', 'Alle Formate'),
  fieldCol('banlist', 'Banlist'),
  { key: 'preis', label: 'Preis', num: true, val: (e, c) => euro(c.p), csv: (e, c) => (c.p || 0).toFixed(2).replace('.', ',') },
  { key: 'wert', label: 'Gesamtwert', num: true, val: (e, c) => euro(e.count * (c.p || 0)), csv: (e, c) => (e.count * (c.p || 0)).toFixed(2).replace('.', ',') },
  { key: 'stapel', label: 'Stapel', val: e => e.pile || '',
    html: e => (e.pile ? `<span class="pile-chip" style="background:${esc(e.color || '#6b7280')}">${esc(e.pile)}</span>` : '') },
  { key: 'zuletzt', label: 'Zuletzt gescannt', val: e => (e.last ? new Date(e.last).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '') },
];
const COL_BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]));
const DEFAULT_COLS = ['anzahl', 'name', 'sprache', 'kategorie', 'attribut', 'typ', 'stufe', 'atk', 'def', 'setcode', 'seltenheit', 'erstdruck', 'format', 'preis', 'stapel'];

let collView = { sort: [['stapel', 1], ['name', 1], ['', 1]], group: 'stapel', q: '', cols: DEFAULT_COLS, ...LS.get('collView', {}) };
collView.cols = (collView.cols || DEFAULT_COLS).filter(k => COL_BY_KEY[k]);
const saveCollView = () => LS.set('collView', collView);
const visibleCols = () => collView.cols.map(k => COL_BY_KEY[k]).filter(Boolean);

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
function sortedEntries() {
  let entries = Object.entries(collection).filter(([, e]) => byId.has(e.id));
  const q = normName(collView.q || '');
  if (q) entries = entries.filter(([, e]) => { const c = byId.get(e.id); return normName(c.n).includes(q) || normName(c.nd).includes(q) || normName(e.code).includes(q) || normName(e.pile || '').includes(q); });
  const sorts = collView.sort.filter(([k]) => k);
  entries.sort(([, a], [, b]) => { for (const [k, dir] of sorts) { const r = cmp(sortValue(a, k), sortValue(b, k)); if (r) return r * dir; } return 0; });
  return entries;
}
function renderCollection() {
  const box = $('#collection');
  if (!dbReady) { box.innerHTML = '<p class="muted">Datenbank lädt…</p>'; return; }
  const entries = sortedEntries();
  const total = entries.reduce((s, [, e]) => s + e.count, 0);
  const value = entries.reduce((s, [, e]) => s + e.count * (byId.get(e.id).p || 0), 0);
  $('#collSummary').textContent = `${total.toLocaleString('de-DE')} Karten (${entries.length} verschiedene) · geschätzter Wert ${euro(value)}`;
  if (!entries.length) { box.innerHTML = '<p class="muted">Noch keine Karten in der Sammlung. Scanne welche!</p>'; return; }

  const cols = visibleCols();
  const cell = (col, e, c) => `<td${col.num ? ' class="num"' : ''}>${col.html ? col.html(e, c) : esc(col.val(e, c))}</td>`;
  const row = ([k, e]) => { const c = byId.get(e.id); return `<tr data-k="${esc(k)}">${cols.map(col => cell(col, e, c)).join('')}</tr>`; };
  const table = list => `<div class="table-wrap"><table><thead><tr>${cols.map(col => `<th${col.num ? ' class="num"' : ''}>${esc(col.label)}</th>`).join('')}</tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;

  if (!collView.group) { box.innerHTML = table(entries); return; }
  const groups = new Map();
  for (const pair of entries) {
    const e = pair[1];
    const raw = sortValue(e, collView.group);
    const g = String((FIELDS[collView.group]?.date ? fmtDate(raw) : raw) || '–');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(pair);
  }
  box.innerHTML = [...groups].map(([g, list]) => `<div class="group-h"><h3>${esc(g)}</h3><span class="muted">${list.reduce((s, [, e]) => s + e.count, 0)} Karten · ${euro(list.reduce((s, [, e]) => s + e.count * (byId.get(e.id).p || 0), 0))}</span></div>${table(list)}`).join('');
}
// Spaltenauswahl: sichtbare Spalten (in Reihenfolge, verschiebbar) + ausgeblendete
function renderColChooser() {
  const box = $('#colChooser');
  const hidden = COLUMNS.filter(c => !collView.cols.includes(c.key));
  const item = (col, on, i) => `<div class="col-item${on ? ' on' : ''}">
      <label class="chk"><input type="checkbox" data-col="${col.key}" ${on ? 'checked' : ''}> ${esc(col.label)}</label>
      ${on ? `<button class="small" data-mv="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="nach links">◀</button><button class="small" data-mv="1" data-i="${i}" ${i === collView.cols.length - 1 ? 'disabled' : ''} title="nach rechts">▶</button>` : ''}
    </div>`;
  box.innerHTML = `<div class="muted small">Angezeigt (Reihenfolge mit ◀ ▶ ändern):</div>
    <div class="col-list">${visibleCols().map((c, i) => item(c, true, i)).join('')}</div>
    <div class="muted small" style="margin-top:8px">Ausgeblendet:</div>
    <div class="col-list">${hidden.map(c => item(c, false)).join('') || '<span class="muted small">–</span>'}</div>
    <div style="margin-top:8px"><button class="small" data-reset>Standard wiederherstellen</button></div>`;
}
function initCollectionUi() {
  const opts = () => Object.entries(SORT_KEYS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
  $$('.sortKey').forEach(s => { s.innerHTML = opts(); s.value = collView.sort[+s.dataset.i][0]; });
  $$('.sortDir').forEach(b => { b.textContent = collView.sort[+b.dataset.i][1] > 0 ? '↑' : '↓'; });
  $('#groupBy').innerHTML = Object.entries(SORT_KEYS).filter(([k]) => !['anzahl', 'zuletzt', 'name', 'atk', 'def', 'preis', 'erstdruckOcg'].includes(k)).map(([k, l]) => `<option value="${k}">${esc(l === '–' ? 'nicht gruppieren' : l)}</option>`).join('');
  $('#groupBy').value = collView.group;
  $('#collSearch').value = collView.q;
  const save = () => { saveCollView(); renderCollection(); };
  $$('.sortKey').forEach(s => s.addEventListener('change', () => { collView.sort[+s.dataset.i][0] = s.value; save(); }));
  $$('.sortDir').forEach(b => b.addEventListener('click', () => { const s = collView.sort[+b.dataset.i]; s[1] *= -1; b.textContent = s[1] > 0 ? '↑' : '↓'; save(); }));
  $('#groupBy').addEventListener('change', e => { collView.group = e.target.value; save(); });
  $('#collSearch').addEventListener('input', e => { collView.q = e.target.value; save(); });

  $('#btnCols').addEventListener('click', () => { const b = $('#colChooser'); b.hidden = !b.hidden; if (!b.hidden) renderColChooser(); });
  $('#colChooser').addEventListener('change', e => {
    const k = e.target.dataset.col; if (!k) return;
    collView.cols = e.target.checked ? [...collView.cols, k] : collView.cols.filter(x => x !== k);
    renderColChooser(); save();
  });
  $('#colChooser').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-reset')) collView.cols = [...DEFAULT_COLS];
    else if (b.dataset.mv) {
      const i = +b.dataset.i, j = i + +b.dataset.mv, a = collView.cols;
      if (j < 0 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
    }
    renderColChooser(); save();
  });

  $('#collection').addEventListener('click', e => {
    const b = e.target.closest('button[data-d]');
    if (!b) return;
    const k = b.closest('tr').dataset.k, ent = collection[k];
    if (!ent) return;
    ent.count += +b.dataset.d;
    if (ent.count <= 0) delete collection[k];
    saveCollection(); renderCollection();
  });
  $('#btnRepile').addEventListener('click', () => {
    for (const e of Object.values(collection)) if (byId.has(e.id)) applyRules(e);
    saveCollection(); renderCollection();
  });
  $('#btnCsv').addEventListener('click', exportCsv);
  $('#btnBackup').addEventListener('click', () => download('ygo-backup.json', JSON.stringify({ version: 2, collection, rules, formats, settings, collView }, null, 1), 'application/json'));
  $('#backupInput').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!confirm('Backup laden? Sammlung, Regeln und Formate werden ersetzt.')) return;
      if (data.collection) { collection = data.collection; saveCollection(); }
      if (data.rules) { rules = data.rules.map(hydrateRule); saveRules(); renderRules(); }
      if (data.formats) { formats = data.formats; saveFormats(); renderFormats(); }
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
// CSV mit den aktuell angezeigten Spalten in der aktuellen Sortierung
function exportCsv() {
  const cols = visibleCols();
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(c => q(c.label)).join(';')];
  for (const [, e] of sortedEntries()) {
    const c = byId.get(e.id);
    lines.push(cols.map(col => q((col.csv || col.val)(e, c))).join(';'));
  }
  download('ygo-sammlung.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/* ------------------------------------------------------- UI: Spielformate */
function renderFormats() {
  const box = $('#formatsList');
  box.innerHTML = formats.map((f, i) => `
    <div class="format-row" data-i="${i}">
      <input type="text" data-f="name" value="${esc(f.name)}" placeholder="Name, z.B. GOAT">
      <label>von <input type="date" data-f="from" value="${esc(f.from)}"></label>
      <label>bis <input type="date" data-f="to" value="${esc(f.to)}"></label>
      <span class="muted small" data-count></span>
      <button class="small danger" data-del title="Format löschen">🗑</button>
    </div>`).join('') || '<p class="muted small">Noch keine Formate angelegt.</p>';
  updateFormatCounts();
  buildDatalistsSafe();
  if ($('#formatTarget')) refreshFormatSelects();
}
function updateFormatCounts() {
  if (!dbReady) return;
  $$('#formatsList .format-row').forEach(row => {
    const f = formats[+row.dataset.i];
    const n = CARDS.filter(c => c.d && (!f.from || c.d >= f.from) && (!f.to || c.d <= f.to)).length;
    row.querySelector('[data-count]').textContent = `${n.toLocaleString('de-DE')} Karten`;
  });
}
const buildDatalistsSafe = () => { if (dbReady) buildDatalists(); };
function initFormatsUi() {
  const box = $('#formatsList');
  box.addEventListener('change', e => {
    const row = e.target.closest('.format-row'); if (!row || !e.target.dataset.f) return;
    formats[+row.dataset.i][e.target.dataset.f] = e.target.value.trim();
    saveFormats(); updateFormatCounts(); buildDatalistsSafe(); refreshFormatSelects(); renderCollection(); renderHistory();
  });
  box.addEventListener('click', e => {
    if (!e.target.closest('[data-del]')) return;
    const i = +e.target.closest('.format-row').dataset.i;
    if (!confirm(`Format „${formats[i].name}“ löschen?`)) return;
    formats.splice(i, 1); saveFormats(); renderFormats(); renderCollection();
  });
  $('#btnAddFormat').addEventListener('click', () => {
    formats.push({ id: uid(), name: 'Neues Format', from: '', to: '' });
    saveFormats(); renderFormats();
  });
  renderFormats();
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
      if (k === 'lang') { renderCollection(); renderHistory(); }
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
  video.addEventListener('loadedmetadata', layoutGuide);

  // Format-Suche
  const fsBox = $('#formatScanBox');
  $('#formatScan').checked = settings.formatScan;
  fsBox.classList.toggle('on', settings.formatScan);
  $('#formatScan').addEventListener('change', e => { settings.formatScan = e.target.checked; fsBox.classList.toggle('on', e.target.checked); saveSettings(); ensureAudio(); });
  $('#formatTarget').addEventListener('change', e => { settings.formatTarget = e.target.value; saveSettings(); renderHistory(); });

  // Filter der letzten Scans
  $('#histCat').value = settings.histCat;
  $('#histCat').addEventListener('change', e => { settings.histCat = e.target.value; saveSettings(); renderHistory(); });
  $('#histFormat').addEventListener('change', e => { settings.histFormat = e.target.value; saveSettings(); renderHistory(); });
  $('#histClear').addEventListener('click', () => { if (confirm('Liste der letzten Scans leeren? (Die Sammlung bleibt erhalten.)')) { history = []; saveHistory(); renderHistory(); } });
  refreshFormatSelects();
  // auf großen Bildschirmen aufgeklappt, auf dem Handy eingeklappt
  $('#manualBox').open = window.innerWidth > 820;
  $('#collOptions').open = window.innerWidth > 820;
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
  initFormatsUi();
  initSettingsUi();
  renderHistory();
  loadDb();
  // OCR-Engine schon mal vorwärmen
  if (window.Tesseract) { getWorker('code'); getWorker('name'); }
}
init();

// 設定值（存在 IndexedDB 的 settings store，一個 key 一筆）。
//
// 預設值集中在 DEFAULTS，測試會盯著其中兩條：
//   dayPLIncludeDividend 預設 true（當日損益含當日除息應收股利，PLAN §1）
//   dividendAutoFees     預設 false（自動扣匯費與補充保費，預設關，PLAN §1）

import * as db from './db.js';
import { DEFAULT_TODAY_THRESHOLD } from './market.js';

export const DEFAULTS = {
  fontScale: 'md',                 // sm | md | lg | xl
  dayPLIncludeDividend: true,
  dividendAutoFees: false,
  todayDataThreshold: DEFAULT_TODAY_THRESHOLD,
  // 「今日觀察」的一次性同意。預設 false —— 沒有勾過就不會產生任何 AI 內容。
  insightConsent: false,
};

const cache = new Map();
let loaded = false;

export async function load() {
  const rows = await db.getAll('settings');
  cache.clear();
  for (const r of rows) cache.set(r.key, r.value);
  loaded = true;
}

export function get(key) {
  if (!loaded) throw new Error('prefs.load() 還沒跑完就讀設定');
  return cache.has(key) ? cache.get(key) : DEFAULTS[key];
}

export async function set(key, value) {
  cache.set(key, value);
  await db.put('settings', { key, value });
}

export function all() {
  const out = { ...DEFAULTS };
  for (const [k, v] of cache) out[k] = v;
  return out;
}

const SCALES = { sm: 0.92, md: 1, lg: 1.15, xl: 1.34 };

/** 把字級套到 <html> 上。特大字級的版面由 layouttest 掃描。 */
export function applyFontScale(scale = get('fontScale')) {
  const root = document.documentElement;
  root.style.setProperty('--font-scale', String(SCALES[scale] ?? 1));
  root.dataset.fontScale = scale;
}

export const FONT_SCALE_LABELS = { sm: '小', md: '標準', lg: '大', xl: '特大' };

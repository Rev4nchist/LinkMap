/**
 * Creates a debounced version of a function.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  const debounced = function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
  // A6: lets an immediate write cancel a still-pending debounced one, so a
  // stale trailing debounce can never clobber a newer write.
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/**
 * Smart tab search — tiered scoring that prioritizes meaningful matches.
 * Returns { match: boolean, score: number, indices: number[], tier: string }
 *
 * Scoring tiers (highest first):
 *   1000  Exact match (case-insensitive)
 *    900  Starts with query
 *    800  Word boundary match (query matches at start of a word)
 *    700  Substring match (query found as contiguous substring)
 *  100-300 Scored fuzzy match (characters in order with gap penalties)
 *      0  No match
 */
export function smartSearch(query, text) {
  const NO_MATCH = { match: false, score: 0, indices: [], tier: 'none' };
  if (!query || !text) return NO_MATCH;

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Tier 1: Exact match
  if (t === q) {
    return { match: true, score: 1000, indices: range(0, q.length), tier: 'exact' };
  }

  // Tier 2: Starts with
  if (t.startsWith(q)) {
    return { match: true, score: 900, indices: range(0, q.length), tier: 'prefix' };
  }

  // Tier 3: Word boundary match — query matches at start of a word
  const wordBoundaryIdx = findWordBoundaryMatch(q, t);
  if (wordBoundaryIdx !== -1) {
    return {
      match: true, score: 800,
      indices: range(wordBoundaryIdx, q.length), tier: 'word-boundary',
    };
  }

  // Tier 4: Substring match — contiguous substring anywhere
  const substringIdx = t.indexOf(q);
  if (substringIdx !== -1) {
    return {
      match: true, score: 700,
      indices: range(substringIdx, q.length), tier: 'substring',
    };
  }

  // Tier 5: Scored fuzzy match (gap penalties)
  return scoredFuzzyMatch(q, t, text);
}


function range(start, length) {
  return Array.from({ length }, (_, i) => start + i);
}

function findWordBoundaryMatch(query, text) {
  const separators = new Set([' ', '-', '_', '.', '/', ':', '|']);
  for (let i = 0; i <= text.length - query.length; i++) {
    const isWordStart = i === 0 || separators.has(text[i - 1]);
    if (isWordStart && text.substring(i, i + query.length) === query) {
      return i;
    }
  }
  return -1;
}

/**
 * Scored fuzzy match with gap penalties.
 * @param {string} query - lowercased query
 * @param {string} text - lowercased text
 * @param {string} originalText - original-case text (for camelCase detection)
 */
function scoredFuzzyMatch(query, text, originalText) {
  const NO_MATCH = { match: false, score: 0, indices: [], tier: 'none' };
  const SCORE_MATCH = 16;
  const SCORE_GAP_START = -3;
  const SCORE_GAP_EXTENSION = -1;
  const BONUS_CONSECUTIVE = 4;
  const BONUS_SEPARATOR = 9;
  const BONUS_WORD_START = 10;
  const BONUS_CAMEL = 7;
  const BONUS_FIRST_CHAR = 2;

  const separators = new Set(['-', '_', '.', '/', ':', '|', ' ']);
  const indices = [];
  let qi = 0;
  let score = 0;
  let prevMatchIdx = -1;

  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      indices.push(ti);

      let charScore = SCORE_MATCH;

      // Bonus: consecutive match
      if (prevMatchIdx === ti - 1) {
        charScore += BONUS_CONSECUTIVE;
      }

      // Bonus: word boundary (check original case for camelCase)
      if (ti === 0) {
        charScore += BONUS_WORD_START * BONUS_FIRST_CHAR;
      } else if (separators.has(text[ti - 1])) {
        charScore += BONUS_SEPARATOR;
      } else if (
        originalText[ti - 1] >= 'a' && originalText[ti - 1] <= 'z' &&
        originalText[ti] >= 'A' && originalText[ti] <= 'Z'
      ) {
        charScore += BONUS_CAMEL;
      }

      // Gap penalty
      if (prevMatchIdx >= 0 && prevMatchIdx < ti - 1) {
        const gapSize = ti - prevMatchIdx - 1;
        charScore += SCORE_GAP_START + (gapSize - 1) * SCORE_GAP_EXTENSION;
      }

      score += charScore;
      prevMatchIdx = ti;
      qi++;
    }
  }

  if (qi < query.length) return NO_MATCH;

  // Normalize to 100-300 range for the fuzzy tier
  const maxScore = query.length * 26;
  const normalized = Math.max(1, Math.min(300, Math.round((score / maxScore) * 200 + 100)));

  return { match: true, score: normalized, indices, tier: 'fuzzy' };
}

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------

/**
 * Returns all tab IDs belonging to a group.
 * @param {Object} tabs - Plain object of tabId -> TabNode
 * @param {number} groupId
 * @returns {number[]}
 */
export function getGroupTabIds(tabs, groupId) {
  return Object.values(tabs)
    .filter(tab => tab.groupId === groupId)
    .map(tab => tab.tabId);
}

/**
 * Returns a Map of groupId -> display order index, based on first
 * occurrence in rootIds. Used to sort groups in sidebar order.
 * @param {Object} tabs - Plain object of tabId -> TabNode
 * @param {number[]} rootIds
 * @param {number} ungroupedId - Sentinel value for ungrouped tabs
 * @returns {Map<number, number>}
 */
export function getGroupDisplayOrder(tabs, rootIds, ungroupedId) {
  const order = new Map();
  let idx = 0;
  for (const rootId of rootIds) {
    const t = tabs[rootId];
    if (!t) continue;
    const gid = t.groupId ?? ungroupedId;
    if (gid !== ungroupedId && !order.has(gid)) {
      order.set(gid, idx++);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Shared helpers (moved from sidepanel.js and context-menu.js)
// ---------------------------------------------------------------------------

/**
 * Collects all descendant tab IDs via tree walk.
 * @param {Object} tabs - Map-like of tabId -> TabNode
 * @param {number} tabId - Root tab ID
 * @returns {number[]}
 */
export function getDescendantIds(tabs, tabId) {
  const ids = [];
  const walk = (id) => {
    const tab = tabs[id];
    if (!tab || !tab.children) return;
    for (const childId of tab.children) {
      ids.push(childId);
      walk(childId);
    }
  };
  walk(tabId);
  return ids;
}

/**
 * Escapes HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Position a floating menu within the viewport bounds.
 * @param {HTMLElement} menuEl - The menu element (must be in the DOM)
 * @param {number} x - clientX position
 * @param {number} y - clientY position
 */
export function positionMenu(menuEl, x, y) {
  const rect = menuEl.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menuEl.style.left = `${Math.min(x, maxX)}px`;
  menuEl.style.top = `${Math.min(y, maxY)}px`;
}

/**
 * Converts a hex color to HSL [h, s, l] (degrees, %, %).
 * @param {string} hex
 * @returns {number[]}
 */
export function hexToHsl(hex) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return [h * 360, s * 100, l * 100];
}

/**
 * Converts HSL values to a hex color string.
 * @param {number} h - Hue (degrees)
 * @param {number} s - Saturation (%)
 * @param {number} l - Lightness (%)
 * @returns {string}
 */
export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Generates 10 monochromatic shades from a theme's accent color.
 * @param {string} themeName
 * @param {Object} themeAccents - Map of theme name to accent hex
 * @returns {string[]}
 */
export function generateThemePalette(themeName, themeAccents) {
  const accent = themeAccents[themeName];
  if (!accent) return ['#c084fc','#f87171','#34d399','#38bdf8','#f472b6','#fdd663','#81c995','#fcad70','#78d9ec','#c58af9'];

  const [h, s] = hexToHsl(accent);
  const palette = [];
  for (let i = 0; i < 10; i++) {
    const lightness = 20 + (70 * i / 9);
    const midDist = Math.abs(lightness - 55) / 35;
    const saturation = Math.max(15, s * (1 - midDist * 0.3));
    palette.push(hslToHex(h, saturation, lightness));
  }
  return palette;
}

/**
 * Create a DOM element with attributes and children.
 * @param {string} tag
 * @param {Object} attrs
 * @param  {...(Node|string)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') {
      element.className = value;
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else if (key.startsWith('on')) {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      element.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else if (child) {
      element.appendChild(child);
    }
  }
  return element;
}

/**
 * Extracts the hostname from a URL string.
 * @param {string} url
 * @returns {string} hostname or the original string on failure
 */
export function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * Shows an inline text input near an anchor element.
 * Resolves with the entered text on Enter, or null on Escape/blur.
 * @param {HTMLElement} anchorEl - Element to position near
 * @param {string} [placeholder=''] - Placeholder text
 * @param {string} [defaultValue=''] - Pre-filled value
 * @returns {Promise<string|null>}
 */
export function inlinePrompt(anchorEl, placeholder = '', defaultValue = '') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-prompt-input';
    input.placeholder = placeholder;
    input.value = defaultValue;

    // Position after anchor
    anchorEl.after(input);
    input.focus();
    input.select();

    let resolved = false;
    function finish(value) {
      if (resolved) return;
      resolved = true;
      input.remove();
      resolve(value);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        finish(val || null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });

    input.addEventListener('blur', () => finish(null));
  });
}

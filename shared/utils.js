/**
 * Creates a debounced version of a function.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Simple fuzzy match — checks if characters of query appear in order in text.
 * Returns { match: boolean, score: number, indices: number[] }
 */
export function fuzzyMatch(query, text) {
  if (!query || !text) return { match: false, score: 0, indices: [] };

  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  const indices = [];
  let qi = 0;

  for (let ti = 0; ti < lowerText.length && qi < lowerQuery.length; ti++) {
    if (lowerText[ti] === lowerQuery[qi]) {
      indices.push(ti);
      qi++;
    }
  }

  if (qi < lowerQuery.length) return { match: false, score: 0, indices: [] };

  // Score: prefer consecutive matches and matches at start
  let score = lowerQuery.length / lowerText.length;
  let consecutive = 0;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) consecutive++;
  }
  score += consecutive / lowerQuery.length;
  if (indices[0] === 0) score += 0.5;

  return { match: true, score, indices };
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

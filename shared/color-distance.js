/**
 * color-distance.js — Delta E (CIE76) color distance for Smart Mapper.
 *
 * Maps arbitrary HEX colors to the nearest Chrome tab group color enum
 * using perceptual distance in CIELAB color space.
 */

import { CHROME_GROUP_COLORS } from './constants.js';

/**
 * Parse a hex color string to [R, G, B] (0-255).
 * @param {string} hex - e.g. '#ff00ff' or '#FFF'
 * @returns {number[]}
 */
function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return [0, 0, 0];
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * Convert sRGB (0-255) to CIELAB [L, a, b].
 * Uses D65 illuminant reference white.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number[]}
 */
function rgbToLab(r, g, b) {
  // Linearize sRGB
  let lr = r / 255;
  let lg = g / 255;
  let lb = b / 255;

  lr = lr > 0.04045 ? Math.pow((lr + 0.055) / 1.055, 2.4) : lr / 12.92;
  lg = lg > 0.04045 ? Math.pow((lg + 0.055) / 1.055, 2.4) : lg / 12.92;
  lb = lb > 0.04045 ? Math.pow((lb + 0.055) / 1.055, 2.4) : lb / 12.92;

  // sRGB to XYZ (D65)
  let x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  let y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) / 1.00000;
  let z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883;

  // XYZ to Lab
  const epsilon = 0.008856;
  const kappa = 903.3;

  x = x > epsilon ? Math.cbrt(x) : (kappa * x + 16) / 116;
  y = y > epsilon ? Math.cbrt(y) : (kappa * y + 16) / 116;
  z = z > epsilon ? Math.cbrt(z) : (kappa * z + 16) / 116;

  return [
    116 * y - 16,   // L
    500 * (x - y),  // a
    200 * (y - z),  // b
  ];
}

/**
 * CIE76 Delta E — Euclidean distance in Lab space.
 * @param {number[]} lab1
 * @param {number[]} lab2
 * @returns {number}
 */
function deltaE(lab1, lab2) {
  return Math.sqrt(
    (lab1[0] - lab2[0]) ** 2 +
    (lab1[1] - lab2[1]) ** 2 +
    (lab1[2] - lab2[2]) ** 2
  );
}

/**
 * Pre-compute Lab values for Chrome's 9 group color enums.
 * @type {Array<{name: string, lab: number[]}>}
 */
const CHROME_COLOR_LABS = Object.entries(CHROME_GROUP_COLORS).map(([name, hex]) => ({
  name,
  lab: rgbToLab(...hexToRgb(hex)),
}));

/**
 * Find the nearest Chrome tab group color enum for an arbitrary hex color.
 *
 * @param {string} hex - Any hex color (e.g. '#39ff14')
 * @returns {string} Chrome group color enum (e.g. 'green')
 */
export function nearestChromeGroupColor(hex) {
  const targetLab = rgbToLab(...hexToRgb(hex));
  let bestName = 'grey';
  let bestDist = Infinity;

  for (const { name, lab } of CHROME_COLOR_LABS) {
    const dist = deltaE(targetLab, lab);
    if (dist < bestDist) {
      bestDist = dist;
      bestName = name;
    }
  }

  return bestName;
}

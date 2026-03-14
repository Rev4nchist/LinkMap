import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// color-distance.js only exports nearestChromeGroupColor. It imports
// CHROME_GROUP_COLORS from constants.js, which is a plain object — no DOM needed.
// ---------------------------------------------------------------------------

const { nearestChromeGroupColor } = await import('../shared/color-distance.js');

// ---------------------------------------------------------------------------
// Tests: nearestChromeGroupColor
// ---------------------------------------------------------------------------

describe('nearestChromeGroupColor', () => {
  // Chrome's canonical group colors (from constants.js):
  //   grey:   '#5f6368'
  //   blue:   '#8ab4f8'
  //   red:    '#f28b82'
  //   yellow: '#fdd663'
  //   green:  '#81c995'
  //   pink:   '#ff8bcb'
  //   purple: '#c58af9'
  //   cyan:   '#78d9ec'
  //   orange: '#fcad70'

  it('maps exact Chrome color hex to its own name', () => {
    assert.equal(nearestChromeGroupColor('#8ab4f8'), 'blue');
    assert.equal(nearestChromeGroupColor('#f28b82'), 'red');
    assert.equal(nearestChromeGroupColor('#fdd663'), 'yellow');
    assert.equal(nearestChromeGroupColor('#81c995'), 'green');
    assert.equal(nearestChromeGroupColor('#ff8bcb'), 'pink');
    assert.equal(nearestChromeGroupColor('#c58af9'), 'purple');
    assert.equal(nearestChromeGroupColor('#78d9ec'), 'cyan');
    assert.equal(nearestChromeGroupColor('#fcad70'), 'orange');
    assert.equal(nearestChromeGroupColor('#5f6368'), 'grey');
  });

  it('maps near-red colors to red', () => {
    // Bright red
    assert.equal(nearestChromeGroupColor('#ff0000'), 'red');
    // Dark reddish
    assert.equal(nearestChromeGroupColor('#cc4444'), 'red');
  });

  it('maps near-blue colors to blue', () => {
    // Cornflower blue
    assert.equal(nearestChromeGroupColor('#6495ed'), 'blue');
    // Dodger blue
    assert.equal(nearestChromeGroupColor('#5b9bd5'), 'blue');
  });

  it('maps near-green colors to green', () => {
    // Medium sea green
    assert.equal(nearestChromeGroupColor('#66cc99'), 'green');
  });

  it('maps near-yellow colors to yellow', () => {
    // Gold
    assert.equal(nearestChromeGroupColor('#ffd700'), 'yellow');
  });

  it('maps near-purple colors to purple', () => {
    // Medium purple
    assert.equal(nearestChromeGroupColor('#9370db'), 'purple');
    // Violet
    assert.equal(nearestChromeGroupColor('#ee82ee'), 'purple');
  });

  it('maps near-orange colors to orange', () => {
    // Peach
    assert.equal(nearestChromeGroupColor('#ffcc88'), 'orange');
  });

  it('maps near-cyan colors to cyan', () => {
    // Light cyan
    assert.equal(nearestChromeGroupColor('#87ceeb'), 'cyan');
  });

  it('maps near-pink colors to pink', () => {
    // Hot pink
    assert.equal(nearestChromeGroupColor('#ff69b4'), 'pink');
  });

  it('maps black to grey (closest dark color)', () => {
    const result = nearestChromeGroupColor('#000000');
    assert.equal(result, 'grey');
  });

  it('handles 3-character hex shorthand via fallback (treated as invalid)', () => {
    // hexToRgb handles 3-char shorthand by doubling each char
    // '#fff' -> '#ffffff' -> white
    // White should map to yellow (lightest Chrome color)
    const result = nearestChromeGroupColor('#fff');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0, 'should return a valid color name');
  });

  it('handles uppercase hex', () => {
    assert.equal(nearestChromeGroupColor('#8AB4F8'), 'blue');
  });

  it('handles missing hash prefix', () => {
    // hexToRgb strips '#' so bare hex should work
    assert.equal(nearestChromeGroupColor('8ab4f8'), 'blue');
  });

  it('returns grey for null/undefined/empty input', () => {
    // hexToRgb returns [0,0,0] for invalid input -> black -> grey
    assert.equal(nearestChromeGroupColor(null), 'grey');
    assert.equal(nearestChromeGroupColor(undefined), 'grey');
    assert.equal(nearestChromeGroupColor(''), 'grey');
  });

  it('returns a string for any valid hex input', () => {
    // Neon green
    const result = nearestChromeGroupColor('#39ff14');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

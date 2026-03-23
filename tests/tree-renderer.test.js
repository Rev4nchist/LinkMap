import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockElement, MockTextNode, setupMockDOM } from './helpers/mock-dom.js';

// Setup global DOM mocks
setupMockDOM();

// ---------------------------------------------------------------------------
// Now import the modules under test (after DOM mock is set up)
// ---------------------------------------------------------------------------

const { el } = await import('../shared/utils.js');
const { renderTree, patchElement, getElementKey } = await import('../sidepanel/modules/tree-renderer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal state payload matching getStatePayload() format. */
function makeState(overrides = {}) {
  return {
    tabs: {},
    rootIds: [],
    collapsed: [],
    groupColors: {},
    theme: 'midnight',
    activeTabId: null,
    ...overrides,
  };
}

/** Create a tab node object for the state. */
function makeTabNode(id, overrides = {}) {
  return {
    tabId: id,
    parentId: null,
    children: [],
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    favIconUrl: `https://example.com/favicon-${id}.png`,
    pinned: false,
    audible: false,
    status: 'complete',
    groupId: -1,
    index: 0,
    windowId: 1,
    ...overrides,
  };
}

/** Creates container and pinnedList mock elements. */
function makeContainers() {
  const container = new MockElement('main');
  const pinnedList = new MockElement('div');
  return { container, pinnedList };
}

/** Count elements matching a class in a container's children tree. */
function findAll(container, className) {
  return container.querySelectorAll(`.${className}`);
}

// ---------------------------------------------------------------------------
// Tests: renderTree
// ---------------------------------------------------------------------------

describe('renderTree', () => {

  describe('empty state', () => {
    it('renders nothing into container when no tabs exist', () => {
      const state = makeState();
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      assert.equal(container.children.length, 0);
      assert.equal(pinnedList.children.length, 0);
    });
  });

  describe('flat list of tabs (no nesting)', () => {
    it('renders each root tab as a .tab-entry', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1),
          2: makeTabNode(2),
          3: makeTabNode(3),
        },
        rootIds: [1, 2, 3],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 3);
    });

    it('sets data-tab-id attribute on each entry', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.equal(entry.dataset.tabId, '1');
    });

    it('sets data-depth="0" for root tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.equal(entry.dataset.depth, '0');
    });

    it('renders tab title text', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { title: 'My Page' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const titleEl = findAll(container, 'tab-title')[0];
      assert.ok(titleEl, 'should have .tab-title element');
      // Title should contain the text
      const hasText = titleEl.childNodes.some(
        n => n.textContent === 'My Page'
      );
      assert.ok(hasText, 'title element should contain "My Page"');
    });

    it('renders favicon img with src', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { favIconUrl: 'https://example.com/icon.png' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const favicon = findAll(container, 'tab-favicon')[0];
      assert.ok(favicon, 'should have .tab-favicon element');
      assert.equal(favicon.tagName, 'IMG');
      assert.equal(favicon.attributes.src, 'https://example.com/icon.png');
    });

    it('renders close button', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const closeBtn = findAll(container, 'tab-close')[0];
      assert.ok(closeBtn, 'should have .tab-close element');
      assert.equal(closeBtn.tagName, 'BUTTON');
    });

    it('renders spacer instead of chevron for tabs without children', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const chevrons = findAll(container, 'tab-chevron');
      assert.equal(chevrons.length, 0, 'should have no chevron for leaf tabs');

      // Should have a spacer div instead
      const spacers = findAll(container, 'tab-chevron-spacer');
      assert.equal(spacers.length, 1, 'should have a spacer for leaf tabs');
    });
  });

  describe('active tab highlighting', () => {
    it('sets data-active="true" on the active tab', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1),
          2: makeTabNode(2),
        },
        rootIds: [1, 2],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, 2, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      const activeEntry = entries.find(e => e.dataset.tabId === '2');
      assert.equal(activeEntry.dataset.active, 'true');

      const inactiveEntry = entries.find(e => e.dataset.tabId === '1');
      assert.equal(inactiveEntry.dataset.active, 'false');
    });
  });

  describe('nested tree structure', () => {
    it('renders children with increasing depth', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1, children: [3] }),
          3: makeTabNode(3, { parentId: 2 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 3, 'should render all 3 tabs');

      const depths = entries.map(e => e.dataset.depth);
      assert.deepEqual(depths, ['0', '1', '2']);
    });

    it('shows chevron on parent tabs with children', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const chevrons = findAll(container, 'tab-chevron');
      assert.equal(chevrons.length, 1, 'parent should have a chevron');
    });

    it('sets data-collapsed on chevron based on collapsed state', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1 }),
        },
        rootIds: [1],
        collapsed: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const chevron = findAll(container, 'tab-chevron')[0];
      assert.equal(chevron.dataset.collapsed, 'true');
    });
  });

  describe('collapsed nodes', () => {
    it('does not render children of collapsed tabs', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2, 3] }),
          2: makeTabNode(2, { parentId: 1 }),
          3: makeTabNode(3, { parentId: 1 }),
        },
        rootIds: [1],
        collapsed: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 1, 'only the collapsed parent should render');
      assert.equal(entries[0].dataset.tabId, '1');
    });

    it('renders children of non-collapsed parent normally', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1 }),
        },
        rootIds: [1],
        collapsed: [],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 2);
    });
  });

  describe('pinned tabs', () => {
    it('renders pinned tabs into pinnedList, not tree container', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true }),
          2: makeTabNode(2, { pinned: false }),
        },
        rootIds: [1, 2],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      // Pinned list should have 1 pinned tab
      const pinnedTabs = findAll(pinnedList, 'pinned-tab');
      assert.equal(pinnedTabs.length, 1);

      // Tree container should only have the non-pinned tab
      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 1);
      assert.equal(entries[0].dataset.tabId, '2');
    });

    it('renders pinned tab as compact tile with favicon', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, favIconUrl: 'https://pin.com/icon.png' }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const pinned = findAll(pinnedList, 'pinned-tab')[0];
      assert.ok(pinned, 'should have .pinned-tab element');
      assert.equal(pinned.dataset.tabId, '1');

      // Should contain a favicon img
      const imgs = pinned.querySelectorAll('img');
      assert.equal(imgs.length, 1);
    });

    it('renders empty pinnedList when no pinned tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      assert.equal(pinnedList.children.length, 0);
    });
  });

  describe('tab status indicators', () => {
    it('adds tab-loading class for loading tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { status: 'loading' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const favicon = findAll(container, 'tab-favicon')[0];
      assert.ok(
        favicon.className.includes('tab-loading'),
        'favicon should have tab-loading class'
      );
    });

    it('adds tab-audible class for audible tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { audible: true }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.ok(
        entry.className.includes('tab-audible'),
        'entry should have tab-audible class'
      );
    });

    it('does not add tab-audible for non-audible tabs', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { audible: false }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entry = findAll(container, 'tab-entry')[0];
      assert.ok(
        !entry.className.includes('tab-audible'),
        'entry should not have tab-audible class'
      );
    });
  });

  describe('favicon fallback', () => {
    it('uses fallback when favIconUrl is empty', () => {
      const state = makeState({
        tabs: { 1: makeTabNode(1, { favIconUrl: '' }) },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const favicon = findAll(container, 'tab-favicon')[0];
      // Should still render an element (either img with fallback or a div)
      assert.ok(favicon, 'should render a favicon element even without URL');
    });
  });

  describe('replaceChildren behavior', () => {
    it('clears previous content on re-render', () => {
      const state1 = makeState({
        tabs: { 1: makeTabNode(1), 2: makeTabNode(2) },
        rootIds: [1, 2],
      });
      const state2 = makeState({
        tabs: { 3: makeTabNode(3) },
        rootIds: [3],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state1, null, container, pinnedList);
      assert.equal(findAll(container, 'tab-entry').length, 2);

      renderTree(state2, null, container, pinnedList);
      assert.equal(findAll(container, 'tab-entry').length, 1);
      assert.equal(findAll(container, 'tab-entry')[0].dataset.tabId, '3');
    });
  });

  describe('deeply nested tree', () => {
    it('handles 5 levels of nesting', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [2] }),
          2: makeTabNode(2, { parentId: 1, children: [3] }),
          3: makeTabNode(3, { parentId: 2, children: [4] }),
          4: makeTabNode(4, { parentId: 3, children: [5] }),
          5: makeTabNode(5, { parentId: 4 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      assert.equal(entries.length, 5);

      const depths = entries.map(e => e.dataset.depth);
      assert.deepEqual(depths, ['0', '1', '2', '3', '4']);
    });
  });

  describe('mixed pinned and nested tabs', () => {
    it('excludes pinned tabs from tree even if they are parents', () => {
      // Pinned tab with a child — child should still render (promoted to root)
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, children: [2] }),
          2: makeTabNode(2, { parentId: 1 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      // Pinned tab goes to pinned list
      const pinnedTabs = findAll(pinnedList, 'pinned-tab');
      assert.equal(pinnedTabs.length, 1);

      // Non-pinned child should render in tree
      const entries = findAll(container, 'tab-entry');
      assert.ok(entries.length >= 1, 'child of pinned parent should render in tree');
    });
  });

  describe('order preservation', () => {
    it('renders tabs in rootIds order', () => {
      const state = makeState({
        tabs: {
          3: makeTabNode(3),
          1: makeTabNode(1),
          2: makeTabNode(2),
        },
        rootIds: [3, 1, 2],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      const ids = entries.map(e => e.dataset.tabId);
      assert.deepEqual(ids, ['3', '1', '2']);
    });

    it('renders children in their array order', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { children: [3, 2] }),
          2: makeTabNode(2, { parentId: 1 }),
          3: makeTabNode(3, { parentId: 1 }),
        },
        rootIds: [1],
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList);

      const entries = findAll(container, 'tab-entry');
      const ids = entries.map(e => e.dataset.tabId);
      // Parent 1, then children in order: 3, 2
      assert.deepEqual(ids, ['1', '3', '2']);
    });
  });

  // ---------------------------------------------------------------------------
  // Track A: Window Names
  // ---------------------------------------------------------------------------

  describe('window names (Track A)', () => {
    it('uses user-assigned name instead of "Window N" label', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { windowId: 100 }),
          2: makeTabNode(2, { windowId: 200 }),
        },
        rootIds: [1, 2],
        windowNames: { 200: 'Work' },
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList, 100, new Set());

      // Find window separators
      const seps = findAll(container, 'window-separator');
      assert.equal(seps.length, 2, 'should have 2 window separators');

      // Non-home window (200) separator should show user name "Work"
      const nonHomeSep = seps.find(s => s.dataset.windowId === '200');
      assert.ok(nonHomeSep, 'should find separator for window 200');
      // The text content should include 'Work'
      const textParts = nonHomeSep.childNodes
        .filter(n => n.nodeType === 3 || (typeof n.textContent === 'string'))
        .map(n => n.textContent)
        .join('');
      assert.ok(textParts.includes('Work'), `separator text should include 'Work', got: '${textParts}'`);
    });

    it('falls back to "Window N" when no name is assigned', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { windowId: 100 }),
          2: makeTabNode(2, { windowId: 200 }),
        },
        rootIds: [1, 2],
        windowNames: {},
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList, 100, new Set());

      const seps = findAll(container, 'window-separator');
      const nonHomeSep = seps.find(s => s.dataset.windowId === '200');
      assert.ok(nonHomeSep);
      const textParts = nonHomeSep.childNodes
        .filter(n => n.nodeType === 3 || (typeof n.textContent === 'string'))
        .map(n => n.textContent)
        .join('');
      assert.ok(textParts.includes('Window 1'), `should fall back to 'Window 1', got: '${textParts}'`);
    });

    it('uses user-assigned name for home window instead of "This Window"', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { windowId: 100 }),
          2: makeTabNode(2, { windowId: 200 }),
        },
        rootIds: [1, 2],
        windowNames: { 100: 'Dev' },
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList, 100, new Set());

      const seps = findAll(container, 'window-separator');
      const homeSep = seps.find(s => s.dataset.windowId === '100');
      assert.ok(homeSep, 'should find separator for home window');
      const textParts = homeSep.childNodes
        .filter(n => n.nodeType === 3 || (typeof n.textContent === 'string'))
        .map(n => n.textContent)
        .join('');
      assert.ok(textParts.includes('Dev'), `home separator should show 'Dev', got: '${textParts}'`);
    });

    it('falls back to "This Window" when home window has no name', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { windowId: 100 }),
          2: makeTabNode(2, { windowId: 200 }),
        },
        rootIds: [1, 2],
        windowNames: {},
      });
      const { container, pinnedList } = makeContainers();

      renderTree(state, null, container, pinnedList, 100, new Set());

      const seps = findAll(container, 'window-separator');
      const homeSep = seps.find(s => s.dataset.windowId === '100');
      assert.ok(homeSep);
      const textParts = homeSep.childNodes
        .filter(n => n.nodeType === 3 || (typeof n.textContent === 'string'))
        .map(n => n.textContent)
        .join('');
      assert.ok(textParts.includes('This Window'), `should fall back to 'This Window', got: '${textParts}'`);
    });

    it('handles missing windowNames property gracefully', () => {
      const state = makeState({
        tabs: {
          1: makeTabNode(1, { windowId: 100 }),
          2: makeTabNode(2, { windowId: 200 }),
        },
        rootIds: [1, 2],
      });
      // Ensure no windowNames key at all
      delete state.windowNames;
      const { container, pinnedList } = makeContainers();

      // Should not throw
      renderTree(state, null, container, pinnedList, 100, new Set());

      const seps = findAll(container, 'window-separator');
      assert.equal(seps.length, 2);
    });
  });

  // ---------------------------------------------------------------------------
  // Track B: Per-Window Pinned Tabs
  // ---------------------------------------------------------------------------

  describe('per-window pinned tabs (Track B)', () => {

    describe('single window mode', () => {
      it('renders pinned tabs into global pinnedList (existing behavior)', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100 }),
            2: makeTabNode(2, { pinned: true, windowId: 100 }),
            3: makeTabNode(3, { pinned: false, windowId: 100 }),
          },
          rootIds: [1, 2, 3],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        // Global pinned bar should have both pinned tabs
        const pinnedTabs = findAll(pinnedList, 'pinned-tab');
        assert.equal(pinnedTabs.length, 2, 'global pinned bar should have 2 pinned tabs');

        // No inline pinned bars in the tree
        const inlineBars = findAll(container, 'window-pinned-bar');
        assert.equal(inlineBars.length, 0, 'single-window mode should have no inline pinned bars');
      });
    });

    describe('multi-window mode', () => {
      it('renders pinned tabs into pinnedContainer in multi-window mode (sticky)', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100 }),
            2: makeTabNode(2, { pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: true, windowId: 200 }),
            4: makeTabNode(4, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 2, 3, 4],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        // pinnedContainer should have content (not cleared) in multi-window mode
        assert.ok(pinnedList.children.length > 0,
          'pinnedContainer should have pinned tab content in multi-window mode');
      });

      it('renders per-window pinned groups with labels into pinnedContainer', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100 }),
            2: makeTabNode(2, { pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: true, windowId: 200 }),
            4: makeTabNode(4, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 2, 3, 4],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        // Should have per-window pinned groups in pinnedContainer
        const groups = findAll(pinnedList, 'pinned-window-group');
        assert.equal(groups.length, 2,
          'should have 2 pinned-window-group elements (one per window)');

        // Each group should have a label and a pinned bar
        for (const group of groups) {
          const labels = findAll(group, 'pinned-window-label');
          assert.equal(labels.length, 1, 'each group should have a label');
          const bars = findAll(group, 'window-pinned-bar');
          assert.equal(bars.length, 1, 'each group should have a pinned bar');
        }
      });

      it('does NOT render pinned bars into the tree container (scroller)', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100 }),
            2: makeTabNode(2, { pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: true, windowId: 200 }),
            4: makeTabNode(4, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 2, 3, 4],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        // Tree container should NOT have any pinned bars
        const inlineBars = findAll(container, 'window-pinned-bar');
        assert.equal(inlineBars.length, 0,
          'tree container (scroller) should have no inline pinned bars');
      });

      it('uses correct window labels for pinned groups', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100 }),
            2: makeTabNode(2, { pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: true, windowId: 200 }),
            4: makeTabNode(4, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 2, 3, 4],
          windowNames: { 100: 'Dev' },
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        const groups = findAll(pinnedList, 'pinned-window-group');
        assert.equal(groups.length, 2);

        // Home window group should use user-assigned name 'Dev'
        const homeGroup = groups.find(g => g.dataset.windowId === '100');
        assert.ok(homeGroup, 'should find group for home window');
        const homeLabel = findAll(homeGroup, 'pinned-window-label')[0];
        assert.ok(homeLabel.textContent.includes('Dev') ||
          homeLabel.childNodes.some(n => n.textContent === 'Dev'),
          `home window label should be 'Dev'`);

        // Non-home window group should use fallback 'Window 1'
        const otherGroup = groups.find(g => g.dataset.windowId === '200');
        assert.ok(otherGroup, 'should find group for window 200');
        const otherLabel = findAll(otherGroup, 'pinned-window-label')[0];
        const otherText = otherLabel.textContent || otherLabel.childNodes.map(n => n.textContent).join('');
        assert.ok(otherText.includes('Window 1'),
          `non-home window label should be 'Window 1', got: '${otherText}'`);
      });

      it('uses "This Window" label when home window has no name', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100 }),
            2: makeTabNode(2, { pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: true, windowId: 200 }),
            4: makeTabNode(4, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 2, 3, 4],
          windowNames: {},
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        const groups = findAll(pinnedList, 'pinned-window-group');
        const homeGroup = groups.find(g => g.dataset.windowId === '100');
        assert.ok(homeGroup);
        const homeLabel = findAll(homeGroup, 'pinned-window-label')[0];
        const labelText = homeLabel.textContent || homeLabel.childNodes.map(n => n.textContent).join('');
        assert.ok(labelText.includes('This Window'),
          `home window label should be 'This Window', got: '${labelText}'`);
      });

      it('assigns correct pinned tabs to each window group', () => {
        const state = makeState({
          tabs: {
            10: makeTabNode(10, { pinned: true, windowId: 100, title: 'Pinned W1' }),
            11: makeTabNode(11, { pinned: false, windowId: 100 }),
            20: makeTabNode(20, { pinned: true, windowId: 200, title: 'Pinned W2a' }),
            21: makeTabNode(21, { pinned: true, windowId: 200, title: 'Pinned W2b' }),
            22: makeTabNode(22, { pinned: false, windowId: 200 }),
          },
          rootIds: [10, 11, 20, 21, 22],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        const groups = findAll(pinnedList, 'pinned-window-group');
        assert.equal(groups.length, 2);

        // First window (home, windowId 100) should have 1 pinned tab
        const homeGroup = groups.find(g => g.dataset.windowId === '100');
        const bar1Pinned = findAll(homeGroup, 'pinned-tab');
        assert.equal(bar1Pinned.length, 1, 'window 100 should have 1 pinned tab');
        assert.equal(bar1Pinned[0].dataset.tabId, '10');

        // Second window (windowId 200) should have 2 pinned tabs
        const otherGroup = groups.find(g => g.dataset.windowId === '200');
        const bar2Pinned = findAll(otherGroup, 'pinned-tab');
        assert.equal(bar2Pinned.length, 2, 'window 200 should have 2 pinned tabs');
        const bar2Ids = bar2Pinned.map(p => p.dataset.tabId);
        assert.ok(bar2Ids.includes('20'), 'window 200 bar should contain tab 20');
        assert.ok(bar2Ids.includes('21'), 'window 200 bar should contain tab 21');
      });

      it('does not render pinned group for window with no pinned tabs', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100 }),
            2: makeTabNode(2, { pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 2, 3],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        // Only 1 group (for window 100 which has a pinned tab)
        const groups = findAll(pinnedList, 'pinned-window-group');
        assert.equal(groups.length, 1,
          'only window with pinned tabs should have a pinned group');
      });

      it('still renders pinned tab children in the tree', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100, children: [2] }),
            2: makeTabNode(2, { parentId: 1, pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 3],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        // The non-pinned child of the pinned tab should still render in the tree
        const entries = findAll(container, 'tab-entry');
        const entryIds = entries.map(e => e.dataset.tabId);
        assert.ok(entryIds.includes('2'),
          'non-pinned child of pinned parent should still render in tree');
      });

      it('uses buildPinnedTab format for pinned elements in groups', () => {
        const state = makeState({
          tabs: {
            1: makeTabNode(1, { pinned: true, windowId: 100, favIconUrl: 'https://example.com/icon.png' }),
            2: makeTabNode(2, { pinned: false, windowId: 100 }),
            3: makeTabNode(3, { pinned: false, windowId: 200 }),
          },
          rootIds: [1, 2, 3],
        });
        const { container, pinnedList } = makeContainers();

        renderTree(state, null, container, pinnedList, 100, new Set());

        const groups = findAll(pinnedList, 'pinned-window-group');
        assert.equal(groups.length, 1);

        // The pinned tab inside the bar should use buildPinnedTab format
        const pinnedTab = findAll(groups[0], 'pinned-tab')[0];
        assert.ok(pinnedTab, 'pinned group should contain .pinned-tab elements');
        assert.equal(pinnedTab.dataset.tabId, '1');

        // Should have favicon img
        const imgs = pinnedTab.querySelectorAll('img');
        assert.equal(imgs.length, 1);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Pinned bar reconciliation (multi-window pinnedContainer updates)
  // ---------------------------------------------------------------------------

  describe('pinned bar reconciliation', () => {
    it('updates pinned groups when a new tab is pinned', () => {
      const { container, pinnedList } = makeContainers();

      // Initial: 1 pinned tab in window 100
      const state1 = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, windowId: 100 }),
          2: makeTabNode(2, { pinned: false, windowId: 100 }),
          3: makeTabNode(3, { pinned: false, windowId: 200 }),
        },
        rootIds: [1, 2, 3],
      });
      renderTree(state1, null, container, pinnedList, 100, new Set());

      const groups1 = findAll(pinnedList, 'pinned-window-group');
      assert.equal(groups1.length, 1, 'should have 1 pinned group');
      assert.equal(findAll(groups1[0], 'pinned-tab').length, 1, 'group should have 1 pinned tab');

      // Now pin tab 2 as well
      const state2 = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, windowId: 100 }),
          2: makeTabNode(2, { pinned: true, windowId: 100 }),
          3: makeTabNode(3, { pinned: false, windowId: 200 }),
        },
        rootIds: [1, 2, 3],
      });
      renderTree(state2, null, container, pinnedList, 100, new Set());

      const groups2 = findAll(pinnedList, 'pinned-window-group');
      assert.equal(groups2.length, 1, 'should still have 1 pinned group');
      const pinnedTabs = findAll(groups2[0], 'pinned-tab');
      assert.equal(pinnedTabs.length, 2, 'group should now have 2 pinned tabs');
    });

    it('removes pinned tab icon when a pinned tab is closed', () => {
      const { container, pinnedList } = makeContainers();

      // Initial: 2 pinned tabs in window 100
      const state1 = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, windowId: 100 }),
          2: makeTabNode(2, { pinned: true, windowId: 100 }),
          3: makeTabNode(3, { pinned: false, windowId: 200 }),
        },
        rootIds: [1, 2, 3],
      });
      renderTree(state1, null, container, pinnedList, 100, new Set());

      assert.equal(findAll(findAll(pinnedList, 'pinned-window-group')[0], 'pinned-tab').length, 2);

      // Close tab 2 (remove it from state)
      const state2 = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, windowId: 100 }),
          3: makeTabNode(3, { pinned: false, windowId: 200 }),
        },
        rootIds: [1, 3],
      });
      renderTree(state2, null, container, pinnedList, 100, new Set());

      const groups = findAll(pinnedList, 'pinned-window-group');
      assert.equal(groups.length, 1);
      const pinnedTabs = findAll(groups[0], 'pinned-tab');
      assert.equal(pinnedTabs.length, 1, 'group should have 1 pinned tab after close');
      assert.equal(pinnedTabs[0].dataset.tabId, '1', 'remaining tab should be tab 1');
    });

    it('keeps pinned groups in sync after multiple pin/unpin cycles', () => {
      const { container, pinnedList } = makeContainers();

      // Start: tab 1 pinned
      const state1 = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: true, windowId: 100 }),
          2: makeTabNode(2, { pinned: false, windowId: 100 }),
          3: makeTabNode(3, { pinned: false, windowId: 200 }),
        },
        rootIds: [1, 2, 3],
      });
      renderTree(state1, null, container, pinnedList, 100, new Set());
      assert.equal(findAll(findAll(pinnedList, 'pinned-window-group')[0], 'pinned-tab').length, 1);

      // Unpin tab 1, pin tab 2
      const state2 = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: false, windowId: 100 }),
          2: makeTabNode(2, { pinned: true, windowId: 100 }),
          3: makeTabNode(3, { pinned: false, windowId: 200 }),
        },
        rootIds: [1, 2, 3],
      });
      renderTree(state2, null, container, pinnedList, 100, new Set());

      const groups = findAll(pinnedList, 'pinned-window-group');
      assert.equal(groups.length, 1);
      const pinnedTabs = findAll(groups[0], 'pinned-tab');
      assert.equal(pinnedTabs.length, 1, 'group should have 1 pinned tab');
      assert.equal(pinnedTabs[0].dataset.tabId, '2', 'pinned tab should be tab 2');

      // Unpin all — groups should disappear
      const state3 = makeState({
        tabs: {
          1: makeTabNode(1, { pinned: false, windowId: 100 }),
          2: makeTabNode(2, { pinned: false, windowId: 100 }),
          3: makeTabNode(3, { pinned: false, windowId: 200 }),
        },
        rootIds: [1, 2, 3],
      });
      renderTree(state3, null, container, pinnedList, 100, new Set());

      const groupsAfter = findAll(pinnedList, 'pinned-window-group');
      assert.equal(groupsAfter.length, 0, 'no pinned groups when no tabs are pinned');
    });
  });

  // ---------------------------------------------------------------------------
  // patchElement unit tests for window-pinned-bar
  // ---------------------------------------------------------------------------

  describe('patchElement for window-pinned-bar', () => {
    it('replaces children entirely for window-pinned-bar elements', () => {
      const existing = new MockElement('div');
      existing.className = 'window-pinned-bar';
      existing.dataset.windowId = 'pinned-100';
      const oldChild = new MockElement('div');
      oldChild.className = 'pinned-tab';
      oldChild.dataset.tabId = '1';
      existing.appendChild(oldChild);

      const incoming = new MockElement('div');
      incoming.className = 'window-pinned-bar';
      incoming.dataset.windowId = 'pinned-100';
      const newChild1 = new MockElement('div');
      newChild1.className = 'pinned-tab';
      newChild1.dataset.tabId = '1';
      incoming.appendChild(newChild1);
      const newChild2 = new MockElement('div');
      newChild2.className = 'pinned-tab';
      newChild2.dataset.tabId = '2';
      incoming.appendChild(newChild2);

      patchElement(existing, incoming);

      assert.equal(existing.children.length, 2, 'should have 2 children after patch');
      assert.equal(existing.children[0].dataset.tabId, '1');
      assert.equal(existing.children[1].dataset.tabId, '2');
    });

    it('removes stale children when pinned tab is closed', () => {
      const existing = new MockElement('div');
      existing.className = 'window-pinned-bar';
      existing.dataset.windowId = 'pinned-100';
      const child1 = new MockElement('div');
      child1.className = 'pinned-tab';
      child1.dataset.tabId = '1';
      existing.appendChild(child1);
      const child2 = new MockElement('div');
      child2.className = 'pinned-tab';
      child2.dataset.tabId = '2';
      existing.appendChild(child2);

      const incoming = new MockElement('div');
      incoming.className = 'window-pinned-bar';
      incoming.dataset.windowId = 'pinned-100';
      const newChild = new MockElement('div');
      newChild.className = 'pinned-tab';
      newChild.dataset.tabId = '1';
      incoming.appendChild(newChild);

      patchElement(existing, incoming);

      assert.equal(existing.children.length, 1, 'should have 1 child after patch');
      assert.equal(existing.children[0].dataset.tabId, '1');
    });

    it('does not replace children for regular tab-entry elements', () => {
      const existing = new MockElement('div');
      existing.className = 'tab-entry';
      existing.dataset.tabId = '1';
      const oldChild = new MockElement('span');
      oldChild.className = 'tab-title';
      oldChild.textContent = 'Old Title';
      existing.appendChild(oldChild);

      const incoming = new MockElement('div');
      incoming.className = 'tab-entry';
      incoming.dataset.tabId = '1';
      const newChild = new MockElement('span');
      newChild.className = 'tab-title';
      newChild.textContent = 'New Title';
      incoming.appendChild(newChild);

      patchElement(existing, incoming);

      // Children should NOT be replaced entirely — only title patched
      assert.equal(existing.children.length, 1, 'should still have 1 child');
      assert.equal(existing.children[0].textContent, 'New Title', 'title should be updated');
    });
  });
});

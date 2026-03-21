/**
 * Bookmark Helpers
 *
 * Save tree as bookmarks and open bookmark folders.
 */

/**
 * Saves the current tab tree as a bookmark folder structure.
 * Mirrors the tree hierarchy: root tabs become bookmarks, children become subfolders.
 * @param {Object} state - ShadowState instance
 */
export async function saveTreeAsBookmarks(state) {
  try {
    const folderName = `LinkMap — ${new Date().toLocaleDateString()}`;
    const root = await chrome.bookmarks.create({ title: folderName });

    // Recursive tree walk
    async function saveSubtree(tabIds, parentBookmarkId) {
      for (const tabId of tabIds) {
        const node = state.tabs.get(tabId);
        if (!node) continue;

        if (node.children && node.children.length > 0) {
          // Tab with children: create a folder with the tab as the first bookmark
          const folder = await chrome.bookmarks.create({
            parentId: parentBookmarkId,
            title: node.title || 'Untitled',
          });
          // Add the tab URL itself as the first bookmark in the folder
          await chrome.bookmarks.create({
            parentId: folder.id,
            title: node.title || 'Untitled',
            url: node.url,
          });
          // Recurse for children
          await saveSubtree(node.children, folder.id);
        } else {
          // Leaf tab: just a bookmark
          await chrome.bookmarks.create({
            parentId: parentBookmarkId,
            title: node.title || 'Untitled',
            url: node.url,
          });
        }
      }
    }

    await saveSubtree(state.rootIds, root.id);
    console.log(`[LinkMap] Tree saved as bookmarks: "${folderName}"`);
  } catch (err) {
    console.error('[LinkMap] Failed to save bookmarks:', err);
  }
}

/**
 * Opens all bookmarks in a folder as tabs.
 * @param {string} folderId
 */
export async function openBookmarkFolder(folderId) {
  try {
    const children = await chrome.bookmarks.getChildren(folderId);
    for (const child of children) {
      if (child.url) {
        await chrome.tabs.create({ url: child.url, active: false });
      }
    }
  } catch (err) {
    console.error('[LinkMap] Failed to open bookmark folder:', err);
  }
}

import { MSG, STORAGE_KEY } from './shared/constants.js';

console.log('[LinkMap] Background service worker started');

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Placeholder: message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[LinkMap] Message received:', message.type);

  if (message.type === MSG.GET_STATE) {
    sendResponse({ tabs: [], rootIds: [], collapsed: [], groupColors: {}, theme: 'midnight' });
  }

  return true; // keep channel open for async responses
});

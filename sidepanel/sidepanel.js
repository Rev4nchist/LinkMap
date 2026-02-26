import { MSG } from '../shared/constants.js';

console.log('[LinkMap] Side panel loaded');

// Request initial state from background
chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (response) => {
  if (chrome.runtime.lastError) {
    console.error('[LinkMap] Failed to get state:', chrome.runtime.lastError.message);
    return;
  }
  console.log('[LinkMap] Initial state received:', response);
});

// Listen for state updates from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[LinkMap] Message from background:', message.type);
});

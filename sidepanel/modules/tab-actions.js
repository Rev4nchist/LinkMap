/**
 * tab-actions.js — Utility helpers that send action messages to background.
 *
 * Each function fires a message; the background service worker performs the
 * actual Chrome tabs API call and broadcasts the resulting STATE_UPDATE.
 */

import { MSG } from '../../shared/constants.js';

export function activateTab(tabId) {
  chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } });
}

export function closeTab(tabId) {
  chrome.runtime.sendMessage({ type: MSG.CLOSE_TAB, payload: { tabId } });
}

export function closeTabs(tabIds) {
  chrome.runtime.sendMessage({ type: MSG.CLOSE_TABS, payload: { tabIds } });
}

export function pinTab(tabId, pinned) {
  chrome.runtime.sendMessage({ type: MSG.PIN_TAB, payload: { tabId, pinned } });
}

export function duplicateTab(tabId) {
  chrome.runtime.sendMessage({ type: MSG.DUPLICATE_TAB, payload: { tabId } });
}

export function muteTab(tabId, muted) {
  chrome.runtime.sendMessage({ type: MSG.MUTE_TAB, payload: { tabId, muted } });
}

export function toggleCollapse(tabId) {
  chrome.runtime.sendMessage({ type: MSG.TOGGLE_COLLAPSE, payload: { tabId } });
}

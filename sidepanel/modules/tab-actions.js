/**
 * tab-actions.js — Utility helpers that send action messages to background.
 *
 * Each function fires a message; the background service worker performs the
 * actual Chrome tabs API call and broadcasts the resulting STATE_UPDATE.
 */

import { MSG } from '../../shared/constants.js';

export function activateTab(tabId) {
  chrome.runtime.sendMessage({ type: MSG.ACTIVATE_TAB, payload: { tabId } }).catch(e => console.warn('[LinkMap]', e));
}

export function closeTab(tabId) {
  chrome.runtime.sendMessage({ type: MSG.CLOSE_TAB, payload: { tabId } }).catch(e => console.warn('[LinkMap]', e));
}

export function closeTabs(tabIds) {
  chrome.runtime.sendMessage({ type: MSG.CLOSE_TABS, payload: { tabIds } }).catch(e => console.warn('[LinkMap]', e));
}

export function pinTab(tabId, pinned) {
  chrome.runtime.sendMessage({ type: MSG.PIN_TAB, payload: { tabId, pinned } }).catch(e => console.warn('[LinkMap]', e));
}

export function duplicateTab(tabId) {
  chrome.runtime.sendMessage({ type: MSG.DUPLICATE_TAB, payload: { tabId } }).catch(e => console.warn('[LinkMap]', e));
}

export function muteTab(tabId, muted) {
  chrome.runtime.sendMessage({ type: MSG.MUTE_TAB, payload: { tabId, muted } }).catch(e => console.warn('[LinkMap]', e));
}

export function toggleCollapse(tabId) {
  chrome.runtime.sendMessage({ type: MSG.TOGGLE_COLLAPSE, payload: { tabId } }).catch(e => console.warn('[LinkMap]', e));
}

export function newTabBelow(tabId) {
  chrome.runtime.sendMessage({ type: MSG.NEW_TAB_BELOW, payload: { tabId } }).catch(e => console.warn('[LinkMap]', e));
}

export function ungroupTabs(tabIds) {
  chrome.runtime.sendMessage({ type: MSG.UNGROUP_TAB, payload: { tabIds } }).catch(e => console.warn('[LinkMap]', e));
}

export function discardTabs(tabIds) {
  chrome.runtime.sendMessage({ type: MSG.DISCARD_TABS, payload: { tabIds } }).catch(e => console.warn('[LinkMap]', e));
}

export function reloadTab(tabId) {
  chrome.runtime.sendMessage({ type: MSG.RELOAD_TAB, payload: { tabId } }).catch(e => console.warn('[LinkMap]', e));
}

export function moveToNewWindow(tabId) {
  chrome.runtime.sendMessage({ type: MSG.MOVE_TO_NEW_WINDOW, payload: { tabId } }).catch(e => console.warn('[LinkMap]', e));
}

export function moveToGroup(tabId, groupId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: MSG.MOVE_TO_GROUP, payload: { tabId, groupId } },
      (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(response);
      }
    );
  });
}

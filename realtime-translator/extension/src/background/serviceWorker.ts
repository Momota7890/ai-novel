/**
 * Manifest V3 Background Service Worker (Phase 0 scaffold).
 * Phase 1 adds localhost API proxying with AbortController support;
 * Phase 2 adds cross-origin manhwa image fetching and captureVisibleTab.
 */

chrome.runtime.onInstalled.addListener(() => {
  // Extension initialized cleanly.
});

chrome.commands.onCommand.addListener((command) => {
  void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTabId = tabs[0]?.id;
    if (activeTabId === undefined) {
      return;
    }
    void chrome.tabs.sendMessage(activeTabId, { type: "RT_COMMAND", command }).catch(() => {
      // Content script may not be injected on chrome:// or restricted pages.
    });
  });
});

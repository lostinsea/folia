(function () {
  "use strict";

  if (!window.folia) throw new Error("Markaloo preload must load before document-events.js");
  const channels = new Map([
    ["file-opened", "onFileOpened"],
    ["file-open-result", "onFileOpenResult"],
    ["file-reload-result", "onFileReloadResult"],
    ["save-markdown-result", "onSaveMarkdownResult"],
    ["file-changed-externally", "onFileChangedExternally"],
  ]);
  const listeners = new Map([...channels.keys()].map(channel => [channel, []]));
  const unsubscribers = [];

  function getListeners(channel) {
    if (!listeners.has(channel)) throw new TypeError("Unknown document event");
    return listeners.get(channel);
  }

  const registry = Object.freeze({
    on(channel, listener) {
      if (typeof listener !== "function") throw new TypeError("Invalid document listener");
      getListeners(channel).push(listener);
      return registry;
    },
    listeners(channel) {
      return getListeners(channel).slice();
    },
    removeListener(channel, listener) {
      if (typeof listener !== "function") throw new TypeError("Invalid document listener");
      const current = getListeners(channel);
      const index = current.lastIndexOf(listener);
      if (index !== -1) current.splice(index, 1);
      return registry;
    },
    removeAllListeners(channel) {
      getListeners(channel).length = 0;
      return registry;
    },
  });

  for (const [channel, method] of channels) {
    if (typeof window.folia[method] !== "function") {
      throw new Error(`Markaloo preload is missing ${method}`);
    }
    unsubscribers.push(window.folia[method](payload => {
      // ContextBridge can freeze its copy. Tabs annotate and memoize one shared
      // page-local result; cloning per listener would break Save's WeakMap.
      const data = payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload } : payload;
      for (const listener of getListeners(channel).slice()) listener(undefined, data);
    }));
  }
  window.addEventListener("unload", () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  }, { once: true });
  window.FoliaDocumentEvents = registry;
})();

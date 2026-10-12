const { contextBridge, ipcRenderer } = require("electron");

const api = Object.freeze({
  async readOwnedTabDiskSnapshot(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("Invalid owned tab disk snapshot request");
    }
    const owner = request.owner;
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
      throw new TypeError("Invalid owned tab disk snapshot request");
    }
    const payload = {
      filePath: request.filePath,
      pageSession: request.pageSession,
      rendererGeneration: request.rendererGeneration,
      owner: {
        pageSession: owner.pageSession,
        rendererGeneration: owner.rendererGeneration,
        tabId: owner.tabId,
        documentGeneration: owner.documentGeneration,
        pathKey: owner.pathKey,
      },
    };
    const identity = payload.owner;
    if (typeof payload.filePath !== "string" || !payload.filePath ||
        payload.filePath.includes("\0") ||
        typeof payload.pageSession !== "string" || !payload.pageSession ||
        payload.pageSession.length > 128 ||
        !Number.isSafeInteger(payload.rendererGeneration) ||
        payload.rendererGeneration <= 0 ||
        identity.pageSession !== payload.pageSession ||
        identity.rendererGeneration !== payload.rendererGeneration ||
        !Number.isSafeInteger(identity.tabId) || identity.tabId <= 0 ||
        !Number.isSafeInteger(identity.documentGeneration) ||
        identity.documentGeneration <= 0 ||
        typeof identity.pathKey !== "string" || !identity.pathKey ||
        identity.pathKey.includes("\0")) {
      throw new TypeError("Invalid owned tab disk snapshot request");
    }
    const snapshot = await ipcRenderer.invoke(
      "read-owned-tab-disk-snapshot", payload,
    );
    if (snapshot === null) return null;
    if (!snapshot || typeof snapshot.content !== "string" ||
        !Number.isFinite(snapshot.modifiedTime) || !snapshot.diskVersion) {
      throw new TypeError("Invalid owned tab disk snapshot response");
    }
    const diskVersion = {
      dev: snapshot.diskVersion.dev,
      ino: snapshot.diskVersion.ino,
      size: snapshot.diskVersion.size,
      mtimeMs: snapshot.diskVersion.mtimeMs,
      ctimeMs: snapshot.diskVersion.ctimeMs,
    };
    if (!Object.values(diskVersion).every(Number.isFinite)) {
      throw new TypeError("Invalid owned tab disk snapshot response");
    }
    return Object.freeze({
      content: snapshot.content,
      modifiedTime: snapshot.modifiedTime,
      diskVersion: Object.freeze(diskVersion),
    });
  },
});

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("folia", api);
} else {
  // Transitional publication only; renderer Node removal precedes isolation.
  globalThis.folia = api;
}

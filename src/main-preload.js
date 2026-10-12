const { contextBridge, ipcRenderer } = require("electron");

function copyDiskSnapshot(snapshot, kind) {
  if (!snapshot || typeof snapshot.content !== "string" ||
      !Number.isFinite(snapshot.modifiedTime) || !snapshot.diskVersion) {
    throw new TypeError(`Invalid ${kind} response`);
  }
  const diskVersion = {
    dev: snapshot.diskVersion.dev,
    ino: snapshot.diskVersion.ino,
    size: snapshot.diskVersion.size,
    mtimeMs: snapshot.diskVersion.mtimeMs,
    ctimeMs: snapshot.diskVersion.ctimeMs,
  };
  if (!Object.values(diskVersion).every(Number.isFinite)) {
    throw new TypeError(`Invalid ${kind} response`);
  }
  return Object.freeze({
    content: snapshot.content,
    modifiedTime: snapshot.modifiedTime,
    diskVersion: Object.freeze(diskVersion),
  });
}

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
    return copyDiskSnapshot(snapshot, "owned tab disk snapshot");
  },
  async readDialogExtra(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("Invalid dialog extra request");
    }
    const payload = {
      grant: request.grant,
      pageSession: request.pageSession,
      rendererGeneration: request.rendererGeneration,
    };
    if (typeof payload.grant !== "string" || !payload.grant ||
        payload.grant.length > 128 || payload.grant.includes("\0") ||
        typeof payload.pageSession !== "string" || !payload.pageSession ||
        payload.pageSession.length > 128 ||
        !Number.isSafeInteger(payload.rendererGeneration) ||
        payload.rendererGeneration <= 0) {
      throw new TypeError("Invalid dialog extra request");
    }
    const snapshot = await ipcRenderer.invoke("read-dialog-extra", payload);
    if (!snapshot || typeof snapshot.path !== "string" ||
        !snapshot.path || snapshot.path.includes("\0")) {
      throw new TypeError("Invalid dialog extra snapshot response");
    }
    return Object.freeze({
      path: snapshot.path,
      ...copyDiskSnapshot(snapshot, "dialog extra snapshot"),
    });
  },
});

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("folia", api);
} else {
  // Transitional publication only; renderer Node removal precedes isolation.
  globalThis.folia = api;
}

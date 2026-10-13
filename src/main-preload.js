const { contextBridge, ipcRenderer } = require("electron");

function copyDiskVersion(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${kind} response`);
  }
  const diskVersion = {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
  if (!Object.values(diskVersion).every(Number.isFinite)) {
    throw new TypeError(`Invalid ${kind} response`);
  }
  return Object.freeze(diskVersion);
}

function copyDiskSnapshot(snapshot, kind) {
  if (!snapshot || typeof snapshot.content !== "string" ||
      !Number.isFinite(snapshot.modifiedTime) || !snapshot.diskVersion) {
    throw new TypeError(`Invalid ${kind} response`);
  }
  return Object.freeze({
    content: snapshot.content,
    modifiedTime: snapshot.modifiedTime,
    diskVersion: copyDiskVersion(snapshot.diskVersion, kind),
  });
}

function isPath(value) {
  return typeof value === "string" && !!value && !value.includes("\0");
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function revisionNumber(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function copyAdoptionEnvelope(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      typeof request.pageSession !== "string" || !request.pageSession ||
      request.pageSession.length > 128 ||
      !positiveInteger(request.rendererGeneration)) {
    throw new TypeError("Invalid disk adoption request");
  }
  return {
    pageSession: request.pageSession,
    rendererGeneration: request.rendererGeneration,
  };
}

function copyAdoptionIdentity(identity, envelope, allowSelection = false) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
      identity.pageSession !== envelope.pageSession ||
      identity.rendererGeneration !== envelope.rendererGeneration ||
      !positiveInteger(identity.tabId) ||
      !positiveInteger(identity.documentGeneration) ||
      !isPath(identity.pathKey) ||
      (allowSelection && identity.selectionGeneration !== undefined &&
        !positiveInteger(identity.selectionGeneration))) {
    throw new TypeError("Invalid disk adoption identity");
  }
  return {
    pageSession: identity.pageSession,
    rendererGeneration: identity.rendererGeneration,
    tabId: identity.tabId,
    documentGeneration: identity.documentGeneration,
    pathKey: identity.pathKey,
    ...(!allowSelection || identity.selectionGeneration === undefined ? {} : {
      selectionGeneration: identity.selectionGeneration,
    }),
  };
}

function copyAdoptionTarget(request) {
  const envelope = copyAdoptionEnvelope(request);
  const diskVersion = copyDiskVersion(request.diskVersion, "disk adoption");
  if (!isPath(request.filePath) || !isPath(request.ownerFilePath) ||
      !Number.isFinite(request.modifiedTime) ||
      request.modifiedTime !== diskVersion.mtimeMs ||
      typeof request.contentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.contentDigest) ||
      typeof request.replaceDocument !== "boolean") {
    throw new TypeError("Invalid disk adoption target");
  }
  return {
    ...envelope,
    filePath: request.filePath,
    ownerFilePath: request.ownerFilePath,
    modifiedTime: request.modifiedTime,
    diskVersion,
    contentDigest: request.contentDigest,
    replaceDocument: request.replaceDocument,
    proposedOwner: copyAdoptionIdentity(request.proposedOwner, envelope),
  };
}

function copyAdoptionCapability(request) {
  const envelope = copyAdoptionEnvelope(request);
  if (typeof request.capability !== "string" ||
      !/^[a-f0-9]{32}$/.test(request.capability)) {
    throw new TypeError("Invalid disk adoption capability");
  }
  return { ...envelope, capability: request.capability };
}

function copyAdoptionRefusal(result, flag) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      typeof result[flag] !== "boolean") {
    throw new TypeError("Invalid disk adoption response");
  }
  if (result[flag]) return null;
  if (typeof result.why !== "string" || !result.why) {
    throw new TypeError("Invalid disk adoption refusal");
  }
  return { [flag]: false, why: result.why };
}

function copyAdoptionReplyFields(result, fields) {
  const copy = {};
  for (const field of fields) {
    const value = result[field];
    const valid = field === "revision" || field === "remainingPhysicalEpisodes" ||
      field === "relatedOrphanCount"
      ? revisionNumber(value)
      : field === "tabId" || field === "documentGeneration"
        ? positiveInteger(value)
        : field === "capability"
          ? typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
          : field === "contentDigest"
            ? typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
            : field === "pathKey" || field === "incomingSpelling" ||
                field === "ownerSpelling"
              ? isPath(value)
              : typeof value === "boolean";
    if (!valid) throw new TypeError("Invalid disk adoption response");
    copy[field] = value;
  }
  return copy;
}

const api = Object.freeze({
  async prepareDocumentDiskAdoption(request) {
    const payload = copyAdoptionTarget(request);
    if (request.tabId === null) {
      if (request.documentGeneration != null || request.pathKey != null) {
        throw new TypeError("Invalid new disk adoption identity");
      }
      payload.tabId = null;
    } else {
      const identity = copyAdoptionIdentity(request, payload);
      payload.tabId = identity.tabId;
      payload.documentGeneration = identity.documentGeneration;
      payload.pathKey = identity.pathKey;
    }
    const result = await ipcRenderer.invoke(
      "prepare-document-disk-adoption", payload,
    );
    const refused = copyAdoptionRefusal(result, "known");
    if (refused) {
      if (refused.why === "resolve-historical-episode") {
        Object.assign(refused, copyAdoptionReplyFields(result, [
          "capability", "revision", "pathKey", "remainingPhysicalEpisodes",
        ]));
      }
      return Object.freeze(refused);
    }
    return Object.freeze({
      known: true,
      ...copyAdoptionReplyFields(result, [
        "pathKey", "revision", "versionMatches", "capability", "ownDeletion",
        "orphaned", "pathOnly", "overflow", "relatedOrphanCount",
      ]),
    });
  },
  commitDocumentDiskAdoption(request) {
    const payload = {
      ...copyAdoptionTarget(request),
      ...copyAdoptionCapability(request),
      revision: request.revision,
      oldOwner: request.oldOwner === null
        ? null : copyAdoptionIdentity(request.oldOwner, request),
    };
    if (!revisionNumber(payload.revision)) {
      throw new TypeError("Invalid disk adoption revision");
    }
    const result = ipcRenderer.sendSync("commit-document-disk-adoption", payload);
    const refused = copyAdoptionRefusal(result, "accepted");
    if (refused) {
      if (refused.why === "resolved-historical-episode") {
        Object.assign(refused, copyAdoptionReplyFields(result, [
          "revision", "remainingPhysicalEpisodes",
        ]));
      }
      return Object.freeze(refused);
    }
    return Object.freeze({
      accepted: true,
      ...copyAdoptionReplyFields(result, [
        "capability", "incomingSpelling", "ownerSpelling", "tabId",
        "documentGeneration", "contentDigest", "confirmed", "pathKey", "revision",
      ]),
      version: copyDiskVersion(result.version, "disk adoption"),
    });
  },
  completeDocumentDiskAdoption(request) {
    const payload = {
      ...copyAdoptionCapability(request),
      filePath: request.filePath,
      ownerFilePath: request.ownerFilePath,
      revision: request.revision,
      actualOwner: copyAdoptionIdentity(request.actualOwner, request, true),
    };
    if (!isPath(payload.filePath) || !isPath(payload.ownerFilePath) ||
        !revisionNumber(payload.revision)) {
      throw new TypeError("Invalid disk adoption completion");
    }
    const result = ipcRenderer.sendSync("complete-document-disk-adoption", payload);
    const refused = copyAdoptionRefusal(result, "completed");
    return Object.freeze(refused || {
      completed: true,
      ...copyAdoptionReplyFields(result, [
        "capability", "revision", "unresolvedEvidence",
      ]),
    });
  },
  abandonDocumentDiskAdoption(request) {
    ipcRenderer.send("abandon-document-disk-adoption", copyAdoptionCapability(request));
  },
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

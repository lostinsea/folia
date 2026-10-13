const { contextBridge, ipcRenderer, webUtils } = require("electron");
let selectedDocumentRef = null;

// Capture before any page script can replace the legacy keys. The nonce and
// startup channel are deliberately absent from the public bridge.
const bootstrapArgument = process.argv.find(argument =>
  argument.startsWith("--folia-session-bootstrap="));
if (process.isMainFrame && bootstrapArgument) {
  const capture = { openTabs: null, activeTabPath: null };
  try {
    capture.openTabs = localStorage.getItem("openTabs");
    capture.activeTabPath = localStorage.getItem("activeTabPath");
  } catch (error) {
    capture.captureError = String(error.message).slice(0, 1024);
  }
  try {
    ipcRenderer.sendSync("bootstrap-legacy-document-session", {
      nonce: bootstrapArgument.slice("--folia-session-bootstrap=".length),
      ...capture,
    });
  } catch (error) {
    console.error("Private document session bootstrap failed:", error);
  }
  const nonce = bootstrapArgument.slice("--folia-session-bootstrap=".length);
  document.addEventListener("click", event => {
    if (!event.isTrusted || !selectedDocumentRef) return;
    const link = event.target?.closest?.("#viewer a, #viewer area");
    const href = link?.getAttribute("href") ?? link?.getAttribute("xlink:href");
    if (!href || /^[\u0000-\u0020]*$/.test(href) || href.startsWith("#")) return;
    const documentRef = selectedDocumentRef;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.invoke("private-trusted-document-gesture", {
      nonce, kind: "link", href, documentRef,
    }).catch(error => console.error("Trusted document link failed:", error));
  }, true);
  window.addEventListener("drop", event => {
    if (!event.isTrusted || !event.dataTransfer?.files?.length ||
        typeof webUtils?.getPathForFile !== "function") return;
    const file = event.dataTransfer.files[0];
    const filePath = webUtils.getPathForFile(file);
    event.preventDefault();
    document.body?.classList.remove("drop-active");
    if (!filePath) return;
    ipcRenderer.invoke("private-trusted-document-gesture", {
      nonce, kind: "drop", filePath,
    }).catch(error => console.error("Trusted document drop failed:", error));
  }, true);
}

function copyDocumentDescriptor(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.ref) ||
      !/^[a-f0-9]{32}$/.test(value.entryId) ||
      !["logicalPath", "spellingKey", "readTarget", "pathKey", "documentUrl"]
        .every(field => isPath(value[field])) ||
      !value.documentUrl.startsWith("file:") ||
      (value.openTicket !== undefined &&
        !/^[a-f0-9]{64}$/.test(value.openTicket))) {
    throw new TypeError("Invalid admitted document response");
  }
  return Object.freeze({
    ref: value.ref, entryId: value.entryId, logicalPath: value.logicalPath,
    spellingKey: value.spellingKey, readTarget: value.readTarget,
    pathKey: value.pathKey, documentUrl: value.documentUrl,
    ...(value.openTicket === undefined ? {} : { openTicket: value.openTicket }),
  });
}

function copyOptionalDocumentRef(value) {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("Invalid admitted document reference");
  }
  return { documentRef: value };
}

function copyNativeOpenTicket(request) {
  if (!request || typeof request.ticket !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.ticket)) {
    throw new TypeError("Invalid native document ticket");
  }
  return { ticket: request.ticket };
}

function copySessionAnchor(anchor) {
  if (anchor === null) return null;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) ||
      !Number.isFinite(anchor.scrollTop) || anchor.scrollTop < 0 ||
      (anchor.text !== null && (typeof anchor.text !== "string" ||
        anchor.text.length > 1024 * 1024)) ||
      !Number.isSafeInteger(anchor.ordinal) || anchor.ordinal < 0 ||
      !Number.isFinite(anchor.delta)) {
    throw new TypeError("Invalid document session anchor");
  }
  return Object.freeze({
    scrollTop: anchor.scrollTop, text: anchor.text,
    ordinal: anchor.ordinal, delta: anchor.delta,
  });
}

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
    ...(snapshot.document === undefined ? {} : {
      document: copyDocumentDescriptor(snapshot.document),
    }),
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
    ...copyOptionalDocumentRef(identity.documentRef),
    ...(!allowSelection || identity.selectionGeneration === undefined ? {} : {
      selectionGeneration: identity.selectionGeneration,
    }),
  };
}

function copySaveTransport(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      !positiveInteger(request.requestId) ||
      !request.saveRequest || !positiveInteger(request.saveRequest.sequence) ||
      !positiveInteger(request.saveRequest.selectionGeneration) ||
      request.saveRequest.requestId !== request.requestId) {
    throw new TypeError("Invalid Save transport request");
  }
  const envelope = copyAdoptionEnvelope({
    pageSession: request.saveRequestSession,
    rendererGeneration: request.saveRequest.rendererGeneration,
  });
  return {
    saveRequestSession: envelope.pageSession,
    requestId: request.requestId,
    saveRequest: {
      ...copyAdoptionIdentity(request.saveRequest, envelope, true),
      sequence: request.saveRequest.sequence,
      requestId: request.requestId,
    },
  };
}

function copyReloadTransport(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      !isPath(request.filePath) || !isPath(request.reloadRequestPath) ||
      !isPath(request.reloadRequestDocumentPathKey) ||
      typeof request.reloadRequestSnapshot !== "string" ||
      !["reloadRequestSequence", "reloadRequestTabId",
        "reloadRequestDocumentGeneration", "reloadRequestSelectionGeneration"]
        .every(field => positiveInteger(request[field]))) {
    throw new TypeError("Invalid reload transport request");
  }
  const envelope = copyAdoptionEnvelope({
    pageSession: request.reloadRequestSession,
    rendererGeneration: request.reloadRequestRendererGeneration,
  });
  return {
    filePath: request.filePath,
    reloadRequestSequence: request.reloadRequestSequence,
    reloadRequestPath: request.reloadRequestPath,
    reloadRequestSnapshot: request.reloadRequestSnapshot,
    reloadRequestSession: envelope.pageSession,
    reloadRequestTabId: request.reloadRequestTabId,
    reloadRequestDocumentGeneration: request.reloadRequestDocumentGeneration,
    reloadRequestDocumentPathKey: request.reloadRequestDocumentPathKey,
    reloadRequestRendererGeneration: envelope.rendererGeneration,
    reloadRequestSelectionGeneration: request.reloadRequestSelectionGeneration,
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

function copyDocumentIdentityRequest(request) {
  const envelope = copyAdoptionEnvelope(request);
  if (!isPath(request.filePath)) {
    throw new TypeError("Invalid document control path");
  }
  return {
    filePath: request.filePath,
    ...copyAdoptionIdentity(request, envelope, true),
  };
}

function copyTrackingEnvelope(request) {
  const envelope = copyAdoptionEnvelope(request);
  if (!isPath(request.filePath) ||
      !positiveInteger(request.owner?.selectionGeneration)) {
    throw new TypeError("Invalid document tracking request");
  }
  return {
    ...envelope,
    filePath: request.filePath,
    owner: copyAdoptionIdentity(request.owner, envelope, true),
  };
}

function copyTrackingSelection(request) {
  const payload = copyTrackingEnvelope(request);
  if (typeof request.adoptBaseline !== "boolean" ||
      typeof request.adoptPathIdentity !== "boolean" ||
      typeof request.trackingActive !== "boolean" ||
      (request.modifiedTime !== null && !Number.isFinite(request.modifiedTime))) {
    throw new TypeError("Invalid document tracking selection");
  }
  const diskVersion = request.diskVersion === null
    ? null : copyDiskVersion(request.diskVersion, "document tracking");
  if (request.adoptBaseline &&
      (!diskVersion || request.modifiedTime !== diskVersion.mtimeMs)) {
    throw new TypeError("Invalid document tracking baseline");
  }
  Object.assign(payload, {
    adoptBaseline: request.adoptBaseline,
    adoptPathIdentity: request.adoptPathIdentity,
    trackingActive: request.trackingActive,
    modifiedTime: request.modifiedTime,
    diskVersion,
  });
  if (request.adoption !== undefined) {
    const adoption = request.adoption;
    if (!adoption || typeof adoption !== "object" || Array.isArray(adoption) ||
        typeof adoption.capability !== "string" ||
        !/^[a-f0-9]{32}$/.test(adoption.capability) ||
        !revisionNumber(adoption.revision) ||
        typeof adoption.contentDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(adoption.contentDigest) ||
        !isPath(adoption.sourceFilePath) || !isPath(adoption.ownerFilePath)) {
      throw new TypeError("Invalid document tracking adoption");
    }
    payload.adoption = {
      capability: adoption.capability,
      revision: adoption.revision,
      contentDigest: adoption.contentDigest,
      sourceFilePath: adoption.sourceFilePath,
      ownerFilePath: adoption.ownerFilePath,
    };
  }
  return payload;
}

function copyTrackingOwnerReply(owner, envelope) {
  if (!positiveInteger(owner?.selectionGeneration) || !isPath(owner.spelling)) {
    throw new TypeError("Invalid document tracking owner response");
  }
  return Object.freeze({
    ...copyAdoptionIdentity(owner, envelope, true),
    spelling: owner.spelling,
  });
}

function copyDocumentQueryReply(result, fields) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      typeof result.known !== "boolean") {
    throw new TypeError("Invalid document query response");
  }
  return result.known
    ? { known: true, ...copyAdoptionReplyFields(result, fields) }
    : { known: false };
}

const api = Object.freeze({
  saveMarkdown(request) {
    const payload = copySaveTransport(request);
    if (!isPath(request.filePath) || typeof request.content !== "string") {
      throw new TypeError("Invalid Save transport content or path");
    }
    ipcRenderer.send("save-markdown-file", {
      ...payload, filePath: request.filePath, content: request.content,
    });
  },
  requestReload(request) {
    ipcRenderer.send("reload-file", copyReloadTransport(request));
  },
  async acknowledgeSaveResult(request) {
    const payload = copySaveTransport(request);
    if (!isPath(request.path) || !positiveInteger(request.saveResultAttempt)) {
      throw new TypeError("Invalid Save acknowledgement");
    }
    const result = await ipcRenderer.invoke("save-markdown-result-ack", {
      ...payload, path: request.path, saveResultAttempt: request.saveResultAttempt,
    });
    if (typeof result !== "boolean") {
      throw new TypeError("Invalid Save acknowledgement response");
    }
    return result;
  },
  async acceptDocumentOpenTicket(request) {
    const result = await ipcRenderer.invoke("accept-native-document-ticket",
      copyNativeOpenTicket(request));
    if (typeof result !== "boolean") throw new TypeError("Invalid native open response");
    return result;
  },
  async cancelDocumentOpenTicket(request) {
    const result = await ipcRenderer.invoke("cancel-native-document-ticket",
      copyNativeOpenTicket(request));
    if (typeof result !== "boolean") throw new TypeError("Invalid native cancel response");
    return result;
  },
  async openReadme() {
    const result = await ipcRenderer.invoke("open-admitted-readme");
    if (typeof result !== "boolean") throw new TypeError("Invalid README open response");
    return result;
  },
  async restoreSession() {
    const result = await ipcRenderer.invoke("restore-document-session");
    if (result === null) return null;
    if (!result || !Array.isArray(result.entries) ||
        result.entries.length > 512 ||
        (result.activeEntryId !== null &&
          !/^[a-f0-9]{32}$/.test(result.activeEntryId)) ||
        (result.error !== undefined && typeof result.error !== "string") ||
        (result.superseded !== undefined && typeof result.superseded !== "boolean")) {
      throw new TypeError("Invalid document session response");
    }
    const entries = result.entries.map(entry => {
      if (!entry || !/^[a-f0-9]{32}$/.test(entry.id) || !isPath(entry.filePath) ||
          !Number.isFinite(entry.scrollPosition) || entry.scrollPosition < 0) {
        throw new TypeError("Invalid document session entry");
      }
      return Object.freeze({
        id: entry.id, filePath: entry.filePath,
        scrollPosition: entry.scrollPosition, anchor: copySessionAnchor(entry.anchor),
        ...(typeof entry.error === "string" ? { error: entry.error } :
          copyDiskSnapshot(entry, "document session")),
      });
    });
    return Object.freeze({
      entries: Object.freeze(entries), activeEntryId: result.activeEntryId,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.superseded === undefined ? {} : { superseded: result.superseded }),
    });
  },
  async saveSessionLayout(request) {
    if (!request || !Array.isArray(request.entries) || request.entries.length > 512 ||
        (request.activeEntryId !== null &&
          !/^[a-f0-9]{32}$/.test(request.activeEntryId))) {
      throw new TypeError("Invalid document layout");
    }
    const entries = request.entries.map(entry => {
      if (!entry || !/^[a-f0-9]{32}$/.test(entry.id) ||
          typeof entry.documentRef !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.documentRef) ||
          !Number.isFinite(entry.scrollPosition) || entry.scrollPosition < 0) {
        throw new TypeError("Invalid document layout entry");
      }
      return { id: entry.id, documentRef: entry.documentRef, scrollPosition: entry.scrollPosition,
        anchor: copySessionAnchor(entry.anchor) };
    });
    const result = await ipcRenderer.invoke("save-document-session-layout", {
      entries, activeEntryId: request.activeEntryId,
    });
    if (result !== true) throw new TypeError("Invalid document layout response");
    return true;
  },
  async readOpenTicketSnapshot(request) {
    if (!request || typeof request.openTicket !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.openTicket)) {
      throw new TypeError("Invalid document open ticket");
    }
    const result = await ipcRenderer.invoke("read-open-ticket-snapshot", {
      openTicket: request.openTicket,
    });
    return result === null ? null : copyDiskSnapshot(result, "document open ticket");
  },
  registerDocumentOwner(request) {
    const payload = copyTrackingEnvelope(request);
    const diskVersion = copyDiskVersion(request.diskVersion, "document owner");
    if (request.modifiedTime !== diskVersion.mtimeMs) {
      throw new TypeError("Invalid document owner baseline");
    }
    ipcRenderer.send("register-document-owner", {
      ...payload, diskVersion, modifiedTime: request.modifiedTime,
    });
  },
  setActiveFile(request) {
    const payload = copyTrackingSelection(request);
    ipcRenderer.send("set-active-file", payload);
    selectedDocumentRef = payload.owner.documentRef || null;
  },
  selectFileTracking(request) {
    const payload = copyTrackingSelection(request);
    const result = ipcRenderer.sendSync("select-file-tracking", payload);
    const refused = copyAdoptionRefusal(result, "accepted");
    if (refused) {
      if (typeof result.mayHaveMoved !== "boolean") {
        throw new TypeError("Invalid document tracking refusal");
      }
      return Object.freeze({ ...refused, mayHaveMoved: result.mayHaveMoved });
    }
    const copy = {
      accepted: true, ...copyAdoptionReplyFields(result, ["trackingActive"]),
    };
    selectedDocumentRef = payload.owner.documentRef || null;
    if (payload.adoption || result.completedAdoption !== undefined) {
      if (typeof result.completedAdoption !== "string" ||
          !/^[a-f0-9]{32}$/.test(result.completedAdoption) ||
          !isPath(result.approvedPathKey) ||
          !isPath(result.approvedSourceFilePath) ||
          !isPath(result.approvedOwnerFilePath)) {
        throw new TypeError("Invalid document tracking adoption response");
      }
      Object.assign(copy, {
        completedAdoption: result.completedAdoption,
        approvedOwner: copyTrackingOwnerReply(result.approvedOwner, payload),
        approvedPathKey: result.approvedPathKey,
        approvedDiskVersion: copyDiskVersion(result.approvedDiskVersion, "document tracking"),
        approvedSourceFilePath: result.approvedSourceFilePath,
        approvedOwnerFilePath: result.approvedOwnerFilePath,
        ...copyAdoptionReplyFields(result, ["unresolvedEvidence", "trackingConflict"]),
      });
    }
    return Object.freeze(copy);
  },
  pauseFileWatching(request) {
    ipcRenderer.send("pause-file-watching", copyTrackingEnvelope(request));
  },
  resumeFileWatching(request) {
    ipcRenderer.send("resume-file-watching", copyTrackingEnvelope(request));
  },
  stopFileWatching(request) {
    ipcRenderer.send("stop-file-watching", copyTrackingEnvelope(request));
  },
  quarantineSelectedFileTracking(request) {
    const payload = copyTrackingEnvelope(request);
    if (!isPath(request.approvedPathKey) ||
        (request.background !== undefined && typeof request.background !== "boolean")) {
      throw new TypeError("Invalid document tracking quarantine");
    }
    Object.assign(payload, {
      approvedPathKey: request.approvedPathKey,
      approvedDiskVersion: copyDiskVersion(request.approvedDiskVersion, "document quarantine"),
      ...(request.background === undefined ? {} : { background: request.background }),
    });
    const result = ipcRenderer.sendSync("quarantine-selected-file-tracking", payload);
    const refused = copyAdoptionRefusal(result, "quarantined");
    if (refused) return Object.freeze(refused);
    if (!isPath(result.pathKey)) {
      throw new TypeError("Invalid document tracking quarantine response");
    }
    return Object.freeze({
      quarantined: true,
      owner: copyTrackingOwnerReply(result.owner, payload),
      pathKey: result.pathKey,
      diskVersion: copyDiskVersion(result.diskVersion, "document quarantine"),
    });
  },
  queryDocumentDeletionState(request) {
    const result = ipcRenderer.sendSync(
      "query-document-deletion-state", copyDocumentIdentityRequest(request),
    );
    return Object.freeze(copyDocumentQueryReply(result, [
      "revision", "ownDeletion", "orphaned", "pathOnly", "unreadable", "unresolved",
    ]));
  },
  queryDocumentDiskAdoptionState(request) {
    const payload = request?.tabId === null
      ? { ...copyAdoptionEnvelope(request), filePath: request.filePath, tabId: null }
      : copyDocumentIdentityRequest(request);
    if (!isPath(payload.filePath) || !isPath(request.ownerFilePath) ||
        !Number.isFinite(request.modifiedTime)) {
      throw new TypeError("Invalid document disk query");
    }
    Object.assign(payload, {
      ownerFilePath: request.ownerFilePath,
      modifiedTime: request.modifiedTime,
      diskVersion: copyDiskVersion(request.diskVersion, "document disk query"),
    });
    const result = ipcRenderer.sendSync("query-document-disk-adoption-state", payload);
    const copy = copyDocumentQueryReply(result, [
      "revision", "ownDeletion", "orphaned", "pathOnly", "overflow", "versionMatches",
    ]);
    if (copy.known) {
      if (result.pathKey !== null && !isPath(result.pathKey)) {
        throw new TypeError("Invalid document disk query response");
      }
      copy.pathKey = result.pathKey;
    }
    return Object.freeze(copy);
  },
  reportAdoptionTrackingConflict(request) {
    const envelope = copyAdoptionEnvelope(request);
    if (!isPath(request.filePath)) {
      throw new TypeError("Invalid document tracking conflict");
    }
    ipcRenderer.send("report-adoption-tracking-conflict", {
      ...envelope, filePath: request.filePath,
      owner: copyAdoptionIdentity(request.owner, envelope, true),
    });
  },
  retireDeletedDocumentOwner(request) {
    const payload = copyDocumentIdentityRequest(request);
    if (typeof request.acknowledgedDeletion !== "boolean") {
      throw new TypeError("Invalid document retirement acknowledgement");
    }
    payload.acknowledgedDeletion = request.acknowledgedDeletion;
    // Delivery tokens are evidence, not authority: main tolerates live drift.
    for (const field of ["eventId", "watcherGeneration", "attempt"]) {
      if (request[field] !== undefined) {
        if (!positiveInteger(request[field])) {
          throw new TypeError("Invalid document retirement evidence");
        }
        payload[field] = request[field];
      }
    }
    const result = ipcRenderer.sendSync("retire-deleted-document-owner", payload);
    const refused = copyAdoptionRefusal(result, "retired");
    if (!revisionNumber(result.revision) ||
        typeof result.why !== "string" || !result.why ||
        (typeof result.unresolved !== "boolean" &&
          (result.retired || result.unresolved !== null))) {
      throw new TypeError("Invalid document retirement response");
    }
    return Object.freeze({
      ...(refused || {
        retired: true,
        why: result.why,
        ...copyAdoptionReplyFields(result, ["retiredEvidence"]),
      }),
      revision: result.revision,
      unresolved: result.unresolved,
    });
  },
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
      Object.assign(payload, copyOptionalDocumentRef(identity.documentRef));
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
        ...copyOptionalDocumentRef(owner.documentRef),
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

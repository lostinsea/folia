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

function copyOwnedTabDiskRequest(request) {
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
  return payload;
}

function copyConditionalTabSnapshot(result, payload) {
  const kind = "conditional tab disk refresh";
  if (result === null) return null;
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      result.pathKey !== payload.owner.pathKey) {
    throw new TypeError(`Invalid ${kind} response`);
  }
  if (result.status === "changed") {
    if (Object.prototype.hasOwnProperty.call(result, "document")) {
      throw new TypeError(`Invalid ${kind} response`);
    }
    const snapshot = copyDiskSnapshot(result, kind);
    if (snapshot.modifiedTime !== snapshot.diskVersion.mtimeMs) {
      throw new TypeError(`Invalid ${kind} response`);
    }
    return Object.freeze({ status: "changed", pathKey: result.pathKey, ...snapshot });
  }
  if (Object.prototype.hasOwnProperty.call(result, "content") ||
      Object.prototype.hasOwnProperty.call(result, "modifiedTime") ||
      Object.prototype.hasOwnProperty.call(result, "document")) {
    throw new TypeError(`Invalid ${kind} response`);
  }
  if (result.status === "unchanged") {
    const diskVersion = copyDiskVersion(result.diskVersion, kind);
    // The content version deliberately ignores finite ctime-only drift.
    if (["dev", "ino", "size", "mtimeMs"].some(
      key => diskVersion[key] !== payload.diskVersion[key],
    )) throw new TypeError(`Invalid ${kind} response`);
    return Object.freeze({
      status: "unchanged", pathKey: result.pathKey,
      diskVersion,
    });
  }
  if (result.status === "unavailable" &&
      (result.reason === "missing" || result.reason === "binding") &&
      !Object.prototype.hasOwnProperty.call(result, "diskVersion")) {
    return Object.freeze({
      status: "unavailable", pathKey: result.pathKey, reason: result.reason,
    });
  }
  throw new TypeError(`Invalid ${kind} response`);
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

const DOCUMENT_EVENT_IDENTITY_FIELDS = [
  "pageSession", "rendererGeneration", "tabId", "documentGeneration", "pathKey",
  "documentRef", "selectionGeneration", "sequence", "requestId",
];
const DOCUMENT_EVENT_FIELDS = {
  "file-opened": ["path", "content", "allPaths", "extraReadGrants", "openRequest",
    "modifiedTime", "diskVersion", "document"],
  "file-open-result": ["success", "path", "openRequest", "reason", "message"],
  "file-reload-result": ["success", "path", "content", "modifiedTime", "diskVersion",
    "error", "reloadRequest", "reloadSession"],
  "save-markdown-result": ["success", "path", "requestId", "saveRequestSession",
    "saveRequest", "saveResultAttempt", "savedContent", "modifiedTime", "diskVersion",
    "error", "conflict", "deleted", "settlementOnly", "pathReplaced", "originalPathKey",
    "saveBlocked", "saveBlockedStage", "saveBlockedWhy"],
  "file-changed-externally": ["path", "modifiedTime", "watcher"],
  "prepare-for-pdf-export": [],
  "pdf-export-result": ["success", "path", "error", "saveBlocked",
    "saveBlockedStage", "saveBlockedWhy"],
  "image-selected": ["base64", "mimeType", "fileName", "error"],
  "quit-approval-request": ["id", "gen", "reason", "retainFreeze"],
  "quit-approval-commit": ["id", "gen", "revision"],
  "quit-approval-verify": ["id", "gen", "revision"],
  "quit-approval-thaw": [],
  "file-deleted": ["path", "delivery"],
  "file-not-found": ["path"],
  "external-file-open-request": ["filePath", "documentOpenTicket"],
  "show-error": [],
  "update-status": ["status", "version", "transferred", "total", "percent",
    "error", "message"],
};
const DOCUMENT_EVENT_RECORD_FIELDS = {
  diskVersion: ["dev", "ino", "size", "mtimeMs", "ctimeMs"],
  document: ["ref", "entryId", "logicalPath", "spellingKey", "readTarget",
    "pathKey", "documentUrl", "openTicket"],
  openRequest: ["token", "targetIndex", "path"],
  reloadRequest: ["sequence", "path", "snapshot", "session", "tabId",
    "documentGeneration", "pathKey", "rendererGeneration", "selectionGeneration", "documentRef"],
  reloadSession: ["epoch", "rendererGeneration", "pageSession"],
  saveRequest: DOCUMENT_EVENT_IDENTITY_FIELDS,
  watcher: ["pageSession", "rendererGeneration", "selectionGeneration",
    "watcherGeneration", "owner"],
  owner: ["pageSession", "rendererGeneration", "tabId", "documentGeneration", "pathKey"],
  delivery: ["eventId", "pageSession", "rendererGeneration",
    "selectionGeneration", "watcherGeneration", "attempt", "owner"],
};

function projectDocumentEventRecord(value, fields) {
  // Refusals can echo malformed identities. Projection must not repair them
  // into absence or prevent the existing settlement/rejection gates seeing them.
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const projected = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const nested = DOCUMENT_EVENT_RECORD_FIELDS[field];
    projected[field] = nested
      ? projectDocumentEventRecord(value[field], nested) : value[field];
  }
  return projected;
}

function subscribeDocumentEvent(channel, callback, once = false) {
  if (typeof callback !== "function") {
    throw new TypeError("Invalid document event callback");
  }
  let subscribed = true;
  const listener = (_event, data) => {
    if (once) subscribed = false;
    callback(projectDocumentEventRecord(data, DOCUMENT_EVENT_FIELDS[channel]));
  };
  if (once) ipcRenderer.once(channel, listener);
  else ipcRenderer.on(channel, listener);
  return () => {
    if (!subscribed) return;
    subscribed = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

function copyPopupRequest(request, textFields) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      typeof request.isDarkMode !== "boolean" ||
      !textFields.every(field => typeof request[field] === "string")) {
    throw new TypeError("Invalid popup request");
  }
  return Object.fromEntries([...textFields, "isDarkMode"]
    .map(field => [field, request[field]]));
}

function copyControlMessage(request, fields) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Invalid app control request");
  }
  // Main owns correlation validation. Refusal replies deliberately echo bad
  // or absent identities; repairing/rejecting them here can strand a request.
  return projectDocumentEventRecord(request, fields);
}

function copyApprovedDocumentRequest(request, withNavigation = false) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      !isPath(request.filePath)) {
    throw new TypeError("Invalid approved document request");
  }
  const payload = { filePath: request.filePath };
  if (withNavigation && request.openRequest != null) {
    const navigation = request.openRequest;
    if (typeof navigation !== "object" || Array.isArray(navigation) ||
        !positiveInteger(navigation.token) || !isPath(navigation.path) ||
        !Number.isSafeInteger(navigation.targetIndex) || navigation.targetIndex < 0) {
      throw new TypeError("Invalid approved navigation request");
    }
    payload.openRequest = {
      token: navigation.token, path: navigation.path,
      targetIndex: navigation.targetIndex,
    };
  }
  return payload;
}

function copyReloadTransport(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      !isPath(request.filePath) || !isPath(request.reloadRequestPath) ||
      !isPath(request.reloadRequestDocumentPathKey) ||
      typeof request.reloadRequestDocumentRef !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.reloadRequestDocumentRef) ||
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
    reloadRequestDocumentRef: request.reloadRequestDocumentRef,
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
  openApprovedDocument(request) {
    ipcRenderer.send("open-file-path", copyApprovedDocumentRequest(request, true));
  },
  revealApprovedDocument(request) {
    ipcRenderer.send("open-folder-in-explorer", copyApprovedDocumentRequest(request));
  },
  confirmLargeRender(request) {
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        typeof request.name !== "string" || !Number.isFinite(request.seconds) ||
        request.seconds < 0) {
      throw new TypeError("Invalid large render confirmation request");
    }
    const result = ipcRenderer.sendSync("confirm-large-render", {
      name: request.name, seconds: request.seconds,
    });
    if (typeof result !== "boolean") throw new TypeError("Invalid large render confirmation response");
    return result;
  },
  async getQuitApprovalGeneration() {
    const generation = await ipcRenderer.invoke("quit-approval-generation");
    if (!positiveInteger(generation)) throw new TypeError("Invalid renderer generation response");
    return generation;
  },
  announceQuitApprovalReady(request) {
    ipcRenderer.send("quit-approval-ready",
      copyControlMessage(request, ["gen", "pageSession"]));
  },
  respondToQuitApproval(request) {
    ipcRenderer.send("quit-approval-response",
      copyControlMessage(request, ["id", "gen", "dirtyFiles", "revision", "pendingSaves"]));
  },
  respondToQuitCommit(request) {
    ipcRenderer.send("quit-approval-committed",
      copyControlMessage(request, ["id", "gen", "committed", "why", "revision", "dirtyFiles"]));
  },
  respondToQuitVerification(request) {
    ipcRenderer.send("quit-approval-verified",
      copyControlMessage(request, ["id", "gen", "revision", "valid"]));
  },
  requestQuitApprovalRetry(request) {
    ipcRenderer.send("quit-approval-retry",
      copyControlMessage(request, ["id", "gen", "revision"]));
  },
  reportQuitApprovalOverflow(request) {
    ipcRenderer.send("quit-approval-overflow", copyControlMessage(request, ["id", "gen"]));
  },
  onQuitApprovalRequest(callback) {
    return subscribeDocumentEvent("quit-approval-request", callback);
  },
  onQuitApprovalCommit(callback) {
    return subscribeDocumentEvent("quit-approval-commit", callback);
  },
  onQuitApprovalVerification(callback) {
    return subscribeDocumentEvent("quit-approval-verify", callback);
  },
  onQuitApprovalThaw(callback) {
    return subscribeDocumentEvent("quit-approval-thaw", callback);
  },
  acknowledgeFileDeletion(request) {
    ipcRenderer.send("file-deleted-ack", copyControlMessage(request, [
      "eventId", "consumed", "why", "pageSession", "rendererGeneration", "tabId",
      "documentGeneration", "pathKey", "selectionGeneration", "watcherGeneration", "attempt",
    ]));
  },
  onFileDeleted(callback) {
    return subscribeDocumentEvent("file-deleted", callback);
  },
  onFileNotFound(callback) {
    return subscribeDocumentEvent("file-not-found", callback);
  },
  onExternalFileOpenRequest(callback) {
    return subscribeDocumentEvent("external-file-open-request", callback);
  },
  onError(callback) {
    return subscribeDocumentEvent("show-error", callback);
  },
  onUpdateStatus(callback) {
    return subscribeDocumentEvent("update-status", callback);
  },
  async getNewlineAlignmentDiagnosticsEnabled() {
    const enabled = await ipcRenderer.invoke("newline-alignment-diagnostics-enabled");
    if (typeof enabled !== "boolean") throw new TypeError("Invalid diagnostics response");
    return enabled;
  },
  reportNewlineAlignmentWitness(request) {
    ipcRenderer.send("newline-alignment-witness", copyControlMessage(request, [
      "callId", "callCount", "restoredSpans", "bytesScanned", "degradedCount",
      "ambiguousBoundaries", "mode",
    ]));
  },
  openFileDialog() {
    ipcRenderer.send("open-file-dialog");
  },
  openImageDialog() {
    ipcRenderer.send("open-image-dialog");
  },
  exportPdf(request) {
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        (request.currentFileName !== null && typeof request.currentFileName !== "string")) {
      throw new TypeError("Invalid PDF export request");
    }
    ipcRenderer.send("export-pdf", { currentFileName: request.currentFileName });
  },
  pdfExportReady() {
    ipcRenderer.send("pdf-export-ready");
  },
  onPrepareForPdfExport(callback) {
    return subscribeDocumentEvent("prepare-for-pdf-export", callback);
  },
  onPdfExportResult(callback) {
    return subscribeDocumentEvent("pdf-export-result", callback);
  },
  oncePdfExportResult(callback) {
    return subscribeDocumentEvent("pdf-export-result", callback, true);
  },
  onImageSelected(callback) {
    return subscribeDocumentEvent("image-selected", callback);
  },
  openMermaidPopup(request) {
    ipcRenderer.send("open-mermaid-popup", copyPopupRequest(request, ["svgContent"]));
  },
  openImagePopup(request) {
    ipcRenderer.send("open-image-popup", copyPopupRequest(request, ["src", "alt"]));
  },
  openTablePopup(request) {
    const payload = copyPopupRequest(request, []);
    const tableData = request.tableData;
    if (!tableData || typeof tableData !== "object" || Array.isArray(tableData) ||
        !Array.isArray(tableData.columns) || !Array.isArray(tableData.data)) {
      throw new TypeError("Invalid table popup request");
    }
    // Main owns escaping, re-keying and column policy; do not scan rows twice.
    payload.tableData = { columns: tableData.columns, data: tableData.data };
    ipcRenderer.send("open-table-popup", payload);
  },
  downloadUpdate() {
    ipcRenderer.send("download-update");
  },
  installUpdate() {
    ipcRenderer.send("install-update");
  },
  async getVersion() {
    const version = await ipcRenderer.invoke("get-version");
    if (typeof version !== "string") throw new TypeError("Invalid app version response");
    return version;
  },
  onFileOpened(callback) {
    return subscribeDocumentEvent("file-opened", callback);
  },
  onFileOpenResult(callback) {
    return subscribeDocumentEvent("file-open-result", callback);
  },
  onFileReloadResult(callback) {
    return subscribeDocumentEvent("file-reload-result", callback);
  },
  onSaveMarkdownResult(callback) {
    return subscribeDocumentEvent("save-markdown-result", callback);
  },
  onFileChangedExternally(callback) {
    return subscribeDocumentEvent("file-changed-externally", callback);
  },
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
  checkCommittedDiskAdoption(request) {
    const payload = copyAdoptionCapability(request);
    const result = ipcRenderer.sendSync("check-committed-disk-adoption", payload);
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        typeof result.valid !== "boolean") {
      throw new TypeError("Invalid committed disk adoption response");
    }
    if (!result.valid) {
      if (typeof result.why !== "string" || !result.why ||
          result.why.length > 256 || Object.keys(result).some(
            key => key !== "valid" && key !== "why",
          )) throw new TypeError("Invalid committed disk adoption response");
      return Object.freeze({ valid: false, why: result.why });
    }
    if (!isPath(result.pathKey) || Object.keys(result).some(
      key => !["valid", "pathKey", "version"].includes(key),
    )) throw new TypeError("Invalid committed disk adoption response");
    return Object.freeze({
      valid: true, pathKey: result.pathKey,
      version: copyDiskVersion(result.version, "committed disk adoption"),
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
    const payload = copyOwnedTabDiskRequest(request);
    const snapshot = await ipcRenderer.invoke(
      "read-owned-tab-disk-snapshot", payload,
    );
    if (snapshot === null) return null;
    return copyDiskSnapshot(snapshot, "owned tab disk snapshot");
  },
  checkOwnedTabDiskSnapshot(request) {
    const kind = "owned tab disk check";
    const payload = copyOwnedTabDiskRequest(request);
    if (!payload.owner.documentRef || payload.filePath.length > 32768 ||
        (request.sourcePath !== undefined &&
          (!isPath(request.sourcePath) || request.sourcePath.length > 32768))) {
      throw new TypeError(`Invalid ${kind} request`);
    }
    payload.diskVersion = copyDiskVersion(request.diskVersion, kind);
    if (request.sourcePath !== undefined) payload.sourcePath = request.sourcePath;
    const result = ipcRenderer.sendSync("check-owned-tab-disk-snapshot", payload);
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        typeof result.matches !== "boolean") {
      throw new TypeError(`Invalid ${kind} response`);
    }
    const allowedFields = result.matches
      ? ["matches", "pathKey", "diskVersion"] : ["matches", "why"];
    if (Object.keys(result).some(key => !allowedFields.includes(key))) {
      throw new TypeError(`Invalid ${kind} response`);
    }
    if (!result.matches) {
      if (typeof result.why !== "string" || !result.why || result.why.length > 128) {
        throw new TypeError(`Invalid ${kind} response`);
      }
      return Object.freeze({ matches: false, why: result.why });
    }
    const diskVersion = copyDiskVersion(result.diskVersion, kind);
    if (result.pathKey !== payload.owner.pathKey ||
        Object.keys(result.diskVersion).some(key => !Object.hasOwn(diskVersion, key)) ||
        ["dev", "ino", "size", "mtimeMs"].some(
          key => diskVersion[key] !== payload.diskVersion[key],
        )) {
      throw new TypeError(`Invalid ${kind} response`);
    }
    return Object.freeze({ matches: true, pathKey: result.pathKey, diskVersion });
  },
  async refreshOwnedTabDiskSnapshot(request) {
    const payload = copyOwnedTabDiskRequest(request);
    if (!payload.owner.documentRef) {
      throw new TypeError("Invalid conditional tab disk refresh request");
    }
    payload.diskVersion = copyDiskVersion(request.diskVersion, "conditional tab disk refresh request");
    const result = await ipcRenderer.invoke("refresh-owned-tab-disk-snapshot", payload);
    return copyConditionalTabSnapshot(result, payload);
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

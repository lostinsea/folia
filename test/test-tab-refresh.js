// End-to-end regression harness for the tab overlay (custom-tabs.js).
// Run with: npm run test:tabs
//
// Boots the real main.js so every real IPC handler exists, then drives the
// renderer through the multi-tab refresh scenarios via executeJavaScript.
// Uses only the Electron already required to run the app - no test framework.
const { app, BrowserWindow, dialog, ipcMain, autoUpdater: electronAutoUpdater } = require("electron");
const fs = require("fs");
const path = require("path");

// The portable path is selected when main.js is loaded. A separate Electron
// invocation is therefore the only live test of it that does not reload main
// into an already-running app (and double-register every lifecycle listener).
const portableHarness = process.env.F22_PORTABLE_HARNESS === "1";
const focusedF22Harness = process.env.F22_FOCUSED_HARNESS === "1";
const focusedCommitHarness = process.env.F22_COMMIT_FOCUSED_HARNESS === "1";
const companionSelfcheck = process.env.F22_COMPANION_SELFCHECK === "1";
// One window-destroying teardown case per child process. See
// runTeardownScenario(): main.js nulls its own `mainWindow` on `closed`, so a
// scenario that destroys the window poisons every later scenario in the same
// process.
const teardownCase = process.env.F22_TEARDOWN_CASE || "";
// A subprocess whose only job is to reach this file's finalizer with a
// preserved companion tree, so the preservation can be observed from OUTSIDE
// the process that performs it. See runFinalizerPreservationSubprocess().
const finalizerSelfcheck = process.env.F22_FINALIZER_SELFCHECK === "1";
// SAMPLED BEFORE THE FALLBACK BELOW WRITES IT. "PORTABLE_EXECUTABLE_DIR is set"
// is not evidence that anything outside this harness chose the portable branch
// once this harness is one of the things that can set it. Recorded here so the
// portable companion can assert it was INHERITED.
const portableEnvWasInherited =
  typeof process.env.PORTABLE_EXECUTABLE_DIR === "string" &&
  process.env.PORTABLE_EXECUTABLE_DIR.length > 0;
// EVERY COMPANION NEEDS ITS OWN PROFILE NAME, NOT JUST THE PORTABLE ONE.
// test-userdata-isolation derives a FIXED per-suite profile directory from the
// first JavaScript argv entry and WIPES it on entry. A companion spawned as
// `electron test-tab-refresh.js` therefore resolves to `test-tab-refresh` -
// the profile the parent Electron process is running out of right now - and
// the wipe fails EPERM against the parent's own open handles, which is a
// fatal exit(1) before the companion has run a single assertion. Measured:
// all three teardown companions died that way while the portable companion,
// which already renamed itself here, ran fine. The name is per CASE because
// the profile is wiped on entry, so two cases sharing one name would race a
// still-releasing handle from the case before them.
if (portableHarness) {
  process.argv.splice(1, 0, "test-f22-portable.js");
  process.env.PORTABLE_EXECUTABLE_DIR =
    process.env.PORTABLE_EXECUTABLE_DIR || path.join(process.cwd(), "tmp");
} else if (teardownCase) {
  process.argv.splice(1, 0, `test-f22-teardown-${teardownCase}.js`);
} else if (focusedCommitHarness) {
  process.argv.splice(1, 0, "test-f22-commit.js");
} else if (focusedF22Harness) {
  process.argv.splice(1, 0, "test-f22-focused.js");
} else if (finalizerSelfcheck) {
  process.argv.splice(1, 0, "test-f22-finalizer.js");
} else if (companionSelfcheck) {
  process.argv.splice(1, 0, "test-f22-companion-selfcheck.js");
}

const {
  inspectVisual,
  captureScreenshot,
  startErrorSentinel,
  proveSentinelAlive,
  trapExternalOpens,
  tempDir,
  releaseTempDir,
  REGISTERED_TEMP_DIRS,
  sweepTempDirs,
} = require("./test-visual-utils");

// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

const results = [];
let unavailableEvidence = 0;
// A SCOPED CAPTURE, FOR TESTING THE HARNESS'S OWN ASSERTIONS. Some controls in
// this file are only observable by making a helper FAIL and then reading the
// assertion it produced - runCompanion's naming and accounting under a spawn
// that throws is the case that forced this. Letting that failure reach the
// transcript would be worse than not testing it: the revert audit reads FAIL
// names at column zero, so a deliberately provoked one is indistinguishable
// from a real regression. Inside a capture nothing is recorded and nothing is
// printed; the caller asserts on what it caught, in its own name.
let checkCapture = null;
function check(name, ok, detail) {
  if (checkCapture) {
    checkCapture.push({ name, ok, detail });
    return;
  }

  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

function unavailable(name, detail) {
  unavailableEvidence += 1;
  console.log(`UNAVAILABLE  ${name}  -> ${detail}`);
}

// This is deliberately data-only: capability scheduling must be testable
// without Electron state, and each group remains independently reportable.
function createDeletionEvidencePlan(capabilities, acknowledgementContract) {
  const producerGeneration = capabilities.producer === true;
  const acknowledgementLifecycle =
    capabilities.ackIdentity === true && acknowledgementContract === "valid";
  return Object.freeze({
    producerGeneration: Object.freeze({
      scheduled: producerGeneration,
      unavailable: "F22 deletion producer identity evidence is unavailable",
    }),
    watcherOwnership: Object.freeze({
      scheduled: capabilities.watcher === true,
      unavailable: "F22 deletion watcher ownership evidence is unavailable",
    }),
    rendererTombstoneCache: Object.freeze({
      scheduled: capabilities.tombstone === true,
      unavailable: "F22 deletion tombstone cache evidence is unavailable",
    }),
    deletionSaveRefusal: Object.freeze({
      scheduled: capabilities.saveRefusal === true,
      unavailable: "F22 deletion Save-refusal evidence is unavailable",
    }),
    acknowledgementLifecycle: Object.freeze({
      scheduled: acknowledgementLifecycle,
      unavailable: "F22 deletion ACK identity/retirement evidence is unavailable",
      invalid: acknowledgementContract === "invalid",
    }),
    synchronousSendRecovery: Object.freeze({
      scheduled:
        capabilities.synchronousSend === true && acknowledgementLifecycle,
      unavailable: "F22 synchronous deletion-send recovery evidence is unavailable",
    }),
  });
}

async function runDeletionEvidenceGroup(plan, group, body) {
  if (!plan[group].scheduled) return undefined;
  return body();
}

function scheduleDeletionAssertion(plan, groups, sink, name, evaluate, detail) {
  if (
    !Array.isArray(groups) ||
    !groups.every((group) => plan[group] && plan[group].scheduled === true)
  ) {
    return false;
  }
  sink(
    name,
    evaluate(),
    typeof detail === "function" ? detail() : detail,
  );
  return true;
}

function classifyDeletionCapability(advertised, supported) {
  if (!advertised) return "absent";
  return supported ? "supported" : "invalid";
}

function sourceForNamedDeletionFunction(source, name) {
  if (typeof source !== "string" || typeof name !== "string") return "";
  const isIdentifier = (character) =>
    typeof character === "string" && /[A-Za-z0-9_$]/.test(character);
  const skipQuoted = (index, quote) => {
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === "\\") {
        cursor += 1;
      } else if (source[cursor] === quote) {
        return cursor + 1;
      }
    }
    return source.length;
  };
  const skipLineComment = (index) => {
    const newline = source.indexOf("\n", index + 2);
    return newline < 0 ? source.length : newline + 1;
  };
  const skipBlockComment = (index) => {
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
  };
  const skipSyntax = (index) => {
    const character = source[index];
    if (character === "'" || character === '"') {
      return skipQuoted(index, character);
    }
    if (character === "/" && source[index + 1] === "/") {
      return skipLineComment(index);
    }
    if (character === "/" && source[index + 1] === "*") {
      return skipBlockComment(index);
    }
    if (character !== "`") return index;
    let cursor = index + 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
      } else if (source[cursor] === "`") {
        return cursor + 1;
      } else if (source[cursor] === "$" && source[cursor + 1] === "{") {
        cursor = skipInterpolation(cursor + 2);
      } else {
        cursor += 1;
      }
    }
    return source.length;
  };
  const skipInterpolation = (index) => {
    let depth = 1;
    for (let cursor = index; cursor < source.length; cursor += 1) {
      const skipped = skipSyntax(cursor);
      if (skipped !== cursor) {
        cursor = skipped - 1;
        continue;
      }
      if (source[cursor] === "{") {
        depth += 1;
      } else if (source[cursor] === "}" && --depth === 0) {
        return cursor + 1;
      }
    }
    return source.length;
  };
  const findCodeCharacter = (start, target) => {
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const skipped = skipSyntax(cursor);
      if (skipped !== cursor) {
        cursor = skipped - 1;
      } else if (source[cursor] === target) {
        return cursor;
      }
    }
    return -1;
  };
  const matchingDelimiter = (start, open, close) => {
    let depth = 0;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const skipped = skipSyntax(cursor);
      if (skipped !== cursor) {
        cursor = skipped - 1;
        continue;
      }
      if (source[cursor] === open) {
        depth += 1;
      } else if (source[cursor] === close && --depth === 0) {
        return cursor;
      }
    }
    return -1;
  };
  for (let start = 0; start < source.length; start += 1) {
    const skipped = skipSyntax(start);
    if (skipped !== start) {
      start = skipped - 1;
      continue;
    }
    if (
      !source.startsWith("function", start) ||
      isIdentifier(source[start - 1]) ||
      isIdentifier(source[start + "function".length])
    ) {
      continue;
    }
    let cursor = start + "function".length;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (source[cursor] === "*") cursor += 1;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (
      !source.startsWith(name, cursor) ||
      isIdentifier(source[cursor - 1]) ||
      isIdentifier(source[cursor + name.length])
    ) {
      continue;
    }
    const argumentsStart = findCodeCharacter(cursor + name.length, "(");
    if (argumentsStart < 0) return "";
    const argumentsEnd = matchingDelimiter(argumentsStart, "(", ")");
    if (argumentsEnd < 0) return "";
    const bodyStart = findCodeCharacter(argumentsEnd + 1, "{");
    if (bodyStart < 0) return "";
    const bodyEnd = matchingDelimiter(bodyStart, "{", "}");
    return bodyEnd < 0 ? "" : source.slice(start, bodyEnd + 1);
  }
  return "";
}

function deletionIdentityFieldsPresent(source) {
  return [
    "eventId",
    "selectionGeneration",
    "watcherGeneration",
    "attempt",
    "pageSession",
    "rendererGeneration",
    "tabId",
    "documentGeneration",
    "pathKey",
  ].every((field) => new RegExp(`\\b${field}\\b`).test(source));
}

function deletionOwnerFieldsPresent(source) {
  return [
    "pageSession",
    "rendererGeneration",
    "tabId",
    "documentGeneration",
    "pathKey",
  ].every((field) => new RegExp(`\\b${field}\\b`).test(source));
}

function directReturnCallName(functionSource) {
  if (typeof functionSource !== "string") return "";
  const isIdentifier = (character) =>
    typeof character === "string" && /[A-Za-z0-9_$]/.test(character);
  const skipQuoted = (index, quote) => {
    for (let cursor = index + 1; cursor < functionSource.length; cursor += 1) {
      if (functionSource[cursor] === "\\") {
        cursor += 1;
      } else if (functionSource[cursor] === quote) {
        return cursor + 1;
      }
    }
    return functionSource.length;
  };
  const skipSyntax = (index) => {
    const character = functionSource[index];
    if (character === "'" || character === '"' || character === "`") {
      return skipQuoted(index, character);
    }
    if (character === "/" && functionSource[index + 1] === "/") {
      const newline = functionSource.indexOf("\n", index + 2);
      return newline < 0 ? functionSource.length : newline + 1;
    }
    if (character === "/" && functionSource[index + 1] === "*") {
      const end = functionSource.indexOf("*/", index + 2);
      return end < 0 ? functionSource.length : end + 2;
    }
    return index;
  };
  let bodyStart = -1;
  for (let cursor = 0; cursor < functionSource.length; cursor += 1) {
    const skipped = skipSyntax(cursor);
    if (skipped !== cursor) {
      cursor = skipped - 1;
    } else if (functionSource[cursor] === "{") {
      bodyStart = cursor;
      break;
    }
  }
  if (bodyStart < 0) return "";
  let depth = 1;
  for (let cursor = bodyStart + 1; cursor < functionSource.length; cursor += 1) {
    const skipped = skipSyntax(cursor);
    if (skipped !== cursor) {
      cursor = skipped - 1;
      continue;
    }
    const character = functionSource[cursor];
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (
      depth !== 1 ||
      !functionSource.startsWith("return", cursor) ||
      isIdentifier(functionSource[cursor - 1]) ||
      isIdentifier(functionSource[cursor + "return".length])
    ) {
      continue;
    }
    let nameStart = cursor + "return".length;
    while (/\s/.test(functionSource[nameStart] || "")) nameStart += 1;
    if (!/[A-Za-z_$]/.test(functionSource[nameStart] || "")) continue;
    let nameEnd = nameStart + 1;
    while (isIdentifier(functionSource[nameEnd])) nameEnd += 1;
    let argumentsStart = nameEnd;
    while (/\s/.test(functionSource[argumentsStart] || "")) argumentsStart += 1;
    if (functionSource[argumentsStart] === "(") {
      return functionSource.slice(nameStart, nameEnd);
    }
  }
  return "";
}

function reachableDeletionOwnerIdentity(source) {
  const visited = new Set();
  let functionName = "getActiveDocumentIdentity";
  // Direct identity-helper delegation is deliberately bounded; a cycle is
  // invalid rather than an unbounded source-analysis walk.
  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(functionName)) return false;
    visited.add(functionName);
    const functionSource = sourceForNamedDeletionFunction(source, functionName);
    if (!functionSource) return false;
    if (deletionOwnerFieldsPresent(functionSource)) return true;
    functionName = directReturnCallName(functionSource);
    if (!functionName) return false;
  }
  return false;
}

function hasSaveResultCorrelationContract(saveHandlerSource) {
  const resultStart = saveHandlerSource.indexOf("const sendSaveResult =");
  const resultEnd = saveHandlerSource.indexOf(
    "const sendSaveScopeFailure",
    resultStart + 1,
  );
  const resultSource = resultStart < 0
    ? ""
    : saveHandlerSource.slice(
      resultStart,
      resultEnd < 0 ? undefined : resultEnd,
    );
  const payload = /replyTarget\.send\(\s*["']save-markdown-result["']\s*,\s*\{([\s\S]*?)\}\s*\)/.exec(
    resultSource,
  );
  return /\bconst\s+saveRequestSession\s*=\s*data\s*&&\s*data\.saveRequestSession\b/.test(
    saveHandlerSource,
  ) &&
    /\bconst\s+saveRequest\s*=\s*data\s*&&\s*data\.saveRequest\b/.test(
      saveHandlerSource,
    ) &&
    !!payload &&
    /(?:^|,)\s*saveRequestSession\s*,/.test(payload[1]) &&
    /(?:^|,)\s*saveRequest\s*,/.test(payload[1]);
}

function saveResultCorrelationSelfcheck() {
  const valid = `
    const saveRequestSession = data && data.saveRequestSession;
    const saveRequest = data && data.saveRequest;
    const sendSaveResult = () => {
      replyTarget.send("save-markdown-result", {
        ...outgoing,
        saveRequestSession,
        saveRequest,
      });
    };
    const sendSaveScopeFailure = () => {};
  `;
  const deadShorthand = valid.replace(
    "saveRequestSession,\n        saveRequest,",
    "requestSession: saveRequestSession,\n        request: saveRequest,",
  ) + "\nconst decoy = { saveRequestSession, saveRequest, };";
  return hasSaveResultCorrelationContract(valid) &&
    !hasSaveResultCorrelationContract(deadShorthand);
}

// This is the one deletion-contract classifier used by both the live
// preflight and the pure fixtures below. Keep advertisements separate from
// implementations: a half-landed protocol is a hard failure, never an
// "unavailable" excuse.
function deriveDeletionContracts({
  mainSource = "",
  rendererSource = "",
  tabsSource = "",
  runtimeAckListeners = [],
} = {}) {
  const normaliseRuntimeListener = (listener) => {
    const actual = listener && listener.listener ? listener.listener : listener;
    const source = listener && typeof listener.source === "string"
      ? listener.source
      : typeof actual === "function"
        ? Function.prototype.toString.call(actual)
        : "";
    return {
      raw: listener,
      source,
      once: !!(listener && (listener.once === true || listener.listener)),
      async:
        !!(listener && listener.async === true) ||
        !!(actual && actual.constructor &&
          actual.constructor.name === "AsyncFunction") ||
        /\bawait\b/.test(source),
    };
  };
  const ackListeners = runtimeAckListeners.map(normaliseRuntimeListener);
  const deliverySource = sourceForNamedDeletionFunction(
    mainSource,
    "deliverDeletionReport",
  );
  const saveHandlerStart = mainSource.indexOf('ipcMain.on("save-markdown-file"');
  const saveHandlerEnd = mainSource.indexOf(
    "\nipcMain.",
    saveHandlerStart + 1,
  );
  const saveHandlerSource = saveHandlerStart < 0
    ? ""
    : mainSource.slice(
      saveHandlerStart,
      saveHandlerEnd < 0 ? undefined : saveHandlerEnd,
    );
  const producerAdvertised = /\bdeliverDeletionReport\b/.test(mainSource);
  const producerDelivery = producerAdvertised &&
    /\.send\(\s*["']file-deleted["']/.test(deliverySource);
  const deliveryIdentity = producerDelivery &&
    deletionIdentityFieldsPresent(deliverySource);
  const documentTombstone = /\bdeletionTombstone\b/.test(tabsSource);
  const saveResultAdvertised = /\bsaveRequest(?:Session)?\b/.test(
    saveHandlerSource,
  );
  const saveResultCorrelation = hasSaveResultCorrelationContract(
    saveHandlerSource,
  );
  // Seeing the public helper merely advertises a reload-owner protocol. The
  // helper must reach a body that constructs the full owner identity before it
  // can support it.
  const reloadOwnerAdvertised = /\bgetActiveDocumentIdentity\b/.test(
    tabsSource,
  );
  const reloadOwnerIdentity = reloadOwnerAdvertised &&
    reachableDeletionOwnerIdentity(tabsSource);
  const acknowledgedDelivery = /\bfile-deleted-ack\b/.test(mainSource);
  const rendererAcknowledgementSender =
    /ipcRenderer\.send\(\s*["']file-deleted-ack["']/.test(rendererSource);
  const rendererDeletionClassifier =
    sourceForNamedDeletionFunction(
      rendererSource,
      "classifyDeletionDelivery",
    ).length > 0 &&
    sourceForNamedDeletionFunction(
      rendererSource,
      "acknowledgeDeletionDelivery",
    ).length > 0;
  const productionAckListeners = ackListeners.filter((listener) =>
    /\bfindDeletionDeliveryById\b/.test(listener.source) &&
    /\bclearDeletionDeliveryAttempt\b/.test(listener.source) &&
    /\brendererGeneration\b/.test(listener.source));
  const productionAckHandler = productionAckListeners[0] || null;
  const productionAckSource = productionAckHandler
    ? productionAckHandler.source
    : "";
  const acknowledgementAttempt = !!productionAckHandler &&
    /\bfindDeletionDeliveryById\b/.test(productionAckSource) &&
    /\bclearDeletionDeliveryAttempt\b/.test(productionAckSource) &&
    deletionIdentityFieldsPresent(productionAckSource);
  const persistentProductionAckRegistration =
    ackListeners.length === 1 &&
    productionAckListeners.length === 1 &&
    ackListeners[0] === productionAckHandler &&
    productionAckHandler.once === false &&
    /ipcMain\.on\(\s*["']file-deleted-ack["']/.test(mainSource);
  const synchronousProductionAckHandler = !!productionAckHandler &&
    productionAckHandler.async === false;
  const caughtSynchronousSend =
    /try\s*\{[\s\S]*?\.send\(\s*["']file-deleted["'][\s\S]*?\}\s*catch/.test(
      deliverySource,
    );
  const prerequisite = {
    documentTombstone,
    producerDelivery,
    deliveryIdentity,
    acknowledgedDelivery,
    rendererAcknowledgementSender,
    rendererDeletionClassifier,
    acknowledgementAttempt,
    mainAcknowledgementListener: productionAckListeners.length > 0,
    uniqueProductionAckRegistration: productionAckListeners.length === 1,
    persistentProductionAckRegistration,
    synchronousProductionAckHandler,
    caughtSynchronousSend,
    saveResultCorrelation,
    saveResultAdvertised,
    reloadOwnerAdvertised,
    reloadOwnerIdentity,
  };
  const capabilities = {
    producer: producerDelivery && deliveryIdentity,
    tombstone: producerDelivery && deliveryIdentity && documentTombstone,
    watcher: producerDelivery && deliveryIdentity,
    saveRefusal:
      producerDelivery &&
      deliveryIdentity &&
      documentTombstone &&
      saveResultCorrelation,
    ackIdentity:
      producerDelivery &&
      deliveryIdentity &&
      acknowledgedDelivery &&
      rendererAcknowledgementSender &&
      rendererDeletionClassifier &&
      acknowledgementAttempt &&
      prerequisite.mainAcknowledgementListener &&
      prerequisite.uniqueProductionAckRegistration &&
      persistentProductionAckRegistration &&
      synchronousProductionAckHandler,
    synchronousSend:
      producerDelivery &&
      deliveryIdentity &&
      caughtSynchronousSend &&
      acknowledgedDelivery,
    reloadOwner: reloadOwnerIdentity,
  };
  const acknowledgementAdvertised =
    acknowledgedDelivery ||
    rendererAcknowledgementSender ||
    ackListeners.length > 0;
  const acknowledgementContractViolations = acknowledgementAdvertised
    ? [
      acknowledgementAttempt ||
        "the ACK attempt contract is malformed",
      acknowledgedDelivery ||
        "main does not advertise the ACK channel",
      rendererAcknowledgementSender ||
        "renderer does not advertise the ACK sender",
      rendererDeletionClassifier ||
        "renderer does not provide the deletion classifier",
      ackListeners.length === 1 ||
        `runtime listener count is ${ackListeners.length}, not 1`,
      productionAckListeners.length === 1 ||
        `matching production handlers is ${productionAckListeners.length}, not 1`,
      persistentProductionAckRegistration ||
        "the production ACK registration is not one persistent handler",
      !productionAckHandler || !productionAckHandler.once ||
        "the production ACK handler is registered with once",
      !productionAckHandler || synchronousProductionAckHandler ||
        "the production ACK handler is asynchronous",
    ].filter((result) => typeof result === "string")
    : [];
  const acknowledgementContract = !acknowledgementAdvertised
    ? "absent"
    : acknowledgementContractViolations.length === 0 ? "valid" : "invalid";
  const capabilityContracts = {
    producerGeneration: classifyDeletionCapability(
      producerAdvertised,
      capabilities.producer,
    ),
    watcherOwnership: classifyDeletionCapability(
      producerAdvertised,
      capabilities.watcher,
    ),
    rendererTombstoneCache: classifyDeletionCapability(
      producerAdvertised || documentTombstone,
      capabilities.tombstone,
    ),
    deletionSaveRefusal: classifyDeletionCapability(
      producerAdvertised || documentTombstone,
      capabilities.saveRefusal,
    ),
    synchronousSendRecovery: classifyDeletionCapability(
      producerAdvertised,
      capabilities.synchronousSend,
    ),
    reloadOwner: classifyDeletionCapability(
      reloadOwnerAdvertised,
      reloadOwnerIdentity,
    ),
  };
  const statuses = [
    ...Object.values(capabilityContracts),
    acknowledgementContract === "valid" ? "supported" : acknowledgementContract,
  ];
  return {
    prerequisite,
    capabilities,
    capabilityContracts,
    acknowledgementContract,
    acknowledgementContractViolations,
    acknowledgementAdvertised,
    productionAckListeners,
    productionAckHandler,
    productionAckSource,
    synchronousProductionAckHandler,
    saveHandlerSource,
    status: statuses.includes("invalid")
      ? "invalid"
      : statuses.every((status) => status === "absent")
        ? "absent"
        : "supported",
  };
}

function deletionEvidenceDisposition(derived, plan, group) {
  const contract = group === "acknowledgementLifecycle"
    ? derived.acknowledgementContract === "valid"
      ? "supported"
      : derived.acknowledgementContract
    : derived.capabilityContracts[group];
  if (plan[group] && plan[group].scheduled === true) return "scheduled";
  return (plan[group] && plan[group].invalid === true) || contract === "invalid"
    ? "invalid"
    : "unavailable";
}

function deletionCapabilityClassificationSelfcheck() {
  const delivery = `
function deliverDeletionReport(target) {
  const deliveryIdentity = {
    eventId: 1,
    selectionGeneration: 1,
    watcherGeneration: 1,
    attempt: 1,
    pageSession: "fixture",
    rendererGeneration: 1,
    tabId: 1,
    documentGeneration: 1,
    pathKey: "fixture",
  };
  try {
    target.send("file-deleted", deliveryIdentity);
  } catch (error) {}
}
`;
  const acknowledgement = `
ipcMain.on("file-deleted-ack", function acknowledgement(event, payload) {
  const record = findDeletionDeliveryById(payload.eventId);
  if (!record ||
      payload.selectionGeneration !== record.selectionGeneration ||
      payload.watcherGeneration !== record.watcherGeneration ||
      payload.attempt !== record.attempt ||
      payload.pageSession !== record.owner.pageSession ||
      payload.rendererGeneration !== record.owner.rendererGeneration ||
      payload.owner.tabId !== record.owner.tabId ||
      payload.owner.documentGeneration !== record.owner.documentGeneration ||
      payload.owner.pathKey !== record.owner.pathKey) return;
  clearDeletionDeliveryAttempt(record);
});
`;
  const save = `
ipcMain.on("save-markdown-file", (event, data) => {
  const saveRequestSession = data && data.saveRequestSession;
  const saveRequest = data && data.saveRequest;
  const sendSaveResult = () => {
    replyTarget.send("save-markdown-result", {
      ...outgoing,
      saveRequestSession,
      saveRequest,
    });
  };
  const sendSaveScopeFailure = () => {};
});
`;
  const tabs = `
const deletionTombstone = true;
function getActiveDocumentIdentity(tab, pageSession) {
  return documentIdentity(tab, pageSession);
}
function documentIdentity(tab, pageSession) {
  return {
    pageSession: "fixture",
    rendererGeneration: 1,
    tabId: 1,
    documentGeneration: 1,
    pathKey: "fixture",
  };
}
`;
  const renderer = `
function classifyDeletionDelivery() {}
function acknowledgeDeletionDelivery() {}
ipcRenderer.on("file-deleted", () => {
  classifyDeletionDelivery();
  acknowledgeDeletionDelivery();
});
ipcRenderer.send("file-deleted-ack", acknowledgement);
`;
  const acknowledgementListener = acknowledgement.slice(
    acknowledgement.indexOf("function acknowledgement"),
    acknowledgement.lastIndexOf("});"),
  );
  const full = () => deriveDeletionContracts({
    mainSource: delivery + acknowledgement + save,
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const assertPartial = (derived, group) => {
    const plan = createDeletionEvidencePlan(
      derived.capabilities,
      derived.acknowledgementContract,
    );
    return derived.status === "invalid" &&
      deletionEvidenceDisposition(derived, plan, group) === "invalid";
  };
  const supported = full();
  const whollyAbsent = deriveDeletionContracts();
  const directCompleteReloadOwner = deriveDeletionContracts({
    tabsSource: `
function getActiveDocumentIdentity() {
  return {
    pageSession: "fixture",
    rendererGeneration: 1,
    tabId: 1,
    documentGeneration: 1,
    pathKey: "fixture",
  };
}
`,
  });
  const delegatedCompleteReloadOwner = deriveDeletionContracts({
    tabsSource: tabs,
  });
  const delegatedMissingReloadOwner = deriveDeletionContracts({
    tabsSource: tabs.replace('pathKey: "fixture",', ""),
  });
  const unknownReloadOwnerHelper = deriveDeletionContracts({
    tabsSource: tabs.replace(
      "return documentIdentity(tab, pageSession);",
      "return unknownDocumentIdentity(tab, pageSession);",
    ),
  });
  const cyclicReloadOwnerHelpers = deriveDeletionContracts({
    tabsSource: `
function getActiveDocumentIdentity(tab, pageSession) {
  return documentIdentity(tab, pageSession);
}
function documentIdentity(tab, pageSession) {
  return getActiveDocumentIdentity(tab, pageSession);
}
`,
  });
  const unreachableOwnerFieldTokens = deriveDeletionContracts({
    tabsSource: `
function getActiveDocumentIdentity(tab, pageSession) {
  return incompleteDocumentIdentity(tab, pageSession);
}
function incompleteDocumentIdentity(tab, pageSession) {
  return {
    pageSession: "fixture",
    rendererGeneration: 1,
    tabId: 1,
    documentGeneration: 1,
  };
}
function unrelatedIdentityTokenDecoy() {
  return {
    pageSession: "fixture",
    rendererGeneration: 1,
    tabId: 1,
    documentGeneration: 1,
    pathKey: "fixture",
  };
}
`,
  });
  const partialProducerIdentity = deriveDeletionContracts({
    mainSource: (delivery + acknowledgement + save).replace(
      "rendererGeneration: 1,",
      "",
    ),
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const tombstoneOnly = deriveDeletionContracts({
    tabsSource: tabs,
  });
  const producerOnly = deriveDeletionContracts({
    mainSource: delivery + acknowledgement + save,
  });
  const partialSaveDeclaration = deriveDeletionContracts({
    mainSource: (delivery + acknowledgement + save).replace(
      "const saveRequest = data && data.saveRequest;",
      "",
    ),
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const partialSavePayload = deriveDeletionContracts({
    mainSource: (delivery + acknowledgement + save).replace(
      "saveRequest,",
      "request: saveRequest,",
    ),
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const partialReloadSupport = deriveDeletionContracts({
    mainSource: delivery + acknowledgement + save,
    rendererSource: renderer,
    tabsSource: tabs.replace('pathKey: "fixture",', ""),
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const partialSyncCatch = deriveDeletionContracts({
    mainSource: (delivery + acknowledgement + save).replace(
      "} catch (error) {}",
      "}",
    ),
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const missingDeliveryFunctionWithUnrelatedCatch = deriveDeletionContracts({
    mainSource: `
const deliverDeletionReport = (target) => target.send("file-deleted", {});
function unrelatedCaughtSend(target) {
  try {
    target.send("file-deleted", {});
  } catch (error) {}
}
`,
  });
  const partialSyncChannel = deriveDeletionContracts({
    mainSource: (delivery + acknowledgement + save).replaceAll(
      "file-deleted-ack",
      "removed-deletion-ack",
    ),
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const rendererAckOnly = deriveDeletionContracts({
    mainSource: delivery + save,
    rendererSource: renderer,
  });
  const mainAckOnly = deriveDeletionContracts({
    mainSource: delivery + acknowledgement + save,
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const missingRendererClassifier = deriveDeletionContracts({
    mainSource: delivery + acknowledgement + save,
    rendererSource: renderer.replace(
      "function classifyDeletionDelivery() {}",
      "function unrelatedDeletionClassifier() {}",
    ),
    tabsSource: tabs,
    runtimeAckListeners: [{
      source: acknowledgementListener,
      once: false,
      async: false,
    }],
  });
  const nestedFunctionTokensAfterBody = `
function getActiveDocumentIdentity() {
  const nested = () => \`nested \${\`${"${"}still nested${"}"}\`}\`;
  return { value: nested };
}
  function indentedLater() {
    return {
      pageSession: "fixture",
      rendererGeneration: 1,
      tabId: 1,
      documentGeneration: 1,
      pathKey: "fixture",
    };
  }
`;
  const tokensAfterFunction = deriveDeletionContracts({
    tabsSource: nestedFunctionTokensAfterBody,
  });
  const acknowledgementMutation = (listener) => deriveDeletionContracts({
    mainSource: delivery + acknowledgement + save,
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [listener],
  });
  const onceAcknowledgement = acknowledgementMutation({
    source: acknowledgementListener,
    once: true,
    async: false,
  });
  const duplicateAcknowledgement = deriveDeletionContracts({
    mainSource: delivery + acknowledgement + save,
    rendererSource: renderer,
    tabsSource: tabs,
    runtimeAckListeners: [
      { source: acknowledgementListener, once: false, async: false },
      { source: acknowledgementListener, once: false, async: false },
    ],
  });
  const asyncAcknowledgement = acknowledgementMutation({
    source: acknowledgementListener,
    once: false,
    async: true,
  });
  const missingAttemptClear = acknowledgementMutation({
    source: acknowledgementListener.replace(
      "clearDeletionDeliveryAttempt",
      "ignoredDeletionDeliveryAttempt",
    ),
    once: false,
    async: false,
  });
  const absentPlan = createDeletionEvidencePlan(
    whollyAbsent.capabilities,
    whollyAbsent.acknowledgementContract,
  );
  return supported.status === "supported" &&
    supported.acknowledgementContract === "valid" &&
    supported.capabilityContracts.reloadOwner === "supported" &&
    supported.prerequisite.reloadOwnerIdentity === true &&
    directCompleteReloadOwner.capabilityContracts.reloadOwner === "supported" &&
    delegatedCompleteReloadOwner.capabilityContracts.reloadOwner === "supported" &&
    [
      delegatedMissingReloadOwner,
      unknownReloadOwnerHelper,
      cyclicReloadOwnerHelpers,
      unreachableOwnerFieldTokens,
    ].every((derived) =>
      derived.status === "invalid" &&
      derived.capabilityContracts.reloadOwner === "invalid") &&
    whollyAbsent.status === "absent" &&
    Object.keys(absentPlan).every((group) =>
      deletionEvidenceDisposition(whollyAbsent, absentPlan, group) === "unavailable",
    ) &&
    assertPartial(partialProducerIdentity, "producerGeneration") &&
    assertPartial(tombstoneOnly, "rendererTombstoneCache") &&
    assertPartial(producerOnly, "rendererTombstoneCache") &&
    assertPartial(partialSaveDeclaration, "deletionSaveRefusal") &&
    assertPartial(partialSavePayload, "deletionSaveRefusal") &&
    assertPartial(partialReloadSupport, "reloadOwner") &&
    assertPartial(partialSyncCatch, "synchronousSendRecovery") &&
    missingDeliveryFunctionWithUnrelatedCatch.prerequisite.caughtSynchronousSend ===
      false &&
    missingDeliveryFunctionWithUnrelatedCatch.capabilityContracts
      .synchronousSendRecovery === "invalid" &&
    assertPartial(partialSyncChannel, "synchronousSendRecovery") &&
    assertPartial(rendererAckOnly, "acknowledgementLifecycle") &&
    assertPartial(mainAckOnly, "acknowledgementLifecycle") &&
    assertPartial(missingRendererClassifier, "acknowledgementLifecycle") &&
    missingRendererClassifier.acknowledgementContractViolations.includes(
      "renderer does not provide the deletion classifier",
    ) &&
    assertPartial(tokensAfterFunction, "reloadOwner") &&
    assertPartial(onceAcknowledgement, "acknowledgementLifecycle") &&
    assertPartial(duplicateAcknowledgement, "acknowledgementLifecycle") &&
    assertPartial(asyncAcknowledgement, "acknowledgementLifecycle") &&
    assertPartial(missingAttemptClear, "acknowledgementLifecycle");
}

async function deletionEvidencePlanSelfcheck() {
  const partial = createDeletionEvidencePlan({
    producer: true,
    tombstone: true,
    watcher: true,
    saveRefusal: false,
    ackIdentity: false,
    synchronousSend: false,
  }, "absent");
  const invalidAcknowledgement = createDeletionEvidencePlan({
    producer: true,
    tombstone: true,
    watcher: true,
    saveRefusal: true,
    ackIdentity: true,
    synchronousSend: true,
  }, "invalid");
  const partialRuns = [];
  for (const group of Object.keys(partial)) {
    await runDeletionEvidenceGroup(partial, group, async () => {
      partialRuns.push(group);
    });
  }
  const assertionRuns = [];
  const assertionSink = (...args) => assertionRuns.push(args);
  const assertionThunkRuns = {
    producer: 0,
    tombstone: 0,
    watcher: 0,
    acknowledgement: 0,
    acknowledgementDetail: 0,
  };
  const producerAssertion = scheduleDeletionAssertion(
    partial,
    ["producerGeneration"],
    assertionSink,
    "producer",
    () => {
      assertionThunkRuns.producer += 1;
      return true;
    },
    () => "producer-detail",
  );
  const tombstoneAssertion = scheduleDeletionAssertion(
    partial,
    ["rendererTombstoneCache"],
    assertionSink,
    "tombstone",
    () => {
      assertionThunkRuns.tombstone += 1;
      return true;
    },
    () => "tombstone-detail",
  );
  const watcherAssertion = scheduleDeletionAssertion(
    partial,
    ["watcherOwnership"],
    assertionSink,
    "watcher",
    () => {
      assertionThunkRuns.watcher += 1;
      return true;
    },
    () => "watcher-detail",
  );
  const acknowledgementAssertion = scheduleDeletionAssertion(
    partial,
    ["acknowledgementLifecycle"],
    assertionSink,
    "acknowledgement",
    () => {
      assertionThunkRuns.acknowledgement += 1;
      throw new Error("unscheduled acknowledgement evidence was evaluated");
    },
    () => {
      assertionThunkRuns.acknowledgementDetail += 1;
      throw new Error("unscheduled acknowledgement detail was evaluated");
    },
  );
  const unknownAssertion = scheduleDeletionAssertion(
    partial,
    ["does-not-exist"],
    assertionSink,
    "unknown",
    () => true,
    () => "unknown-detail",
  );
  return partial.producerGeneration.scheduled === true &&
    partial.rendererTombstoneCache.scheduled === true &&
    partial.watcherOwnership.scheduled === true &&
    partial.deletionSaveRefusal.scheduled === false &&
    partial.acknowledgementLifecycle.scheduled === false &&
    partial.synchronousSendRecovery.scheduled === false &&
    invalidAcknowledgement.producerGeneration.scheduled === true &&
    invalidAcknowledgement.acknowledgementLifecycle.scheduled === false &&
    invalidAcknowledgement.acknowledgementLifecycle.invalid === true &&
    invalidAcknowledgement.synchronousSendRecovery.scheduled === false &&
    JSON.stringify(partialRuns) === JSON.stringify([
      "producerGeneration",
      "watcherOwnership",
      "rendererTombstoneCache",
    ]) &&
    producerAssertion === true &&
    tombstoneAssertion === true &&
    watcherAssertion === true &&
    acknowledgementAssertion === false &&
    unknownAssertion === false &&
    assertionThunkRuns.producer === 1 &&
    assertionThunkRuns.tombstone === 1 &&
    assertionThunkRuns.watcher === 1 &&
    assertionThunkRuns.acknowledgement === 0 &&
    assertionThunkRuns.acknowledgementDetail === 0 &&
    JSON.stringify(assertionRuns) === JSON.stringify([
      ["producer", true, "producer-detail"],
      ["tombstone", true, "tombstone-detail"],
      ["watcher", true, "watcher-detail"],
    ]);
}

// Always restores, including on a throw: a capture left installed would silence
// the entire rest of the suite, which is the one failure this seam could cause.
async function captureChecks(body) {
  const captured = [];
  const previous = checkCapture;
  checkCapture = captured;
  try {
    await body();
  } finally {
    checkCapture = previous;
  }
  return captured;
}

let terminatingFromUncaughtException = false;
function uncaughtExceptionDetail(error) {
  try {
    return error && error.stack ? String(error.stack) : String(error);
  } catch {
    return "<exception could not be formatted>";
  }
}

function writeFatal(message) {
  try {
    // app.exit() can discard buffered console output, so diagnostics that
    // explain a fatal harness failure must reach stderr synchronously.
    fs.writeSync(2, message + "\n");
  } catch {
    // There is no recoverable output path after stderr itself has failed.
  }
}

// Electron otherwise presents uncaught main-process exceptions in a native
// modal, which blocks this unattended suite before its watchdog can run.
// Register before loading main.js, whose module initialization starts Electron
// lifecycle work and is therefore part of this suite's failure surface.
process.on("uncaughtException", (error) => {
  const detail = uncaughtExceptionDetail(error);
  if (!terminatingFromUncaughtException) {
    terminatingFromUncaughtException = true;
    results.push({ name: "uncaught main-process exception", ok: false, detail });
    const failed = results.filter((result) => !result.ok).length;
    writeFatal(
      `FAIL  uncaught main-process exception  -> ${detail}\n\n=== ${results.length - failed}/${results.length} passed ===`,
    );
  } else {
    writeFatal("FAIL  additional uncaught main-process exception  -> " + detail);
  }
  // test-visual-utils wraps app.exit() to sweep registered temp directories.
  // Do not run asynchronous teardown here: it could hide the original stack
  // behind the same blocked renderer condition that caused the exception.
  app.exit(1);
});

// Captured for the shutdown block below. main.js exports a narrow read/reset
// seam over the quit-approval state machine (F22): `state()` is how a test can
// assert that a rejected answer left the question OPEN rather than inferring it
// from an absence, and `reset()` is what returns the machine to its start state
// between scenarios - the authorization it grants is one-way within a session
// because a real shutdown ends with the process gone, and this suite has to
// drive a dozen of them in one process with the window still standing.
const { __shutdown } = require("../src/main.js");

// A COMPANION'S SCRATCH DIRECTORY BELONGS TO THE PARENT THAT SPAWNED IT.
// tempDir() removes its directories from process.on("exit") and from the
// app.exit wrapper in test-visual-utils, and NEITHER of those runs when the
// parent has to kill a companion: child.kill() on Windows is TerminateProcess,
// which unwinds nothing. That is where the leftover mdv-e2e-* trees full of
// portable-update/batch-*/{ack,lease,release} markers came from - one tree per
// killed portable companion, and the acknowledged batch directories inside
// them are the ones main.js deliberately does not delete because the real
// batch deletes itself. Assigning the companion a directory INSIDE the
// parent's registered one makes the parent's own sweep collect it however the
// companion ended, which is the only exit path either process can still act
// on. Residual, stated rather than implied: killing the PARENT still leaks,
// exactly as test-visual-utils documents.
// THE ASSIGNER OWNS THE REMOVAL, and that is the whole ownership rule. The
// companion neither creates nor deletes this tree: the parent creates it before
// the spawn and removes it after a CONFIRMED close, which is what lets the
// parent assert the removal did something - it saw the directory there, and it
// saw it gone. A companion that deleted it on its own happy path would make the
// parent's check vacuous ("already absent" reads exactly like "removed"), and
// would leave the parent unable to tell a clean run from a tree that some other
// process had swept out from under it. mkdirSync stays as a belt-and-braces for
// a companion driven by hand with F22_COMPANION_DIR set.
function canonicalExistingPath(value) {
  return fs.realpathSync.native(path.resolve(String(value)));
}

function canonicalPathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sameCanonicalPath(left, right) {
  try {
    const a = canonicalExistingPath(left);
    const b = canonicalExistingPath(right);
    return canonicalPathKey(a) === canonicalPathKey(b);
  } catch {
    return false;
  }
}

function isStrictCanonicalDescendant(candidate, ownerRoot) {
  try {
    const canonicalCandidate = canonicalExistingPath(candidate);
    const canonicalOwner = canonicalExistingPath(ownerRoot);
    const ownerKey = canonicalPathKey(canonicalOwner);
    const candidateKey = canonicalPathKey(canonicalCandidate);
    return candidateKey.startsWith(ownerKey + path.sep);
  } catch {
    return false;
  }
}

function validateCompanionScratch(scratchDir, ownerRoot) {
  if (typeof scratchDir !== "string" || scratchDir.length === 0) {
    return { ok: false, error: "scratch directory was not supplied" };
  }
  if (typeof ownerRoot !== "string" || ownerRoot.length === 0) {
    return { ok: false, error: "companion owner root was not supplied" };
  }
  try {
    const canonicalOwner = canonicalExistingPath(ownerRoot);
    const resolved = path.resolve(scratchDir);
    const canonicalScratch = fs.existsSync(resolved)
      ? canonicalExistingPath(resolved)
      : path.join(
          canonicalExistingPath(path.dirname(resolved)),
          path.basename(resolved),
        );
    const ownerKey = canonicalPathKey(canonicalOwner);
    const scratchKey = canonicalPathKey(canonicalScratch);
    if (
      !scratchKey.startsWith(ownerKey + path.sep)
    ) {
      return {
        ok: false,
        error: "scratch directory is not strictly beneath its owner root",
        ownerRoot: canonicalOwner,
        scratchDir: canonicalScratch,
      };
    }
    return { ok: true, ownerRoot: canonicalOwner, scratchDir: canonicalScratch };
  } catch (error) {
    return {
      ok: false,
      error: "scratch directory or owner root could not be canonicalized: " +
        String((error && error.code) || error),
    };
  }
}

function companionScratchDir() {
  const assigned = process.env.F22_COMPANION_DIR;
  if (!assigned) return tempDir("mdv-e2e-");
  const validated = validateCompanionScratch(
    assigned,
    process.env.F22_COMPANION_OWNER_ROOT,
  );
  if (!validated.ok) {
    throw new Error(
      "Rejected F22_COMPANION_DIR: " +
        JSON.stringify({ assigned, ownerRoot: process.env.F22_COMPANION_OWNER_ROOT || null, ...validated }),
    );
  }
  fs.mkdirSync(validated.scratchDir, { recursive: true });
  return validated.scratchDir;
}

// Whether this process may delete `dir` at the end of its run. A companion may
// not: the directory is its parent's. See companionScratchDir().
const ownsScratchDir = !process.env.F22_COMPANION_DIR;

const dir = companionScratchDir();

// A COMPANION MUST NOT BE STANDING IN THE PARENT'S PROFILE, and that is an
// assertion rather than a comment because the failure mode is silent in one
// direction and fatal in the other. test-userdata-isolation WIPES the profile
// it resolves on entry, so a companion that resolved to `test-tab-refresh`
// either killed itself against the running parent's open handles - measured,
// three times, as `EPERM` before a single assertion ran - or, on a machine
// where the wipe happened to succeed, would have deleted the profile the parent
// is still running out of. The parent's own name deliberately stays FIXED: it
// is what test-startup-perf.js's clean-start oracle depends on, so the
// companions get synthetic names and the parent keeps its real one.
function checkCompanionProfileIsolation(label) {
  const profile = global.__foliaTestUserData || "";
  const suite = profile ? path.basename(profile) : "";
  check(
    `the ${label} companion runs in its own userData profile, not the parent's`,
    suite.length > 0 &&
      suite !== "test-tab-refresh" &&
      suite === path.basename(process.argv[1] || "", ".js") &&
      !sameCanonicalPath(
        profile,
        path.resolve(path.dirname(profile), "test-tab-refresh"),
      ),
    JSON.stringify({ profile, suite, argv1: process.argv[1] || null }),
  );
}

const fileA = path.join(dir, "alpha.md");
const fileB = path.join(dir, "beta.md");
const fileM = path.join(dir, "diagram.mmd");
const jsA = JSON.stringify(fileA);
const jsB = JSON.stringify(fileB);
const jsM = JSON.stringify(fileM);

// This source and argument shape identify main.js's overlay probe exactly.
// The test window and shared test helpers also execute arbitrary renderer code;
// fault injection must never affect those calls.
const OVERLAY_PROBE_SOURCE =
  "typeof window.CustomTabs === 'object' && window.CustomTabs !== null";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a page-side condition rather than guessing with a fixed sleep, so the
// fast path stays fast and a slow machine does not produce a false failure.
async function waitForCondition(exec, expression, timeoutMs = 8000) {
  const started = Date.now();
  let last = false;
  while (Date.now() - started < timeoutMs) {
    last = await exec(expression);
    if (last) return true;
    await sleep(100);
  }
  return last === true;
}

// mtime has 1ms resolution but writes can land inside the same tick; bump the
// mtime explicitly so the change is unambiguously detectable.
function write(file, content) {
  fs.writeFileSync(file, content, "utf8");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);
}

// These two harness controls must be checked without provoking the native
// exception modal that would make the check itself interactive.
function verifyHarnessFaultBoundaries() {
  const source = fs.readFileSync(__filename, "utf8");
  const exactProbeInterceptions =
    (source.match(/code === OVERLAY_PROBE_SOURCE && arguments\.length === 1/g) ||
      []).length;
  const uncaughtStart = source.indexOf('process.on("uncaughtException",');
  const uncaughtEnd = source.indexOf("\n});", uncaughtStart);
  const uncaughtHandler =
    uncaughtStart >= 0 && uncaughtEnd > uncaughtStart
      ? source.slice(uncaughtStart, uncaughtEnd)
      : "";
  check(
    "controlled overlay probe injection is limited to the exact production probe shape",
    exactProbeInterceptions === 2,
    JSON.stringify({ exactProbeInterceptions }),
  );
  check(
    "uncaught harness exceptions terminate headlessly rather than recovering into a native modal",
    uncaughtStart >= 0 &&
      uncaughtStart < source.indexOf('require("../src/main.js")') &&
      uncaughtHandler.includes("writeFatal(") &&
      uncaughtHandler.includes("app.exit(1);"),
    JSON.stringify({
      uncaughtStart,
      loadedMainAt: source.indexOf('require("../src/main.js")'),
      terminalExit: uncaughtHandler.includes("app.exit(1);"),
    }),
  );
}

// ============================================
// Shutdown-protocol harness (F22)
// ============================================

// Poll a MAIN-process condition. The renderer-side waitForCondition above
// cannot be used for these: the subject is main.js's own state machine, and in
// the renderer-loss scenario there is no renderer left to ask.
async function waitUntil(predicate, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return false;
}

// Replaces a method and hands back the restore. The ORIGINAL PROPERTY
// DESCRIPTOR is what gets put back, not a re-assignment: `app.quit` lives on
// the prototype, so assigning over it installs an own property that a naive
// `app.quit = saved` would leave behind, permanently shadowing Electron's. If
// the method had no own descriptor the replacement is deleted instead, which
// re-exposes the prototype's.
function replaceMethod(target, name, impl) {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    value: impl,
    writable: true,
    configurable: true,
    enumerable: own ? own.enumerable : false,
  });
  return () => {
    if (own) Object.defineProperty(target, name, own);
    else delete target[name];
  };
}

// A stand-in for the cancellable event Electron passes to a `close` /
// `before-quit` listener. The listeners under test are ordinary emitter
// listeners, so emitting drives the REAL guard; what the fake records is the
// decision the guard made about the gesture.
function guardEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function sameDescriptor(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

// Stubs the three things an approved shutdown actually does - quit the app,
// close the window, put a modal on screen - so the suite survives to run the
// next scenario. Everything between the gesture and those three calls is the
// real product path.
function shutdownRig(win) {
  const appQuitDescriptor = Object.getOwnPropertyDescriptor(app, "quit");
  const rig = {
    quits: 0,
    closes: 0,
    dialogs: [],
    answer: 1,
    driveQuitLifecycle: false,
    quitEvents: [],
    appQuitDescriptor,
  };
  const undo = [
    replaceMethod(app, "quit", () => {
      rig.quits += 1;
      // The real window-all-closed listener calls app.quit(), which then
      // raises before-quit. Reproduce that lifecycle inside the non-terminal
      // stub rather than testing before-quit directly.
      if (rig.driveQuitLifecycle) {
        const event = guardEvent();
        app.emit("before-quit", event);
        rig.quitEvents.push(event);
      }
    }),
    replaceMethod(win, "close", () => {
      rig.closes += 1;
    }),
    replaceMethod(dialog, "showMessageBox", async (parent, options) => {
      // The reason is sampled WHILE the question is on screen; by the time the
      // answer is given the record has settled and is gone.
      rig.dialogs.push({
        options,
        pendingReason: __shutdown.state().pendingReason,
      });
      const answer =
        typeof rig.answer === "function" ? await rig.answer(options) : rig.answer;
      return { response: answer };
    }),
  ];
  rig.reset = () => {
    rig.quits = 0;
    rig.closes = 0;
    rig.dialogs.length = 0;
    rig.answer = 1;
    rig.driveQuitLifecycle = false;
    rig.quitEvents.length = 0;
  };
  rig.restore = () => {
    while (undo.length) undo.pop()();
  };
  return rig;
}

function portableInstallEvent(win) {
  return {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  };
}

// The private directory main.js created for one hand-off. Derived from the
// batch path the production code actually wrote rather than guessed, so a
// record that stops creating one fails here instead of silently checking a
// directory that never existed.
function portableBatchDir(batchFile) {
  return path.dirname(String(batchFile));
}

// The acknowledgement secret main.js embedded in the batch. Read out of the
// script on disk - the same bytes cmd.exe would run - so the test cannot
// accidentally agree with a token the product never wrote.
function portableHandoffToken(batchFile) {
  const script = fs.readFileSync(String(batchFile), "utf8");
  const match = script.match(/echo ([0-9a-f]{64})/);
  return match ? match[1] : null;
}

// Stands in for the batch's own `> "<dir>\ack" echo <token>`: the real file,
// in the real private directory, with the real bytes. Nothing about the
// installer is simulated because nothing about the installer is consulted -
// main.js quits on this marker and on nothing else, which is exactly what
// makes the hand-off testable without launching anything.
function writePortableMarker(batchFile, name, body) {
  fs.writeFileSync(
    path.join(portableBatchDir(batchFile), name),
    `${body}\r\n`,
    "utf8",
  );
}

async function runPortableUpdateScenarios(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const rig = shutdownRig(win);
  const childProcess = require("child_process");
  const updaterModule = require("electron-updater");
  const portableDir = path.join(dir, "portable-update");
  const installHandler = ipcMain.listeners("install-update")[0];
  const realMkdtemp = fs.mkdtempSync;
  // CAPTURED BEFORE THE FAULT INJECTION, because the liveness block below has
  // to run real processes and write real files while the product's own spawn
  // and writeFileSync are still stubbed for the scenarios around it. Calling
  // the stub there handed the liveness cases a fake EventEmitter that never
  // emits `close` and never has a `pid`, so the very first await in that block
  // - waiting for a throwaway process to die so its id is known-dead - could
  // not resolve and the companion hung until something killed it. Measured:
  // zero liveness assertions printed, ever, in any run.
  const realSpawn = childProcess.spawn;
  const realWriteFile = fs.writeFileSync;
  let restoreSpawn = null;
  let restoreMkdtemp = null;
  let restoreWrite = null;
  let spawnCalls = 0;
  let batchDirectories = 0;
  let batchWrites = 0;
  let releaseWrites = 0;
  let cancelWrites = 0;
  let childKills = 0;
  let gateWriteMode = null;
  const batchPaths = [];
  const releasePaths = [];
  const cancelPaths = [];
  const spawnInvocations = [];
  // The private directories whose hand-off was acknowledged. On that one path
  // the real batch deletes itself, so main.js deliberately does not - which
  // makes them the only directories allowed to survive the sweep at the end.
  const acknowledgedBatchDirs = new Set();
  let activeChild = null;
  let spawnMode = "park";

  const resetCounts = () => {
    spawnCalls = 0;
    batchDirectories = 0;
    batchWrites = 0;
    releaseWrites = 0;
    cancelWrites = 0;
    childKills = 0;
    gateWriteMode = null;
    batchPaths.length = 0;
    releasePaths.length = 0;
    cancelPaths.length = 0;
    spawnInvocations.length = 0;
    activeChild = null;
    rig.reset();
  };
  const startInstall = () =>
    exec(`window.ipcRenderer.send('install-update'); null;`);

  try {
    fs.mkdirSync(portableDir, { recursive: true });
    const rendererReady = await waitUntil(
      () => __shutdown.state().renderer === "ready",
      20000,
    );
    check(
      "the portable companion renderer is ready before it drives an install",
      rendererReady,
      JSON.stringify(__shutdown.state()),
    );
    if (!rendererReady) return;
    write(fileA, "# Portable update fixture\n");
    await exec(`
      (() => {
        const realConfirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = realConfirm;
        }
        const tab = window.CustomTabs.createTab(${jsA}, window.fs.readFileSync(${jsA}, 'utf8'));
        window.CustomTabs.switchToTab(tab.id);
        window.originalMarkdown = tab.originalContent;
        window.isEditMode = false;
        return window.CustomTabs.getTabs().length;
      })()
    `);
    // That fresh id was deliberately far ahead of the real sequence, so this
    // renderer would now treat every genuine request as stale. Replace it
    // rather than leaving the next block to inherit the poisoned counter.
    win.webContents.reload();
    await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
    // The no-download press initializes exactly the real lazy updater path;
    // update-downloaded is then its real public state transition.
    await startInstall();
    const updaterConfigured = await waitUntil(
      () =>
        updaterModule.autoUpdater.requestHeaders &&
        updaterModule.autoUpdater.requestHeaders["x-user-staging-id"] === "",
    );
    // THE ENVIRONMENT VARIABLE IS NOT THE EVIDENCE, and on its own it was
    // circular: this harness writes PORTABLE_EXECUTABLE_DIR itself when the
    // caller did not, so "the variable is set" could be true of a run that
    // main.js had nonetheless resolved as a normal installed build. What
    // decides the branch is main.js's own `isPortable`, and it is observable in
    // production state rather than through a seam invented for the test:
    // configureAutoUpdater() sets `autoInstallOnAppQuit = !isPortable`, so on
    // this branch it must be FALSE. The parent suite asserts the same field is
    // TRUE in a non-portable process, which is what makes this a discriminator
    // and not a constant.
    check(
      "the portable companion loaded the production portable updater branch",
      !!process.env.PORTABLE_EXECUTABLE_DIR &&
        typeof installHandler === "function" &&
        updaterConfigured &&
        // The branch itself, read off the real updater main.js configured.
        // This, not the environment variable, is what carries the assertion:
        // the variable can be written by this harness's own fallback, and
        // "the variable is set" would then be true of a run main.js had
        // nonetheless resolved as a normal installed build.
        updaterModule.autoUpdater.autoInstallOnAppQuit === false &&
        // Control: proves configureAutoUpdater ran at all, so the field above
        // is a decision rather than an electron-updater default.
        updaterModule.autoUpdater.autoDownload === false,
      JSON.stringify({
        portable: process.env.PORTABLE_EXECUTABLE_DIR,
        // Recorded, not asserted: true when the parent supplied it, false when
        // the fallback at the top of this file did. Either way the branch is
        // proven by the product state above.
        portableEnvWasInherited,
        installHandlers: ipcMain.listeners("install-update").length,
        updaterConfigured,
        autoInstallOnAppQuit: updaterModule.autoUpdater.autoInstallOnAppQuit,
        autoDownload: updaterModule.autoUpdater.autoDownload,
      }),
    );
    updaterModule.autoUpdater.emit("update-downloaded", {
      version: "9.9.9-portable",
      downloadedFile: fileA,
    });

    restoreMkdtemp = replaceMethod(fs, "mkdtempSync", (prefix) => {
      if (!String(prefix).includes("folia-update-")) {
        return realMkdtemp(prefix);
      }
      batchDirectories += 1;
      return realMkdtemp(path.join(portableDir, "batch-"));
    });
    const realWrite = fs.writeFileSync;
    restoreWrite = replaceMethod(fs, "writeFileSync", (target, ...rest) => {
      const name = path.basename(String(target));
      if (name === "update.bat") {
        batchWrites += 1;
        batchPaths.push(String(target));
      }
      if (name === "release") {
        releaseWrites += 1;
        releasePaths.push(String(target));
        if (gateWriteMode === "release-throw") {
          throw new Error("controlled portable release-gate write failure");
        }
      }
      if (name === "cancel") {
        cancelWrites += 1;
        cancelPaths.push(String(target));
      }
      return realWrite(target, ...rest);
    });
    restoreSpawn = replaceMethod(childProcess, "spawn", (command, args, options) => {
      spawnCalls += 1;
      spawnInvocations.push({ command, args, options });
      if (spawnMode === "reenter-then-throw") {
        // Run the second request while the first is parked at spawn. If the
        // latch moves below spawn, the first throw clears its late latch and
        // this re-entry's approved continuation creates a second hand-off.
        installHandler(portableInstallEvent(win));
        spawnMode = "park";
        throw new Error("controlled portable spawn refusal");
      }
      activeChild = new (require("events").EventEmitter)();
      activeChild.unrefCalls = 0;
      activeChild.unref = () => {
        activeChild.unrefCalls += 1;
      };
      activeChild.kill = () => {
        childKills += 1;
        return true;
      };
      return activeChild;
    });

    // Re-entrant request at the hand-off boundary: one private directory,
    // one batch, and one spawn attempt even when that first attempt refuses.
    __shutdown.reset();
    resetCounts();
    spawnMode = "reenter-then-throw";
    await startInstall();
    await waitUntil(() => spawnCalls === 1);
    await sleep(150);
    check(
      "a portable pre-spawn duplicate is latched before one temp batch hand-off",
      spawnCalls === 1 &&
        batchDirectories === 1 &&
        batchWrites === 1 &&
        __shutdown.state().authorized === false &&
        rig.quits === 0,
      JSON.stringify({
        spawnCalls,
        batchDirectories,
        batchWrites,
        state: __shutdown.state(),
        quits: rig.quits,
      }),
    );

    // Park the child before it reports success, issue a normal second press,
    // then release the public spawn event. This proves the in-flight latch
    // covers the real asynchronous gap rather than merely the call itself.
    __shutdown.reset();
    resetCounts();
    spawnMode = "park";
    await startInstall();
    const parked = await waitUntil(() => activeChild !== null);
    await startInstall();
    await sleep(150);
    const parkedState = __shutdown.state();
    check(
      "a parked portable child admits only one temp batch and spawn hand-off",
      parked &&
        spawnCalls === 1 &&
        batchDirectories === 1 &&
        batchWrites === 1 &&
        parkedState.authorized === false &&
        rig.quits === 0,
      JSON.stringify({
        parked,
        spawnCalls,
        batchDirectories,
        batchWrites,
        parkedState,
        quits: rig.quits,
      }),
    );
    activeChild.emit("spawn");
    const gateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    // THE QUIT IS NOT ALLOWED TO HAPPEN YET. Releasing the gate only tells the
    // batch it may proceed; the installer has not been observed starting, so a
    // quit here would be the original defect with an extra file in it.
    await sleep(200);
    const beforeAck = {
      quits: rig.quits,
      unrefCalls: activeChild.unrefCalls,
      authorized: __shutdown.state().authorized,
    };
    const handoffToken = portableHandoffToken(batchPaths[0]);
    const batchScript = fs.readFileSync(batchPaths[0], "utf8");
    acknowledgedBatchDirs.add(path.resolve(portableBatchDir(batchPaths[0])));
    writePortableMarker(batchPaths[0], "ack", handoffToken);
    const spawned = await waitUntil(() => rig.quits === 1, 10000);
    check(
      "a successful portable spawn commits once, unreferences once, and then quits",
      gateReleased &&
        spawned &&
        activeChild.unrefCalls === 1 &&
        releaseWrites === 1 &&
        releasePaths.length === 1 &&
        fs.existsSync(releasePaths[0]) &&
        cancelWrites === 0 &&
        spawnInvocations.length === 1 &&
        spawnInvocations[0].command === "cmd.exe" &&
        Array.isArray(spawnInvocations[0].args) &&
        spawnInvocations[0].args[0] === "/c" &&
        spawnInvocations[0].args[1] === batchPaths[0] &&
        spawnInvocations[0].options.detached === true &&
        spawnInvocations[0].options.stdio === "ignore" &&
        spawnInvocations[0].options.windowsHide === true &&
        rig.quits === 1 &&
        __shutdown.state().authorized === true,
      JSON.stringify({
        gateReleased,
        spawned,
        unrefCalls: activeChild.unrefCalls,
        releaseWrites,
        releasePaths,
        cancelWrites,
        batchPaths,
        spawnInvocations,
        quits: rig.quits,
        state: __shutdown.state(),
      }),
    );
    check(
      "a released portable gate does not quit until the installer hand-off is acknowledged",
      gateReleased &&
        beforeAck.quits === 0 &&
        beforeAck.unrefCalls === 0 &&
        beforeAck.authorized === false &&
        rig.quits === 1,
      JSON.stringify({ gateReleased, beforeAck, quits: rig.quits }),
    );
    // The batch is the other half of the hand-off and cannot be run here, so
    // its CONTRACT is asserted against the script that was actually written:
    // it must refuse a download that is no longer on disk, and it must not be
    // able to acknowledge anything before `start` has run.
    //
    // THE MARKER IS LOCATED BY ITS WHOLE WRITE, NOT BY THE TOKEN. The token is
    // echoed into THREE different markers - the orphan-liveness `failed`, the
    // post-`start` `ack`, and the `:failed` branch's `failed` - and the first
    // of those is emitted ABOVE `:install`. Searching for the bare `echo
    // <token>` therefore found the orphan write and reported the
    // acknowledgement as preceding the `start` it is gated on, which is the
    // opposite of what this asserts. Each marker's own redirection is unique,
    // so matching it names the write instead of guessing at it.
    const ackWrite = `> "${path.join(portableBatchDir(batchPaths[0]), "ack")}" echo ${handoffToken}`;
    const failedWrite = `> "${path.join(portableBatchDir(batchPaths[0]), "failed")}" echo ${handoffToken}`;
    const startIndex = batchScript.indexOf('start ""');
    const ackIndex = batchScript.indexOf(ackWrite);
    const failedIndex = batchScript.lastIndexOf(failedWrite);
    // Counted, because "the acknowledgement comes after start" is only worth
    // anything if there is exactly one of them: a second, earlier write would
    // satisfy an index comparison against the later one and still hand the app
    // an acknowledgement for an installer that never launched.
    const ackWrites = batchScript.split(ackWrite).length - 1;
    check(
      "the portable batch refuses a missing download and acknowledges only after starting it",
      typeof handoffToken === "string" &&
        handoffToken.length === 64 &&
        /if not exist "[^"]+" goto failed/.test(batchScript) &&
        /if errorlevel 1 goto failed/.test(batchScript) &&
        startIndex > 0 &&
        ackWrites === 1 &&
        ackIndex > startIndex &&
        failedIndex > ackIndex &&
        batchScript.includes("ver > nul"),
      JSON.stringify({
        handoffTokenLength: handoffToken && handoffToken.length,
        startIndex,
        ackIndex,
        ackWrites,
        failedIndex,
        script: batchScript,
      }),
    );

    // THE LEASE IS THE ANTI-PID-REUSE HALF OF THE LIVENESS TEST, and its shape
    // is a contract with the batch: the app writes the file, and the batch
    // reads only the SIZE cmd reports for it. A lease whose CONTENT was parsed
    // would be a script-injection surface in a directory the batch already
    // trusts, so "%%~zF and nothing else" is asserted here rather than assumed.
    const leaseFile = path.join(portableBatchDir(batchPaths[0]), "lease");
    // MATCHED ON THE LEASE'S OWN PATH, NOT ON THE WORD. `release` contains
    // `lease`, so a substring search matched `:wait_for_release` - the first
    // line of the wait loop - and this assertion was measuring a label instead
    // of the read it names. The quoted full path cannot collide: the release
    // marker is `<dir>\release`, which does not contain `<dir>\lease`.
    // Requiring exactly ONE such line is the other half of the contract - the
    // batch reads the lease and never writes it, so a second reference would
    // mean the script touches a file only the app is allowed to touch.
    const leaseScriptLines = batchScript.split(/\r?\n/);
    const leaseReferences = leaseScriptLines.filter((line) =>
      line.includes(`"${leaseFile}"`),
    );
    const leaseReadLine = leaseReferences.length === 1 ? leaseReferences[0] : null;
    // THE WHOLE COMMAND, BYTE FOR BYTE, against this batch's own lease path. A
    // shape regex over `[^"]+lease` accepts a line that reads some OTHER
    // lease-suffixed path, which in a directory the batch already trusts is
    // precisely the substitution this assertion exists to rule out. Anchoring
    // on the exact command also pins the half of the contract that carries the
    // security argument: `for %%F ... %%~zF` is cmd's own size metadata, so the
    // file's bytes are never re-read as script.
    const expectedLeaseRead = `for %%F in ("${leaseFile}") do set "FOLIA_HB=%%~zF"`;
    const staleThreshold = /GEQ (\d+) goto orphaned/.exec(batchScript);
    // The PID half of the same liveness pair, asserted here as a shape and
    // proven to WORK by the live dead-parent case below. The two `find` and
    // `PID eq` numbers must be the SAME pid - a mismatch would make the check
    // interrogate one process and test the answer for another - which is what
    // the backreference pins.
    const parentPidCheck = leaseScriptLines.some((line) =>
      /^tasklist \/FI "PID eq (\d+)" \/NH 2>nul \| find "\1" >nul$/.test(
        line.trim(),
      ),
    );
    check(
      "the portable batch measures its parent's lease by size and gives up only after a bounded stall",
      fs.existsSync(leaseFile) &&
        typeof leaseReadLine === "string" &&
        // Read through cmd's own metadata: the file's bytes never become code.
        leaseReadLine.trim() === expectedLeaseRead &&
        parentPidCheck &&
        batchScript.includes("if errorlevel 1 goto orphaned") &&
        !!staleThreshold &&
        // Bounded, and generous enough that a briefly blocked main process is
        // not mistaken for a dead one.
        Number(staleThreshold[1]) >= 10 &&
        Number(staleThreshold[1]) <= 120 &&
        batchScript.includes("set /a FOLIA_MISS=FOLIA_MISS+1"),
      JSON.stringify({
        leaseExists: fs.existsSync(leaseFile),
        leaseReferences,
        leaseReadLine,
        expectedLeaseRead,
        parentPidCheck,
        staleThreshold: staleThreshold && staleThreshold[1],
      }),
    );

    // A FORGED OR STALE MARKER IS NOT AN ACKNOWLEDGEMENT. The private
    // directory is unpredictable, but "unpredictable" is not "unreachable", and
    // the one claim this path quits on must not be plantable by any local
    // process that finds it. An `ack` with the wrong body has to leave the app
    // exactly as unauthorised as no `ack` at all - which the timeout below then
    // resolves fail-closed.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    await startInstall();
    const forgedChildParked = await waitUntil(() => activeChild !== null);
    const forgedChild = activeChild;
    if (forgedChild) forgedChild.emit("spawn");
    const forgedGateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    writePortableMarker(batchPaths[0], "ack", "0".repeat(64));
    await sleep(500);
    const afterForgedAck = {
      quits: rig.quits,
      cancelWrites,
      authorized: __shutdown.state().authorized,
    };
    const forgedTimedOut = await waitUntil(
      () => cancelWrites === 1 && childKills === 1,
      15000,
    );
    if (forgedChild) forgedChild.emit("close", 1);
    await sleep(200);
    // THE LATCH MUST NOT CLEAR HERE. The gate was already open, so the batch
    // may have run `start` and merely been slow to acknowledge; an expired
    // deadline cannot tell that apart from an installer that never began.
    // Clearing would let a second Install press launch a second installer over
    // the first, which is why this hand-off stays latched for the session.
    const forgedLatchHeld = __shutdown.state().updateInstallStarted === true;
    const forgedDirRemoved = await waitUntil(
      () => !fs.existsSync(portableBatchDir(batchPaths[0])),
      10000,
    );
    check(
      "a forged portable acknowledgement never quits and the hand-off times out fail-closed",
      forgedChildParked &&
        forgedGateReleased &&
        afterForgedAck.quits === 0 &&
        afterForgedAck.cancelWrites === 0 &&
        afterForgedAck.authorized === false &&
        forgedTimedOut &&
        rig.quits === 0 &&
        forgedChild &&
        forgedChild.unrefCalls === 0 &&
        forgedLatchHeld &&
        forgedDirRemoved,
      JSON.stringify({
        forgedChildParked,
        forgedGateReleased,
        afterForgedAck,
        forgedTimedOut,
        quits: rig.quits,
        unrefCalls: forgedChild && forgedChild.unrefCalls,
        forgedLatchHeld,
        forgedDirRemoved,
      }),
    );

    // The batch's own report that it could not start the installer - a swept
    // download, a refused `start`. It carries the same secret, so it is
    // believed immediately rather than waited out, and the app stays up.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    await startInstall();
    const failedChildParked = await waitUntil(() => activeChild !== null);
    const failedChild = activeChild;
    if (failedChild) failedChild.emit("spawn");
    const failedGateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    writePortableMarker(
      batchPaths[0],
      "failed",
      portableHandoffToken(batchPaths[0]),
    );
    const reportedFailure = await waitUntil(
      () => cancelWrites === 1 && childKills === 1,
      10000,
    );
    if (failedChild) failedChild.emit("close", 1);
    const failedLatchReleased = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const failedDirRemoved = await waitUntil(
      () => !fs.existsSync(portableBatchDir(batchPaths[0])),
      10000,
    );
    check(
      "a portable batch that reports it could not start the installer leaves the app running",
      failedChildParked &&
        failedGateReleased &&
        reportedFailure &&
        rig.quits === 0 &&
        failedChild &&
        failedChild.unrefCalls === 0 &&
        __shutdown.state().authorized === false &&
        failedLatchReleased &&
        failedDirRemoved,
      JSON.stringify({
        failedChildParked,
        failedGateReleased,
        reportedFailure,
        quits: rig.quits,
        unrefCalls: failedChild && failedChild.unrefCalls,
        state: __shutdown.state(),
        failedLatchReleased,
        failedDirRemoved,
      }),
    );

    // A MARKER THAT EXISTS BEFORE THE GATE DOES WAS NOT WRITTEN BY THE BATCH.
    // The batch cannot reach either marker until it sees the release file, so
    // anything already sitting in the private directory was put there by
    // something else - and believing it would quit the app for an installer
    // that has not started. The directory is minted fresh per attempt, so this
    // can never be the app's own residue.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const plantedChildParked = await waitUntil(() => activeChild !== null, 10000);
    const plantedChild = activeChild;
    if (plantedChildParked) {
      // Planted while the child is parked - before the gate is released, and
      // carrying the hand-off's real secret, so only the ORDERING can refuse
      // it. A token check alone would accept this.
      writePortableMarker(
        batchPaths[0],
        "ack",
        portableHandoffToken(batchPaths[0]),
      );
    }
    const plantedBatchDir = portableBatchDir(batchPaths[0]);
    if (plantedChild) plantedChild.emit("spawn");
    const plantedRefused = await waitUntil(
      () => cancelWrites === 1 && childKills === 1,
      10000,
    );
    await sleep(200);
    if (plantedChild) plantedChild.emit("close", 1);
    const plantedLatchReleased = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const plantedDirRemoved = await waitUntil(
      () => !fs.existsSync(plantedBatchDir),
      10000,
    );
    check(
      "a portable acknowledgement planted before the gate was released is refused",
      plantedChildParked &&
        plantedRefused &&
        releaseWrites === 0 &&
        rig.quits === 0 &&
        plantedChild &&
        plantedChild.unrefCalls === 0 &&
        __shutdown.state().authorized === false &&
        plantedLatchReleased &&
        plantedDirRemoved,
      JSON.stringify({
        plantedChildParked,
        plantedRefused,
        releaseWrites,
        cancelWrites,
        childKills,
        quits: rig.quits,
        unrefCalls: plantedChild && plantedChild.unrefCalls,
        state: __shutdown.state(),
        plantedLatchReleased,
        plantedDirRemoved,
      }),
    );

    // AN ACKNOWLEDGEMENT IS NOT CONSENT TO QUIT WHATEVER IS ON SCREEN NOW.
    // The installer is running by this point and cannot be recalled, but the
    // answer that authorised the quit was given about the document as it stood
    // when the gate was released. If a question is already open when the
    // acknowledgement lands, that answer no longer covers what the reader is
    // looking at - so the quit is re-asked rather than taken, exactly as the
    // installed updater's public commit boundary does.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const staleAckChildParked = await waitUntil(() => activeChild !== null, 10000);
    const staleAckChild = activeChild;
    if (staleAckChild) staleAckChild.emit("spawn");
    const staleAckGateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    const exactPostReleaseEdit =
      "# Portable update fixture\nPORTABLE_POST_RELEASE_EDIT\n";
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = ${JSON.stringify(exactPostReleaseEdit)};
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return tab.content;
      })()
    `);
    let releaseStaleAckClose;
    rig.answer = () =>
      new Promise((resolve) => {
        releaseStaleAckClose = resolve;
      });
    const closeDuringHandoff = guardEvent();
    win.emit("close", closeDuringHandoff);
    const closeQuestionOpen = await waitUntil(() => rig.dialogs.length === 1, 10000);
    if (staleAckGateReleased) {
      acknowledgedBatchDirs.add(path.resolve(portableBatchDir(batchPaths[0])));
      writePortableMarker(
        batchPaths[0],
        "ack",
        portableHandoffToken(batchPaths[0]),
      );
    }
    await sleep(400);
    const quitsWhileQuestionOpen = rig.quits;
    rig.answer = 1;
    if (releaseStaleAckClose) releaseStaleAckClose(1);
    const reAskedAfterAck = await waitUntil(
      () => rig.dialogs.length === 2 && __shutdown.state().pendingId === 0,
      10000,
    );
    const preservedPostReleaseEdit = await exec(
      `window.CustomTabs.getActiveTab().content`,
    );
    check(
      "an acknowledgement landing behind an open question re-asks instead of quitting on stale consent",
      staleAckChildParked &&
        staleAckGateReleased &&
        closeQuestionOpen &&
        closeDuringHandoff.prevented === true &&
        quitsWhileQuestionOpen === 0 &&
        reAskedAfterAck &&
        rig.dialogs[0].pendingReason === "window-close" &&
        rig.dialogs[1].pendingReason === "update-install" &&
        rig.quits === 0 &&
        preservedPostReleaseEdit === exactPostReleaseEdit &&
        __shutdown.state().authorized === false,
      JSON.stringify({
        staleAckChildParked,
        staleAckGateReleased,
        closeQuestionOpen,
        prevented: closeDuringHandoff.prevented,
        quitsWhileQuestionOpen,
        reAskedAfterAck,
        dialogs: rig.dialogs.map((dialog) => dialog.pendingReason),
        quits: rig.quits,
        preservedPostReleaseEdit,
        state: __shutdown.state(),
      }),
    );
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);

    // THE EDIT MADE WHILE THE INSTALLER WAS STARTING. This is the window a
    // generation check structurally cannot see: no navigation, no second
    // question, the same document throughout - just text typed between the gate
    // opening and the acknowledgement coming back. The commit has to ASK,
    // because the answer that opened the gate was about a document that no
    // longer exists. Cancel keeps the edit, does not quit, and leaves the
    // attempt latched: the installer is already running and must not be joined
    // by a second one.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const editRaceChildParked = await waitUntil(() => activeChild !== null, 10000);
    const editRaceChild = activeChild;
    if (editRaceChild) editRaceChild.emit("spawn");
    const editRaceGateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    const dialogsBeforeEditRace = rig.dialogs.length;
    const exactPostGateEdit =
      "# Portable update fixture\nPORTABLE_POST_GATE_EDIT\n";
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = ${JSON.stringify(exactPostGateEdit)};
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return tab.content;
      })()
    `);
    if (editRaceGateReleased) {
      acknowledgedBatchDirs.add(path.resolve(portableBatchDir(batchPaths[0])));
      writePortableMarker(
        batchPaths[0],
        "ack",
        portableHandoffToken(batchPaths[0]),
      );
    }
    const editRaceAsked = await waitUntil(() => rig.dialogs.length === 1, 10000);
    await sleep(300);
    const preservedPostGateEdit = await exec(
      `window.CustomTabs.getActiveTab().content`,
    );
    const editRaceState = __shutdown.state();
    check(
      "an edit made after the portable gate opened is asked about before the acknowledged hand-off quits",
      editRaceChildParked &&
        editRaceGateReleased &&
        dialogsBeforeEditRace === 0 &&
        editRaceAsked &&
        rig.dialogs[0].pendingReason === "update-install" &&
        /alpha\.md/.test(String(rig.dialogs[0].options.message)) &&
        rig.quits === 0 &&
        preservedPostGateEdit === exactPostGateEdit &&
        editRaceState.authorized === false &&
        // Declining the quit is not cancelling the hand-off: the installer has
        // already started, so no cancel gate is written, the child is not
        // killed, and the attempt stays latched against a second launch.
        cancelWrites === 0 &&
        childKills === 0 &&
        editRaceChild &&
        editRaceChild.unrefCalls === 1 &&
        editRaceState.updateInstallStarted === true,
      JSON.stringify({
        editRaceChildParked,
        editRaceGateReleased,
        dialogsBeforeEditRace,
        editRaceAsked,
        dialog: rig.dialogs[0],
        quits: rig.quits,
        preservedPostGateEdit,
        cancelWrites,
        childKills,
        unrefCalls: editRaceChild && editRaceChild.unrefCalls,
        state: editRaceState,
      }),
    );

    // A LATCH IS ONLY REAL IF IT REFUSES SOMETHING. Reading the flag and then
    // resetting the state machine proves the flag's VALUE, not its EFFECT: a
    // regression that cleared it on a declined confirmation, or that let a
    // press past it, would satisfy the assertion above and still launch a
    // second installer over the one this hand-off started. So press Install
    // again, for real, while that installer is running - and require the press
    // to change nothing whatsoever.
    //
    // `lastRequestId` is the sharpest single witness: a refusal that happens
    // before `requestShutdown` leaves the sequence untouched, while a press
    // that got through would mint a request and - the document being dirty -
    // put a second dialog on screen.
    const observePortableState = () => ({
      spawnCalls,
      batchDirectories,
      batchWrites,
      releaseWrites,
      cancelWrites,
      childKills,
      dialogs: rig.dialogs.length,
      quits: rig.quits,
      unrefCalls: editRaceChild ? editRaceChild.unrefCalls : -1,
      lastRequestId: __shutdown.state().lastRequestId,
    });
    const beforeDuplicatePress = observePortableState();
    await startInstall();
    await sleep(400);
    const afterDuplicatePress = observePortableState();
    const contentAfterDuplicatePress = await exec(
      `window.CustomTabs.getActiveTab().content`,
    );
    check(
      "a second install press while an acknowledged portable installer is running is refused outright",
      JSON.stringify(beforeDuplicatePress) ===
        JSON.stringify(afterDuplicatePress) &&
        __shutdown.state().updateInstallStarted === true &&
        contentAfterDuplicatePress === exactPostGateEdit,
      JSON.stringify({
        beforeDuplicatePress,
        afterDuplicatePress,
        contentAfterDuplicatePress,
        state: __shutdown.state(),
      }),
    );

    // THE RETRY BOUNDARY IS THE PROCESS, NOT THE CHILD. cmd.exe finishing its
    // settle wait and exiting is an ordinary production event, and it must not
    // be mistaken for permission to try again: the installer it started is
    // still running. Only the CANCEL path registers a close handler that
    // clears the latch, and an acknowledged hand-off never takes that path -
    // so the boundary has to survive the one event most likely to erode it.
    //
    // Driven through a real child event rather than through
    // `__shutdown.reset()`, which is a test seam and not something the product
    // ever does.
    if (editRaceChild) editRaceChild.emit("close", 0);
    await sleep(300);
    const afterChildExit = observePortableState();
    const latchAfterChildExit = __shutdown.state().updateInstallStarted;
    await startInstall();
    await sleep(400);
    const afterPostExitPress = observePortableState();
    check(
      "an acknowledged portable hand-off keeps its retry boundary after the child process exits",
      latchAfterChildExit === true &&
        JSON.stringify(afterChildExit) === JSON.stringify(afterPostExitPress) &&
        afterChildExit.spawnCalls === 1 &&
        afterChildExit.batchDirectories === 1 &&
        __shutdown.state().updateInstallStarted === true,
      JSON.stringify({
        latchAfterChildExit,
        afterChildExit,
        afterPostExitPress,
        state: __shutdown.state(),
      }),
    );

    // The same race, approved. The confirmation is a QUIT and nothing else: no
    // second batch, no second gate, no second child - one installer, launched
    // once, and exactly one quit behind the answer that agreed to it.
    //
    // The document is put back first: the decline above deliberately left it
    // dirty, and an install press against a dirty document raises its OWN
    // approval dialog, which would make the dialog count below ambiguous
    // between the press and the confirmation this scenario is about.
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    __shutdown.reset();
    resetCounts();
    rig.answer = 0;
    await startInstall();
    const approvedRaceChildParked = await waitUntil(
      () => activeChild !== null,
      10000,
    );
    const approvedRaceChild = activeChild;
    if (approvedRaceChild) approvedRaceChild.emit("spawn");
    const approvedRaceGateReleased = await waitUntil(
      () => releaseWrites === 1,
      10000,
    );
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = ${JSON.stringify(exactPostGateEdit)} + 'APPROVED\\n';
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return tab.content;
      })()
    `);
    if (approvedRaceGateReleased) {
      acknowledgedBatchDirs.add(path.resolve(portableBatchDir(batchPaths[0])));
      writePortableMarker(
        batchPaths[0],
        "ack",
        portableHandoffToken(batchPaths[0]),
      );
    }
    const approvedRaceQuit = await waitUntil(() => rig.quits === 1, 10000);
    await sleep(300);
    check(
      "approving the confirmation after an acknowledged portable hand-off quits once and starts nothing further",
      approvedRaceChildParked &&
        approvedRaceGateReleased &&
        approvedRaceQuit &&
        rig.dialogs.length === 1 &&
        rig.dialogs[0].pendingReason === "update-install" &&
        rig.quits === 1 &&
        spawnCalls === 1 &&
        batchDirectories === 1 &&
        batchWrites === 1 &&
        releaseWrites === 1 &&
        cancelWrites === 0 &&
        approvedRaceChild &&
        approvedRaceChild.unrefCalls === 1 &&
        __shutdown.state().authorized === true,
      JSON.stringify({
        approvedRaceChildParked,
        approvedRaceGateReleased,
        approvedRaceQuit,
        dialogs: rig.dialogs.map((dialog) => dialog.pendingReason),
        quits: rig.quits,
        spawnCalls,
        batchDirectories,
        batchWrites,
        releaseWrites,
        cancelWrites,
        unrefCalls: approvedRaceChild && approvedRaceChild.unrefCalls,
        state: __shutdown.state(),
      }),
    );
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);

    // THE EDIT THAT ARRIVES IN THE SPAWN GAP. The install approval was given
    // against a clean document; spawning is asynchronous, and text typed while
    // the child was starting belongs to a document nobody has been asked about.
    // The generation has not changed - it is the same document - so only asking
    // again can find it. Cancel must keep the edit, release no gate, and leave
    // no authorization behind.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return tab.content;
      })()
    `);
    await startInstall();
    const gapChildParked = await waitUntil(() => activeChild !== null, 10000);
    const gapChild = activeChild;
    const exactGapEdit = "# Portable update fixture\nPORTABLE_SPAWN_GAP_EDIT\n";
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = ${JSON.stringify(exactGapEdit)};
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return tab.content;
      })()
    `);
    if (gapChild) gapChild.emit("spawn");
    const gapAsked = await waitUntil(() => rig.dialogs.length === 1, 10000);
    const gapCancelled = await waitUntil(
      () => cancelWrites === 1 && childKills === 1,
      10000,
    );
    const preservedGapEdit = await exec(
      `window.CustomTabs.getActiveTab().content`,
    );
    if (gapChild) gapChild.emit("close", 1);
    const gapLatchReleased = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const gapDirRemoved = await waitUntil(
      () => !fs.existsSync(portableBatchDir(batchPaths[0])),
      10000,
    );
    check(
      "a portable commit re-asks about an edit made after the install approval and Cancel keeps it",
      gapChildParked &&
        gapAsked &&
        rig.dialogs[0].pendingReason === "update-install" &&
        /alpha\.md/.test(String(rig.dialogs[0].options.message)) &&
        gapCancelled &&
        releaseWrites === 0 &&
        rig.quits === 0 &&
        preservedGapEdit === exactGapEdit &&
        __shutdown.state().authorized === false &&
        gapLatchReleased &&
        gapDirRemoved,
      JSON.stringify({
        gapChildParked,
        gapAsked,
        dialog: rig.dialogs[0],
        gapCancelled,
        releaseWrites,
        cancelWrites,
        childKills,
        quits: rig.quits,
        preservedGapEdit,
        state: __shutdown.state(),
        gapLatchReleased,
        gapDirRemoved,
      }),
    );
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);

    // A dirty portable install is held at the same approval boundary as every
    // other shutdown. No private batch/gate exists while that question is on
    // screen, and Cancel therefore cannot accidentally release an installer.
    __shutdown.reset();
    resetCounts();
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent + '\\nPORTABLE_HELD_APPROVAL_EDIT\\n';
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return tab.filename;
      })()
    `);
    let releasePortableApproval;
    rig.answer = () =>
      new Promise((resolve) => {
        releasePortableApproval = resolve;
      });
    await startInstall();
    const portableApprovalHeld = await waitUntil(() => rig.dialogs.length === 1);
    const gatesWhileHeld = {
      batchDirectories,
      batchWrites,
      spawnCalls,
      releaseWrites,
      cancelWrites,
    };
    rig.answer = 1;
    if (releasePortableApproval) releasePortableApproval(1);
    const portableApprovalCancelled = await waitUntil(
      () => __shutdown.state().pendingId === 0,
    );
    check(
      "a portable install held for approval creates no release gate and Cancel starts no child",
      portableApprovalHeld &&
        portableApprovalCancelled &&
        gatesWhileHeld.batchDirectories === 0 &&
        gatesWhileHeld.batchWrites === 0 &&
        gatesWhileHeld.spawnCalls === 0 &&
        gatesWhileHeld.releaseWrites === 0 &&
        gatesWhileHeld.cancelWrites === 0 &&
        __shutdown.state().authorized === false,
      JSON.stringify({
        portableApprovalHeld,
        portableApprovalCancelled,
        gatesWhileHeld,
        state: __shutdown.state(),
      }),
    );

    // Once the child is parked, a committed document replacement invalidates
    // the approval that launched it. The child receives only a cancel gate;
    // its close event, not merely kill(), releases the retry latch.
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const childParkedBeforeReplacement = await waitUntil(() => activeChild !== null);
    const parkedChild = activeChild;
    const parkedGeneration = __shutdown.state().rendererGeneration;
    win.webContents.reload();
    const replacementDocumentReady = await waitUntil(
      () =>
        __shutdown.state().renderer === "ready" &&
        __shutdown.state().rendererGeneration > parkedGeneration,
      20000,
    );
    if (parkedChild) parkedChild.emit("spawn");
    const cancelledParkedChild = await waitUntil(
      () => cancelWrites === 1 && childKills === 1,
      10000,
    );
    const latchBeforeChildClose = __shutdown.state().updateInstallStarted;
    // Sampled while the child is still open: the private directory is removed
    // as part of the close below, so a check made afterwards could not tell a
    // cancel gate that was written from one that never was.
    const cancelGateWritten =
      cancelPaths.length === 1 && fs.existsSync(cancelPaths[0]);
    const cancelledBatchDir = portableBatchDir(batchPaths[0]);
    if (parkedChild) parkedChild.emit("close", 1);
    const latchReleasedAfterChildClose = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const cancelledDirRemoved = await waitUntil(
      () => !fs.existsSync(cancelledBatchDir),
      10000,
    );
    const cancelledSnapshot = {
      releaseWrites,
      cancelWrites,
      childKills,
      releasePaths: releasePaths.slice(),
      cancelPaths: cancelPaths.slice(),
      cancelGateWritten,
      latchBeforeChildClose,
      latchReleasedAfterChildClose,
      cancelledDirRemoved,
    };
    // A retry is only meaningful after the cancelled child has closed. Give
    // it a separate batch and let its observed spawn event complete normally,
    // acknowledgement included.
    resetCounts();
    rig.reset();
    await startInstall();
    const retryChildParked = await waitUntil(() => activeChild !== null);
    const retryChild = activeChild;
    if (retryChild) retryChild.emit("spawn");
    const retryGateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    if (retryGateReleased) {
      acknowledgedBatchDirs.add(path.resolve(portableBatchDir(batchPaths[0])));
      writePortableMarker(
        batchPaths[0],
        "ack",
        portableHandoffToken(batchPaths[0]),
      );
    }
    const retrySucceeded = await waitUntil(() => rig.quits === 1, 10000);
    check(
      "a replaced document cancels a parked portable child before latch reset and permits one later retry",
      childParkedBeforeReplacement &&
        replacementDocumentReady &&
        cancelledParkedChild &&
      cancelledSnapshot.releaseWrites === 0 &&
      cancelledSnapshot.cancelWrites === 1 &&
      cancelledSnapshot.childKills === 1 &&
      cancelledSnapshot.cancelPaths.length === 1 &&
      cancelledSnapshot.cancelGateWritten &&
      cancelledSnapshot.latchBeforeChildClose === true &&
      cancelledSnapshot.latchReleasedAfterChildClose &&
      cancelledSnapshot.cancelledDirRemoved &&
        retryChildParked &&
        retryGateReleased &&
        retrySucceeded &&
        retryChild &&
        retryChild.unrefCalls === 1 &&
        spawnCalls === 1 &&
        batchDirectories === 1 &&
        batchWrites === 1,
      JSON.stringify({
        childParkedBeforeReplacement,
        replacementDocumentReady,
        cancelledParkedChild,
        cancelled: cancelledSnapshot,
        retry: {
          retryChildParked,
          retrySucceeded,
          releasePaths,
          cancelPaths,
          spawnCalls,
          batchDirectories,
          batchWrites,
          unrefCalls: retryChild && retryChild.unrefCalls,
        },
      }),
    );

    // A batch that has already died - killed from Task Manager, swept by
    // security software, crashed - can never emit another close. Waiting for
    // one that cannot arrive strands the in-flight latch, so no later Install
    // press can start anything, and leaves the private directory on disk.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const deadChildParked = await waitUntil(() => activeChild !== null, 10000);
    const deadChild = activeChild;
    const deadBatchDir = portableBatchDir(batchPaths[0]);
    if (deadChild) {
      // Node types exitCode only once a child has ended; while it runs, both
      // exitCode and signalCode are null. The parked stub is otherwise
      // indistinguishable from a live child, which is the point.
      deadChild.exitCode = 1;
      deadChild.emit("close", 1);
    }
    const deadGeneration = __shutdown.state().rendererGeneration;
    win.webContents.reload();
    const deadReplacementReady = await waitUntil(
      () =>
        __shutdown.state().renderer === "ready" &&
        __shutdown.state().rendererGeneration > deadGeneration,
      20000,
    );
    if (deadChild) deadChild.emit("spawn");
    const deadLatchReleased = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const deadDirRemoved = await waitUntil(
      () => !fs.existsSync(deadBatchDir),
      10000,
    );
    check(
      "a portable child that has already exited releases its latch without waiting for a close it cannot send",
      deadChildParked &&
        deadReplacementReady &&
        cancelWrites === 1 &&
        deadLatchReleased &&
        deadDirRemoved &&
        rig.quits === 0 &&
        __shutdown.state().authorized === false,
      JSON.stringify({
        deadChildParked,
        deadReplacementReady,
        cancelWrites,
        childKills,
        deadLatchReleased,
        deadDirRemoved,
        quits: rig.quits,
        state: __shutdown.state(),
      }),
    );

    // ============================================================
    // Token non-reuse, replay refusal, and the sender gate
    // ============================================================
    //
    // A TOKEN THAT IS THE SAME EVERY TIME IS NOT A SECRET, and a token check
    // that only measures LENGTH would pass a hard-coded one. Three attempts,
    // three tokens, and the previous attempt's acknowledgement replayed against
    // a later one - which must be refused for as long as it is offered.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const tokenAttemptA = await waitUntil(() => activeChild !== null, 10000);
    const childA = activeChild;
    const tokenA = portableHandoffToken(batchPaths[0]);
    const dirA = portableBatchDir(batchPaths[0]);
    // Killed before its gate ever opened, so it provably started nothing and
    // the latch clears - which is what lets attempt B run at all.
    if (childA) {
      childA.exitCode = 1;
      childA.emit("close", 1);
    }
    await waitUntil(() => __shutdown.state().updateInstallStarted === false, 10000);
    await waitUntil(() => !fs.existsSync(dirA), 10000);

    resetCounts();
    rig.reset();
    rig.answer = 1;
    await startInstall();
    const tokenAttemptB = await waitUntil(() => activeChild !== null, 10000);
    const childB = activeChild;
    const tokenB = portableHandoffToken(batchPaths[0]);
    if (childB) childB.emit("spawn");
    const replayGateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    // THE REPLAY. Attempt A's acknowledgement, verbatim, planted into attempt
    // B's private directory after B's gate opened - the exact shape a captured
    // marker from an earlier update would take.
    if (replayGateReleased) writePortableMarker(batchPaths[0], "ack", tokenA);
    await sleep(600);
    const duringReplay = {
      quits: rig.quits,
      cancelWrites,
      authorized: __shutdown.state().authorized,
      unrefCalls: childB ? childB.unrefCalls : -1,
    };
    // Offered for the whole deadline and refused throughout: the hand-off ends
    // in the fail-closed timeout, not in a quit.
    const replayTimedOut = await waitUntil(
      () => cancelWrites === 1 && childKills === 1,
      15000,
    );
    if (childB) childB.emit("close", 1);
    await waitUntil(() => !fs.existsSync(portableBatchDir(batchPaths[0])), 10000);
    check(
      "a portable acknowledgement replayed from an earlier attempt is refused for its whole deadline",
      tokenAttemptA &&
        tokenAttemptB &&
        typeof tokenA === "string" &&
        typeof tokenB === "string" &&
        tokenA.length === 64 &&
        tokenB.length === 64 &&
        // The point of the test: two attempts, two different secrets.
        tokenA !== tokenB &&
        replayGateReleased &&
        duringReplay.quits === 0 &&
        duringReplay.cancelWrites === 0 &&
        duringReplay.authorized === false &&
        duringReplay.unrefCalls === 0 &&
        replayTimedOut &&
        rig.quits === 0,
      JSON.stringify({
        tokenAttemptA,
        tokenAttemptB,
        tokensDiffer: tokenA !== tokenB,
        tokenALength: tokenA && tokenA.length,
        tokenBLength: tokenB && tokenB.length,
        replayGateReleased,
        duringReplay,
        replayTimedOut,
        quits: rig.quits,
      }),
    );

    // The genuine current token, on a third attempt, still succeeds - and only
    // through the ordinary approval path. A replay test that left the real path
    // unproven would have shown the check refusing everything.
    __shutdown.reset();
    resetCounts();
    rig.reset();
    rig.answer = 1;
    await startInstall();
    const tokenAttemptC = await waitUntil(() => activeChild !== null, 10000);
    const childC = activeChild;
    const tokenC = portableHandoffToken(batchPaths[0]);
    if (childC) childC.emit("spawn");
    const genuineGateReleased = await waitUntil(() => releaseWrites === 1, 10000);
    if (genuineGateReleased) {
      acknowledgedBatchDirs.add(path.resolve(portableBatchDir(batchPaths[0])));
      writePortableMarker(batchPaths[0], "ack", tokenC);
    }
    const genuineQuit = await waitUntil(() => rig.quits === 1, 10000);
    check(
      "a fresh token is minted per attempt and only the current one can commit the hand-off",
      tokenAttemptC &&
        typeof tokenC === "string" &&
        tokenC.length === 64 &&
        tokenC !== tokenA &&
        tokenC !== tokenB &&
        genuineGateReleased &&
        genuineQuit &&
        rig.quits === 1 &&
        cancelWrites === 0 &&
        childC &&
        childC.unrefCalls === 1 &&
        __shutdown.state().authorized === true,
      JSON.stringify({
        tokenAttemptC,
        distinctFromA: tokenC !== tokenA,
        distinctFromB: tokenC !== tokenB,
        genuineGateReleased,
        genuineQuit,
        quits: rig.quits,
        cancelWrites,
        unrefCalls: childC && childC.unrefCalls,
        state: __shutdown.state(),
      }),
    );

    // Captured while this attempt's batch is still on disk and still the newest
    // one: the scenarios below reset the counters, and the liveness test needs
    // the REAL emitted bytes rather than a reconstruction of them.
    const emittedBatchText = fs.readFileSync(batchPaths[0], "utf8");
    const emittedBatchDir = portableBatchDir(batchPaths[0]);

    // AN INSTALL PRESS FROM A WINDOW THAT OWNS NO DOCUMENTS IS NOT A PRESS.
    // `install-update` can quit the app and replace it on disk, so the sender
    // gate is a security control - and "the suite passed" is not evidence for
    // it. A real second BrowserWindow sends the message; nothing may move.
    __shutdown.reset();
    resetCounts();
    rig.reset();
    const impostor = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    try {
      await impostor.loadURL("data:text/html,<title>impostor</title>");
      const beforeImpostor = {
        lastRequestId: __shutdown.state().lastRequestId,
        updateInstallStarted: __shutdown.state().updateInstallStarted,
      };
      installHandler({
        sender: impostor.webContents,
        senderFrame: impostor.webContents.mainFrame,
      });
      await sleep(400);
      const afterImpostor = __shutdown.state();
      check(
        "an install press from a window that owns no documents starts nothing at all",
        !impostor.isDestroyed() &&
          impostor.webContents.id !== win.webContents.id &&
          // No question was even raised: the gate refuses before requestShutdown.
          afterImpostor.lastRequestId === beforeImpostor.lastRequestId &&
          afterImpostor.updateInstallStarted === beforeImpostor.updateInstallStarted &&
          spawnCalls === 0 &&
          batchDirectories === 0 &&
          batchWrites === 0 &&
          releaseWrites === 0 &&
          cancelWrites === 0 &&
          childKills === 0 &&
          rig.dialogs.length === 0 &&
          rig.quits === 0 &&
          afterImpostor.authorized === false,
        JSON.stringify({
          impostorId: impostor.isDestroyed() ? null : impostor.webContents.id,
          ownerId: win.webContents.id,
          beforeImpostor,
          afterImpostor,
          spawnCalls,
          batchDirectories,
          batchWrites,
          releaseWrites,
          cancelWrites,
          childKills,
          dialogs: rig.dialogs.length,
          quits: rig.quits,
        }),
      );
    } finally {
      if (!impostor.isDestroyed()) impostor.destroy();
    }

    // ============================================================
    // The waiting batch must not outlive the app that parked it
    // ============================================================
    //
    // STATIC SHAPE IS NOT ENOUGH HERE. The batch waits for a release file that
    // only the app writes, so if Electron dies first nothing will ever write
    // one - and before the liveness check existed the loop spun in the user's
    // temp directory until reboot. The only honest test of that is to RUN the
    // emitted script.
    //
    // It is safe to run, and deliberately so: the real bytes are used, with a
    // named set of substitutions - the parent PID, the installer path (one that
    // does not exist), the private directory, and for the lease cases the
    // staleness threshold. No release file is ever written, so control cannot
    // reach `:install`; even if it did, the `if not exist` guard sends it to
    // `:failed`. Nothing can be launched by this test.
    const cmdPath = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    const canRunBatch = process.platform === "win32" && fs.existsSync(cmdPath);
    if (!canRunBatch) {
      // Announced in the shape the revert audit reads, so the assertions below
      // are catalogued as skipped rather than looking like dead names.
      for (const name of [
        "a parked portable batch exits by itself once its parent process is gone",
        "a parked portable batch stands itself down when its parent stops extending the lease",
        "a parked portable batch keeps waiting while its parent keeps extending the lease",
      ]) {
        console.log(`  SKIP  ${name} - no cmd.exe on ${process.platform}`);
      }
    } else {
      const liveDir = path.join(portableDir, "liveness");
      fs.mkdirSync(liveDir, { recursive: true });
      // realSpawn/realWriteFile, NOT the module's: the product's fault
      // injection is still installed here and would answer with a fake child
      // and inflate the batch counters the scenarios around this rely on.
      // A PID that is definitely not running: spawned, awaited, and gone.
      // ELECTRON_RUN_AS_NODE, because process.execPath in a main process is
      // electron.exe, not node. Without it `-e` is not a script flag at all:
      // Electron treats it as a Chromium switch, finds no app to load, and the
      // child NEVER exits - so the await below waited forever and every
      // liveness assertion under it was unreachable. Measured directly: no
      // `close` event in 15s with the variable unset, 136ms with it set.
      const corpse = realSpawn(process.execPath, ["-e", "process.exit(0)"], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      const deadPid = corpse.pid;
      // BOUNDED LIKE EVERY OTHER WAIT IN THIS BLOCK, and it was not before.
      // An unbounded await here is the one shape the surrounding design
      // explicitly rules out: it cannot fail, it can only hang, and a hung
      // companion is killed by its parent with no summary line - so the entire
      // catalogue below it is reported as unreached rather than as a failure.
      // This is how the defect above stayed invisible.
      //
      // AND THE KILL IS AWAITED TOO. `deadPid` is only a known-dead pid once
      // this process is CONFIRMED gone; a kill that was merely requested leaves
      // a pid that may still be in the table, which would make the dead-parent
      // case below wait on a parent that is alive and blame the PID check for
      // it. `close` rather than `exit`, so the same fact is read the same way
      // everywhere in this file.
      const waitForClose = (child, budgetMs) =>
        new Promise((resolve) => {
          // NO exitCode/signalCode SHORTCUT. Those fields say the process
          // reported an exit status; they do not say its handles are closed,
          // and `deadPid` is about to be handed to a batch whose entire job is
          // to decide whether that pid is still alive. Only the `close` event
          // is that statement. Both call sites attach before any event can be
          // emitted - the first in the same tick as the spawn, the second only
          // after the first has already waited its full budget without a close
          // - so nothing can be missed by refusing the shortcut.
          let done = false;
          const settle = (value) => {
            if (done) return;
            done = true;
            clearTimeout(bail);
            resolve(value);
          };
          const bail = setTimeout(() => settle(false), budgetMs);
          child.once("close", () => settle(true));
          child.once("error", () => settle(false));
        });
      let corpseGone = await waitForClose(corpse, 15000);
      if (!corpseGone) {
        try {
          corpse.kill();
        } catch (error) {
          // Reported through the dead-parent assertion, which reads corpseGone.
        }
        corpseGone = await waitForClose(corpse, 10000);
      }
      const missingInstaller = path.join(liveDir, "no-such-installer.exe");
      // WHAT MAKES RUNNING PRODUCTION BYTES SAFE IS THE SUBSTITUTION, so the
      // substitution is PROVEN rather than performed and trusted. The real
      // `downloadedFile` these scripts were emitted against is `fileA`, and it
      // EXISTS - so a `start`/`if not exist` rewrite that silently failed to
      // apply would leave a runnable script pointing at a real file, the
      // `if not exist` guard would pass, and this test would hand a document to
      // the shell's default handler. `installerNeutralised` below is the
      // assertion that this cannot have happened: the real path appears nowhere
      // in the rewritten bytes, both the guard and the `start` name the
      // substitute, there is exactly one `start`, and the substitute is absent
      // from disk so control provably reaches `:failed` even if it got there.
      const realDownloadPath = fileA;
      // THE PRE-CONDITION IS PROVEN BEFORE THE REWRITE, because a substitution
      // is only meaningful against a known starting point. If the captured
      // bytes did not name the real download in these two exact lines - a
      // different quoting, a second `start`, a guard against some other path -
      // then `installerNeutralised` below would be measuring a rewrite of
      // something this block never identified, and "the real path is gone from
      // the script" would be true for the uninteresting reason that it was
      // never there. Asserted against the ORIGINAL emitted text.
      const emittedLines = emittedBatchText.split(/\r?\n/).map((l) => l.trim());
      const emittedStartLines = emittedLines.filter((l) =>
        l.startsWith('start ""'),
      );
      const emittedGuardLines = emittedLines.filter((l) =>
        /^if not exist "[^"]*" goto failed$/.test(l),
      );
      const emittedNamesRealDownload =
        emittedStartLines.length === 1 &&
        emittedStartLines[0] === `start "" "${realDownloadPath}"` &&
        emittedGuardLines.length === 1 &&
        emittedGuardLines[0] ===
          `if not exist "${realDownloadPath}" goto failed` &&
        // And it is a real file, so the guard it is about would genuinely pass.
        fs.existsSync(realDownloadPath);
      check(
        "the captured portable batch names the real downloaded installer in its guard and its start line",
        emittedNamesRealDownload,
        JSON.stringify({
          realDownloadPath,
          realDownloadExists: fs.existsSync(realDownloadPath),
          emittedStartLines,
          emittedGuardLines,
        }),
      );
      const buildLivenessBatch = (name, options) => {
        const batchDir = path.join(liveDir, name);
        fs.mkdirSync(batchDir, { recursive: true });
        const batchFile = path.join(batchDir, "update.bat");
        let text = emittedBatchText
          .replace(/PID eq \d+/g, `PID eq ${options.pid}`)
          .replace(/find "\d+"/g, `find "${options.pid}"`)
          .split(emittedBatchDir)
          .join(batchDir)
          .replace(/start "" "[^"]*"/g, `start "" "${missingInstaller}"`)
          .replace(
            /if not exist "[^"]*" goto failed/,
            `if not exist "${missingInstaller}" goto failed`,
          );
        let thresholdApplied = true;
        if (typeof options.stalePolls === "number") {
          text = text.replace(
            /GEQ \d+ goto orphaned/,
            `GEQ ${options.stalePolls} goto orphaned`,
          );
          thresholdApplied = text.includes(
            `GEQ ${options.stalePolls} goto orphaned`,
          );
        }
        const startLines = text
          .split(/\r?\n/)
          .filter((line) => line.trim().startsWith('start ""'));
        const installerNeutralised =
          // The pre-condition above identified exactly what is being replaced.
          emittedNamesRealDownload &&
          // The real download is still on disk, so its absence from the script
          // is a substitution rather than an accident of the fixture.
          fs.existsSync(realDownloadPath) &&
          !text.includes(realDownloadPath) &&
          startLines.length === 1 &&
          startLines[0].trim() === `start "" "${missingInstaller}"` &&
          text.includes(`if not exist "${missingInstaller}" goto failed`) &&
          // And the substitute is not there either, so `:install` provably
          // falls through to `:failed` without launching anything at all.
          !fs.existsSync(missingInstaller);
        realWriteFile(batchFile, text, "utf8");
        return {
          dir: batchDir,
          file: batchFile,
          lease: path.join(batchDir, "lease"),
          cancel: path.join(batchDir, "cancel"),
          ack: path.join(batchDir, "ack"),
          installerNeutralised,
          startLines,
          applied:
            text.includes(`PID eq ${options.pid}`) &&
            text.includes(`find "${options.pid}"`) &&
            text.includes(batchDir) &&
            !text.includes(emittedBatchDir) &&
            installerNeutralised &&
            thresholdApplied,
        };
      };
      // BOUNDED in every case, so a revert that removes a liveness check is
      // caught by a failing assertion rather than by hanging the suite.
      //
      // A TIMED-OUT RUN IS NOT FINISHED WHEN THE KILL IS REQUESTED. Resolving
      // there returned control to a caller that immediately asks whether the
      // batch's private directory is gone - while cmd.exe is still running,
      // still holding the script it is executing open inside that directory.
      // The answer would be a statement about a race rather than about the
      // batch, and the directory could then survive into the sweep at the end
      // of the scenario. The kill is awaited to `close`, and whether that was
      // acknowledged is reported rather than assumed.
      const runLivenessBatch = (batchFile, budgetMs) =>
        new Promise((resolve) => {
          const started = Date.now();
          let exited = false;
          let timedOut = false;
          let killAcknowledged = true;
          const runner = realSpawn(cmdPath, ["/c", batchFile], {
            windowsHide: true,
            stdio: "ignore",
          });
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve({
              exited,
              timedOut,
              killAcknowledged,
              elapsedMs: Date.now() - started,
            });
          };
          let killGrace = null;
          const watchdog = setTimeout(() => {
            timedOut = true;
            try {
              runner.kill();
            } catch (error) {
              // Reported through killAcknowledged.
            }
            killGrace = setTimeout(() => {
              killAcknowledged = false;
              finish();
            }, 10000);
          }, budgetMs);
          runner.once("error", () => {
            clearTimeout(watchdog);
            if (killGrace) clearTimeout(killGrace);
            finish();
          });
          runner.once("close", () => {
            clearTimeout(watchdog);
            if (killGrace) clearTimeout(killGrace);
            // `exited` means it ended ON ITS OWN. A close that only arrives
            // because the watchdog killed it is a timeout that was cleaned up,
            // not a batch that stood itself down, and the assertions read the
            // two differently.
            if (!timedOut) exited = true;
            finish();
          });
        });

      // -- the parent process is simply gone -------------------------------
      // The lease is kept FRESH here on purpose, so the only thing that can end
      // this wait is the PID check. Without that isolation a revert of the PID
      // check would still be rescued by the staleness window and the assertion
      // would prove nothing about the control it names.
      const deadCase = buildLivenessBatch("dead-parent", { pid: deadPid });
      realWriteFile(deadCase.lease, ".", "utf8");
      const deadBeats = setInterval(() => {
        try {
          fs.appendFileSync(deadCase.lease, ".");
        } catch (error) {
          // The directory is gone: the batch has ended, which is the outcome
          // this case is waiting for.
        }
      }, 500);
      const deadRun = await runLivenessBatch(deadCase.file, 20000);
      clearInterval(deadBeats);
      const dirRemoved = await waitUntil(() => !fs.existsSync(deadCase.dir), 5000);
      const ackWritten = fs.existsSync(deadCase.ack);
      check(
        "a parked portable batch exits by itself once its parent process is gone",
        deadCase.applied &&
          // The PID this case rests on is only known-dead if the throwaway
          // process really ended; without it the "dead" parent may be alive
          // and the batch would be right to keep waiting.
          corpseGone &&
          typeof deadPid === "number" &&
          deadRun.exited &&
          !deadRun.timedOut &&
          deadRun.elapsedMs < 20000 &&
          dirRemoved &&
          // It never reached `start`: no acknowledgement was written, so no
          // installer can have been launched by this test.
          !ackWritten,
        JSON.stringify({
          substitutionsApplied: deadCase.applied,
          installerNeutralised: deadCase.installerNeutralised,
          startLines: deadCase.startLines,
          corpseGone,
          deadPid,
          exited: deadRun.exited,
          timedOut: deadRun.timedOut,
          // A kill this batch did not acknowledge is a cmd.exe still running
          // inside the directory the next line asks about.
          killAcknowledged: deadRun.killAcknowledged,
          elapsedMs: deadRun.elapsedMs,
          dirRemoved,
          ackWritten,
        }),
      );

      // -- the PID is alive but the lease has stopped moving ----------------
      // A PID IS NOT AN IDENTITY. Windows reuses process ids, so a batch that
      // trusted the PID table alone could be kept waiting indefinitely by an
      // unrelated process that happened to inherit the number. This case uses a
      // parent that is definitely alive - this very process - so the ONLY thing
      // that can end the wait is the lease that stopped being extended.
      const staleCase = buildLivenessBatch("stale-lease", {
        pid: process.pid,
        stalePolls: 3,
      });
      realWriteFile(staleCase.lease, ".", "utf8");
      const staleRun = await runLivenessBatch(staleCase.file, 25000);
      const staleDirRemoved = await waitUntil(
        () => !fs.existsSync(staleCase.dir),
        5000,
      );
      check(
        "a parked portable batch stands itself down when its parent stops extending the lease",
        staleCase.applied &&
          staleRun.exited &&
          !staleRun.timedOut &&
          staleRun.elapsedMs < 25000 &&
          staleDirRemoved,
        JSON.stringify({
          substitutionsApplied: staleCase.applied,
          installerNeutralised: staleCase.installerNeutralised,
          startLines: staleCase.startLines,
          livePid: process.pid,
          exited: staleRun.exited,
          timedOut: staleRun.timedOut,
          killAcknowledged: staleRun.killAcknowledged,
          elapsedMs: staleRun.elapsedMs,
          staleDirRemoved,
        }),
      );

      // -- and it keeps waiting while the lease IS extended ------------------
      // The non-vacuity half. Without it "the batch exits" and "the batch
      // always exits" are the same observation, and a lease check that fired
      // unconditionally would abort every legitimate update - including one
      // where the reader is simply taking their time over the confirmation.
      const freshCase = buildLivenessBatch("fresh-lease", {
        pid: process.pid,
        stalePolls: 3,
      });
      realWriteFile(freshCase.lease, ".", "utf8");
      let freshExited = false;
      const freshPromise = runLivenessBatch(freshCase.file, 30000).then(
        (result) => {
          freshExited = true;
          return result;
        },
      );
      const beats = setInterval(() => {
        try {
          fs.appendFileSync(freshCase.lease, ".");
        } catch (error) {
          // The directory is gone: the batch has already ended, which the
          // assertion below reports through freshExited.
        }
      }, 500);
      // Well past the scaled staleness window: an unconditional or PID-only
      // check would have ended it several polls ago.
      await sleep(9000);
      const stillWaiting = !freshExited;
      clearInterval(beats);
      // Stand it down the way the app does, rather than by killing it.
      try {
        realWriteFile(freshCase.cancel, "", "utf8");
      } catch (error) {
        // Reported through the assertion below.
      }
      const freshRun = await freshPromise;
      const freshDirRemoved = await waitUntil(
        () => !fs.existsSync(freshCase.dir),
        5000,
      );
      check(
        "a parked portable batch keeps waiting while its parent keeps extending the lease",
        freshCase.applied &&
          stillWaiting &&
          freshRun.exited &&
          !freshRun.timedOut &&
          freshDirRemoved &&
          !fs.existsSync(freshCase.ack),
        JSON.stringify({
          substitutionsApplied: freshCase.applied,
          installerNeutralised: freshCase.installerNeutralised,
          startLines: freshCase.startLines,
          stillWaiting,
          exited: freshRun.exited,
          timedOut: freshRun.timedOut,
          killAcknowledged: freshRun.killAcknowledged,
          elapsedMs: freshRun.elapsedMs,
          freshDirRemoved,
        }),
      );

      try {
        fs.rmSync(liveDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        check(
          "the portable liveness test removes its own scratch directory",
          false,
          String(error),
        );
      }
    }

    // A BATCH THAT DIES BEFORE ITS GATE OPENS PROVABLY STARTED NOTHING. The
    // child can be killed from Task Manager or swept by security software while
    // the approval is still on screen; releasing a gate at a process that is
    // already gone opens nothing, the acknowledgement never comes, and the
    // deadline would then hold the retry latch for the rest of the session over
    // an installer that could not possibly have run.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const earlyDeathParked = await waitUntil(() => activeChild !== null, 10000);
    const earlyDeathChild = activeChild;
    const earlyDeathBatchDir = portableBatchDir(batchPaths[0]);
    if (earlyDeathChild) {
      earlyDeathChild.exitCode = 1;
      earlyDeathChild.emit("close", 1);
    }
    await sleep(300);
    const afterEarlyDeath = __shutdown.state();
    const earlyDeathDirRemoved = await waitUntil(
      () => !fs.existsSync(earlyDeathBatchDir),
      10000,
    );
    // The latch is clear, so a later press may try again - and does.
    resetCounts();
    rig.reset();
    await startInstall();
    const earlyDeathRetryParked = await waitUntil(
      () => activeChild !== null,
      10000,
    );
    check(
      "a portable batch that dies before its gate is released clears the retry latch",
      earlyDeathParked &&
        afterEarlyDeath.updateInstallStarted === false &&
        afterEarlyDeath.authorized === false &&
        releaseWrites === 0 &&
        rig.quits === 0 &&
        earlyDeathDirRemoved &&
        earlyDeathRetryParked &&
        spawnCalls === 1 &&
        batchDirectories === 1,
      JSON.stringify({
        earlyDeathParked,
        afterEarlyDeath,
        releaseWrites,
        quits: rig.quits,
        earlyDeathDirRemoved,
        earlyDeathRetryParked,
        spawnCalls,
        batchDirectories,
      }),
    );
    if (activeChild) {
      activeChild.exitCode = 1;
      activeChild.emit("close", 1);
    }
    await sleep(200);

    // A release-gate write is also a failed hand-off. It must fail closed,
    // cancel and await the child close before another attempt can start.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await startInstall();
    const releaseFailureChildParked = await waitUntil(() => activeChild !== null);
    const releaseFailureChild = activeChild;
    gateWriteMode = "release-throw";
    const releaseFailureStarted = Date.now();
    if (releaseFailureChild) releaseFailureChild.emit("spawn");
    const releaseFailureCancelled = await waitUntil(
      () => releaseWrites === 1 && cancelWrites === 1 && childKills === 1,
      10000,
    );
    // A FAILED GATE WRITE MUST CANCEL ITSELF, NOT BE RESCUED BY THE DEADLINE.
    // The hand-off already has a fail-closed timeout, and it would eventually
    // cancel this child too - which means "the child was cancelled" alone
    // cannot tell the explicit failure path from the timeout that would happen
    // anyway, and a revert of the explicit path would look proven. The timeout
    // is 5s; the explicit path is a few milliseconds plus one IPC round trip,
    // measured at a p95 of about 3ms.
    const releaseFailureElapsedMs = Date.now() - releaseFailureStarted;
    const releaseFailureLatched = __shutdown.state().updateInstallStarted;
    const releaseFailureGates =
      cancelPaths.length === 1 &&
      releasePaths.length === 1 &&
      fs.existsSync(cancelPaths[0]) &&
      !fs.existsSync(releasePaths[0]);
    const releaseFailureBatchDir = portableBatchDir(batchPaths[0]);
    if (releaseFailureChild) releaseFailureChild.emit("close", 1);
    const releaseFailureClosed = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const releaseFailureDirRemoved = await waitUntil(
      () => !fs.existsSync(releaseFailureBatchDir),
      10000,
    );
    gateWriteMode = null;
    check(
      "a portable release-gate write failure stays fail-closed until the child closes",
      releaseFailureChildParked &&
        releaseFailureCancelled &&
        releaseFailureElapsedMs < 2500 &&
        releaseWrites === 1 &&
        cancelWrites === 1 &&
        releasePaths.length === 1 &&
        cancelPaths.length === 1 &&
        releaseFailureGates &&
        childKills === 1 &&
        releaseFailureChild &&
        releaseFailureChild.unrefCalls === 0 &&
        rig.quits === 0 &&
        __shutdown.state().authorized === false &&
        releaseFailureLatched === true &&
        releaseFailureClosed &&
        releaseFailureDirRemoved,
      JSON.stringify({
        releaseFailureChildParked,
        releaseFailureCancelled,
        releaseFailureElapsedMs,
        releasePaths,
        cancelPaths,
        releaseFailureGates,
        childKills,
        unrefCalls: releaseFailureChild && releaseFailureChild.unrefCalls,
        quits: rig.quits,
        releaseFailureLatched,
        releaseFailureClosed,
        releaseFailureDirRemoved,
        state: __shutdown.state(),
      }),
    );

    // An error before gate release does not prove cmd.exe has stopped holding
    // its script. It cancels immediately, but its retry latch and directory
    // remain owned by the child-close boundary.
    __shutdown.reset();
    resetCounts();
    await startInstall();
    const errorChildReady = await waitUntil(() => activeChild !== null);
    const errorIsHandled =
      errorChildReady && activeChild.listenerCount("error") === 1;
    const errorBatchDir = portableBatchDir(batchPaths[0]);
    const errorBatchWritten = fs.existsSync(batchPaths[0]);
    if (activeChild) {
      activeChild.emit("error", new Error("controlled asynchronous spawn error"));
      // `spawn` is the portable hand-off boundary. It may have been queued
      // before the error; after cancellation it must not write the release
      // gate or turn the failed attempt into a quit.
      activeChild.emit("spawn");
    }
    await sleep(150);
    const afterError = __shutdown.state();
    const errorDirHeld = fs.existsSync(errorBatchDir);
    const latePortableBoundaryBlocked = releaseWrites === 0 && rig.quits === 0;
    await startInstall();
    const errorDuplicateBlocked = spawnCalls === 1;
    const errorSpawnCallsBeforeRetry = spawnCalls;
    if (activeChild) activeChild.emit("close", 1);
    const errorLatchReleased = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const errorDirRemoved = await waitUntil(() => !fs.existsSync(errorBatchDir), 10000);
    // A pre-release child error means no installer could have started. Once
    // that child closes, the old attempt must not retain the retry latch: a
    // fresh press reaches a distinct child, and a late event from the old one
    // cannot be mistaken for authority to quit.
    const errorChild = activeChild;
    await startInstall();
    const errorRetryStarted = await waitUntil(
      () => spawnCalls === 2 && activeChild !== null && activeChild !== errorChild,
      10000,
    );
    const errorRetryChild = activeChild;
    if (errorRetryChild) {
      errorRetryChild.exitCode = 1;
      errorRetryChild.emit("close", 1);
    }
    const errorRetryCleared = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent + '\\nPORTABLE_SPAWN_ERROR_EDIT\\n';
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return true;
      })()
    `);
    rig.answer = 1;
    const closeAfterError = guardEvent();
    win.emit("close", closeAfterError);
    const errorAsked = await waitUntil(() => rig.dialogs.length === 1);
    check(
      "a pre-release portable child error is handled but cannot clear its retry latch before close",
      errorIsHandled &&
        errorSpawnCallsBeforeRetry === 1 &&
        rig.quits === 0 &&
        afterError.authorized === false &&
        afterError.pendingId === 0 &&
        afterError.updateInstallStarted === true &&
        errorDirHeld &&
        latePortableBoundaryBlocked &&
        errorDuplicateBlocked &&
        errorLatchReleased &&
        errorAsked &&
        closeAfterError.prevented === true,
      JSON.stringify({
        errorIsHandled,
        spawnCalls,
        errorSpawnCallsBeforeRetry,
        quits: rig.quits,
        afterError,
        errorDirHeld,
        latePortableBoundaryBlocked,
        errorDuplicateBlocked,
        errorLatchReleased,
        errorAsked,
        prevented: closeAfterError.prevented,
      }),
    );
    check(
      "a pre-release portable child error clears its retry latch only after close and permits one new attempt",
      errorBatchWritten &&
        errorDirRemoved &&
        errorRetryStarted &&
        errorRetryCleared &&
        spawnCalls === 2 &&
        rig.quits === 0,
      JSON.stringify({
        errorBatchWritten,
        errorDirRemoved,
        errorBatchDir,
        errorRetryStarted,
        errorRetryCleared,
        spawnCalls,
        quits: rig.quits,
        stillThere: fs.existsSync(errorBatchDir)
          ? fs.readdirSync(errorBatchDir)
          : null,
      }),
    );

    // After release, an error cannot prove that cmd did not already reach
    // `start`. It must still wait for close before deleting the batch, and it
    // must retain the duplicate-install latch even after that close.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    await startInstall();
    const releasedErrorChildReady = await waitUntil(() => activeChild !== null);
    const releasedErrorChild = activeChild;
    if (releasedErrorChild) releasedErrorChild.emit("spawn");
    const releasedErrorGate = await waitUntil(() => releaseWrites === 1, 10000);
    const releasedErrorBatchDir = portableBatchDir(batchPaths[0]);
    if (releasedErrorChild) {
      releasedErrorChild.emit(
        "error",
        new Error("controlled post-release child error"),
      );
    }
    await sleep(150);
    const afterReleasedError = __shutdown.state();
    const releasedErrorDirHeld = fs.existsSync(releasedErrorBatchDir);
    await startInstall();
    const releasedErrorDuplicateBlocked = spawnCalls === 1;
    if (releasedErrorChild) releasedErrorChild.emit("close", 1);
    const releasedErrorDirRemoved = await waitUntil(
      () => !fs.existsSync(releasedErrorBatchDir),
      10000,
    );
    const afterReleasedClose = __shutdown.state();
    check(
      "a post-release portable child error waits for close but retains the duplicate-install latch",
      releasedErrorChildReady &&
        releasedErrorGate &&
        afterReleasedError.authorized === false &&
        afterReleasedError.updateInstallStarted === true &&
        releasedErrorDirHeld &&
        releasedErrorDuplicateBlocked &&
        releasedErrorDirRemoved &&
        afterReleasedClose.updateInstallStarted === true &&
        rig.quits === 0,
      JSON.stringify({
        releasedErrorChildReady,
        releasedErrorGate,
        afterReleasedError,
        releasedErrorDirHeld,
        releasedErrorDuplicateBlocked,
        releasedErrorDirRemoved,
        afterReleasedClose,
        spawnCalls,
        quits: rig.quits,
      }),
    );

    // A cancelled pre-release child that never closes is still live from the
    // owner's perspective. Do not delete its tree or permit a retry; a late
    // close is the one event that may release that state, and duplicate late
    // lifecycle events must not release it twice.
    __shutdown.reset();
    resetCounts();
    rig.answer = 1;
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    await startInstall();
    const neverCloseChildReady = await waitUntil(() => activeChild !== null);
    const neverCloseChild = activeChild;
    const neverCloseBatchDir = portableBatchDir(batchPaths[0]);
    if (neverCloseChild) {
      neverCloseChild.emit("error", new Error("controlled never-close error"));
    }
    await sleep(150);
    const neverCloseState = __shutdown.state();
    const neverCloseDirHeld = fs.existsSync(neverCloseBatchDir);
    await startInstall();
    const neverCloseRetryBlocked = spawnCalls === 1;
    const cancelsBeforeLateClose = cancelWrites;
    if (neverCloseChild) {
      neverCloseChild.emit("close", 1);
      neverCloseChild.emit("close", 1);
      neverCloseChild.emit("error", new Error("late child error"));
    }
    const lateCloseReleased = await waitUntil(
      () => __shutdown.state().updateInstallStarted === false,
      10000,
    );
    const lateCloseDirRemoved = await waitUntil(
      () => !fs.existsSync(neverCloseBatchDir),
      10000,
    );
    const cancelsAfterLateEvents = cancelWrites;
    await startInstall();
    const oneRetryAfterLateClose = await waitUntil(() => spawnCalls === 2, 10000);
    check(
      "a never-closing pre-release child preserves its latch and tree until one late close releases exactly one retry",
      neverCloseChildReady &&
        neverCloseState.updateInstallStarted === true &&
        neverCloseState.authorized === false &&
        neverCloseDirHeld &&
        neverCloseRetryBlocked &&
        lateCloseReleased &&
        lateCloseDirRemoved &&
        cancelsBeforeLateClose === 1 &&
        cancelsAfterLateEvents === 1 &&
        oneRetryAfterLateClose &&
        spawnCalls === 2,
      JSON.stringify({
        neverCloseChildReady,
        neverCloseState,
        neverCloseDirHeld,
        neverCloseRetryBlocked,
        lateCloseReleased,
        lateCloseDirRemoved,
        cancelsBeforeLateClose,
        cancelsAfterLateEvents,
        oneRetryAfterLateClose,
        spawnCalls,
      }),
    );
    if (activeChild) {
      activeChild.exitCode = 1;
      activeChild.emit("close", 1);
    }
    await sleep(150);

    // A terminal process status proves only that this batch can no longer
    // consume its *unreleased* gate. Its close still owns filesystem cleanup,
    // so the retry may begin before it arrives; a late close from that old
    // child must never clear the new attempt's latch. Exercise event, typed
    // exitCode, and typed signalCode through the same production branches.
    const preReleaseTerminalCases = [
      {
        name: "an exit event before release permits a retry without letting the old close clear its latch",
        terminal(child) {
          child.emit("exit", 1);
        },
      },
      {
        name: "a typed exitCode before release permits a retry without letting the old close clear its latch",
        terminal(child) {
          child.exitCode = 1;
          child.emit("spawn");
        },
      },
      {
        name: "a typed signalCode before release permits a retry without letting the old close clear its latch",
        terminal(child) {
          child.signalCode = "SIGTERM";
          child.emit("spawn");
        },
      },
    ];
    for (const terminalCase of preReleaseTerminalCases) {
      __shutdown.reset();
      resetCounts();
      rig.answer = 1;
      await exec(`
        (() => {
          const tab = window.CustomTabs.getActiveTab();
          tab.content = tab.originalContent;
          tab.hasUnsavedChanges = false;
          window.originalMarkdown = tab.originalContent;
          return true;
        })()
      `);
      await startInstall();
      const oldChildParked = await waitUntil(() => activeChild !== null, 10000);
      const oldChild = activeChild;
      const oldBatchDir = oldChildParked ? portableBatchDir(batchPaths[0]) : null;
      if (oldChild) terminalCase.terminal(oldChild);
      const retryableBeforeClose = await waitUntil(
        () => __shutdown.state().updateInstallStarted === false,
        10000,
      );
      const oldBatchStillHeld = !!oldBatchDir && fs.existsSync(oldBatchDir);
      await startInstall();
      const retryStartedBeforeOldClose = await waitUntil(
        () => activeChild !== null && activeChild !== oldChild,
        10000,
      );
      const newChild = activeChild;
      const newLatchBeforeOldClose = __shutdown.state().updateInstallStarted;
      if (oldChild) {
        oldChild.emit("close", 1);
        // `once` must consume duplicate terminal close events; the durable
        // error listener is deliberately exercised after it as well.
        oldChild.emit("close", 1);
        oldChild.emit("error", new Error("late old-child error"));
      }
      await sleep(150);
      const newLatchAfterOldClose = __shutdown.state().updateInstallStarted;
      check(
        terminalCase.name,
        oldChildParked &&
          retryableBeforeClose &&
          oldBatchStillHeld &&
          retryStartedBeforeOldClose &&
          newLatchBeforeOldClose === true &&
          newLatchAfterOldClose === true &&
          spawnCalls === 2,
        JSON.stringify({
          oldChildParked,
          retryableBeforeClose,
          oldBatchStillHeld,
          retryStartedBeforeOldClose,
          newLatchBeforeOldClose,
          newLatchAfterOldClose,
          spawnCalls,
          state: __shutdown.state(),
        }),
      );
      // End the retry deterministically before the next row. Its own typed
      // terminal status proves no installer could have started.
      if (newChild) {
        newChild.exitCode = 1;
        newChild.emit("close", 1);
      }
      await waitUntil(() => __shutdown.state().updateInstallStarted === false, 10000);
      await waitUntil(
        () => !fs.existsSync(portableBatchDir(batchPaths.at(-1))),
        10000,
      );
    }

    // ============================================================
    // AN EMPTY SCREEN IS NOT CONSENT TO REPLACE THE APPLICATION
    // ============================================================
    //
    // THE ONE PRODUCTION ROUTE that reaches the dispatcher with no window and
    // an updater reason. The acknowledgement can arrive after the window has
    // gone - the batch is off starting an installer, and the reader closes the
    // app in that gap - and the hand-off's commit then raises `update-install`
    // against nothing. "Nothing is on screen, so there is nothing to lose" used
    // to approve it, which is an argument about DATA being used to authorise
    // rewriting the application on disk. It now fails closed.
    //
    // The window is destroyed for real, last, after every other scenario: this
    // is the only way to observe the branch, and the sweep below and the
    // teardown afterwards need no window.
    __shutdown.reset();
    resetCounts();
    rig.reset();
    rig.answer = 1;
    // THE DOCUMENT IS PUT BACK CLEAN FIRST, and it has to be. The block above
    // deliberately leaves an edit in the tab so that its close is asked about;
    // an Install press against that edit raises a discard question, `answer: 1`
    // CANCELS it, and no child is ever parked - so `batchPaths[0]` was
    // undefined and reading the hand-off token out of it threw, taking the
    // whole companion down after its last assertion. This block is about a
    // window that disappears mid-hand-off, not about consent, so the consent
    // question is removed rather than answered.
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        window.isEditMode = false;
        return true;
      })()
    `);
    await startInstall();
    const noWindowParked = await waitUntil(() => activeChild !== null, 10000);
    const noWindowBatch = batchPaths[0];
    // THE SETUP IS ASSERTED BEFORE THE ACT. Everything below reads this batch
    // path, so a press that parked nothing has to be reported here rather than
    // thrown out of a file read several lines later.
    check(
      "the no-window portable case really parked a child with a batch on disk",
      noWindowParked === true &&
        typeof noWindowBatch === "string" &&
        fs.existsSync(noWindowBatch) &&
        rig.dialogs.length === 0,
      JSON.stringify({
        noWindowParked,
        noWindowBatch: noWindowBatch || null,
        dialogs: rig.dialogs.length,
        state: __shutdown.state(),
      }),
    );
    if (!noWindowParked || typeof noWindowBatch !== "string") return;
    if (activeChild) activeChild.emit("spawn");
    const noWindowReleased = await waitUntil(() => releaseWrites === 1, 10000);
    const noWindowToken = portableHandoffToken(noWindowBatch);
    // The real batch deletes its own directory once acknowledged, so this one
    // is expected to survive the sweep exactly like the other acknowledged
    // hand-offs.
    acknowledgedBatchDirs.add(path.resolve(portableBatchDir(noWindowBatch)));
    win.destroy();
    await waitUntil(() => win.isDestroyed(), 5000);
    // window-all-closed reaches the real app.quit() listener, which the rig
    // counts. Cleared here so the assertion below measures the hand-off's own
    // decision and not the lifecycle cascade that preceded it.
    await sleep(300);
    rig.reset();
    const beforeNoWindowAck = __shutdown.state();
    writePortableMarker(noWindowBatch, "ack", noWindowToken);
    await sleep(1200);
    const afterNoWindowAck = __shutdown.state();
    check(
      "an acknowledged portable hand-off refuses to quit for a window that is already gone",
      noWindowParked &&
        noWindowReleased &&
        typeof noWindowToken === "string" &&
        noWindowToken.length === 64 &&
        beforeNoWindowAck.updateInstallStarted === true &&
        // Refused by REASON, not by circumstance: the recorded route says so.
        afterNoWindowAck.settleWhy === "no-window-updater" &&
        rig.quits === 0 &&
        afterNoWindowAck.authorized === false &&
        afterNoWindowAck.pendingId === 0,
      JSON.stringify({
        noWindowParked,
        noWindowReleased,
        tokenLength: noWindowToken && noWindowToken.length,
        beforeNoWindowAck,
        afterNoWindowAck,
        quits: rig.quits,
      }),
    );
    check(
      "a refused no-window update quit keeps the in-flight latch over an installer that is already running",
      // The installer was acknowledged: it cannot be recalled, so a second
      // attempt must not be allowed to start one alongside it. The latch is
      // the boundary, and a refusal that cleared it would be worse than the
      // quit it declined.
      afterNoWindowAck.updateInstallStarted === true &&
        cancelWrites === 0 &&
        spawnCalls === 1,
      JSON.stringify({
        afterNoWindowAck,
        cancelWrites,
        spawnCalls,
      }),
    );

    // A SWEEP, NOT A SPOT CHECK. Every scenario above ends by asserting its own
    // directory is gone, but "gone" is only meaningful if nothing else was left
    // behind on the way - a private directory created by a path this suite did
    // not think to look at is exactly the residue being fixed. The survivors
    // are named individually rather than counted: on an acknowledged hand-off
    // the real batch deletes itself and there is no real batch here, so those
    // exact directories are expected and every other one is a leak.
    const strayBatchDirs = fs
      .readdirSync(portableDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.resolve(path.join(portableDir, entry.name)))
      .filter((directory) => !acknowledgedBatchDirs.has(directory));
    check(
      "the portable updater leaves no private batch directory behind on any failed hand-off",
      strayBatchDirs.length === 0 && acknowledgedBatchDirs.size === 7,
      JSON.stringify({
        strayBatchDirs,
        acknowledged: [...acknowledgedBatchDirs],
      }),
    );
  } finally {
    if (restoreSpawn) restoreSpawn();
    if (restoreWrite) restoreWrite();
    if (restoreMkdtemp) restoreMkdtemp();
    rig.restore();
    __shutdown.reset();
    try {
      fs.rmSync(portableDir, { recursive: true, force: true });
    } catch (error) {
      check(
        "the portable updater test removes its private batch directories",
        false,
        String(error),
      );
    }
  }
}

// ============================================================
// TEARDOWN IS NOT CONSENT (F22) - ISOLATED, ONE WINDOW PER CASE
// ============================================================
//
// THE GAP THESE CLOSE. A window disappearing used to RESOLVE the protocol
// rather than abandon it, and every route out of that ended in an installer.
// Settling the pending close APPROVED it, and an approval carries the QUEUED
// intent with it - so a force-fresh update-install queued behind that close was
// re-raised, reached the dispatcher with no window left, and was approved by
// the "nothing is on screen, so there is nothing to lose" rule. That rule is an
// argument about DATA; it was being used to authorise replacing the application
// on disk.
//
// WHY THIS IS A SEPARATE PROCESS PER CASE, and not a block in the shared suite.
// These scenarios have to destroy the document window for real - main.js's own
// `closed` handler sets `mainWindow = null`, so `shutdownOwnerWindow()` returns
// null from then on and EVERY later scenario in that process silently becomes a
// no-window scenario. Measured, not theorised: emitting `closed` on the shared
// window turned twelve later F22 assertions into no-window artefacts and then
// crashed the harness, which truncated the assertion catalogue the revert audit
// reads. A window that must die gets its own process.
//
// Each case is headless, bounded by the parent's own timeout, and answers its
// own dialogs; nothing here can open a native modal.
async function runTeardownScenario(win, kase) {
  // These isolated companions retain the non-Windows BaseUpdater lifecycle
  // coverage; Windows NSIS launcher coverage runs in the parent process.
  if (process.platform === "win32") {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  }
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const rig = shutdownRig(win);
  const updaterModule = require("electron-updater");
  const fileT = path.join(dir, `teardown-${kase}.md`);
  write(fileT, "# Teardown fixture\n\nT_BODY\n");
  let installs = 0;
  let restoreInstall = null;
  let restoreWindowAllClosed = null;
  const updaterLatchDescriptor = Object.getOwnPropertyDescriptor(
    updaterModule.autoUpdater,
    "quitAndInstallCalled",
  );
  const restoreUpdaterLatch = () => {
    if (updaterLatchDescriptor) {
      Object.defineProperty(
        updaterModule.autoUpdater,
        "quitAndInstallCalled",
        updaterLatchDescriptor,
      );
    } else {
      delete updaterModule.autoUpdater.quitAndInstallCalled;
    }
  };
  try {
    const ready = await waitUntil(
      () => __shutdown.state().renderer === "ready",
      20000,
    );
    check(
      `the teardown companion renderer is ready before the ${kase} case`,
      ready,
      JSON.stringify(__shutdown.state()),
    );
    if (!ready) return;
    restoreInstall = replaceMethod(
      updaterModule.autoUpdater,
      "quitAndInstall",
      () => {
        installs += 1;
        // BaseUpdater's real method raises this latch while the hand-off is
        // live. The continuation case replaces only that external effect, so
        // retain the observable completion boundary the product uses after
        // quitAndInstall() returns.
        Object.defineProperty(updaterModule.autoUpdater, "quitAndInstallCalled", {
          value: true,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      },
    );
    // Armed through the real updater event, which is the only thing that makes
    // the Install path reachable in the product.
    //
    // AND THE EVENT ONLY MEANS ANYTHING ONCE THE UPDATER EXISTS. main.js
    // attaches its own `update-downloaded` listener inside getAutoUpdater(),
    // which is lazy: nothing in a companion process has pressed Install yet,
    // so emitting the event first sets `downloadedUpdatePath` on nobody and
    // every later press logs "requested with nothing downloaded" and returns
    // before requestShutdown(). Measured - all three cases then reported "no
    // install question open" against a state machine that had never been
    // asked. The priming press is inert by construction for exactly that
    // reason: with nothing downloaded it returns before raising anything,
    // which is the same real initialisation the portable companion uses.
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const updaterArmed = await waitUntil(
      () =>
        !!updaterModule.autoUpdater.requestHeaders &&
        updaterModule.autoUpdater.requestHeaders["x-user-staging-id"] === "",
      10000,
    );
    updaterModule.autoUpdater.emit("update-downloaded", {
      version: "9.9.9-teardown",
      downloadedFile: fileT,
    });
    check(
      `the teardown companion armed the real updater before the ${kase} case`,
      updaterArmed === true &&
        __shutdown.state().pendingId === 0 &&
        rig.dialogs.length === 0,
      JSON.stringify({
        updaterArmed,
        state: __shutdown.state(),
        dialogs: rig.dialogs.length,
      }),
    );
    await exec(`
      (() => {
        const realConfirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = realConfirm;
        }
        const tab = window.CustomTabs.createTab(${JSON.stringify(fileT)}, window.fs.readFileSync(${JSON.stringify(fileT)}, 'utf8'));
        window.CustomTabs.switchToTab(tab.id);
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    await sleep(300);
    __shutdown.reset();
    rig.reset();

    if (kase === "queued") {
      // A close question on screen, an Install press queued behind it, and then
      // the window goes.
      await exec(`
        (() => {
          const tab = window.CustomTabs.getActiveTab();
          tab.content = tab.originalContent + '\\nTEARDOWN_CONSENT_EDIT\\n';
          window.originalMarkdown = tab.content;
          return true;
        })()
      `);
      let releaseDialog = null;
      rig.answer = () =>
        new Promise((resolve) => {
          releaseDialog = resolve;
        });
      const teardownClose = guardEvent();
      win.emit("close", teardownClose);
      const asked = await waitUntil(() => rig.dialogs.length > 0, 15000);
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const queued = await waitUntil(
        () => __shutdown.state().queuedReason === "update-install",
        15000,
      );
      const before = __shutdown.state();
      // THE SETUP IS ASSERTED BEFORE THE ACT. Without this the case can silently
      // measure nothing at all - which is exactly how a previous run reported a
      // teardown result for a scenario that never entered its own setup.
      check(
        "the teardown queued case really has a close question open with an install queued behind it",
        asked === true &&
          queued === true &&
          before.pendingReason === "window-close" &&
          before.queuedReason === "update-install" &&
          rig.dialogs.length === 1,
        JSON.stringify({ asked, queued, before, dialogs: rig.dialogs.length }),
      );
      win.destroy();
      await waitUntil(() => win.isDestroyed(), 10000);
      await sleep(300);
      const after = __shutdown.state();
      // The reader's answer to the dialog arrives after the window has gone. It
      // must decide nothing: the record it belonged to is already settled.
      if (releaseDialog) releaseDialog(0);
      await sleep(400);
      const afterAnswer = __shutdown.state();
      check(
        "a window that disappears declines the update queued behind its close instead of installing it",
        before.queuedReason === "update-install" &&
          after.queuedReason === null &&
          installs === 0 &&
          rig.dialogs.length === 1 &&
          afterAnswer.updateInstallStarted === false,
        JSON.stringify({ before, after, afterAnswer, installs, dialogs: rig.dialogs.length }),
      );
      check(
        "a window that disappears settles the close it was asked about without running its continuation",
        after.pendingId === 0 &&
          after.settleWhy === "window-gone-already-closed" &&
          after.authorized === false &&
          rig.closes === 0 &&
          afterAnswer.pendingId === 0 &&
          afterAnswer.authorized === false &&
          afterAnswer.lastRequestId === before.lastRequestId,
        JSON.stringify({ before, after, afterAnswer, closes: rig.closes }),
      );
      return;
    }

    if (kase === "commit") {
      // A commit in flight when the window goes. A refused commit normally
      // RE-RAISES its intents, which is right while the app is running and
      // wrong at teardown: the fresh question it raises can only be answered by
      // a rule, and the only rule left is the one this must not reach.
      rig.answer = 0;
      await exec(`
        (() => {
          const tab = window.CustomTabs.getActiveTab();
          tab.content = tab.originalContent;
          tab.hasUnsavedChanges = false;
          window.originalMarkdown = tab.originalContent;
          return true;
        })()
      `);
      let commitInFlight = null;
      const destroyDuringCommit = () => {
        if (commitInFlight !== null) return;
        // Sampled BEFORE the window is destroyed, inside the same tick the
        // commit was sent on. This is the setup control: a zero here means the
        // case never entered the state it claims to test.
        commitInFlight = __shutdown.state().commitPendingId;
        win.destroy();
      };
      ipcMain.on("quit-approval-response", destroyDuringCommit);
      let commitClose;
      try {
        commitClose = guardEvent();
        win.emit("close", commitClose);
        await waitUntil(() => win.isDestroyed(), 15000);
        await sleep(500);
      } finally {
        ipcMain.removeListener("quit-approval-response", destroyDuringCommit);
      }
      const state = __shutdown.state();
      check(
        "the teardown commit case really destroyed the window with a commit outstanding",
        commitInFlight !== null && commitInFlight > 0,
        JSON.stringify({ commitInFlight, state }),
      );
      check(
        "a commit in flight when the window goes is abandoned rather than re-raised into a new question",
        commitInFlight > 0 &&
          state.commitRefusedWhy === "window-closed" &&
          state.commitPendingId === 0 &&
          state.pendingId === 0 &&
          rig.dialogs.length === 0 &&
          rig.closes === 0 &&
          installs === 0 &&
          state.authorized === false,
        JSON.stringify({
          commitInFlight,
          state,
          dialogs: rig.dialogs.length,
          closes: rig.closes,
          installs,
          // Recorded, not asserted: destroying the last window reaches the real
          // window-all-closed listener, which calls the rig's non-terminal
          // app.quit stub. That quit is the lifecycle doing its job, not this
          // protocol deciding anything.
          quits: rig.quits,
        }),
      );
      return;
    }

    if (kase === "continuation") {
      // The installed updater's public commit has already received its fresh
      // confirmation, but its final quit is deliberately deferred to a later
      // turn. Destroy the actual owner window in the renderer's commit event
      // between those turns. Suppress only the unrelated all-windows-closed
      // lifecycle listener so its ordinary app.quit does not obscure whether
      // the deferred update continuation ran.
      rig.answer = 1;
      let confirmedUpdateCommit = null;
      const destroyAfterConfirmedCommit = (_event, data) => {
        if (
          !data ||
          data.committed !== true ||
          installs !== 1 ||
          confirmedUpdateCommit !== null
        ) {
          return;
        }
        confirmedUpdateCommit = data;
        win.destroy();
      };
      ipcMain.on("quit-approval-committed", destroyAfterConfirmedCommit);
      const allWindowsClosed = app.listeners("window-all-closed");
      app.removeAllListeners("window-all-closed");
      restoreWindowAllClosed = () => {
        for (const listener of allWindowsClosed) app.on("window-all-closed", listener);
      };
      try {
        await exec(`window.ipcRenderer.send('install-update'); null;`);
        const updaterEntered = await waitUntil(() => installs === 1, 15000);
        // The public boundary and its updater-owned app.quit are one
        // synchronous lifecycle pair. Drive both before waiting for the fresh
        // approval; otherwise the production one-turn expiry correctly
        // classifies this as a boundary that never handed off.
        electronAutoUpdater.emit("before-quit-for-update");
        app.emit("before-quit", guardEvent());
        const updaterLifecycleQuit = guardEvent();
        app.emit("before-quit", updaterLifecycleQuit);
        const initialUpdaterQuitHeld = updaterLifecycleQuit.prevented === true;
        const closedBeforeContinuation = await waitUntil(
          () => win.isDestroyed(),
          15000,
        );
        const continuationInvalidated = await waitUntil(
          () => __shutdown.state().updaterInvalidatedContinuationCount === 1,
          5000,
        );
        const state = __shutdown.state();
        check(
          "a closed owner window invalidates a confirmed deferred update continuation before it can quit",
          updaterEntered &&
            !!confirmedUpdateCommit &&
            initialUpdaterQuitHeld &&
            closedBeforeContinuation &&
            continuationInvalidated &&
            installs === 1 &&
            rig.quits === 0 &&
            rig.closes === 0 &&
            state.pendingId === 0 &&
            state.commitPendingId === 0 &&
            state.authorized === false &&
            state.updateInstallStarted === true &&
            state.updaterShutdownCancelWhy === "window-closed",
          JSON.stringify({
            updaterEntered,
            confirmedUpdateCommit,
            initialUpdaterQuitHeld,
            updaterLifecycleQuitPrevented: updaterLifecycleQuit.prevented,
            closedBeforeContinuation,
            continuationInvalidated,
            installs,
            closes: rig.closes,
            quits: rig.quits,
            state,
          }),
        );
      } finally {
        ipcMain.removeListener(
          "quit-approval-committed",
          destroyAfterConfirmedCommit,
        );
      }
      return;
    }

    // An updater can fail after its initial approval but before its queued
    // lifecycle boundary. Destroy the owner, then drive the exact native
    // before-quit-for-update/app.quit pair: this must be consumed as the
    // poisoned updater attempt, not accepted by ordinary no-window policy.
    if (kase === "poisoned") {
      rig.answer = 0;
      rig.driveQuitLifecycle = true;
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const attemptStarted = await waitUntil(
        () => installs === 1 && __shutdown.state().updaterInstallAttemptId > 0,
        15000,
      );
      const beforeError = __shutdown.state();
      updaterModule.autoUpdater.emit("error", new Error("controlled no-window updater failure"));
      const poisoned = __shutdown.state();
      // The ordinary window-all-closed quit is not the updater pair under
      // test. Suppress it so the only app.quit is the poisoned boundary below.
      const allWindowsClosed = app.listeners("window-all-closed");
      app.removeAllListeners("window-all-closed");
      restoreWindowAllClosed = () => {
        for (const listener of allWindowsClosed) app.on("window-all-closed", listener);
      };
      win.destroy();
      const ownerGone = await waitUntil(() => win.isDestroyed(), 10000);
      electronAutoUpdater.emit("before-quit-for-update");
      const boundaryArmed = __shutdown.state().updaterQuitBoundaryAttemptId ===
        beforeError.updaterInstallAttemptId;
      app.quit();
      const boundaryConsumed = await waitUntil(
        () =>
          __shutdown.state().updaterInstallAttemptId === 0 &&
          __shutdown.state().updaterQuitBoundaryAttemptId === 0,
        5000,
      );
      const state = __shutdown.state();
      check(
        "a poisoned updater boundary with no owner window is intercepted instead of passing ordinary no-window quit policy",
        attemptStarted &&
          beforeError.updaterInstallAttemptId > 0 &&
          poisoned.updaterInstallAttemptId === beforeError.updaterInstallAttemptId &&
          poisoned.updaterInstallAttemptPoisoned === true &&
          ownerGone &&
          boundaryArmed &&
          boundaryConsumed &&
          rig.quits === 1 &&
          rig.quitEvents.length === 1 &&
          rig.quitEvents[0].prevented === true &&
          state.pendingId === 0 &&
          state.authorized === false &&
          state.updateInstallStarted === false,
        JSON.stringify({
          attemptStarted,
          beforeError,
          poisoned,
          ownerGone,
          boundaryArmed,
          boundaryConsumed,
          quits: rig.quits,
          quitEvents: rig.quitEvents,
          state,
        }),
      );
      return;
    }

    // kase === "pending": an Install press with its question still on screen,
    // and then the window disappears. The old handler re-dispatched it "on its
    // own terms", which with no window left meant the automatic approval - so
    // the disappearance installed it.
    //
    // THE QUESTION ONLY EXISTS IF THERE IS SOMETHING TO LOSE. A clean document
    // answers `dirtyFiles: []`, which settles the request "clean" without ever
    // reaching a dialog - the press is then approved and the update installs
    // immediately, and this case measures a machine that was never asked.
    // Measured exactly that way before the edit below existed. The `queued`
    // case dirties its document for the same reason; this one had been relying
    // on a question that could not be raised.
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent + '\\nTEARDOWN_PENDING_EDIT\\n';
        window.originalMarkdown = tab.content;
        return true;
      })()
    `);
    let releasePendingDialog = null;
    rig.answer = () =>
      new Promise((resolve) => {
        releasePendingDialog = resolve;
      });
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const pendingAsked = await waitUntil(() => rig.dialogs.length > 0, 15000);
    const before = __shutdown.state();
    check(
      "the teardown pending case really has an update install question open",
      pendingAsked === true &&
        before.pendingReason === "update-install" &&
        rig.dialogs.length === 1,
      JSON.stringify({ pendingAsked, before, dialogs: rig.dialogs.length }),
    );
    win.destroy();
    await waitUntil(() => win.isDestroyed(), 10000);
    await sleep(300);
    const after = __shutdown.state();
    if (releasePendingDialog) releasePendingDialog(0);
    await sleep(400);
    const afterAnswer = __shutdown.state();
    check(
      "a window that disappears refuses the update install it was still being asked about",
      before.pendingReason === "update-install" &&
        after.pendingId === 0 &&
        after.settleWhy === "window-gone-updater" &&
        rig.dialogs.length === 1 &&
        installs === 0 &&
        afterAnswer.authorized === false &&
        afterAnswer.updateInstallStarted === false,
      JSON.stringify({ before, after, afterAnswer, dialogs: rig.dialogs.length, installs }),
    );
  } finally {
    if (restoreWindowAllClosed) restoreWindowAllClosed();
    if (restoreInstall) restoreInstall();
    restoreUpdaterLatch();
    rig.restore();
    __shutdown.reset();
  }
}

// HOW LONG A COMPANION IS GIVEN, AND WHY THE PARENT'S KILL IS THE OUTER ONE.
//
// Each companion runs this same file, so it carries its own watchdog (see the
// whenReady tail) which prints a TIMED OUT summary and exits non-zero. That is
// the outcome worth having: the revert audit reads assertion NAMES out of the
// companion transcript, and a companion the parent shot produces no summary
// line at all, so the whole catalogue underneath it is reported as truncated
// rather than as a result. The parent's timer is therefore a backstop for a
// companion too wedged to run its own timer - a native modal blocks the main
// process, and a blocked main process cannot fire a setTimeout - and it sits
// ABOVE the companion's watchdog rather than below it.
//
// THE 90s THAT WAS HERE WAS BELOW THE WORK, not above the watchdog. The
// portable companion runs the emitted batch for real: three live cmd.exe cases
// with 20s, 25s and 30s budgets plus a 9s non-vacuity hold, on top of two
// fail-closed hand-off deadlines of 15s and 5s. It was killed mid-liveness on
// a HEALTHY run, which is also where the leftover mdv-e2e-* trees came from -
// a killed process sweeps nothing.
const COMPANION_WATCHDOG_MS = { portable: 300000, teardown: 120000 };
const COMPANION_BUDGET_MS = {
  portable: COMPANION_WATCHDOG_MS.portable + 30000,
  teardown: COMPANION_WATCHDOG_MS.teardown + 30000,
};
// How long a killed companion is given to actually die, and how long a dead one
// is given to finish flushing its pipes. Both are real wall clock the parent
// spends, so both are named here and BOTH are added into the suite watchdog
// below rather than being absorbed silently into its slack.
const COMPANION_KILL_GRACE_MS = 10000;
const COMPANION_DRAIN_GRACE_MS = 5000;
// Spawn, the ownership-scoped removal after each companion, and the loop around
// them. Small, but it is the difference between a watchdog that is a bound and
// one that is nearly a bound.
const COMPANION_SEQUENCING_MS = 5000;
// The parent's own tail after its last assertion: a failure screenshot and the
// registered temp-directory sweep. Counted, so the watchdog cannot fire between
// the summary line and the cleanup that follows it.
const SUITE_TAIL_MS = 30000;
const companionWallClockMs = (budgetMs) =>
  budgetMs +
  COMPANION_KILL_GRACE_MS +
  COMPANION_DRAIN_GRACE_MS +
  COMPANION_SEQUENCING_MS;

const COMPANION_ASSERTION_TOTALS = {
  portable: 44,
  teardown: { queued: 9, commit: 8, pending: 8, continuation: 7, poisoned: 7 },
};

// ONE SPAWNER FOR BOTH COMPANIONS. They differed only in their environment and
// their budget, and the things that were wrong with them - a kill that did not
// wait for the process to actually go, a scratch directory nobody removed when
// it did not, and an exit code standing in for a result - were wrong in both
// copies.
//
// WHAT "COMPLETED" MEANS HERE, and it is not the exit code. A companion prints
// its own `=== N/M passed ===` footer, and that footer is the only statement
// that the run reached its own end: an exit code cannot distinguish a suite
// that passed from one that died after its last assertion, and the revert
// audit treats a missing footer as a TRUNCATED catalogue rather than a result.
// So the parent parses the child's footer and its raw FAIL lines and reconciles
// them with its own single assertion, rather than asserting `code === 0` and
// leaving the child's own accounting unreferenced beside it.
function summariseCompanionTranscript(text) {
  // Footers are an exact transport contract. Trimming would turn a malformed
  // child transcript into a terminal accounting that this parent never saw.
  const lines = text.split(/\r?\n/);
  const passedFooterRecord =
    /^=== ([1-9]\d*)\/([1-9]\d*) passed(?:; ([1-9]\d*) unavailable)? ===$/;
  const timedOutFooterRecord =
    /^=== TIMED OUT after (?:0|[1-9]\d*)\/(?:0|[1-9]\d*) checks ===$/;
  const recognizedNonFooterBanners = new Set(["=== Application started ==="]);
  const protocolText = "\\S(?:.*\\S)?";
  const passRecord = new RegExp(`^PASS  (${protocolText})$`);
  const failureRecord = new RegExp(`^FAIL  (${protocolText})  -> (${protocolText})$`);
  const unavailableRecord = new RegExp(
    `^UNAVAILABLE  (${protocolText})  -> (${protocolText})$`,
  );
  const protocolPrefix = (line) =>
    line.trimStart().startsWith("PASS") ||
    line.trimStart().startsWith("FAIL") ||
    line.trimStart().startsWith("UNAVAILABLE");
  // COUNTED, NOT PICKED. Taking the last footer accepts a transcript with two
  // of them, and two terminal accountings in one companion is not a companion
  // that finished twice - it is a transcript this parent cannot attribute, and
  // the revert audit reads names out of exactly these bytes. A `TIMED OUT`
  // footer is collected separately and can never satisfy the assertion: its
  // numbers read as N === M whenever the run wedged after its last assertion,
  // which is the precise confusion this reconciliation exists to remove.
  const passedFooters = lines
    .map((line) => passedFooterRecord.exec(line))
    .filter(Boolean);
  const timedOutFooters = lines.filter((line) => timedOutFooterRecord.test(line));
  const only = passedFooters.length === 1 ? passedFooters[0] : null;
  const footerIndex = only ? lines.indexOf(only[0]) : -1;
  // `main.js` emits this exact startup banner into every Electron child
  // transcript. It is preamble only; every fenced line after the definitive
  // passed footer is malformed, even if it is this otherwise known banner.
  const footerLikeSummary = (line) =>
    /^(?:\s*===\s*(?:\d+\s*\/\s*\d+|TIMED\s*OUT\b)|\s*(?:\d+\s*\/\s*\d+\s+(?:passed|unavailable)\b|TIMED\s*OUT\b).*===\s*$)/i.test(line);
  const malformedFooterLines = lines.filter((line, index) =>
    (/^\s*===/.test(line) || footerLikeSummary(line)) &&
    (!recognizedNonFooterBanners.has(line) ||
      (footerIndex >= 0 && index > footerIndex)) &&
    !passedFooterRecord.test(line) &&
    !timedOutFooterRecord.test(line));
  const assertionLines = footerIndex < 0 ? [] : lines.slice(0, footerIndex);
  const postFooterAssertions =
    footerIndex < 0 ? [] : lines.slice(footerIndex + 1).filter(protocolPrefix);
  const malformedProtocolLines = lines.filter((line) =>
    protocolPrefix(line) &&
    !passRecord.test(line) &&
    !failureRecord.test(line) &&
    !unavailableRecord.test(line));
  return {
    passedFooters: passedFooters.map((match) => match[0]),
    timedOutFooters,
    malformedFooterLines,
    passed: only ? Number(only[1]) : null,
    total: only ? Number(only[2]) : null,
    unavailable: only ? Number(only[3] || 0) : null,
    // The child's OWN failure names, not a byte tail. A tail can cut a failure
    // in half; these are what the parent's detail has to carry so a companion
    // failure is readable without re-running it.
    failures: assertionLines
      .map((line) => failureRecord.exec(line))
      .filter(Boolean)
      .map((match) => match[1]),
    passedAssertions: assertionLines.filter((line) => passRecord.test(line)),
    unavailableAssertions: assertionLines
      .filter((line) => unavailableRecord.test(line))
      .map((line) => unavailableRecord.exec(line)[1]),
    malformedUnavailableAssertions: assertionLines.filter((line) =>
      line.startsWith("UNAVAILABLE") && !unavailableRecord.test(line)),
    malformedProtocolLines,
    postFooterAssertions,
  };
}

function reconcileCompanionCompletion({ code, timedOut, error, closeObserved, transcript, expectedTotal }) {
  const footerComplete =
    closeObserved === true &&
    !timedOut &&
    !error &&
    transcript.passedFooters.length === 1 &&
    transcript.timedOutFooters.length === 0 &&
    transcript.malformedFooterLines.length === 0 &&
    transcript.total === expectedTotal &&
    transcript.passed === transcript.total &&
    transcript.failures.length === 0;
  const assertionAccounting =
    transcript.postFooterAssertions.length === 0 &&
    transcript.malformedProtocolLines.length === 0 &&
    transcript.malformedUnavailableAssertions.length === 0 &&
    transcript.passedAssertions.length + transcript.failures.length ===
      transcript.total &&
    transcript.unavailableAssertions.length === transcript.unavailable;
  if (footerComplete && assertionAccounting && code === 0 && transcript.unavailable === 0) {
    return { kind: "passed", valid: true };
  }
  if (footerComplete && assertionAccounting && code === 2 && transcript.unavailable > 0) {
    return { kind: "unavailable", valid: true };
  }
  return { kind: "invalid", valid: false };
}

function relayCompanionOutput(child, output) {
  const streamErrors = [];
  for (const [name, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ]) {
    if (!stream || typeof stream.on !== "function") {
      streamErrors.push({ stream: name, error: "stream was unavailable" });
      continue;
    }
    // Keep this listener for the stream's whole lifetime. A second error is
    // still an EventEmitter "error" event and would otherwise become an
    // uncaught exception after the first one had been observed.
    stream.on("error", (error) => {
      streamErrors.push({
        stream: name,
        error: String((error && error.code) || error),
      });
    });
    stream.on("data", (chunk) => {
      const text = String(chunk);
      output.push(text);
      // Byte-for-byte, at column zero: the revert harness reads these
      // assertion names out of this transcript, and a transport prefix would
      // make a real companion failure invisible to that audit.
      process.stdout.write(text);
    });
  }
  return streamErrors;
}

/**
 * @returns {boolean} whether the companion process is CONFIRMED gone. False
 *   stops the caller from starting another one: an un-killable Electron is the
 *   one condition under which a second companion would be racing a first that
 *   still holds handles, which is the failure this whole seam exists to end.
 */
/**
 * The companion settlement state machine, over ANY child-like emitter.
 *
 * Extracted from runCompanion so it can be driven directly by the assertions in
 * runCompanionSettlementScenarios(). Every branch here is a failure path - a
 * kill that threw, an exit whose pipes never closed, an error after a
 * successful spawn - and none of them occur on a healthy run, so left inline
 * they were reachable only by deliberately breaking the harness by hand. A
 * control that is only ever exercised by hand is a control that regresses.
 *
 * SETTLED ON `close`, NOT ON `exit`. `exit` says the process ended; `close`
 * says the process ended AND its stdout/stderr pipes are fully drained.
 * Reading the transcript on `exit` reads whatever had arrived by then, so a
 * footer still sitting in the pipe reads as a companion that never printed one.
 * `exit` is still observed, because "the process is gone" and "the bytes are
 * all here" are different facts and the caller needs both.
 *
 * TERMINATION IS THE `close` EVENT AND NOTHING ELSE. A pipe that is still open
 * is a handle somebody still holds - a grandchild that inherited it, most
 * plausibly. Treating `exit` as termination would let the caller delete a tree
 * and start another Electron while that handle is live. The only other safely
 * terminal outcome is a spawn that never created a process at all, and that is
 * recorded separately rather than folded in.
 *
 * ONE LISTENER PER EVENT, and that is not incidental. Registering a second
 * `exit`/`close` listener from inside the timeout is a race against the first:
 * the original was registered earlier so it wins, and a killed companion would
 * then be reported as a clean non-timeout exit. The timeout raises a FLAG and
 * the single listener reads it.
 */
function awaitCompanionProcess(child, budgets) {
  return new Promise((resolve) => {
    let settled = false;
    let settleCount = 0;
    let timeout = null;
    let killGrace = null;
    let drainGrace = null;
    const settle = (value) => {
      settleCount += 1;
      if (settled) return;
      settled = true;
      // A drain timeout is terminal for the parent: keeping the original
      // watchdog alive after returning would kill a child that this function
      // has already reported as unconfirmed, potentially racing subsequent
      // diagnostics. The event listeners deliberately remain installed so
      // the late-event assertions can prove this guard, but no timer may take
      // another action after settlement.
      if (timeout) clearTimeout(timeout);
      if (killGrace) clearTimeout(killGrace);
      if (drainGrace) clearTimeout(drainGrace);
      resolve({ ...value, settleCount: () => settleCount });
    };
    let killRequested = false;
    let exited = false;
    let exitCode = null;
    let postSpawnError = null;
    let killThrew = false;
    const startDrainGrace = () => {
      if (settled || drainGrace) return;
      drainGrace = setTimeout(
        () =>
          settle({
            code: exitCode,
            timedOut: killRequested,
            closeObserved: false,
            processNeverStarted: false,
            exited,
            killThrew,
            error: postSpawnError,
          }),
        budgets.drainGraceMs,
      );
    };
    timeout = setTimeout(() => {
      killRequested = true;
      try {
        child.kill();
      } catch (error) {
        // A kill that THREW is a live process this parent could not stop.
        // Recorded, never treated as termination.
        killThrew = true;
        postSpawnError = error;
      }
      killGrace = setTimeout(
        () =>
          settle({
            code: exitCode,
            timedOut: true,
            closeObserved: false,
            processNeverStarted: false,
            exited,
            killThrew,
            error: postSpawnError,
          }),
        budgets.killGraceMs,
      );
    }, budgets.budgetMs);
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
      // The process reports itself gone, so neither the main watchdog nor a
      // kill grace may act on it. What is left is only the pipes, which get
      // their own smaller budget. A `close` that never arrives still fails
      // closed - `exited` is recorded for the diagnosis, not as permission.
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (killGrace) {
        clearTimeout(killGrace);
        killGrace = null;
      }
      startDrainGrace();
    });
    child.once("error", (error) => {
      // A SPAWN THAT NEVER STARTED A PROCESS IS NOT A PROCESS THAT MIGHT STILL
      // BE RUNNING. Node leaves `pid` undefined when the spawn itself failed
      // (ENOENT, EACCES), and in that case there is nothing holding the profile
      // or the scratch tree, so the run is safely terminal and the next
      // companion may start. `error` can also fire AFTER a successful spawn -
      // a kill that failed, an I/O fault on the pipes - and that is a live
      // process; it must wait for the `close` that says otherwise, and fail
      // closed if it never comes.
      if (!child.pid) {
        clearTimeout(timeout);
        if (killGrace) clearTimeout(killGrace);
        if (drainGrace) clearTimeout(drainGrace);
        settle({
          code: null,
          timedOut: killRequested,
          closeObserved: false,
          processNeverStarted: true,
          exited,
          killThrew,
          error,
        });
        return;
      }
      postSpawnError = error;
      startDrainGrace();
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killGrace) clearTimeout(killGrace);
      if (drainGrace) clearTimeout(drainGrace);
      settle({
        code: code === null ? exitCode : code,
        timedOut: killRequested,
        closeObserved: true,
        processNeverStarted: false,
        exited,
        killThrew,
        error: postSpawnError,
      });
    });
  });
}

/**
 * The owned removal, over any directory. Extracted for the same reason as
 * awaitCompanionProcess(): "already absent" and "preserved because the process
 * is still alive" are the two outcomes that matter most and neither happens on
 * a healthy run.
 */
function resolveCompanionScratch(scratchDir, terminationConfirmed, ownerRoot) {
  if (!scratchDir) {
    return {
      existedBefore: null,
      removed: false,
      preserved: false,
      error: "no scratch directory was assigned",
    };
  }
  // Skipped entirely when the process was not confirmed gone: removing a tree
  // out from under a live Electron is how a diagnosable hang becomes an
  // unreadable one, and the tree is the evidence.
  if (!terminationConfirmed) {
    return {
      existedBefore: null,
      removed: false,
      preserved: true,
      error: "companion not confirmed terminated; tree kept for diagnosis",
    };
  }
  const validated = validateCompanionScratch(scratchDir, ownerRoot);
  if (!validated.ok) {
    return {
      existedBefore: null,
      removed: false,
      preserved: true,
      error: validated.error,
      validation: validated,
    };
  }
  scratchDir = validated.scratchDir;
  // AND "ALREADY ABSENT" IS A FAILURE, NOT A SUCCESS. The parent created this
  // directory before the spawn and the companion is forbidden to delete it, so
  // finding it missing means something outside this ownership removed it - a
  // stray sweep, a concurrent suite, a companion that broke the rule. Reporting
  // that as a clean removal is how an ownership violation becomes invisible, so
  // the removal asserts BOTH halves: present immediately before, absent
  // immediately after.
  const existedBefore = fs.existsSync(scratchDir);
  if (!existedBefore) {
    return {
      existedBefore: false,
      removed: false,
      preserved: false,
      error:
        "assigned scratch directory was already gone before the owned removal",
    };
  }
  try {
    fs.rmSync(scratchDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    // STRICTLY BOOLEAN, and re-read from disk. A caught error used to be
    // recorded as its own message string here, and a non-empty string is
    // truthy - so an EPERM was reported in the detail and then accepted by the
    // assertion beside it. The removal either left nothing behind or it did
    // not; the reason lives in its own field.
    const removed = !fs.existsSync(scratchDir);
    return {
      existedBefore: true,
      removed,
      preserved: false,
      error: removed ? null : "still present after rmSync",
    };
  } catch (error) {
    return {
      existedBefore: true,
      removed: false,
      preserved: false,
      error: String((error && error.code) || error),
    };
  }
}

// Trees this run has deliberately NOT removed because the companion holding
// them could not be confirmed gone. The parent's finalizer reads this: sweeping
// its root would destroy in-root evidence, while an external child root is
// retained and named for diagnosis.
const PRESERVED_COMPANION_DIRS = [];

async function runCompanion(options) {
  const childProcess = require("child_process");
  const output = [];
  const scratchValidation = validateCompanionScratch(options.scratchDir, dir);
  if (!scratchValidation.ok) {
    check(
      options.name,
      false,
      JSON.stringify({
        scratchDir: options.scratchDir || null,
        scratchValidation,
      }),
    );
    return false;
  }
  const envScratchValidation =
    options.env && options.env.F22_COMPANION_DIR
      ? validateCompanionScratch(options.env.F22_COMPANION_DIR, dir)
      : null;
  if (
    envScratchValidation &&
    (!envScratchValidation.ok ||
      canonicalPathKey(envScratchValidation.scratchDir) !==
        canonicalPathKey(scratchValidation.scratchDir))
  ) {
    check(
      options.name,
      false,
      JSON.stringify({
        scratchDir: options.scratchDir,
        envScratchDir: options.env.F22_COMPANION_DIR,
        envScratchValidation,
        scratchValidation,
        error: "F22_COMPANION_DIR did not name the parent's validated scratch directory",
      }),
    );
    return false;
  }
  const scratchDir = scratchValidation.scratchDir;
  // CREATED BY THE OWNER, BEFORE THE SPAWN. The removal below asserts the tree
  // was there immediately before it ran, and that claim is only meaningful if
  // this parent is the thing that put it there.
  if (scratchDir) {
    try {
      fs.mkdirSync(scratchDir, { recursive: true });
    } catch (error) {
      // Surfaced by existedBefore, which is read from disk.
    }
  }
  // A SYNCHRONOUS SPAWN THROW MUST NOT SKIP THIS ASSERTION. spawn() throws
  // rather than emitting for a bad options object - a non-string env value, an
  // unrepresentable cwd - and an escaping throw is caught by the generic
  // "harness threw" handler at the tail. The companion's own name would then
  // never execute, and the revert audit reports an unreached catalogue entry,
  // which is indistinguishable from a name somebody deleted. Nothing was
  // started, so it settles exactly like the asynchronous ENOENT does.
  let child = null;
  let spawnThrew = null;
  try {
    child = childProcess.spawn(process.execPath, [__filename], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        ...options.env,
        F22_COMPANION_DIR: scratchDir,
        F22_COMPANION_OWNER_ROOT: scratchValidation.ownerRoot,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    spawnThrew = error;
  }
  let result;
  let streamErrors = [];
  if (spawnThrew) {
    result = {
      code: null,
      timedOut: false,
      closeObserved: false,
      processNeverStarted: true,
      exited: false,
      killThrew: false,
      error: spawnThrew,
      settleCount: () => 1,
    };
  } else {
    streamErrors = relayCompanionOutput(child, output);
    result = await awaitCompanionProcess(child, {
      budgetMs: options.budgetMs,
      killGraceMs: COMPANION_KILL_GRACE_MS,
      drainGraceMs: COMPANION_DRAIN_GRACE_MS,
    });
  }
  // Confirmed gone means the pipes closed, or no process was ever created.
  const terminationConfirmed =
    result.closeObserved === true || result.processNeverStarted === true;
  // OWNERSHIP-SCOPED, AND ONLY OVER A CORPSE. See resolveCompanionScratch():
  // this removes the one directory this parent CREATED for this companion and
  // nothing else - no glob over the shared temp directory, which would be a
  // test deleting other processes' state on a machine it does not own.
  const scratch = resolveCompanionScratch(
    scratchDir,
    terminationConfirmed,
    scratchValidation.ownerRoot,
  );
  if (scratch.preserved && scratchDir) {
    PRESERVED_COMPANION_DIRS.push(scratchDir);
  }
  const scratchExistedBefore = scratch.existedBefore;
  const scratchRemoved = scratch.removed;
  const scratchPreserved = scratch.preserved;
  const scratchError = scratch.error;
  const transcript = summariseCompanionTranscript(output.join(""));
  const completion = reconcileCompanionCompletion({
    code: result.code,
    timedOut: result.timedOut,
    error: result.error,
    closeObserved: result.closeObserved,
    transcript,
    expectedTotal: options.expectedTotal,
  });
  const completedUnavailable =
    completion.kind === "unavailable" &&
    streamErrors.length === 0 &&
    scratchExistedBefore === true &&
    scratchRemoved === true;
  if (completedUnavailable) {
    unavailable(
      options.name,
      JSON.stringify({
        code: result.code,
        companionPassedFooters: transcript.passedFooters,
        companionPassed: transcript.passed,
        companionTotal: transcript.total,
        companionUnavailable: transcript.unavailable,
      }),
    );
    return terminationConfirmed;
  }
  check(
    options.name,
    completion.kind === "passed" &&
      // The child's own accounting has to agree, exactly once. Without this the
      // parent is asserting "the process ended well", which is not the same
      // claim as "every check in it ran and passed".
      transcript.passedFooters.length === 1 &&
      transcript.timedOutFooters.length === 0 &&
      transcript.total === options.expectedTotal &&
      transcript.passed === transcript.total &&
      transcript.unavailable === 0 &&
      transcript.failures.length === 0 &&
      streamErrors.length === 0 &&
      scratchExistedBefore === true &&
      scratchRemoved === true,
    JSON.stringify({
      code: result.code,
      timedOut: result.timedOut,
      closeObserved: result.closeObserved,
      processNeverStarted: result.processNeverStarted,
      exitObserved: result.exited === true,
      terminationConfirmed,
      error: result.error && String(result.error),
      companionPassedFooters: transcript.passedFooters,
      companionTimedOutFooters: transcript.timedOutFooters,
      companionPassed: transcript.passed,
      companionTotal: transcript.total,
      companionUnavailable: transcript.unavailable,
      companionFailures: transcript.failures,
      streamErrors,
      expectedTotal: options.expectedTotal,
      scratchDir,
      scratchExistedBefore,
      scratchRemoved,
      scratchPreserved,
      scratchError,
      tail: output.join("").slice(-2000),
    }),
  );
  return terminationConfirmed;
}

async function runTeardownCompanion() {
  const cases = ["queued", "commit", "pending", "continuation", "poisoned"];
  for (let index = 0; index < cases.length; index += 1) {
    const kase = cases[index];
    const scratchDir = path.join(dir, `companion-teardown-${kase}`);
    const gone = await runCompanion({
      name: `the isolated ${kase} teardown companion completed its window-destroying case`,
      budgetMs: COMPANION_BUDGET_MS.teardown,
      scratchDir,
      expectedTotal: COMPANION_ASSERTION_TOTALS.teardown[kase],
      env: {
        F22_TEARDOWN_CASE: kase,
        // See companionScratchDir(): the parent owns the directory so that a
        // killed companion cannot leave one behind.
        F22_COMPANION_DIR: scratchDir,
      },
    });
    if (gone) continue;
    // FAIL CLOSED, AND SAY SO FOR EVERY CASE THAT WILL NOT RUN. A companion
    // that survived its own kill is still holding an Electron profile and a
    // scratch tree, and starting the next one against that is the concurrent-
    // Electron condition every one of these companions exists to avoid. The
    // remaining names are still EMITTED as failures rather than skipped: a name
    // the audit never sees is reported as an unreached catalogue entry, which
    // is indistinguishable from a name that was deleted.
    for (const skipped of cases.slice(index + 1)) {
      check(
        `the isolated ${skipped} teardown companion completed its window-destroying case`,
        false,
        JSON.stringify({
          notStarted: true,
          reason: `the ${kase} companion could not be confirmed terminated, so starting another Electron against this repo would be the concurrency this suite forbids`,
        }),
      );
    }
    return;
  }
}

/**
 * Emit every teardown companion name as an explicit failure without starting
 * any of them. Used when an earlier companion could not be confirmed gone.
 */
function skipTeardownCompanions(blockedBy) {
  // FAIL CLOSED, AND SAY SO FOR EVERY CASE THAT WILL NOT RUN. A companion that
  // survived its own kill is still holding an Electron profile and a scratch
  // tree, and starting the next one against that is the concurrent-Electron
  // condition every one of these companions exists to avoid. The remaining
  // names are still EMITTED as failures rather than skipped: a name the audit
  // never sees is reported as an unreached catalogue entry, which is
  // indistinguishable from a name somebody deleted.
  for (const kase of ["queued", "commit", "pending", "continuation", "poisoned"]) {
    check(
      `the isolated ${kase} teardown companion completed its window-destroying case`,
      false,
      JSON.stringify({
        notStarted: true,
        reason: `the ${blockedBy} companion could not be confirmed terminated, so starting another Electron against this repo would be the concurrency this suite forbids`,
      }),
    );
  }
}

function skipPortableAndTeardownCompanions(blockedBy) {
  check(
    "the isolated portable updater companion completed every live hand-off check",
    false,
    JSON.stringify({
      notStarted: true,
      reason: `the ${blockedBy} companion could not be confirmed terminated, so starting another Electron against this repo would be the concurrency this suite forbids`,
    }),
  );
  skipTeardownCompanions(blockedBy);
}

// ============================================================
// THE COMPANION SEAM'S OWN FAILURE PATHS, DRIVEN DIRECTLY
// ============================================================
//
// None of these happen on a healthy run, which is exactly why they need tests:
// a kill that throws, an exit whose pipes never close, an error after a
// successful spawn, a second settlement arriving after the first. Every one of
// them was previously reachable only by editing the harness by hand, and a
// control that is only ever exercised by hand is a control that regresses. The
// child is a plain EventEmitter here - no process is started - so the whole
// block costs a couple of seconds and can assert the branches a real companion
// reaches only when something has already gone wrong.
async function runCompanionSettlementScenarios() {
  const startupBanner = "=== Application started ===\n";
  const unavailableFooter = summariseCompanionTranscript(
    startupBanner +
      "PASS  retained check\nUNAVAILABLE  first  -> detail\nUNAVAILABLE  second  -> detail\n=== 1/1 passed; 2 unavailable ===\n",
  );
  const malformedUnavailableFooters = [
    " === 1/1 passed; 1 unavailable ===",
    "=== 1/1 passed; 0 unavailable ===",
    "=== 1/1 passed; 1 unavailable === ",
  ].every((footer) =>
    summariseCompanionTranscript(footer).passedFooters.length === 0,
  );
  const completeFooter = summariseCompanionTranscript(
    startupBanner + "PASS  retained check\n=== 1/1 passed ===\n",
  );
  const timedOutFooter = summariseCompanionTranscript(
    startupBanner + "PASS  retained check\n=== TIMED OUT after 1/2 checks ===\n",
  );
  const malformedTimedOutFooterTranscripts = [
    "=== TIMED OUT after 1/2 checks === ",
    "=== TIMED OUT after 1/2 check ===",
  ].map((footer) =>
    summariseCompanionTranscript(
      startupBanner + "PASS  retained check\n" + footer + "\n",
    ));
  const malformedPostFooterSummaries = [
    " 1/1 passed ===",
    " 0/1 passed; 3 unavailable ===",
    " TIMED OUT after 0/1 checks ===",
    "=== TIMEDOUT after 0/1 checks ===",
  ].map((summary) =>
    summariseCompanionTranscript(
      "PASS  retained check\n=== 1/1 passed ===\n" + summary + "\n",
    ));
  const postFooterPass = summariseCompanionTranscript(
    "PASS  retained check\n=== 1/1 passed ===\nPASS  unaccounted\n",
  );
  const postFooterUnavailable = summariseCompanionTranscript(
    "PASS  retained check\n=== 1/1 passed ===\nUNAVAILABLE  unaccounted\n",
  );
  const countMismatch = summariseCompanionTranscript(
    "PASS  retained check\n=== 2/2 passed ===\n",
  );
  const malformedProtocolTranscripts = [
    "PASS retained check\n=== 1/1 passed ===\n",
    "FAIL  retained check -> detail\n=== 1/1 passed ===\n",
    "UNAVAILABLE first -> detail\n=== 1/1 passed; 1 unavailable ===\n",
    "UNAVAILABLE  first -> detail\n=== 1/1 passed; 1 unavailable ===\n",
    "UNAVAILABLE  first  -> \n=== 1/1 passed; 1 unavailable ===\n",
    "UNAVAILABLE   first  -> detail\n=== 1/1 passed; 1 unavailable ===\n",
    "UNAVAILABLE  first  ->   \n=== 1/1 passed; 1 unavailable ===\n",
    " PASS  retained check\n=== 1/1 passed ===\n",
    "PASS  retained check\n=== 1/1 passed ===\nFAIL retained check\n",
  ].map((text) => summariseCompanionTranscript(text));
  const malformedFooterTranscripts = [
    "PASS  retained check\n=== 1/1 passed; 0 unavailable ===\n",
    "PASS  retained check\n=== 1/1 passed === \n",
    "PASS  retained check\n=== 1/1 passed ===\n=== 1/1 passed ===\n",
    "PASS  retained check\n=== 1/1 passed ===\n=== 1/1 passed === \n",
    "PASS  retained check\n=== 1/1 passed ===\n === 1/1 passed ===\n",
  ].map((text) => summariseCompanionTranscript(text));
  const leadingZeroFooterTranscripts = [
    "PASS  retained check\n=== 01/01 passed ===\n",
    "PASS  retained check\n=== 1/01 passed ===\n",
    "PASS  retained check\n=== 01/1 passed ===\n",
  ].map((text) => summariseCompanionTranscript(text));
  const leadingZeroFootersRejected = leadingZeroFooterTranscripts.every(
    (transcript) =>
      transcript.passedFooters.length === 0 &&
      transcript.malformedFooterLines.length === 1 &&
      reconcileCompanionCompletion({
        code: 0, timedOut: false, error: null, closeObserved: true,
        transcript, expectedTotal: 1,
      }).kind === "invalid",
  );
  const reviewerReproFooterTranscripts = [
    "PASS  retained check\n=== 1/1 passed ===\n=== passed 1/1 ===\n",
    "PASS  retained check\n=== 1/1 passed ===\n=== unavailable 1/1 ===\n",
  ].map((text) => summariseCompanionTranscript(text));
  const arbitraryFencedSummaryTranscripts = [
    "=== bogus ===\nPASS  retained check\n=== 1/1 passed ===\n",
    "PASS  retained check\n=== 1/1 passed ===\n=== bogus ===\n",
  ].map((text) => summariseCompanionTranscript(text));
  const postFooterStartupBanner = summariseCompanionTranscript(
    "PASS  retained check\n=== 1/1 passed ===\n=== Application started ===\n",
  );
  const fencedSummariesRejected = [
    ...reviewerReproFooterTranscripts,
    ...arbitraryFencedSummaryTranscripts,
    postFooterStartupBanner,
  ].every((transcript) =>
    transcript.malformedFooterLines.length === 1 &&
    reconcileCompanionCompletion({
      code: 0, timedOut: false, error: null, closeObserved: true,
      transcript, expectedTotal: 1,
    }).kind === "invalid",
  );
  const strictTranscriptGrammar =
    malformedProtocolTranscripts.every((transcript) =>
      transcript.malformedProtocolLines.length > 0 &&
      reconcileCompanionCompletion({
        code: 0, timedOut: false, error: null, closeObserved: true,
        transcript, expectedTotal: 1,
      }).kind === "invalid") &&
    malformedFooterTranscripts.every((transcript) =>
      (transcript.malformedFooterLines.length > 0 ||
        transcript.passedFooters.length !== 1) &&
      reconcileCompanionCompletion({
        code: 0, timedOut: false, error: null, closeObserved: true,
        transcript, expectedTotal: 1,
      }).kind === "invalid");
  const completionCases = {
    passed: reconcileCompanionCompletion({
      code: 0, timedOut: false, error: null, closeObserved: true,
      transcript: completeFooter, expectedTotal: 1,
    }),
    unavailable: reconcileCompanionCompletion({
      code: 2, timedOut: false, error: null, closeObserved: true,
      transcript: unavailableFooter, expectedTotal: 1,
    }),
    codeZeroUnavailable: reconcileCompanionCompletion({
      code: 0, timedOut: false, error: null, closeObserved: true,
      transcript: unavailableFooter, expectedTotal: 1,
    }),
    codeTwoWithoutUnavailable: reconcileCompanionCompletion({
      code: 2, timedOut: false, error: null, closeObserved: true,
      transcript: completeFooter, expectedTotal: 1,
    }),
  };
  check(
    "companion transcript parser preserves an explicit unavailable completion",
    unavailableFooter.passedFooters.length === 1 &&
      unavailableFooter.passed === 1 &&
      unavailableFooter.total === 1 &&
      unavailableFooter.unavailable === 2 &&
      unavailableFooter.failures.length === 0 &&
      unavailableFooter.malformedFooterLines.length === 0 &&
      completeFooter.malformedFooterLines.length === 0 &&
      timedOutFooter.timedOutFooters.length === 1 &&
      timedOutFooter.malformedFooterLines.length === 0 &&
      reconcileCompanionCompletion({
        code: 1, timedOut: true, error: null, closeObserved: true,
        transcript: timedOutFooter, expectedTotal: 2,
      }).kind === "invalid" &&
      malformedTimedOutFooterTranscripts.every((transcript) =>
        transcript.malformedFooterLines.length === 1 &&
        reconcileCompanionCompletion({
          code: 1, timedOut: true, error: null, closeObserved: true,
          transcript, expectedTotal: 2,
        }).kind === "invalid") &&
      malformedPostFooterSummaries.every((transcript) =>
        transcript.malformedFooterLines.length === 1 &&
        reconcileCompanionCompletion({
          code: 0, timedOut: false, error: null, closeObserved: true,
          transcript, expectedTotal: 1,
        }).kind === "invalid") &&
      malformedUnavailableFooters === true &&
      leadingZeroFootersRejected === true &&
      fencedSummariesRejected === true &&
      strictTranscriptGrammar === true &&
      completionCases.passed.kind === "passed" &&
      completionCases.unavailable.kind === "unavailable" &&
      completionCases.codeZeroUnavailable.kind === "invalid" &&
      completionCases.codeTwoWithoutUnavailable.kind === "invalid" &&
      reconcileCompanionCompletion({
        code: 0, timedOut: false, error: null, closeObserved: true,
        transcript: postFooterPass, expectedTotal: 1,
      }).kind === "invalid" &&
      reconcileCompanionCompletion({
        code: 0, timedOut: false, error: null, closeObserved: true,
        transcript: postFooterUnavailable, expectedTotal: 1,
      }).kind === "invalid" &&
      reconcileCompanionCompletion({
        code: 0, timedOut: false, error: null, closeObserved: true,
        transcript: countMismatch, expectedTotal: 2,
      }).kind === "invalid",
    JSON.stringify({
      unavailableFooter, malformedUnavailableFooters, completionCases,
      strictTranscriptGrammar, malformedProtocolTranscripts,
      malformedFooterTranscripts, leadingZeroFooterTranscripts,
      leadingZeroFootersRejected, postFooterPass, postFooterUnavailable,
      countMismatch, timedOutFooter, malformedTimedOutFooterTranscripts,
      malformedPostFooterSummaries, postFooterStartupBanner,
    }),
  );
  const { EventEmitter } = require("events");
  const budgets = { budgetMs: 300, killGraceMs: 200, drainGraceMs: 150 };
  const fakeChild = (overrides) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killCalls = 0;
    child.kill = () => {
      child.killCalls += 1;
    };
    return Object.assign(child, overrides || {});
  };

  // Drive the skip path under capture: merely listing an array beside the
  // helper would not prove it emits every catalogue entry as a failure.
  const skippedTeardown = await captureChecks(() =>
    skipTeardownCompanions("controlled enumeration test"),
  );
  const expectedSkippedTeardownNames = ["queued", "commit", "pending", "continuation", "poisoned"].map(
    (kase) => `the isolated ${kase} teardown companion completed its window-destroying case`,
  );
  check(
    "skipping teardown companions explicitly fails every teardown catalogue case",
    skippedTeardown.length === expectedSkippedTeardownNames.length &&
      skippedTeardown.every(
        (entry, index) => entry.ok === false && entry.name === expectedSkippedTeardownNames[index],
      ),
    JSON.stringify(skippedTeardown),
  );

  // -- the healthy shape, as the control -------------------------------------
  const cleanChild = fakeChild();
  const cleanPromise = awaitCompanionProcess(cleanChild, budgets);
  cleanChild.emit("exit", 0);
  cleanChild.emit("close", 0);
  const clean = await cleanPromise;
  // Well past the budget: a timer that was not cleared would kill a child that
  // has already been settled, which is a leak this cannot otherwise see.
  await sleep(budgets.budgetMs + budgets.killGraceMs + 150);
  check(
    "a companion that exits and closes settles as confirmed and cancels its own timers",
    clean.closeObserved === true &&
      clean.processNeverStarted === false &&
      clean.timedOut === false &&
      clean.exited === true &&
      clean.code === 0 &&
      clean.error == null &&
      cleanChild.killCalls === 0,
    JSON.stringify({ clean: { ...clean, settleCount: clean.settleCount() }, killCalls: cleanChild.killCalls }),
  );

  // -- a second settlement must decide nothing -------------------------------
  // DRIVEN THROUGH A TIMEOUT SETTLEMENT, NOT A CLEAN ONE. After a clean close
  // the `once` listeners are already spent, so replaying events proves only
  // that EventEmitter works. A DRAIN-TIMEOUT settlement leaves the `close` and
  // `error` listeners live and unfired - the process is, as far as this seam
  // knows, still holding its pipes - so a late close genuinely re-enters
  // settle() and the guard is the only thing standing between it and a second,
  // contradictory result.
  const lateChild = fakeChild();
  const latePromise = awaitCompanionProcess(lateChild, budgets);
  lateChild.emit("exit", 0);
  const first = await latePromise;
  const settledOnce = first.settleCount() === 1;
  const listenersStillLive =
    lateChild.listenerCount("close") === 1 && lateChild.listenerCount("error") === 1;
  lateChild.emit("close", 99);
  lateChild.emit("error", new Error("late error after a drain timeout"));
  await sleep(budgets.drainGraceMs + 100);
  const second = await latePromise;
  check(
    "a settlement reached by drain timeout survives a late close and a late error",
    first === second &&
      settledOnce &&
      listenersStillLive &&
      // The late close DID re-enter, which is what makes the guard the thing
      // being tested rather than a listener that was already spent.
      second.settleCount() > 1 &&
      second.code === 0 &&
      second.closeObserved === false &&
      second.error == null &&
      // A settled drain result is terminal. Its original watchdog must not
      // later kill the child while callers are inspecting the preserved tree.
      lateChild.killCalls === 0,
    JSON.stringify({
      same: first === second,
      settledOnce,
      listenersStillLive,
      settleCount: second.settleCount(),
      code: second.code,
      closeObserved: second.closeObserved,
      killCalls: lateChild.killCalls,
    }),
  );

  // A late error without a following close is the timer-specific counterpart
  // to the case above. It must not resurrect the drain grace after its result
  // has been returned, or a prior failed companion can keep the parent alive
  // and act on it after the caller has already preserved its evidence.
  const lateErrorChild = fakeChild();
  const lateErrorPromise = awaitCompanionProcess(lateErrorChild, budgets);
  lateErrorChild.emit("exit", 0);
  const lateError = await lateErrorPromise;
  lateErrorChild.emit("error", new Error("late error after terminal drain"));
  await sleep(budgets.budgetMs + budgets.drainGraceMs + 100);
  check(
    "a terminal drain settlement does not re-arm a timer for a late error",
    lateError.closeObserved === false &&
      lateError.timedOut === false &&
      lateErrorChild.killCalls === 0 &&
      lateError.settleCount() === 1,
    JSON.stringify({
      closeObserved: lateError.closeObserved,
      timedOut: lateError.timedOut,
      killCalls: lateErrorChild.killCalls,
      settleCount: lateError.settleCount(),
    }),
  );

  // The same guard on the other timeout: the kill grace expired without any
  // event at all, so exit, close AND error are all still live.
  const lateKillChild = fakeChild();
  const lateKillPromise = awaitCompanionProcess(lateKillChild, budgets);
  const lateKilled = await lateKillPromise;
  const killListenersLive =
    lateKillChild.listenerCount("close") === 1 &&
    lateKillChild.listenerCount("exit") === 1;
  lateKillChild.emit("exit", 7);
  lateKillChild.emit("close", 7);
  lateKillChild.emit("error", new Error("late error after kill settlement"));
  await sleep(budgets.drainGraceMs + 100);
  const lateKilledAgain = await lateKillPromise;
  check(
    "a settlement reached by kill timeout survives a late exit and close without becoming confirmed",
    lateKilled === lateKilledAgain &&
      killListenersLive &&
      lateKilledAgain.timedOut === true &&
      lateKilledAgain.closeObserved === false &&
      lateKilledAgain.exited === false &&
      lateKilledAgain.code === null &&
      // The late close re-enters settle once; the late error must not arm a
      // fresh drain timer and produce a third terminal action.
      lateKilledAgain.settleCount() === 2,
    JSON.stringify({
      same: lateKilled === lateKilledAgain,
      killListenersLive,
      ...lateKilled,
      settleCount: lateKilledAgain.settleCount(),
    }),
  );

  // -- exit without close: the process is gone, the pipes are not ------------
  const drainChild = fakeChild();
  const drainPromise = awaitCompanionProcess(drainChild, budgets);
  drainChild.emit("exit", 0);
  const drained = await drainPromise;
  check(
    "an exit whose pipes never close is never reported as a confirmed termination",
    drained.exited === true &&
      drained.closeObserved === false &&
      drained.processNeverStarted === false &&
      drained.code === 0 &&
      // The caller's rule, restated here so a change to it fails this too.
      (drained.closeObserved === true || drained.processNeverStarted === true) ===
        false,
    JSON.stringify(drained),
  );

  // Exit is decisive for the process watchdog but not for ownership: `close`
  // can still arrive after the original budget while the drain grace is
  // running. That must be a clean close, not a timeout that tries to kill an
  // already-exited child.
  const exitBeforeCloseBudgets = {
    budgetMs: 600,
    killGraceMs: 200,
    drainGraceMs: 600,
  };
  const exitBeforeCloseChild = fakeChild();
  const exitBeforeClosePromise = awaitCompanionProcess(
    exitBeforeCloseChild,
    exitBeforeCloseBudgets,
  );
  await sleep(350);
  exitBeforeCloseChild.emit("exit", 0);
  await sleep(350);
  exitBeforeCloseChild.emit("close", 0);
  const exitBeforeClose = await exitBeforeClosePromise;
  check(
    "an exit before the budget and a close during drain is clean, never a watchdog kill",
    exitBeforeClose.exited === true &&
      exitBeforeClose.closeObserved === true &&
      exitBeforeClose.code === 0 &&
      exitBeforeClose.timedOut === false &&
      exitBeforeCloseChild.killCalls === 0,
    JSON.stringify({
      ...exitBeforeClose,
      settleCount: exitBeforeClose.settleCount(),
      killCalls: exitBeforeCloseChild.killCalls,
    }),
  );

  // -- a spawn that never created a process ----------------------------------
  const noProcessChild = fakeChild({ pid: undefined });
  const noProcessPromise = awaitCompanionProcess(noProcessChild, budgets);
  noProcessChild.emit("error", new Error("spawn ENOENT"));
  const noProcess = await noProcessPromise;
  check(
    "a spawn that never created a process is safely terminal rather than a live child",
    noProcess.processNeverStarted === true &&
      noProcess.closeObserved === false &&
      noProcess.exited === false &&
      String(noProcess.error).includes("ENOENT") &&
      (noProcess.closeObserved === true ||
        noProcess.processNeverStarted === true) === true,
    JSON.stringify({ ...noProcess, error: String(noProcess.error) }),
  );

  // -- an error AFTER a successful spawn, then a close ------------------------
  const errorThenCloseChild = fakeChild();
  const errorThenClosePromise = awaitCompanionProcess(
    errorThenCloseChild,
    budgets,
  );
  errorThenCloseChild.emit("error", new Error("post-spawn fault"));
  errorThenCloseChild.emit("exit", 1);
  errorThenCloseChild.emit("close", 1);
  const errorThenClose = await errorThenClosePromise;
  check(
    "a post-spawn error on a live child waits for the close that says it is gone",
    errorThenClose.processNeverStarted === false &&
      errorThenClose.closeObserved === true &&
      errorThenClose.code === 1 &&
      String(errorThenClose.error).includes("post-spawn fault"),
    JSON.stringify({ ...errorThenClose, error: String(errorThenClose.error) }),
  );

  // -- an error AFTER a successful spawn, and no close ever ------------------
  const errorNoCloseChild = fakeChild();
  const errorNoClosePromise = awaitCompanionProcess(errorNoCloseChild, budgets);
  errorNoCloseChild.emit("error", new Error("post-spawn fault, still running"));
  const errorNoClose = await errorNoClosePromise;
  // The drain result is terminal even though the child was never confirmed
  // gone. Wait past the original watchdog and its kill grace: either acting
  // after this result would race the preserved tree it just told the caller
  // not to touch.
  await sleep(budgets.budgetMs + budgets.killGraceMs + 100);
  check(
    "a post-spawn error with no close is never mistaken for a spawn that started nothing",
    errorNoClose.processNeverStarted === false &&
      errorNoClose.closeObserved === false &&
      String(errorNoClose.error).includes("still running") &&
      errorNoCloseChild.killCalls === 0 &&
      errorNoClose.settleCount() === 1,
    JSON.stringify({
      ...errorNoClose,
      error: String(errorNoClose.error),
      killCalls: errorNoCloseChild.killCalls,
      settleCount: errorNoClose.settleCount(),
    }),
  );

  // -- the budget expires and the kill THROWS --------------------------------
  const killThrowChild = fakeChild({
    kill() {
      throw new Error("EPERM: kill refused");
    },
  });
  const killThrowPromise = awaitCompanionProcess(killThrowChild, budgets);
  const killThrown = await killThrowPromise;
  check(
    "a kill that throws is a live child, not a termination",
    killThrown.timedOut === true &&
      killThrown.killThrew === true &&
      killThrown.closeObserved === false &&
      killThrown.processNeverStarted === false &&
      String(killThrown.error).includes("kill refused"),
    JSON.stringify({ ...killThrown, error: String(killThrown.error) }),
  );

  // -- the budget expires, the kill lands, the child closes ------------------
  const killedChild = fakeChild();
  const killedPromise = awaitCompanionProcess(killedChild, budgets);
  await sleep(budgets.budgetMs + 60);
  const killRequested = killedChild.killCalls === 1;
  killedChild.emit("exit", null);
  killedChild.emit("close", null);
  const killed = await killedPromise;
  check(
    "a killed companion that then closes is confirmed terminated and still reported as timed out",
    killRequested &&
      killed.timedOut === true &&
      killed.closeObserved === true &&
      killed.killThrew === false &&
      killedChild.killCalls === 1,
    JSON.stringify({ killRequested, killCalls: killedChild.killCalls, ...killed }),
  );

  // A kill-grace settlement has no drain timer to leave behind. A late error
  // without a close is therefore the one ordering that proves `settled`
  // itself, rather than a previously cleared timer handle, prevents a new
  // drain grace from being armed after the terminal result.
  const lateErrorAfterKillChild = fakeChild();
  const lateErrorAfterKillPromise = awaitCompanionProcess(
    lateErrorAfterKillChild,
    budgets,
  );
  const lateErrorAfterKill = await lateErrorAfterKillPromise;
  lateErrorAfterKillChild.emit(
    "error",
    new Error("late error after kill-grace settlement"),
  );
  await sleep(budgets.drainGraceMs + 100);
  check(
    "a late error after kill-grace settlement cannot re-arm a drain timer",
    lateErrorAfterKill.timedOut === true &&
      lateErrorAfterKill.closeObserved === false &&
      lateErrorAfterKillChild.killCalls === 1 &&
      lateErrorAfterKill.settleCount() === 1,
    JSON.stringify({
      ...lateErrorAfterKill,
      killCalls: lateErrorAfterKillChild.killCalls,
      settleCount: lateErrorAfterKill.settleCount(),
    }),
  );

  // -- a spawn that throws SYNCHRONOUSLY, through the real runCompanion ------
  // The whole point is the ASSERTION, not the settlement: spawn() throws rather
  // than emitting for a bad options object, and an escaping throw is swallowed
  // by the generic "harness threw" handler at the tail - so the companion's own
  // name never executes and the revert audit reports an unreached catalogue
  // entry. Driven through runCompanion itself so the naming, the accounting and
  // the return value are all the real ones, and captured so the deliberate
  // failure never reaches the transcript.
  const childProcess = require("child_process");
  const throwScratch = path.join(dir, "spawn-throw-scratch");
  const probeName = "probe: a companion whose spawn throws is still named";
  let throwReturn = null;
  let restoreThrowingSpawn = null;
  const captured = await captureChecks(async () => {
    restoreThrowingSpawn = replaceMethod(childProcess, "spawn", () => {
      throw new TypeError("controlled synchronous spawn failure");
    });
    try {
      throwReturn = await runCompanion({
        name: probeName,
        budgetMs: 5000,
        scratchDir: throwScratch,
        expectedTotal: 0,
        env: { F22_TEARDOWN_CASE: "queued" },
      });
    } finally {
      restoreThrowingSpawn();
    }
      },
    );
  const only = captured.length === 1 ? captured[0] : null;
  let detail = null;
  try {
    detail = only ? JSON.parse(only.detail) : null;
  } catch (error) {
    detail = null;
  }
  check(
    "a companion whose spawn throws synchronously still runs its own assertion with full scratch accounting",
    // Exactly one assertion, under exactly the name the caller asked for.
    only !== null &&
      only.name === probeName &&
      only.ok === false &&
      // Nothing was created, so it is safely terminal and the caller may go on.
      detail !== null &&
      detail.processNeverStarted === true &&
      detail.closeObserved === false &&
      detail.terminationConfirmed === true &&
      throwReturn === true &&
      String(detail.error).includes("controlled synchronous spawn failure") &&
      // The strict accounting still applies: the owner created the tree before
      // the spawn and removed it afterwards, and both halves are recorded.
      detail.scratchExistedBefore === true &&
      detail.scratchRemoved === true &&
      detail.scratchPreserved === false &&
      detail.scratchError === null &&
      !fs.existsSync(throwScratch) &&
      // And the capture is released, or every later assertion would be silent.
      checkCapture === null,
    JSON.stringify({
      capturedCount: captured.length,
      name: only && only.name,
      ok: only && only.ok,
      throwReturn,
      detail,
      scratchGone: !fs.existsSync(throwScratch),
      captureReleased: checkCapture === null,
    }),
  );

  // -- an unconfirmed companion, through the real runCompanion ---------------
  // THE LINK THE SUBPROCESS TEST CANNOT SEE. runFinalizerPreservationSubprocess
  // proves the FINALIZER honours a preserved tree, but it arms that list by
  // hand, so it says nothing about runCompanion actually putting anything in
  // it. Measured: deleting the push from runCompanion left the whole suite
  // green. The child here is a fake whose pipes never end and whose kill does
  // nothing, which is precisely the condition the preservation exists for.
  const preserveScratch = path.join(dir, "unconfirmed-scratch");
  const preserveName = "probe: an unconfirmed companion preserves its tree";
  const preservedBefore = PRESERVED_COMPANION_DIRS.length;
  let preserveReturn = null;
  let restoreHangingSpawn = null;
  const preservedCaptured = await captureChecks(async () => {
    restoreHangingSpawn = replaceMethod(childProcess, "spawn", () => {
      const hung = new EventEmitter();
      hung.pid = 5150;
      hung.stdout = new EventEmitter();
      hung.stderr = new EventEmitter();
      // A kill that lands nowhere: no exit, no close, ever.
      hung.kill = () => true;
      return hung;
    });
    try {
      preserveReturn = await runCompanion({
        name: preserveName,
        budgetMs: 300,
        scratchDir: preserveScratch,
        expectedTotal: 0,
        env: { F22_TEARDOWN_CASE: "queued" },
      });
    } finally {
      restoreHangingSpawn();
    }
  });
  const preserveOnly =
    preservedCaptured.length === 1 ? preservedCaptured[0] : null;
  let preserveDetail = null;
  try {
    preserveDetail = preserveOnly ? JSON.parse(preserveOnly.detail) : null;
  } catch (error) {
    preserveDetail = null;
  }
  const registeredPreserved = PRESERVED_COMPANION_DIRS.includes(preserveScratch);
  const treeStillThere = fs.existsSync(preserveScratch);
  // Restored before anything else runs: leaving this in the list would make the
  // real finalizer preserve the whole run, which is the opposite of this
  // block's job. The tree is this block's to remove, and it removes it.
  if (registeredPreserved) {
    PRESERVED_COMPANION_DIRS.splice(
      PRESERVED_COMPANION_DIRS.indexOf(preserveScratch),
      1,
    );
  }
  fs.rmSync(preserveScratch, { recursive: true, force: true, maxRetries: 5 });
  check(
    "a companion that cannot be confirmed gone preserves its tree and registers it for the finalizer",
    preserveOnly !== null &&
      preserveOnly.name === preserveName &&
      preserveOnly.ok === false &&
      preserveDetail !== null &&
      preserveDetail.closeObserved === false &&
      preserveDetail.processNeverStarted === false &&
      preserveDetail.terminationConfirmed === false &&
      preserveDetail.timedOut === true &&
      // No removal was even attempted against a process that may be live.
      preserveDetail.scratchPreserved === true &&
      preserveDetail.scratchRemoved === false &&
      preserveDetail.scratchExistedBefore === null &&
      treeStillThere &&
      // The propagation itself, both halves: the caller is told to stop, and
      // the finalizer is told what not to sweep.
      preserveReturn === false &&
      registeredPreserved &&
      PRESERVED_COMPANION_DIRS.length === preservedBefore,
    JSON.stringify({
      name: preserveOnly && preserveOnly.name,
      preserveReturn,
      registeredPreserved,
      treeStillThere,
      preservedListRestored: PRESERVED_COMPANION_DIRS.length === preservedBefore,
      detail: preserveDetail,
    }),
  );

  // Stream errors are EventEmitter "error" events. Without listeners on both
  // pipes, either of these emissions would terminate the parent before it
  // could preserve the transcript and scratch directory.
  const streamScratch = path.join(dir, "stream-error-scratch");
  const streamProbeName = "probe: companion pipe errors are accounted for";
  let streamReturn = null;
  const streamCaptured = await captureChecks(async () => {
    const restoreStreamSpawn = replaceMethod(childProcess, "spawn", () => {
      const child = fakeChild();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        const stdoutError = new Error("controlled stdout failure");
        stdoutError.code = "EPIPE";
        const stderrError = new Error("controlled stderr failure");
        stderrError.code = "ECONNRESET";
        child.stdout.emit("error", stdoutError);
        child.stderr.emit("error", stderrError);
        child.emit("exit", 0);
        child.emit("close", 0);
      });
      return child;
    });
    try {
      streamReturn = await runCompanion({
        name: streamProbeName,
        budgetMs: 5000,
        scratchDir: streamScratch,
        expectedTotal: 0,
      });
    } finally {
      restoreStreamSpawn();
    }
  });
  const streamOnly = streamCaptured.length === 1 ? streamCaptured[0] : null;
  let streamDetail = null;
  try {
    streamDetail = streamOnly ? JSON.parse(streamOnly.detail) : null;
  } catch {
    streamDetail = null;
  }
  check(
    "companion stdout and stderr errors are captured without bypassing scratch ownership accounting",
    streamOnly !== null &&
      streamOnly.name === streamProbeName &&
      streamOnly.ok === false &&
      streamReturn === true &&
      streamDetail !== null &&
      streamDetail.closeObserved === true &&
      Array.isArray(streamDetail.streamErrors) &&
      streamDetail.streamErrors.length === 2 &&
      streamDetail.streamErrors.some(
        (entry) => entry.stream === "stdout" && entry.error === "EPIPE",
      ) &&
      streamDetail.streamErrors.some(
        (entry) => entry.stream === "stderr" && entry.error === "ECONNRESET",
      ) &&
      streamDetail.scratchExistedBefore === true &&
      streamDetail.scratchRemoved === true &&
      !fs.existsSync(streamScratch),
    JSON.stringify({
      captured: streamCaptured,
      streamReturn,
      streamScratchGone: !fs.existsSync(streamScratch),
    }),
  );

  const countScratch = path.join(dir, "assertion-count-scratch");
  const countProbeName = "probe: companion assertion totals are exact";
  let countReturn = null;
  const countCaptured = await captureChecks(async () => {
    const restoreCountSpawn = replaceMethod(childProcess, "spawn", () => {
      const child = fakeChild();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", "PASS  retained check\n=== 1/1 passed ===\n");
        child.emit("exit", 0);
        child.emit("close", 0);
      });
      return child;
    });
    try {
      countReturn = await runCompanion({
        name: countProbeName,
        budgetMs: 5000,
        scratchDir: countScratch,
        expectedTotal: 2,
      });
    } finally {
      restoreCountSpawn();
    }
  });
  const countOnly = countCaptured.length === 1 ? countCaptured[0] : null;
  let countDetail = null;
  try {
    countDetail = countOnly ? JSON.parse(countOnly.detail) : null;
  } catch {
    countDetail = null;
  }
  check(
    "companion transcript reconciliation rejects a complete but wrong assertion total",
    countOnly !== null &&
      countOnly.name === countProbeName &&
      countOnly.ok === false &&
      countReturn === true &&
      countDetail !== null &&
      countDetail.companionPassed === 1 &&
      countDetail.companionTotal === 1 &&
      countDetail.expectedTotal === 2 &&
      Array.isArray(countDetail.streamErrors) &&
      countDetail.streamErrors.length === 0 &&
      countDetail.scratchExistedBefore === true &&
      countDetail.scratchRemoved === true &&
      !fs.existsSync(countScratch),
    JSON.stringify({
      captured: countCaptured,
      countReturn,
      countScratchGone: !fs.existsSync(countScratch),
    }),
  );
}

// The owned removal's three outcomes, against the real filesystem.
async function runCompanionScratchScenarios() {
  const root = path.join(dir, "scratch-oracle");
  const externalSibling = path.join(dir, "scratch-oracle-external-sibling");
  fs.mkdirSync(root, { recursive: true });
  try {
    const present = path.join(root, "present");
    fs.mkdirSync(path.join(present, "nested"), { recursive: true });
    fs.writeFileSync(path.join(present, "nested", "f.txt"), "x", "utf8");
    const removed = resolveCompanionScratch(present, true, root);
    check(
      "an owned removal over a confirmed corpse reports the tree present before and gone after",
      removed.existedBefore === true &&
        removed.removed === true &&
        removed.preserved === false &&
        removed.error === null &&
        !fs.existsSync(present),
      JSON.stringify({ ...removed, stillThere: fs.existsSync(present) }),
    );

    const absent = path.join(root, "never-created");
    const missing = resolveCompanionScratch(absent, true, root);
    check(
      "an owned removal that finds nothing there reports an ownership failure, not a success",
      missing.existedBefore === false &&
        missing.removed === false &&
        missing.preserved === false &&
        String(missing.error).includes("already gone"),
      JSON.stringify(missing),
    );

    const live = path.join(root, "live");
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "evidence.txt"), "keep me", "utf8");
    const preserved = resolveCompanionScratch(live, false, root);
    check(
      "an unconfirmed companion has its tree preserved rather than removed or probed",
      preserved.preserved === true &&
        preserved.removed === false &&
        preserved.existedBefore === null &&
        fs.existsSync(path.join(live, "evidence.txt")),
      JSON.stringify({
        ...preserved,
        evidenceKept: fs.existsSync(path.join(live, "evidence.txt")),
      }),
    );

    // The accepted root is a real owner root, not a string-prefix check:
    // `root\\..\\sibling` resolves outside it despite beginning with root.
    const inRootSibling = path.join(root, "allowed-sibling");
    fs.mkdirSync(inRootSibling, { recursive: true });
    fs.writeFileSync(path.join(inRootSibling, "evidence.txt"), "inside", "utf8");
    fs.mkdirSync(externalSibling, { recursive: true });
    const externalEvidence = path.join(externalSibling, "evidence.txt");
    fs.writeFileSync(externalEvidence, "outside", "utf8");
    const traversalToExternal = path.join(
      root,
      "..",
      path.basename(externalSibling),
    );
    const acceptedSibling = validateCompanionScratch(inRootSibling, root);
    const rejectedTraversal = resolveCompanionScratch(
      traversalToExternal,
      true,
      root,
    );
    const rejectedStaleOwner = validateCompanionScratch(
      inRootSibling,
      path.join(root, "stale-owner"),
    );
    check(
      "companion scratch deletion accepts a canonical in-root sibling but rejects traversal, external, and stale-owner paths",
      acceptedSibling.ok === true &&
        isStrictCanonicalDescendant(acceptedSibling.scratchDir, root) &&
        rejectedTraversal.removed === false &&
        rejectedTraversal.preserved === true &&
        String(rejectedTraversal.error).includes("not strictly beneath") &&
        fs.existsSync(externalEvidence) &&
        rejectedStaleOwner.ok === false &&
        String(rejectedStaleOwner.error).includes("could not be canonicalized"),
      JSON.stringify({
        root,
        acceptedSibling,
        traversalToExternal,
        rejectedTraversal,
        externalEvidenceStillThere: fs.existsSync(externalEvidence),
        rejectedStaleOwner,
      }),
    );

    // NOTE: there was a source-shape tripwire here that scanned this file for
    // the finalizer's own literals. It is gone rather than repaired. It could
    // not locate the finalizer except by matching strings it also contained,
    // and everything it approximated is now measured for real, from outside a
    // process that has actually run that path -
    // runFinalizerPreservationSubprocess() below. A weaker restatement of a
    // stronger test is not a second opinion; it is a second thing to keep true.
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(externalSibling, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ============================================================
// THE PRESERVATION, OBSERVED FROM OUTSIDE THE PROCESS THAT MAKES IT
// ============================================================
//
// The decision is taken on the way out of a process, between the summary line
// and app.exit(), and app.exit() unwinds nothing - so nothing INSIDE that
// process can report on what survived it.
//
// THE CHILD OWNS A REAL, REGISTERED ROOT. An earlier version handed it one
// through F22_COMPANION_DIR, which was the whole defect: that path takes the
// companion branch of companionScratchDir(), so tempDir() is never called, the
// root is never added to REGISTERED_TEMP_DIRS, `ownsScratchDir` is false, and
// the finalizer's `REGISTERED_TEMP_DIRS.delete(dir)` removed an entry that was
// never there. `registered: false` then read back true-by-construction and the
// assertion measured nothing at all. This child is spawned WITHOUT that
// variable, so it takes the ordinary path: a real mkdtemp root, really
// registered, which - absent the preservation - it would really release and
// really sweep.
//
// AND THE SWEEP IS PROVEN TO HAVE RUN, by a DECOY. "The root survived" is an
// absence check and fails open: a sweep that never executed would leave the
// root standing for the wrong reason. The child therefore registers a second
// temp directory it does NOT preserve, and the sweep has to take that one. The
// pair - decoy gone, root present - is the discrimination.
//
// The subprocess is owned like any other: its termination is confirmed through
// the same awaitCompanionProcess() the companions use, its transcript is
// reconciled through the same summariseCompanionTranscript(), and its tree -
// which by construction it must NOT have removed - is removed here afterwards,
// by the owner, once the evidence has been read.
//
// The child runs no scenario, so its assertion count is fixed and small. It is
// asserted exactly, not as a lower bound: a child that silently stopped running
// one of them is a child whose evidence is worth less than it appears.
const FINALIZER_SELFCHECK_ASSERTIONS = 4;

async function runFinalizerPreservationSubprocess() {
  const childProcess = require("child_process");
  const output = [];
  const finalizerEnv = { ...process.env, F22_FINALIZER_SELFCHECK: "1" };
  delete finalizerEnv.F22_COMPANION_DIR;
  delete finalizerEnv.F22_COMPANION_OWNER_ROOT;
  let child = null;
  let spawnError = null;
  try {
    child = childProcess.spawn(process.execPath, [__filename], {
      cwd: path.join(__dirname, ".."),
      // Deliberately NO F22_COMPANION_DIR: see above. The child must own and
      // register its own root for any of this to mean anything.
      env: finalizerEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    spawnError = error;
  }
  let result = null;
  let streamErrors = [];
  if (child) {
    streamErrors = relayCompanionOutput(child, output);
    result = await awaitCompanionProcess(child, {
      budgetMs: COMPANION_BUDGET_MS.teardown,
      killGraceMs: COMPANION_KILL_GRACE_MS,
      drainGraceMs: COMPANION_DRAIN_GRACE_MS,
    });
  }
  const text = output.join("");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const readOne = (marker) => {
    const matches = lines.filter((l) => l.startsWith(marker));
    return { count: matches.length, value: matches.length === 1 ? matches[0].slice(marker.length) : null };
  };
  const diagnosticMarker = "preserved for diagnosis (not swept): ";
  const diagnosticLines = readOne(diagnosticMarker);
  let diagnostic = null;
  try {
    diagnostic = diagnosticLines.value ? JSON.parse(diagnosticLines.value) : null;
  } catch (error) {
    diagnostic = null;
  }
  // Announced by the child the moment it knows them, so the owner can clean up
  // even on a path where the diagnostic never gets printed.
  const rootLine = readOne("finalizer selfcheck root: ");
  const decoyLine = readOne("finalizer selfcheck decoy: ");
  const root = rootLine.value;
  const decoy = decoyLine.value;
  const preserved = root ? path.join(root, "companion-preserved") : null;
  const evidence = preserved ? path.join(preserved, "evidence.txt") : null;
  // THE SAME RECONCILIATION THE COMPANIONS GET, not a weaker parallel one.
  const transcript = summariseCompanionTranscript(text);
  const completion = reconcileCompanionCompletion({
    code: result && result.code,
    timedOut: result && result.timedOut,
    error: spawnError || (result && result.error),
    closeObserved: result && result.closeObserved,
    transcript,
    expectedTotal: FINALIZER_SELFCHECK_ASSERTIONS,
  });
  const terminationConfirmed =
    !!spawnError ||
    (result !== null &&
      (result.closeObserved === true || result.processNeverStarted === true));
  check(
    "the finalizer selfcheck subprocess completed its whole run and accounted for every assertion",
    !spawnError &&
      completion.kind === "passed" &&
      streamErrors.length === 0 &&
      // Exactly one of each announcement: a second would mean two finalizers
      // ran, and the evidence below could not be attributed to either.
      rootLine.count === 1 &&
      decoyLine.count === 1 &&
      diagnosticLines.count === 1,
    JSON.stringify({
      spawnError: spawnError && String(spawnError),
      code: result && result.code,
      timedOut: result && result.timedOut,
      closeObserved: result && result.closeObserved,
      error: result && result.error && String(result.error),
      passedFooters: transcript.passedFooters,
      unavailable: transcript.unavailable,
      timedOutFooters: transcript.timedOutFooters,
      failures: transcript.failures,
      streamErrors,
      passed: transcript.passed,
      total: transcript.total,
      expectedTotal: FINALIZER_SELFCHECK_ASSERTIONS,
      rootLines: rootLine.count,
      decoyLines: decoyLine.count,
      diagnosticLines: diagnosticLines.count,
    }),
  );
  const rootSurvived = !!root && fs.existsSync(root);
  const preservedSurvived = !!preserved && fs.existsSync(preserved);
  const evidenceSurvived = !!evidence && fs.existsSync(evidence);
  const decoySwept = !!decoy && !fs.existsSync(decoy);
  check(
    "a preserved companion tree and its registered root survive a real exit sweep that provably ran",
    result !== null &&
      result.closeObserved === true &&
      rootSurvived &&
      preservedSurvived &&
      evidenceSurvived &&
      // The positive control. Without it "the root survived" is satisfied by a
      // sweep that never happened.
      decoySwept,
    JSON.stringify({
      root,
      decoy,
      rootSurvived,
      preservedSurvived,
      evidenceSurvived,
      decoySwept,
    }),
  );
  check(
    "the preserved tree is excluded from the exit sweep's registry and reported with its path and reason",
    diagnostic !== null &&
      // WAS registered, and is not any more. Both halves, or the de-registration
      // is indistinguishable from a root that was never registered at all -
      // which is exactly the defect this block used to have.
      diagnostic.registeredBefore === true &&
      diagnostic.registered === false &&
      !!root &&
      path.resolve(String(diagnostic.root)) === path.resolve(root) &&
      Array.isArray(diagnostic.companions) &&
      diagnostic.companions.length === 1 &&
      path.resolve(String(diagnostic.companions[0])) ===
        path.resolve(String(preserved)) &&
      typeof diagnostic.reason === "string" &&
      diagnostic.reason.length > 0,
    JSON.stringify({ diagnostic, root, preserved }),
  );
  // OWNER CLEANUP, AFTER THE EVIDENCE HAS BEEN READ. The child was required not
  // to remove the root; leaving it behind would make this block the source of
  // exactly the residue the whole seam exists to stop. The decoy is included
  // because a sweep that failed to take it is still this run's mess.
  const cleanupTargets = [root, decoy].filter(Boolean);
  let cleaned = cleanupTargets.length === 2;
  if (terminationConfirmed) {
    for (const target of cleanupTargets) {
      try {
        fs.rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
        if (fs.existsSync(target)) cleaned = false;
      } catch (error) {
        cleaned = false;
      }
    }
  } else {
    cleaned = false;
  }
  check(
    "the finalizer subprocess's preserved tree is removed by its owner once the evidence has been read",
    terminationConfirmed && cleaned,
    JSON.stringify({
      closeObserved: result && result.closeObserved,
      terminationConfirmed,
      cleaned,
      targets: cleanupTargets,
      stillThere: cleanupTargets.filter((t) => fs.existsSync(t)),
    }),
  );
  // This is a real Electron child, not merely a selfcheck transcript. If its
  // pipes never close, do not start another Electron or delete its own root:
  // preserve the path for the parent's finalizer and propagate the same
  // close-only ownership boundary used by ordinary companions.
  if (!terminationConfirmed && root) PRESERVED_COMPANION_DIRS.push(root);
  return terminationConfirmed;
}

/**
 * @returns {boolean} whether the portable companion is CONFIRMED gone. The
 *   caller propagates this the same way runTeardownCompanion() does: a
 *   companion still holding handles must not be followed by another Electron,
 *   and its tree must not be swept.
 */
async function runPortableCompanion() {
  const scratchDir = path.join(dir, "companion-portable");
  return runCompanion({
    name: "the isolated portable updater companion completed every live hand-off check",
    budgetMs: COMPANION_BUDGET_MS.portable,
    scratchDir,
    expectedTotal: COMPANION_ASSERTION_TOTALS.portable,
    env: {
      F22_PORTABLE_HARNESS: "1",
      // See companionScratchDir(). This is also what collects an ACKNOWLEDGED
      // batch directory - on that one path the real batch deletes itself, so
      // main.js correctly does not, and there is no real batch here.
      F22_COMPANION_DIR: scratchDir,
      PORTABLE_EXECUTABLE_DIR: path.join(dir, "portable-executable"),
    },
  });
}

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const sentinel = startErrorSentinel(win, { label: "tabs" });
  // No suite may reach the user's browser. See trapExternalOpens().
  await trapExternalOpens(win);

  write(fileA, "# Alpha\n\nALPHA_V1\n");
  write(fileB, "# Beta\n\nBETA_V1\n");

  await exec(`
    localStorage.clear();
    window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
    window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
    null;
  `);

  const ids = await exec(`
    (() => {
      const a = window.CustomTabs.createTab(${jsA}, window.fs.readFileSync(${jsA}, 'utf8'));
      const b = window.CustomTabs.createTab(${jsB}, window.fs.readFileSync(${jsB}, 'utf8'));
      return { a: a.id, b: b.id };
    })()
  `);
  await sleep(500);

  const viewerText = () =>
    exec(`document.getElementById('viewer').textContent`);
  const holdReloadResults = () => {
    const realSend = win.webContents.send;
    const held = [];
    const restore = replaceMethod(
      win.webContents,
      "send",
      function (channel, ...args) {
        if (channel === "file-reload-result") {
          held.push(args[0]);
          return;
        }
        return realSend.call(this, channel, ...args);
      },
    );
    return {
      held,
      restore,
      release(index = 0) {
        const data = held[index];
        if (data) realSend.call(win.webContents, "file-reload-result", data);
      },
    };
  };

  // ---- Scenario 1: the reported bug -------------------------------------
  // Both files change on disk. Refresh B, then refresh A, then switch back to
  // B. Before the fix, B reverted to BETA_V1.
  write(fileA, "# Alpha\n\nALPHA_V2\n");
  write(fileB, "# Beta\n\nBETA_V2\n");

  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(400);
  await exec(`window.reloadCurrentFile(); null;`);
  await sleep(900);
  check(
    "refresh shows new content for B",
    (await viewerText()).includes("BETA_V2"),
    await viewerText(),
  );

  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(400);
  await exec(`window.reloadCurrentFile(); null;`);
  await sleep(900);
  check(
    "refresh shows new content for A",
    (await viewerText()).includes("ALPHA_V2"),
    await viewerText(),
  );

  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  const backToB = await viewerText();
  check(
    "REGRESSION: B does not revert after refreshing A",
    backToB.includes("BETA_V2") && !backToB.includes("BETA_V1"),
    backToB,
  );

  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(700);
  const backToA = await viewerText();
  check(
    "REGRESSION: A stays refreshed after switching away and back",
    backToA.includes("ALPHA_V2") && !backToA.includes("ALPHA_V1"),
    backToA,
  );

  // ---- Scenario 2: auto-reload a background tab on switch ---------------
  write(fileB, "# Beta\n\nBETA_V3\n");
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(400);
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  check(
    "switching to a tab auto-reloads changed file from disk",
    (await viewerText()).includes("BETA_V3"),
    await viewerText(),
  );

  // ---- Scenario 3: unsaved edits are never clobbered --------------------
  await exec(`
    (() => {
      const tabs = window.CustomTabs.getTabs();
      const b = tabs.find(t => t.id === ${ids.b});
      b.content = '# Beta\\n\\nUNSAVED_EDIT\\n';
      b.hasUnsavedChanges = true;
      return true;
    })()
  `);
  write(fileB, "# Beta\n\nBETA_V4\n");
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(400);
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  const afterUnsaved = await viewerText();
  check(
    "unsaved edits survive an on-disk change",
    afterUnsaved.includes("UNSAVED_EDIT") && !afterUnsaved.includes("BETA_V4"),
    afterUnsaved,
  );

  // ---- Scenario 3b: the edit base tracks what is on screen ---------------
  // renderer.js applies view-mode edits (notes, tables, checkboxes) as string
  // splices against originalMarkdown. If a switch seeds it with the on-disk
  // copy while rendering the unsaved copy, the next splice builds on the wrong
  // base and silently drops the earlier unsaved edit.
  const editBaseDirty = await exec("window.originalMarkdown");
  check(
    "edit base matches the rendered (unsaved) content on a dirty tab",
    editBaseDirty.includes("UNSAVED_EDIT") && !editBaseDirty.includes("BETA_V4"),
    editBaseDirty,
  );

  // A second view-mode edit must build on the first, not replace it.
  await exec(`
    (() => {
      window.originalMarkdown = window.originalMarkdown + '\\nSECOND_EDIT\\n';
      const tabs = window.CustomTabs.getTabs();
      const b = tabs.find(t => t.id === ${ids.b});
      b.content = window.originalMarkdown;
      return true;
    })()
  `);
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(400);
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  const editBaseAfter = await exec("window.originalMarkdown");
  check(
    "sequential view-mode edits both survive a tab round-trip",
    editBaseAfter.includes("UNSAVED_EDIT") &&
      editBaseAfter.includes("SECOND_EDIT"),
    editBaseAfter,
  );

  // ---- Scenario 4: scroll position is remembered across a refresh -------
  const longDoc = (marker) =>
    ["# Top", "", "x".repeat(50), ""]
      .concat(
        Array.from({ length: 40 }, (_, i) =>
          [`## Section ${i}`, "", `${marker} body ${i}`, "", "filler ".repeat(60), ""].join("\n"),
        ),
      )
      .join("\n");

  write(fileA, longDoc("V1"));
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(800);

  const scroller = `(document.querySelector('.content-wrapper').classList.contains('split-view') ? document.getElementById('viewer') : document.querySelector('.content-wrapper'))`;
  // An oracle must not reuse the formula it is judging. The implementation's
  // own offsetWithin() was, until this round, a raw
  // `rect.top - rect.top + scrollTop`, and so was this test - which is why the
  // suite could not see that the two terms are in different coordinate spaces
  // once #viewer carries a `zoom` (scrollTop is in the scroller's pre-zoom
  // pixels, rects are in viewport pixels). Derived independently here, from the
  // scroller's own border-box-to-padding-box ratio, so it agrees with the
  // implementation only if both are right.
  const offsetIn = (s, el) => `
    (() => {
      const s = ${s}, el = ${el};
      const cs = getComputedStyle(s);
      const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const local = s.clientHeight + borders;
      const scale = local ? s.getBoundingClientRect().height / local : 1;
      return (el.getBoundingClientRect().top - s.getBoundingClientRect().top) / (scale || 1) + s.scrollTop;
    })()
  `;
  const SECTION_25 = `Array.from(document.querySelectorAll('#viewer h2')).find(el => el.textContent.trim() === 'Section 25')`;
  await exec(`
    (() => {
      const s = ${scroller};
      s.scrollTop = ${offsetIn(scroller, SECTION_25)};
      return s.scrollTop;
    })()
  `);
  await sleep(200);
  const before = await exec(`${scroller}.scrollTop`);

  // Rewrite with extra content ABOVE the anchor: a raw pixel offset would now
  // point at the wrong place, a heading anchor should not.
  write(fileA, longDoc("V1").replace("# Top", "# Top\n\n" + "extra line\n\n".repeat(30)));
  await exec(`window.reloadCurrentFile(); null;`);
  await sleep(1800);

  const after = await exec(`${scroller}.scrollTop`);
  const anchorTop = await exec(offsetIn(scroller, SECTION_25));
  check(
    "refresh keeps the reader at the same heading",
    Math.abs(after - anchorTop) < 40 && after > 0,
    `before=${before} after=${after} anchorTop=${anchorTop}`,
  );
  check(
    "refresh did not merely keep the raw pixel offset",
    Math.abs(after - before) > 40,
    `before=${before} after=${after}`,
  );
  // Deliberately NOT repeated at a second zoom level here. This scenario runs in
  // normal view, where the scroller is .content-wrapper - OUTSIDE the zoom
  // renderer.js applies to #viewer - so the scale is 1 at every zoom and a
  // zoomed pass would assert nothing new. The non-vacuous case is split view,
  // where the scroller IS the zoomed element; that is scenario 5c2z below, and
  // it exercises this same captureAnchor/resolveAnchorTop pair because refresh
  // and tab-switch share them.

  // ---- Scenario 5: the "File Updated" prompt ----------------------------
  // Actively-viewed tab: we deliberately do NOT auto-reload (that would yank
  // the document out from under the reader), so the actionable prompt must
  // still appear, and acting on it must not resurrect the revert bug.
  const promptShown = () =>
    exec(
      `!!document.getElementById('fileUpdateToast') && document.getElementById('fileUpdateToast').classList.contains('show')`,
    );

  write(fileA, "# Alpha\n\nALPHA_V9\n");
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(900);
  await exec(`window.dismissFileUpdateNotification(); null;`);

  // Change the file the user is currently looking at.
  write(fileA, "# Alpha\n\nALPHA_V10\n");
  await sleep(2200);
  check(
    "actively-viewed tab still gets the actionable update prompt",
    await promptShown(),
    "toast not shown",
  );

  // Acting on the prompt must load the new content...
  await exec(`document.getElementById('reloadFileBtn').click(); null;`);
  await sleep(1200);
  check(
    "prompt Reload loads the new content",
    (await viewerText()).includes("ALPHA_V10"),
    await viewerText(),
  );
  check(
    "prompt is dismissed after acting on it",
    (await promptShown()) === false,
    "toast still shown",
  );

  // ...and must survive a tab round-trip (the original bug).
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(400);
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(700);
  check(
    "REGRESSION: prompt-triggered reload does not revert on tab switch",
    (await viewerText()).includes("ALPHA_V10"),
    await viewerText(),
  );

  // A prompt raised for the visible tab is stale once we move away: the
  // background tab is reloaded silently instead, so the ask-to-reload toast
  // must be taken down rather than left pointing at another document.
  write(fileA, "# Alpha\n\nALPHA_V11\n");
  await sleep(2200);
  check(
    "prompt appears again for the visible tab",
    await promptShown(),
    "toast not shown",
  );
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  check(
    "switching tabs dismisses the stale update prompt",
    (await promptShown()) === false,
    "toast still shown after switch",
  );

  // Coming back auto-reloads silently: fresh content, no actionable prompt.
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(900);
  const afterAuto = await viewerText();
  check(
    "auto-reload on switch picks up the change without prompting",
    afterAuto.includes("ALPHA_V11") && (await promptShown()) === false,
    afterAuto,
  );

  // The prompt's Reload button must not silently discard unsaved edits the
  // way upstream's inline onclick="reloadCurrentFile()" does.
  check(
    "prompt Reload button is rebound to the guarded handler",
    (await exec(
      `document.getElementById('reloadFileBtn').onclick && document.getElementById('reloadFileBtn').onclick.name`,
    )) === "reloadFromUpdatePrompt",
    await exec(
      `String(document.getElementById('reloadFileBtn').onclick && document.getElementById('reloadFileBtn').onclick.name)`,
    ),
  );

  // Same for Dismiss. Its inline onclick was removed for SEC-09 (no inline
  // handlers under the new CSP) and rebound in custom-tabs.js, which made this
  // a silently-untested path: a click that no longer reaches
  // dismissFileUpdateNotification() leaves the toast on screen until the
  // 10-second auto-hide, and nothing else in the suite would notice. Driven
  // through a real click on the real element, not by calling the function.
  const dismissState = await exec(`
    (() => {
      const btn = document.getElementById('dismissFileUpdateBtn');
      const toast = document.getElementById('fileUpdateToast');
      if (!btn || !toast) return { missing: true, btn: !!btn, toast: !!toast };
      toast.classList.add('show');
      window.__dismissProbe = 0;
      const orig = window.dismissFileUpdateNotification;
      window.dismissFileUpdateNotification = function () {
        window.__dismissProbe += 1;
        return orig.apply(this, arguments);
      };
      try {
        btn.click();
      } finally {
        window.dismissFileUpdateNotification = orig;
      }
      return {
        bound: typeof btn.onclick === 'function',
        calls: window.__dismissProbe,
        visible: toast.classList.contains('show'),
      };
    })()
  `);
  check(
    "prompt Dismiss button is bound and really dismisses the toast",
    dismissState.bound === true &&
      dismissState.calls === 1 &&
      dismissState.visible === false,
    JSON.stringify(dismissState),
  );


  write(fileA, "# Alpha\n\nALPHA_V12\n");
  await sleep(2200);
  const promptBeforeDecline = await promptShown();

  await exec(`
    (() => {
      const tabs = window.CustomTabs.getTabs();
      const a = tabs.find(t => t.id === ${ids.a});
      a.content = '# Alpha\\n\\nDIRTY_EDIT\\n';
      a.hasUnsavedChanges = true;
      window.originalMarkdown = a.content;
      window.__confirmCalls = 0;
      window.__realConfirm = window.confirm;
      window.confirm = () => { window.__confirmCalls++; return false; };
      return true;
    })()
  `);
  await exec(`document.getElementById('reloadFileBtn').click(); null;`);
  await sleep(900);
  check(
    "declining the Reload confirmation keeps unsaved edits",
    (await exec(`window.__confirmCalls`)) === 1 &&
      (await exec(`window.originalMarkdown`)).includes("DIRTY_EDIT"),
    `confirmCalls=${await exec(`window.__confirmCalls`)}`,
  );
  // Backing out of the confirmation is not the same as pressing Dismiss: the
  // file is still stale, so the only route back to it must remain on screen.
  check(
    "declining the Reload confirmation leaves the prompt up",
    promptBeforeDecline === true && (await promptShown()) === true,
    `before=${promptBeforeDecline} after=${await promptShown()}`,
  );

  await exec(`window.confirm = () => { window.__confirmCalls++; return true; }; null;`);
  await exec(`document.getElementById('reloadFileBtn').click(); null;`);
  await sleep(1200);
  const afterAccept = await viewerText();
  await exec(`window.confirm = window.__realConfirm; null;`);
  check(
    "accepting the Reload confirmation loads from disk",
    afterAccept.includes("ALPHA_V12"),
    afterAccept,
  );

  // ---- Scenario 5b: prompt bookkeeping is reset, not just hidden ---------
  // renderer.js guards showFileUpdateNotification() with a module-level
  // `fileUpdateNotificationShown` flag. If dismissing only hid the DOM without
  // resetting that flag, the NEXT file change would be silently swallowed for
  // up to 10s. This asserts the real resetter is reachable and is actually
  // being used.
  check(
    "renderer's dismissFileUpdateNotification is reachable as a global",
    (await exec(`typeof window.dismissFileUpdateNotification`)) === "function",
    await exec(`typeof window.dismissFileUpdateNotification`),
  );

  // B is still dirty from scenario 3; a dirty tab is never watched or
  // prompted, so clean it before using it as the prompt target.
  await exec(`
    (() => {
      const b = window.CustomTabs.getTabs().find(t => t.id === ${ids.b});
      b.content = b.originalContent;
      b.hasUnsavedChanges = false;
      return true;
    })()
  `);

  await exec(`window.dismissFileUpdateNotification(); null;`);
  write(fileA, "# Alpha\n\nALPHA_V14\n");
  await sleep(2200);
  const promptedForA = await promptShown();

  // Switch away well inside renderer's 10s auto-dismiss window, so the flag is
  // only cleared if our dismiss path actually resets it.
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  write(fileB, "# Beta\n\nBETA_V14\n");
  await sleep(2400);
  check(
    "a dismissed prompt does not suppress the next tab's prompt",
    promptedForA === true && (await promptShown()) === true,
    `promptedForA=${promptedForA} promptedForB=${await promptShown()}`,
  );

  // ---- Scenario 5c: a slow reload render must not outlive its context -----
  // renderMarkdown() is async (diagrams can take seconds), so the user can act
  // before a reload settles. The completion must not clear the unsaved flag or
  // restore scroll for a document it no longer owns.
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(900);
  await exec(`window.dismissFileUpdateNotification(); null;`);

  // (i) Edited while the reload render was in flight.
  const heldEditedReload = holdReloadResults();
  await exec(`
    (() => {
      window.reloadCurrentFile();
      return true;
    })()
  `);
  const editedReloadHeld = await waitUntil(
    () => heldEditedReload.held.length === 1,
    5000,
  );
  await exec(
    `window.originalMarkdown = '# Alpha\\n\\nTYPED_DURING_RELOAD\\n'; null;`,
  );
  heldEditedReload.release();
  await sleep(1600);
  heldEditedReload.restore();
  const afterRace = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      return { content: a.content, dirty: a.hasUnsavedChanges };
    })()
  `);
  check(
    "edits made during a reload render are not silently marked saved",
    afterRace.content.includes("TYPED_DURING_RELOAD") && afterRace.dirty === true,
    JSON.stringify(afterRace),
  );

  // (ii) Switched tabs while the reload render was in flight.
  const heldSwitchedReload = holdReloadResults();
  await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = a.originalContent;
      a.hasUnsavedChanges = false;
      window.originalMarkdown = a.originalContent;

      const b = window.CustomTabs.getTabs().find(t => t.id === ${ids.b});
      b.content = '# Beta\\n\\nB_UNSAVED\\n';
      b.hasUnsavedChanges = true;

      window.__unsavedCalls = [];
      const real = window.setUnsavedState;
      window.setUnsavedState = (v) => { window.__unsavedCalls.push(!!v); return real(v); };

      window.reloadCurrentFile();
      return true;
    })()
  `);
  const switchedReloadHeld = await waitUntil(
    () => heldSwitchedReload.held.length === 1,
    5000,
  );
  await exec(`
    (() => {
      window.CustomTabs.switchToTab(${ids.b});
      return true;
    })()
  `);
  heldSwitchedReload.release();
  await sleep(1600);
  heldSwitchedReload.restore();
  const afterSuperseded = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      const b = window.CustomTabs.getTabs().find(t => t.id === ${ids.b});
      return {
        unsavedCalls: window.__unsavedCalls,
        aContent: a.content,
        bContent: b.content,
        bDirty: b.hasUnsavedChanges,
      };
    })()
  `);
  check(
    "a superseded reload does not clear the newly active tab's unsaved state",
    afterSuperseded.bDirty === true &&
      afterSuperseded.bContent.includes("B_UNSAVED") &&
      !(
        afterSuperseded.unsavedCalls.length &&
        afterSuperseded.unsavedCalls[afterSuperseded.unsavedCalls.length - 1] ===
          false
      ),
    JSON.stringify(afterSuperseded),
  );
  // Without the generation/tab guard the completion falls into the
  // "edited during reload" branch and writes the NEW tab's live text into the
  // OLD tab's cache - silent cross-tab content corruption.
  check(
    "a superseded reload does not write the new tab's text into the old tab",
    !afterSuperseded.aContent.includes("B_UNSAVED"),
    JSON.stringify({ aContent: afterSuperseded.aContent }),
  );

  // ---- Scenario 5e: CRLF files are not falsely reported as edited --------
  // A <textarea> normalises CRLF to LF on assignment, so renderer's
  // `markdownEditor.value = data.content` silently rewrites the line endings.
  // Comparing the live editor text against the raw `data.content` would then
  // report every Windows-line-ending file as edited on every reload, with no
  // user input at all - permanently dirtying the tab (which also pauses its
  // file watcher) and converting the file to LF on the next save.
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(700);
  await exec(`window.dismissFileUpdateNotification(); null;`);
  const crlfContent = "# Alpha\r\n\r\nCRLF_BODY\r\n";
  write(fileA, crlfContent);
  const heldCrlfReload = holdReloadResults();
  const afterCrlf = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = a.originalContent;
      a.hasUnsavedChanges = false;
      window.originalMarkdown = a.content;

      // Force the edit-mode branch of renderer's reload handler.
      window.isEditMode = true;
      if (!window.markdownEditor) {
        window.markdownEditor = document.getElementById('markdownEditor');
      }
      window.reloadCurrentFile();
      return true;
    })()
  `);
  const crlfReloadHeld = await waitUntil(
    () => heldCrlfReload.held.length === 1,
    5000,
  );
  heldCrlfReload.release();
  await sleep(1600);
  heldCrlfReload.restore();
  const crlfState = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      window.isEditMode = false;
      return {
        dirty: a.hasUnsavedChanges,
        synced: a.content === a.originalContent,
        hasCr: a.content.indexOf('\\r') !== -1,
      };
    })()
  `);
  check(
    "a CRLF file is not falsely marked edited by its own reload",
    crlfState.dirty !== true && crlfState.synced === true,
    JSON.stringify(crlfState),
  );

  // Same class, different path: switchToTab writes tab.content into the
  // textarea (normalising CRLF->LF) and snapshotActiveTab reads it back out.
  // Switching or closing while in edit mode, with zero edits, must not mark
  // the tab dirty - and must not rewrite the cached document to LF, or the
  // next save silently converts the user's file.
  const crlfSnapshot = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = ${JSON.stringify(crlfContent)};
      a.originalContent = ${JSON.stringify(crlfContent)};
      a.hasUnsavedChanges = false;
      window.originalMarkdown = a.content;
      // EDIT MODE IS THE split-view CLASS. \`window.isEditMode\` is not read by
      // anything: renderer.js keeps its own module-scoped variable, and the
      // overlay reads the DOM. Setting the class is what actually sends
      // snapshotActiveTab down the textarea branch this scenario is about.
      const wrapper = document.querySelector('.content-wrapper');
      const addedSplit = !!wrapper && !wrapper.classList.contains('split-view');
      if (wrapper) wrapper.classList.add('split-view');
      if (!window.markdownEditor) {
        window.markdownEditor = document.getElementById('markdownEditor');
      }
      window.markdownEditor.value = a.content;
      const reallyEditing = window.CustomTabs.__inEditMode();

      window.CustomTabs.switchToTab(${ids.b});
      const after = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      if (wrapper && addedSplit) wrapper.classList.remove('split-view');
      return {
        reallyEditing: reallyEditing,
        dirty: after.hasUnsavedChanges,
        keptCrlf: after.content.indexOf('\\r\\n') !== -1,
      };
    })()
  `);
  check(
    "leaving edit mode on a CRLF file does not dirty it or strip its endings",
    crlfSnapshot.reallyEditing === true &&
      crlfSnapshot.dirty !== true &&
      crlfSnapshot.keptCrlf === true,
    JSON.stringify(crlfSnapshot),
  );
  await sleep(800);
  await exec(`
    (() => {
      window.CustomTabs.getTabs().forEach(t => {
        t.content = t.originalContent;
        t.hasUnsavedChanges = false;
      });
      window.CustomTabs.switchToTab(${ids.a});
      window.dismissFileUpdateNotification();
      return true;
    })()
  `);
  await sleep(800);

  // ---- Scenario 5c2: reading position survives a tab switch in REAL split
  // view. Every other edit-mode scenario here only flips `window.isEditMode`,
  // which never applies the `split-view` class and so never exercises the CSS
  // that decides which element actually scrolls. That gap hid a real defect:
  // when #viewer stopped being a scroller, getScroller() still returned it, so
  // save and restore both operated on a node whose scrollTop is permanently 0
  // and the position was silently lost on every switch while editing.
  // Write to disk first, then reload: setting tab.content alone would leave the
  // cached document disagreeing with the file and trip the file-updated prompt,
  // whose native dialog blocks executeJavaScript forever.
  write(fileA, longDoc("SPLIT"));
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(500);
  await exec(`window.reloadCurrentFile(); null;`);
  await sleep(1500);
  await exec(`window.dismissFileUpdateNotification && window.dismissFileUpdateNotification(); null;`);
  await sleep(300);

  const splitScroll = await exec(`
    (async () => {
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      const wrapper = document.querySelector('.content-wrapper');
      const inSplit = wrapper.classList.contains('split-view');
      const s = window.CustomTabs.__getScroller
        ? window.CustomTabs.__getScroller()
        : document.getElementById('viewer');
      // Prove the chosen element is the one that genuinely scrolls, rather
      // than asserting against whatever the implementation happens to pick.
      const oy = getComputedStyle(s).overflowY;
      const canScroll = s.scrollHeight > s.clientHeight + 1;
      s.scrollTop = 400;
      await new Promise(r => setTimeout(r, 100));
      const parked = s.scrollTop;

      window.CustomTabs.switchToTab(${ids.b});
      await new Promise(r => setTimeout(r, 700));
      window.CustomTabs.switchToTab(${ids.a});
      await new Promise(r => setTimeout(r, 900));

      const s2 = window.CustomTabs.__getScroller
        ? window.CustomTabs.__getScroller()
        : document.getElementById('viewer');
      const restored = s2.scrollTop;
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 500));
      return {
        inSplit,
        scrollerId: s.id || s.className,
        overflowY: oy,
        canScroll,
        parked,
        restored,
      };
    })()
  `);
  check(
    "the split-view scroll test really entered split view on a scrollable pane",
    splitScroll.inSplit === true &&
      /^(auto|scroll)$/.test(splitScroll.overflowY) &&
      splitScroll.canScroll === true &&
      splitScroll.parked > 100,
    JSON.stringify(splitScroll),
  );
  check(
    "reading position survives a tab switch in split view",
    Math.abs(splitScroll.restored - splitScroll.parked) < 80,
    JSON.stringify(splitScroll),
  );
  await sleep(400);

  // ---- Scenario 5c2z: reading position survives a tab switch in split view
  // WHILE ZOOMED. 5c2 above proves the right ELEMENT is used; it cannot see a
  // coordinate-space error, because at 100% zoom the scroller's own pixels and
  // viewport pixels are the same thing. offsetWithin() converts a viewport-pixel
  // rect delta into the scroller's space, and in split view the scroller is
  // #viewer, which is the element renderer.js puts `zoom` on. Without the
  // conversion the remembered delta is scaled by the zoom factor and the reader
  // is dropped somewhere else entirely on every tab switch.
  const zoomScroll = await exec(`
    (async () => {
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      zoomLevel = 200;
      updateZoom();
      await new Promise(r => setTimeout(r, 400));
      const s = window.CustomTabs.__getScroller();
      // Guard: this only measures anything if the scroller really is the
      // zoomed element. If a future change moves the scroller back outside the
      // zoom, the conversion becomes a no-op and this scenario is vacuous.
      const zoomed = parseFloat(getComputedStyle(s).zoom) || 1;
      s.scrollTop = 400;
      await new Promise(r => setTimeout(r, 150));
      const parked = s.scrollTop;

      window.CustomTabs.switchToTab(${ids.b});
      await new Promise(r => setTimeout(r, 700));
      window.CustomTabs.switchToTab(${ids.a});
      await new Promise(r => setTimeout(r, 900));

      const restored = window.CustomTabs.__getScroller().scrollTop;
      zoomLevel = 100;
      updateZoom();
      await new Promise(r => setTimeout(r, 300));
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 500));
      return { zoomed, scrollerId: s.id || s.className, parked, restored };
    })()
  `);
  check(
    "the zoomed split-view scroll test really ran on the zoomed scroller",
    zoomScroll.zoomed === 2 && zoomScroll.parked > 100,
    JSON.stringify(zoomScroll),
  );
  check(
    "reading position survives a tab switch in split view while zoomed",
    Math.abs(zoomScroll.restored - zoomScroll.parked) < 80,
    JSON.stringify(zoomScroll),
  );
  await sleep(400);

  // ---- Scenario 5c3: undo keeps the reading position in REAL split view.
  // historyUndo/historyRedo save and restore contentWrapper.scrollTop
  // unconditionally, in BOTH the edit-mode and view-mode branches, and in
  // split view .content-wrapper is `overflow: hidden` so its scrollTop is
  // permanently 0. A reviewer predicted from that reading that the preview
  // would snap to the top on every undo while editing. It does not: the
  // measured result is parked=900, restored=900 on a document that genuinely
  // shrank by 60 paragraphs ABOVE the reading position. The position survives
  // because `undoRedoRendering` suppresses the only scrollTop reset in the
  // render path and patchViewerDOM keeps the surrounding nodes, so nothing
  // moves it in the first place. The contentWrapper save/restore is therefore
  // dead code in split view rather than a defect - and this scenario exists so
  // that if anyone ever removes the undoRedoRendering guard, the symptom the
  // reviewer described shows up as a failure instead of a bug report.
  const undoScroll = await exec(`
    (async () => {
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 700));
      const inSplit = document
        .querySelector('.content-wrapper')
        .classList.contains('split-view');
      // The rendered document must actually CHANGE across the undo, or the
      // scenario proves nothing: assigning markdownEditor.value does not
      // render, so pushing a state and undoing it would re-render the very
      // same document and the scroll offset would trivially survive.
      // So: render the LONG version, park the reader deep inside it, then undo
      // back to the short one. That removes content above the reading position
      // and is the case most likely to move the scroll offset.
      const shortDoc = markdownEditor.value;
      const longDoc = 'inserted paragraph.\\n\\n'.repeat(60) + shortDoc;
      historyPush(shortDoc);
      markdownEditor.value = longDoc;
      await renderMarkdown(longDoc);
      await new Promise(r => setTimeout(r, 400));

      const s = getViewerScroller();
      const canScroll = s.scrollHeight > s.clientHeight + 1;
      s.scrollTop = 900;
      await new Promise(r => setTimeout(r, 120));
      const parked = s.scrollTop;

      historyUndo();
      await new Promise(r => setTimeout(r, 1400));

      const restored = getViewerScroller().scrollTop;
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 500));
      return {
        inSplit,
        canScroll,
        parked,
        restored,
        scroller: s.id || s.className,
      };
    })()
  `);
  check(
    "the undo scroll test really entered split view on a scrollable pane",
    undoScroll.inSplit === true &&
      undoScroll.canScroll === true &&
      undoScroll.parked > 100,
    JSON.stringify(undoScroll),
  );
  check(
    "undo keeps the reading position in split view",
    Math.abs(undoScroll.restored - undoScroll.parked) < 80,
    JSON.stringify(undoScroll),
  );
  await sleep(400);

  write(fileM, "graph TD;\n  A-->B;\n");
  const mermaidTab = await exec(`
    (() => {
      const t = window.CustomTabs.createTab(${jsM}, '\\u0060\\u0060\\u0060mermaid\\ngraph TD;\\n  A-->B;\\n\\u0060\\u0060\\u0060');
      return t.id;
    })()
  `);
  await sleep(400);
  write(fileM, "graph TD;\n  A-->C;\n");
  await exec(`window.CustomTabs.switchToTab(${mermaidTab}); null;`);
  await sleep(1200);
  const afterMermaid = await exec(`
    (() => {
      const t = window.CustomTabs.getTabs().find(t => t.id === ${mermaidTab});
      return {
        content: t.content,
        dirty: t.hasUnsavedChanges,
        synced: t.content === t.originalContent,
      };
    })()
  `);
  check(
    "a refreshed .mmd tab keeps its mermaid fence and stays clean",
    afterMermaid.content.includes("```mermaid") &&
      afterMermaid.content.includes("A-->C") &&
      afterMermaid.dirty !== true &&
      afterMermaid.synced === true,
    JSON.stringify(afterMermaid),
  );
  await exec(`
    (() => {
      const t = window.CustomTabs.getTabs().find(t => t.id === ${mermaidTab});
      t.content = t.originalContent;
      t.hasUnsavedChanges = false;
      window.originalMarkdown = t.content;
      window.CustomTabs.closeTab(${mermaidTab});
      return true;
    })()
  `);
  await sleep(400);

  // ---- Scenario 6: closing tabs leaves no stale watcher / cache ---------
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(500);

  // A save result that lands after its tab was closed must not be applied to
  // whichever tab happens to be active now.
  const beforeStray = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = '# Alpha\\n\\nSTRAY_GUARD\\n';
      a.hasUnsavedChanges = true;
      window.originalMarkdown = a.content;
      window.ipcRenderer.emit('save-markdown-result', {}, {
        success: true,
        path: ${JSON.stringify(path.join(dir, "gone.md"))},
      });
      const after = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      return { content: after.content, dirty: after.hasUnsavedChanges };
    })()
  `);
  check(
    "save result for a closed tab does not clobber the active tab",
    beforeStray.content.includes("STRAY_GUARD") && beforeStray.dirty === true,
    JSON.stringify(beforeStray),
  );

  // Visual smoke: the assertions above all read state the code believes it has
  // rendered. None of them would notice the tab bar being covered by an
  // overlay, collapsed to zero height, or pushed off screen - which is exactly
  // how a tab bug looks to a user. Assert the pixels-level facts directly.
  // See test-visual-utils.js for why this is a DOM probe and not a pixel diff.
  // inspectVisual installs the probe itself, so no separate injection here.
  const tabsVisual = await inspectVisual(win, ".tab", {
    minWidth: 20,
    minHeight: 10,
  });
  check(
    "every open tab is rendered, on screen, unoccluded and unclipped",
    tabsVisual.count >= 1 && tabsVisual.soundCount === tabsVisual.count,
    JSON.stringify({ count: tabsVisual.count, unsound: tabsVisual.unsound }),
  );

  const viewerVisual = await inspectVisual(win, "#viewer", {
    minWidth: 200,
    minHeight: 100,
  });
  check(
    "the document viewer is rendered, on screen and unoccluded",
    viewerVisual.count === 1 && viewerVisual.soundCount === 1,
    JSON.stringify(viewerVisual.unsound),
  );

  // ---- Scenario 6b: a superseded render must not strand the overlay ------
  // renderMarkdownFull() opens with showLoadingScreen() and hides it at the
  // very end. It also bails out mid-way if a newer render has started, and that
  // bail-out used to `return` without hiding - so the full-screen,
  // click-blocking overlay stayed up forever.
  //
  // This is not a hypothetical: it fired on the ordinary startup path. Restoring
  // a tab began a full render, a second render superseded it, and the winner
  // took the light-format path which neither shows nor hides the overlay. The
  // app booted to a permanent "Loading..." screen with the document invisible
  // behind it - which is precisely what the visual probe above reported before
  // the fix, naming loadingScreen as the occluder.
  //
  // Supersession is forced directly rather than hoped for: two renders are
  // started in the same turn, so the first is guaranteed to be stale by the
  // time it reaches the bail-out.
  //
  // The winner MUST be a light-format render. Two overlapping 'full' renders
  // would not reproduce the bug - the winner would hide the overlay itself and
  // the loser's missing hide would be invisible. Only the full-superseded-by-
  // light ordering leaves nobody responsible for hiding it, which is exactly
  // the ordering the startup path produces.
  //
  // That ordering is only real if renderMarkdown actually takes the light path.
  // It falls back to a FULL render when _lastRenderedContent is null (see
  // renderer.js renderMarkdown), and two full renders would silently restore the
  // vacuous version of this test - it would pass with the fix reverted. Assert
  // the precondition locally rather than trusting scenario ordering.
  const lightPathAvailable = await exec(`_lastRenderedContent !== null`);
  check(
    "the light-format path is reachable, so this scenario is not vacuous",
    lightPathAvailable === true,
    "_lastRenderedContent is null; renderMarkdown would fall back to a full render",
  );
  await exec(`
    (() => {
      renderMarkdown('# Superseded render\\n\\nfirst', 'full');
      renderMarkdown('# Winning render\\n\\nsecond', 'light-format');
      return true;
    })()
  `);
  const overlayState = await waitForCondition(
    exec,
    `(() => {
       const el = document.getElementById('loadingScreen');
       return el && !el.classList.contains('active');
     })()`,
    8000,
  );
  check(
    "a superseded render does not leave the loading overlay up",
    overlayState === true,
    JSON.stringify(
      await exec(
        `({ active: document.getElementById('loadingScreen').classList.contains('active'),
            viewer: document.getElementById('viewer').textContent.slice(0, 40) })`,
      ),
    ),
  );

  // And the overlay must not be covering anything even when it is inactive.
  const overlayVisual = await inspectVisual(win, "#viewer", {
    minWidth: 200,
    minHeight: 100,
  });
  check(
    "the viewer is still unoccluded after overlapping renders",
    overlayVisual.count === 1 && overlayVisual.soundCount === 1,
    JSON.stringify(overlayVisual.unsound),
  );

  // ---- Scenario 6c: the overlay is owned, not shared ---------------------
  // Hiding on the way out of a superseded render is only half correct. If the
  // render that superseded it is ALSO a full render, it is still working, and a
  // loser that hides unconditionally would uncover a half-built document - the
  // overlay would drop on the FIRST completion instead of the last.
  //
  // Ownership makes both directions right, so assert both here: the loser must
  // stay quiet while a newer full render owns the overlay, and the overlay must
  // still come down once that winner finishes.
  const ownership = await exec(`
    (() => {
      const el = document.getElementById('loadingScreen');
      renderMarkdown('# Loser\\n\\n' + 'aaa '.repeat(200), 'full');
      renderMarkdown('# Winner\\n\\n' + 'bbb '.repeat(400), 'full');
      return { shownAtStart: el.classList.contains('active') };
    })()
  `);
  check(
    "two overlapping full renders raise the overlay",
    ownership.shownAtStart === true,
    JSON.stringify(ownership),
  );

  // The loser reaches its bail-out well before the winner finishes, but sampling
  // "mid-flight" by wall clock would be a flaky race. Assert the invariant that
  // actually protects the winner instead: a stale generation must not be able to
  // take the overlay down. This is deterministic and fails loudly if the
  // ownership check is removed or weakened.
  const staleCannotHide = await exec(`
    (() => {
      const el = document.getElementById('loadingScreen');
      const before = el.classList.contains('active');
      hideLoadingScreenFor(-1);      // a generation that never owned it
      const afterStale = el.classList.contains('active');
      hideLoadingScreenFor(0);       // the "nobody owns it" sentinel
      const afterSentinel = el.classList.contains('active');
      return { before, afterStale, afterSentinel };
    })()
  `);
  check(
    "a superseded render cannot take the overlay away from the current one",
    staleCannotHide.before === true &&
      staleCannotHide.afterStale === true &&
      staleCannotHide.afterSentinel === true,
    JSON.stringify(staleCannotHide),
  );

  const settled = await waitForCondition(
    exec,
    `(() => {
       const el = document.getElementById('loadingScreen');
       return el && !el.classList.contains('active');
     })()`,
    8000,
  );
  check(
    "the winning full render still clears the overlay when it finishes",
    settled === true,
    JSON.stringify(staleCannotHide),
  );
  check(
    "the winner ends up owning the rendered document",
    (await exec(`document.getElementById('viewer').textContent.includes('Winner')`)) === true,
    await exec(`document.getElementById('viewer').textContent.slice(0, 30)`),
  );

  // ---- Scenario 6d: the idle callback must carry a deadline --------------
  // The winning render hides the overlay from inside a requestIdleCallback. A
  // bare requestIdleCallback has NO deadline - the browser may defer it
  // indefinitely on a page that never goes idle, which would strand the overlay
  // for the winner in the same way the missing hide stranded it for the loser.
  // The {timeout} option is what bounds that, so assert it is actually passed.
  // The deadline itself is enforced by the browser, not by this code, so the
  // passing of the option IS the contract worth checking here.
  await exec(`
    (() => {
      const real = window.requestIdleCallback;
      window.__idleSeen = [];
      window.requestIdleCallback = function (cb, opts) {
        window.__idleSeen.push(opts || null);
        return real.call(window, cb, opts);
      };
      window.__restoreIdle = () => { window.requestIdleCallback = real; };
      renderMarkdown('# Idle deadline\\n\\nbody text', 'full');
      return true;
    })()
  `);
  await waitForCondition(
    exec,
    `(() => {
       const el = document.getElementById('loadingScreen');
       return el && !el.classList.contains('active');
     })()`,
    8000,
  );
  const idleSeen = await exec(`window.__idleSeen`);
  await exec(`(window.__restoreIdle(), true)`);
  check(
    "the render's idle callback is given a timeout so the overlay cannot be stranded",
    Array.isArray(idleSeen) &&
      idleSeen.length > 0 &&
      idleSeen.every((o) => o && typeof o.timeout === "number" && o.timeout > 0),
    JSON.stringify(idleSeen),
  );

  // Closing every tab must disarm the watcher, so an external change cannot
  // raise a "reload?" prompt over the welcome screen. Clear the dirty state
  // left by earlier scenarios first - closeTab() on a dirty tab raises a
  // native confirm() that would block the run indefinitely.
  await exec(`
    (() => {
      window.CustomTabs.getTabs().forEach(t => {
        t.content = t.originalContent;
        t.hasUnsavedChanges = false;
      });
      // closeTab() re-derives dirtiness from originalMarkdown, so it has to
      // agree with the active tab or the teardown raises a native confirm()
      // and blocks the run.
      const active = window.CustomTabs.getActiveTab && window.CustomTabs.getActiveTab();
      window.originalMarkdown = active ? active.originalContent : '';
      // ALL BUT THE LAST. The final close is done separately below so the
      // viewer-mutation counter can be read around IT specifically: closing a
      // non-last tab activates its neighbour and re-renders, which bumps the
      // counter too, so a delta taken across the whole loop would be satisfied
      // by any of those and would measure the disjunction rather than the
      // welcome-screen replacement it is named for.
      window.CustomTabs.getTabs().slice(0, -1).forEach(t => window.CustomTabs.closeTab(t.id));
      return window.CustomTabs.getTabs().length;
    })()
  `);
  // Let any render kicked off by those closes land, so it cannot be counted
  // against the final close.
  await sleep(600);
  const lastClose = JSON.parse(
    await exec(`
      (() => {
        const gen = () => window.viewerMutationGeneration();
        const tabs = window.CustomTabs.getTabs();
        if (tabs.length !== 1) return JSON.stringify({ single: false, n: tabs.length });
        const before = gen();
        const hadWelcome = !!document.querySelector('#viewer .welcome');
        window.CustomTabs.closeTab(tabs[0].id);
        const after = gen();
        return JSON.stringify({
          single: true,
          delta: after - before,
          hadWelcomeBefore: hadWelcome,
          welcomeShown: !!document.querySelector('#viewer .welcome'),
          remaining: window.CustomTabs.getTabs().length,
        });
      })()
    `),
  );
  console.log("note: last tab close " + JSON.stringify(lastClose));
  await exec(`(window.dismissFileUpdateNotification(), true)`);
  // Soundness: the delta means nothing unless the close really did replace the
  // viewer with the welcome screen, and unless the welcome screen was not
  // already there before.
  check(
    "closing the last tab really replaced the document with the welcome screen",
    lastClose.single === true &&
      lastClose.hadWelcomeBefore === false &&
      lastClose.welcomeShown === true &&
      lastClose.remaining === 0,
    JSON.stringify(lastClose),
  );
  // The viewer subtree is replaced wholesale here without any render, so a zoom
  // anchor captured against the document being closed would otherwise still
  // look valid and be applied to the welcome screen.
  // EXACTLY ONE, NOT "AT LEAST ONE". `>= 1` reports that SOMETHING bumped the
  // counter across the close, not that THIS site did - the disjunction defect.
  // The measured delta is exactly 1, and pinning it means a second, unrelated
  // bump appearing in this window can no longer keep the assertion green after
  // the welcome-screen bump itself has been reverted away.
  check(
    "replacing the closed document with the welcome screen is reported as a viewer mutation",
    lastClose.delta === 1,
    JSON.stringify(lastClose),
  );
  await sleep(400);
  // Write to the file the watcher was last armed on (the last tab closed),
  // otherwise no change event fires at all and the check proves nothing.
  write(fileB, "# Beta\n\nBETA_V13\n");
  await sleep(2200);
  check(
    "closing the last tab leaves no watcher raising prompts",
    (await promptShown()) === false,
    "toast shown with no tabs open",
  );

  // ---- Scenario 6: saving in view mode writes the persisted document -----
  // A CONTRACT test, not a user journey, and the distinction is deliberate.
  //
  // In view mode the textarea is not the source of truth: `originalMarkdown`
  // is what file-opened, file-reload-result and switchToTab write, and those
  // paths touch the textarea only when isEditMode is true. historyUndo /
  // historyRedo likewise update only `originalMarkdown` when isEditMode is
  // false (renderer.js:961, :988). So in view mode the textarea can hold a
  // previous tab's content, a previous file's content, or an undone edit.
  //
  // No shipping UI on this branch reaches saveMarkdownFile() in view mode -
  // Ctrl+S is gated on isEditMode and the save button is in the edit-mode-only
  // header - so this scenario calls it directly and asserts the contract. That
  // is worth pinning because upstream's ef81474 adds a view-mode save trigger,
  // and because the wrong behaviour here is silent data loss rather than a
  // visible error. The undo route is used to create the divergence because it
  // is the cheapest one that uses only the app's own functions.
  //
  // Driven through historyPush / historyUndo / saveMarkdownFile, and checked
  // against the bytes on disk and the in-memory document - never against the
  // implementation's own choice of store.
  // The preceding scenario deliberately closes every tab, so a tab has to be
  // reopened here - otherwise saveMarkdownFile() takes its no-file-open branch
  // and raises a blocking alert instead of saving.
  const tabC = await exec(`
    (() => {
      const t = window.CustomTabs.createTab(${jsA}, window.fs.readFileSync(${jsA}, 'utf8'));
      window.CustomTabs.switchToTab(t.id);
      return t.id;
    })()
  `);
  await sleep(600);
  const undoSave = await exec(`
    (async () => {
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 300));
      // Make the undo stack local to this scenario. Without it the assertions
      // below depend on whatever every preceding scenario left on the stack,
      // which is a global invariant masquerading as a local one.
      historyClear();
      window.originalMarkdown = '# Alpha\\n\\nV_ONSCREEN\\n';
      markdownEditor.value = window.originalMarkdown;
      historyPush(window.originalMarkdown);
      // A view-mode edit: both stores move together, as the edit paths do.
      window.originalMarkdown = '# Alpha\\n\\nV_EDITED\\n';
      markdownEditor.value = window.originalMarkdown;
      // Ctrl+Z in view mode moves originalMarkdown back and leaves the
      // textarea holding V_EDITED. This is the app's own code, not the test's.
      historyUndo();
      await new Promise(r => setTimeout(r, 600));
      return JSON.stringify({
        editMode: isEditMode,
        hasPath: !!currentFilePath,
        onScreen: window.originalMarkdown.includes('V_ONSCREEN'),
        editorStale: markdownEditor.value.includes('V_EDITED'),
      });
    })()
  `);
  const undoState = JSON.parse(undoSave);
  // Vacuity guard: if the two stores had not actually diverged, saving either
  // one would write the same bytes and the assertion below could not fail.
  // hasPath is part of the guard because saveMarkdownFile() silently does
  // nothing useful without a current file.
  check(
    "a view-mode undo really does leave the editor holding different content",
    undoState.editMode === false &&
      undoState.hasPath === true &&
      undoState.onScreen === true &&
      undoState.editorStale === true,
    undoSave,
  );

  await exec(`saveMarkdownFile(); null;`);
  await sleep(900);
  const onDisk = fs.readFileSync(fileA, "utf8");
  check(
    "saving in view mode writes the content on screen, not a stale editor buffer",
    onDisk.includes("V_ONSCREEN") && !onDisk.includes("V_EDITED"),
    onDisk,
  );
  // The second half of the same defect: the save-result handler used to copy
  // the stale editor value back over originalMarkdown, so the undo was lost
  // in memory as well and came back on the next render.
  const afterSave = await exec(`window.originalMarkdown`);
  check(
    "a successful view-mode save does not overwrite the in-memory document",
    afterSave.includes("V_ONSCREEN") && !afterSave.includes("V_EDITED"),
    afterSave,
  );

  // ---- Scenario 7: exiting edit mode discards, and warns that it will ----
  // Measured bug, three clicks, silent: type in edit mode, click Exit, accept
  // the confirm, and the app left the editor buffer holding the typing, the
  // dirty flag true, the preview showing the typed text, and `originalMarkdown`
  // still on the last saved content. Re-entering edit mode then reset the
  // textarea from `originalMarkdown` and cleared the dirty flag, so the typing
  // was destroyed, the app reported "clean", and the preview went on showing
  // text no store held.
  //
  // The user's decision: discard, because there is no way to save from view
  // mode, and say so in the warning. So the discard must actually happen and
  // must be complete - including the undo entries the session pushed, or Ctrl+Z
  // hands the discarded text straight back with no dirty indicator.
  //
  // Deliberately checked here: the rollback is SURGICAL. An undo point made
  // before the edit session must survive it.
  const discardOut = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (msg) => { seen.push(String(msg)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 600));
      historyClear();
      historyPush('# Alpha\\n\\nS7_OLD_UNDO_POINT\\n');
      window.originalMarkdown = '# Alpha\\n\\nS7_SAVED\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Alpha\\n\\nS7_EARLY\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1400));
      markdownEditor.value = '# Alpha\\n\\nS7_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 3600));
      // Use undo and redo INSIDE the session before discarding. Both move
      // entries between the stacks without going through historyPush, so a
      // rollback that counts pushes drifts here and eats the pre-session entry.
      // Without these three calls the buggy and the correct implementation
      // agree, and the assertion below passes for the wrong reason.
      historyUndo();
      await new Promise(r => setTimeout(r, 400));
      historyUndo();
      await new Promise(r => setTimeout(r, 400));
      historyRedo();
      await new Promise(r => setTimeout(r, 600));
      const before = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        viewerShowsTyped: viewer.textContent.includes('S7_TYPED'),
        undoDepth: undoHistory.length,
      };
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 1800));
      const after = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        textareaMatchesStore: markdownEditor.value === window.originalMarkdown,
        storeIsSaved: window.originalMarkdown.includes('S7_SAVED'),
        viewerShowsTyped: viewer.textContent.includes('S7_TYPED'),
        viewerShowsSaved: viewer.textContent.includes('S7_SAVED'),
      };
      historyUndo();
      await new Promise(r => setTimeout(r, 1000));
      const undone = {
        resurrected: window.originalMarkdown.includes('S7_TYPED') ||
          window.originalMarkdown.includes('S7_EARLY'),
        olderPointReached: window.originalMarkdown.includes('S7_OLD_UNDO_POINT'),
      };
      window.confirm = realConfirm;
      return JSON.stringify({ warned: seen, before: before, after: after, undone: undone });
    })()
  `);
  const discard = JSON.parse(discardOut);
  // Vacuity guard: an edit-mode session that never diverged would make every
  // assertion below true for free.
  check(
    "the edit-mode session really did diverge from the saved content",
    discard.before.editMode === true &&
      discard.before.dirty === true &&
      discard.before.viewerShowsTyped === true &&
      discard.before.undoDepth > 1,
    discardOut,
  );
  check(
    "the exit warning states that the changes will be discarded",
    discard.warned.length === 1 && /discard/i.test(discard.warned[0]),
    JSON.stringify(discard.warned),
  );
  check(
    "exiting edit mode discards the unsaved edit from every store",
    discard.after.editMode === false &&
      discard.after.dirty === false &&
      discard.after.textareaMatchesStore === true &&
      discard.after.storeIsSaved === true,
    discardOut,
  );
  check(
    "the preview is repainted from the saved content, not left showing the discard",
    discard.after.viewerShowsSaved === true && discard.after.viewerShowsTyped === false,
    discardOut,
  );
  check(
    "undo cannot resurrect discarded content, and older undo points survive",
    discard.undone.resurrected === false && discard.undone.olderPointReached === true,
    JSON.stringify(discard.undone),
  );
  const shotDiscard = await captureScreenshot(win, "tabs-exit-edit-discard");
  if (shotDiscard) console.log("discard screenshot: " + shotDiscard);

  // ---- Scenario 8: the discard survives a tab round trip ----------------
  // Both reviewers found this independently, from opposite directions.
  // switchToTab seeds `window.originalMarkdown` from `tab.content`, and
  // snapshotActiveTab folds the dirty textarea INTO `tab.content` while edit
  // mode is on. So editing tab A, visiting tab B and coming back leaves the
  // session's own unsaved text sitting in `originalMarkdown` - which means a
  // discard that restores "from originalMarkdown" restores the very edit it
  // was asked to throw away, and then marks it clean.
  //
  // The fix is to restore from a baseline captured when the session began, and
  // to re-capture that baseline whenever the active document changes while edit
  // mode stays on, so the discard can never write another tab's text here.
  //
  // The final round trip is the part that matters most: the tab record keeps
  // its own copy, so a discard that fixes only the renderer's globals still
  // lets the next tab switch replay the discarded text.
  const s8 = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (m) => { seen.push(String(m)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 600));
      const findOrMake = (p) => {
        const found = window.CustomTabs.getTabs().find(t => t.filePath === p);
        return found || window.CustomTabs.createTab(p, window.fs.readFileSync(p, 'utf8'));
      };
      const tA = findOrMake(${jsA});
      const tB = findOrMake(${jsB});
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 800));
      // Make tab A GENUINELY clean: content === originalContent. Otherwise
      // snapshotActiveTab's view-mode branch (which only folds originalMarkdown
      // back into tab.content when the two DIFFER) papers over the replay hole
      // and this scenario stops testing it.
      window.CustomTabs.updateTabContent(window.originalMarkdown, false);
      await new Promise(r => setTimeout(r, 300));
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Alpha\\n\\nS8_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1200));
      window.CustomTabs.switchToTab(tB.id);
      await new Promise(r => setTimeout(r, 900));
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 900));
      const contaminated = {
        editMode: isEditMode,
        storeHasTyped: window.originalMarkdown.includes('S8_TYPED'),
      };
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      const after = {
        editMode: isEditMode,
        storeHasTyped: window.originalMarkdown.includes('S8_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S8_TYPED'),
      };
      window.CustomTabs.switchToTab(tB.id);
      await new Promise(r => setTimeout(r, 900));
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 1000));
      const replay = {
        storeHasTyped: window.originalMarkdown.includes('S8_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S8_TYPED'),
      };
      window.confirm = realConfirm;
      return JSON.stringify({ warned: seen.length, contaminated: contaminated, after: after, replay: replay });
    })()
  `);
  const tabDiscard = JSON.parse(s8);
  // Vacuity guard, and it is the whole point of this scenario: if the tab round
  // trip did NOT push the session's text into the document store, every
  // assertion below would pass without exercising the bug at all.
  check(
    "a tab round trip in edit mode really does put the session's text into the document store",
    tabDiscard.contaminated.editMode === true &&
      tabDiscard.contaminated.storeHasTyped === true &&
      tabDiscard.warned === 1,
    s8,
  );
  check(
    "discarding after a tab round trip does not restore the discarded text",
    tabDiscard.after.editMode === false &&
      tabDiscard.after.storeHasTyped === false &&
      tabDiscard.after.viewerHasTyped === false,
    s8,
  );
  check(
    "a later tab switch cannot replay the discarded text from the tab record",
    tabDiscard.replay.storeHasTyped === false && tabDiscard.replay.viewerHasTyped === false,
    s8,
  );

  // ---- Scenario 8b: discarding on a tab the session did not start on -----
  // The case that makes the switchToTab hook load-bearing. The session begins
  // on tab A, so only A has a baseline; if the user then types on tab B and
  // discards there, a lookup for B finds nothing and the discard silently
  // degrades into "keep the text, mark it clean" - the original bug, on the
  // other tab. The hook gives B a baseline of its own on arrival.
  const s8b = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 600));
      const tabsNow = window.CustomTabs.getTabs();
      const tA = tabsNow.find(t => t.filePath === ${jsA});
      const tB = tabsNow.find(t => t.filePath === ${jsB});
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 800));
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Alpha\\n\\nS8B_ON_A\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1200));
      window.CustomTabs.switchToTab(tB.id);
      await new Promise(r => setTimeout(r, 900));
      const bBefore = window.originalMarkdown;
      markdownEditor.value = '# Beta\\n\\nS8B_ON_B\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1200));
      const diverged = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        viewerHasB: viewer.textContent.includes('S8B_ON_B'),
      };
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      // Capture BEFORE the undo below. Building this object inside the return
      // statement would evaluate it after historyUndo() had already moved the
      // document, which reads as a discard failure that never happened.
      const after = {
        editMode: isEditMode,
        storeHasB: window.originalMarkdown.includes('S8B_ON_B'),
        viewerHasB: viewer.textContent.includes('S8B_ON_B'),
        restoredToArrival: window.originalMarkdown === bBefore,
        dirty: hasUnsavedChanges,
        arrival: bBefore.slice(0, 80),
        final: window.originalMarkdown.slice(0, 80),
      };
      // The hook's real payload on this tab: without a baseline of its own the
      // discard cannot roll the history back, so one Ctrl+Z hands the
      // discarded text straight back - the R89 defect, on the other tab.
      historyUndo();
      await new Promise(r => setTimeout(r, 1000));
      const undoAfter = {
        resurrectedB: window.originalMarkdown.includes('S8B_ON_B'),
        viewerHasB: viewer.textContent.includes('S8B_ON_B'),
      };
      window.confirm = realConfirm;
      return JSON.stringify({ diverged: diverged, undoAfter: undoAfter, after: after });
    })()
  `);
  const otherTab = JSON.parse(s8b);
  check(
    "the edit really diverged on the second tab, so the discard there can fail",
    otherTab.diverged.editMode === true &&
      otherTab.diverged.dirty === true &&
      otherTab.diverged.viewerHasB === true,
    s8b,
  );
  check(
    "discarding on a tab the session did not start on restores that tab's own content",
    otherTab.after.editMode === false &&
      otherTab.after.storeHasB === false &&
      otherTab.after.viewerHasB === false &&
      otherTab.after.restoredToArrival === true,
    s8b,
  );
  check(
    "undo cannot resurrect content discarded on a tab the session did not start on",
    otherTab.undoAfter.resurrectedB === false && otherTab.undoAfter.viewerHasB === false,
    JSON.stringify(otherTab.undoAfter),
  );
  // The baseline records the dirty flag as well as the document. It is captured
  // on arrival, and used to be captured BEFORE switchToTab moved the flag to
  // the arriving tab's value - so it baked in the previous tab's dirty state
  // and a discard here left an "unsaved" indicator on a document with nothing
  // unsaved in it. Tab B arrives clean, so the flag must be clean afterwards.
  check(
    "discarding on a clean tab does not inherit the previous tab's unsaved state",
    otherTab.after.dirty === false,
    s8b,
  );

  // ---- Scenario 9: Save clicked, then Exit before the write comes back ----
  // Raised by GPT-5.4 while reviewing the discard. Clicking Save dispatches an
  // async IPC write and clears nothing; `hasUnsavedChanges` stays true until
  // `save-markdown-result` arrives. So an Exit in that window used to (a) warn
  // that changes would be DISCARDED when the user had just asked to save them,
  // and (b) actually discard them in the renderer while the main process wrote
  // them to disk - leaving the file and the app holding different documents,
  // with no indicator that anything had happened.
  //
  // The race is made deterministic rather than hoped for: Save and Exit are
  // issued in one synchronous task, and an IPC reply cannot be delivered before
  // that task yields.
  const raceOut = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (msg) => { seen.push(String(msg)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9_SAVED\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      const before = { editMode: isEditMode, dirty: hasUnsavedChanges };
      // One synchronous task: the save reply cannot land between these two.
      saveButton.click();
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2500));
      const after = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        storeHasTyped: window.originalMarkdown.includes('S9_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S9_TYPED'),
      };
      // The user's ORIGINAL complaint, in a new disguise: a save that leaves
      // the tab record on the pre-save document means the next tab switch
      // repaints the file as it was before the save, from memory.
      const tabs = window.CustomTabs.getTabs();
      const other = tabs.find(t => t.filePath !== window.currentFilePath);
      let replay = null;
      if (other) {
        const mine = window.CustomTabs.getActiveTab().id;
        window.CustomTabs.switchToTab(other.id);
        await new Promise(r => setTimeout(r, 900));
        window.CustomTabs.switchToTab(mine);
        await new Promise(r => setTimeout(r, 1000));
        replay = {
          storeHasTyped: window.originalMarkdown.includes('S9_TYPED'),
          viewerHasTyped: viewer.textContent.includes('S9_TYPED'),
        };
      }
      window.confirm = realConfirm;
      return JSON.stringify({
        warned: seen,
        before: before,
        path: window.currentFilePath,
        after: after,
        replay: replay,
      });
    })()
  `);
  const race = JSON.parse(raceOut);
  const diskAfterRace = fs.readFileSync(race.path, "utf8");
  check(
    "the save-then-exit race really was set up: dirty edit-mode content and a real write",
    race.before.editMode === true &&
      race.before.dirty === true &&
      diskAfterRace.includes("S9_TYPED"),
    raceOut + " disk=" + JSON.stringify(diskAfterRace.slice(0, 60)),
  );
  check(
    "exiting during a save does not warn that the changes will be discarded",
    race.warned.length === 0,
    JSON.stringify(race.warned),
  );
  check(
    "the document the app shows after a save-then-exit is the document on disk",
    race.after.storeHasTyped === true &&
      race.after.viewerHasTyped === true &&
      race.after.dirty === false,
    raceOut + " disk=" + JSON.stringify(diskAfterRace.slice(0, 60)),
  );
  const shotRace = await captureScreenshot(win, "tabs-save-then-exit");
  if (shotRace) console.log("save-race screenshot: " + shotRace);
  check(
    "a saved document survives a tab round trip instead of reverting to the pre-save text",
    race.replay !== null &&
      race.replay.storeHasTyped === true &&
      race.replay.viewerHasTyped === true,
    raceOut,
  );

  // ---- Scenario 9b: typing while the write is in flight ------------------
  // The save wrote the bytes it was handed, not the bytes that are in the
  // textarea by the time the reply lands. Re-reading the textarea there marks
  // the document saved when it is not: `originalMarkdown` starts describing a
  // file that was never written, the dirty indicator goes out, and the next
  // exit discards the difference without warning. The disk is the oracle here.
  const duringOut = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9B_BASE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9B_SENT\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1400));
      // One synchronous task again: the keystroke lands after the write was
      // dispatched and before its reply can possibly arrive.
      saveButton.click();
      markdownEditor.value = '# Beta\\n\\nS9B_AFTER\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 2500));
      const out = {
        editMode: isEditMode,
        storeIsSent: window.originalMarkdown.includes('S9B_SENT'),
        storeIsAfter: window.originalMarkdown.includes('S9B_AFTER'),
        dirty: hasUnsavedChanges,
        textarea: markdownEditor.value.includes('S9B_AFTER'),
        path: window.currentFilePath,
      };
      window.confirm = realConfirm;
      return JSON.stringify(out);
    })()
  `);
  const during = JSON.parse(duringOut);
  const diskDuring = fs.readFileSync(during.path, "utf8");
  check(
    "the type-during-save race really was set up: the write and the buffer diverged",
    during.editMode === true &&
      during.textarea === true &&
      diskDuring.includes("S9B_SENT") &&
      !diskDuring.includes("S9B_AFTER"),
    duringOut + " disk=" + JSON.stringify(diskDuring.slice(0, 60)),
  );
  check(
    "after a save the document store holds the bytes that were written, not later keystrokes",
    during.storeIsSent === true && during.storeIsAfter === false,
    duringOut + " disk=" + JSON.stringify(diskDuring.slice(0, 60)),
  );
  check(
    "keystrokes made during a save are still reported as unsaved",
    during.dirty === true,
    duringOut,
  );

  // ---- Scenario 9c: the save reply lands while another tab is active -----
  // Both reviewers found this independently. custom-tabs.js takes over the
  // save-markdown-result channel and used to swallow replies whose path was
  // not the active document. A save on tab A followed by a switch to tab B
  // therefore never reached the renderer: the promise the exit path parks on
  // was stranded, `originalMarkdown` for A never adopted the write, and coming
  // back to A and clicking Exit sat on a 5s timeout and then offered to
  // DISCARD a save that had already succeeded.
  const bgOut = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (msg) => { seen.push(String(msg)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      // The preceding scenario deliberately leaves a dirty edit session open,
      // so the cleanup click above raises its own discard confirm. Only the
      // prompts this scenario provokes are being measured.
      seen.length = 0;
      const tabs = window.CustomTabs.getTabs();
      const mine = window.CustomTabs.getActiveTab();
      const other = tabs.find(t => t.filePath !== mine.filePath);
      window.originalMarkdown = '# Beta\\n\\nS9C_BASE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      window.CustomTabs.updateTabContent(window.originalMarkdown, false);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9C_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      // One synchronous task: the reply cannot arrive before we have left.
      saveButton.click();
      window.CustomTabs.switchToTab(other.id);
      await new Promise(r => setTimeout(r, 2500));
      // The reply for the background document landed while THIS one was on
      // screen. It must not have been applied to it.
      const otherStore = {
        clean: !window.originalMarkdown.includes('S9C_TYPED'),
        viewerClean: !viewer.textContent.includes('S9C_TYPED'),
      };
      window.CustomTabs.switchToTab(mine.id);
      await new Promise(r => setTimeout(r, 1200));
      const beforeExit = {
        dirty: hasUnsavedChanges,
        tabDirty: window.CustomTabs.getActiveTab().hasUnsavedChanges,
        activePath: window.currentFilePath,
        tabContentHasTyped: window.CustomTabs.getActiveTab().content.includes('S9C_TYPED'),
        tabOriginalHasTyped: String(window.CustomTabs.getActiveTab().originalContent).includes('S9C_TYPED'),
      };
      const t0 = Date.now();
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2200));
      const elapsed = Date.now() - t0;
      window.confirm = realConfirm;
      return JSON.stringify({
        warned: seen,
        elapsed: elapsed,
        path: mine.filePath,
        beforeExit: beforeExit,
        otherStore: otherStore,
        editMode: isEditMode,
        storeHasTyped: window.originalMarkdown.includes('S9C_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S9C_TYPED'),
      });
    })()
  `);
  const bg = JSON.parse(bgOut);
  const diskBg = fs.readFileSync(bg.path, "utf8");
  check(
    "the background-save case really was set up: the write reached disk from a tab left in the background",
    diskBg.includes("S9C_TYPED"),
    bgOut + " disk=" + JSON.stringify(diskBg.slice(0, 60)),
  );
  check(
    "a save whose reply arrived on another tab is not offered for discard on return",
    bg.warned.length === 0 && bg.editMode === false,
    bgOut,
  );
  check(
    "returning to a tab saved in the background shows the saved document, not the pre-save text",
    bg.storeHasTyped === true && bg.viewerHasTyped === true,
    bgOut + " disk=" + JSON.stringify(diskBg.slice(0, 60)),
  );
  check(
    "a save that completes for a background document is not applied to the document on screen",
    bg.otherStore.clean === true && bg.otherStore.viewerClean === true,
    bgOut,
  );
  check(
    "exiting after a completed background save does not stall on the in-flight timeout",
    bg.elapsed < 4500,
    JSON.stringify({ elapsed: bg.elapsed }),
  );

  // ---- Scenario 9d: two writes in flight at once -------------------------
  // A single pending slot cross-wires them: the first reply adopts the SECOND
  // request's bytes, so the store claims a document that is not yet on disk.
  // Ctrl+S twice, or Save then Ctrl+S, reaches this with no exotic timing.
  //
  // THE OUTCOME ON DISK IS NOT A SOUND ORACLE FOR THE SERIALISATION, and R102
  // was vacuous because of it. Without queueSave the two writes are concurrent
  // open-truncate-write sequences and WHICH ONE LANDS LAST IS DECIDED BY THE
  // OS - so "the last write won" fails only when the scheduler happens to
  // cooperate, and a revert that removes the fix reports VACUOUS the rest of
  // the time. Same disease as R57 riding on parity: a real property measured
  // through something that is not deterministic.
  //
  // queueSave exposes monotonic main-process diagnostics. They are the real
  // queue's observation point, so unlike the old fs.writeFile monkeypatch this
  // remains valid when production writes through FileHandle.writeFile().
  const saveQueueBefore = __shutdown.state();
  const twoOut = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9D_BASE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9D_FIRST\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1400));
      // Both writes dispatched in one synchronous task, so both are in flight
      // before either reply can be delivered.
      saveButton.click();
      markdownEditor.value = '# Beta\\n\\nS9D_SECOND\\n';
      saveButton.click();
      await new Promise(r => setTimeout(r, 2800));
      const out = {
        editMode: isEditMode,
        storeIsSecond: window.originalMarkdown.includes('S9D_SECOND'),
        storeIsFirst: window.originalMarkdown.includes('S9D_FIRST'),
        dirty: hasUnsavedChanges,
        path: window.currentFilePath,
      };
      window.confirm = realConfirm;
      return JSON.stringify(out);
    })()
  `);
  const two = JSON.parse(twoOut);
  const saveQueueAfter = __shutdown.state();
  const diskTwo = fs.readFileSync(two.path, "utf8");
  check(
    "two saves to one path are serialised by the main-process queue",
    saveQueueAfter.saveQueueEnqueuedCount === saveQueueBefore.saveQueueEnqueuedCount + 2 &&
      saveQueueAfter.saveQueueStartedCount === saveQueueBefore.saveQueueStartedCount + 2 &&
      saveQueueAfter.saveQueueCompletedCount === saveQueueBefore.saveQueueCompletedCount + 2 &&
      saveQueueAfter.saveQueuePendingCount === 0 &&
      saveQueueAfter.saveQueueActivePathCount === 0 &&
      saveQueueAfter.saveQueueOverlapCount === saveQueueBefore.saveQueueOverlapCount &&
      saveQueueAfter.saveQueueMaxActiveForSinglePath === 1,
    JSON.stringify({ before: saveQueueBefore, after: saveQueueAfter }),
  );
  check(
    "the two-writes-in-flight case really was set up: the last write won on disk",
    two.editMode === true && diskTwo.includes("S9D_SECOND"),
    twoOut + " disk=" + JSON.stringify(diskTwo.slice(0, 60)),
  );
  check(
    "with two writes in flight the document store ends on the bytes that are actually on disk",
    two.storeIsSecond === true && two.storeIsFirst === false && two.dirty === false,
    twoOut + " disk=" + JSON.stringify(diskTwo.slice(0, 60)),
  );

  // ---- Scenario 9e: a reload underneath an open edit session -------------
  // Both reviewers found this too. The baseline is captured on edit-mode entry;
  // a reload replaces the document without moving it, so a later discard
  // restores the PRE-reload text and silently undoes the reload as well - the
  // user's own original complaint (a refresh reverting a file) reappearing
  // through the discard path.
  const reloadOut = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9E_STALE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      // The file on disk still holds whatever the previous scenario wrote, so
      // reloading brings in content the session never saw.
      reloadCurrentFile();
      await new Promise(r => setTimeout(r, 2000));
      const reloaded = markdownEditor.value;
      markdownEditor.value = reloaded + '\\nS9E_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      window.confirm = realConfirm;
      return JSON.stringify({
        reloadedWasDifferent: !reloaded.includes('S9E_STALE'),
        reloaded: reloaded.slice(0, 60),
        editMode: isEditMode,
        restoredToReloaded: window.originalMarkdown === reloaded,
        wentBackToStale: window.originalMarkdown.includes('S9E_STALE'),
        keptTyping: window.originalMarkdown.includes('S9E_TYPED'),
        final: window.originalMarkdown.slice(0, 60),
      });
    })()
  `);
  const reload = JSON.parse(reloadOut);
  check(
    "the reload case really was set up: the reload brought in content the session had not seen",
    reload.reloadedWasDifferent === true,
    reloadOut,
  );
  check(
    "discarding after a reload restores the reloaded document, not the pre-reload text",
    reload.editMode === false &&
      reload.restoredToReloaded === true &&
      reload.wentBackToStale === false &&
      reload.keptTyping === false,
    reloadOut,
  );

  const errors = await exec(`window.__e2eErrors || []`);
  check("no uncaught renderer errors", errors.length === 0, JSON.stringify(errors));

  // ---- Scenario 10: the size guard on a lazy tab -------------------------
  // Tabs render lazily: createTab() only stores the text, switchToTab() is
  // what pays. So a document that arrived by multi-select or session restore
  // has never passed main.js's open-time guard, and the click on its tab is
  // the first moment the cost is real. Declining must leave the reader exactly
  // where they were - which is why the guard runs before snapshotActiveTab().
  //
  // The sample is a long run of pipes: the estimator scores it as expensive
  // (pipes are table cells) while marked renders it as one paragraph, so BOTH
  // branches are cheap to drive. That divergence is deliberate - a genuinely
  // 10-second document would make this scenario cost 10 seconds.
  const fileBig = path.join(dir, "guard-big.md");
  const fileSmall = path.join(dir, "guard-small.md");
  const jsBig = JSON.stringify(fileBig);
  const jsSmall = JSON.stringify(fileSmall);
  write(fileBig, "|".repeat(260000) + "\n");
  write(fileSmall, "# Small\n\nGUARD_SMALL_DOC\n");

  const guard = await exec(`
    (async () => {
      const out = {};
      // NOTE: this require is evaluated in the RENDERER, so it resolves against
      // the renderer's own directory (beside file-helpers.js), not against this
      // test file. It stays './' even though this suite lives in test/.
      const helpers = require('./file-helpers');
      out.bigIsLarge = helpers.isLargeDocument(window.fs.readFileSync(${jsBig}, 'utf8')).large;
      out.smallIsLarge = helpers.isLargeDocument(window.fs.readFileSync(${jsSmall}, 'utf8')).large;

      const realSendSync = window.ipcRenderer.sendSync;
      let asked = 0;
      let answer = false;
      window.ipcRenderer.sendSync = function (channel) {
        if (channel === 'confirm-large-render') { asked++; return answer; }
        return realSendSync.apply(this, arguments);
      };
      try {
        const small = window.CustomTabs.createTab(${jsSmall}, window.fs.readFileSync(${jsSmall}, 'utf8'));
        await new Promise(r => setTimeout(r, 400));
        out.askedForSmall = asked;
        out.smallOnScreen = document.getElementById('viewer').textContent.indexOf('GUARD_SMALL_DOC') !== -1;

        // createTab() switches to the new tab, so opening an expensive file is
        // itself a guarded switch. Declining here must leave the reader on the
        // document they were already reading - the multi-select case.
        answer = false;
        const big = window.CustomTabs.createTab(${jsBig}, window.fs.readFileSync(${jsBig}, 'utf8'));
        await new Promise(r => setTimeout(r, 400));
        out.askedOnCreate = asked - out.askedForSmall;
        out.activeAfterCreate = window.CustomTabs.getActiveTabId() === small.id;

        let mark = asked;
        window.CustomTabs.switchToTab(big.id);
        await new Promise(r => setTimeout(r, 400));
        out.askedOnDecline = asked - mark;
        out.activeAfterDecline = window.CustomTabs.getActiveTabId() === small.id;
        out.viewerAfterDecline = document.getElementById('viewer').textContent.indexOf('GUARD_SMALL_DOC') !== -1;

        mark = asked;
        answer = true;
        window.CustomTabs.switchToTab(big.id);
        await new Promise(r => setTimeout(r, 800));
        out.askedOnAccept = asked - mark;
        out.activeAfterAccept = window.CustomTabs.getActiveTabId() === big.id;

        mark = asked;
        window.CustomTabs.switchToTab(small.id);
        await new Promise(r => setTimeout(r, 400));
        window.CustomTabs.switchToTab(big.id);
        await new Promise(r => setTimeout(r, 400));
        out.askedOnRevisit = asked - mark;
        out.activeAfterRevisit = window.CustomTabs.getActiveTabId() === big.id;

        [big.id, small.id].forEach(id => {
          const t = window.CustomTabs.getTabs().find(x => x.id === id);
          if (t) t.hasUnsavedChanges = false;
          window.CustomTabs.closeTab(id);
        });
      } finally {
        window.ipcRenderer.sendSync = realSendSync;
      }
      return out;
    })()
  `);
  await sleep(400);

  // Vacuity guards. If the sample stopped tripping the estimator, or the small
  // document started tripping it, every assertion below would pass for the
  // wrong reason.
  check(
    "the guard sample really is scored as expensive and the control is not",
    guard.bigIsLarge === true && guard.smallIsLarge === false,
    JSON.stringify(guard),
  );
  check(
    "an ordinary document is never asked about",
    guard.askedForSmall === 0 && guard.smallOnScreen === true,
    JSON.stringify(guard),
  );
  check(
    "opening an expensive file asks, and declining leaves the reader put",
    guard.askedOnCreate === 1 && guard.activeAfterCreate === true,
    JSON.stringify(guard),
  );
  check(
    "switching to an expensive tab asks first",
    guard.askedOnDecline === 1,
    JSON.stringify(guard),
  );
  check(
    "declining leaves the reader on the tab they were viewing",
    guard.activeAfterDecline === true,
    JSON.stringify(guard),
  );
  check(
    "declining leaves the document they were reading on screen",
    guard.viewerAfterDecline === true,
    JSON.stringify(guard),
  );
  check(
    "accepting switches to the expensive tab",
    guard.askedOnAccept === 1 && guard.activeAfterAccept === true,
    JSON.stringify(guard),
  );
  check(
    "a cost already accepted is not asked about again",
    guard.askedOnRevisit === 0 && guard.activeAfterRevisit === true,
    JSON.stringify(guard),
  );

  // ---- Scenario 11: the single-row top bar --------------------------------
  // The header was two rows (logo + product name + menu items, then a file
  // location bar, then a separate tab strip that only appeared at 2+ tabs).
  // It is now ONE bar: [tab strip] [reload] [hamburger]. Every assertion here
  // guards a property that was measured to be wrong at some point while
  // building it, so none of them is decorative.
  //
  // This is a GEOMETRIC block, so it pins the window itself. main.js persists
  // window bounds on every resize, which means a suite that measures without
  // pinning is measuring whatever the last run left behind.
  {
    const setInner = async (w, h) => {
      for (let i = 0; i < 40; i++) {
        if (i % 10 === 0) {
          win.unmaximize();
          win.setBounds({ x: 40, y: 40, width: w, height: h });
        }
        await sleep(100);
        // getBounds() reports the size that was REQUESTED, so it lies during a
        // transition and after a request a maximized window silently swallowed.
        // innerWidth is the number the layout actually used.
        const ok = await exec(`Math.abs(window.innerWidth - ${w}) <= 24`);
        if (ok) return true;
      }
      return false;
    };

    const sized = await setInner(1400, 900);
    check(
      "the layout block could pin the window, so its geometry is not inherited",
      sized === true,
      "window never reached the requested inner width",
    );

    // Clean slate: earlier scenarios leave tabs behind and the strip's overflow
    // state is the thing under test.
    await exec(`
      window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
      window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
      null;
    `);
    await sleep(300);

    const layoutFiles = [];
    for (let i = 0; i < 8; i++) {
      const p = path.join(dir, `bar-document-${i}-with-a-long-name.md`);
      write(p, `# Bar ${i}\n\nBAR_BODY_${i}\n`);
      layoutFiles.push(p);
    }

    // --- one document ---
    await exec(
      `window.CustomTabs.createTab(${JSON.stringify(layoutFiles[0])},
        window.fs.readFileSync(${JSON.stringify(layoutFiles[0])}, 'utf8')); null`,
    );
    await sleep(500);

    const one = await exec(`(() => {
      const px = (el) => { const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      const header = document.querySelector('.header');
      const strip = document.getElementById('tabsContainer');
      const tab = document.querySelector('.tab');
      return {
        headerCount: document.querySelectorAll('.header').length,
        stripInsideHeader: !!(header && strip && header.contains(strip)),
        reloadInsideHeader: !!(header && header.contains(document.getElementById('refreshBtn'))),
        menuInsideHeader: !!(header && header.contains(document.getElementById('menuBtn'))),
        // The deleted surfaces. Their absence is the redesign.
        fileInfoBar: !!document.getElementById('fileInfoBar'),
        appTitle: !!document.querySelector('.app-title'),
        logoLink: !!document.getElementById('logoLink'),
        tabCount: document.querySelectorAll('.tab').length,
        // Counting elements is NOT enough: the old two-tab minimum hid the
        // whole strip with display:none, which leaves every tab element in the
        // DOM and made this assertion pass with no tab on screen at all.
        // Observed visibility is the only thing that answers "shown".
        tabShown: tab
          ? tab.offsetParent !== null &&
            (typeof tab.checkVisibility === 'function'
              ? tab.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : true) &&
            tab.getBoundingClientRect().width > 0
          : false,
        tabTitle: tab ? tab.querySelector('.tab-title').textContent : null,
        tabTooltip: tab ? tab.getAttribute('title') : null,
        header: header ? px(header) : null,
      };
    })()`);

    check(
      "the toolbar is a single row and the tab strip lives inside it",
      one.headerCount === 1 &&
        one.stripInsideHeader === true &&
        one.reloadInsideHeader === true &&
        one.menuInsideHeader === true,
      JSON.stringify(one),
    );
    // Each of these three elements was removed, and each left a live reference
    // behind. The logo's was the expensive one: a surviving
    // `logoLink.addEventListener` threw at renderer.js top level, which aborts
    // the REST of that script, so every handler registered after it silently
    // never registered. The visible symptom was "the tab strip does not work".
    check(
      "the removed header surfaces are really gone from the DOM",
      one.fileInfoBar === false && one.appTitle === false && one.logoLink === false,
      JSON.stringify(one),
    );
    // The old strip swapped itself out below 2 tabs and showed the file-info
    // bar instead. That bar no longer exists, so a lone document would have had
    // no tab and no location shown anywhere.
    check(
      "a single open document is still shown as a tab",
      one.tabCount === 1 &&
        one.tabShown === true &&
        /bar-document-0/.test(String(one.tabTitle)),
      JSON.stringify(one),
    );
    // The location moved from a dedicated row onto the tab. The tooltip is on
    // the whole tab, not just the label - the label stops at the ellipsis, so
    // hovering the padding or the close-button gap produced nothing.
    check(
      "the tab carries the document's full path as its tooltip",
      one.tabTooltip === layoutFiles[0],
      JSON.stringify(one),
    );

    // --- many documents: the strip must scroll, not push the buttons off ---
    for (let i = 1; i < layoutFiles.length; i++) {
      await exec(
        `window.CustomTabs.createTab(${JSON.stringify(layoutFiles[i])},
          window.fs.readFileSync(${JSON.stringify(layoutFiles[i])}, 'utf8')); null`,
      );
      await sleep(150);
    }
    await sleep(500);

    const many = await exec(`(() => {
      const px = (el) => { const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; };
      const strip = document.getElementById('tabsContainer');
      const active = document.querySelector('.tab.active');
      const sr = strip.getBoundingClientRect();
      const ar = active ? active.getBoundingClientRect() : null;
      return {
        tabCount: document.querySelectorAll('.tab').length,
        scrollWidth: strip.scrollWidth,
        clientWidth: strip.clientWidth,
        overflows: strip.scrollWidth > strip.clientWidth,
        header: px(document.querySelector('.header')),
        strip: px(strip),
        reload: px(document.getElementById('refreshBtn')),
        menu: px(document.getElementById('menuBtn')),
        menuOnScreen: px(document.getElementById('menuBtn')).right <= window.innerWidth,
        innerW: window.innerWidth,
        activeWithinStrip: ar
          ? (ar.left >= sr.left - 1 && ar.right <= sr.right + 1)
          : null,
        activeTitle: active ? active.querySelector('.tab-title').textContent : null,
      };
    })()`);

    check(
      "enough tabs are open to overflow the strip, so the scroll assertions bite",
      many.tabCount === 8 && many.overflows === true,
      JSON.stringify(many),
    );
    // The strip shrinks because it is a SCROLL CONTAINER (its automatic
    // minimum size is zero); `min-width: 0` says the same thing a second time.
    // Without that, the item's min-content size is the width of all eight tabs
    // and the bar outgrows the window. MEASURED: the overflow goes LEFT, not
    // right - header.x = -1054 on a 1336px window - so a right-edge check
    // alone reported this as fine. Both edges, and the bar's own width.
    check(
      "an overflowing strip scrolls instead of pushing the buttons off the bar",
      many.menuOnScreen === true &&
        many.reload.x > many.strip.x &&
        many.header.x >= -1 &&
        many.strip.x >= -1 &&
        many.header.w <= many.innerW + 1,
      JSON.stringify(many),
    );
    check(
      "the reload button sits between the tab strip and the hamburger",
      many.strip.x < many.reload.x && many.reload.x < many.menu.x,
      JSON.stringify(many),
    );
    // Making the strip scroll introduced this: the newly-opened document's tab
    // is past the right edge, so opening a file showed a strip that did not
    // contain it.
    check(
      "the active tab is scrolled into view",
      many.activeWithinStrip === true &&
        /bar-document-7/.test(String(many.activeTitle)),
      JSON.stringify(many),
    );
    // A classic (non-overlay) scrollbar takes layout space, so under
    // `overflow-x: auto` the bar grew 6px the moment the tabs overflowed and
    // shifted the document underneath it. `scrollbar-gutter: stable` does not
    // help - measured, it reserves the inline-axis gutter only.
    check(
      "the bar does not change height when the strip gains its scrollbar",
      one.header && many.header && Math.abs(one.header.h - many.header.h) < 1,
      `oneTab=${one.header && one.header.h} manyTabs=${many.header && many.header.h}`,
    );

    // --- the hamburger and its two flyouts ---
    await exec(`document.getElementById('menuBtn').click(); null`);
    await sleep(300);
    await exec(`document.getElementById('fileBtn').click(); null`);
    await sleep(350);
    const fileOpen = await exec(`(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        return { painted: r.width > 0 && r.height > 0, left: r.left, right: r.right,
                 top: r.top, bottom: r.bottom };
      };
      const f = vis('fileMenu');
      return { file: f, view: vis('viewMenu'),
        onScreen: f.left >= 0 && f.right <= window.innerWidth &&
                  f.top >= 0 && f.bottom <= window.innerHeight };
    })()`);
    await exec(`document.getElementById('viewBtn').click(); null`);
    await sleep(350);
    const viewOpen = await exec(`(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        return { painted: r.width > 0 && r.height > 0, left: r.left, right: r.right,
                 top: r.top, bottom: r.bottom };
      };
      const v = vis('viewMenu');
      return { file: vis('fileMenu'), view: v,
        onScreen: v.left >= 0 && v.right <= window.innerWidth &&
                  v.top >= 0 && v.bottom <= window.innerHeight };
    })()`);
    await exec(`document.body.click(); null`);
    await sleep(250);

    check(
      "the hamburger's File flyout opens fully on screen",
      fileOpen.file.painted === true && fileOpen.onScreen === true,
      JSON.stringify(fileOpen),
    );
    // The flyouts are driven by the ORIGINAL, unmodified fileBtn/viewBtn click
    // handlers. They are marked `has-flyout`, not `has-submenu`, precisely so
    // opening stays click-driven: the inherited `.has-submenu:hover` rule would
    // let hover open one while a click held the other open, and two panels
    // could be visible at once.
    check(
      "only one flyout is open at a time",
      fileOpen.file.painted === true && fileOpen.view.painted === false &&
        viewOpen.view.painted === true && viewOpen.file.painted === false,
      JSON.stringify({ fileOpen, viewOpen }),
    );
    check(
      "the hamburger's View flyout opens fully on screen",
      viewOpen.onScreen === true,
      JSON.stringify(viewOpen),
    );

    // --- the search panel must not cover the bar it used to sit beside ---
    // This is a REGRESSION guard, not a new feature. The panel was
    // `position: fixed; top: 0`, survivable while the toolbar was two rows
    // (the 58px panel covered the 38px row and left the tab row showing).
    // Against one bar it covered the whole thing: no tabs, no reload, no
    // hamburger, and nothing saying which document was being searched.
    // Driven through the product's own toggle rather than by adding the class
    // by hand, so what is measured is the real open path.
    await exec(`window.toggleSearchPanel(); null`);
    await sleep(500);
    const search = await exec(`(() => {
      const rect = (el) => el.getBoundingClientRect();
      const sp = document.getElementById('searchPanel');
      const header = document.querySelector('.header');
      const sr = rect(sp), hr = rect(header);
      // Hit-test rather than trust the rectangles: an element can be inside the
      // viewport and still be covered.
      const reachable = (el) => {
        const r = rect(el);
        const hit = document.elementFromPoint(
          Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
        return !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      };
      return {
        panelPainted: sr.width > 0 && sr.height > 0,
        panelBelowHeader: sr.top >= hr.bottom - 1,
        overlapsHeader: !(sr.top >= hr.bottom || sr.bottom <= hr.top),
        activeTabReachable: reachable(document.querySelector('.tab.active')),
        reloadReachable: reachable(document.getElementById('refreshBtn')),
        menuReachable: reachable(document.getElementById('menuBtn')),
        searchInputReachable: reachable(document.getElementById('searchInput')),
      };
    })()`);
    check(
      "the search panel really opened, so the overlay assertions are not vacuous",
      search.panelPainted === true && search.searchInputReachable === true,
      JSON.stringify(search),
    );
    check(
      "the search panel opens below the bar rather than covering it",
      search.panelBelowHeader === true && search.overlapsHeader === false,
      JSON.stringify(search),
    );
    check(
      "the tabs, reload and hamburger stay usable while search is open",
      search.activeTabReachable === true &&
        search.reloadReachable === true &&
        search.menuReachable === true,
      JSON.stringify(search),
    );
    await exec(`window.toggleSearchPanel(); null`);
    await sleep(600);

    // The CLOSED state is a separate failure mode and needs its own assertion.
    // The retracted panel translates up and lands exactly over the bar, so the
    // bar is only clickable because `.header` establishes a stacking context
    // that paints above it. `.header` carried `z-index: 100` with NO
    // `position`, where z-index is ignored outright - it painted on top purely
    // by DOM order, which the `.search-anchor` wrapper reversed.
    const closed = await exec(`(() => {
      const rect = (el) => el.getBoundingClientRect();
      const reachable = (el) => {
        const r = rect(el);
        const hit = document.elementFromPoint(
          Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
        return !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      };
      const sr = rect(document.getElementById('searchPanel'));
      const hr = rect(document.querySelector('.header'));
      return {
        panelClosed: !document.getElementById('searchPanel').classList.contains('visible'),
        // The whole point: retracted, it really is on top of the bar.
        retractedOverBar: !(sr.top >= hr.bottom || sr.bottom <= hr.top),
        activeTabReachable: reachable(document.querySelector('.tab.active')),
        reloadReachable: reachable(document.getElementById('refreshBtn')),
        menuReachable: reachable(document.getElementById('menuBtn')),
      };
    })()`);
    check(
      "the retracted search panel really does overlap the bar, so this bites",
      closed.panelClosed === true && closed.retractedOverBar === true,
      JSON.stringify(closed),
    );
    check(
      "the bar stays clickable underneath the retracted search panel",
      closed.activeTabReachable === true &&
        closed.reloadReachable === true &&
        closed.menuReachable === true,
      JSON.stringify(closed),
    );

    // --- the tab right-click menu ---
    // This replaces the deleted click-to-copy file-path element, so the path is
    // still obtainable now that the location bar is gone.
    const ctxPath = layoutFiles[layoutFiles.length - 1];
    const ctx = await exec(`(() => {
      const t = document.querySelector('.tab.active');
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) }));
      const m = document.getElementById('tabContextMenu');
      const mr = m.getBoundingClientRect();
      require('electron').clipboard.writeText('CLIPBOARD_NOT_WRITTEN');
      document.getElementById('ctxTabCopyPath').click();
      return {
        painted: mr.width > 0 && mr.height > 0,
        onScreen: mr.left >= 0 && mr.top >= 0 &&
                  mr.right <= window.innerWidth && mr.bottom <= window.innerHeight,
        copied: require('electron').clipboard.readText(),
        dismissed: !m.classList.contains('visible'),
      };
    })()`);
    check(
      "right-clicking a tab opens its menu on screen",
      ctx.painted === true && ctx.onScreen === true,
      JSON.stringify(ctx),
    );
    check(
      "the tab menu copies that tab's full path and closes itself",
      ctx.copied === ctxPath && ctx.dismissed === true,
      JSON.stringify(ctx),
    );

    await exec(`
      window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
      window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
      null;
    `);
    await sleep(300);
  }

  // ---- Scenario 12: batch paths must not interrogate the reader ----------
  // Two defects, both MEASURED on the pre-fix tree before anything was
  // changed. Restoring four tabs (three of them expensive) raised THREE
  // "Large document" modals before the window was usable, and performed FIVE
  // renders for four tabs - every restored document was rendered and only the
  // last was ever seen. Cause: createTab() switched to every tab it created,
  // and switchToTab() is both the thing that renders and the thing that asks.
  //
  // The recorded decision is that batch paths (session restore, the trailing
  // files of a multi-select) skip the dialog and report passively, while every
  // switch a reader actually asks for keeps it. Scenario 10 owns that second
  // half; this scenario owns the first, and deliberately re-checks that the
  // explicit path still asks so a fix here cannot disable the guard outright.
  //
  // Sample shape is borrowed from Scenario 10: a long run of pipes scores as
  // expensive (pipes are table cells) but marked renders it as one paragraph,
  // so the scenario does not cost the ten seconds it is describing.
  const restoreBigA = path.join(dir, "restore-big-a.md");
  const restoreBigB = path.join(dir, "restore-big-b.md");
  const restoreBigC = path.join(dir, "restore-big-c.md");
  const restoreSmall = path.join(dir, "restore-small.md");
  write(restoreBigA, "|".repeat(260000) + "\nRESTORE_BIG_A\n");
  write(restoreBigB, "|".repeat(260000) + "\nRESTORE_BIG_B\n");
  write(restoreBigC, "|".repeat(260000) + "\nRESTORE_BIG_C\n");
  write(restoreSmall, "# Small\n\nRESTORE_SMALL_DOC\n");
  const jsRestoreBigA = JSON.stringify(restoreBigA);
  const jsRestoreSmall = JSON.stringify(restoreSmall);
  const restoreSession = JSON.stringify(
    JSON.stringify(
      [restoreBigA, restoreBigB, restoreBigC, restoreSmall].map((p) => ({
        filePath: p,
        scrollPosition: 0,
        anchor: null,
      })),
    ),
  );

  const batch = await exec(`
    (async () => {
      const out = {};
      const helpers = require('./file-helpers');
      out.bigIsLarge = helpers.isLargeDocument(window.fs.readFileSync(${JSON.stringify(restoreBigA)}, 'utf8')).large;
      out.smallIsLarge = helpers.isLargeDocument(window.fs.readFileSync(${jsRestoreSmall}, 'utf8')).large;

      const realSendSync = window.ipcRenderer.sendSync;
      const realRender = window.renderMarkdown;
      let asked = 0;
      let answer = true;
      const renders = [];
      const toasts = [];
      window.ipcRenderer.sendSync = function (channel) {
        if (channel === 'confirm-large-render') { asked++; return answer; }
        return realSendSync.apply(this, arguments);
      };
      // switchToTab renders through window.renderMarkdown, so counting here
      // counts the work a restore actually performs rather than restating the
      // number of tabs.
      window.renderMarkdown = function (text) {
        renders.push(String(text || '').slice(0, 24));
        return realRender.apply(this, arguments);
      };
      const toastEl = document.getElementById('notificationMessage');
      const toastObserver = new MutationObserver(() => toasts.push(toastEl.textContent));
      if (toastEl) toastObserver.observe(toastEl, { childList: true, characterData: true, subtree: true });

      try {
        window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
        window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        await new Promise(r => setTimeout(r, 200));

        // ---- restore, with an ORDINARY document as the active one ----
        localStorage.setItem('openTabs', ${restoreSession});
        localStorage.setItem('activeTabPath', ${jsRestoreSmall});
        asked = 0; renders.length = 0; toasts.length = 0;
        window.CustomTabs.__loadSavedTabs();
        await new Promise(r => setTimeout(r, 900));
        out.askedOnRestore = asked;
        out.rendersOnRestore = renders.length;
        out.tabsAfterRestore = window.CustomTabs.getTabs().length;
        out.restoredActiveIsSmall =
          (window.CustomTabs.getActiveTab() || {}).filePath === ${jsRestoreSmall};
        out.smallOnScreen =
          document.getElementById('viewer').textContent.indexOf('RESTORE_SMALL_DOC') !== -1;

        // A tab restored but never activated is still guarded: clicking it is
        // an explicit act. Without this the fix could be "delete the guard".
        const bigTab = window.CustomTabs.findTabByPath(${jsRestoreBigA});
        let mark = asked;
        answer = false;
        window.CustomTabs.switchToTab(bigTab.id);
        await new Promise(r => setTimeout(r, 400));
        out.askedOnExplicitClick = asked - mark;
        out.declineKeptReaderPut =
          (window.CustomTabs.getActiveTab() || {}).filePath === ${jsRestoreSmall};

        window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
        window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        await new Promise(r => setTimeout(r, 200));

        // ---- restore, with an EXPENSIVE document as the active one ----
        // The recorded decision: restore it rather than leaving the reader
        // staring at nothing, and say so passively instead of behind a modal.
        localStorage.setItem('openTabs', ${restoreSession});
        localStorage.setItem('activeTabPath', ${jsRestoreBigA});
        asked = 0; renders.length = 0; toasts.length = 0;
        answer = false; // would DECLINE if anything asked
        window.CustomTabs.__loadSavedTabs();
        await new Promise(r => setTimeout(r, 900));
        out.askedOnBigRestore = asked;
        out.rendersOnBigRestore = renders.length;
        out.bigRestoredActive =
          (window.CustomTabs.getActiveTab() || {}).filePath === ${jsRestoreBigA};
        out.bigOnScreen =
          document.getElementById('viewer').textContent.indexOf('RESTORE_BIG_A') !== -1;
        out.toastNamedIt = toasts.some(m => /restore-big-a\\.md/.test(m) && /large/i.test(m));
        // Already on screen, so revisiting it must never raise the question.
        //
        // Two traps here, both hit for real. (1) If the restore's switch was
        // declined - which is exactly what a revert of silent:true produces -
        // nothing is active and getActiveTab() is undefined. Dereferencing it
        // makes the PROBE throw, and a probe that throws reports "harness
        // threw" with no named assertion, which is indistinguishable from a
        // broken test. Record the miss instead. (2) switchToTab() returns
        // early when the target is already active, so if the move AWAY is
        // declined the return trip is a no-op and the count is vacuous. The
        // scenario therefore accepts the question it raises on the way out,
        // and asserts the move really happened.
        const restoredBig = window.CustomTabs.getActiveTab();
        const otherTab = restoredBig
          ? window.CustomTabs.getTabs().find(t => t.id !== restoredBig.id)
          : null;
        if (restoredBig && otherTab) {
          answer = true;
          window.CustomTabs.switchToTab(otherTab.id);
          await new Promise(r => setTimeout(r, 300));
          out.revisitMovedAway =
            (window.CustomTabs.getActiveTab() || {}).id === otherTab.id;
          mark = asked;
          window.CustomTabs.switchToTab(restoredBig.id);
          await new Promise(r => setTimeout(r, 300));
          out.askedOnRevisitAfterRestore = asked - mark;
        } else {
          out.revisitMovedAway = false;
          out.askedOnRevisitAfterRestore = -1;
        }

        window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
        window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        await new Promise(r => setTimeout(r, 200));

        // ---- multi-select, and the double-ask on a single open ----
        // main.js runs confirmLargeDocument() before it emits 'file-opened',
        // so anything this side asks is a SECOND dialog for one open. It was
        // measured at two identical dialogs before the fix.
        asked = 0; renders.length = 0;
        // ACCEPT here, deliberately. Declining masks the very work this leg
        // measures: a switch that is refused neither renders nor moves the
        // reader, so a revert that switches to every extra file would leave
        // the render count and the active tab looking correct. MEASURED -
        // R253 came back WRONG-GUARD for exactly this reason.
        answer = true;
        window.ipcRenderer.emit('file-opened', {}, {
          content: window.fs.readFileSync(${JSON.stringify(restoreBigA)}, 'utf8'),
          path: ${JSON.stringify(restoreBigA)},
          allPaths: [${JSON.stringify(restoreBigA)}, ${JSON.stringify(restoreBigB)}, ${JSON.stringify(restoreBigC)}],
        });
        await new Promise(r => setTimeout(r, 900));
        out.askedOnMultiOpen = asked;
        out.multiOpenTabs = window.CustomTabs.getTabs().length;
        out.multiOpenActiveIsFirst =
          (window.CustomTabs.getActiveTab() || {}).filePath === ${JSON.stringify(restoreBigA)};
        out.rendersOnMultiOpen = renders.length;

        // The same file arriving again - a markdown link to a document that is
        // already open. main.js has asked about it on the way here, so this
        // side must not ask a second time either.
        mark = asked;
        window.ipcRenderer.emit('file-opened', {}, {
          content: window.fs.readFileSync(${JSON.stringify(restoreBigB)}, 'utf8'),
          path: ${JSON.stringify(restoreBigB)},
          allPaths: [${JSON.stringify(restoreBigB)}],
        });
        await new Promise(r => setTimeout(r, 700));
        out.askedOnReopen = asked - mark;
        out.reopenSwitched =
          (window.CustomTabs.getActiveTab() || {}).filePath === ${JSON.stringify(restoreBigB)};
        out.tabsAfterReopen = window.CustomTabs.getTabs().length;

        window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
        window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
      } finally {
        window.ipcRenderer.sendSync = realSendSync;
        window.renderMarkdown = realRender;
        toastObserver.disconnect();
      }
      return out;
    })()
  `);
  await sleep(400);

  // Vacuity guards first: if the sample stopped scoring as expensive, or the
  // restore stopped restoring, every "0 dialogs" assertion below would pass
  // for the worst possible reason.
  check(
    "the restore samples really are scored expensive and the control is not",
    batch.bigIsLarge === true && batch.smallIsLarge === false,
    JSON.stringify(batch),
  );
  check(
    "a session restore really did restore every tab",
    batch.tabsAfterRestore === 4 && batch.restoredActiveIsSmall === true,
    JSON.stringify(batch),
  );
  check(
    "a session restore asks nothing, however many expensive tabs it holds",
    batch.askedOnRestore === 0,
    JSON.stringify(batch),
  );
  check(
    "a session restore renders the active document only, not every tab",
    batch.rendersOnRestore === 1 && batch.smallOnScreen === true,
    JSON.stringify(batch),
  );
  check(
    "a restored-but-unvisited expensive tab still asks when it is clicked",
    batch.askedOnExplicitClick === 1 && batch.declineKeptReaderPut === true,
    JSON.stringify(batch),
  );
  check(
    "restoring an expensive active document asks nothing and still renders it",
    batch.askedOnBigRestore === 0 &&
      batch.bigRestoredActive === true &&
      batch.bigOnScreen === true,
    JSON.stringify(batch),
  );
  check(
    "restoring an expensive document says so passively, naming the file",
    batch.toastNamedIt === true,
    JSON.stringify(batch),
  );
  check(
    "a restore renders one document even when that document is expensive",
    batch.rendersOnBigRestore === 1,
    JSON.stringify(batch),
  );
  check(
    "a document restored and already on screen is never asked about later",
    batch.askedOnRevisitAfterRestore === 0 && batch.revisitMovedAway === true,
    JSON.stringify(batch),
  );
  check(
    "a file main.js already asked about is not asked about again",
    batch.askedOnMultiOpen === 0 && batch.multiOpenActiveIsFirst === true,
    JSON.stringify(batch),
  );
  check(
    "a multi-select opens every file but renders only the chosen one",
    batch.multiOpenTabs === 3 && batch.rendersOnMultiOpen === 1,
    JSON.stringify(batch),
  );
  check(
    "re-opening a file that is already open does not ask a second time",
    batch.askedOnReopen === 0 &&
      batch.reopenSwitched === true &&
      batch.tabsAfterReopen === 3,
    JSON.stringify(batch),
  );

  // ---- Scenario 12b: reload replies are owned by their request -----------
  // Capture an actual main-frame request/reply, then use that opaque reply
  // metadata to exercise CustomTabs' foreign/conflict distinction.  This
  // keeps the test at the IPC boundary: no private sequence/session state is
  // manufactured by the harness.
  await exec(`
    window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
    window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
    const t = window.CustomTabs.createTab(${jsA}, window.fs.readFileSync(${jsA}, 'utf8'));
    window.CustomTabs.switchToTab(t.id);
    window.originalMarkdown = t.content;
    null;
  `);
  const reloadOwnershipHold = holdReloadResults();
  let reloadOwnership;
  try {
    await exec(`window.reloadCurrentFile(); null;`);
    const trustedReplyHeld = await waitUntil(
      () => reloadOwnershipHold.held.length === 1,
      10000,
    );
    const trusted = reloadOwnershipHold.held[0];
    // Invoke the registered main listener with a non-owner sender.  A real
    // BrowserWindow cannot forge this event, but this direct listener call is
    // the only deterministic way to present its owner gate with a foreign
    // sender without opening an uncontrolled renderer.
    let untrustedSends = 0;
    const fakeSender = {
      isDestroyed: () => false,
      send: () => { untrustedSends += 1; },
      mainFrame: { isDestroyed: () => false, frameTreeNodeId: -99 },
    };
    const beforeMain = __shutdown.state();
    for (const handler of ipcMain.listeners("reload-file")) {
      handler({ sender: fakeSender, senderFrame: fakeSender.mainFrame }, {
        filePath: fileA, reloadRequestSequence: 1,
        reloadRequestPath: fileA, reloadRequestSnapshot: "foreign",
        reloadRequestSession: "foreign",
      });
    }
    const afterMain = __shutdown.state();
    reloadOwnershipHold.release(0);
    await sleep(500);
    const foreignAndConflict = await exec(`
      (() => {
        const ipc = require("electron").ipcRenderer;
        const tab = window.CustomTabs.getActiveTab();
        const clean = {
          content: tab.content, original: tab.originalContent,
          dirty: tab.hasUnsavedChanges,
          diagnostics: window.CustomTabs.__reloadState(),
        };
        const base = ${JSON.stringify(trusted || null)};
        if (!base || !base.reloadRequest || !base.reloadSession) return { unavailable: true };
        const send = data => ipc.emit("file-reload-result", {}, data);
        send({ ...base, reloadRequest: {
          ...base.reloadRequest, sequence: base.reloadRequest.sequence + 1,
        }});
        send({ ...base, reloadRequest: {
          ...base.reloadRequest, path: base.reloadRequest.path + ".foreign",
        }});
        send({ ...base, reloadRequest: {
          ...base.reloadRequest, session: "wrong-page-session",
        }});
        const foreign = {
          content: tab.content, original: tab.originalContent,
          dirty: tab.hasUnsavedChanges,
          diagnostics: window.CustomTabs.__reloadState(),
        };
        // A matching request whose live bytes moved is the sole conflict
        // branch.  Feed the same genuine response metadata after a real edit.
        window.originalMarkdown = clean.content + "\\nOWNERSHIP_LIVE_EDIT\\n";
        send(base);
        const conflict = {
          content: tab.content, original: tab.originalContent,
          dirty: tab.hasUnsavedChanges,
          diagnostics: window.CustomTabs.__reloadState(),
        };
        tab.content = tab.originalContent;
        window.originalMarkdown = tab.originalContent;
        window.setUnsavedState(false);
        return { clean, foreign, conflict };
      })()
    `);
    reloadOwnership = {
      trustedReplyHeld, trusted, untrustedSends, beforeMain, afterMain,
      foreignAndConflict,
    };
  } finally {
    reloadOwnershipHold.restore();
  }
  check(
    "reload ownership drops foreign sender, sequence, path, and page-session replies without inventing a conflict, while a moved live snapshot conflicts",
    reloadOwnership &&
      reloadOwnership.trustedReplyHeld &&
      reloadOwnership.trusted &&
      reloadOwnership.trusted.success === true &&
      reloadOwnership.untrustedSends === 0 &&
      reloadOwnership.afterMain.staleReloadReplyDropsByReason["untrusted-request"] >
        (reloadOwnership.beforeMain.staleReloadReplyDropsByReason["untrusted-request"] || 0) &&
      reloadOwnership.foreignAndConflict &&
      !reloadOwnership.foreignAndConflict.unavailable &&
      reloadOwnership.foreignAndConflict.foreign.content === reloadOwnership.foreignAndConflict.clean.content &&
      reloadOwnership.foreignAndConflict.foreign.dirty === false &&
      reloadOwnership.foreignAndConflict.foreign.diagnostics.foreignCount >=
        reloadOwnership.foreignAndConflict.clean.diagnostics.foreignCount + 3 &&
      reloadOwnership.foreignAndConflict.conflict.dirty === true &&
      reloadOwnership.foreignAndConflict.conflict.content.includes("OWNERSHIP_LIVE_EDIT") &&
      reloadOwnership.foreignAndConflict.conflict.diagnostics.rejectedCount >=
        reloadOwnership.foreignAndConflict.foreign.diagnostics.rejectedCount + 1,
    JSON.stringify(reloadOwnership),
  );

  // The listener commits all ownership before awaiting its renderer.  Hold the
  // renderer at that boundary so two real file-open IPC messages complete in
  // reverse order; the old continuation must be visibly retired.
  const fileOpenRaceA = path.join(dir, "race-open-a.md");
  const fileOpenRaceB = path.join(dir, "race-open-b.md");
  write(fileOpenRaceA, "RACE_OPEN_A");
  write(fileOpenRaceB, "RACE_OPEN_B");
  const fileOpenRace = await exec(`
    (async () => {
      const ipc = require("electron").ipcRenderer;
      const a = ${JSON.stringify(fileOpenRaceA)};
      const b = ${JSON.stringify(fileOpenRaceB)};
      const realRender = window.renderMarkdown;
      const gates = [];
      window.renderMarkdown = text => new Promise(resolve => gates.push({ text, resolve }));
      try {
        ipc.emit("file-opened", {}, { path: a, filePath: a, content: "RACE_OPEN_A",
          allPaths: [a, b] });
        const afterA = {
          path: window.currentFilePath, original: window.originalMarkdown,
          diagnostics: window.getReloadRequestDiagnostics(),
        };
        ipc.emit("file-opened", {}, { path: b, filePath: b, content: "RACE_OPEN_B",
          allPaths: [a, b] });
        const afterB = {
          path: window.currentFilePath, original: window.originalMarkdown,
          diagnostics: window.getReloadRequestDiagnostics(),
        };
        // Finish the newer render first, then the stale one.  The latter may
        // settle but cannot scroll or overwrite B's synchronous ownership.
        gates[1].resolve();
        await new Promise(resolve => setTimeout(resolve, 20));
        gates[0].resolve();
        await new Promise(resolve => setTimeout(resolve, 20));
        return {
          afterA, afterB, gates: gates.map(g => g.text),
          final: {
            path: window.currentFilePath, original: window.originalMarkdown,
            diagnostics: window.getReloadRequestDiagnostics(),
            recents: JSON.parse(localStorage.getItem("recentFiles") || "[]"),
          },
        };
      } finally {
        window.renderMarkdown = realRender;
      }
    })()
  `);
  check(
    "file-open ownership is synchronous and a superseded render completion cannot reclaim the newer document",
    fileOpenRace &&
      fileOpenRace.gates.length === 2 &&
      fileOpenRace.afterA.path.endsWith("race-open-a.md") &&
      fileOpenRace.afterA.original === "RACE_OPEN_A" &&
      fileOpenRace.afterB.path.endsWith("race-open-b.md") &&
      fileOpenRace.afterB.original === "RACE_OPEN_B" &&
      fileOpenRace.final.path.endsWith("race-open-b.md") &&
      fileOpenRace.final.original === "RACE_OPEN_B" &&
      fileOpenRace.final.diagnostics.fileOpenSequence ===
        fileOpenRace.afterB.diagnostics.fileOpenSequence,
    JSON.stringify(fileOpenRace),
  );

  // ---- Scenario 13: leaving the app is a question, not an assumption -----
  // F22. The native X, Ctrl+Q, an ordinary quit and an update install all used
  // to leave without asking; they now share one approval protocol.
  // The legacy installed-boundary cases exercise BaseUpdater's non-Windows
  // lifecycle. Windows now owns NSIS launch directly and is covered below.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (process.platform === "win32") {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  }
  try {
    await runShutdownScenarios(win, exec, sentinel);
  } finally {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  }
  await runShutdownGenerationScenarios(win, exec);
  // The parent runs on Windows so the NSIS path is exercised below.  Also run
  // the BaseUpdater-only lifecycle matrix under its supported platform model:
  // its public-boundary listener and error ownership are independent of the
  // Windows launcher and otherwise would be catalogue-visible but unexecuted.
  const installedPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  if (process.platform === "win32") {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
  }
  try {
    await runInstalledUpdateCommitScenarios(win, exec);
  } finally {
    if (installedPlatformDescriptor) {
      Object.defineProperty(process, "platform", installedPlatformDescriptor);
    }
  }
  if (process.platform === "win32") {
    await runWindowsInstalledLauncherScenarios(win, exec);
  }
  await sentinel.mute("sameDocument's deliberate unreadable-editor failure path");
  try {
    await runSameDocumentShutdownScenarios(win, exec);
  } finally {
    await sentinel.unmute();
  }
  await runCommitDeadlineAndContinuationScenarios(win, exec);
  await runF22SaveAndReloadScenarios(win, exec);

  // Prove the watcher was actually watching. Without this, "no errors were
  // recorded" and "the watcher silently stopped working" are the same result -
  // the exact vacuity this harness exists to eliminate. Both detection paths
  // are checked because they fail independently.
  const alive = await proveSentinelAlive(win, sentinel);
  check(
    "the error sentinel was demonstrably watching both channels",
    alive.console === true && alive.dom === true,
    JSON.stringify(alive),
  );

  const sentinelReport = await sentinel.stop();
  check(
    "nothing rendered a visible error at any point during the suite",
    sentinelReport.hits.length === 0,
    JSON.stringify(sentinelReport.hits),
  );

  // ---- Scenario 14: the renderer is gone ---------------------------------
  // DELIBERATELY THE LAST THING THE SUITE DOES. It crashes the renderer for
  // real, which ends every page-side instrument - the sentinel included - so
  // it runs after the sentinel has reported. The window is restored afterwards
  // so a failure screenshot is still possible.
  await runRendererLossScenario(win);
}


async function runF22SaveAndReloadScenarios(win, exec) {
  const wc = win.webContents;
  // R2 is a regression suite for the companion production correction.  Do not
  // execute a mixture of old contracts and new proof obligations: that yields
  // incidental failures which look like evidence rather than the explicit
  // prerequisite disposition that maintainers need when running this test file
  // alone on the immutable base revision.
  const deletionProducerSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "main.js"), "utf8",
  );
  const deletionTabsSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8",
  );
  const deletionRendererSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer.js"), "utf8",
  );
  const deletionAckChannel = "file-deleted-ack";
  const initialDeletionAckListeners = ipcMain.rawListeners(deletionAckChannel);
  const deletionContracts = deriveDeletionContracts({
    mainSource: deletionProducerSource,
    rendererSource: deletionRendererSource,
    tabsSource: deletionTabsSource,
    runtimeAckListeners: initialDeletionAckListeners,
  });
  const deletionProductionPrerequisite = deletionContracts.prerequisite;
  const deletionCapabilities = deletionContracts.capabilities;
  const deletionCapabilityContracts = deletionContracts.capabilityContracts;
  const productionDeletionAckListeners = deletionContracts.productionAckListeners
    .map((listener) => listener.raw);
  const productionDeletionAckHandler = deletionContracts.productionAckHandler
    ? deletionContracts.productionAckHandler.raw
    : null;
  const productionDeletionAckSource = deletionContracts.productionAckSource;
  const persistentProductionAckRegistration =
    deletionProductionPrerequisite.persistentProductionAckRegistration;
  const synchronousProductionDeletionAckHandler =
    deletionContracts.synchronousProductionAckHandler;
  const saveHandlerSource = deletionContracts.saveHandlerSource;
  const reportDeletionCapability = (name, contract, detail) => {
    if (contract === "invalid") {
      check(`${name} production contract is complete when advertised`, false, detail);
    } else {
      unavailable(name, detail);
    }
  };
  const deletionAckContractViolations =
    deletionContracts.acknowledgementContractViolations;
  const deletionAcknowledgementContract =
    deletionContracts.acknowledgementContract;
  const deletionAcknowledgementContractDetail = JSON.stringify({
    contract: deletionAcknowledgementContract,
    violations: deletionAckContractViolations,
    listeners: initialDeletionAckListeners.length,
    matchingHandlers: productionDeletionAckListeners.length,
    persistentProductionAckRegistration,
    synchronousProductionDeletionAckHandler,
    acknowledgementAttempt: deletionProductionPrerequisite.acknowledgementAttempt,
  });
  const deletionEvidencePlan = createDeletionEvidencePlan(
    deletionCapabilities,
    deletionAcknowledgementContract,
  );
  const deletionPlanSelfcheckPassed = await deletionEvidencePlanSelfcheck();
  const saveResultCorrelationSelfcheckPassed = saveResultCorrelationSelfcheck();
  const deletionCapabilityClassificationSelfcheckPassed =
    deletionCapabilityClassificationSelfcheck();
  check(
    "F22 deletion capability plan keeps producer, tombstone and watcher scheduled when ACK support is absent",
    deletionPlanSelfcheckPassed,
    JSON.stringify(createDeletionEvidencePlan({
      producer: true,
      tombstone: true,
      watcher: true,
      saveRefusal: false,
      ackIdentity: false,
      synchronousSend: false,
    }, "absent")),
  );
  check(
    "F22 deletion capability classification follows direct reload-owner delegation and rejects malformed advertised contracts",
    deletionCapabilityClassificationSelfcheckPassed,
    JSON.stringify({ deletionCapabilityClassificationSelfcheckPassed }),
  );
  check(
    "F22 save-result correlation capability rejects a dead shorthand decoy",
    saveResultCorrelationSelfcheckPassed,
    JSON.stringify({ saveResultCorrelationSelfcheckPassed }),
  );
  for (const [group, entry] of Object.entries(deletionEvidencePlan)) {
    const disposition = deletionEvidenceDisposition(
      deletionContracts,
      deletionEvidencePlan,
      group,
    );
    if (disposition === "scheduled") continue;
    if (disposition === "invalid") {
      if (group === "acknowledgementLifecycle") {
        check(
          "F22 production deletion ACK registration is one persistent uniquely identified handler",
          false,
          deletionAcknowledgementContractDetail,
        );
      } else {
        check(
          `F22 ${group} production contract is complete when advertised`,
          false,
          JSON.stringify({
            group,
            contract: deletionCapabilityContracts[group],
            deletionProductionPrerequisite,
          }),
        );
      }
    } else {
      unavailable(
        entry.unavailable,
        group === "acknowledgementLifecycle"
          ? deletionAcknowledgementContractDetail
          : JSON.stringify(deletionProductionPrerequisite),
      );
    }
  }
  const clearTabs = () =>
    exec(`
      (async () => {
        const confirm = window.confirm;
        window.confirm = () => true;
        try {
          await Promise.all(window.CustomTabs.getTabs().slice().map((tab) =>
            window.CustomTabs.closeTab(tab.id)));
        } finally {
          window.confirm = confirm;
        }
        return true;
      })()
    `);
  const createActiveTab = async (filePath, content) => {
    const tab = await exec(`
      window.CustomTabs.createTab(${JSON.stringify(filePath)}, ${JSON.stringify(content)})
    `);
    // createTab's watcher selection is asynchronous. Explicitly adopt the
    // fixture's current baseline before any save so its initial fs.watch event
    // cannot be mistaken for an external edit.
    await exec(`
      window.ipcRenderer.send("set-active-file", {
        filePath: ${JSON.stringify(filePath)}, adoptBaseline: true
      });
      null;
    `);
    await sleep(350);
    return tab;
  };

  // A dangling symlink must be refused at the spelling the user saved through.
  // In particular, a prior real target must not be recreated from a remembered
  // canonical key after the link has been retargeted (or its target removed).
  const originalTarget = path.join(dir, "f22-save-old-target.md");
  const danglingLink = path.join(dir, "f22-save-retargeted.md");
  fs.writeFileSync(originalTarget, "F22_OLD_TARGET_BYTES", "utf8");
  // A prior failed run must not turn EEXIST into an environmental skip. Remove
  // only this fixture deterministically; cleanup errors are setup failures,
  // never evidence that creating a symlink is unsupported.
  let symlinkAvailable = true;
  let symlinkReason = "";
  try {
    fs.lstatSync(danglingLink);
    fs.unlinkSync(danglingLink);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      symlinkAvailable = false;
      symlinkReason = `${String(error && error.code || "unknown").toUpperCase()}: ${String(error && error.message || error)}`;
      check(
        "F22 symlink retarget setup rejects stale-fixture cleanup errors",
        false,
        JSON.stringify({ danglingLink, originalTarget, symlinkReason }),
      );
    }
  }
  if (symlinkAvailable) {
    try {
      fs.symlinkSync(originalTarget, danglingLink, "file");
      const linkControl =
        fs.lstatSync(danglingLink).isSymbolicLink() &&
        fs.readFileSync(danglingLink, "utf8") === "F22_OLD_TARGET_BYTES";
      check(
        "F22 symlink save control creates a link to the remembered old target",
        linkControl,
        JSON.stringify({ danglingLink, originalTarget }),
      );
    } catch (error) {
      const code = String(error && error.code || "unknown").toUpperCase();
      symlinkReason = `${code}: ${String(error && error.message || error)}`;
      // These are the OS errors documented for absent symlink privilege/support.
      // EEXIST, invalid paths and all unrelated I/O failures are setup failures.
      if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code)) {
        symlinkAvailable = false;
        unavailable(
          "F22 symlink retarget evidence is unavailable on this platform",
          symlinkReason,
        );
      } else {
        symlinkAvailable = false;
        check(
          "F22 symlink retarget setup rejects unexpected fixture errors",
          false,
          JSON.stringify({ danglingLink, originalTarget, code, symlinkReason }),
        );
      }
    }
  }

  if (symlinkAvailable) {
    try {
      await clearTabs();
      await createActiveTab(danglingLink, "F22_OLD_TARGET_BYTES");
      fs.unlinkSync(originalTarget);
      const symlinkResult = await exec(`
        (async () => {
          const ipc = require("electron").ipcRenderer;
          const expectedPath = ${JSON.stringify(danglingLink)};
          const originalAlert = window.alert;
          let timer = null;
          let onResult = null;
          try {
            window.alert = () => {};
            window.originalMarkdown = "F22_ATTEMPTED_DANGLING_SAVE";
            return await new Promise((resolve) => {
              timer = setTimeout(() => resolve({ timedOut: true }), 5000);
              onResult = (_event, data) => {
                if (!data || data.path !== expectedPath) return;
                resolve({ timedOut: false, data });
              };
              ipc.on("save-markdown-result", onResult);
              document.getElementById("saveButton").click();
            });
          } catch (error) {
            return { error: String(error && error.stack ? error.stack : error) };
          } finally {
            if (timer) clearTimeout(timer);
            if (onResult) ipc.removeListener("save-markdown-result", onResult);
            window.alert = originalAlert;
          }
        })()
      `);
      let linkStats = null;
      let linkTarget = null;
      try {
        linkStats = fs.lstatSync(danglingLink);
        linkTarget = fs.readlinkSync(danglingLink);
      } catch (error) {}
      check(
        "F22 saving through a retargeted dangling symlink fails before recreating the remembered old target",
        !!symlinkResult &&
          symlinkResult.timedOut === false &&
          symlinkResult.data &&
          symlinkResult.data.success === false &&
          /symbolic link whose target is missing/i.test(String(symlinkResult.data.error)) &&
          fs.existsSync(originalTarget) === false &&
          linkStats &&
          linkStats.isSymbolicLink() &&
          linkTarget === originalTarget,
        JSON.stringify({ symlinkResult, oldTargetExists: fs.existsSync(originalTarget), linkTarget }),
      );
    } finally {
      if (fs.existsSync(danglingLink) || (() => { try { return fs.lstatSync(danglingLink).isSymbolicLink(); } catch { return false; } })()) {
        try { fs.unlinkSync(danglingLink); } catch (error) {}
      }
    }
  }

  // These save-path races are driven at the main-process IPC boundary rather
  // than by the Save button. That keeps deliberately rejected saves out of
  // the renderer alert path: an unexpected failure is a result payload, never
  // a native Electron dialog that can strand the focused harness.
  //
  // The boundary is nevertheless the production boundary: obtain the owner
  // from the renderer's real active-tab selection before each request, then
  // pair it with prepareSaveRequest's current tab generation. Do not invent a
  // compatible owner here; main.js intentionally rejects path-only saves.
  await exec(`
    (() => {
      if (window.__f22SavePathRaceProbe) return null;
      const ipc = require("electron").ipcRenderer;
      const originalSend = ipc.send;
      const send = originalSend.bind(ipc);
      const probe = window.__f22SavePathRaceProbe = { owners: [] };
      const captureSelection = (channel, ...args) => {
        const selection = args[0];
        if (
          channel === "set-active-file" &&
          selection &&
          selection.owner
        ) {
          probe.owners.push({
            filePath: selection.filePath,
            owner: selection.owner,
          });
        }
        return send(channel, ...args);
      };
      probe.restore = () => {
        if (ipc.send === captureSelection) ipc.send = originalSend;
      };
      ipc.send = captureSelection;
      return null;
    })()
  `);
  let saveRaceScenario = 0;
  let lastObservedSaveRaceSequence = 0;
  const observedSaveRaceSequences = [];
  const prepareSaveRaceDocument = async (filePath, baselineContent, content) => {
    const ownerStart = await exec(`
      window.__f22SavePathRaceProbe.owners.length
    `);
    await clearTabs();
    const tab = await createActiveTab(filePath, baselineContent);
    const activeDocument = await exec(`
      (() => {
        const hasSaveSeam = !!(
          window.CustomTabs &&
          typeof window.CustomTabs.prepareSaveRequest === "function" &&
          typeof window.getReloadRequestSession === "function"
        );
        const pageSession = hasSaveSeam ? window.getReloadRequestSession() : null;
        window.originalMarkdown = ${JSON.stringify(content)};
        const prepared = hasSaveSeam
          ? window.CustomTabs.prepareSaveRequest(
              ${JSON.stringify(filePath)},
              pageSession,
            )
          : null;
        const owner = window.__f22SavePathRaceProbe.owners
          .slice(${ownerStart})
          .reverse()
          .find((entry) =>
            entry.filePath === ${JSON.stringify(filePath)} &&
            entry.owner &&
            entry.owner.tabId === ${tab.id}
          );
        const identity = prepared && prepared.identity;
        const selectionGeneration =
          owner && owner.owner && owner.owner.selectionGeneration;
        const sequence = identity && identity.sequence;
        const matchesActiveDocument = !!(
          identity &&
          owner &&
          owner.owner &&
          identity.pageSession === pageSession &&
          identity.tabId === ${tab.id} &&
          identity.documentGeneration === owner.owner.documentGeneration &&
          identity.pathKey === owner.owner.pathKey &&
          Number.isSafeInteger(selectionGeneration) &&
          selectionGeneration > 0 &&
          Number.isSafeInteger(sequence) &&
          sequence > 0 &&
          prepared.content === ${JSON.stringify(content)}
        );
        return {
          seamReady: hasSaveSeam,
          matchesActiveDocument,
          selectionGeneration: matchesActiveDocument
            ? selectionGeneration
            : null,
          sequence: matchesActiveDocument ? sequence : null,
          saveRequest: matchesActiveDocument
            ? {
                ...identity,
                selectionGeneration,
              }
            : null,
        };
      })()
    `);
    const sequence = activeDocument && activeDocument.sequence;
    const sequencePositive =
      Number.isSafeInteger(sequence) && sequence > 0;
    const sequenceMonotonic =
      sequencePositive && sequence > lastObservedSaveRaceSequence;
    if (sequencePositive) {
      lastObservedSaveRaceSequence = Math.max(
        lastObservedSaveRaceSequence,
        sequence,
      );
    }
    const observed = {
      ...activeDocument,
      sequencePositive,
      sequenceMonotonic,
    };
    observedSaveRaceSequences.push({
      sequence,
      sequencePositive,
      sequenceMonotonic,
    });
    return observed;
  };
  const hasMatchedSaveRequest = (save) => !!(
    save &&
    save.activeDocument &&
    save.activeDocument.seamReady === true &&
    save.activeDocument.matchesActiveDocument === true &&
    save.activeDocument.sequencePositive === true &&
    save.activeDocument.sequenceMonotonic === true &&
    save.saveRequest &&
    typeof save.saveRequest.pageSession === "string" &&
    Number.isSafeInteger(save.saveRequest.tabId) &&
    Number.isSafeInteger(save.saveRequest.documentGeneration) &&
    typeof save.saveRequest.pathKey === "string" &&
    Number.isSafeInteger(save.saveRequest.selectionGeneration) &&
    save.saveRequest.selectionGeneration > 0 &&
    save.saveRequest.selectionGeneration ===
      save.activeDocument.selectionGeneration &&
    Number.isSafeInteger(save.saveRequest.sequence) &&
    save.saveRequest.sequence > 0 &&
    save.saveRequest.sequence === save.activeDocument.sequence &&
    save.saveRequest.requestId === save.requestId &&
    save.result &&
    save.result.saveRequestSession === save.saveRequest.pageSession &&
    save.result.saveRequest &&
    save.result.saveRequest.requestId === save.saveRequest.requestId &&
    save.result.saveRequest.sequence === save.saveRequest.sequence &&
    save.result.saveRequest.pageSession === save.saveRequest.pageSession &&
    save.result.saveRequest.tabId === save.saveRequest.tabId &&
    save.result.saveRequest.documentGeneration ===
      save.saveRequest.documentGeneration &&
    save.result.saveRequest.pathKey === save.saveRequest.pathKey &&
    save.result.saveRequest.selectionGeneration ===
      save.saveRequest.selectionGeneration
  );
  const closeFile = path.join(dir, "f22-close-pending.md");
  if (!deletionProductionPrerequisite.saveResultCorrelation) {
    reportDeletionCapability(
      "F22 correlated save-path and pending-save evidence requires saveRequest production support",
      classifyDeletionCapability(
        /\bsaveRequest\b/.test(saveHandlerSource),
        deletionProductionPrerequisite.saveResultCorrelation,
      ),
      JSON.stringify({
        saveResultCorrelation: deletionProductionPrerequisite.saveResultCorrelation,
      }),
    );
    await exec(`
      window.__f22SavePathRaceProbe && window.__f22SavePathRaceProbe.restore();
      null;
    `);
    fs.writeFileSync(closeFile, "F22_CLOSE_BASE", "utf8");
    await clearTabs();
    await createActiveTab(closeFile, "F22_CLOSE_BASE");
  } else {
  try {
  const requestSave = async (filePath, content, baselineContent = content) => {
    const requestId = ++saveRaceScenario;
    const activeDocument = await prepareSaveRaceDocument(
      filePath,
      baselineContent,
      content,
    );
    const save = await exec(`
      new Promise((resolve) => {
        const ipc = require("electron").ipcRenderer;
        const expectedPath = ${JSON.stringify(filePath)};
        const requestId = ${JSON.stringify(requestId)};
        const saveRequest = {
          ...${JSON.stringify(activeDocument.saveRequest)},
          requestId,
        };
        if (!${JSON.stringify(activeDocument.matchesActiveDocument)}) {
          resolve({ setupFailed: true });
          return;
        }
        const timer = setTimeout(() => {
          ipc.removeListener("save-markdown-result", onResult);
          resolve({ timedOut: true });
        }, 5000);
        const onResult = (_event, result) => {
          if (
            !result ||
            result.path !== expectedPath ||
            result.requestId !== requestId
          ) return;
          clearTimeout(timer);
          ipc.removeListener("save-markdown-result", onResult);
          resolve({ timedOut: false, result });
        };
        ipc.on("save-markdown-result", onResult);
        ipc.send("save-markdown-file", {
          filePath: expectedPath,
          content: ${JSON.stringify(content)},
          requestId,
          saveRequestSession: saveRequest.pageSession,
          saveRequest,
        });
      })
    `);
    return {
      ...save,
      requestId,
      activeDocument,
      saveRequest: {
        ...activeDocument.saveRequest,
        requestId,
      },
    };
  };
  // Preserve the lower-level IPC tests below for main-process race coverage,
  // and add this renderer-owned route so identity construction, content
  // capture, and correlation cross the production saveMarkdownFile() boundary.
  const requestProducerSave = async (filePath, baselineContent, content) => {
    await clearTabs();
    const tab = await createActiveTab(filePath, baselineContent);
    return exec(`
      (async () => {
        const ipc = require("electron").ipcRenderer;
        const originalSend = ipc.send;
        const originalAlert = window.alert;
        const requests = [];
        const alerts = [];
        let timer = null;
        let onResult = null;
        try {
          ipc.send = function(channel, ...args) {
            if (channel === "save-markdown-file") requests.push(args[0]);
            return originalSend.call(this, channel, ...args);
          };
          window.alert = message => alerts.push(String(message));
          window.originalMarkdown = ${JSON.stringify(content)};
          const active = window.CustomTabs.getTabs().find(t => t.id === ${tab.id});
          if (active) active.content = window.originalMarkdown;
          return await new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true, requests, alerts }), 5000);
            onResult = (_event, result) => {
              const request = requests[0];
              if (!result || !request || result.requestId !== request.requestId) return;
              resolve({ timedOut: false, result, requests, alerts });
            };
            ipc.on("save-markdown-result", onResult);
            saveMarkdownFile();
          });
        } catch (error) {
          return { error: String(error && error.stack ? error.stack : error), requests, alerts };
        } finally {
          if (timer) clearTimeout(timer);
          if (onResult) ipc.removeListener("save-markdown-result", onResult);
          ipc.send = originalSend;
          window.alert = originalAlert;
        }
      })()
    `);
  };
  const producerRequestMatches = (save, filePath, content) => {
    const request = save && save.requests && save.requests[0];
    const result = save && save.result;
    return !!(
      request && result && request.filePath === filePath && request.content === content &&
      request.requestId === request.saveRequest?.requestId &&
      request.saveRequestSession === request.saveRequest?.pageSession &&
      Number.isSafeInteger(request.saveRequest?.tabId) &&
      Number.isSafeInteger(request.saveRequest?.documentGeneration) &&
      typeof request.saveRequest?.pathKey === "string" &&
      Number.isSafeInteger(request.saveRequest?.selectionGeneration) &&
      request.saveRequest.selectionGeneration > 0 &&
      Number.isSafeInteger(request.saveRequest?.sequence) && request.saveRequest.sequence > 0 &&
      result.requestId === request.requestId &&
      result.saveRequestSession === request.saveRequestSession &&
      result.saveRequest && result.saveRequest.requestId === request.saveRequest.requestId &&
      result.saveRequest.sequence === request.saveRequest.sequence &&
      result.saveRequest.pageSession === request.saveRequest.pageSession &&
      result.saveRequest.tabId === request.saveRequest.tabId &&
      result.saveRequest.documentGeneration === request.saveRequest.documentGeneration &&
      result.saveRequest.pathKey === request.saveRequest.pathKey &&
      result.saveRequest.selectionGeneration === request.saveRequest.selectionGeneration
    );
  };

  // A real renderer save must retain its producer-owned identity and bytes when
  // a filesystem race rejects it; hand-authoring this envelope would test only
  // main's validator, not the saveMarkdownFile() producer.
  const producerRaceFile = path.join(dir, "f22-producer-save-race.md");
  fs.writeFileSync(producerRaceFile, "F22_PRODUCER_RACE_BASE", "utf8");
  const realProducerRaceOpen = fs.promises.open;
  let producerRaceOpenCount = 0;
  const restoreProducerRaceOpen = replaceMethod(
    fs.promises,
    "open",
    async (candidate, flags, ...args) => {
      if (candidate === producerRaceFile && flags === "r+" && producerRaceOpenCount++ === 0) {
        throw Object.assign(new Error(`ENOENT: controlled producer save race for '${candidate}'`), {
          code: "ENOENT", path: candidate,
        });
      }
      return realProducerRaceOpen(candidate, flags, ...args);
    },
  );
  let producerRaceSave;
  try {
    producerRaceSave = await requestProducerSave(
      producerRaceFile,
      "F22_PRODUCER_RACE_BASE",
      "F22_PRODUCER_RACE_ATTEMPT",
    );
  } finally {
    restoreProducerRaceOpen();
  }
  check(
    "F22 saveMarkdownFile preserves its real request identity and content through a main path-race rejection",
    producerRaceSave && !producerRaceSave.error && producerRaceSave.timedOut === false &&
      producerRequestMatches(producerRaceSave, producerRaceFile, "F22_PRODUCER_RACE_ATTEMPT") &&
      producerRaceSave.result.success === false && producerRaceSave.result.conflict === true &&
      producerRaceOpenCount === 1 &&
      fs.readFileSync(producerRaceFile, "utf8") === "F22_PRODUCER_RACE_BASE",
    JSON.stringify({ producerRaceSave, producerRaceOpenCount }),
  );

  const trackHandle = (handle, tracker) => ({
    stat: (...args) => handle.stat(...args),
    truncate: (...args) => {
      tracker.truncates += 1;
      return handle.truncate(...args);
    },
    writeFile: (...args) => {
      tracker.writes += 1;
      return handle.writeFile(...args);
    },
    sync: (...args) => handle.sync(...args),
    close: async (...args) => {
      tracker.closes += 1;
      return handle.close(...args);
    },
  });
  const enoent = (filePath) =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
      code: "ENOENT",
      path: filePath,
    });
  const eexist = (filePath) =>
    Object.assign(new Error(`EEXIST: file already exists, open '${filePath}'`), {
      code: "EEXIST",
      path: filePath,
    });

  // A file which appears after the first r+ ENOENT must conflict before it
  // can be opened for writing. truncate or write would destroy the other
  // writer's bytes.
  const appearedFile = path.join(dir, "f22-save-appeared.md");
  const appeared = {
    rplus: 0,
    wx: 0,
    truncates: 0,
    writes: 0,
    closes: 0,
    unlinks: 0,
  };
  const realAppearedOpen = fs.promises.open;
  const realAppearedUnlink = fs.promises.unlink;
  const realAppearedUnlinkSync = fs.unlinkSync;
  let appearedSave;
  const restoreAppearedOpen = replaceMethod(
    fs.promises,
    "open",
    async (candidate, flags, ...args) => {
      if (candidate === appearedFile && flags === "r+") {
        appeared.rplus += 1;
        throw enoent(candidate);
      }
      if (candidate === appearedFile && flags === "wx+") {
        appeared.wx += 1;
        fs.writeFileSync(appearedFile, "F22_EXTERNAL_APPEARED_BYTES", "utf8");
        throw eexist(candidate);
      }
      return realAppearedOpen(candidate, flags, ...args);
    },
  );
  const restoreAppearedUnlink = replaceMethod(
    fs.promises,
    "unlink",
    async (candidate, ...args) => {
      if (candidate === appearedFile) appeared.unlinks += 1;
      return realAppearedUnlink(candidate, ...args);
    },
  );
  const restoreAppearedUnlinkSync = replaceMethod(
    fs,
    "unlinkSync",
    (candidate, ...args) => {
      if (candidate === appearedFile) appeared.unlinks += 1;
      return realAppearedUnlinkSync(candidate, ...args);
    },
  );
  try {
    appearedSave = await requestSave(
      appearedFile,
      "F22_ATTEMPTED_OVERWRITE_OF_APPEARED_FILE",
    );
  } finally {
    restoreAppearedUnlinkSync();
    restoreAppearedUnlink();
    restoreAppearedOpen();
  }
  check(
    "F22 a regular file which appears after ENOENT conflicts before opening it for writing",
    appearedSave &&
      hasMatchedSaveRequest(appearedSave) &&
      appearedSave.timedOut === false &&
      appearedSave.result &&
      appearedSave.result.success === false &&
      appearedSave.result.conflict === true &&
      appeared.rplus === 1 &&
      appeared.wx === 1 &&
      appeared.truncates === 0 &&
      appeared.writes === 0 &&
      appeared.closes === 0 &&
      appeared.unlinks === 0 &&
      fs.readFileSync(appearedFile, "utf8") === "F22_EXTERNAL_APPEARED_BYTES",
    JSON.stringify({ appearedSave, appeared, bytes: fs.existsSync(appearedFile) ? fs.readFileSync(appearedFile, "utf8") : null }),
  );

  // Put a final-entry link in place precisely when openDocumentForSave tries
  // wx+. This models a reparse-point swap without depending on scheduler
  // timing. wx+ must reject it, and the retry path must not follow it.
  if (symlinkAvailable) {
    const reparseTarget = path.join(dir, "f22-save-reparse-target.md");
    const reparseLink = path.join(dir, "f22-save-reparse-link.md");
    fs.writeFileSync(reparseTarget, "F22_REPARSE_TARGET_BYTES", "utf8");
    const reparse = { rplus: 0, wx: 0, unlinks: 0 };
    const realReparseOpen = fs.promises.open;
    const realReparseUnlink = fs.promises.unlink;
    const realReparseUnlinkSync = fs.unlinkSync;
    let reparseSave;
    let reparseLinkStats = null;
    let reparseLinkTarget = null;
    const restoreReparseOpen = replaceMethod(
      fs.promises,
      "open",
      async (candidate, flags, ...args) => {
        if (candidate === reparseLink && flags === "r+") {
          reparse.rplus += 1;
          throw enoent(candidate);
        }
        if (candidate === reparseLink && flags === "wx+") {
          reparse.wx += 1;
          fs.symlinkSync(reparseTarget, reparseLink, "file");
          throw eexist(candidate);
        }
        return realReparseOpen(candidate, flags, ...args);
      },
    );
    const restoreReparseUnlink = replaceMethod(
      fs.promises,
      "unlink",
      async (candidate, ...args) => {
        if (candidate === reparseLink || candidate === reparseTarget) {
          reparse.unlinks += 1;
        }
        return realReparseUnlink(candidate, ...args);
      },
    );
    const restoreReparseUnlinkSync = replaceMethod(
      fs,
      "unlinkSync",
      (candidate, ...args) => {
        if (candidate === reparseLink || candidate === reparseTarget) {
          reparse.unlinks += 1;
        }
        return realReparseUnlinkSync(candidate, ...args);
      },
    );
    try {
      reparseSave = await requestSave(
        reparseLink,
        "F22_ATTEMPTED_REPARSE_TARGET_MUTATION",
      );
      reparseLinkStats = fs.lstatSync(reparseLink);
      reparseLinkTarget = fs.readlinkSync(reparseLink);
    } finally {
      restoreReparseUnlinkSync();
      restoreReparseUnlink();
      restoreReparseOpen();
    }
    check(
      "F22 a symlink introduced between the pre-create check and wx+ cannot redirect a save",
      reparseSave &&
        hasMatchedSaveRequest(reparseSave) &&
        reparseSave.timedOut === false &&
        reparseSave.result &&
        reparseSave.result.success === false &&
        /symbolic link whose target is missing/i.test(
          String(reparseSave.result.error),
        ) &&
        reparse.rplus === 1 &&
        reparse.wx === 1 &&
        reparse.unlinks === 0 &&
        reparseLinkStats &&
        reparseLinkStats.isSymbolicLink() &&
        reparseLinkTarget === reparseTarget &&
        fs.readFileSync(reparseTarget, "utf8") === "F22_REPARSE_TARGET_BYTES",
      JSON.stringify({
        reparseSave,
        reparse,
        reparseLinkTarget,
        targetBytes: fs.readFileSync(reparseTarget, "utf8"),
      }),
    );
    try {
      fs.unlinkSync(reparseLink);
    } catch {}
  }

  // Rename the baseline file after r+ has returned its real handle. The
  // logical spelling is now absent, so resolveCanonicalFileKey is null. This
  // must be a pre-write conflict, not a write through the still-open displaced
  // handle (which would mutate the renamed external file).
  const vanishedFile = path.join(dir, "f22-save-vanished.md");
  const parkedVanishedFile = path.join(dir, "f22-save-vanished-parked.md");
  fs.writeFileSync(vanishedFile, "F22_VANISHED_BASELINE_BYTES", "utf8");
  const vanished = {
    rplus: 0,
    renamed: false,
    truncates: 0,
    writes: 0,
    closes: 0,
    unlinks: 0,
  };
  const realVanishedOpen = fs.promises.open;
  const realVanishedUnlink = fs.promises.unlink;
  const realVanishedUnlinkSync = fs.unlinkSync;
  let vanishedSave;
  const restoreVanishedOpen = replaceMethod(
    fs.promises,
    "open",
    async (candidate, flags, ...args) => {
      if (candidate === vanishedFile && flags === "r+") {
        vanished.rplus += 1;
        const handle = await realVanishedOpen(candidate, flags, ...args);
        fs.renameSync(vanishedFile, parkedVanishedFile);
        vanished.renamed = true;
        return trackHandle(handle, vanished);
      }
      return realVanishedOpen(candidate, flags, ...args);
    },
  );
  const restoreVanishedUnlink = replaceMethod(
    fs.promises,
    "unlink",
    async (candidate, ...args) => {
      if (candidate === vanishedFile || candidate === parkedVanishedFile) {
        vanished.unlinks += 1;
      }
      return realVanishedUnlink(candidate, ...args);
    },
  );
  const restoreVanishedUnlinkSync = replaceMethod(
    fs,
    "unlinkSync",
    (candidate, ...args) => {
      if (candidate === vanishedFile || candidate === parkedVanishedFile) {
        vanished.unlinks += 1;
      }
      return realVanishedUnlinkSync(candidate, ...args);
    },
  );
  try {
    vanishedSave = await requestSave(
      vanishedFile,
      "F22_ATTEMPTED_WRITE_AFTER_LOGICAL_DISAPPEARANCE",
      "F22_VANISHED_BASELINE_BYTES",
    );
  } finally {
    restoreVanishedUnlinkSync();
    restoreVanishedUnlink();
    restoreVanishedOpen();
  }
  check(
    "F22 a baseline path whose current canonical key disappears conflicts before writing its displaced handle",
    vanishedSave &&
      hasMatchedSaveRequest(vanishedSave) &&
      vanishedSave.timedOut === false &&
      vanishedSave.result &&
      vanishedSave.result.success === false &&
      vanishedSave.result.conflict === true &&
      vanished.rplus === 1 &&
      vanished.renamed === true &&
      vanished.truncates === 0 &&
      vanished.writes === 0 &&
      vanished.closes === 1 &&
      vanished.unlinks === 0 &&
      fs.existsSync(vanishedFile) === false &&
      fs.readFileSync(parkedVanishedFile, "utf8") ===
        "F22_VANISHED_BASELINE_BYTES",
    JSON.stringify({
      vanishedSave,
      vanished,
      vanishedPathExists: fs.existsSync(vanishedFile),
      parkedBytes: fs.existsSync(parkedVanishedFile)
        ? fs.readFileSync(parkedVanishedFile, "utf8")
        : null,
    }),
  );

  // The guards must remain narrow: an actually new regular file and an
  // existing link whose target is still valid retain their normal save path.
  const newRegularFile = path.join(dir, "f22-save-new-regular.md");
  const newRegularSave = await requestSave(
    newRegularFile,
    "F22_NEW_REGULAR_SAVE_BYTES",
  );
  check(
    "F22 a genuinely new regular file still saves successfully",
    newRegularSave &&
      hasMatchedSaveRequest(newRegularSave) &&
      newRegularSave.timedOut === false &&
      newRegularSave.result &&
      newRegularSave.result.success === true &&
      fs.readFileSync(newRegularFile, "utf8") === "F22_NEW_REGULAR_SAVE_BYTES",
    JSON.stringify({
      newRegularSave,
      bytes: fs.existsSync(newRegularFile)
        ? fs.readFileSync(newRegularFile, "utf8")
        : null,
    }),
  );
  if (symlinkAvailable) {
    const validTarget = path.join(dir, "f22-save-valid-link-target.md");
    const validLink = path.join(dir, "f22-save-valid-link.md");
    fs.writeFileSync(validTarget, "F22_VALID_LINK_BASELINE", "utf8");
    fs.symlinkSync(validTarget, validLink, "file");
    const validLinkSave = await requestSave(
      validLink,
      "F22_VALID_LINK_SAVED_BYTES",
    );
    const validLinkStats = fs.lstatSync(validLink);
    check(
      "F22 an existing symlink with a valid target still saves successfully",
      validLinkSave &&
        hasMatchedSaveRequest(validLinkSave) &&
        validLinkSave.timedOut === false &&
        validLinkSave.result &&
        validLinkSave.result.success === true &&
        validLinkStats.isSymbolicLink() &&
        fs.readlinkSync(validLink) === validTarget &&
        fs.readFileSync(validTarget, "utf8") === "F22_VALID_LINK_SAVED_BYTES",
      JSON.stringify({
        validLinkSave,
        linkTarget: fs.readlinkSync(validLink),
        targetBytes: fs.readFileSync(validTarget, "utf8"),
      }),
    );
    try {
      fs.unlinkSync(validLink);
    } catch {}
  }
  check(
    "F22 prepareSaveRequest keeps production-issued save sequences positive and strictly monotonic",
    observedSaveRaceSequences.length > 0 &&
      observedSaveRaceSequences.every((entry) => entry.sequencePositive === true) &&
      observedSaveRaceSequences.every((entry) => entry.sequenceMonotonic === true) &&
      observedSaveRaceSequences.every((entry, index, entries) =>
        index === 0 || entry.sequence > entries[index - 1].sequence),
    JSON.stringify(observedSaveRaceSequences),
  );
  } finally {
    await exec(`
      window.__f22SavePathRaceProbe &&
        window.__f22SavePathRaceProbe.restore();
      null;
    `);
  }

  // Hold only IPC delivery, not the filesystem implementation: both saves use
  // the real FileHandle.writeFile path. This makes the close path observe two
  // genuinely pending renderer saves, including one started after it began to
  // wait, without reviving the obsolete fs.writeFile monkeypatch.
  fs.writeFileSync(closeFile, "F22_CLOSE_BASE", "utf8");
  await clearTabs();
  const closingTab = await createActiveTab(closeFile, "F22_CLOSE_BASE");
  const heldSaveResults = [];
  const realSaveSend = wc.send;
  const restoreSaveSend = replaceMethod(wc, "send", function (channel, ...args) {
    if (channel === "save-markdown-result") {
      heldSaveResults.push(args[0]);
      return;
    }
    return realSaveSend.call(this, channel, ...args);
  });
  let closeFlow;
  let firstHeld;
  let secondHeld;
  let stillOpenWithBothPending;
  let stillOpenAfterFirst;
  let pendingCloseAlerts = null;
  const pendingSaveRig = shutdownRig(win);
  let pendingSaveDeferral;
  try {
    await exec(`
      (() => {
        const originalAlert = window.alert;
        const alerts = [];
        window.__f22PendingCloseAlert = { originalAlert, alerts };
        window.alert = message => alerts.push(String(message));
        return null;
      })()
    `);
    // First prove the shutdown protocol parks its question while the renderer
    // reports a real pending save. The result is deliberately held above, so
    // this covers the save-queue deferral without replacing any fs method.
    __shutdown.reset();
    pendingSaveRig.reset();
    pendingSaveRig.answer = 1;
    await exec(`
      window.originalMarkdown = "F22_SHUTDOWN_PENDING_SAVE";
      document.getElementById("saveButton").click();
      null;
    `);
    const deferralResultHeld = await waitUntil(() => heldSaveResults.length === 1, 5000);
    const deferredClose = guardEvent();
    win.emit("close", deferredClose);
    const deferred = await waitUntil(
      () => __shutdown.state().pendingId > 0 && pendingSaveRig.dialogs.length === 0,
      5000,
    );
    if (heldSaveResults[0]) {
      realSaveSend.call(wc, "save-markdown-result", heldSaveResults[0]);
    }
    const resumed = await waitUntil(() => pendingSaveRig.closes === 1, 5000);
    pendingSaveDeferral = {
      deferralResultHeld,
      deferred,
      resumed,
      prevented: deferredClose.prevented,
      dialogs: pendingSaveRig.dialogs.length,
    };
    __shutdown.reset();
    heldSaveResults.length = 0;

    await exec(`
      window.originalMarkdown = "F22_CLOSE_FIRST";
      document.getElementById("saveButton").click();
      null;
    `);
    firstHeld = await waitUntil(() => heldSaveResults.length === 1, 5000);
    await exec(`
      window.__f22ClosePromise = window.CustomTabs.closeTab(${closingTab.id})
        .then(() => "settled", (error) => "rejected:" + String(error));
      null;
    `);
    await exec(`
      window.originalMarkdown = "F22_CLOSE_SECOND";
      document.getElementById("saveButton").click();
      null;
    `);
    secondHeld = await waitUntil(() => heldSaveResults.length === 2, 5000);
    stillOpenWithBothPending = await exec(`
      ({ tab: !!window.CustomTabs.getTabs().find(t => t.id === ${closingTab.id}),
         pending: window.getPendingSaveStatus(${JSON.stringify(closeFile)}).count })
    `);
    if (heldSaveResults[0]) realSaveSend.call(wc, "save-markdown-result", heldSaveResults[0]);
    await sleep(100);
    stillOpenAfterFirst = await exec(
      `!!window.CustomTabs.getTabs().find(t => t.id === ${closingTab.id})`,
    );
    if (heldSaveResults[1]) realSaveSend.call(wc, "save-markdown-result", heldSaveResults[1]);
    closeFlow = await exec(`window.__f22ClosePromise`);
  } finally {
    pendingSaveRig.restore();
    __shutdown.reset();
    restoreSaveSend();
    try {
      pendingCloseAlerts = await exec(`
        (() => {
          const probe = window.__f22PendingCloseAlert;
          if (!probe) return null;
          window.alert = probe.originalAlert;
          delete window.__f22PendingCloseAlert;
          return probe.alerts;
        })()
      `);
    } catch {
      pendingCloseAlerts = null;
    }
  }
  check(
    "F22 shutdown defers its approval until a pending save settles instead of prompting concurrently",
    pendingSaveDeferral &&
      pendingSaveDeferral.deferralResultHeld === true &&
      pendingSaveDeferral.deferred === true &&
      pendingSaveDeferral.resumed === true &&
      pendingSaveDeferral.prevented === true &&
      pendingSaveDeferral.dialogs === 0 &&
      Array.isArray(pendingCloseAlerts) &&
      pendingCloseAlerts.length === 0,
    JSON.stringify({ pendingSaveDeferral, pendingCloseAlerts }),
  );
  const diskAfterClose = fs.readFileSync(closeFile, "utf8");
  const closedAfterBoth = await exec(
    `!window.CustomTabs.getTabs().find(t => t.id === ${closingTab.id})`,
  );
  const reopened = await createActiveTab(closeFile, diskAfterClose);
  await sleep(350);
  check(
    "F22 close waits for its first and later pending save before removing the tab or allowing a safe reopen",
    firstHeld === true &&
      secondHeld === true &&
      stillOpenWithBothPending.tab === true &&
      stillOpenWithBothPending.pending === 2 &&
      stillOpenAfterFirst === true &&
      closeFlow === "settled" &&
      closedAfterBoth === true &&
      diskAfterClose === "F22_CLOSE_SECOND" &&
      !!reopened &&
      fs.readFileSync(closeFile, "utf8") === "F22_CLOSE_SECOND",
    JSON.stringify({ firstHeld, secondHeld, stillOpenWithBothPending, stillOpenAfterFirst, closeFlow, diskAfterClose }),
  );

  }

  // ---- F22 regression: an edit-mode CRLF undo keeps raw cache bytes -------
  if (!deletionProductionPrerequisite.saveResultCorrelation) {
    reportDeletionCapability(
      "F22 raw-newline save identity and cache evidence requires saveRequest production support",
      classifyDeletionCapability(
        /\bsaveRequest\b/.test(saveHandlerSource),
        deletionProductionPrerequisite.saveResultCorrelation,
      ),
      JSON.stringify({
        saveResultCorrelation: deletionProductionPrerequisite.saveResultCorrelation,
      }),
    );
  } else {
  // The editor necessarily exposes LF text.  Exercise its real input and undo
  // path, then cross a tab snapshot before making a later, unrelated save.
  // A semantic-only test would miss the regression: the current text still
  // compares clean while the cache that save consumes has already lost CRLF.
  const crlfEditFile = path.join(dir, "f22-edit-mode-crlf.md");
  const crlfOtherFile = path.join(dir, "f22-edit-mode-crlf-other.md");
  const crlfOriginal = "# F22 CRLF\r\n\r\nORIGINAL\r\n";
  const crlfSaved = "# F22 CRLF\r\n\r\nPERSISTED_EDIT\r\n";
  fs.writeFileSync(crlfEditFile, crlfOriginal, "utf8");
  fs.writeFileSync(crlfOtherFile, "F22_CRLF_OTHER_TAB\r\n", "utf8");
  await clearTabs();
  const crlfTab = await createActiveTab(crlfEditFile, crlfOriginal);
  const crlfOtherTab = await exec(
    `window.CustomTabs.createTab(${JSON.stringify(crlfOtherFile)}, "F22_CRLF_OTHER_TAB\\r\\n", { activate: false })`,
  );
  await exec(`toggleEditBtn.click(); null;`);
  const crlfEnteredEditMode = await waitForCondition(
    exec,
    `window.CustomTabs.__inEditMode() === true`,
    5000,
  );
  const crlfUndoBaseline = await exec(`window.getFileOpenDiagnostics().undoSize`);
  const crlfUndoRecorded = await exec(`
    (async () => {
      const editor = window.markdownEditor;
      const original = editor.value;
      const replacementStart = original.indexOf("ORIGINAL");
      // The editor input debounce records its *current* value. Establish the
      // same pre-edit entry that production edit commands create before they
      // replace source, then undo before the debounce can record the edit.
      // When that timer later finalizes it sees the restored original and the
      // duplicate guard keeps the pre-edit entry as the top history item.
      historyPush(original);
      const undoSizeBeforeUndo = window.getFileOpenDiagnostics().undoSize;
      editor.setRangeText(
        "TEMPORARY_EDIT",
        replacementStart,
        replacementStart + "ORIGINAL".length,
        "end",
      );
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "TEMPORARY_EDIT",
      }));
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", ctrlKey: true, bubbles: true, cancelable: true,
      }));
      const undoApplied = editor.value === original;
      const undoFinalized = await new Promise((resolve) => {
        const deadline = Date.now() + 2000;
        const observe = () => {
          const size = window.getFileOpenDiagnostics().undoSize;
          if (size === undoSizeBeforeUndo && editor.value === original) {
            resolve({ size, timedOut: false });
          } else if (Date.now() >= deadline) {
            resolve({ size, timedOut: true });
          } else {
            setTimeout(observe, 25);
          }
        };
        observe();
      });
      return {
        undoSizeBeforeUndo,
        undoApplied,
        undoFinalized,
        editor: editor.value,
      };
    })()
  `);
  const crlfUndoState = await exec(`
    (() => {
      const tab = window.CustomTabs.getTabs().find(t => t.id === ${crlfTab.id});
      return {
        editor: window.markdownEditor.value,
        semanticOriginal: window.markdownEditor.value === ${JSON.stringify(
          crlfOriginal.replace(/\r\n/g, "\n"),
        )},
        tabContent: tab && tab.content,
      };
    })()
  `);
  await exec(`window.CustomTabs.switchToTab(${crlfOtherTab.id}); null;`);
  await exec(`window.CustomTabs.switchToTab(${crlfTab.id}); null;`);
  const crlfAfterRoundTrip = await exec(`
    (() => {
      const tab = window.CustomTabs.getTabs().find(t => t.id === ${crlfTab.id});
      return {
        content: tab && tab.content,
        original: tab && tab.originalContent,
        editor: window.markdownEditor.value,
        dirty: tab && tab.hasUnsavedChanges,
      };
    })()
  `);
  const crlfSave = await exec(`
    (async () => {
      const ipc = require("electron").ipcRenderer;
      const filePath = ${JSON.stringify(crlfEditFile)};
      const oldAlert = window.alert;
      const originalSend = ipc.send;
      let savePayload = null;
      let selectedOwner = null;
      let ownerAtSave = null;
      let timer = null;
      let onResult = null;
      try {
        ipc.send = function (channel, ...args) {
          const payload = args[0];
          if (
            (channel === "set-active-file" || channel === "start-file-watching") &&
            payload &&
            payload.filePath === filePath &&
            payload.owner
          ) {
            selectedOwner = payload.owner;
          }
          if (channel === "save-markdown-file") {
            savePayload = payload;
            ownerAtSave = selectedOwner;
          }
          return originalSend.call(this, channel, ...args);
        };
        window.alert = () => {};
        window.CustomTabs.switchToTab(${crlfOtherTab.id});
        window.CustomTabs.switchToTab(${crlfTab.id});
        window.markdownEditor.value = "# F22 CRLF\\n\\nPERSISTED_EDIT\\n";
        window.markdownEditor.dispatchEvent(new Event("input", { bubbles: true }));
        return await new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ timedOut: true, savePayload, ownerAtSave }),
            5000,
          );
          onResult = (_event, result) => {
            if (!result || result.path !== filePath) return;
            resolve({ timedOut: false, result, savePayload, ownerAtSave });
          };
          ipc.on("save-markdown-result", onResult);
          document.getElementById("saveButton").click();
        });
      } catch (error) {
        return {
          error: String(error && error.stack ? error.stack : error),
          savePayload,
          ownerAtSave,
        };
      } finally {
        if (timer) clearTimeout(timer);
        if (onResult) ipc.removeListener("save-markdown-result", onResult);
        ipc.send = originalSend;
        window.alert = oldAlert;
      }
    })()
  `);
  const crlfDiskBytes = fs.readFileSync(crlfEditFile, "utf8");
  const crlfAfterEditSave = await exec(`
    (() => {
      const tab = window.CustomTabs.getTabs().find(t => t.id === ${crlfTab.id});
      return {
        content: tab && tab.content,
        original: tab && tab.originalContent,
        dirty: tab && tab.hasUnsavedChanges,
        editMode: window.CustomTabs.__inEditMode(),
      };
    })()
  `);
  const crlfEditDetail = JSON.stringify({
    crlfEnteredEditMode,
    crlfUndoBaseline,
    crlfUndoRecorded,
    crlfUndoState,
    crlfAfterRoundTrip,
    crlfSave,
    expectedBytes: crlfSaved,
    diskBytes: crlfDiskBytes,
    crlfAfterEditSave,
  });
  check(
    "F22 edit-mode CRLF undo survives tab cache folding without becoming dirty",
    crlfEnteredEditMode === true &&
      crlfUndoRecorded.undoSizeBeforeUndo === crlfUndoBaseline + 1 &&
      crlfUndoRecorded.undoApplied === true &&
      crlfUndoRecorded.undoFinalized &&
      crlfUndoRecorded.undoFinalized.timedOut === false &&
      crlfUndoRecorded.undoFinalized.size === crlfUndoBaseline + 1 &&
      crlfUndoRecorded.editor === crlfOriginal.replace(/\r\n/g, "\n") &&
      crlfUndoState.semanticOriginal === true &&
      crlfAfterRoundTrip.content === crlfOriginal &&
      crlfAfterRoundTrip.original === crlfOriginal &&
      crlfAfterRoundTrip.dirty === false &&
      crlfAfterEditSave.editMode === true,
    crlfEditDetail,
  );
  check(
    "F22 edit-mode CRLF save sends and persists raw CRLF bytes, then is clean",
    crlfSave &&
      crlfSave.timedOut === false &&
      crlfSave.result &&
      crlfSave.result.success === true &&
      crlfSave.savePayload &&
      crlfSave.savePayload.filePath === crlfEditFile &&
      crlfSave.savePayload.content === crlfSaved &&
      crlfSave.savePayload.saveRequest &&
      crlfSave.ownerAtSave &&
      crlfSave.savePayload.saveRequest.pageSession ===
        crlfSave.ownerAtSave.pageSession &&
      crlfSave.savePayload.saveRequest.tabId === crlfTab.id &&
      crlfSave.savePayload.saveRequest.documentGeneration ===
        crlfSave.ownerAtSave.documentGeneration &&
      crlfSave.savePayload.saveRequest.pathKey ===
        crlfSave.ownerAtSave.pathKey &&
      Number.isSafeInteger(crlfSave.savePayload.saveRequest.selectionGeneration) &&
      crlfSave.savePayload.saveRequest.selectionGeneration > 0 &&
      crlfSave.savePayload.saveRequest.selectionGeneration ===
        crlfSave.ownerAtSave.selectionGeneration &&
      Number.isSafeInteger(crlfSave.savePayload.saveRequest.sequence) &&
      crlfSave.savePayload.saveRequest.sequence > 0 &&
      crlfDiskBytes === crlfSaved &&
      !/(^|[^\r])\n/.test(crlfDiskBytes) &&
      crlfAfterEditSave.content === crlfSaved &&
      crlfAfterEditSave.original === crlfSaved &&
      crlfAfterEditSave.dirty === false,
    crlfEditDetail,
  );
  check(
    "F22 real Save carries complete active selection identity",
    crlfSave &&
      crlfSave.timedOut === false &&
      crlfSave.savePayload &&
      crlfSave.savePayload.saveRequest &&
      crlfSave.ownerAtSave &&
      typeof crlfSave.savePayload.saveRequest.pageSession === "string" &&
      Number.isSafeInteger(crlfSave.savePayload.saveRequest.tabId) &&
      Number.isSafeInteger(crlfSave.savePayload.saveRequest.documentGeneration) &&
      typeof crlfSave.savePayload.saveRequest.pathKey === "string" &&
      Number.isSafeInteger(crlfSave.savePayload.saveRequest.selectionGeneration) &&
      crlfSave.savePayload.saveRequest.selectionGeneration > 0 &&
      Number.isSafeInteger(crlfSave.savePayload.saveRequest.sequence) &&
      crlfSave.savePayload.saveRequest.sequence > 0 &&
      crlfSave.savePayload.saveRequest.pageSession ===
        crlfSave.ownerAtSave.pageSession &&
      crlfSave.savePayload.saveRequest.tabId === crlfSave.ownerAtSave.tabId &&
      crlfSave.savePayload.saveRequest.documentGeneration ===
        crlfSave.ownerAtSave.documentGeneration &&
      crlfSave.savePayload.saveRequest.pathKey ===
        crlfSave.ownerAtSave.pathKey &&
      crlfSave.savePayload.saveRequest.selectionGeneration ===
        crlfSave.ownerAtSave.selectionGeneration,
    crlfEditDetail,
  );

  // The real UI currently offers no view-mode Save gesture, but
  // saveMarkdownFile() is a renderer contract used by view-mode auto-saves.
  // Fold a CRLF view document through a tab round-trip, leave the textarea LF,
  // and verify that its IPC payload and post-save tab state use the folded
  // document rather than the stale textarea.
  const crlfViewSaved = "# F22 CRLF\r\n\r\nVIEW_MODE_EDIT\r\n";
  const crlfViewSave = await exec(`
    (async () => {
      const ipc = require("electron").ipcRenderer;
      const filePath = ${JSON.stringify(crlfEditFile)};
      const originalSend = ipc.send;
      const originalAlert = window.alert;
      let savePayload = null;
      let timer = null;
      let onResult = null;
      try {
        ipc.send = function (channel, ...args) {
          if (channel === "save-markdown-file") savePayload = args[0];
          return originalSend.call(this, channel, ...args);
        };
        window.alert = () => {};
        if (window.CustomTabs.__inEditMode()) {
          toggleEditBtn.click();
        }
        window.originalMarkdown = ${JSON.stringify(crlfViewSaved)};
        window.markdownEditor.value = ${JSON.stringify(crlfViewSaved.replace(/\r\n/g, "\n"))};
        window.CustomTabs.switchToTab(${crlfOtherTab.id});
        window.CustomTabs.switchToTab(${crlfTab.id});
        return await new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true, savePayload }), 5000);
          onResult = (_event, result) => {
            if (!result || result.path !== filePath) return;
            resolve({ timedOut: false, result, savePayload });
          };
          ipc.on("save-markdown-result", onResult);
          saveMarkdownFile();
        });
      } catch (error) {
        return { error: String(error && error.stack ? error.stack : error), savePayload };
      } finally {
        if (timer) clearTimeout(timer);
        if (onResult) ipc.removeListener("save-markdown-result", onResult);
        ipc.send = originalSend;
        window.alert = originalAlert;
      }
    })()
  `);
  const crlfViewDiskBytes = fs.readFileSync(crlfEditFile, "utf8");
  const crlfAfterViewSave = await exec(`
    (() => {
      const tab = window.CustomTabs.getTabs().find(t => t.id === ${crlfTab.id});
      return {
        content: tab && tab.content,
        original: tab && tab.originalContent,
        dirty: tab && tab.hasUnsavedChanges,
        editor: window.markdownEditor.value,
        editMode: window.CustomTabs.__inEditMode(),
      };
    })()
  `);
  const crlfViewDetail = JSON.stringify({
    crlfViewSave,
    expectedBytes: crlfViewSaved,
    diskBytes: crlfViewDiskBytes,
    crlfAfterViewSave,
  });
  check(
    "F22 view-mode CRLF fold saves raw bytes instead of the stale LF textarea",
    crlfViewSave &&
      !crlfViewSave.error &&
      crlfViewSave.timedOut === false &&
      crlfViewSave.result &&
      crlfViewSave.result.success === true &&
      crlfViewSave.savePayload &&
      crlfViewSave.savePayload.content === crlfViewSaved &&
      crlfViewDiskBytes === crlfViewSaved &&
      !/(^|[^\r])\n/.test(crlfViewDiskBytes) &&
      crlfAfterViewSave.editor === crlfViewSaved.replace(/\r\n/g, "\n"),
    crlfViewDetail,
  );
  check(
    "F22 view-mode CRLF save makes the folded tab clean with raw baseline bytes",
    crlfAfterViewSave.editMode === false &&
      crlfAfterViewSave.content === crlfViewSaved &&
      crlfAfterViewSave.original === crlfViewSaved &&
      crlfAfterViewSave.dirty === false &&
      crlfAfterViewSave.editor === crlfViewSaved.replace(/\r\n/g, "\n"),
    crlfViewDetail,
  );

  // A textarea normalizes CRLF and bare CR to LF. Two edits separated by
  // unchanged lines therefore need the tab's raw fold, rather than a document
  // default, to carry every untouched terminator to the real save payload.
  const mixedNewlineFile = path.join(dir, "f22-mixed-newlines.md");
  const mixedNewlineOtherFile = path.join(dir, "f22-mixed-newlines-other.md");
  const mixedNewlineOriginal = "a\r\nb\nc\rd\r\ne";
  const mixedNewlineSaved = "A\r\nb\nc\rD\r\ne";
  fs.writeFileSync(mixedNewlineFile, mixedNewlineOriginal, "utf8");
  fs.writeFileSync(mixedNewlineOtherFile, "F22_MIXED_NEWLINE_OTHER\n", "utf8");
  await clearTabs();
  const mixedNewlineTab = await createActiveTab(
    mixedNewlineFile,
    mixedNewlineOriginal,
  );
  const mixedNewlineOtherTab = await exec(
    `window.CustomTabs.createTab(${JSON.stringify(mixedNewlineOtherFile)}, "F22_MIXED_NEWLINE_OTHER\\n", { activate: false })`,
  );
  const mixedNewlineSave = await exec(`
    (async () => {
      const ipc = require("electron").ipcRenderer;
      const filePath = ${JSON.stringify(mixedNewlineFile)};
      const originalSend = ipc.send;
      const originalAlert = window.alert;
      let savePayload = null;
      let timer = null;
      let onResult = null;
      try {
        ipc.send = function (channel, ...args) {
          if (channel === "save-markdown-file") savePayload = args[0];
          return originalSend.call(this, channel, ...args);
        };
        window.alert = () => {};
        if (!window.CustomTabs.__inEditMode()) toggleEditBtn.click();
        const editor = window.markdownEditor;
        const original = editor.value;
        const undoSizeBeforeInput = window.getFileOpenDiagnostics().undoSize;
        editor.setRangeText("X", 0, 1, "end");
        editor.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: "X",
        }));
        await new Promise(resolve => setTimeout(resolve, 900));
        const undoSizeAfterFirstEdit = window.getFileOpenDiagnostics().undoSize;
        const firstStableValue = editor.value;
        editor.setRangeText("Y", 0, 1, "end");
        editor.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: "Y",
        }));
        const secondTransientValue = editor.value;
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "z", ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await new Promise(resolve => setTimeout(resolve, 900));
        const undoApplied = editor.value === firstStableValue &&
          editor.value !== secondTransientValue;
        const undoSizeAfterUndo = window.getFileOpenDiagnostics().undoSize;
        editor.setRangeText("A", 0, 1, "end");
        editor.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: "A",
        }));
        await new Promise(resolve => setTimeout(resolve, 900));
        const d = editor.value.indexOf("\\nd") + 1;
        editor.setRangeText("D", d, d + 1, "end");
        editor.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: "D",
        }));
        await new Promise(resolve => setTimeout(resolve, 900));
        window.CustomTabs.switchToTab(${mixedNewlineOtherTab.id});
        window.CustomTabs.switchToTab(${mixedNewlineTab.id});
        const restoredAfterRoundTrip = editor.value;
        return await new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({
              timedOut: true, savePayload, undoApplied, restoredAfterRoundTrip,
              undoSizeBeforeInput, undoSizeAfterFirstEdit, undoSizeAfterUndo,
              firstStableValue, secondTransientValue,
            }),
            5000,
          );
          onResult = (_event, result) => {
            if (!result || result.path !== filePath) return;
            resolve({
              timedOut: false, result, savePayload, undoApplied, restoredAfterRoundTrip,
              undoSizeBeforeInput, undoSizeAfterFirstEdit, undoSizeAfterUndo,
              firstStableValue, secondTransientValue,
            });
          };
          ipc.on("save-markdown-result", onResult);
          document.getElementById("saveButton").click();
        });
      } catch (error) {
        return {
          error: String(error && error.stack ? error.stack : error),
          savePayload,
        };
      } finally {
        if (timer) clearTimeout(timer);
        if (onResult) ipc.removeListener("save-markdown-result", onResult);
        ipc.send = originalSend;
        window.alert = originalAlert;
      }
    })()
  `);
  const mixedNewlineDiskBytes = fs.readFileSync(mixedNewlineFile, "utf8");
  const mixedNewlineAfterSave = await exec(`
    (() => {
      const tab = window.CustomTabs.getTabs().find(
        candidate => candidate.id === ${mixedNewlineTab.id},
      );
      return {
        content: tab && tab.content,
        original: tab && tab.originalContent,
        dirty: tab && tab.hasUnsavedChanges,
        editor: window.markdownEditor.value,
        editMode: window.CustomTabs.__inEditMode(),
      };
    })()
  `);
  const mixedNewlineDetail = JSON.stringify({
    mixedNewlineSave,
    expectedBytes: mixedNewlineSaved,
    diskBytes: mixedNewlineDiskBytes,
    mixedNewlineAfterSave,
  });
  check(
    "F22 noncontiguous mixed-newline edits preserve every untouched raw terminator through Save",
    mixedNewlineSave &&
      !mixedNewlineSave.error &&
      mixedNewlineSave.timedOut === false &&
      mixedNewlineSave.result &&
      mixedNewlineSave.result.success === true &&
      mixedNewlineSave.savePayload &&
      mixedNewlineSave.undoSizeAfterFirstEdit > mixedNewlineSave.undoSizeBeforeInput &&
      mixedNewlineSave.undoApplied === true &&
      mixedNewlineSave.firstStableValue === "X\nb\nc\nd\ne" &&
      mixedNewlineSave.secondTransientValue === "Y\nb\nc\nd\ne" &&
      mixedNewlineSave.undoSizeAfterUndo >= mixedNewlineSave.undoSizeBeforeInput &&
      mixedNewlineSave.restoredAfterRoundTrip === "A\nb\nc\nD\ne" &&
      mixedNewlineSave.savePayload.content === mixedNewlineSaved &&
      mixedNewlineDiskBytes === mixedNewlineSaved &&
      mixedNewlineAfterSave.editor === "A\nb\nc\nD\ne",
    mixedNewlineDetail,
  );
  check(
    "F22 mixed-newline Save makes the tab clean with the exact raw disk baseline",
    mixedNewlineAfterSave.editMode === true &&
      mixedNewlineAfterSave.content === mixedNewlineSaved &&
      mixedNewlineAfterSave.original === mixedNewlineSaved &&
      mixedNewlineAfterSave.dirty === false,
    mixedNewlineDetail,
  );

  }

  // ---- F22 regression: deleted-tab evidence belongs to its generation ----
  let f22WatcherProbe = null;
  const checkDeletionEvidence = (groups, name, evaluate, detail) => {
    scheduleDeletionAssertion(
      deletionEvidencePlan,
      groups,
      check,
      name,
      evaluate,
      detail,
    );
  };
  await runDeletionEvidenceGroup(
    deletionEvidencePlan,
    "producerGeneration",
    async () => {
  let watcherProbe = null;
  let mainDeletionAckProbe = null;
  let mainDeletionAckProbeRestored = false;
  let restoreWatcherConstruction = null;
  let restoreMainDeletionAckConstruction = null;
  try {
  // Instrument real main-process producer resources at the fs boundary, not
  // renderer IPC controls.  This records the OS watcher and the polling
  // producer used while a deleted path is retained for rearm.
  watcherProbe = (() => {
    const live = new Map();
    const starts = [];
    const stops = [];
    let nextId = 1;
    let lastWatchedPath = null;
    const snapshot = () => ({
      starts: starts.map(({ id, kind, filePath }) => ({ id, kind, filePath })),
      stops: stops.map(({ id, kind, filePath }) => ({ id, kind, filePath })),
      live: [...live.values()].map(({ id, kind, filePath }) => ({
        id, kind, filePath,
      })),
    });
    const retire = (record) => {
      if (!record || !live.delete(record.id)) return;
      stops.push(record);
    };
    const realWatch = fs.watch;
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const restoreWatch = replaceMethod(fs, "watch", function(filePath, ...args) {
      const watcher = realWatch.call(this, filePath, ...args);
      const record = {
        id: nextId++, kind: "fs.watch", filePath: String(filePath),
      };
      lastWatchedPath = record.filePath;
      starts.push(record);
      live.set(record.id, record);
      const originalClose = watcher.close.bind(watcher);
      replaceMethod(watcher, "close", function(...closeArgs) {
        try {
          return originalClose(...closeArgs);
        } finally {
          retire(record);
        }
      });
      watcher.once?.("close", () => retire(record));
      return watcher;
    });
    restoreWatcherConstruction = () => restoreWatch();
    const intervalRecords = new Map();
    const restoreSetInterval = replaceMethod(
      global,
      "setInterval",
      function(handler, delay, ...args) {
        const handle = realSetInterval.call(this, handler, delay, ...args);
        if (
          Number(delay) === 2000 &&
          typeof handler === "function" &&
          /\bcheckFileChanges\b/.test(Function.prototype.toString.call(handler))
        ) {
          const record = {
            id: nextId++, kind: "poll", filePath: lastWatchedPath,
          };
          starts.push(record);
          live.set(record.id, record);
          intervalRecords.set(handle, record);
          if (handle && typeof handle.close === "function") {
            const originalClose = handle.close.bind(handle);
            replaceMethod(handle, "close", function(...closeArgs) {
              try {
                return originalClose(...closeArgs);
              } finally {
                retire(record);
                intervalRecords.delete(handle);
              }
            });
          }
        }
        return handle;
      },
    );
    restoreWatcherConstruction = () => {
      restoreSetInterval();
      restoreWatch();
    };
    const restoreClearInterval = replaceMethod(
      global,
      "clearInterval",
      function(handle) {
        retire(intervalRecords.get(handle));
        intervalRecords.delete(handle);
        return realClearInterval.call(this, handle);
      },
    );
    restoreWatcherConstruction = () => {
      restoreClearInterval();
      restoreSetInterval();
      restoreWatch();
    };
    return {
      snapshot,
      restore() {
        restoreWatcherConstruction();
      },
    };
  })();
  f22WatcherProbe = watcherProbe;
  // Observe the actual ipcMain acknowledgement listener.  Renderer-side
  // forwarding only proves that ipcRenderer.send was attempted; the wrapped
  // listener below records a matching deletion-record Map retirement while
  // preserving its arguments, receiver, return value, and listener order.
  mainDeletionAckProbe = await runDeletionEvidenceGroup(
    deletionEvidencePlan,
    "acknowledgementLifecycle",
    async () => (() => {
    const channel = deletionAckChannel;
    const listeners = initialDeletionAckListeners;
    const sameListenerSequence = (left, right) =>
      left.length === right.length &&
      left.every((listener, index) => listener === right[index]);
    const productionListener = productionDeletionAckHandler;
    if (!productionListener || !synchronousProductionDeletionAckHandler) {
      throw new Error(
        `Expected one synchronous production ${channel} listener identified by ` +
          "findDeletionDeliveryById and clearDeletionDeliveryAttempt",
      );
    }
    const productionListenerIndex = listeners.indexOf(productionListener);
    const productionListenerIsOnce = !!productionListener.listener;
    const records = [];
    const recordWrites = [];
    let watchedOwner = null;
    const normaliseDelivery = (payload) => {
      const attempt = payload && (
        payload.attempt ?? payload.deliveryAttempt ?? payload.attemptId
      );
      const eventId = payload && (payload.eventId ?? payload.id);
      const owner = payload && (payload.owner || payload);
      return payload && {
        eventId,
        selectionGeneration: payload.selectionGeneration,
        watcherGeneration: payload.watcherGeneration,
        attempt,
        pageSession: payload.pageSession ?? (owner && owner.pageSession),
        rendererGeneration:
          payload.rendererGeneration ?? (owner && owner.rendererGeneration),
        tabId: owner && owner.tabId,
        documentGeneration: owner && owner.documentGeneration,
        pathKey: owner && owner.pathKey,
        complete: Number.isSafeInteger(eventId) &&
          eventId > 0 &&
          Number.isSafeInteger(payload.selectionGeneration) &&
          payload.selectionGeneration > 0 &&
          Number.isSafeInteger(payload.watcherGeneration) &&
          payload.watcherGeneration > 0 &&
          Number.isSafeInteger(attempt) &&
          attempt > 0 &&
          typeof (payload.pageSession ?? (owner && owner.pageSession)) === "string" &&
          (payload.pageSession ?? (owner && owner.pageSession)).length > 0 &&
          Number.isSafeInteger(
            payload.rendererGeneration ?? (owner && owner.rendererGeneration),
          ) &&
          (payload.rendererGeneration ?? (owner && owner.rendererGeneration)) > 0 &&
          Number.isSafeInteger(owner && owner.tabId) &&
          owner.tabId > 0 &&
          Number.isSafeInteger(owner && owner.documentGeneration) &&
          owner.documentGeneration > 0 &&
          typeof (owner && owner.pathKey) === "string" &&
          owner.pathKey.length > 0,
      };
    };
    const normaliseAcknowledgement = (payload) => {
      const delivery = normaliseDelivery(payload);
      return delivery && {
        ...delivery,
        consumed: payload.consumed,
        why: payload.why,
        complete:
          delivery.complete === true &&
          typeof payload.consumed === "boolean" &&
          typeof payload.why === "string",
      };
    };
    const sameIdentity = (left, right) => !!(
      left && right && left.complete && right.complete &&
      left.eventId === right.eventId &&
      left.selectionGeneration === right.selectionGeneration &&
      left.watcherGeneration === right.watcherGeneration &&
      left.attempt === right.attempt &&
      left.pageSession === right.pageSession &&
      left.rendererGeneration === right.rendererGeneration &&
      left.tabId === right.tabId &&
      left.documentGeneration === right.documentGeneration &&
      left.pathKey === right.pathKey
    );
    const sameAcknowledgement = (left, right) =>
      sameIdentity(left, right) && left.consumed === right.consumed &&
      left.why === right.why;
    const terminalDeletionRefusal = (identity) =>
      !!identity && [
        "owner-closed",
        "replacement-owner",
        "foreign-session",
        "owner-path-moved",
      ].includes(identity.why);
    const retryableDeletionRefusal = (identity) =>
      !!identity && identity.consumed === false &&
        [
          "owner-inactive",
          "frozen",
          "stale-selection",
          "not-active",
        ].includes(identity.why);
    const terminalAcknowledgement = (identity) =>
      !!identity && (
        (identity.consumed === true &&
          ["consumed", "already-consumed"].includes(identity.why)) ||
        (identity.consumed === false && terminalDeletionRefusal(identity))
      );
    const producerRecord = (value) =>
      value && (value.record || value.deliveryRecord || value);
    const recordIdentity = (value) => normaliseDelivery(
      producerRecord(value) &&
        (producerRecord(value).delivery || producerRecord(value).envelope ||
          producerRecord(value).report || producerRecord(value)),
    );
    const ownerIsComplete = (owner) => !!(
      owner &&
      typeof owner.pageSession === "string" &&
      owner.pageSession.length > 0 &&
      Number.isSafeInteger(owner.rendererGeneration) &&
      owner.rendererGeneration > 0 &&
      Number.isSafeInteger(owner.tabId) &&
      owner.tabId > 0 &&
      Number.isSafeInteger(owner.documentGeneration) &&
      owner.documentGeneration > 0 &&
      typeof owner.pathKey === "string" &&
      owner.pathKey.length > 0 &&
      typeof owner.spelling === "string"
    );
    const expectedOwnerKey = (owner) => ownerIsComplete(owner)
      ? [
        owner.pageSession,
        owner.rendererGeneration,
        owner.tabId,
        owner.documentGeneration,
        owner.pathKey,
        owner.spelling,
      ].join("\0")
      : null;
    const sameObservedDocumentOwner = (left, right) => !!(
      ownerIsComplete(left) &&
      ownerIsComplete(right) &&
      left.pageSession === right.pageSession &&
      left.rendererGeneration === right.rendererGeneration &&
      left.tabId === right.tabId &&
      left.documentGeneration === right.documentGeneration &&
      left.pathKey === right.pathKey &&
      left.spelling === right.spelling
    );
    const snapshotOwner = (owner) => ownerIsComplete(owner)
      ? {
        pageSession: owner.pageSession,
        rendererGeneration: owner.rendererGeneration,
        tabId: owner.tabId,
        documentGeneration: owner.documentGeneration,
        pathKey: owner.pathKey,
        spelling: owner.spelling,
      }
      : null;
    const observedObjectIds = new WeakMap();
    let nextObservedObjectId = 1;
    const observedObjectId = (value) => {
      if (value === null || value === undefined) return String(value);
      if ((typeof value !== "object" && typeof value !== "function")) {
        return `${typeof value}:${String(value)}`;
      }
      let id = observedObjectIds.get(value);
      if (!id) {
        id = nextObservedObjectId++;
        observedObjectIds.set(value, id);
      }
      return id;
    };
    const deliveryFingerprint = (identity) => identity && [
      identity.eventId,
      identity.pageSession,
      identity.rendererGeneration,
      identity.tabId,
      identity.documentGeneration,
      identity.pathKey,
      identity.selectionGeneration,
      identity.watcherGeneration,
      identity.attempt,
    ].join("\0");
    const attemptState = (record) => record && {
      recordKey: record.key,
      recordObjectId: observedObjectId(record),
      deliveryIdentity: deliveryFingerprint(recordIdentity(record)),
      attempt: record.attempt,
      inFlight: record.inFlight,
      hasBooleanInFlight: typeof record.inFlight === "boolean",
      hasAckTimeout: Object.hasOwn(record, "ackTimeout"),
      ackTimeoutActive: record.ackTimeout !== null &&
        record.ackTimeout !== undefined,
      ackTimeout: observedObjectId(record.ackTimeout),
      hasRetryTimeout: Object.hasOwn(record, "retryTimeout"),
      retryTimeoutActive: record.retryTimeout !== null &&
        record.retryTimeout !== undefined,
      retryTimeout: observedObjectId(record.retryTimeout),
    };
    const originalSet = Map.prototype.set;
    const originalValues = Map.prototype.values;
    Map.prototype.set = function observedDeletionRecordStore(key, value) {
      const record = producerRecord(value);
      const identity = recordIdentity(value);
      const owner = record && (record.owner ||
        (record.delivery && record.delivery.owner));
      const ownerKey = expectedOwnerKey(owner);
      if (identity && Number.isSafeInteger(identity.eventId) && ownerKey) {
        // deletionDeliveries uses an owner/document key, never eventId. Keep
        // the actual map and key produced with this complete delivery identity.
        recordWrites.push({
          map: this,
          key,
          value,
          identity,
          ownerKeyed:
            key === ownerKey &&
            record.key === ownerKey &&
            ownerIsComplete(owner),
          },
        );
      }
      return originalSet.call(this, key, value);
    };
    const currentRecordsForEvent = (identity) => {
      if (!identity || !Number.isSafeInteger(identity.eventId)) return [];
      return recordWrites.filter((candidate) =>
        candidate.map.get(candidate.key) === candidate.value &&
        candidate.ownerKeyed === true &&
        candidate.map.has(candidate.key) &&
        recordIdentity(candidate.value).eventId === identity.eventId,
      );
    };
    const sameAttemptState = (left, right) => !!(
      left && right &&
      left.recordKey === right.recordKey &&
      left.recordObjectId === right.recordObjectId &&
      left.deliveryIdentity === right.deliveryIdentity &&
      left.attempt === right.attempt &&
      left.inFlight === right.inFlight &&
      left.hasBooleanInFlight === right.hasBooleanInFlight &&
      left.hasAckTimeout === right.hasAckTimeout &&
      left.ackTimeoutActive === right.ackTimeoutActive &&
      left.ackTimeout === right.ackTimeout &&
      left.hasRetryTimeout === right.hasRetryTimeout &&
      left.retryTimeoutActive === right.retryTimeoutActive &&
      left.retryTimeout === right.retryTimeout
    );
    restoreMainDeletionAckConstruction = () => {
      Map.prototype.set = originalSet;
      Map.prototype.values = originalValues;
    };
    const originalEmit = ipcMain.emit;
    const restoreEmit = replaceMethod(
      ipcMain,
      "emit",
      function observedDeletionAcknowledgement(channelName, ...args) {
        if (
          (channelName === "start-file-watching" ||
            channelName === "set-active-file") &&
          args[1] &&
          args[1].owner
        ) {
          watchedOwner = snapshotOwner(args[1].owner);
        }
        if (channelName !== channel) {
          return originalEmit.call(this, channelName, ...args);
        }
        const payload = args[1];
        const identity = normaliseAcknowledgement(payload);
        const listenersBefore = ipcMain.rawListeners(channel);
        const deletionRecords = recordWrites.filter((candidate) =>
          candidate.map.get(candidate.key) === candidate.value &&
          sameIdentity(recordIdentity(candidate.value), identity) &&
          candidate.ownerKeyed === true &&
          candidate.map.has(candidate.key),
        );
        const candidateRecords = currentRecordsForEvent(identity);
        const deletionRecord =
          deletionRecords.length > 0 &&
          deletionRecords.every(
            (candidate) => candidate.value === deletionRecords[0].value,
          )
            ? deletionRecords[0]
            : null;
        const candidateRecord =
          candidateRecords.length > 0 &&
          candidateRecords.every(
            (candidate) => candidate.value === candidateRecords[0].value,
          )
            ? candidateRecords[0]
            : null;
        // A forged acknowledgement intentionally cannot identify the record
        // by its full identity. Still observe the one real event-id record so
        // rejection proves its live attempt and retry state stayed unchanged.
        const observedRecord = deletionRecord || candidateRecord;
        const observedIdentity = observedRecord
          ? recordIdentity(observedRecord.value)
          : null;
        const observedOwner = observedRecord &&
          (producerRecord(observedRecord.value).owner ||
            (producerRecord(observedRecord.value).delivery &&
              producerRecord(observedRecord.value).delivery.owner));
        const watchedOwnerBefore = snapshotOwner(watchedOwner);
        const attemptBefore = observedRecord
          ? attemptState(producerRecord(observedRecord.value))
          : null;
        let attemptAfter = null;
        const record = {
          identity,
          reachedMain: true,
          productionListenerRegistered: listenersBefore[productionListenerIndex] ===
            productionListener,
          listenerSequenceBefore: sameListenerSequence(listenersBefore, listeners),
          productionListenerIsOnce,
          deletionRecordFound: !!deletionRecord,
          ownerKeyedRecord: !!(deletionRecord && deletionRecord.ownerKeyed),
          candidateRecordFound: !!candidateRecord,
          identityMatchesCurrentRecord: !!deletionRecord,
          owner: snapshotOwner(observedOwner),
          watchedOwner: watchedOwnerBefore,
          watchedOwnerMatchesRecord: sameObservedDocumentOwner(
            observedOwner,
            watchedOwnerBefore,
          ),
          watchedOwnerIsDistinctTab: !!(
            observedOwner &&
            watchedOwnerBefore &&
            observedOwner.tabId !== watchedOwnerBefore.tabId
          ),
          attemptBefore,
          attemptAfter: null,
          attemptStateUnchanged: false,
          recordFingerprintUnchanged: false,
          attemptRetired: false,
          recordRetired: false,
          recordParked: false,
          retryScheduled: false,
          matchingDeliveryRecordRemains: false,
          retiredMaps: [],
          deliveryMap: null,
          deliveryMaps: [],
          tombstoneRetained: false,
        };
        const originalDelete = Map.prototype.delete;
        Map.prototype.delete = function observedDeletionRecordRetirement(key) {
          const deleted = originalDelete.call(this, key);
          if (deleted && observedRecord) {
            if (this === record.deliveryMap && key === observedRecord.key) {
              record.recordRetired = true;
              record.retiredMaps.push(this);
            }
          }
          return deleted;
        };
        Map.prototype.values = function observedDeletionDeliveryLookup(...args) {
          if (
            observedRecord &&
            /\bfindDeletionDeliveryById\b/.test(new Error().stack || "") &&
            !record.deliveryMaps.includes(this) &&
            candidateRecords.some((candidate) =>
              candidate.map === this &&
              Array.from(originalValues.call(this)).includes(candidate.value))
          ) {
            // findDeletionDeliveryById() is the production lookup boundary.
            // Only the Map it traverses is the delivery registry; the
            // tombstone map holds the same record but is not this contract.
            record.deliveryMaps.push(this);
            record.deliveryMap = this;
          }
          return originalValues.apply(this, args);
        };
        try {
          return originalEmit.call(this, channelName, ...args);
        } finally {
          Map.prototype.delete = originalDelete;
          Map.prototype.values = originalValues;
          if (observedRecord) {
            attemptAfter = attemptState(producerRecord(observedRecord.value));
            record.attemptAfter = attemptAfter;
            record.attemptStateUnchanged = sameAttemptState(
              attemptBefore,
              attemptAfter,
            );
            record.recordFingerprintUnchanged = record.attemptStateUnchanged;
            record.attemptRetired = !!(
              deletionRecord &&
              attemptBefore &&
              attemptBefore.attempt === identity.attempt &&
              attemptBefore.hasBooleanInFlight === true &&
              attemptBefore.inFlight === true &&
              attemptBefore.ackTimeoutActive === true &&
              attemptAfter.attempt === identity.attempt &&
              attemptAfter.hasBooleanInFlight === true &&
              attemptAfter.inFlight === false &&
              attemptAfter.ackTimeoutActive === false
            );
            const deliveryMaps = record.deliveryMap ? [record.deliveryMap] : [];
            record.recordParked = producerRecord(observedRecord.value).parked === true;
            record.retryScheduled =
              attemptAfter.retryTimeoutActive === true;
            record.matchingDeliveryRecordRemains = deliveryMaps.some((map) =>
              Array.from(map.values()).some((value) =>
                sameIdentity(recordIdentity(value), observedIdentity)));
            // A tombstone retaining the same consumed delivery is a distinct
            // map from deletionDeliveries and must not mask its retirement.
            record.tombstoneRetained = candidateRecords.some(
              (candidate) =>
                candidate.map !== record.deliveryMap &&
                candidate.map.get(candidate.key) === candidate.value &&
                sameIdentity(recordIdentity(candidate.value), observedIdentity),
            );
          }
          const listenersAfter = ipcMain.rawListeners(channel);
          record.listenerSequenceAfter = productionListenerIsOnce
            ? sameListenerSequence(
                listenersAfter,
                listeners.filter((listener) => listener !== productionListener),
              )
            : sameListenerSequence(listenersAfter, listeners);
          record.accepted = record.productionListenerRegistered &&
            record.listenerSequenceBefore &&
            record.listenerSequenceAfter &&
            record.deletionRecordFound &&
            record.ownerKeyedRecord &&
            (terminalAcknowledgement(identity)
              ? record.attemptRetired === true &&
                record.deliveryMaps.length === 1 &&
                record.recordRetired === true &&
                record.recordParked === false &&
                attemptAfter.hasRetryTimeout === true &&
                record.retryScheduled === false &&
                record.matchingDeliveryRecordRemains === false
              : retryableDeletionRefusal(identity) &&
                record.attemptRetired === true &&
                record.deliveryMaps.length === 1 &&
                record.recordRetired === false &&
                (identity.why === "frozen"
                  ? record.recordParked === true &&
                    record.retryScheduled === false
                  : record.recordParked === false &&
                    (record.watchedOwnerMatchesRecord === true
                      ? record.retryScheduled === true
                      : identity.why === "owner-inactive" &&
                        record.watchedOwnerIsDistinctTab === true &&
                        record.retryScheduled === false)) &&
                record.matchingDeliveryRecordRemains === true);
          records.push(record);
        }
      },
    );
    restoreMainDeletionAckConstruction = () => {
      restoreEmit();
      Map.prototype.set = originalSet;
      Map.prototype.values = originalValues;
    };
    return {
      acceptedAndRetired(identity) {
        return records.some((record) =>
          sameAcknowledgement(record.identity, identity) &&
          record.reachedMain === true &&
          record.accepted === true &&
          (terminalAcknowledgement(identity)
            ? record.attemptRetired === true &&
              record.deliveryMaps.length === 1 &&
              record.recordRetired === true &&
              record.recordParked === false &&
              record.retryScheduled === false &&
              record.matchingDeliveryRecordRemains === false
            : retryableDeletionRefusal(identity) &&
              record.attemptRetired === true &&
              record.deliveryMaps.length === 1 &&
              record.recordRetired === false &&
              (identity.why === "frozen"
                ? record.recordParked === true &&
                  record.retryScheduled === false
                : record.recordParked === false &&
                  (record.watchedOwnerMatchesRecord === true
                    ? record.retryScheduled === true
                    : identity.why === "owner-inactive" &&
                      record.watchedOwnerIsDistinctTab === true &&
                      record.retryScheduled === false)) &&
              record.matchingDeliveryRecordRemains === true),
        );
      },
      count(identity) {
        return records.filter((record) => sameAcknowledgement(record.identity, identity))
          .length;
      },
      rejectedAndUnchanged(identity) {
        return records.some((record) =>
          sameAcknowledgement(record.identity, identity) &&
          record.reachedMain === true &&
          record.productionListenerRegistered === true &&
          record.listenerSequenceBefore === true &&
          record.listenerSequenceAfter === true &&
          record.candidateRecordFound === true &&
          record.identityMatchesCurrentRecord === false &&
          record.attemptBefore &&
          record.attemptBefore.inFlight === true &&
          record.attemptBefore.ackTimeoutActive === true &&
          record.attemptBefore.retryTimeoutActive === false &&
          record.attemptStateUnchanged === true &&
          record.recordFingerprintUnchanged === true &&
          record.recordRetired === false &&
          record.recordParked === false &&
          record.retryScheduled === false &&
          record.matchingDeliveryRecordRemains === true,
        );
      },
      recordSnapshot(identity) {
        const candidates = currentRecordsForEvent(identity);
        return {
          count: candidates.length,
          records: candidates.map((candidate) => ({
            identity: recordIdentity(candidate.value),
            ownerKeyed: candidate.ownerKeyed === true,
            attempt: attemptState(producerRecord(candidate.value)),
          })),
        };
      },
      observation(identity) {
        return records.findLast((record) =>
          sameAcknowledgement(record.identity, identity),
        ) || null;
      },
      listenerSequenceIntact() {
        const current = ipcMain.rawListeners(channel);
        return productionListenerIsOnce
          ? sameListenerSequence(
              current,
              listeners.filter((listener) => listener !== productionListener),
            )
          : sameListenerSequence(current, listeners);
      },
      restore() {
        restoreMainDeletionAckConstruction();
      },
    };
    })(),
  );

  // Capture real main-process deliveries and ACKs. The test never manufactures
  // delivery IDs, owners or watcher generations: each comes from wc.send after
  // the actual watcher detected a filesystem deletion.
  await exec(`
    (() => {
      const ipc = require("electron").ipcRenderer;
      if (window.__f22DeletionProtocolProbe) return null;
      const originalSend = ipc.send;
      const send = originalSend.bind(ipc);
      const probe = window.__f22DeletionProtocolProbe = {
        selections: [], deliveries: [], deletionEvents: [], acknowledgements: [],
        attemptedAcknowledgements: [], droppedAcknowledgements: [],
        forwardedAcknowledgements: [], dropAcknowledgements: false,
        originalSend,
        restored: false,
      };
      const deletionProtocolSend = (channel, ...args) => {
        const payload = args[0];
        if ((channel === "start-file-watching" || channel === "set-active-file") &&
            payload && payload.owner) {
          probe.selections.push({ channel, filePath: payload.filePath, owner: payload.owner });
        }
        if (channel === "file-deleted-ack") {
          probe.attemptedAcknowledgements.push(payload);
          if (probe.dropAcknowledgements) {
            probe.droppedAcknowledgements.push(payload);
            return undefined;
          }
          // This call is the real ipcRenderer transport; entries here, unlike
          // attempts, have crossed the renderer-to-main boundary.
          const result = send(channel, ...args);
          probe.forwardedAcknowledgements.push(payload);
          probe.acknowledgements.push(payload);
          return result;
        }
        return send(channel, ...args);
      };
      probe.wrapper = deletionProtocolSend;
      ipc.send = deletionProtocolSend;
      const onDeletion = (event, payload) => {
        probe.deletionEvents.push(event);
        probe.deliveries.push(payload);
      };
      probe.restore = () => {
        if (probe.restored) return false;
        probe.restored = true;
        if (ipc.send === deletionProtocolSend) ipc.send = originalSend;
        ipc.removeListener("file-deleted", onDeletion);
        return true;
      };
      ipc.on("file-deleted", onDeletion);
      return null;
    })()
  `);
  const deletedBFile = path.join(dir, "f22-deleted-owner-b.md");
  fs.writeFileSync(deletedBFile, "F22_DELETED_B_BASE\r\n", "utf8");
  const deletedMessages = () => exec(
    `window.__f22DeletionMessages.filter(message => /deleted from disk/i.test(message)).length`,
  );
  const deletionDeliveryIdentity = (delivery) => {
    const attempt = delivery && (
      delivery.attempt ?? delivery.deliveryAttempt ?? delivery.attemptId
    );
    const owner = delivery && (delivery.owner || delivery);
    return delivery && {
      eventId: delivery.eventId,
      selectionGeneration: delivery.selectionGeneration,
      watcherGeneration: delivery.watcherGeneration,
      attempt,
      pageSession: delivery.pageSession ?? (owner && owner.pageSession),
      rendererGeneration:
        delivery.rendererGeneration ?? (owner && owner.rendererGeneration),
      tabId: owner && owner.tabId,
      documentGeneration: owner && owner.documentGeneration,
      pathKey: owner && owner.pathKey,
      complete: Number.isSafeInteger(delivery.eventId) &&
        delivery.eventId > 0 &&
        Number.isSafeInteger(delivery.selectionGeneration) &&
        delivery.selectionGeneration > 0 &&
        Number.isSafeInteger(delivery.watcherGeneration) &&
        delivery.watcherGeneration > 0 &&
        Number.isSafeInteger(attempt) &&
        attempt > 0 &&
        typeof (delivery.pageSession ?? (owner && owner.pageSession)) === "string" &&
        (delivery.pageSession ?? (owner && owner.pageSession)).length > 0 &&
        Number.isSafeInteger(
          delivery.rendererGeneration ?? (owner && owner.rendererGeneration),
        ) &&
        (delivery.rendererGeneration ?? (owner && owner.rendererGeneration)) > 0 &&
        Number.isSafeInteger(owner && owner.tabId) &&
        owner.tabId > 0 &&
        Number.isSafeInteger(owner && owner.documentGeneration) &&
        owner.documentGeneration > 0 &&
        typeof (owner && owner.pathKey) === "string" &&
        owner.pathKey.length > 0,
    };
  };
  const deletionAckIdentity = (acknowledgement) => {
    const delivery = deletionDeliveryIdentity(acknowledgement);
    return delivery && {
      ...delivery,
      consumed: acknowledgement.consumed,
      why: acknowledgement.why,
      complete:
        delivery.complete === true &&
        typeof acknowledgement.consumed === "boolean" &&
        typeof acknowledgement.why === "string",
    };
  };
  const deletionIdentityDifferences = (left, right) => {
    const fields = [
      "pageSession",
      "rendererGeneration",
      "tabId",
      "documentGeneration",
      "pathKey",
      "selectionGeneration",
      "watcherGeneration",
      "attempt",
    ];
    return fields.filter((field) => left && right && left[field] !== right[field]);
  };
  const acknowledgementMatchesDelivery = (acknowledgement, delivery) => {
    const ack = deletionAckIdentity(acknowledgement);
    const produced = deletionDeliveryIdentity(delivery);
    return !!(
      ack && produced && ack.complete && produced.complete &&
      ack.eventId === produced.eventId &&
      ack.selectionGeneration === produced.selectionGeneration &&
      ack.watcherGeneration === produced.watcherGeneration &&
      ack.attempt === produced.attempt &&
      ack.pageSession === produced.pageSession &&
      ack.rendererGeneration === produced.rendererGeneration &&
      ack.tabId === produced.tabId &&
      ack.documentGeneration === produced.documentGeneration &&
      ack.pathKey === produced.pathKey
    );
  };
  const deletionIdentityKey = (identity) => identity && identity.complete &&
    JSON.stringify({
      eventId: identity.eventId,
      selectionGeneration: identity.selectionGeneration,
      watcherGeneration: identity.watcherGeneration,
      attempt: identity.attempt,
      pageSession: identity.pageSession,
      rendererGeneration: identity.rendererGeneration,
      tabId: identity.tabId,
      documentGeneration: identity.documentGeneration,
      pathKey: identity.pathKey,
    });
  const acknowledgementsMatchDeliveries = (acknowledgements, deliveries) =>
    Array.isArray(acknowledgements) &&
    Array.isArray(deliveries) &&
    acknowledgements.length === deliveries.length &&
    (() => {
      const deliveryCounts = new Map();
      for (const entry of deliveries) {
        const identity = deletionDeliveryIdentity(
          entry && (entry.delivery || entry),
        );
        if (!identity || !identity.complete) return false;
        const key = deletionIdentityKey(identity);
        deliveryCounts.set(key, (deliveryCounts.get(key) || 0) + 1);
      }
      for (const acknowledgement of acknowledgements) {
        const identity = deletionAckIdentity(acknowledgement);
        const key = deletionIdentityKey(identity);
        const count = key && deliveryCounts.get(key);
        if (!count) return false;
        if (count === 1) deliveryCounts.delete(key);
        else deliveryCounts.set(key, count - 1);
      }
      return deliveryCounts.size === 0;
    })();
  const terminalDeletionAcknowledgement = (identity) =>
    !!identity && (
      (identity.consumed === true &&
        ["consumed", "already-consumed"].includes(identity.why)) ||
      (identity.consumed === false && [
        "owner-closed",
        "replacement-owner",
        "foreign-session",
        "owner-path-moved",
      ].includes(identity.why))
    );
  const retryableDeletionAcknowledgement = (identity) =>
    !!identity && identity.consumed === false &&
    [
      "owner-inactive",
      "frozen",
      "stale-selection",
      "not-active",
    ].includes(identity.why);
  const terminalObservationSatisfiesContract = (observation) =>
    !!observation &&
    observation.attemptRetired === true &&
    observation.recordRetired === true &&
    observation.recordParked === false &&
    observation.matchingDeliveryRecordRemains === false;
  const retryableObservationSatisfiesContract = (observation) =>
    !!observation &&
    observation.attemptRetired === true &&
    observation.recordRetired === false &&
    observation.matchingDeliveryRecordRemains === true;
  const acknowledgementObservationSatisfiesContract = (identity, observation) =>
    terminalDeletionAcknowledgement(identity)
      ? terminalObservationSatisfiesContract(observation)
      : retryableDeletionAcknowledgement(identity) &&
        retryableObservationSatisfiesContract(observation) &&
        (identity.why === "frozen"
          ? observation.recordParked === true &&
            observation.retryScheduled === false
          : observation.recordParked === false &&
            (observation.watchedOwnerMatchesRecord === true
              ? observation.retryScheduled === true
              : identity.why === "owner-inactive" &&
                observation.watchedOwnerIsDistinctTab === true &&
                observation.retryScheduled === false));
  const waitForMainDeletionAcknowledgement = async (identity) => {
    if (!mainDeletionAckProbe) {
      return {
        identity,
        count: 0,
        acceptedAndRetired: false,
        mainObservation: {
          attemptRetired: false,
          recordRetired: false,
          recordParked: false,
          matchingDeliveryRecordRemains: false,
          tombstoneRetained: false,
        },
      };
    }
    const deadline = Date.now() + 5000;
    let count = 0;
    let acceptedAndRetired = false;
    let mainObservation = null;
    do {
      count = mainDeletionAckProbe.count(identity);
      mainObservation = mainDeletionAckProbe.observation(identity);
      acceptedAndRetired =
        mainDeletionAckProbe.acceptedAndRetired(identity) &&
        acknowledgementObservationSatisfiesContract(identity, mainObservation);
      if (acceptedAndRetired || Date.now() >= deadline) break;
      await sleep(25);
    } while (true);
    return {
      identity, count, acceptedAndRetired,
      mainObservation,
    };
  };
  const waitForDeletionAckQuiescence = async (start, filePath, identity) => {
    const counts = () => exec(`
      (() => {
        const probe = window.__f22DeletionProtocolProbe;
        const matching = probe.deliveries.slice(${start}).filter(entry =>
          entry && entry.path === ${JSON.stringify(filePath)} &&
          entry.delivery && entry.delivery.eventId === ${JSON.stringify(identity && identity.eventId)});
        return {
          deliveries: matching.length,
          attempted: probe.attemptedAcknowledgements.filter(ack =>
            ack && ack.eventId === ${JSON.stringify(identity && identity.eventId)}).length,
          forwarded: probe.forwardedAcknowledgements.filter(ack =>
            ack && ack.eventId === ${JSON.stringify(identity && identity.eventId)}).length,
        };
      })()
    `);
    const mainAcceptance = await waitForMainDeletionAcknowledgement(identity);
    if (!mainAcceptance.acceptedAndRetired) {
      return {
        identity, before: await counts(), mainAcknowledgementCount: mainAcceptance.count,
        acceptedAndRetired: false, mainProcessed: mainAcceptance.count > 0,
        mainObservation: mainAcceptance.mainObservation,
        retired: false,
      };
    }
    // Start the no-retry oracle only after main's exact production listener
    // accepted this exact acknowledgement and retired the relevant boundary.
    const acceptedMainObservation = mainAcceptance.mainObservation;
    const before = await counts();
    const deadline = Date.now() + 4250;
    while (Date.now() < deadline) {
      await sleep(50);
      if (JSON.stringify(await counts()) !== JSON.stringify(before)) {
        return {
          identity, before, mainAcknowledgementCount: mainAcceptance.count,
          acceptedAndRetired: mainAcceptance.acceptedAndRetired,
          mainProcessed: true, retired: false,
          mainObservation: acceptedMainObservation,
        };
      }
    }
    return {
      identity, before, mainAcknowledgementCount: mainAcceptance.count,
      acceptedAndRetired: mainAcceptance.acceptedAndRetired,
      mainProcessed: true, retired: true,
      mainObservation: acceptedMainObservation,
    };
  };
  const deletionTabSnapshot = (tabId) => exec(`
    (() => {
      const tab = window.CustomTabs.getTabs().find(t => t.id === ${'${tabId}'});
      const state = tab && window.CustomTabs.__documentState(tab);
      return tab ? {
        id: tab.id, active: (window.CustomTabs.getActiveTab() || {}).id,
        content: tab.content, originalContent: tab.originalContent,
        live: window.originalMarkdown, dirty: tab.hasUnsavedChanges,
        reloadConflict: !!(state && state.reloadConflict),
        deletionTombstone: !!(state && state.deletionTombstone),
        deletionEventId: state ? state.deletionEventId : null,
        reloadDiagnostics: typeof window.getReloadRequestDiagnostics === "function"
          ? window.getReloadRequestDiagnostics()
          : null,
      } : null;
    })()
  `.replace("${tabId}", String(tabId)));
  const saveWithAlertGuard = (filePath) => exec(`
    (async () => {
      const filePath = ${JSON.stringify(filePath)};
      const ipc = require("electron").ipcRenderer;
      const oldAlert = window.alert; const alerts = [];
      let timer = null; let onResult = null;
      try {
        window.alert = message => alerts.push(String(message));
        return await new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true, filePath, alerts }), 5000);
          onResult = (_event, result) => {
            if (!result || result.path !== filePath) return;
            resolve({ timedOut: false, filePath, result, alerts });
          };
          ipc.on("save-markdown-result", onResult);
          document.getElementById("saveButton").click();
        });
      } catch (error) {
        return { error: String(error && error.stack ? error.stack : error), filePath, alerts };
      }
      finally {
        if (timer) clearTimeout(timer);
        if (onResult) ipc.removeListener("save-markdown-result", onResult);
        window.alert = oldAlert;
      }
    })()
  `.replace("${filePath}", filePath));
  const deletionProbe = await exec(`
    (() => {
      const message = document.getElementById("notificationMessage");
      window.__f22DeletionMessages = [];
      window.__f22DeletionObserver && window.__f22DeletionObserver.disconnect();
      window.__f22DeletionObserver = new MutationObserver(() =>
        window.__f22DeletionMessages.push(message ? message.textContent : ""));
      if (message) window.__f22DeletionObserver.observe(message, {
        childList: true, characterData: true, subtree: true,
      });
      return !!message;
    })()
  `);
  const realDeletionFor = (start, filePath) => exec(`
    (() => {
      const expectedPath = ${JSON.stringify(filePath)};
      const entry = window.__f22DeletionProtocolProbe.deliveries.slice(${start})
        .find(candidate => candidate && candidate.path === expectedPath);
      return entry ? { ...entry, matchedPath: expectedPath } : null;
    })()
  `);

  // Active-owner consumption establishes the real tombstone used by the save
  // and explicit-reload checks below.
  const deletedAFile = path.join(dir, "f22-deleted-owner-a.md");
  fs.writeFileSync(deletedAFile, "F22_DELETED_A_BASE\r\n", "utf8");
  await clearTabs();
  const deletedA = await createActiveTab(deletedAFile, "F22_DELETED_A_BASE\r\n");
  const deletedAWatcherAtStart = watcherProbe.snapshot();
  const deletedAOwner = await exec(`window.__f22DeletionProtocolProbe.selections
    .filter(entry => entry.filePath === ${JSON.stringify(deletedAFile)} && entry.owner && entry.owner.tabId === ${deletedA.id})
    .at(-1)?.owner || null`);
  const deletionDeliveryStart = await exec(`window.__f22DeletionProtocolProbe.deliveries.length`);
  const deletionMessageStart = await deletedMessages();
  fs.unlinkSync(deletedAFile);
  const deletedAProduced = await waitForCondition(exec, `!!(window.__f22DeletionProtocolProbe.deliveries
    .slice(${deletionDeliveryStart}).find(entry => entry && entry.path === ${JSON.stringify(deletedAFile)} && entry.delivery))`, 5000);
  const deletedAEvent = await realDeletionFor(deletionDeliveryStart, deletedAFile);
  const deletionAAfterReplay = await deletionTabSnapshot(deletedA.id);
  const deletionMessagesAfterA = await deletedMessages();
  const deletedAProtocol = await exec(`
    (() => {
      const probe = window.__f22DeletionProtocolProbe;
      const eventId = ${'${eventId}'};
      return {
        deliveries: probe.deliveries.filter(entry => entry && entry.delivery && entry.delivery.eventId === eventId),
        attempted: probe.attemptedAcknowledgements.filter(ack => ack && ack.eventId === eventId),
        forwarded: probe.forwardedAcknowledgements.filter(ack => ack && ack.eventId === eventId),
      };
    })()
  `.replace("${eventId}", String(deletedAEvent && deletedAEvent.delivery && deletedAEvent.delivery.eventId)));
  const activeAckQuiescence = await waitForDeletionAckQuiescence(
    deletionDeliveryStart,
    deletedAFile,
    deletionAckIdentity(deletedAProtocol.forwarded[0]),
  );
  const deletedADeletionProducerRetained = await waitUntil(
    () => {
      const snapshot = watcherProbe.snapshot();
      return snapshot.live.length === 1 && snapshot.live[0].kind === "poll";
    },
    5000,
  );
  const deletedAWatcherAfterDeletion = watcherProbe.snapshot();
  // Recreate and round-trip before attempting a Save.  That isolates the
  // tombstone's cache semantics from any dirty/conflict outcome of a refused
  // save, and proves path recreation cannot silently adopt external bytes.
  const deletedAWasMissingBeforeRecreation = !fs.existsSync(deletedAFile);
  fs.writeFileSync(deletedAFile, "F22_DELETED_A_EXTERNAL_REPLACEMENT\r\n", "utf8");
  const deletedAWatcherRearmed = await waitUntil(
    () => watcherProbe.snapshot().live.some(
      (entry) => entry.kind === "fs.watch" && entry.filePath === deletedAFile &&
        entry.id !== (deletedAWatcherAtStart.live[0] &&
          deletedAWatcherAtStart.live[0].id),
    ),
    5000,
  );
  const deletionRoundTrip = await exec(`
    (() => {
      const other = window.CustomTabs.createTab(
        ${JSON.stringify(deletedBFile)},
        "F22_DELETED_B_BASE\\r\\n",
        { activate: false },
      );
      window.CustomTabs.switchToTab(other.id);
      window.CustomTabs.switchToTab(${deletedA.id});
      return { otherId: other.id, active: (window.CustomTabs.getActiveTab() || {}).id };
    })()
  `);
  const deletionAAfterRecreatedRoundTrip = await deletionTabSnapshot(deletedA.id);
  const deletedAWatcherAfterRoundTrip = watcherProbe.snapshot();
  // A tombstone guard must still refuse after an external recreation.  The
  // saved path was proven missing immediately before recreation; this
  // assertion then proves refusal leaves the replacement bytes unchanged.
  const deletionSave = await saveWithAlertGuard(deletedAFile);
  const deletionAAfterSave = await deletionTabSnapshot(deletedA.id);
  const replacementBytesAfterSave = fs.readFileSync(deletedAFile, "utf8");
  const replacementConflictAfterSave = await deletionTabSnapshot(deletedA.id);
  const replacementSave = deletionSave;
  await exec(`window.reloadCurrentFile(); null;`);
  const explicitReplacementAdopted = await waitForCondition(
    exec, `window.originalMarkdown === "F22_DELETED_A_EXTERNAL_REPLACEMENT\\r\\n"`, 5000,
  );
  const replacementAfterExplicitAdoption = await deletionTabSnapshot(deletedA.id);

  // Hold exactly one genuine producer envelope, close its owner, then release
  // it. This tests owner-closed ACK acceptance without activating a watcher for
  // a missing path after the tab has gone.
  const closedDeletedFile = path.join(dir, "f22-deleted-closed-a.md");
  fs.writeFileSync(closedDeletedFile, "F22_DELETED_CLOSED\r\n", "utf8");
  await clearTabs();
  const closedDeletedA = await createActiveTab(closedDeletedFile, "F22_DELETED_CLOSED\r\n");
  const closedDeletedB = await exec(`window.CustomTabs.createTab(${JSON.stringify(deletedBFile)}, "F22_DELETED_B_BASE\\r\\n", { activate: false })`);
  const heldClosedDeliveries = [];
  const realClosedSend = wc.send;
  const restoreClosedSend = replaceMethod(wc, "send", function(channel, ...args) {
    if (channel === "file-deleted" && args[0] && args[0].path === closedDeletedFile) {
      heldClosedDeliveries.push(args[0]); return undefined;
    }
    return realClosedSend.call(this, channel, ...args);
  });
  let closedEnvelopeHeld = false;
  try {
    fs.unlinkSync(closedDeletedFile);
    closedEnvelopeHeld = await waitUntil(() => heldClosedDeliveries.length === 1, 5000);
  } finally { restoreClosedSend(); }
  await exec(`window.CustomTabs.switchToTab(${closedDeletedB.id}); null;`);
  await exec(`window.CustomTabs.closeTab(${closedDeletedA.id}); null;`);
  const closedDeletedGone = await exec(`!window.CustomTabs.getTabs().some(tab => tab.id === ${closedDeletedA.id})`);
  const closedBeforeMessages = await deletedMessages();
  if (heldClosedDeliveries[0]) realClosedSend.call(wc, "file-deleted", heldClosedDeliveries[0]);
  const closedDelivered = await waitForCondition(exec, `window.__f22DeletionProtocolProbe.deliveries.some(entry => entry && entry.path === ${JSON.stringify(closedDeletedFile)})`, 5000);
  const closedAfterMessages = await deletedMessages();
  const closedDeletedEvent = heldClosedDeliveries[0] || null;
  const closedAcknowledgement = await exec(`window.__f22DeletionProtocolProbe.forwardedAcknowledgements
    .find(ack => ack && ack.eventId === ${'${eventId}'}) || null`
    .replace("${eventId}", String(closedDeletedEvent && closedDeletedEvent.delivery && closedDeletedEvent.delivery.eventId)));
  const closedAckQuiescence = await waitForDeletionAckQuiescence(
    0,
    closedDeletedFile,
    deletionAckIdentity(closedAcknowledgement),
  );

  // Keep the owning tab open and active, but explicitly adopt the recreated
  // file before releasing its held old-generation envelope. This reaches the
  // renderer's replacement-owner branch (same tab ID, new generation), while
  // the preceding closed-owner scenario retains that distinct terminal reason.
  const replacementDeletedFile = path.join(dir, "f22-deleted-replacement-a.md");
  fs.writeFileSync(replacementDeletedFile, "F22_DELETED_REPLACEMENT_OLD\r\n", "utf8");
  await clearTabs();
  const replacementDeletedA = await createActiveTab(replacementDeletedFile, "F22_DELETED_REPLACEMENT_OLD\r\n");
  const heldReplacementDeliveries = [];
  const realReplacementSend = wc.send;
  const restoreReplacementSend = replaceMethod(wc, "send", function(channel, ...args) {
    if (channel === "file-deleted" && args[0] && args[0].path === replacementDeletedFile) {
      heldReplacementDeliveries.push(args[0]); return undefined;
    }
    return realReplacementSend.call(this, channel, ...args);
  });
  let replacementEnvelopeHeld = false;
  try {
    fs.unlinkSync(replacementDeletedFile);
    replacementEnvelopeHeld = await waitUntil(() => heldReplacementDeliveries.length === 1, 5000);
  } finally { restoreReplacementSend(); }
  fs.writeFileSync(replacementDeletedFile, "F22_DELETED_REPLACEMENT_NEW\r\n", "utf8");
  // Let the renderer complete its real reload/adoption and advance its tab
  // generation, but hold only the renderer-to-main adoption envelope. Sending
  // that envelope would release the held delivery before its old generation
  // reaches classifyDeletionDelivery(), making replacement-owner untestable.
  await exec(`
    (() => {
      const ipc = require("electron").ipcRenderer;
      const originalSend = ipc.send;
      const probe = window.__f22ReplacementAdoptionProbe = {
        held: [],
        enabled: true,
        restored: false,
        originalSend,
      };
      const replacementAdoptionSend = function(channel, ...args) {
        const payload = args[0];
        if (
          probe.enabled &&
          (channel === "start-file-watching" || channel === "set-active-file") &&
          payload && payload.adoptDeletion === true
        ) {
          probe.held.push({ channel, payload });
          return undefined;
        }
        return originalSend.call(this, channel, ...args);
      };
      probe.wrapper = replacementAdoptionSend;
      ipc.send = replacementAdoptionSend;
      probe.restore = () => {
        if (probe.restored) return false;
        probe.restored = true;
        probe.enabled = false;
        if (ipc.send === replacementAdoptionSend) ipc.send = originalSend;
        return true;
      };
      return null;
    })()
  `);
  let replacementReloaded = false;
  let replacementCurrentOwner = null;
  let replacementAdoption = null;
  try {
    await exec(`window.reloadCurrentFile(); null;`);
    replacementReloaded = await waitForCondition(
      exec,
      `window.originalMarkdown === "F22_DELETED_REPLACEMENT_NEW\\r\\n"`,
      5000,
    );
    replacementCurrentOwner = await exec(
      `window.CustomTabs.getActiveDocumentIdentity(
        ${JSON.stringify(replacementDeletedFile)},
        window.getReloadRequestSession(),
      )`,
    );
  } finally {
    replacementAdoption = await exec(`
      (() => {
        const probe = window.__f22ReplacementAdoptionProbe;
        if (probe) probe.restore();
        return probe ? { held: probe.held.slice() } : null;
      })()
    `);
  }
  const replacementBefore = await deletionTabSnapshot(replacementDeletedA.id);
  const replacementBeforeMessages = await deletedMessages();
  if (heldReplacementDeliveries[0]) realReplacementSend.call(wc, "file-deleted", heldReplacementDeliveries[0]);
  const replacementDelivered = await waitForCondition(exec, `window.__f22DeletionProtocolProbe.deliveries.some(entry => entry && entry.path === ${JSON.stringify(replacementDeletedFile)} && entry.delivery)`, 5000);
  const replacementAfterStaleDelivery = await deletionTabSnapshot(replacementDeletedA.id);
  const replacementAfterStaleMessages = await deletedMessages();
  const replacementAfter = await deletionTabSnapshot(replacementDeletedA.id);
  const replacementAfterMessages = await deletedMessages();
  const replacementDeletedEvent = heldReplacementDeliveries[0] || null;
  const replacementAcknowledgement = await exec(`window.__f22DeletionProtocolProbe.forwardedAcknowledgements
    .find(ack => ack && ack.eventId === ${'${eventId}'}) || null`
    .replace("${eventId}", String(replacementDeletedEvent && replacementDeletedEvent.delivery && replacementDeletedEvent.delivery.eventId)));
  const replacementAckQuiescence = await waitForDeletionAckQuiescence(
    0,
    replacementDeletedFile,
    deletionAckIdentity(replacementAcknowledgement),
  );

  // Exercise the actual renderer listener/classifier with controlled false
  // deliveries. These are classifier-only cases: their ACKs are deliberately
  // dropped before main so they cannot disturb the held real record below.
  const ownerPathMovedFile = path.join(dir, "f22-deleted-owner-path-moved.md");
  fs.writeFileSync(ownerPathMovedFile, "F22_OWNER_PATH_MOVED\r\n", "utf8");
  await clearTabs();
  const ownerPathMovedTab = await createActiveTab(
    ownerPathMovedFile,
    "F22_OWNER_PATH_MOVED\r\n",
  );
  const ownerPathMovedDeliveryStart = await exec(
    `window.__f22DeletionProtocolProbe.deliveries.length`,
  );
  const heldOwnerPathMovedDeliveries = [];
  const realOwnerPathMovedSend = wc.send;
  const restoreOwnerPathMovedSend = replaceMethod(
    wc,
    "send",
    function (channel, ...args) {
      if (
        channel === "file-deleted" &&
        args[0] &&
        args[0].path === ownerPathMovedFile
      ) {
        heldOwnerPathMovedDeliveries.push(args[0]);
        return undefined;
      }
      return realOwnerPathMovedSend.call(this, channel, ...args);
    },
  );
  let ownerPathMovedEnvelopeHeld = false;
  try {
    fs.unlinkSync(ownerPathMovedFile);
    ownerPathMovedEnvelopeHeld = await waitUntil(
      () => heldOwnerPathMovedDeliveries.length === 1,
      5000,
    );
  } finally {
    restoreOwnerPathMovedSend();
  }
  const ownerPathMovedHeldIdentity = deletionDeliveryIdentity(
    heldOwnerPathMovedDeliveries[0] && heldOwnerPathMovedDeliveries[0].delivery,
  );
  // `unusable-path` is a dead defensive renderer branch outside this
  // harness's valid-envelope contract: main supplies validated file paths and
  // the renderer rejects empty/NUL input before canonical reload handling.
  const classifierReasonEvidence = await exec(`
    (() => {
      const ipc = require("electron").ipcRenderer;
      const protocol = window.__f22DeletionProtocolProbe;
      const raw = typeof ipc.rawListeners === "function"
        ? ipc.rawListeners("file-deleted")
        : [];
      const registration = raw.find((candidate) => {
        const source = Function.prototype.toString.call(
          candidate.listener || candidate,
        );
        return /\\bclassifyDeletionDelivery\\b/.test(source) &&
          /\\backnowledgeDeletionDelivery\\b/.test(source);
      }) || null;
      const listener = registration && (registration.listener || registration);
      const tabs = window.CustomTabs;
      const originalIdentity = tabs && tabs.getActiveDocumentIdentity;
      const originalCurrentFilePath = window.currentFilePath;
      const owner = ${JSON.stringify(
        heldOwnerPathMovedDeliveries[0] &&
          heldOwnerPathMovedDeliveries[0].delivery &&
          heldOwnerPathMovedDeliveries[0].delivery.owner,
      )};
      const ownerTab = tabs && owner &&
        typeof tabs.getTabs === "function"
        ? tabs.getTabs().find((tab) => tab.id === owner.tabId) || null
        : null;
      const fire = (name, configure) => {
        if (!listener || !protocol) {
          return {
            name, listener: false, acknowledgementCount: 0,
            acknowledgements: [], acknowledgement: null,
          };
        }
        const payload = JSON.parse(${JSON.stringify(JSON.stringify(
          heldOwnerPathMovedDeliveries[0] || null,
        ))});
        if (!payload || !payload.delivery) {
          return {
            name, listener: true, acknowledgementCount: 0,
            acknowledgements: [], acknowledgement: null,
          };
        }
        const before = protocol.attemptedAcknowledgements.length;
        const event = protocol.deletionEvents.at(-1) || null;
        if (!event) {
          return {
            name, listener: true, realEvent: false, acknowledgementCount: 0,
            acknowledgements: [], acknowledgement: null,
          };
        }
        let cleanup = null;
        let configuration = null;
        try {
          configuration = configure
            ? configure({
              payload, tabs, ownerTab, originalIdentity, originalCurrentFilePath,
            })
            : null;
          cleanup = configuration && configuration.cleanup;
          const { cleanup: _cleanup, ...evidence } = configuration || {};
          protocol.dropAcknowledgements = true;
          // Invoke only the selected production classifier. Emitting would
          // invoke every listener, allowing an unrelated ACK to satisfy this
          // classifier-only assertion.
          listener.call(ipc, event, payload);
          const acknowledgements =
            protocol.attemptedAcknowledgements.slice(before);
          return {
            name,
            listener: true,
            realEvent: true,
            ...evidence,
            acknowledgementCount: acknowledgements.length,
            acknowledgements,
            acknowledgement:
              acknowledgements.length === 1 ? acknowledgements[0] : null,
          };
        } finally {
          protocol.dropAcknowledgements = false;
          if (typeof cleanup === "function") cleanup();
        }
      };
      const results = [
        fire("foreign-session", ({ payload }) => {
          const value = String(
            payload.delivery.pageSession ||
            (payload.delivery.owner && payload.delivery.owner.pageSession) ||
            "fixture",
          ) + "-foreign";
          payload.delivery.pageSession = value;
          if (payload.delivery.owner) payload.delivery.owner.pageSession = value;
          return { mutation: "delivery.pageSession" };
        }),
        fire("owner-path-moved", ({ ownerTab }) => {
          if (!ownerTab) return { mutation: "owner-tab-unavailable" };
          const originalFilePath = ownerTab.filePath;
          const movedFilePath = String(originalFilePath) + ".owner-path-moved";
          ownerTab.filePath = movedFilePath;
          return {
            mutation: "ownerTab.filePath",
            ownerPathBefore: originalFilePath,
            ownerPathDuringDelivery: movedFilePath,
            cleanup: () => {
              if (ownerTab.filePath === movedFilePath) {
                ownerTab.filePath = originalFilePath;
              }
            },
          };
        }),
        fire("replacement-owner", ({ tabs, originalIdentity }) => {
          if (!tabs || typeof originalIdentity !== "function") {
            return { mutation: "active-identity-unavailable" };
          }
          const replacementIdentity = function(...args) {
            const identity = originalIdentity.apply(this, args);
            return identity && {
              ...identity,
              documentGeneration: identity.documentGeneration + 1,
            };
          };
          tabs.getActiveDocumentIdentity = replacementIdentity;
          return {
            mutation: "active-document-identity",
            identityHook: tabs.getActiveDocumentIdentity === replacementIdentity,
            cleanup: () => {
              if (tabs.getActiveDocumentIdentity === replacementIdentity) {
                tabs.getActiveDocumentIdentity = originalIdentity;
              }
            },
          };
        }),
        fire("not-active", ({ tabs, originalIdentity, originalCurrentFilePath }) => {
          if (!tabs || typeof originalIdentity !== "function") {
            return { mutation: "current-path-unavailable" };
          }
          const inactivePath = String(originalCurrentFilePath) + ".not-active";
          const activeIdentityForDifferentCurrentPath = function(...args) {
            return originalIdentity.call(
              this,
              originalCurrentFilePath,
              ...args.slice(1),
            );
          };
          window.currentFilePath = inactivePath;
          tabs.getActiveDocumentIdentity = activeIdentityForDifferentCurrentPath;
          return {
            mutation: "currentFilePath",
            currentPathBefore: originalCurrentFilePath,
            currentPathDuringDelivery: inactivePath,
            identityHook:
              tabs.getActiveDocumentIdentity === activeIdentityForDifferentCurrentPath,
            cleanup: () => {
              if (
                tabs.getActiveDocumentIdentity ===
                activeIdentityForDifferentCurrentPath
              ) {
                tabs.getActiveDocumentIdentity = originalIdentity;
              }
              if (window.currentFilePath === inactivePath) {
                window.currentFilePath = originalCurrentFilePath;
              }
            },
          };
        }),
      ];
      return results;
    })()
  `);
  const classifierReasonDetail = () => JSON.stringify({
    classifierReasonEvidence,
  });
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 selected production classifier exclusively acknowledges foreign-session, owner-path-moved, replacement-owner, and not-active", () =>
    ownerPathMovedEnvelopeHeld === true &&
      ownerPathMovedHeldIdentity &&
      ownerPathMovedHeldIdentity.complete === true &&
      Array.isArray(classifierReasonEvidence) &&
      classifierReasonEvidence.length === 4 &&
      classifierReasonEvidence.every((entry) =>
        entry.listener === true &&
        entry.realEvent === true &&
        entry.acknowledgementCount === 1 &&
        Array.isArray(entry.acknowledgements) &&
        entry.acknowledgements.length === 1 &&
        entry.acknowledgements[0] &&
        entry.acknowledgements[0].why === entry.name &&
        entry.acknowledgement &&
        entry.acknowledgement.consumed === false &&
        entry.acknowledgement.why === entry.name) &&
      classifierReasonEvidence[1].mutation === "ownerTab.filePath" &&
      classifierReasonEvidence[1].ownerPathBefore !==
        classifierReasonEvidence[1].ownerPathDuringDelivery &&
      classifierReasonEvidence[2].mutation === "active-document-identity" &&
      classifierReasonEvidence[2].identityHook === true &&
      classifierReasonEvidence[3].mutation === "currentFilePath" &&
      classifierReasonEvidence[3].identityHook === true &&
      classifierReasonEvidence[3].currentPathBefore !==
        classifierReasonEvidence[3].currentPathDuringDelivery &&
      classifierReasonEvidence.every((entry) =>
        !entry.acknowledgements.some((acknowledgement) =>
          acknowledgement && acknowledgement.why !== entry.name)), () =>
    classifierReasonDetail()
  );
  const ownerPathMovedForgedAcknowledgements = await exec(`
    (() => {
      const ipc = require("electron").ipcRenderer;
      const delivery = ${JSON.stringify(
        heldOwnerPathMovedDeliveries[0] &&
          heldOwnerPathMovedDeliveries[0].delivery,
      )};
      if (!delivery) return [];
      const canonicalAcknowledgement = Object.freeze({
        eventId: delivery.eventId,
        consumed: false,
        why: "owner-path-moved",
        pageSession: delivery.pageSession,
        rendererGeneration: delivery.rendererGeneration,
        tabId: delivery.owner && delivery.owner.tabId,
        documentGeneration: delivery.owner && delivery.owner.documentGeneration,
        pathKey: delivery.owner && delivery.owner.pathKey,
        selectionGeneration: delivery.selectionGeneration,
        watcherGeneration: delivery.watcherGeneration,
        attempt: delivery.attempt,
      });
      const acknowledgement = () => ({ ...canonicalAcknowledgement });
      const variants = [
        ["pageSession", (ack) => {
          ack.pageSession = String(ack.pageSession) + "-forged";
        }],
        ["rendererGeneration", (ack) => {
          ack.rendererGeneration += 1000000;
        }],
        ["tabId", (ack) => { ack.tabId += 1000000; }],
        ["documentGeneration", (ack) => { ack.documentGeneration += 1000000; }],
        ["pathKey", (ack) => { ack.pathKey += "-forged"; }],
        ["selectionGeneration", (ack) => { ack.selectionGeneration += 1000000; }],
        ["watcherGeneration", (ack) => { ack.watcherGeneration += 1000000; }],
        ["attempt", (ack) => { ack.attempt += 1000000; }],
      ];
      return variants.map(([field, mutate]) => {
        const ack = acknowledgement();
        mutate(ack);
        const changedFields = Object.keys(canonicalAcknowledgement).filter(
          (key) => ack[key] !== canonicalAcknowledgement[key],
        );
        ipc.send("file-deleted-ack", ack);
        return {
          field,
          changedFields,
          canonicalFields: Object.keys(canonicalAcknowledgement),
          acknowledgement: ack,
        };
      });
    })()
  `);
  const ownerPathMovedForgedObserved = await waitUntil(
    () => mainDeletionAckProbe &&
      ownerPathMovedForgedAcknowledgements.length === 8 &&
      ownerPathMovedForgedAcknowledgements.every((entry) =>
        mainDeletionAckProbe.rejectedAndUnchanged(
          deletionAckIdentity(entry.acknowledgement),
        )),
    5000,
  );
  // The held message is still the actual main-produced record. Change only
  // the live owner's path spelling; its session, owner identity, selection,
  // and active-document identity remain the ones captured by main.
  const ownerPathMovedDeliveryProbe = await exec(`
    (() => {
      const tabs = window.CustomTabs;
      const originalIdentity = tabs && tabs.getActiveDocumentIdentity;
      const owner = ${JSON.stringify(
        heldOwnerPathMovedDeliveries[0] &&
          heldOwnerPathMovedDeliveries[0].delivery &&
          heldOwnerPathMovedDeliveries[0].delivery.owner,
      )};
      const ownerTab = tabs && owner && typeof tabs.getTabs === "function"
        ? tabs.getTabs().find((tab) => tab.id === owner.tabId) || null
        : null;
      if (typeof originalIdentity !== "function" || !ownerTab) {
        return { installed: false };
      }
      const originalFilePath = ownerTab.filePath;
      const movedFilePath = String(originalFilePath) + ".owner-path-moved";
      const probe = window.__f22OwnerPathMovedDeliveryProbe = {
        originalIdentity,
        ownerTab,
        originalFilePath,
        movedFilePath,
        restored: false,
      };
      probe.restore = () => {
        if (probe.restored) return false;
        probe.restored = true;
        if (ownerTab.filePath === movedFilePath) {
          ownerTab.filePath = originalFilePath;
        }
        return true;
      };
      ownerTab.filePath = movedFilePath;
      return {
        installed: ownerTab.filePath === movedFilePath,
        originalFilePath,
        movedFilePath,
        originalIdentityIntact: tabs.getActiveDocumentIdentity === originalIdentity,
      };
    })()
  `);
  if (heldOwnerPathMovedDeliveries[0]) {
    realOwnerPathMovedSend.call(
      wc,
      "file-deleted",
      heldOwnerPathMovedDeliveries[0],
    );
  }
  const ownerPathMovedAcknowledged = await waitForCondition(
    exec,
    `window.__f22DeletionProtocolProbe.forwardedAcknowledgements.some(ack =>
      ack && ack.eventId === ${JSON.stringify(
        heldOwnerPathMovedDeliveries[0] &&
          heldOwnerPathMovedDeliveries[0].delivery &&
          heldOwnerPathMovedDeliveries[0].delivery.eventId,
      )} && ack.consumed === false && ack.why === "owner-path-moved")`,
    5000,
  );
  const ownerPathMovedAcknowledgement = await exec(`
    window.__f22DeletionProtocolProbe.forwardedAcknowledgements.find(ack =>
      ack && ack.eventId === ${JSON.stringify(
        heldOwnerPathMovedDeliveries[0] &&
          heldOwnerPathMovedDeliveries[0].delivery &&
          heldOwnerPathMovedDeliveries[0].delivery.eventId,
      )} && ack.consumed === false && ack.why === "owner-path-moved",
    ) || null
  `);
  const ownerPathMovedMainAcceptance = await waitForMainDeletionAcknowledgement(
    deletionAckIdentity(ownerPathMovedAcknowledgement),
  );
  const ownerPathMovedDeliveryCleanup = await exec(`
    (() => {
      const probe = window.__f22OwnerPathMovedDeliveryProbe;
      return probe ? {
        restored: probe.restore(),
        restoredAgain: probe.restore(),
        exactIdentityRestored:
          window.CustomTabs.getActiveDocumentIdentity === probe.originalIdentity,
        exactOwnerPathRestored:
          probe.ownerTab.filePath === probe.originalFilePath,
        noIdentityReinstall:
          window.CustomTabs.getActiveDocumentIdentity === probe.originalIdentity,
      } : null;
    })()
  `);
  const ownerPathMovedAckQuiescence = await waitForDeletionAckQuiescence(
    ownerPathMovedDeliveryStart,
    ownerPathMovedFile,
    deletionAckIdentity(ownerPathMovedAcknowledgement),
  );

  // Hold main's real watcher envelope while A still owns the single watcher.
  // Only after the producer has captured A's identity do we select B and
  // release that exact envelope for the renderer to refuse.
  const inactiveDeletedFile = path.join(dir, "f22-deleted-inactive-a.md");
  fs.writeFileSync(inactiveDeletedFile, "F22_DELETED_INACTIVE_A\r\n", "utf8");
  await clearTabs();
  const inactiveDeletedA = await createActiveTab(
    inactiveDeletedFile,
    "F22_DELETED_INACTIVE_A\r\n",
  );
  const inactiveSelectedOwner = await exec(`
    window.__f22DeletionProtocolProbe.selections
      .filter(entry => entry.filePath === ${JSON.stringify(inactiveDeletedFile)} &&
        entry.owner && entry.owner.tabId === ${inactiveDeletedA.id})
      .at(-1)?.owner || null
  `);
  const inactiveDeletedB = await exec(
    `window.CustomTabs.createTab(${JSON.stringify(deletedBFile)}, "F22_DELETED_B_BASE\\r\\n", { activate: false })`,
  );
  const inactiveMessageStart = await deletedMessages();
  const inactiveDeliveryStart = await exec(
    `window.__f22DeletionProtocolProbe.deliveries.length`,
  );
  const heldInactiveDeliveries = [];
  const realInactiveDeletionSend = wc.send;
  const restoreInactiveDeletionSend = replaceMethod(
    wc,
    "send",
    function (channel, ...args) {
      if (channel === "file-deleted" && args[0] && args[0].path === inactiveDeletedFile) {
        heldInactiveDeliveries.push(args[0]);
        return undefined;
      }
      return realInactiveDeletionSend.call(this, channel, ...args);
    },
  );
  let inactiveEnvelopeHeld = false;
  try {
    fs.unlinkSync(inactiveDeletedFile);
    inactiveEnvelopeHeld = await waitUntil(
      () => heldInactiveDeliveries.length === 1,
      5000,
    );
  } finally {
    restoreInactiveDeletionSend();
  }
  await exec(`window.CustomTabs.switchToTab(${inactiveDeletedB.id}); null;`);
  const inactiveWatcherMovedToB = await waitUntil(
    () => watcherProbe.snapshot().live.some(
      (entry) => entry.kind === "fs.watch" && entry.filePath === deletedBFile,
    ),
    5000,
  );
  const inactiveBBefore = await deletionTabSnapshot(inactiveDeletedB.id);
  if (heldInactiveDeliveries[0]) {
    realInactiveDeletionSend.call(wc, "file-deleted", heldInactiveDeliveries[0]);
  }
  const inactiveFirstDelivered = await waitForCondition(
    exec,
    `window.__f22DeletionProtocolProbe.deliveries
      .slice(${inactiveDeliveryStart})
      .some(entry => entry && entry.path === ${JSON.stringify(inactiveDeletedFile)} &&
        entry.delivery &&
        Number.isSafeInteger(entry.delivery.eventId) &&
        entry.delivery.owner &&
        typeof entry.delivery.owner.pageSession === "string" &&
        entry.delivery.owner.tabId === ${inactiveDeletedA.id} &&
        Number.isSafeInteger(entry.delivery.owner.documentGeneration) &&
        typeof entry.delivery.owner.pathKey === "string")`,
    5000,
  );
  const inactiveFirstDelivery = await exec(`
    window.__f22DeletionProtocolProbe.deliveries
      .slice(${inactiveDeliveryStart})
      .find(entry => entry && entry.path === ${JSON.stringify(inactiveDeletedFile)}) || null
  `);
  const inactiveInitialAcknowledgement = await exec(`
    window.__f22DeletionProtocolProbe.forwardedAcknowledgements.find(ack =>
      ack && ack.eventId === ${JSON.stringify(
        inactiveFirstDelivery && inactiveFirstDelivery.delivery &&
          inactiveFirstDelivery.delivery.eventId,
      )} && ack.consumed === false,
    ) || null
  `);
  const inactiveInitialMainAcceptance = await waitForMainDeletionAcknowledgement(
    deletionAckIdentity(inactiveInitialAcknowledgement),
  );
  const inactiveBAfterRefusal = await deletionTabSnapshot(inactiveDeletedB.id);
  const inactiveMessagesAfterRefusal = await deletedMessages();
  await exec(`window.CustomTabs.switchToTab(${inactiveDeletedA.id}); null;`);
  const inactiveReplaySelectedOwner = await exec(`
    window.__f22DeletionProtocolProbe.selections
      .filter(entry => entry.filePath === ${JSON.stringify(inactiveDeletedFile)} &&
        entry.owner && entry.owner.tabId === ${inactiveDeletedA.id})
      .at(-1)?.owner || null
  `);
  const inactiveReplayDelivered = await waitForCondition(
    exec,
    `(() => {
      const deliveries = window.__f22DeletionProtocolProbe.deliveries
        .slice(${inactiveDeliveryStart})
        .filter(entry => entry && entry.path === ${JSON.stringify(inactiveDeletedFile)});
      const first = deliveries[0];
      return !!(
        first &&
        first.delivery &&
        deliveries.filter(entry =>
          entry.delivery && entry.delivery.eventId === first.delivery.eventId,
        ).length >= 2
      );
    })()`,
    5000,
  );
  const inactiveRecovery = await exec(`
    (() => {
      const probe = window.__f22DeletionProtocolProbe;
      const deliveries = probe.deliveries
        .slice(${inactiveDeliveryStart})
        .filter(entry => entry && entry.path === ${JSON.stringify(inactiveDeletedFile)});
      const first = deliveries[0] || null;
      const eventId = first && first.delivery && first.delivery.eventId;
      return {
        deliveries,
        acknowledgements: probe.acknowledgements.filter(
          ack => ack && ack.eventId === eventId,
        ),
        messages: window.__f22DeletionMessages
          .filter(message => /deleted from disk/i.test(message)).length,
        active: (window.CustomTabs.getActiveTab() || {}).id,
      };
    })()
  `);
  const inactiveAAfterConsumption = await deletionTabSnapshot(inactiveDeletedA.id);
  const inactiveAckQuiescence = await waitForDeletionAckQuiescence(
    inactiveDeliveryStart,
    inactiveDeletedFile,
    deletionAckIdentity(inactiveRecovery.acknowledgements.find(
      (ack) => ack && ack.consumed === true,
    )),
  );

  // Advance A's real selection generation while its held deletion envelope is
  // in flight. Releasing that old envelope while A is watched again is the
  // live stale-selection path: main must retain it, clear its attempt, retry
  // after 100ms, and then accept the current-generation consumption.
  const staleDeletedFile = path.join(dir, "f22-deleted-stale-selection.md");
  fs.writeFileSync(staleDeletedFile, "F22_DELETED_STALE\r\n", "utf8");
  await clearTabs();
  const staleDeletedA = await createActiveTab(staleDeletedFile, "F22_DELETED_STALE\r\n");
  const staleDeletedB = await exec(
    `window.CustomTabs.createTab(${JSON.stringify(deletedBFile)}, "F22_DELETED_B_BASE\\r\\n", { activate: false })`,
  );
  const staleDeliveryStart = await exec(`window.__f22DeletionProtocolProbe.deliveries.length`);
  const heldStaleDeliveries = [];
  const realStaleDeletionSend = wc.send;
  const restoreStaleDeletionSend = replaceMethod(wc, "send", function(channel, ...args) {
    if (channel === "file-deleted" && args[0] && args[0].path === staleDeletedFile) {
      heldStaleDeliveries.push(args[0]);
      return undefined;
    }
    return realStaleDeletionSend.call(this, channel, ...args);
  });
  let staleEnvelopeHeld = false;
  try {
    fs.unlinkSync(staleDeletedFile);
    staleEnvelopeHeld = await waitUntil(() => heldStaleDeliveries.length === 1, 5000);
  } finally {
    restoreStaleDeletionSend();
  }
  // Do not let renderer tab switches reach main yet. The inner wrapper is
  // deliberately owner-aware: only the two real watcher/reassert messages for
  // this A -> B -> A transition are held, while every unrelated IPC call still
  // takes the normal deletion-protocol wrapper and transport.
  let staleSelectionAdvance = null;
  let staleSelectionCleanup = null;
  let staleInitialRecordBeforeRelease = null;
  let staleInitialAcknowledged = false;
  let staleInitialAcknowledgement = null;
  let staleInitialMainAcceptance = null;
  let staleRestoreAndReassert = null;
  let staleReplayed = false;
  let staleRecovery = { deliveries: [], acknowledgements: [], currentOwner: null };
  let staleTerminalAcknowledgement = null;
  let staleAckQuiescence = null;
  try {
    staleSelectionAdvance = await exec(`
      (() => {
        const ipc = require("electron").ipcRenderer;
        const originalSend = ipc.send;
        const probe = window.__f22StaleSelectionProbe = {
          originalSend,
          enabled: true,
          restored: false,
          suppressed: [],
        };
        const expectedPathForOwner = (owner) => {
          if (!owner) return null;
          if (owner.tabId === ${staleDeletedA.id}) {
            return ${JSON.stringify(staleDeletedFile)};
          }
          if (owner.tabId === ${staleDeletedB.id}) {
            return ${JSON.stringify(deletedBFile)};
          }
          return null;
        };
        const staleSelectionSend = function(channel, ...args) {
          const payload = args[0];
          const owner = payload && payload.owner;
          const expectedPath = expectedPathForOwner(owner);
          if (
            probe.enabled &&
            (channel === "start-file-watching" || channel === "set-active-file") &&
            owner &&
            expectedPath &&
            payload.filePath === expectedPath
          ) {
            probe.suppressed.push({
              channel,
              filePath: payload.filePath,
              owner: { ...owner },
            });
            return undefined;
          }
          return originalSend.call(this, channel, ...args);
        };
        probe.wrapper = staleSelectionSend;
        probe.restore = () => {
          if (probe.restored) return false;
          probe.restored = true;
          probe.enabled = false;
          if (ipc.send === staleSelectionSend) ipc.send = originalSend;
          return true;
        };
        ipc.send = staleSelectionSend;
        try {
          window.CustomTabs.switchToTab(${staleDeletedB.id});
          window.CustomTabs.switchToTab(${staleDeletedA.id});
          return {
            active: (window.CustomTabs.getActiveTab() || {}).id,
            owner: window.CustomTabs.getActiveDocumentIdentity(
              ${JSON.stringify(staleDeletedFile)},
              window.getReloadRequestSession(),
            ),
            suppressed: probe.suppressed.slice(),
            wrapperInstalled: ipc.send === staleSelectionSend,
          };
        } catch (error) {
          probe.restore();
          throw error;
        }
      })()
    `);
    const staleHeldIdentity = deletionDeliveryIdentity(
      heldStaleDeliveries[0] && heldStaleDeliveries[0].delivery,
    );
    staleInitialRecordBeforeRelease = mainDeletionAckProbe
      ? mainDeletionAckProbe.recordSnapshot(staleHeldIdentity)
      : null;
    // This is the only release of attempt 1. A main-side reselection would
    // already have cleared it and emitted attempt 2, which these checks reject.
    if (heldStaleDeliveries[0]) {
      realStaleDeletionSend.call(wc, "file-deleted", heldStaleDeliveries[0]);
    }
    staleInitialAcknowledged = await waitForCondition(
      exec,
      `window.__f22DeletionProtocolProbe.forwardedAcknowledgements.some(ack =>
        ack && ack.eventId === ${JSON.stringify(
          heldStaleDeliveries[0] && heldStaleDeliveries[0].delivery &&
            heldStaleDeliveries[0].delivery.eventId,
        )} && ack.attempt === 1 && ack.why === "stale-selection")`,
      5000,
    );
    staleInitialAcknowledgement = await exec(`
      window.__f22DeletionProtocolProbe.forwardedAcknowledgements.find(ack =>
        ack && ack.eventId === ${JSON.stringify(
          heldStaleDeliveries[0] && heldStaleDeliveries[0].delivery &&
            heldStaleDeliveries[0].delivery.eventId,
        )} && ack.attempt === 1 && ack.why === "stale-selection",
      ) || null
    `);
    staleInitialMainAcceptance = await waitForMainDeletionAcknowledgement(
      deletionAckIdentity(staleInitialAcknowledgement),
    );
    // Restore this inner wrapper before the outer protocol wrapper, then use
    // renderer's real ownership assertion to deliver current A ownership.
    staleRestoreAndReassert = await exec(`
      (() => {
        const ipc = require("electron").ipcRenderer;
        const probe = window.__f22StaleSelectionProbe;
        const restored = probe ? probe.restore() : false;
        const before = window.CustomTabs.getActiveDocumentIdentity(
          ${JSON.stringify(staleDeletedFile)},
          window.getReloadRequestSession(),
        );
        const reasserted =
          typeof window.assertFileTrackingOwnership === "function" &&
          window.assertFileTrackingOwnership(
            ${JSON.stringify(staleDeletedFile)},
            true,
            { adoptBaseline: false },
          );
        const after = window.CustomTabs.getActiveDocumentIdentity(
          ${JSON.stringify(staleDeletedFile)},
          window.getReloadRequestSession(),
        );
        return {
          restored,
          reasserted,
          before,
          after,
          outerProtocolRestored: ipc.send ===
            window.__f22DeletionProtocolProbe.wrapper,
        };
      })()
    `);
    staleReplayed = await waitForCondition(
      exec,
      `window.__f22DeletionProtocolProbe.deliveries.slice(${staleDeliveryStart})
        .filter(entry => entry && entry.path === ${JSON.stringify(staleDeletedFile)}).length === 2`,
      5000,
    );
    staleRecovery = await exec(`
      (() => {
        const probe = window.__f22DeletionProtocolProbe;
        const deliveries = probe.deliveries.slice(${staleDeliveryStart})
          .filter(entry => entry && entry.path === ${JSON.stringify(staleDeletedFile)});
        const eventId = deliveries[0] && deliveries[0].delivery && deliveries[0].delivery.eventId;
        return {
          deliveries,
          acknowledgements: probe.acknowledgements.filter(ack => ack && ack.eventId === eventId),
          currentOwner: window.CustomTabs.getActiveDocumentIdentity(
            ${JSON.stringify(staleDeletedFile)},
            window.getReloadRequestSession(),
          ),
        };
      })()
    `);
    staleTerminalAcknowledgement = deletionAckIdentity(
      staleRecovery.acknowledgements.find((ack) => ack && ack.consumed === true),
    );
    staleAckQuiescence = await waitForDeletionAckQuiescence(
      staleDeliveryStart,
      staleDeletedFile,
      staleTerminalAcknowledgement,
    );
  } finally {
    staleSelectionCleanup = await exec(`
      (() => {
        const ipc = require("electron").ipcRenderer;
        const probe = window.__f22StaleSelectionProbe;
        if (!probe) return null;
        const restored = probe.restore();
        return {
          restored,
          disabled: probe.enabled === false,
          outerProtocolRestored: ipc.send ===
            window.__f22DeletionProtocolProbe.wrapper,
          suppressed: probe.suppressed.slice(),
        };
      })()
    `);
  }

  // Freeze while A remains the active watcher owner. This reaches the
  // renderer's frozen refusal rather than the earlier owner-inactive branch.
  const frozenDeletedFile = path.join(dir, "f22-deleted-frozen-a.md");
  fs.writeFileSync(frozenDeletedFile, "F22_DELETED_FROZEN_A\r\n", "utf8");
  await clearTabs();
  const frozenDeletedA = await createActiveTab(
    frozenDeletedFile,
    "F22_DELETED_FROZEN_A\r\n",
  );
  const frozenSelectedOwner = await exec(`
    window.__f22DeletionProtocolProbe.selections
      .filter(entry => entry.filePath === ${JSON.stringify(frozenDeletedFile)} &&
        entry.owner && entry.owner.tabId === ${frozenDeletedA.id})
      .at(-1)?.owner || null
  `);
  const frozenDeletedB = await exec(
    `window.CustomTabs.createTab(${JSON.stringify(deletedBFile)}, "F22_DELETED_B_BASE\\r\\n", { activate: false })`,
  );
  const frozenAInitial = await deletionTabSnapshot(frozenDeletedA.id);
  const frozenDeletion = await exec(`
    (async () => {
      const ipc = require("electron").ipcRenderer;
      const gen = await ipc.invoke("quit-approval-generation");
      const revision = window.CustomTabs.__shutdownFreeze().revision;
      ipc.emit("quit-approval-request", {}, { id: 97001, gen, retainFreeze: true });
      ipc.emit("quit-approval-commit", {}, { id: 97001, gen, revision });
      return { gen, revision, ownerTabId: ${frozenDeletedA.id} };
    })()
  `);
  const frozenBeforeDelete = await waitForCondition(
    exec,
    `window.CustomTabs.__shutdownFreeze().frozen === true`,
    5000,
  );
  const frozenMessageCount = await deletedMessages();
  const frozenDeliveryStart = await exec(
    `window.__f22DeletionProtocolProbe.deliveries.length`,
  );
  fs.unlinkSync(frozenDeletedFile);
  const frozenFirstDelivered = await waitForCondition(
    exec,
    `window.__f22DeletionProtocolProbe.deliveries
      .slice(${frozenDeliveryStart})
      .some(entry => entry && entry.path === ${JSON.stringify(frozenDeletedFile)} &&
        entry.delivery &&
        Number.isSafeInteger(entry.delivery.eventId) &&
        entry.delivery.owner &&
        typeof entry.delivery.owner.pageSession === "string" &&
        entry.delivery.owner.tabId === ${frozenDeletedA.id} &&
        Number.isSafeInteger(entry.delivery.owner.documentGeneration) &&
        typeof entry.delivery.owner.pathKey === "string")`,
    5000,
  );
  const frozenInitialDelivery = await exec(`
    window.__f22DeletionProtocolProbe.deliveries
      .slice(${frozenDeliveryStart})
      .find(entry => entry && entry.path === ${JSON.stringify(frozenDeletedFile)}) || null
  `);
  const frozenAAfterDelete = await deletionTabSnapshot(frozenDeletedA.id);
  const frozenMessagesBeforeThaw = await deletedMessages();
  const frozenInitialAcknowledgement = await exec(`
    window.__f22DeletionProtocolProbe.forwardedAcknowledgements.find(ack =>
      ack && ack.eventId === ${JSON.stringify(
        frozenInitialDelivery && frozenInitialDelivery.delivery &&
          frozenInitialDelivery.delivery.eventId,
      )} && ack.consumed === false,
    ) || null
  `);
  const frozenInitialMainAcceptance = await waitForMainDeletionAcknowledgement(
    deletionAckIdentity(frozenInitialAcknowledgement),
  );
  await exec(`require("electron").ipcRenderer.emit("quit-approval-thaw", {}); null;`);
  const frozenThawed = await waitForCondition(
    exec,
    `window.CustomTabs.__shutdownFreeze().frozen === false`,
    5000,
  );
  await exec(`window.CustomTabs.switchToTab(${frozenDeletedA.id}); null;`);
  const frozenReplaySelectedOwner = await exec(`
    window.__f22DeletionProtocolProbe.selections
      .filter(entry => entry.filePath === ${JSON.stringify(frozenDeletedFile)} &&
        entry.owner && entry.owner.tabId === ${frozenDeletedA.id})
      .at(-1)?.owner || null
  `);
  const frozenReplayDelivered = await waitForCondition(
    exec,
    `(() => {
      const deliveries = window.__f22DeletionProtocolProbe.deliveries
        .slice(${frozenDeliveryStart})
        .filter(entry => entry && entry.path === ${JSON.stringify(frozenDeletedFile)});
      const first = deliveries[0];
      return !!(
        first &&
        first.delivery &&
        deliveries.filter(entry =>
          entry.delivery && entry.delivery.eventId === first.delivery.eventId,
        ).length >= 2
      );
    })()`,
    5000,
  );
  const frozenAAfterThaw = await deletionTabSnapshot(frozenDeletedA.id);
  const frozenMessagesAfterThaw = await deletedMessages();
  const frozenRecovery = await exec(`
    (() => {
      const probe = window.__f22DeletionProtocolProbe;
      const deliveries = probe.deliveries
        .slice(${frozenDeliveryStart})
        .filter(entry => entry && entry.path === ${JSON.stringify(frozenDeletedFile)});
      const first = deliveries[0] || null;
      const eventId = first && first.delivery && first.delivery.eventId;
      return {
        deliveries,
        acknowledgements: probe.acknowledgements.filter(
          ack => ack && ack.eventId === eventId,
        ),
      };
    })()
  `);
  const frozenAckQuiescence = await waitForDeletionAckQuiescence(
    frozenDeliveryStart,
    frozenDeletedFile,
    deletionAckIdentity(frozenRecovery.acknowledgements.find(
      (ack) => ack && ack.consumed === true,
    )),
  );

  // A missing ACK is distinct from an explicit renderer refusal: main must
  // retire the timed-out attempt, replay the same event ID, and notify once.
  const lostAckFile = path.join(dir, "f22-deleted-lost-ack.md");
  fs.writeFileSync(lostAckFile, "F22_DELETED_LOST_ACK\r\n", "utf8");
  await clearTabs();
  const lostAckTab = await createActiveTab(
    lostAckFile,
    "F22_DELETED_LOST_ACK\r\n",
  );
  const lostAckStart = await exec(
    `window.__f22DeletionProtocolProbe.deliveries.length`,
  );
  const lostAckMessageStart = await deletedMessages();
  await exec(`window.__f22DeletionProtocolProbe.dropAcknowledgements = true; null;`);
  let lostAckReplayed = false;
  try {
    fs.unlinkSync(lostAckFile);
    lostAckReplayed = await waitForCondition(
      exec,
      `(() => {
        const deliveries = window.__f22DeletionProtocolProbe.deliveries
          .slice(${lostAckStart})
          .filter(entry => entry && entry.path === ${JSON.stringify(lostAckFile)});
        return deliveries.length >= 2 &&
          deliveries.every(entry => entry.delivery &&
            entry.delivery.eventId === deliveries[0].delivery.eventId);
      })()`,
      5000,
    );
  } finally {
    await exec(`window.__f22DeletionProtocolProbe.dropAcknowledgements = false; null;`);
  }
  const lostAckConsumed = await waitForCondition(
    exec,
    `(() => {
      const probe = window.__f22DeletionProtocolProbe;
      const deliveries = probe.deliveries
        .slice(${lostAckStart})
        .filter(entry => entry && entry.path === ${JSON.stringify(lostAckFile)});
      const eventId = deliveries[0] && deliveries[0].delivery && deliveries[0].delivery.eventId;
      return deliveries.length >= 3 &&
        deliveries.every(entry => entry.delivery && entry.delivery.eventId === eventId) &&
        probe.acknowledgements.some(ack => ack && ack.eventId === eventId && ack.consumed === true);
    })()`,
    5000,
  );
  const lostAckRecovery = await exec(`
    (() => {
      const probe = window.__f22DeletionProtocolProbe;
      const deliveries = probe.deliveries
        .slice(${lostAckStart})
        .filter(entry => entry && entry.path === ${JSON.stringify(lostAckFile)});
      const eventId = deliveries[0] && deliveries[0].delivery && deliveries[0].delivery.eventId;
      return {
        deliveries,
        attempted: probe.attemptedAcknowledgements.filter(ack => ack && ack.eventId === eventId),
        dropped: probe.droppedAcknowledgements.filter(ack => ack && ack.eventId === eventId),
        forwarded: probe.forwardedAcknowledgements.filter(ack => ack && ack.eventId === eventId),
        messages: window.__f22DeletionMessages
          .filter(message => /deleted from disk/i.test(message)).length,
        active: (window.CustomTabs.getActiveTab() || {}).id,
      };
    })()
  `);
  // Main exposes no deletion-delivery diagnostics in packaged renderer IPC.
  // Quiescence beyond its 4s ACK timeout is therefore the observable proof
  // that the exact forwarded ACK was accepted and both retry timers retired.
  const lostAckDeliveryCount = lostAckRecovery.deliveries.length;
  const lostAckTimersTerminated = await new Promise((resolve) => {
    const deadline = Date.now() + 4500;
    const observe = async () => {
      const count = await exec(`window.__f22DeletionProtocolProbe.deliveries
        .slice(${lostAckStart}).filter(entry => entry && entry.path === ${JSON.stringify(lostAckFile)}).length`);
      if (count !== lostAckDeliveryCount) return resolve(false);
      if (Date.now() >= deadline) return resolve(true);
      setTimeout(observe, 50);
    };
    observe();
  });
  const lostAckQuiescence = await waitForDeletionAckQuiescence(
    lostAckStart,
    lostAckFile,
    deletionAckIdentity(lostAckRecovery.forwarded.find(
      (ack) => ack && ack.consumed === true,
    )),
  );

  // A synchronous webContents.send failure is another lost attempt, not a
  // reason to drop the deletion evidence. The retry must carry the original
  // producer-generated event ID and complete with one acknowledgement.
  const throwDeletedFile = path.join(dir, "f22-deleted-send-throw.md");
  fs.writeFileSync(throwDeletedFile, "F22_DELETED_SEND_THROW\r\n", "utf8");
  await clearTabs();
  const throwDeletedTab = await createActiveTab(
    throwDeletedFile,
    "F22_DELETED_SEND_THROW\r\n",
  );
  const throwDeliveryStart = await exec(
    `window.__f22DeletionProtocolProbe.deliveries.length`,
  );
  const throwMessageStart = await deletedMessages();
  // On the sealed baseline deliverDeletionReport calls target.send directly;
  // a thrown send reaches the harness uncaught-exception exit handler. Do not
  // manufacture a crash/native dialog in order to test it. Once production
  // catches the send at this boundary, run the real producer retry below.
  const deletionDeliveryStartInSource = deletionProducerSource.indexOf(
    "function deliverDeletionReport",
  );
  const deletionDeliveryEndInSource = deletionProducerSource.indexOf(
    "\nfunction ", deletionDeliveryStartInSource + 1,
  );
  const deletionDeliverySource = deletionProducerSource.slice(
    deletionDeliveryStartInSource,
    deletionDeliveryEndInSource < 0 ? undefined : deletionDeliveryEndInSource,
  );
  const catchesDeletionSendFailure = deletionProductionPrerequisite.caughtSynchronousSend &&
    /try\s*\{[\s\S]*?target\.send\("file-deleted"[\s\S]*?\}\s*catch/.test(
      deletionDeliverySource,
    );
  checkDeletionEvidence(
    ["synchronousSendRecovery"],
    "F22 deletion send failures are caught before they can reach the unattended main-process exception handler", () =>
    catchesDeletionSendFailure === true, () =>
    JSON.stringify({
      catchesDeletionSendFailure,
      caughtSynchronousSend: deletionProductionPrerequisite.caughtSynchronousSend,
    })
  );
  let thrownDeletionPayload = null;
  const realThrowDeletionSend = wc.send;
  let restoreThrowDeletionSend = null;
  if (catchesDeletionSendFailure) {
    restoreThrowDeletionSend = replaceMethod(
      wc,
      "send",
      function (channel, ...args) {
        if (
          channel === "file-deleted" && args[0] &&
          args[0].path === throwDeletedFile && !thrownDeletionPayload
        ) {
          thrownDeletionPayload = args[0];
          throw new Error("F22 controlled file-deleted send failure");
        }
        return realThrowDeletionSend.call(this, channel, ...args);
      },
    );
  }
  let throwObserved = false;
  try {
    if (catchesDeletionSendFailure) {
      fs.unlinkSync(throwDeletedFile);
      throwObserved = await waitUntil(() => !!thrownDeletionPayload, 5000);
    }
  } finally {
    if (restoreThrowDeletionSend) restoreThrowDeletionSend();
  }
  const throwRecovered = catchesDeletionSendFailure && await waitForCondition(
    exec,
    `(() => {
      const probe = window.__f22DeletionProtocolProbe;
      const delivery = probe.deliveries
        .slice(${throwDeliveryStart})
        .find(entry => entry && entry.path === ${JSON.stringify(throwDeletedFile)});
      return !!(
        delivery && delivery.delivery &&
        ${JSON.stringify(thrownDeletionPayload && thrownDeletionPayload.delivery && thrownDeletionPayload.delivery.eventId)} === delivery.delivery.eventId &&
        probe.acknowledgements.some(ack =>
          ack && ack.eventId === delivery.delivery.eventId && ack.consumed === true)
      );
    })()`,
    5000,
  );
  const throwRecovery = await exec(`
    (() => {
      const probe = window.__f22DeletionProtocolProbe;
      const delivery = probe.deliveries
        .slice(${throwDeliveryStart})
        .find(entry => entry && entry.path === ${JSON.stringify(throwDeletedFile)}) || null;
      const eventId = delivery && delivery.delivery && delivery.delivery.eventId;
      return {
        delivery,
        acknowledgements: probe.acknowledgements.filter(ack => ack && ack.eventId === eventId),
        messages: window.__f22DeletionMessages
          .filter(message => /deleted from disk/i.test(message)).length,
        active: (window.CustomTabs.getActiveTab() || {}).id,
      };
    })()
  `);
  const throwAckQuiescence = catchesDeletionSendFailure &&
    await waitForDeletionAckQuiescence(
      throwDeliveryStart,
      throwDeletedFile,
      deletionAckIdentity(throwRecovery.acknowledgements.find(
        (ack) => ack && ack.consumed === true,
      )),
    );

  const deletionDetail = () => JSON.stringify({
    deletionProbe, deletedAOwner, deletedAProduced, deletedAEvent,
    deletionDeliveryStart, deletionMessageStart, deletionAAfterReplay,
    deletionMessagesAfterA, deletedAProtocol, activeAckQuiescence, deletionSave,
    deletedAWasMissingBeforeRecreation, deletionAAfterSave, deletionRoundTrip,
    deletionAAfterRecreatedRoundTrip, deletedAWatcherAtStart,
    deletedAWatcherAfterDeletion, deletedADeletionProducerRetained,
    deletedAWatcherRearmed, deletedAWatcherAfterRoundTrip,
    closedDeletedA: closedDeletedA.id, closedDeletedB: closedDeletedB.id,
    closedDeletedEvent, closedAcknowledgement, closedEnvelopeHeld, closedDelivered,
    closedDeletedGone, closedBeforeMessages, closedAfterMessages, closedAckQuiescence,
    replacementDeletedA: replacementDeletedA.id,
    replacementReloaded, replacementCurrentOwner, replacementAdoption,
    replacementDeletedEvent, replacementAcknowledgement, replacementEnvelopeHeld,
    replacementDelivered, replacementBefore, replacementAfterStaleDelivery, replacementAfter,
    replacementBeforeMessages, replacementAfterStaleMessages, replacementAfterMessages,
    replacementAckQuiescence,
    ownerPathMovedTab: ownerPathMovedTab.id, ownerPathMovedEnvelopeHeld,
    ownerPathMovedHeldIdentity, classifierReasonEvidence,
    ownerPathMovedForgedAcknowledgements, ownerPathMovedForgedObserved,
    ownerPathMovedDeliveryProbe, ownerPathMovedAcknowledged,
    ownerPathMovedAcknowledgement, ownerPathMovedMainAcceptance,
    ownerPathMovedDeliveryCleanup, ownerPathMovedAckQuiescence,
    inactiveDeletedA: inactiveDeletedA.id, inactiveDeletedB: inactiveDeletedB.id,
    inactiveSelectedOwner, inactiveBBefore, inactiveBAfterRefusal,
    inactiveWatcherMovedToB,
    inactiveMessageStart, inactiveFirstDelivered, inactiveFirstDelivery,
    inactiveMessagesAfterRefusal, inactiveInitialAcknowledgement,
    inactiveInitialMainAcceptance, inactiveReplaySelectedOwner,
    inactiveReplayDelivered, inactiveRecovery, inactiveAAfterConsumption, inactiveAckQuiescence,
    staleDeletedA: staleDeletedA.id, staleDeletedB: staleDeletedB.id,
    staleEnvelopeHeld, staleSelectionAdvance, staleInitialRecordBeforeRelease,
    staleInitialAcknowledged, staleInitialAcknowledgement,
    staleInitialMainAcceptance, staleRestoreAndReassert, staleSelectionCleanup,
    staleReplayed, staleRecovery, staleAckQuiescence,
    frozenDeletedA: frozenDeletedA.id, frozenDeletedB: frozenDeletedB.id,
    frozenSelectedOwner, frozenDeletion, frozenBeforeDelete, frozenDeliveryStart,
    frozenFirstDelivered, frozenInitialDelivery, frozenAInitial, frozenAAfterDelete,
    frozenMessageCount, frozenInitialAcknowledgement, frozenInitialMainAcceptance,
    frozenMessagesBeforeThaw, frozenThawed, frozenReplaySelectedOwner,
    frozenReplayDelivered, frozenAAfterThaw, frozenMessagesAfterThaw, frozenRecovery,
    frozenAckQuiescence,
    lostAckTab: lostAckTab.id, lostAckReplayed, lostAckConsumed,
    lostAckTimersTerminated, lostAckRecovery, lostAckQuiescence,
    throwDeletedTab: throwDeletedTab.id, catchesDeletionSendFailure,
    thrownDeletionPayload, throwObserved, throwRecovered, throwRecovery, throwAckQuiescence,
    replacementSave, replacementBytesAfterSave,
    replacementConflictAfterSave, explicitReplacementAdopted,
    replacementAfterExplicitAdoption,
  });
  checkDeletionEvidence(
    ["producerGeneration"],
    "F22 deletion producer generation carries a complete real owner identity", () =>
    deletedAProduced === true &&
      deletedAEvent &&
      deletedAEvent.delivery &&
      deletionDeliveryIdentity(deletedAEvent.delivery).complete === true &&
      deletedAOwner &&
      deletedAEvent.delivery.owner.pageSession === deletedAOwner.pageSession &&
      deletedAEvent.delivery.owner.rendererGeneration ===
        deletedAOwner.rendererGeneration &&
      deletedAEvent.delivery.owner.tabId === deletedAOwner.tabId &&
      deletedAEvent.delivery.owner.documentGeneration ===
        deletedAOwner.documentGeneration &&
      deletedAEvent.delivery.owner.pathKey === deletedAOwner.pathKey, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 production ACK listener rejects one-field top-level canonical ACK variants without mutating its held record", () =>
    ownerPathMovedEnvelopeHeld === true &&
      ownerPathMovedForgedAcknowledgements.length === 8 &&
      JSON.stringify(ownerPathMovedForgedAcknowledgements.map(
        (entry) => entry.field,
      )) === JSON.stringify([
        "pageSession",
        "rendererGeneration",
        "tabId",
        "documentGeneration",
        "pathKey",
        "selectionGeneration",
        "watcherGeneration",
        "attempt",
      ]) &&
      ownerPathMovedForgedAcknowledgements.every((entry) => {
        const identity = deletionAckIdentity(entry.acknowledgement);
        return identity &&
          identity.complete === true &&
          identity.consumed === false &&
          identity.why === "owner-path-moved" &&
          JSON.stringify(entry.canonicalFields) === JSON.stringify([
            "eventId",
            "consumed",
            "why",
            "pageSession",
            "rendererGeneration",
            "tabId",
            "documentGeneration",
            "pathKey",
            "selectionGeneration",
            "watcherGeneration",
            "attempt",
          ]) &&
          JSON.stringify(Object.keys(entry.acknowledgement)) ===
            JSON.stringify(entry.canonicalFields) &&
          JSON.stringify(entry.changedFields) === JSON.stringify([entry.field]) &&
          JSON.stringify(
            deletionIdentityDifferences(ownerPathMovedHeldIdentity, identity),
          ) === JSON.stringify([entry.field]) &&
          mainDeletionAckProbe.rejectedAndUnchanged(identity);
      }) &&
      ownerPathMovedForgedObserved === true, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 an exact owner-path-moved ACK from the production classifier retires its held owner-keyed record", () =>
    ownerPathMovedDeliveryProbe &&
      ownerPathMovedDeliveryProbe.installed === true &&
    ownerPathMovedDeliveryProbe.originalIdentityIntact === true &&
    ownerPathMovedDeliveryProbe.originalFilePath !==
      ownerPathMovedDeliveryProbe.movedFilePath &&
    ownerPathMovedAcknowledged === true &&
      ownerPathMovedAcknowledgement &&
      ownerPathMovedAcknowledgement.consumed === false &&
      ownerPathMovedAcknowledgement.why === "owner-path-moved" &&
      acknowledgementMatchesDelivery(
        ownerPathMovedAcknowledgement,
        heldOwnerPathMovedDeliveries[0].delivery,
      ) &&
      ownerPathMovedMainAcceptance.acceptedAndRetired === true &&
      ownerPathMovedMainAcceptance.mainObservation.attemptRetired === true &&
      ownerPathMovedMainAcceptance.mainObservation.recordRetired === true &&
      ownerPathMovedMainAcceptance.mainObservation.recordParked === false &&
      ownerPathMovedMainAcceptance.mainObservation.retryScheduled === false &&
      ownerPathMovedDeliveryCleanup &&
      ownerPathMovedDeliveryCleanup.restored === true &&
      ownerPathMovedDeliveryCleanup.restoredAgain === false &&
      ownerPathMovedDeliveryCleanup.exactIdentityRestored === true &&
      ownerPathMovedDeliveryCleanup.exactOwnerPathRestored === true &&
      ownerPathMovedDeliveryCleanup.noIdentityReinstall === true &&
      ownerPathMovedAckQuiescence.acceptedAndRetired === true &&
      ownerPathMovedAckQuiescence.mainObservation.recordRetired === true &&
      ownerPathMovedAckQuiescence.retired === true, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["producerGeneration", "watcherOwnership", "rendererTombstoneCache", "acknowledgementLifecycle"],
    "F22 watcher-produced active deletion records the real tombstone event and one forwarded consumed ACK", () =>
    deletionProbe === true && deletedAProduced === true && deletedAEvent &&
      deletedAEvent.delivery && Number.isSafeInteger(deletedAEvent.delivery.eventId) &&
      deletedAOwner && deletedAEvent.delivery.owner &&
      deletedAEvent.delivery.owner.pageSession === deletedAOwner.pageSession &&
      deletedAEvent.delivery.owner.rendererGeneration ===
        deletedAOwner.rendererGeneration &&
      deletedAEvent.delivery.owner.tabId === deletedAOwner.tabId &&
      deletedAEvent.delivery.owner.documentGeneration === deletedAOwner.documentGeneration &&
      deletedAEvent.delivery.owner.pathKey === deletedAOwner.pathKey &&
      deletionAAfterReplay && deletionAAfterReplay.active === deletedA.id &&
      deletionAAfterReplay.dirty === false && deletionAAfterReplay.reloadConflict === false &&
      deletionAAfterReplay.deletionTombstone === true &&
      deletionAAfterReplay.deletionEventId === deletedAEvent.delivery.eventId &&
      deletionMessagesAfterA === deletionMessageStart + 1 &&
      deletedAProtocol.deliveries.length === 1 &&
      deletedAProtocol.attempted.length === 1 && deletedAProtocol.forwarded.length === 1 &&
      deletedAProtocol.forwarded[0].consumed === true &&
      deletedAProtocol.forwarded[0].why === "consumed" &&
      acknowledgementMatchesDelivery(
        deletedAProtocol.forwarded[0],
        deletedAEvent.delivery,
      ) &&
      deletedAProtocol.forwarded[0].selectionGeneration === deletedAEvent.delivery.selectionGeneration &&
      deletedAProtocol.forwarded[0].watcherGeneration === deletedAEvent.delivery.watcherGeneration &&
      activeAckQuiescence.acceptedAndRetired === true &&
      activeAckQuiescence.mainObservation.recordRetired === true &&
      activeAckQuiescence.mainObservation.recordParked === false &&
      activeAckQuiescence.mainObservation.tombstoneRetained === true &&
      activeAckQuiescence.retired === true, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["deletionSaveRefusal"],
    "F22 deletion-only Save refusal preserves a clean tombstoned tab and replacement bytes", () =>
    deletionSave && deletionSave.timedOut === false && deletionSave.result &&
      deletionSave.filePath === deletedAFile && deletionSave.result.path === deletedAFile &&
      deletionSave.result.success === false && deletionSave.result.conflict === true &&
      deletedAWasMissingBeforeRecreation === true &&
      replacementBytesAfterSave === "F22_DELETED_A_EXTERNAL_REPLACEMENT\r\n" &&
      deletionAAfterSave &&
      deletionAAfterSave.dirty === false &&
      deletionAAfterSave.reloadConflict === false &&
      deletionAAfterSave.deletionTombstone === true &&
      deletionAAfterSave.deletionEventId === deletedAEvent.delivery.eventId, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["rendererTombstoneCache"],
    "F22 renderer retains deletion-tombstone bytes through a real pre-save tab round-trip until explicit reload", () =>
    deletionRoundTrip && deletionRoundTrip.active === deletedA.id &&
      deletionAAfterRecreatedRoundTrip &&
      deletionAAfterRecreatedRoundTrip.active === deletedA.id &&
      deletionAAfterRecreatedRoundTrip.content === "F22_DELETED_A_BASE\r\n" &&
      deletionAAfterRecreatedRoundTrip.originalContent === "F22_DELETED_A_BASE\r\n" &&
      deletionAAfterRecreatedRoundTrip.live === "F22_DELETED_A_BASE\r\n" &&
      deletionAAfterRecreatedRoundTrip.dirty === false &&
      deletionAAfterRecreatedRoundTrip.reloadConflict === false &&
      deletionAAfterRecreatedRoundTrip.deletionTombstone === true &&
      deletionAAfterRecreatedRoundTrip.deletionEventId ===
        deletedAEvent.delivery.eventId, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["watcherOwnership"],
    "F22 owns exactly one actual watcher producer across deletion, recreation rearm, and tab switches", () =>
    deletedAWatcherAtStart.live.length === 1 &&
      deletedAWatcherAtStart.live[0].kind === "fs.watch" &&
      deletedAWatcherAtStart.live[0].filePath === deletedAFile &&
      deletedAWatcherAfterDeletion.live.length === 1 &&
      deletedAWatcherAfterDeletion.live[0].kind === "poll" &&
      deletedAWatcherAfterDeletion.live[0].filePath === deletedAFile &&
      deletedAWatcherAfterDeletion.stops.some(
        (entry) => entry.id === deletedAWatcherAtStart.live[0].id,
      ) &&
      deletedADeletionProducerRetained === true &&
      deletedAWatcherRearmed === true &&
      deletedAWatcherAfterRoundTrip.live.length === 1 &&
      deletedAWatcherAfterRoundTrip.live[0].kind === "fs.watch" &&
      deletedAWatcherAfterRoundTrip.live[0].filePath === deletedAFile &&
      deletedAWatcherAfterRoundTrip.live[0].id !==
        deletedAWatcherAtStart.live[0].id &&
      deletedAProtocol.deliveries.length === 1, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 production deletion delivery rejects closed and distinct replacement generations", () =>
    closedEnvelopeHeld === true && closedDelivered === true && closedDeletedEvent &&
      closedDeletedEvent.delivery && closedDeletedGone === true &&
      closedAcknowledgement && closedAcknowledgement.consumed === false &&
      closedAcknowledgement.why === "owner-closed" &&
      acknowledgementMatchesDelivery(
        closedAcknowledgement,
        closedDeletedEvent.delivery,
      ) &&
      closedAckQuiescence.acceptedAndRetired === true &&
      closedAckQuiescence.mainObservation.recordRetired === true &&
      closedAckQuiescence.mainObservation.recordParked === false &&
      closedAckQuiescence.retired === true &&
      closedAfterMessages === closedBeforeMessages &&
      replacementEnvelopeHeld === true && replacementDelivered === true &&
      replacementDeletedEvent && replacementDeletedEvent.delivery &&
      replacementDeletedEvent.delivery.owner.tabId === replacementDeletedA.id &&
      replacementReloaded === true &&
      replacementAdoption && replacementAdoption.held.length === 1 &&
      replacementCurrentOwner &&
      replacementCurrentOwner.tabId === replacementDeletedA.id &&
      replacementCurrentOwner.documentGeneration !==
        replacementDeletedEvent.delivery.owner.documentGeneration &&
      replacementAcknowledgement && replacementAcknowledgement.consumed === false &&
      replacementAcknowledgement.why === "replacement-owner" &&
      acknowledgementMatchesDelivery(
        replacementAcknowledgement,
        replacementDeletedEvent.delivery,
      ) &&
      replacementAckQuiescence.acceptedAndRetired === true &&
      replacementAckQuiescence.mainObservation.recordRetired === true &&
      replacementAckQuiescence.mainObservation.recordParked === false &&
      replacementAckQuiescence.retired === true &&
      JSON.stringify(replacementAfterStaleDelivery) === JSON.stringify(replacementBefore) &&
      replacementAfterStaleMessages === replacementBeforeMessages &&
      JSON.stringify(replacementAfter) === JSON.stringify(replacementBefore) &&
      replacementAfterMessages === replacementBeforeMessages, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 watcher-driven inactive deletion refusal retains the production owner envelope", () =>
    inactiveFirstDelivered === true &&
      inactiveFirstDelivery &&
      inactiveFirstDelivery.delivery &&
      inactiveFirstDelivery.delivery.owner &&
      inactiveSelectedOwner &&
      inactiveFirstDelivery.delivery.owner.pageSession ===
        inactiveSelectedOwner.pageSession &&
      inactiveFirstDelivery.delivery.owner.rendererGeneration ===
        inactiveSelectedOwner.rendererGeneration &&
      inactiveFirstDelivery.delivery.owner.tabId === inactiveSelectedOwner.tabId &&
      inactiveFirstDelivery.delivery.owner.documentGeneration ===
        inactiveSelectedOwner.documentGeneration &&
      inactiveFirstDelivery.delivery.owner.pathKey === inactiveSelectedOwner.pathKey &&
      inactiveFirstDelivery.delivery.selectionGeneration ===
        inactiveSelectedOwner.selectionGeneration &&
      inactiveBAfterRefusal.content === inactiveBBefore.content &&
      inactiveBAfterRefusal.originalContent === inactiveBBefore.originalContent &&
      inactiveBAfterRefusal.dirty === inactiveBBefore.dirty &&
      inactiveBAfterRefusal.reloadConflict === inactiveBBefore.reloadConflict &&
      inactiveMessagesAfterRefusal === inactiveMessageStart &&
      inactiveInitialAcknowledgement &&
      inactiveInitialAcknowledgement.consumed === false &&
      inactiveInitialAcknowledgement.why === "owner-inactive" &&
      acknowledgementMatchesDelivery(
        inactiveInitialAcknowledgement,
        inactiveFirstDelivery.delivery,
      ) &&
      inactiveInitialMainAcceptance.acceptedAndRetired === true &&
      inactiveInitialMainAcceptance.mainObservation.attemptRetired === true &&
      inactiveInitialMainAcceptance.mainObservation.recordParked === false &&
      inactiveInitialMainAcceptance.mainObservation.watchedOwnerMatchesRecord === false &&
      inactiveInitialMainAcceptance.mainObservation.watchedOwnerIsDistinctTab === true &&
      inactiveInitialMainAcceptance.mainObservation.retryScheduled === false &&
      inactiveInitialMainAcceptance.mainObservation.recordRetired === false &&
      inactiveWatcherMovedToB === true &&
      inactiveRecovery.acknowledgements.some(ack =>
        ack.consumed === false &&
        ack.pageSession === inactiveFirstDelivery.delivery.owner.pageSession &&
        ack.rendererGeneration ===
          inactiveFirstDelivery.delivery.owner.rendererGeneration &&
        ack.tabId === inactiveFirstDelivery.delivery.owner.tabId &&
        ack.documentGeneration ===
          inactiveFirstDelivery.delivery.owner.documentGeneration &&
        ack.pathKey === inactiveFirstDelivery.delivery.owner.pathKey &&
        ack.selectionGeneration ===
          inactiveFirstDelivery.delivery.selectionGeneration &&
        ack.watcherGeneration ===
          inactiveFirstDelivery.delivery.watcherGeneration,
      ) &&
      inactiveAckQuiescence.acceptedAndRetired === true &&
      inactiveAckQuiescence.mainObservation.recordRetired === true &&
      inactiveAckQuiescence.mainObservation.recordParked === false &&
      inactiveAckQuiescence.retired === true, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 watcher-driven inactive deletion replays one event ID and consumes only its valid owner generation", () =>
    inactiveReplayDelivered === true &&
      inactiveRecovery.active === inactiveDeletedA.id &&
    inactiveReplaySelectedOwner &&
      inactiveAAfterConsumption &&
      inactiveAAfterConsumption.dirty === false &&
      inactiveAAfterConsumption.reloadConflict === false &&
      inactiveRecovery.deliveries.length === 2 &&
      inactiveRecovery.deliveries[0].delivery.eventId ===
        inactiveRecovery.deliveries[1].delivery.eventId &&
      inactiveRecovery.deliveries[1].delivery.owner.pageSession ===
        inactiveReplaySelectedOwner.pageSession &&
      inactiveRecovery.deliveries[1].delivery.owner.rendererGeneration ===
        inactiveReplaySelectedOwner.rendererGeneration &&
      inactiveRecovery.deliveries[1].delivery.owner.tabId ===
        inactiveReplaySelectedOwner.tabId &&
      inactiveRecovery.deliveries[1].delivery.owner.documentGeneration ===
        inactiveReplaySelectedOwner.documentGeneration &&
      inactiveRecovery.deliveries[1].delivery.owner.pathKey ===
        inactiveReplaySelectedOwner.pathKey &&
      inactiveRecovery.deliveries[1].delivery.selectionGeneration ===
        inactiveReplaySelectedOwner.selectionGeneration &&
      inactiveRecovery.acknowledgements.some(ack =>
        ack.consumed === true &&
        ack.pageSession === inactiveRecovery.deliveries[1].delivery.owner.pageSession &&
        ack.rendererGeneration ===
          inactiveRecovery.deliveries[1].delivery.owner.rendererGeneration &&
        ack.tabId === inactiveRecovery.deliveries[1].delivery.owner.tabId &&
        ack.documentGeneration ===
          inactiveRecovery.deliveries[1].delivery.owner.documentGeneration &&
        ack.pathKey === inactiveRecovery.deliveries[1].delivery.owner.pathKey &&
        ack.selectionGeneration ===
          inactiveRecovery.deliveries[1].delivery.selectionGeneration &&
        ack.watcherGeneration ===
          inactiveRecovery.deliveries[1].delivery.watcherGeneration,
      ) &&
      acknowledgementsMatchDeliveries(
        [inactiveRecovery.acknowledgements.find(ack => ack && ack.consumed === true)],
        [inactiveRecovery.deliveries[1]],
      ) &&
      inactiveRecovery.messages === inactiveMessageStart + 1 &&
      inactiveAckQuiescence.acceptedAndRetired === true &&
      inactiveAckQuiescence.retired === true, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 stale-selection attempt 1 is accepted, retries exactly once as attempt 2, then has no third delivery for over 4s", () =>
    staleEnvelopeHeld === true &&
      heldStaleDeliveries[0] &&
      heldStaleDeliveries[0].delivery &&
      heldStaleDeliveries[0].delivery.attempt === 1 &&
      staleSelectionAdvance &&
      staleSelectionAdvance.active === staleDeletedA.id &&
      staleSelectionAdvance.wrapperInstalled === true &&
      staleSelectionAdvance.owner &&
      staleSelectionAdvance.owner.tabId === staleDeletedA.id &&
      staleSelectionAdvance.suppressed.length >= 2 &&
      staleSelectionAdvance.suppressed.some(entry =>
        entry.filePath === staleDeletedFile &&
        entry.owner && entry.owner.tabId === staleDeletedA.id) &&
      staleSelectionAdvance.suppressed.some(entry =>
        entry.filePath === deletedBFile &&
        entry.owner && entry.owner.tabId === staleDeletedB.id) &&
      staleInitialRecordBeforeRelease &&
      staleInitialRecordBeforeRelease.count >= 1 &&
      staleInitialRecordBeforeRelease.records.every(record =>
        record.ownerKeyed === true &&
        record.identity &&
        record.identity.eventId ===
          heldStaleDeliveries[0].delivery.eventId &&
        record.attempt &&
        record.attempt.attempt === heldStaleDeliveries[0].delivery.attempt &&
        record.attempt.inFlight === true &&
        record.attempt.ackTimeoutActive === true &&
        record.attempt.retryTimeoutActive === false) &&
      staleSelectionAdvance.owner.selectionGeneration >
        heldStaleDeliveries[0].delivery.selectionGeneration &&
      staleInitialAcknowledged === true &&
      staleInitialAcknowledgement &&
      staleInitialAcknowledgement.consumed === false &&
      staleInitialAcknowledgement.why === "stale-selection" &&
      staleInitialAcknowledgement.attempt === 1 &&
      acknowledgementMatchesDelivery(
        staleInitialAcknowledgement,
        heldStaleDeliveries[0].delivery,
      ) &&
      staleInitialMainAcceptance.acceptedAndRetired === true &&
      staleInitialMainAcceptance.mainObservation.attemptBefore.attempt ===
        1 &&
      staleInitialMainAcceptance.mainObservation.attemptAfter.attempt === 1 &&
      staleInitialMainAcceptance.mainObservation.recordRetired === false &&
      staleInitialMainAcceptance.mainObservation.recordParked === false &&
      staleInitialMainAcceptance.mainObservation.watchedOwnerMatchesRecord === true &&
      staleInitialMainAcceptance.mainObservation.retryScheduled === true &&
      staleRestoreAndReassert &&
      staleRestoreAndReassert.restored === true &&
      staleRestoreAndReassert.reasserted === true &&
      staleRestoreAndReassert.outerProtocolRestored === true &&
      staleRestoreAndReassert.after &&
      staleRestoreAndReassert.after.tabId === staleDeletedA.id &&
      staleSelectionCleanup &&
      staleSelectionCleanup.disabled === true &&
      staleSelectionCleanup.outerProtocolRestored === true &&
      staleReplayed === true &&
      staleRecovery.deliveries.length === 2 &&
      staleRecovery.deliveries.every(entry =>
        entry.delivery.eventId === staleRecovery.deliveries[0].delivery.eventId) &&
      staleRecovery.deliveries[0].delivery.attempt === 1 &&
      staleRecovery.deliveries[1].delivery.attempt === 2 &&
      staleRecovery.deliveries[1].delivery.pageSession ===
        staleRestoreAndReassert.after.pageSession &&
      staleRecovery.deliveries[1].delivery.rendererGeneration ===
        staleRestoreAndReassert.after.rendererGeneration &&
      staleRecovery.deliveries[1].delivery.owner.tabId ===
        staleRestoreAndReassert.after.tabId &&
      staleRecovery.deliveries[1].delivery.owner.documentGeneration ===
        staleRestoreAndReassert.after.documentGeneration &&
      staleRecovery.deliveries[1].delivery.owner.pathKey ===
        staleRestoreAndReassert.after.pathKey &&
      staleRecovery.deliveries[1].delivery.selectionGeneration ===
        staleRestoreAndReassert.after.selectionGeneration &&
      staleRecovery.currentOwner &&
      staleRecovery.currentOwner.selectionGeneration ===
        staleRecovery.deliveries[1].delivery.selectionGeneration &&
      staleTerminalAcknowledgement &&
      staleTerminalAcknowledgement.consumed === true &&
      staleTerminalAcknowledgement.attempt === 2 &&
      acknowledgementMatchesDelivery(
        staleTerminalAcknowledgement,
        staleRecovery.deliveries[1].delivery,
      ) &&
      staleAckQuiescence.acceptedAndRetired === true &&
      staleAckQuiescence.mainObservation.recordRetired === true &&
      staleAckQuiescence.mainObservation.matchingDeliveryRecordRemains === false &&
      staleAckQuiescence.before.deliveries === 2 &&
      staleAckQuiescence.retired === true, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 watcher-driven frozen deletion refusal preserves the real envelope until thaw", () =>
    frozenDeletion &&
      frozenDeletion.ownerTabId === frozenDeletedA.id &&
      Number.isSafeInteger(frozenDeletion.gen) &&
      frozenBeforeDelete === true &&
      frozenFirstDelivered === true &&
      frozenInitialDelivery &&
      frozenRecovery.deliveries[0] &&
      frozenSelectedOwner &&
      frozenRecovery.deliveries[0].delivery.owner.pageSession ===
        frozenSelectedOwner.pageSession &&
      frozenRecovery.deliveries[0].delivery.owner.rendererGeneration ===
        frozenSelectedOwner.rendererGeneration &&
      frozenRecovery.deliveries[0].delivery.owner.tabId === frozenSelectedOwner.tabId &&
      frozenRecovery.deliveries[0].delivery.owner.documentGeneration ===
        frozenSelectedOwner.documentGeneration &&
      frozenRecovery.deliveries[0].delivery.owner.pathKey ===
        frozenSelectedOwner.pathKey &&
      frozenRecovery.deliveries[0].delivery.selectionGeneration ===
        frozenSelectedOwner.selectionGeneration &&
      JSON.stringify(frozenAAfterDelete) === JSON.stringify(frozenAInitial) &&
      frozenMessagesBeforeThaw === frozenMessageCount &&
      frozenInitialAcknowledgement &&
      frozenInitialAcknowledgement.consumed === false &&
      frozenInitialAcknowledgement.why === "frozen" &&
      acknowledgementMatchesDelivery(
        frozenInitialAcknowledgement,
        frozenInitialDelivery.delivery,
      ) &&
      frozenInitialMainAcceptance.acceptedAndRetired === true &&
      frozenInitialMainAcceptance.mainObservation.attemptRetired === true &&
      frozenInitialMainAcceptance.mainObservation.recordParked === true &&
      frozenInitialMainAcceptance.mainObservation.retryScheduled === false &&
      frozenInitialMainAcceptance.mainObservation.recordRetired === false &&
      frozenRecovery.acknowledgements.some(ack =>
        ack.consumed === false &&
        ack.selectionGeneration ===
          frozenRecovery.deliveries[0].delivery.selectionGeneration &&
        ack.watcherGeneration ===
          frozenRecovery.deliveries[0].delivery.watcherGeneration,
      ) &&
      frozenThawed === true &&
      frozenReplayDelivered === true &&
      frozenRecovery.deliveries.length === 2 &&
      frozenRecovery.deliveries[0].delivery.eventId ===
        frozenRecovery.deliveries[1].delivery.eventId &&
      frozenReplaySelectedOwner &&
      frozenRecovery.deliveries[1].delivery.owner.pageSession ===
        frozenReplaySelectedOwner.pageSession &&
      frozenRecovery.deliveries[1].delivery.owner.rendererGeneration ===
        frozenReplaySelectedOwner.rendererGeneration &&
      frozenRecovery.deliveries[1].delivery.owner.tabId ===
        frozenReplaySelectedOwner.tabId &&
      frozenRecovery.deliveries[1].delivery.owner.documentGeneration ===
        frozenReplaySelectedOwner.documentGeneration &&
      frozenRecovery.deliveries[1].delivery.owner.pathKey ===
        frozenReplaySelectedOwner.pathKey &&
      frozenRecovery.deliveries[1].delivery.selectionGeneration ===
        frozenReplaySelectedOwner.selectionGeneration &&
      frozenAAfterThaw &&
      frozenAAfterThaw.dirty === false &&
      frozenAAfterThaw.reloadConflict === false &&
      frozenMessagesAfterThaw === frozenMessageCount + 1 &&
      frozenRecovery.acknowledgements.some(ack =>
        ack.consumed === true &&
        ack.pageSession === frozenRecovery.deliveries[1].delivery.owner.pageSession &&
        ack.rendererGeneration ===
          frozenRecovery.deliveries[1].delivery.owner.rendererGeneration &&
        ack.tabId === frozenRecovery.deliveries[1].delivery.owner.tabId &&
        ack.documentGeneration ===
          frozenRecovery.deliveries[1].delivery.owner.documentGeneration &&
        ack.pathKey === frozenRecovery.deliveries[1].delivery.owner.pathKey &&
        ack.selectionGeneration ===
          frozenRecovery.deliveries[1].delivery.selectionGeneration &&
        ack.watcherGeneration ===
          frozenRecovery.deliveries[1].delivery.watcherGeneration,
      ) &&
      acknowledgementsMatchDeliveries(
        [frozenRecovery.acknowledgements.find(ack => ack && ack.consumed === true)],
        [frozenRecovery.deliveries[1]],
      ) &&
      frozenAckQuiescence.acceptedAndRetired === true &&
      frozenAckQuiescence.mainObservation.recordRetired === true &&
      frozenAckQuiescence.mainObservation.recordParked === false &&
      frozenAckQuiescence.retired === true, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 dropped deletion ACKs replay one producer event, then exactly one ACK crosses to and is accepted by main", () =>
    lostAckReplayed === true && lostAckConsumed === true &&
      lostAckRecovery.active === lostAckTab.id && lostAckRecovery.deliveries.length >= 3 &&
      lostAckRecovery.deliveries.every(entry => entry.delivery &&
        entry.delivery.eventId === lostAckRecovery.deliveries[0].delivery.eventId) &&
      lostAckRecovery.deliveries.every((entry, index, deliveries) =>
        index === 0 ||
        entry.delivery.attempt > deliveries[index - 1].delivery.attempt) &&
      lostAckRecovery.attempted.length >= 3 &&
      lostAckRecovery.dropped.length >= 2 &&
      lostAckRecovery.dropped[0].consumed === true &&
      lostAckRecovery.dropped[0].why === "consumed" &&
      lostAckRecovery.dropped.slice(1).every(ack =>
        ack.consumed === true && ack.why === "already-consumed") &&
      lostAckRecovery.forwarded.length === 1 &&
      lostAckRecovery.forwarded[0].consumed === true &&
      lostAckRecovery.forwarded[0].why === "already-consumed" &&
      lostAckRecovery.attempted.length ===
        lostAckRecovery.dropped.length + lostAckRecovery.forwarded.length &&
      acknowledgementsMatchDeliveries(
        lostAckRecovery.attempted,
        lostAckRecovery.deliveries,
      ) &&
      lostAckTimersTerminated === true &&
      lostAckQuiescence.acceptedAndRetired === true &&
      lostAckQuiescence.mainObservation.recordRetired === true &&
      lostAckQuiescence.mainObservation.recordParked === false &&
      lostAckQuiescence.retired === true &&
      lostAckRecovery.messages === lostAckMessageStart + 1, () =>
    JSON.stringify({ deletionDetail: JSON.parse(deletionDetail()), lostAckTimersTerminated })
  );
  if (catchesDeletionSendFailure) checkDeletionEvidence(
    ["synchronousSendRecovery"],
    "F22 watcher-driven synchronous deletion send failure retains evidence and retries the same event ID", () =>
    catchesDeletionSendFailure === true &&
      throwObserved === true &&
      thrownDeletionPayload &&
      thrownDeletionPayload.delivery &&
      throwRecovered === true &&
      throwRecovery.active === throwDeletedTab.id &&
      throwRecovery.delivery &&
      throwRecovery.delivery.delivery &&
      throwRecovery.delivery.delivery.eventId === thrownDeletionPayload.delivery.eventId &&
      throwRecovery.delivery.delivery.attempt > thrownDeletionPayload.delivery.attempt &&
      throwRecovery.acknowledgements.filter(ack => ack.consumed === true).length === 1 &&
      throwRecovery.acknowledgements.find(ack => ack && ack.consumed === true).why ===
        "consumed" &&
      acknowledgementsMatchDeliveries(
        throwRecovery.acknowledgements,
        [throwRecovery.delivery],
      ) &&
      throwAckQuiescence.acceptedAndRetired === true &&
      throwAckQuiescence.mainObservation.recordRetired === true &&
      throwAckQuiescence.mainObservation.recordParked === false &&
      throwAckQuiescence.retired === true &&
      throwRecovery.messages === throwMessageStart + 1, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["rendererTombstoneCache"],
    "F22 deletion tombstone cannot adopt or save an externally recreated path", () =>
    replacementSave &&
      replacementSave.timedOut === false &&
      replacementSave.result &&
      replacementSave.filePath === deletedAFile &&
      replacementSave.result.path === deletedAFile &&
      replacementSave.result.success === false &&
      replacementSave.result.conflict === true &&
      replacementBytesAfterSave === "F22_DELETED_A_EXTERNAL_REPLACEMENT\r\n" &&
      replacementConflictAfterSave &&
      replacementConflictAfterSave.dirty === false &&
      replacementConflictAfterSave.reloadConflict === false &&
      replacementConflictAfterSave.deletionTombstone === true &&
      replacementConflictAfterSave.deletionEventId ===
        deletedAEvent.delivery.eventId, () =>
    deletionDetail()
  );
  checkDeletionEvidence(
    ["rendererTombstoneCache"],
    "F22 explicit reload is the only path that adopts recreated deletion bytes", () =>
    explicitReplacementAdopted === true &&
      replacementAfterExplicitAdoption &&
      replacementAfterExplicitAdoption.content === "F22_DELETED_A_EXTERNAL_REPLACEMENT\r\n" &&
      replacementAfterExplicitAdoption.originalContent === "F22_DELETED_A_EXTERNAL_REPLACEMENT\r\n" &&
      replacementAfterExplicitAdoption.dirty === false &&
      replacementAfterExplicitAdoption.reloadConflict === false &&
      replacementAfterExplicitAdoption.deletionTombstone === false &&
      replacementAfterExplicitAdoption.deletionEventId === 0, () =>
    deletionDetail()
  );
  const deletionIpcWrapperCleanup = await exec(`
    (() => {
      const ipc = require("electron").ipcRenderer;
      const protocol = window.__f22DeletionProtocolProbe;
      const replacement = window.__f22ReplacementAdoptionProbe;
      const stale = window.__f22StaleSelectionProbe;
      window.__f22DeletionObserver && window.__f22DeletionObserver.disconnect();
      // Inner wrappers were constructed after the outer protocol wrapper, so
      // they must restore first. Their idempotent identity checks cannot put
      // the protocol wrapper back after it has been removed.
      const replacementFirst = replacement ? replacement.restore() : null;
      const staleFirst = stale ? stale.restore() : null;
      const outerFirst = protocol ? protocol.restore() : null;
      const preProbeRestored = !!protocol && ipc.send === protocol.originalSend;
      const replacementAgain = replacement ? replacement.restore() : null;
      const staleAgain = stale ? stale.restore() : null;
      const outerAgain = protocol ? protocol.restore() : null;
      return {
        replacementFirst,
        staleFirst,
        outerFirst,
        replacementAgain,
        staleAgain,
        outerAgain,
        replacementDisabled: !replacement || replacement.enabled === false,
        staleDisabled: !stale || stale.enabled === false,
        preProbeRestored,
        noWrapperReinstalled: !!protocol && ipc.send === protocol.originalSend,
      };
    })()
  `);
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 nested deletion IPC wrappers restore in reverse order and remain unable to reinstall after cleanup", () =>
    deletionIpcWrapperCleanup &&
      deletionIpcWrapperCleanup.outerFirst === true &&
      deletionIpcWrapperCleanup.preProbeRestored === true &&
      deletionIpcWrapperCleanup.noWrapperReinstalled === true &&
      deletionIpcWrapperCleanup.replacementDisabled === true &&
      deletionIpcWrapperCleanup.staleDisabled === true &&
      deletionIpcWrapperCleanup.replacementAgain === false &&
      deletionIpcWrapperCleanup.staleAgain === false &&
      deletionIpcWrapperCleanup.outerAgain === false, () =>
    JSON.stringify(deletionIpcWrapperCleanup)
  );
  if (mainDeletionAckProbe) {
    mainDeletionAckProbe.restore();
    mainDeletionAckProbeRestored = true;
  }
  const deletionAckListenerSequenceRestored =
    mainDeletionAckProbe && mainDeletionAckProbe.listenerSequenceIntact();
  await clearTabs();
  await sleep(50);
  const deletionWatcherAfterFinalClose = watcherProbe.snapshot();
  checkDeletionEvidence(
    ["watcherOwnership"],
    "F22 deletion watcher instrumentation observes producer stop after the final tab closes", () =>
    deletionWatcherAfterFinalClose.live.length === 0, () =>
    JSON.stringify(deletionWatcherAfterFinalClose)
  );
  checkDeletionEvidence(
    ["acknowledgementLifecycle"],
    "F22 ACK observation preserves the exact production listener sequence and identity", () =>
    deletionAckListenerSequenceRestored === true, () =>
    JSON.stringify({ deletionAckListenerSequenceRestored })
  );
  } finally {
    // Reverse construction order. Every wrapper delegates unchanged while
    // installed; this path also covers partial construction and thrown cases.
    try {
      await exec(`
        window.__f22DeletionObserver && window.__f22DeletionObserver.disconnect();
        window.__f22ReplacementAdoptionProbe && window.__f22ReplacementAdoptionProbe.restore();
        window.__f22StaleSelectionProbe && window.__f22StaleSelectionProbe.restore();
        window.__f22OwnerPathMovedDeliveryProbe &&
          window.__f22OwnerPathMovedDeliveryProbe.restore();
        window.__f22DeletionProtocolProbe && window.__f22DeletionProtocolProbe.restore();
        null;
      `);
    } catch {}
    try {
      if (mainDeletionAckProbe && !mainDeletionAckProbeRestored) {
        mainDeletionAckProbe.restore();
      }
      else if (restoreMainDeletionAckConstruction) {
        restoreMainDeletionAckConstruction();
      }
    } finally {
      if (watcherProbe) watcherProbe.restore();
      else if (restoreWatcherConstruction) restoreWatcherConstruction();
      f22WatcherProbe = null;
    }
  }
  });

  // ---- F22 regression: stale save failures cannot roll back newer success --
  if (!deletionProductionPrerequisite.saveResultCorrelation) {
    reportDeletionCapability(
      "F22 ordered save-result acceptance evidence requires saveRequest production support",
      classifyDeletionCapability(
        /\bsaveRequest\b/.test(saveHandlerSource),
        deletionProductionPrerequisite.saveResultCorrelation,
      ),
      JSON.stringify({
        saveResultCorrelation: deletionProductionPrerequisite.saveResultCorrelation,
      }),
    );
  } else {
  // Manufacture the two replies in reverse order. The real save entry and its
  // pending promise are used; only IPC transport is held, so this has no race
  // against disk scheduling and cannot show a native failure dialog.
  const orderedSaveFile = path.join(dir, "f22-stale-save-order.md");
  fs.writeFileSync(orderedSaveFile, "F22_SAVE_ORDER_BASE\r\n", "utf8");
  await clearTabs();
  const orderedSaveTab = await createActiveTab(
    orderedSaveFile,
    "F22_SAVE_ORDER_BASE\r\n",
  );
  const heldOrderedSaveResults = [];
  const realOrderedSaveSend = wc.send;
  const restoreOrderedSaveSend = replaceMethod(wc, "send", function(channel, ...args) {
    if (channel === "save-markdown-result") {
      heldOrderedSaveResults.push(args[0]);
      return undefined;
    }
    return realOrderedSaveSend.call(this, channel, ...args);
  });
  // Make A, C and E genuinely fail in main's ordinary save path. B and D run
  // the ordinary write implementation. Replies remain main-produced and are held
  // only at wc.send, so their IDs cannot be fabricated by this test.
  const realOrderedSaveOpen = fs.promises.open;
  let orderedOpenCount = 0;
  const restoreOrderedSaveOpen = replaceMethod(fs.promises, "open", async (candidate, flags, ...args) => {
    if (candidate === orderedSaveFile && flags === "r+") {
      orderedOpenCount += 1;
      if ([1, 3, 5].includes(orderedOpenCount)) {
        throw Object.assign(new Error(`EACCES: controlled ordered save failure for '${candidate}'`), {
          code: "EACCES", path: candidate,
        });
      }
    }
    return realOrderedSaveOpen(candidate, flags, ...args);
  });
  const orderedSnapshot = () => exec(`
    (() => {
      const tab = window.CustomTabs.getTabs().find(tab => tab.id === ${orderedSaveTab.id});
      const state = tab && window.CustomTabs.__documentState(tab);
      return tab ? {
        id: tab.id, activeTabId: window.CustomTabs.getActiveTabId(),
        content: tab.content, original: tab.originalContent, dirty: tab.hasUnsavedChanges,
        originalMarkdown: window.originalMarkdown,
        editor: window.markdownEditor ? window.markdownEditor.value : null,
        editMode: window.CustomTabs.__inEditMode(),
        documentState: state,
        deletionTombstone: !!(state && state.deletionTombstone),
        failedSaves: saveFailedFor(${JSON.stringify(orderedSaveFile)}),
        reloadConflict: !!(state && state.reloadConflict),
        reloadDiagnostics: window.getReloadRequestDiagnostics(),
        pending: window.getPendingSaveStatus(${JSON.stringify(orderedSaveFile)}),
        shutdownDirty: window.CustomTabs.__dirtyTabNames(),
        selection: window.CustomTabs.getActiveDocumentIdentity(
          ${JSON.stringify(orderedSaveFile)}, window.getReloadRequestSession()),
        disk: window.fs.readFileSync(${JSON.stringify(orderedSaveFile)}, "utf8"),
        notification: (() => {
          const toast = document.getElementById("notificationToast");
          const message = document.getElementById("notificationMessage");
          return { visible: !!(toast && toast.classList.contains("show")), text: message ? message.textContent : null };
        })(),
        alerts: window.__f22OrderedSaveProbe.alerts.slice(),
        alertCount: window.__f22OrderedSaveProbe.alerts.length,
        controls: window.__f22OrderedSaveProbe.controls.slice(),
        controlCount: window.__f22OrderedSaveProbe.controls.length,
        notifications: window.__f22OrderedSaveProbe.notifications.slice(),
        notificationCount: window.__f22OrderedSaveProbe.notifications.length,
        saveSettlementEvents: window.__f22OrderedSaveProbe.saveSettlementEvents.slice(),
        saveResultObservations: window.__f22OrderedSaveProbe.saveResultObservations.slice(),
      } : null;
    })()
  `);
  const stableOrderedSnapshot = (snapshot) => {
    if (!snapshot) return snapshot;
    const { saveResultObservations, ...stable } = snapshot;
    return stable;
  };
  let producerCapturedSaves = null;
  let orderedSaveEvidence = null;
  try {
    producerCapturedSaves = await exec(`
      (() => {
        const ipc = require("electron").ipcRenderer;
        const tab = window.CustomTabs.getTabs().find(tab => tab.id === ${orderedSaveTab.id});
        const originalAlert = window.alert;
        const originalSend = ipc.send;
        const notificationMessage = document.getElementById("notificationMessage");
        const probe = window.__f22OrderedSaveProbe = {
          requests: [], controls: [], alerts: [], notifications: [], saveSettlementEvents: [],
          saveResultObservations: [],
        };
        const onPendingSaveStatusChange = () =>
          probe.saveSettlementEvents.push(window.getPendingSaveStatus(${JSON.stringify(orderedSaveFile)}));
        const onSaveResult = (_event, result) => {
          if (!result || !result.requestId) return;
          const status = window.getPendingSaveStatus(${JSON.stringify(orderedSaveFile)});
          probe.saveResultObservations.push({
            requestId: result.requestId,
            sequence: result.saveRequest && result.saveRequest.sequence,
            success: result.success,
            pending: status.count,
            alertCount: probe.alerts.length,
          });
        };
        const notificationObserver = new MutationObserver(() =>
          probe.notifications.push(notificationMessage ? notificationMessage.textContent : ""));
        window.addEventListener("folia-pending-save-status-changed", onPendingSaveStatusChange);
        ipc.on("save-markdown-result", onSaveResult);
        if (notificationMessage) {
          notificationObserver.observe(notificationMessage, {
            childList: true, characterData: true, subtree: true,
          });
        }
        window.__f22OrderedSaveCleanup = () => {
          ipc.send = originalSend;
          window.alert = originalAlert;
          window.removeEventListener("folia-pending-save-status-changed", onPendingSaveStatusChange);
          ipc.removeListener("save-markdown-result", onSaveResult);
          notificationObserver.disconnect();
        };
        try {
          if (!tab) return { setupFailed: "ordered save tab is absent" };
          window.alert = message => probe.alerts.push(String(message));
          ipc.send = function(channel, ...args) {
            if (channel === "save-markdown-file") probe.requests.push(args[0]);
            if (["pause-file-watching", "resume-file-watching", "set-active-file"].includes(channel)) {
              probe.controls.push({ channel, payload: args[0] || null });
            }
            return originalSend.call(this, channel, ...args);
          };
          window.originalMarkdown = "F22_SAVE_A_OLDER";
          tab.content = window.originalMarkdown;
          document.getElementById("saveButton").click();
          window.originalMarkdown = "F22_SAVE_B_NEWER";
          tab.content = window.originalMarkdown;
          document.getElementById("saveButton").click();
          return { requests: probe.requests };
        } catch (error) {
          window.__f22OrderedSaveCleanup();
          return { setupFailed: String(error && error.stack ? error.stack : error) };
        }
      })()
    `);
    const capturedAB = await waitUntil(() => heldOrderedSaveResults.length === 2, 5000);
    const requests = producerCapturedSaves && producerCapturedSaves.requests || [];
    const requestA = requests[0];
    const requestB = requests[1];
    const resultFor = (request) => heldOrderedSaveResults.find(result =>
      result && request && result.requestId === request.requestId);
    const resultA = resultFor(requestA);
    const resultB = resultFor(requestB);
    const capturedIdentity = (request, result) => !!(
      request && result && request.saveRequest &&
      request.saveRequest.requestId === request.requestId &&
      Number.isSafeInteger(request.saveRequest.sequence) && request.saveRequest.sequence > 0 &&
      Number.isSafeInteger(request.saveRequest.selectionGeneration) && request.saveRequest.selectionGeneration > 0 &&
      result.requestId === request.requestId && result.saveRequestSession === request.saveRequestSession &&
      result.saveRequest && result.saveRequest.requestId === request.saveRequest.requestId &&
      result.saveRequest.sequence === request.saveRequest.sequence &&
      result.saveRequest.pageSession === request.saveRequest.pageSession &&
      result.saveRequest.tabId === request.saveRequest.tabId &&
      result.saveRequest.documentGeneration === request.saveRequest.documentGeneration &&
      result.saveRequest.pathKey === request.saveRequest.pathKey &&
      result.saveRequest.selectionGeneration === request.saveRequest.selectionGeneration
    );
    if (resultB) realOrderedSaveSend.call(wc, "save-markdown-result", resultB);
    const newerApplied = await waitForCondition(exec,
      `window.CustomTabs.getTabs().find(tab => tab.id === ${orderedSaveTab.id})?.originalContent === "F22_SAVE_B_NEWER"`, 5000);
    const afterNewerSuccess = await orderedSnapshot();
    await exec(`window.__f22OrderedSaveProbe.controls.length = 0; null;`);
    if (resultA) realOrderedSaveSend.call(wc, "save-markdown-result", resultA);
    const staleSettled = await waitForCondition(exec,
      `window.getPendingSaveStatus(${JSON.stringify(orderedSaveFile)}).count === 0`, 5000);
    const afterStaleFailure = await orderedSnapshot();
    // Re-deliver the actual A failure to cover duplicate transport delivery;
    // no synthetic result identity is introduced.
    if (resultA) realOrderedSaveSend.call(wc, "save-markdown-result", resultA);
    const afterDuplicateStaleFailure = await orderedSnapshot();

    await exec(`
      const tab = window.CustomTabs.getTabs().find(tab => tab.id === ${orderedSaveTab.id});
      window.originalMarkdown = "F22_SAVE_C_LATEST_FAILURE"; tab.content = window.originalMarkdown;
      document.getElementById("saveButton").click(); null;
    `);
    const capturedC = await waitUntil(() => heldOrderedSaveResults.length === 3, 5000);
    const requestC = await exec(`window.__f22OrderedSaveProbe.requests[2] || null`);
    const resultC = heldOrderedSaveResults[2];
    const capturedIdentityC = capturedIdentity(requestC, resultC);
    if (resultC) realOrderedSaveSend.call(wc, "save-markdown-result", resultC);
    const latestFailureApplied = await waitForCondition(exec,
      `saveFailedFor(${JSON.stringify(orderedSaveFile)}) === true`, 5000);
    const afterFirstCAcceptedFailure = await orderedSnapshot();
    // Re-deliver C through the same main-to-renderer delivery path. Unlike A,
    // C is the current failure that was accepted and settled above.
    if (resultC) realOrderedSaveSend.call(wc, "save-markdown-result", resultC);
    await exec(`new Promise(resolve => setTimeout(() => resolve(null), 0))`);
    const afterDuplicateCAcceptedFailure = await orderedSnapshot();

    await exec(`
      const tab = window.CustomTabs.getTabs().find(tab => tab.id === ${orderedSaveTab.id});
      window.originalMarkdown = "F22_SAVE_D_OLDER_SUCCESS"; tab.content = window.originalMarkdown;
      document.getElementById("saveButton").click();
      window.originalMarkdown = "F22_SAVE_E_NEWER_FAILURE"; tab.content = window.originalMarkdown;
      document.getElementById("saveButton").click(); null;
    `);
    const capturedDE = await waitUntil(() => heldOrderedSaveResults.length === 5, 5000);
    const requestD = await exec(`window.__f22OrderedSaveProbe.requests[3] || null`);
    const requestE = await exec(`window.__f22OrderedSaveProbe.requests[4] || null`);
    const resultD = resultFor(requestD);
    const resultE = resultFor(requestE);
    const capturedIdentityD = capturedIdentity(requestD, resultD);
    const capturedIdentityE = capturedIdentity(requestE, resultE);
    const beforeEFailure = await orderedSnapshot();
    await exec(`window.__f22OrderedSaveProbe.controls.length = 0; null;`);
    if (resultE) realOrderedSaveSend.call(wc, "save-markdown-result", resultE);
    // C has already established saveFailedFor(), so it cannot establish that
    // E was accepted.  E must retire only its own pending request and produce
    // a fresh failure-visible transition before older D is delivered.
    const newerFailureApplied = await waitForCondition(exec,
      `window.getPendingSaveStatus(${JSON.stringify(orderedSaveFile)}).count === 1 &&
       window.__f22OrderedSaveProbe.alerts.length > ${beforeEFailure.alertCount}`, 5000);
    const afterNewerFailure = await orderedSnapshot();
    if (resultD) realOrderedSaveSend.call(wc, "save-markdown-result", resultD);
    const oldSuccessSettled = await waitForCondition(exec,
      `window.getPendingSaveStatus(${JSON.stringify(orderedSaveFile)}).count === 0`, 5000);
    const afterOldSuccess = await orderedSnapshot();
    orderedSaveEvidence = {
      capturedAB, capturedC, capturedDE, requests,
      requestA, requestB, requestC, requestD, requestE,
      resultA, resultB, resultC, resultD, resultE,
      capturedIdentityA: capturedIdentity(requestA, resultA), capturedIdentityB: capturedIdentity(requestB, resultB),
      capturedIdentityC, capturedIdentityD, capturedIdentityE, beforeEFailure,
      newerApplied, staleSettled, latestFailureApplied, newerFailureApplied, oldSuccessSettled,
      afterNewerSuccess, afterStaleFailure, afterDuplicateStaleFailure,
      afterFirstCAcceptedFailure, afterDuplicateCAcceptedFailure,
      afterNewerFailure, afterOldSuccess, orderedOpenCount,
      disk: fs.readFileSync(orderedSaveFile, "utf8"),
    };
  } finally {
    restoreOrderedSaveOpen();
    restoreOrderedSaveSend();
    await exec(`window.__f22OrderedSaveCleanup && window.__f22OrderedSaveCleanup(); delete window.__f22OrderedSaveCleanup; null;`);
  }
  const orderedSaveDetail = JSON.stringify(orderedSaveEvidence);
  check(
    "F22 genuine main failure A is held behind newer producer-backed success B with complete correlation",
    orderedSaveEvidence && orderedSaveEvidence.capturedAB === true && orderedSaveEvidence.orderedOpenCount === 5 &&
      orderedSaveEvidence.capturedIdentityA === true && orderedSaveEvidence.capturedIdentityB === true &&
      orderedSaveEvidence.resultA.success === false && orderedSaveEvidence.resultB.success === true &&
      orderedSaveEvidence.requests[1].saveRequest.sequence > orderedSaveEvidence.requests[0].saveRequest.sequence &&
      orderedSaveEvidence.newerApplied === true && orderedSaveEvidence.afterNewerSuccess.content === "F22_SAVE_B_NEWER" &&
      orderedSaveEvidence.afterNewerSuccess.original === "F22_SAVE_B_NEWER" &&
      orderedSaveEvidence.afterNewerSuccess.dirty === false &&
      orderedSaveEvidence.afterNewerSuccess.disk === "F22_SAVE_B_NEWER",
    orderedSaveDetail,
  );
  check(
    "F22 stale genuine A failure and its duplicate cannot change B content, baseline, dirty state, conflicts, alerts, selection, watcher or pending correlation",
    orderedSaveEvidence && orderedSaveEvidence.staleSettled === true &&
      JSON.stringify(stableOrderedSnapshot(orderedSaveEvidence.afterStaleFailure)) ===
        JSON.stringify(stableOrderedSnapshot(orderedSaveEvidence.afterDuplicateStaleFailure)) &&
      orderedSaveEvidence.afterStaleFailure.content === "F22_SAVE_B_NEWER" &&
      orderedSaveEvidence.afterStaleFailure.original === "F22_SAVE_B_NEWER" &&
      orderedSaveEvidence.afterStaleFailure.dirty === false && orderedSaveEvidence.afterStaleFailure.failedSaves === false &&
      orderedSaveEvidence.afterStaleFailure.reloadConflict === false &&
      orderedSaveEvidence.afterStaleFailure.reloadDiagnostics.conflicts.length === 0 &&
      orderedSaveEvidence.afterStaleFailure.pending.count === 0 &&
      orderedSaveEvidence.afterStaleFailure.shutdownDirty.length === 0 &&
      orderedSaveEvidence.afterStaleFailure.disk === "F22_SAVE_B_NEWER" &&
      JSON.stringify(orderedSaveEvidence.afterStaleFailure.selection) ===
        JSON.stringify(orderedSaveEvidence.afterNewerSuccess.selection) &&
      JSON.stringify(orderedSaveEvidence.afterStaleFailure.notification) ===
        JSON.stringify(orderedSaveEvidence.afterNewerSuccess.notification) &&
      orderedSaveEvidence.afterStaleFailure.alerts.length === 0 &&
      orderedSaveEvidence.afterStaleFailure.controls.length === 0,
    orderedSaveDetail,
  );
  check(
    "F22 accepted current C failure duplicate is idempotent across document/editor and baseline, dirty/conflict/tombstone state, active selection, watcher controls, save settlement, alerts and notifications",
    orderedSaveEvidence && orderedSaveEvidence.capturedC === true &&
      orderedSaveEvidence.capturedIdentityC === true &&
      orderedSaveEvidence.resultC.success === false &&
      orderedSaveEvidence.latestFailureApplied === true &&
      JSON.stringify(stableOrderedSnapshot(orderedSaveEvidence.afterFirstCAcceptedFailure)) ===
        JSON.stringify(stableOrderedSnapshot(orderedSaveEvidence.afterDuplicateCAcceptedFailure)) &&
      orderedSaveEvidence.afterDuplicateCAcceptedFailure.saveResultObservations.length ===
        orderedSaveEvidence.afterFirstCAcceptedFailure.saveResultObservations.length + 1 &&
      orderedSaveEvidence.afterDuplicateCAcceptedFailure.saveResultObservations.at(-1).requestId ===
        orderedSaveEvidence.requestC.requestId &&
      orderedSaveEvidence.afterDuplicateCAcceptedFailure.saveResultObservations.at(-1).pending === 0 &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.id === orderedSaveTab.id &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.activeTabId === orderedSaveTab.id &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.content === "F22_SAVE_C_LATEST_FAILURE" &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.original === "F22_SAVE_B_NEWER" &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.dirty === true &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.documentState.dirty === true &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.failedSaves === true &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.reloadConflict === false &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.deletionTombstone === false &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.reloadDiagnostics.conflicts.length === 0 &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.pending.count === 0 &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.saveSettlementEvents.length > 0 &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.saveSettlementEvents.at(-1).count === 0 &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.shutdownDirty.length > 0 &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.alertCount >= 1 &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.alertCount ===
        orderedSaveEvidence.afterDuplicateCAcceptedFailure.alertCount &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.notificationCount ===
        orderedSaveEvidence.afterDuplicateCAcceptedFailure.notificationCount &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.controlCount ===
        orderedSaveEvidence.afterDuplicateCAcceptedFailure.controlCount &&
      orderedSaveEvidence.afterFirstCAcceptedFailure.disk === "F22_SAVE_B_NEWER",
    orderedSaveDetail,
  );
  check(
    "F22 E failure has an event-specific acceptance transition before older D can settle",
    orderedSaveEvidence && orderedSaveEvidence.capturedDE === true &&
      orderedSaveEvidence.capturedIdentityD === true &&
      orderedSaveEvidence.capturedIdentityE === true &&
      orderedSaveEvidence.resultD.success === true &&
      orderedSaveEvidence.resultE.success === false &&
      orderedSaveEvidence.requestE.saveRequest.sequence >
        orderedSaveEvidence.requestD.saveRequest.sequence &&
      orderedSaveEvidence.beforeEFailure.failedSaves === true &&
      orderedSaveEvidence.beforeEFailure.pending.count === 2 &&
      orderedSaveEvidence.newerFailureApplied === true &&
      orderedSaveEvidence.afterNewerFailure.pending.count === 1 &&
      orderedSaveEvidence.afterNewerFailure.alertCount >
        orderedSaveEvidence.beforeEFailure.alertCount &&
      orderedSaveEvidence.afterNewerFailure.saveSettlementEvents.length >
        orderedSaveEvidence.beforeEFailure.saveSettlementEvents.length &&
      orderedSaveEvidence.afterNewerFailure.saveSettlementEvents.at(-1).count === 1 &&
      orderedSaveEvidence.afterNewerFailure.saveResultObservations.some(
        (observation) =>
          observation.requestId === orderedSaveEvidence.requestE.requestId &&
          observation.sequence ===
            orderedSaveEvidence.requestE.saveRequest.sequence &&
          observation.success === false &&
          observation.pending === 1 &&
          observation.alertCount > orderedSaveEvidence.beforeEFailure.alertCount,
      ) &&
      orderedSaveEvidence.oldSuccessSettled === true &&
      orderedSaveEvidence.afterNewerFailure.content === "F22_SAVE_E_NEWER_FAILURE" &&
      orderedSaveEvidence.afterOldSuccess.content === "F22_SAVE_E_NEWER_FAILURE" &&
      orderedSaveEvidence.afterOldSuccess.original === "F22_SAVE_B_NEWER" &&
      orderedSaveEvidence.afterOldSuccess.dirty === true && orderedSaveEvidence.afterOldSuccess.failedSaves === true &&
      orderedSaveEvidence.afterOldSuccess.reloadConflict === false &&
      orderedSaveEvidence.afterOldSuccess.pending.count === 0 &&
      orderedSaveEvidence.afterOldSuccess.shutdownDirty.length > 0,
    orderedSaveDetail,
  );
  }
  if (f22WatcherProbe) {
    f22WatcherProbe.restore();
    f22WatcherProbe = null;
  }

  // Notification mutations are the user-visible oracle. A stale result is
  // released only after a newer reload request has superseded it; it must not
  // announce success, while the accepted newer result must announce once.
  const notificationProbe = await exec(`
    (() => {
      const message = document.getElementById("notificationMessage");
      window.__f22ReloadToasts = [];
      window.__f22ReloadObserver && window.__f22ReloadObserver.disconnect();
      window.__f22ReloadObserver = new MutationObserver(() =>
        window.__f22ReloadToasts.push(message ? message.textContent : ""));
      if (message) window.__f22ReloadObserver.observe(message, { childList: true, characterData: true, subtree: true });
      return !!message;
    })()
  `);
  const toastCount = () => exec(`window.__f22ReloadToasts.filter(m => /reloaded successfully/i.test(m)).length`);
  const tabSnapshot = (tabId) => exec(`
    (() => {
      const tabs = window.CustomTabs;
      const hasStateSeam = !!(tabs && typeof tabs.__documentState === "function");
      const hasIdentitySeam = !!(tabs && typeof tabs.getActiveDocumentIdentity === "function");
      const tab = tabs && typeof tabs.getTabs === "function"
        ? tabs.getTabs().find(t => t.id === ${tabId})
        : null;
      const state = tab && hasStateSeam ? tabs.__documentState(tab) : null;
      return tab ? {
        id: tab.id,
        active: tabs.getActiveTab() && tabs.getActiveTab().id,
        content: tab.content,
        originalContent: tab.originalContent,
        live: window.originalMarkdown,
        dirty: tab.hasUnsavedChanges,
        reloadConflict: !!(state && state.reloadConflict),
        documentState: state,
        activeIdentity: hasIdentitySeam
          ? tabs.getActiveDocumentIdentity(tab.filePath, window.getReloadRequestSession())
          : null,
        reloadDiagnostics: typeof window.getReloadRequestDiagnostics === "function"
          ? window.getReloadRequestDiagnostics()
          : null,
        hasStateSeam,
        hasIdentitySeam,
        notifications: window.__f22ReloadToasts.length,
      } : null;
    })()
  `);
  const allToastCount = () => exec(`window.__f22ReloadToasts.length`);
  const failedToastCount = () => exec(
    `window.__f22ReloadToasts.filter(m => /failed to reload file/i.test(m)).length`,
  );
  const freezeForF22 = async (id) => {
    const frozen = await exec(`
      (async () => {
        const ipc = require("electron").ipcRenderer;
        const gen = await ipc.invoke("quit-approval-generation");
        const revision = window.CustomTabs.__shutdownFreeze().revision;
        // Drive the actual renderer listeners, not an ipcMain round-trip: this
        // focused scenario owns only CustomTabs' phase-two freeze boundary.
        ipc.emit("quit-approval-request", {}, { id: ${'${id}'}, gen, retainFreeze: true });
        ipc.emit("quit-approval-commit", {}, { id: ${'${id}'}, gen, revision });
        return { gen, revision };
      })()
    `.replaceAll("${id}", String(id)));
    const ready = await waitForCondition(
      exec,
      `window.CustomTabs.__shutdownFreeze().frozen === true`,
      5000,
    );
    return { frozen, ready, state: await exec(`window.CustomTabs.__shutdownFreeze()`) };
  };
  const thawForF22 = async () => {
    await exec(`require("electron").ipcRenderer.emit("quit-approval-thaw", {}); null;`);
    return waitForCondition(exec, `window.CustomTabs.__shutdownFreeze().frozen === false`, 5000);
  };

  fs.writeFileSync(closeFile, "F22_RELOAD_FOREGROUND", "utf8");
  await exec(`window.reloadCurrentFile(); null;`);
  await sleep(1300);
  const foregroundToasts = await toastCount();
  const heldReloadResults = [];
  const realReloadSend = wc.send;
  const restoreReloadSend = replaceMethod(wc, "send", function (channel, ...args) {
    if (channel === "file-reload-result") {
      heldReloadResults.push(args[0]);
      return;
    }
    return realReloadSend.call(this, channel, ...args);
  });
  let staleHeld;
  try {
    fs.writeFileSync(closeFile, "F22_RELOAD_STALE", "utf8");
    await exec(`window.reloadCurrentFile(); null;`);
    staleHeld = await waitUntil(() => heldReloadResults.length === 1, 5000);
    fs.writeFileSync(closeFile, "F22_RELOAD_CURRENT", "utf8");
    await exec(`window.reloadCurrentFile(); null;`);
    const currentHeld = await waitUntil(() => heldReloadResults.length === 2, 5000);
    const supersededTabId = await exec(
      `window.CustomTabs.getActiveTab() && window.CustomTabs.getActiveTab().id`,
    );
    const beforeStaleDelivery = await tabSnapshot(supersededTabId);
    if (heldReloadResults[0]) realReloadSend.call(wc, "file-reload-result", heldReloadResults[0]);
    await sleep(250);
    const afterStaleDelivery = await tabSnapshot(supersededTabId);
    const afterStaleToastCount = await toastCount();
    if (heldReloadResults[1]) realReloadSend.call(wc, "file-reload-result", heldReloadResults[1]);
    await sleep(1300);
    const afterCurrentToastCount = await toastCount();
    if (!deletionProductionPrerequisite.reloadOwnerIdentity) {
      reportDeletionCapability(
        "F22 foreground reload toast ordering requires active document identity support",
        deletionCapabilityContracts.reloadOwner,
        JSON.stringify({
          reloadOwnerIdentity: deletionProductionPrerequisite.reloadOwnerIdentity,
        }),
      );
    } else check(
      "F22 a superseded reload completion produces no stale success toast while the accepted foreground reload produces exactly one",
      notificationProbe === true &&
        staleHeld === true &&
        currentHeld === true &&
        beforeStaleDelivery &&
        beforeStaleDelivery.hasStateSeam === true &&
        beforeStaleDelivery.hasIdentitySeam === true &&
        JSON.stringify({ ...afterStaleDelivery, notifications: 0 }) ===
          JSON.stringify({ ...beforeStaleDelivery, notifications: 0 }) &&
        afterStaleToastCount === foregroundToasts &&
        afterCurrentToastCount === foregroundToasts + 1,
      JSON.stringify({
        foregroundToasts,
        beforeStaleDelivery,
        afterStaleDelivery,
        afterStaleToastCount,
        afterCurrentToastCount,
        held: heldReloadResults.length,
      }),
    );

    // A result that arrives after a tab switch is accepted as a background
    // refresh, not stale. It must therefore notify once; a real failed reload
    // immediately afterwards must not add another success notification.
    const backgroundFile = path.join(dir, "f22-reload-background.md");
    fs.writeFileSync(backgroundFile, "F22_BACKGROUND_BASE", "utf8");
    const backgroundTab = await exec(
      `window.CustomTabs.createTab(${JSON.stringify(backgroundFile)}, "F22_BACKGROUND_BASE", { activate: false })`,
    );
    fs.writeFileSync(closeFile, "F22_BACKGROUND_ACCEPTED", "utf8");
    await exec(`window.reloadCurrentFile(); null;`);
    const backgroundHeld = await waitUntil(() => heldReloadResults.length === 3, 5000);
    await exec(`window.CustomTabs.switchToTab(${backgroundTab.id}); null;`);
    if (heldReloadResults[2]) realReloadSend.call(wc, "file-reload-result", heldReloadResults[2]);
    await sleep(500);
    const afterBackgroundToastCount = await toastCount();
    fs.unlinkSync(backgroundFile);
    const foregroundFailureIndex = heldReloadResults.length;
    const foregroundFailureToastCount = await allToastCount();
    const foregroundFailureCount = await failedToastCount();
    await exec(`window.reloadCurrentFile(); null;`);
    const foregroundFailureHeld = await waitUntil(
      () => heldReloadResults.length === foregroundFailureIndex + 1,
      5000,
    );
    const foregroundFailure = heldReloadResults[foregroundFailureIndex];
    if (foregroundFailure) {
      realReloadSend.call(wc, "file-reload-result", foregroundFailure);
    }
    await sleep(500);
    const afterFailedToastCount = await toastCount();
    const afterForegroundFailureCount = await failedToastCount();
    if (!deletionProductionPrerequisite.reloadOwnerIdentity) {
      reportDeletionCapability(
        "F22 background reload toast ownership requires active document identity support",
        deletionCapabilityContracts.reloadOwner,
        JSON.stringify({
          reloadOwnerIdentity: deletionProductionPrerequisite.reloadOwnerIdentity,
        }),
      );
    } else check(
      "F22 accepted background reload notifies once, while a failed reload never emits a success toast",
      backgroundHeld === true &&
        afterBackgroundToastCount === afterCurrentToastCount + 1 &&
        foregroundFailureHeld === true &&
        foregroundFailure &&
        foregroundFailure.success === false &&
        afterFailedToastCount === afterBackgroundToastCount &&
        afterForegroundFailureCount === foregroundFailureCount + 1 &&
        await allToastCount() === foregroundFailureToastCount + 1,
      JSON.stringify({
        backgroundHeld,
        afterCurrentToastCount,
        afterBackgroundToastCount,
        foregroundFailureHeld,
        foregroundFailure,
        foregroundFailureToastCount,
        foregroundFailureCount,
        afterFailedToastCount,
        afterForegroundFailureCount,
      }),
    );

    // A path is not a tab generation. Hold real main-process replies, close
    // their originating tab, and reopen the same path before delivery. Both a
    // success and a failure must be rejected rather than updating, dirtying,
    // conflicting, or notifying the replacement generation.
    await clearTabs();
    const generationFile = path.join(dir, "f22-reload-tab-generation.md");
    fs.writeFileSync(generationFile, "F22_GENERATION_SUCCESS_BASE", "utf8");
    const successOrigin = await createActiveTab(
      generationFile,
      "F22_GENERATION_SUCCESS_BASE",
    );
    fs.writeFileSync(generationFile, "F22_GENERATION_OLD_SUCCESS", "utf8");
    const successReplyIndex = heldReloadResults.length;
    await exec(`window.reloadCurrentFile(); null;`);
    const oldSuccessHeld = await waitUntil(
      () => heldReloadResults.length === successReplyIndex + 1,
      5000,
    );
    const oldSuccess = heldReloadResults[successReplyIndex];
    const successOriginClosed = await exec(
      `window.CustomTabs.closeTab(${successOrigin.id}).then(() => !window.CustomTabs.getTabs().some(t => t.id === ${successOrigin.id}))`,
    );
    fs.writeFileSync(generationFile, "F22_GENERATION_SUCCESS_REOPENED", "utf8");
    const successReplacement = await createActiveTab(
      generationFile,
      "F22_GENERATION_SUCCESS_REOPENED",
    );
    await sleep(300);
    const beforeOldSuccess = await tabSnapshot(successReplacement.id);
    if (oldSuccess) realReloadSend.call(wc, "file-reload-result", oldSuccess);
    await sleep(500);
    const afterOldSuccess = await tabSnapshot(successReplacement.id);

    await clearTabs();
    fs.writeFileSync(generationFile, "F22_GENERATION_FAILURE_BASE", "utf8");
    const failureOrigin = await createActiveTab(
      generationFile,
      "F22_GENERATION_FAILURE_BASE",
    );
    fs.unlinkSync(generationFile);
    const failureReplyIndex = heldReloadResults.length;
    await exec(`window.reloadCurrentFile(); null;`);
    const oldFailureHeld = await waitUntil(
      () => heldReloadResults.length === failureReplyIndex + 1,
      5000,
    );
    const oldFailure = heldReloadResults[failureReplyIndex];
    await sleep(300);
    const failureOriginClosed = await exec(
      `window.CustomTabs.closeTab(${failureOrigin.id}).then(() => !window.CustomTabs.getTabs().some(t => t.id === ${failureOrigin.id}))`,
    );
    fs.writeFileSync(generationFile, "F22_GENERATION_FAILURE_REOPENED", "utf8");
    const failureReplacement = await createActiveTab(
      generationFile,
      "F22_GENERATION_FAILURE_REOPENED",
    );
    await sleep(500);
    const beforeOldFailure = await tabSnapshot(failureReplacement.id);
    if (oldFailure) realReloadSend.call(wc, "file-reload-result", oldFailure);
    await sleep(500);
    const afterOldFailure = await tabSnapshot(failureReplacement.id);
    check(
      "F22 close-reopen of the same path rejects old reload success and failure replies by their originating tab ID",
      oldSuccessHeld === true &&
        oldSuccess &&
        oldSuccess.success === true &&
        oldSuccess.reloadRequest &&
        oldSuccess.reloadRequest.tabId === successOrigin.id &&
        successOriginClosed === true &&
        successReplacement &&
        successReplacement.id !== successOrigin.id &&
        JSON.stringify(afterOldSuccess) === JSON.stringify(beforeOldSuccess) &&
        oldFailureHeld === true &&
        oldFailure &&
        oldFailure.success === false &&
        oldFailure.reloadRequest &&
        oldFailure.reloadRequest.tabId === failureOrigin.id &&
        failureOriginClosed === true &&
        failureReplacement &&
        failureReplacement.id !== failureOrigin.id &&
        JSON.stringify(afterOldFailure) === JSON.stringify(beforeOldFailure),
      JSON.stringify({
        oldSuccessHeld,
        oldSuccess: oldSuccess && { success: oldSuccess.success, reloadRequest: oldSuccess.reloadRequest },
        successOriginClosed,
        successOriginId: successOrigin.id,
        successReplacementId: successReplacement && successReplacement.id,
        beforeOldSuccess,
        afterOldSuccess,
        oldFailureHeld,
        oldFailure: oldFailure && { success: oldFailure.success, reloadRequest: oldFailure.reloadRequest },
        failureOriginClosed,
        failureOriginId: failureOrigin.id,
        failureReplacementId: failureReplacement && failureReplacement.id,
        beforeOldFailure,
        afterOldFailure,
      }),
    );


    // A valid failure retains the request's owner even after the reader moves
    // away. It must announce that A failed, without giving B's live document
    // the failure handler's normal foreground ownership.
    await clearTabs();
    const backgroundFailureAFile = path.join(dir, "f22-background-failure-a.md");
    const backgroundFailureBFile = path.join(dir, "f22-background-failure-b.md");
    fs.writeFileSync(backgroundFailureAFile, "F22_BACKGROUND_FAILURE_A", "utf8");
    fs.writeFileSync(backgroundFailureBFile, "F22_BACKGROUND_FAILURE_B", "utf8");
    const backgroundFailureA = await createActiveTab(
      backgroundFailureAFile,
      "F22_BACKGROUND_FAILURE_A",
    );
    const backgroundFailureB = await exec(
      `window.CustomTabs.createTab(${JSON.stringify(backgroundFailureBFile)}, "F22_BACKGROUND_FAILURE_B", { activate: false })`,
    );
    fs.unlinkSync(backgroundFailureAFile);
    const backgroundFailureIndex = heldReloadResults.length;
    await exec(`window.reloadCurrentFile(); null;`);
    const backgroundFailureHeld = await waitUntil(
      () => heldReloadResults.length === backgroundFailureIndex + 1,
      5000,
    );
    const backgroundFailure = heldReloadResults[backgroundFailureIndex];
    await exec(`window.CustomTabs.switchToTab(${backgroundFailureB.id}); null;`);
    const beforeBackgroundFailure = await tabSnapshot(backgroundFailureB.id);
    const beforeBackgroundFailureToasts = await allToastCount();
    const beforeBackgroundFailureFailures = await failedToastCount();
    if (backgroundFailure) realReloadSend.call(wc, "file-reload-result", backgroundFailure);
    await sleep(500);
    const afterBackgroundFailure = await tabSnapshot(backgroundFailureB.id);
    const afterBackgroundFailureToasts = await allToastCount();
    const afterBackgroundFailureFailures = await failedToastCount();
    check(
      "F22 an accepted background reload failure remains owned by its originating tab and notifies without mutating the active tab",
      backgroundFailureHeld === true &&
        backgroundFailure &&
        backgroundFailure.success === false &&
        backgroundFailure.reloadRequest &&
        backgroundFailure.reloadRequest.tabId === backgroundFailureA.id &&
        backgroundFailureB &&
        beforeBackgroundFailure &&
        afterBackgroundFailure &&
        JSON.stringify({ ...afterBackgroundFailure, notifications: 0 }) ===
          JSON.stringify({ ...beforeBackgroundFailure, notifications: 0 }) &&
        afterBackgroundFailureToasts === beforeBackgroundFailureToasts + 1 &&
        afterBackgroundFailureFailures === beforeBackgroundFailureFailures + 1,
      JSON.stringify({
        backgroundFailure: backgroundFailure && {
          success: backgroundFailure.success,
          reloadRequest: backgroundFailure.reloadRequest,
        },
        originId: backgroundFailureA.id,
        activeId: backgroundFailureB && backgroundFailureB.id,
        beforeBackgroundFailure,
        afterBackgroundFailure,
        beforeBackgroundFailureToasts,
        afterBackgroundFailureToasts,
        beforeBackgroundFailureFailures,
        afterBackgroundFailureFailures,
      }),
    );

    // No path-only fallback is allowed after the origin has closed. Exercise
    // both reply kinds while no matching tab exists; the earlier replacement
    // scenario above separately proves the stronger same-path generation case.
    const closedReplyResults = [];
    for (const kind of ["success", "failure"]) {
      await clearTabs();
      const file = path.join(dir, `f22-closed-${kind}-reply.md`);
      fs.writeFileSync(file, `F22_CLOSED_${kind}_BASE`, "utf8");
      const origin = await createActiveTab(file, `F22_CLOSED_${kind}_BASE`);
      if (kind === "success") fs.writeFileSync(file, "F22_CLOSED_SUCCESS_NEW", "utf8");
      else fs.unlinkSync(file);
      const replyIndex = heldReloadResults.length;
      await exec(`window.reloadCurrentFile(); null;`);
      const held = await waitUntil(() => heldReloadResults.length === replyIndex + 1, 5000);
      const reply = heldReloadResults[replyIndex];
      const closed = await exec(
        `window.CustomTabs.closeTab(${origin.id}).then(() => !window.CustomTabs.getTabs().some(t => t.id === ${origin.id}))`,
      );
      const beforeToasts = await allToastCount();
      if (reply) realReloadSend.call(wc, "file-reload-result", reply);
      await sleep(300);
      closedReplyResults.push({
        kind,
        held,
        closed,
        success: reply && reply.success,
        requestTabId: reply && reply.reloadRequest && reply.reloadRequest.tabId,
        originId: origin.id,
        noTab: await exec(`!window.CustomTabs.getTabs().some(t => t.filePath === ${JSON.stringify(file)})`),
        noToast: await allToastCount() === beforeToasts,
      });
    }
    check(
      "F22 success and failure replies for a closed originating tab are dropped without a toast or path-only adoption",
      closedReplyResults.length === 2 &&
        closedReplyResults.every((result) =>
          result.held === true &&
          result.closed === true &&
          result.requestTabId === result.originId &&
          result.noTab === true &&
          result.noToast === true,
        ) &&
        closedReplyResults.some((result) => result.kind === "success" && result.success === true) &&
        closedReplyResults.some((result) => result.kind === "failure" && result.success === false),
      JSON.stringify(closedReplyResults),
    );

    // Phase-two freezing must retain correlated one-shot document operations.
    // The real CustomTabs IPC commit/thaw listeners are driven directly here:
    // this isolates replay ownership from updater installation machinery.
    await clearTabs();
    const frozenOpenFile = path.join(dir, "f22-frozen-open.md");
    fs.writeFileSync(frozenOpenFile, "F22_FROZEN_OPEN", "utf8");
    const frozenOpen = await freezeForF22(910001);
    const beforeFrozenOpen = await exec(`window.CustomTabs.__shutdownFreeze()`);
    await exec(`require("electron").ipcRenderer.emit("file-opened", {}, {
      filePath: ${JSON.stringify(frozenOpenFile)}, path: ${JSON.stringify(frozenOpenFile)}, content: "F22_FROZEN_OPEN"
    }); null;`);
    const parkedOpen = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const openThawed = await thawForF22();
    const openReplayed = await waitForCondition(
      exec,
      `window.CustomTabs.getActiveTab() && window.CustomTabs.getActiveTab().filePath === ${JSON.stringify(frozenOpenFile)}`,
      5000,
    );
    const afterFrozenOpen = await exec(`window.CustomTabs.__shutdownFreeze()`);

    const frozenReloadFile = path.join(dir, "f22-frozen-reload.md");
    fs.writeFileSync(frozenReloadFile, "F22_FROZEN_RELOAD_BASE", "utf8");
    await clearTabs();
    const frozenReloadTab = await createActiveTab(frozenReloadFile, "F22_FROZEN_RELOAD_BASE");
    fs.writeFileSync(frozenReloadFile, "F22_FROZEN_RELOAD_SUCCESS", "utf8");
    const frozenSuccessIndex = heldReloadResults.length;
    await exec(`window.reloadCurrentFile(); null;`);
    const frozenSuccessHeld = await waitUntil(() => heldReloadResults.length === frozenSuccessIndex + 1, 5000);
    const frozenSuccess = heldReloadResults[frozenSuccessIndex];
    const frozenSuccessToasts = await toastCount();
    const frozenSuccessFreeze = await freezeForF22(910002);
    const successParkedBefore = await exec(`window.CustomTabs.__shutdownFreeze()`);
    if (frozenSuccess) realReloadSend.call(wc, "file-reload-result", frozenSuccess);
    await sleep(150);
    const successParked = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const successThawed = await thawForF22();
    const successReplayed = await waitForCondition(
      exec,
      `window.CustomTabs.getActiveTab() && window.CustomTabs.getActiveTab().content === "F22_FROZEN_RELOAD_SUCCESS"`,
      5000,
    );
    await sleep(350);
    const successAfterFreeze = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const frozenSuccessAfterToasts = await toastCount();
    const frozenSuccessAfter = await tabSnapshot(frozenReloadTab.id);

    fs.writeFileSync(frozenReloadFile, "F22_FROZEN_FAILURE_BASE", "utf8");
    await clearTabs();
    const frozenFailureTab = await createActiveTab(frozenReloadFile, "F22_FROZEN_FAILURE_BASE");
    fs.unlinkSync(frozenReloadFile);
    const frozenFailureIndex = heldReloadResults.length;
    await exec(`window.reloadCurrentFile(); null;`);
    const frozenFailureHeld = await waitUntil(() => heldReloadResults.length === frozenFailureIndex + 1, 5000);
    const frozenFailure = heldReloadResults[frozenFailureIndex];
    const frozenFailureToasts = await failedToastCount();
    const frozenFailureFreeze = await freezeForF22(910003);
    if (frozenFailure) realReloadSend.call(wc, "file-reload-result", frozenFailure);
    await sleep(150);
    const failureParked = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const failureThawed = await thawForF22();
    await sleep(400);
    const failureAfterFreeze = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const frozenFailureAfterToasts = await failedToastCount();
    const frozenFailureAfter = await tabSnapshot(frozenFailureTab.id);

    // A reply whose tab generation was already replaced is invalid before it
    // reaches the frozen queue, so thaw cannot revive it.
    fs.writeFileSync(frozenReloadFile, "F22_FROZEN_STALE_BASE", "utf8");
    await clearTabs();
    const frozenStaleOrigin = await createActiveTab(frozenReloadFile, "F22_FROZEN_STALE_BASE");
    fs.writeFileSync(frozenReloadFile, "F22_FROZEN_STALE_OLD", "utf8");
    const frozenStaleIndex = heldReloadResults.length;
    await exec(`window.reloadCurrentFile(); null;`);
    const frozenStaleHeld = await waitUntil(() => heldReloadResults.length === frozenStaleIndex + 1, 5000);
    const frozenStale = heldReloadResults[frozenStaleIndex];
    await exec(`window.CustomTabs.closeTab(${frozenStaleOrigin.id}); null;`);
    const frozenStaleReplacement = await createActiveTab(frozenReloadFile, "F22_FROZEN_STALE_REPLACEMENT");
    const frozenStaleBefore = await tabSnapshot(frozenStaleReplacement.id);
    const frozenStaleToasts = await allToastCount();
    const frozenStaleFreeze = await freezeForF22(910004);
    const staleParkedBefore = await exec(`window.CustomTabs.__shutdownFreeze()`);
    if (frozenStale) realReloadSend.call(wc, "file-reload-result", frozenStale);
    await sleep(150);
    const staleParked = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const staleThawed = await thawForF22();
    await sleep(350);
    const staleAfterFreeze = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const frozenStaleAfter = await tabSnapshot(frozenStaleReplacement.id);
    const frozenStaleAfterToasts = await allToastCount();
    check(
      "F22 phase-two freeze replays current file-open and reload success/failure exactly once after thaw, but never replays a replaced tab generation",
      frozenOpen.ready === true &&
        beforeFrozenOpen.deferredOperationCount === 0 &&
        parkedOpen.deferredOperationCount === 1 &&
        openThawed === true &&
        openReplayed === true &&
        afterFrozenOpen.replayedOperations === beforeFrozenOpen.replayedOperations + 1 &&
        frozenSuccessHeld === true &&
        frozenSuccess && frozenSuccess.success === true &&
        frozenSuccess.reloadRequest.tabId === frozenReloadTab.id &&
        frozenSuccessFreeze.ready === true &&
        successParked.deferredOperationCount === successParkedBefore.deferredOperationCount + 1 &&
        successThawed === true &&
        successReplayed === true &&
        successAfterFreeze.deferredOperationCount === 0 &&
        successAfterFreeze.replayedOperations === successParked.replayedOperations + 1 &&
        frozenSuccessAfter && frozenSuccessAfter.content === "F22_FROZEN_RELOAD_SUCCESS" &&
        frozenSuccessAfterToasts === frozenSuccessToasts + 1 &&
        frozenFailureHeld === true &&
        frozenFailure && frozenFailure.success === false &&
        frozenFailure.reloadRequest.tabId === frozenFailureTab.id &&
        frozenFailureFreeze.ready === true &&
        failureParked.deferredOperationCount === 1 &&
        failureThawed === true &&
        failureAfterFreeze.deferredOperationCount === 0 &&
        failureAfterFreeze.replayedOperations === failureParked.replayedOperations + 1 &&
        frozenFailureAfter && frozenFailureAfter.content === "F22_FROZEN_FAILURE_BASE" &&
        frozenFailureAfterToasts === frozenFailureToasts + 1 &&
        frozenStaleHeld === true &&
        frozenStale && frozenStale.success === true &&
        frozenStale.reloadRequest.tabId === frozenStaleOrigin.id &&
        frozenStaleReplacement.id !== frozenStaleOrigin.id &&
        frozenStaleFreeze.ready === true &&
        staleParked.deferredOperationCount === staleParkedBefore.deferredOperationCount &&
        staleThawed === true &&
        staleAfterFreeze.deferredOperationCount === 0 &&
        staleAfterFreeze.replayedOperations === staleParked.replayedOperations &&
        JSON.stringify(frozenStaleAfter) === JSON.stringify(frozenStaleBefore) &&
        frozenStaleAfterToasts === frozenStaleToasts,
      JSON.stringify({
        frozenOpen, beforeFrozenOpen, parkedOpen, openThawed, openReplayed, afterFrozenOpen,
        frozenSuccessHeld, frozenSuccess: frozenSuccess && frozenSuccess.reloadRequest,
        frozenSuccessFreeze, successParkedBefore, successParked, successThawed, successReplayed,
        successAfterFreeze, frozenSuccessAfter, frozenSuccessToasts, frozenSuccessAfterToasts,
        frozenFailureHeld, frozenFailure: frozenFailure && frozenFailure.reloadRequest,
        frozenFailureFreeze, failureParked, failureThawed, failureAfterFreeze, frozenFailureAfter,
        frozenFailureToasts, frozenFailureAfterToasts,
        frozenStaleHeld, frozenStale: frozenStale && frozenStale.reloadRequest,
        frozenStaleFreeze, staleParkedBefore, staleParked, staleThawed, staleAfterFreeze,
        frozenStaleBefore, frozenStaleAfter, frozenStaleToasts, frozenStaleAfterToasts,
      }),
    );
  } finally {
    restoreReloadSend();
    await exec(`window.__f22ReloadObserver && window.__f22ReloadObserver.disconnect(); null;`);
  }
}


async function runF22CommitSendThrowScenario(win, exec) {
  const wc = win.webContents;
  const rig = shutdownRig(win);
  let releaseFallback;
  try {
    __shutdown.reset();
    rig.reset();
    await exec(`
      (() => {
        const confirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().forEach((tab) => {
            tab.content = tab.originalContent;
            tab.hasUnsavedChanges = false;
          });
        } finally {
          window.confirm = confirm;
        }
        const tab = window.CustomTabs.getActiveTab();
        window.originalMarkdown = tab ? tab.originalContent : "";
        return !!tab;
      })()
    `);
    rig.answer = () =>
      new Promise((resolve) => {
        releaseFallback = resolve;
      });
    const approvalRequests = [];
    let commitSendThrows = 0;
    const realSend = wc.send;
    const restoreSend = replaceMethod(wc, "send", function (channel, ...args) {
      if (channel === "quit-approval-request") approvalRequests.push(args[0]);
      if (channel === "quit-approval-commit") {
        commitSendThrows += 1;
        throw new Error("controlled QUIT_APPROVAL_COMMIT send failure");
      }
      return realSend.call(this, channel, ...args);
    });
    const close = guardEvent();
    try {
      win.emit("close", close);
      await waitUntil(() => rig.dialogs.length === 1, 10000);
      await sleep(300);
    } finally {
      restoreSend();
    }
    const state = __shutdown.state();
    const freeze = await exec(`window.CustomTabs.__shutdownFreeze()`);
    check(
      "a QUIT_APPROVAL_COMMIT send throw asks exactly one current main-process fallback without a duplicate renderer prompt",
      close.prevented === true &&
        commitSendThrows === 1 &&
        rig.dialogs.length === 1 &&
        rig.dialogs[0].pendingReason === "window-close" &&
        /cannot be checked/i.test(String(rig.dialogs[0].options.title)) &&
        approvalRequests.length === 1 &&
        state.commitRefusedWhy === "commit-send-failed" &&
        state.commitPendingId === 0 &&
        state.authorized === false &&
        freeze.frozen === false &&
        freeze.editorReadOnly === false,
      JSON.stringify({
        prevented: close.prevented,
        commitSendThrows,
        dialogs: rig.dialogs.map((dialog) => ({
          pendingReason: dialog.pendingReason,
          title: dialog.options.title,
        })),
        rendererApprovalRequests: approvalRequests.map((request) => request && request.id),
        state,
        freeze,
      }),
    );
  } finally {
    if (releaseFallback) releaseFallback(1);
    rig.restore();
    __shutdown.reset();
  }
}

async function runShutdownGenerationScenarios(win, exec) {
  const bareFile = path.join(dir, "f22-no-overlay.html");
  const indexFile = path.join(__dirname, "..", "src", "index.html");
  fs.writeFileSync(
    bareFile,
    "<!doctype html><meta charset=utf-8><title>F22 probe fixture</title>",
    "utf8",
  );
  const rig = shutdownRig(win);
  const wc = win.webContents;
  const clearDocuments = () =>
    exec(`
      (() => {
        const confirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().forEach(t => {
            t.content = t.originalContent;
            t.hasUnsavedChanges = false;
          });
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = confirm;
        }
        localStorage.clear();
        window.originalMarkdown = '';
        window.isEditMode = false;
        return window.CustomTabs.getTabs().length;
      })()
    `);
  try {
    // The preceding shutdown matrix intentionally exercises renderer-hang and
    // loss states. Begin this independent generation matrix from a real ready
    // document, rather than treating its former unresponsive state as an
    // approval sender.
    __shutdown.reset();
    await waitForCondition(exec, `!window.CustomTabs.isDocumentFrozen()`, 5000);
    await exec(`localStorage.clear(); null;`);
    wc.reload();
    await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
    await clearDocuments();

    // The generation is a capability, not a convenience accessor. Exercise
    // the actual ipcMain.handle call from a separate BrowserWindow and from a
    // subframe of the document owner; neither is allowed to mint a token.
    __shutdown.reset();
    const generationBefore = __shutdown.state().rendererGeneration;
    const approvalSenderSource = fs.readFileSync(
      path.join(__dirname, "..", "src", "main.js"),
      "utf8",
    );
    const mainFrameGate =
      approvalSenderSource.indexOf("return frame.parent === null;") >= 0;
    const impostor = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    let impostorGeneration;
    let frameGeneration;
    try {
      await impostor.loadFile(bareFile);
      impostorGeneration = await impostor.webContents.executeJavaScript(`
        require('electron').ipcRenderer.invoke('quit-approval-generation')
          .then(value => ({ resolved: true, value }))
          .catch(error => ({ resolved: false, message: String(error && error.message) }))
      `);
      frameGeneration = await exec(`
        (async () => {
          const frame = document.createElement('iframe');
          frame.srcdoc = '<!doctype html><meta charset=utf-8><title>subframe</title>';
          document.body.appendChild(frame);
          try {
            await new Promise((resolve, reject) => {
              frame.addEventListener('load', resolve, { once: true });
              frame.addEventListener('error', reject, { once: true });
            });
            const child = frame.contentWindow;
            const childIpc =
              child.ipcRenderer ||
              (typeof child.require === 'function' &&
                child.require('electron').ipcRenderer);
            if (!childIpc) return { attempted: false, reason: 'no child ipcRenderer' };
            return await childIpc
              .invoke('quit-approval-generation')
              .then(value => ({ attempted: true, resolved: true, value }))
              .catch(error => ({
                attempted: true,
                resolved: false,
                message: String(error && error.message),
              }));
          } finally {
            frame.remove();
          }
        })()
      `);
    } finally {
      if (!impostor.isDestroyed()) impostor.destroy();
    }
    check(
      "the approval generation is available only to the document main frame",
      impostorGeneration &&
        impostorGeneration.resolved === false &&
        frameGeneration &&
        // nodeIntegrationInSubFrames is deliberately off, so a subframe has
        // no IPC bridge at all; if Electron ever gives it one, the handler
        // must still reject the real invoke rather than trusting the frame.
        (frameGeneration.attempted === false ||
          frameGeneration.resolved === false) &&
        mainFrameGate &&
        __shutdown.state().rendererGeneration === generationBefore,
      JSON.stringify({
        impostorGeneration,
        frameGeneration,
        mainFrameGate,
        state: __shutdown.state(),
      }),
    );

    // A dispatch belongs to a document generation. Hold the original
    // renderer's listener, commit a real reload, then verify that its
    // successor sees the SAME request id exactly once and can complete it.
    __shutdown.reset();
    rig.reset();
    const dispatched = [];
    const restoreSend = replaceMethod(wc, "send", function (channel, payload) {
      if (channel === "quit-approval-request") dispatched.push(payload);
      return Reflect.apply(Object.getPrototypeOf(wc).send, this, arguments);
    });
    try {
      await exec(`
        (() => {
          const ipc = require('electron').ipcRenderer;
          window.__f22HeldHandlers = ipc.listeners('quit-approval-request').slice();
          ipc.removeAllListeners('quit-approval-request');
          ipc.on('quit-approval-request', (_event, request) => {
            window.__f22HeldRequest = request;
          });
          window.__f22HeldRequest = null;
          return window.__f22HeldHandlers.length;
        })()
      `);
      const requestClose = guardEvent();
      win.emit("close", requestClose);
      const firstDispatched = await waitUntil(() => dispatched.length === 1);
      const first = dispatched[0];
      const beforeNavigation = __shutdown.state();
      wc.reload();
      const replacementReady = await waitUntil(
        () =>
          __shutdown.state().renderer === "ready" &&
          __shutdown.state().rendererGeneration > beforeNavigation.rendererGeneration,
        20000,
      );
      // A genuine sender carrying an old generation is still stale. It must
      // not make the replacement renderer look ready or prevent its dispatch.
      await exec(`
        window.ipcRenderer.send('quit-approval-ready', { gen: ${first ? first.gen : -1} });
        null;
      `);
      const redeliveredAndSettled = await waitUntil(
        () => dispatched.length === 2 && rig.closes === 1,
        10000,
      );
      const afterNavigation = __shutdown.state();
      check(
        "a committed navigation invalidates a dispatch and the replacement READY issues a fresh request",
        firstDispatched &&
          replacementReady &&
          redeliveredAndSettled &&
          first &&
          dispatched[1] &&
          dispatched[0].id !== dispatched[1].id &&
          dispatched[0].gen !== dispatched[1].gen &&
          requestClose.prevented === true &&
          afterNavigation.pendingId === 0 &&
          afterNavigation.lastRequestId === beforeNavigation.lastRequestId + 1 &&
          afterNavigation.navigationInvalidatedShutdownCount === 1 &&
          afterNavigation.staleReadyCount >= 1,
        JSON.stringify({ dispatched, beforeNavigation, afterNavigation, closes: rig.closes }),
      );
    } finally {
      restoreSend();
    }

    // An approval is scoped to exactly the document which supplied it. Once a
    // clean request has authorized a close, committing a navigation must
    // revoke that authority before the replacement can discard an edit.
    __shutdown.reset();
    rig.reset();
    const approvedClose = guardEvent();
    win.emit("close", approvedClose);
    const cleanApproved = await waitUntil(
      () => rig.closes === 1 && __shutdown.state().authorized === true,
    );
    const approvalGeneration = __shutdown.state().authorizationGeneration;
    wc.reload();
    const successorReady = await waitUntil(
      () =>
        __shutdown.state().renderer === "ready" &&
        __shutdown.state().rendererGeneration > approvalGeneration,
      20000,
    );
    const afterRevocation = __shutdown.state();
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab('f22-navigation-edit.md', 'before');
        tab.content = 'after navigation exact edit';
        tab.hasUnsavedChanges = false;
        // THE LIVE COPY MOVES FIRST. A view-mode edit exists in
        // window.originalMarkdown; assigning tab.content alone is a state the
        // product cannot reach for the ACTIVE tab, and the switch below
        // correctly folds the pristine text back over it - so a fixture that
        // sets the live copy afterwards is simulating nothing.
        window.originalMarkdown = tab.content;
        window.CustomTabs.switchToTab(tab.id);
        return tab.filename;
      })()
    `);
    rig.answer = 1;
    const replacementClose = guardEvent();
    win.emit("close", replacementClose);
    const replacementAsked = await waitUntil(() => rig.dialogs.length === 1);
    check(
      "navigation revokes a clean approval so the replacement document cannot close silently",
      cleanApproved &&
        successorReady &&
        approvedClose.prevented === true &&
        afterRevocation.authorized === false &&
        replacementAsked &&
        replacementClose.prevented === true &&
        rig.closes === 1 &&
        /f22-navigation-edit/.test(String(rig.dialogs[0] && rig.dialogs[0].options.message)),
      JSON.stringify({
        cleanApproved,
        approvalGeneration,
        afterRevocation,
        replacementAsked,
        closes: rig.closes,
        dialog: rig.dialogs[0] && rig.dialogs[0].options,
      }),
    );

    // A main-process discard dialog is an approval of one renderer document,
    // not a durable approval keyed only by its revision. Keep its real promise
    // pending across a committed reload, deliberately make the replacement
    // revision collide, then release the old promise only after the replacement
    // request is held at its own generation boundary.
    __shutdown.reset();
    rig.reset();
    let releaseOldDiscard = null;
    let holdReplacementRequest = false;
    let heldReplacementRequest = null;
    const emittedDiscardRequests = [];
    const realDiscardSend = wc.send;
    const restoreDiscardSend = replaceMethod(wc, "send", function (channel, ...args) {
      if (channel === "quit-approval-request") {
        emittedDiscardRequests.push(args[0]);
        if (holdReplacementRequest && heldReplacementRequest === null) {
          heldReplacementRequest = args[0];
          return;
        }
      }
      return realDiscardSend.call(this, channel, ...args);
    });
    try {
      const oldDiscardFixture = await exec(`
        (() => {
          try {
            const tab = window.CustomTabs.createTab('f22-discard-navigation.md', 'discard base');
            window.CustomTabs.switchToTab(tab.id);
            window.originalMarkdown = tab.content + '\\nDIRTY_DISCARD_BEFORE_NAVIGATION\\n';
            return { tabId: tab.id, revision: window.CustomTabs.__shutdownFreeze().revision };
          } catch (error) {
            return { error: String(error && error.stack ? error.stack : error) };
          }
        })()
      `);
      rig.answer = () =>
        new Promise((resolve) => {
          releaseOldDiscard = resolve;
        });
      const dirtyDiscardClose = guardEvent();
      win.emit("close", dirtyDiscardClose);
      const oldDiscardAsked = await waitUntil(() => rig.dialogs.length === 1, 10000);
      const oldDiscardState = __shutdown.state();
      const oldDiscardRevision = await exec(
        `window.CustomTabs.__shutdownFreeze().revision`,
      );
      holdReplacementRequest = true;
      wc.reload();
      const replacementRequestHeld = await waitUntil(
        () =>
          heldReplacementRequest !== null &&
          __shutdown.state().renderer === "ready" &&
          __shutdown.state().pendingId === heldReplacementRequest.id,
        20000,
      );
      const replacementDiscardState = __shutdown.state();
      const replacementCollision = await exec(`
        (() => {
          const tab = window.CustomTabs.getActiveTab() ||
            window.CustomTabs.createTab('f22-discard-replacement.md', 'replacement base');
          let revision = window.CustomTabs.__shutdownFreeze().revision;
          while (revision < ${JSON.stringify(oldDiscardRevision)}) {
            // The accessor is the production mutation boundary. Assigning the
            // same text changes no document data but advances exactly one
            // revision, allowing a new renderer to collide numerically with
            // the old dialog's revision.
            tab.content = tab.content;
            revision = window.CustomTabs.__shutdownFreeze().revision;
          }
          return { revision, target: ${JSON.stringify(oldDiscardRevision)} };
        })()
      `);
      const freezeAfterNavigation = await exec(`window.CustomTabs.__shutdownFreeze()`);
      const staleDialogBefore = replacementDiscardState.staleShutdownDialogCompletionCount;
      if (releaseOldDiscard) releaseOldDiscard(0);
      const staleOldDiscardObserved = await waitUntil(
        () =>
          __shutdown.state().staleShutdownDialogCompletionCount ===
          staleDialogBefore + 1,
        5000,
      );
      const afterOldDiscardCompletion = __shutdown.state();
      check(
        "navigation aborts a dirty discard dialog and issues a fresh generation-bound approval despite a colliding revision",
        oldDiscardFixture &&
          oldDiscardAsked &&
          dirtyDiscardClose.prevented === true &&
          oldDiscardState.pendingId > 0 &&
          oldDiscardState.pendingReason === "window-close" &&
          replacementRequestHeld &&
          heldReplacementRequest.id > oldDiscardState.pendingId &&
          heldReplacementRequest.gen === replacementDiscardState.rendererGeneration &&
          heldReplacementRequest.gen > oldDiscardState.rendererGeneration &&
          replacementCollision.revision === replacementCollision.target &&
          replacementCollision.revision === oldDiscardRevision &&
          freezeAfterNavigation.frozen === false &&
          freezeAfterNavigation.editorReadOnly === false &&
          freezeAfterNavigation.wrapperInert === false,
        JSON.stringify({
          oldDiscardFixture,
          oldDiscardAsked,
          oldDiscardState,
          oldDiscardRevision,
          heldReplacementRequest,
          replacementDiscardState,
          replacementCollision,
          freezeAfterNavigation,
          emittedDiscardRequests,
        }),
      );
      check(
        "a stale pre-navigation discard completion is counted and cannot settle the replacement approval",
        staleOldDiscardObserved &&
          afterOldDiscardCompletion.pendingId === heldReplacementRequest.id &&
          afterOldDiscardCompletion.pendingReason === "window-close" &&
          afterOldDiscardCompletion.rendererGeneration === heldReplacementRequest.gen &&
          rig.closes === 0,
        JSON.stringify({
          staleDialogBefore,
          staleOldDiscardObserved,
          afterOldDiscardCompletion,
          closes: rig.closes,
        }),
      );

      // The next document is still allowed to complete an ordinary clean close.
      // This is the positive twin: navigation invalidates old consent, not all
      // future navigation-origin shutdowns.
      await exec(`
        (() => {
          const tab = window.CustomTabs.getActiveTab();
          tab.content = 'replacement clean';
          tab.originalContent = 'replacement clean';
          window.originalMarkdown = tab.content;
          return window.CustomTabs.__shutdownFreeze().revision;
        })()
      `);
      holdReplacementRequest = false;
      restoreDiscardSend();
      heldReplacementRequest = null;
      // The held replacement message is real; deliver it only after its old
      // counterpart has proved stale and the replacement document is clean.
      realDiscardSend.call(wc, "quit-approval-request", emittedDiscardRequests.at(-1));
      const cleanReplacementClosed = await waitUntil(() => rig.closes === 1, 10000);
      check(
        "a clean replacement document still completes its fresh navigation approval normally",
        cleanReplacementClosed &&
          rig.dialogs.length === 1 &&
          __shutdown.state().pendingId === 0 &&
          __shutdown.state().authorized === true,
        JSON.stringify({
          cleanReplacementClosed,
          dialogs: rig.dialogs.length,
          closes: rig.closes,
          state: __shutdown.state(),
        }),
      );
    } finally {
      restoreDiscardSend();
    }

    // send() can throw synchronously while a renderer is nominally ready.
    // That is an unknown answer, not a clean one: clear the dispatch and use
    // the explicit main-process fallback. A later reloaded renderer remains
    // eligible to receive a new request.
    __shutdown.reset();
    rig.reset();
    let releaseSendFallback;
    rig.answer = () =>
      new Promise((resolve) => {
        releaseSendFallback = resolve;
      });
    const restoreThrowingSend = replaceMethod(wc, "send", function (channel) {
      if (channel === "quit-approval-request") {
        throw new Error("controlled synchronous shutdown send failure");
      }
      return Reflect.apply(Object.getPrototypeOf(wc).send, this, arguments);
    });
    let sendFailure;
    try {
      const sendFailureClose = guardEvent();
      win.emit("close", sendFailureClose);
      const fallbackShown = await waitUntil(
        () => rig.dialogs.length === 1 && __shutdown.state().pendingId !== 0,
      );
      sendFailure = __shutdown.state();
      rig.answer = 1;
      if (releaseSendFallback) releaseSendFallback(1);
      const sendFallbackCancelled = await waitUntil(
        () => __shutdown.state().pendingId === 0,
      );
      const sendFallbackState = __shutdown.state();
      check(
        "a synchronous shutdown send failure clears dispatch and falls back without authorizing",
        fallbackShown &&
          sendFallbackCancelled &&
          sendFailureClose.prevented === true &&
          sendFailure.pendingDispatchedTo === 0 &&
          sendFailure.pendingDispatchToken === 0 &&
          sendFailure.sendFailureCount === 1 &&
          sendFailure.authorized === false &&
          sendFallbackState.settleWhy === "fallback-unresponsive" &&
          sendFallbackState.authorized === false &&
          /cannot be checked/i.test(String(rig.dialogs[0] && rig.dialogs[0].options.title)),
        JSON.stringify({
          fallbackShown,
          sendFailure,
          sendFallbackState,
          dialog: rig.dialogs[0],
        }),
      );
    } finally {
      restoreThrowingSend();
    }
    rig.reset();
    wc.reload();
    const sendRecoveryReady = await waitUntil(
      () => __shutdown.state().renderer === "ready",
      20000,
    );
    const sendRecoveryClose = guardEvent();
    win.emit("close", sendRecoveryClose);
    const sendRecoverySettled = await waitUntil(() => rig.closes === 1);
    check(
      "cancelling a send fallback keeps the app alive and a later request remains possible",
      sendRecoveryReady &&
        sendRecoverySettled &&
        sendRecoveryClose.prevented === true &&
        rig.dialogs.length === 0 &&
        __shutdown.state().settleWhy === "clean",
      JSON.stringify({
        sendRecoveryReady,
        sendRecoverySettled,
        state: __shutdown.state(),
        closes: rig.closes,
      }),
    );

    // The overlay probe has the same synchronous boundary. Its token must be
    // released even when executeJavaScript throws before returning a promise,
    // and the next generation must be permitted to probe normally.
    __shutdown.reset();
    rig.reset();
    const realProbeExecuteJavaScript = wc.executeJavaScript;
    const restoreThrowingProbe = replaceMethod(
      wc,
      "executeJavaScript",
      function (code) {
        if (code === OVERLAY_PROBE_SOURCE && arguments.length === 1) {
          throw new Error("controlled synchronous overlay probe failure");
        }
        return Reflect.apply(realProbeExecuteJavaScript, this, arguments);
      },
    );
    let thrownProbe;
    try {
      await win.loadFile(bareFile);
      const probeFailed = await waitUntil(
        () => __shutdown.state().renderer === "unusable",
        10000,
      );
      thrownProbe = __shutdown.state();
      const probeClose = guardEvent();
      win.emit("close", probeClose);
      const probeFallback = await waitUntil(() => rig.dialogs.length === 1);
      check(
        "a synchronous overlay probe throw clears its token and routes the held close to fallback",
        probeFailed &&
          probeFallback &&
          probeClose.prevented === true &&
          thrownProbe.probeOwnerToken === 0 &&
          /page could not be inspected: controlled synchronous overlay probe failure/.test(
            String(thrownProbe.rendererUnusableReason),
          ) &&
          thrownProbe.authorized === false,
        JSON.stringify({ probeFailed, probeFallback, thrownProbe, dialog: rig.dialogs[0] }),
      );
    } finally {
      restoreThrowingProbe();
    }
    rig.reset();
    await win.loadFile(bareFile);
    const laterProbe = await waitUntil(
      () =>
        __shutdown.state().renderer === "unusable" &&
        /loaded without the tab overlay/.test(
          String(__shutdown.state().rendererUnusableReason),
        ) &&
        __shutdown.state().probeOwnerToken === 0,
      10000,
    );
    check(
      "a later overlay probe can run after a synchronous probe failure",
      laterProbe,
      JSON.stringify(__shutdown.state()),
    );

    // Retain a real probe promise across a committed replacement. Resolving it
    // afterwards must be counted as stale and must not disturb the successor's
    // ready state or its (separate) probe ownership.
    __shutdown.reset();
    let resolveOldProbe;
    let oldProbeGeneration = 0;
    const realExecuteJavaScript = wc.executeJavaScript;
    const restoreOldProbe = replaceMethod(wc, "executeJavaScript", function (code) {
      if (code === OVERLAY_PROBE_SOURCE && arguments.length === 1 && !resolveOldProbe) {
        oldProbeGeneration = __shutdown.state().rendererGeneration;
        return new Promise((resolve) => {
          resolveOldProbe = resolve;
        });
      }
      return Reflect.apply(realExecuteJavaScript, this, arguments);
    });
    let oldProbeRestored = false;
    const restoreOldProbeOnce = () => {
      if (oldProbeRestored) return;
      oldProbeRestored = true;
      restoreOldProbe();
    };
    try {
      const oldProbeNavigation = win.loadFile(bareFile);
      const oldProbeStarted = await waitUntil(
        () =>
          !!resolveOldProbe &&
          __shutdown.state().probeOwnerGeneration === oldProbeGeneration,
        10000,
      );
      // The product probe is now retained. Restore before either navigation
      // below can invoke unrelated did-finish-load listeners.
      restoreOldProbeOnce();
      await oldProbeNavigation;
      await win.loadFile(indexFile);
      const newGenerationReady = await waitUntil(
        () =>
          __shutdown.state().renderer === "ready" &&
          __shutdown.state().rendererGeneration > oldProbeGeneration,
        20000,
      );
      const successorBeforeOldCompletion = __shutdown.state();
      if (resolveOldProbe) resolveOldProbe(false);
      const staleCompletionObserved = await waitUntil(
        () => __shutdown.state().staleProbeCompletionCount === 1,
      );
      const successorAfterOldCompletion = __shutdown.state();
      check(
        "a stale asynchronous probe completion cannot clear or mark a newer generation",
        oldProbeStarted &&
          newGenerationReady &&
          staleCompletionObserved &&
          successorBeforeOldCompletion.renderer === "ready" &&
          successorAfterOldCompletion.renderer === "ready" &&
          successorAfterOldCompletion.rendererGeneration ===
            successorBeforeOldCompletion.rendererGeneration &&
          successorAfterOldCompletion.probeOwnerToken ===
            successorBeforeOldCompletion.probeOwnerToken &&
          successorAfterOldCompletion.rendererUnusableReason ===
            successorBeforeOldCompletion.rendererUnusableReason,
        JSON.stringify({
          oldProbeGeneration,
          successorBeforeOldCompletion,
          successorAfterOldCompletion,
        }),
      );
    } finally {
      restoreOldProbeOnce();
    }
  } finally {
    rig.restore();
    __shutdown.reset();
    if (__shutdown.state().renderer !== "ready") {
      await win.loadFile(indexFile);
      await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
    }
  }
}

async function runInstalledUpdateCommitScenarios(win, exec) {
  if (process.platform === "win32") {
    return runWindowsInstalledLauncherScenarios(win, exec);
  }
  const updater = require("electron-updater").autoUpdater;
  const wc = win.webContents;
  const indexFile = path.join(__dirname, "..", "src", "index.html");
  const commitFile = path.join(dir, "f22-installed-commit.md");
  const jsCommitFile = JSON.stringify(commitFile);
  const rig = shutdownRig(win);
  const latchDescriptor = Object.getOwnPropertyDescriptor(
    updater,
    "quitAndInstallCalled",
  );
  const restoreLatch = () => {
    if (latchDescriptor) {
      Object.defineProperty(updater, "quitAndInstallCalled", latchDescriptor);
    } else {
      delete updater.quitAndInstallCalled;
    }
  };
  const setLatch = (value) =>
    Object.defineProperty(updater, "quitAndInstallCalled", {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  let installs = 0;
  let commitMode = "manual";
  let commitSignals = 0;
  const countCommit = () => {
    commitSignals += 1;
  };
  const processWarnings = [];
  const observeProcessWarning = (warning) => {
    if (
      warning &&
      (warning.name === "MaxListenersExceededWarning" ||
        /MaxListenersExceededWarning/.test(String(warning.message)))
    ) {
      processWarnings.push(warning);
    }
  };
  // The test observer below is deliberately separate from the product's
  // process-lifetime listener. This count is captured before adding it, so a
  // passing assertion cannot hide product listener accumulation behind the
  // harness observer.
  const updaterBoundaryListenersBeforeObserver =
    electronAutoUpdater.listenerCount("before-quit-for-update");
  let baseUpdaterAttemptAtQueue = null;
  let beforeBaseUpdaterBoundary = null;
  let afterBaseUpdaterBoundary = null;
  let suppressBaseUpdaterPairedQuit = false;
  let baseUpdaterLifecycleQuitCalls = 0;
  let baseUpdaterPairedQuitCalls = 0;
  const restoreQuitAndInstall = replaceMethod(
    updater,
    "quitAndInstall",
    () => {
      installs += 1;
      setLatch(true);
      if (commitMode === "throw") {
        throw new Error("controlled updater throw for absorbed-user replay");
      }
      if (commitMode === "refusal") {
        setLatch(false);
        return;
      }
      if (commitMode === "error") {
        updater.emit("error", new Error("controlled updater error for absorbed-user replay"));
        return;
      }
      if (commitMode === "immediate") {
        electronAutoUpdater.emit("before-quit-for-update");
        app.emit("before-quit", guardEvent());
      }
      if (commitMode === "base-updater-success") {
        baseUpdaterAttemptAtQueue = __shutdown.state();
        setImmediate(() => {
          if (typeof beforeBaseUpdaterBoundary === "function") {
            beforeBaseUpdaterBoundary();
          }
          electronAutoUpdater.emit("before-quit-for-update");
          baseUpdaterLifecycleQuitCalls += 1;
          if (suppressBaseUpdaterPairedQuit) {
            baseUpdaterPairedQuitCalls += 1;
          } else {
            app.quit();
          }
          if (typeof afterBaseUpdaterBoundary === "function") {
            afterBaseUpdaterBoundary();
          }
        });
      }
      if (commitMode === "base-updater-error-race") {
        baseUpdaterAttemptAtQueue = __shutdown.state();
        setImmediate(() => {
          updater.emit(
            "error",
            new Error("controlled error racing queued BaseUpdater boundary"),
          );
          electronAutoUpdater.emit("before-quit-for-update");
          app.quit();
        });
      }
    },
  );
  const clearDocuments = () =>
    exec(`
      (() => {
        const confirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().forEach(t => {
            t.content = t.originalContent;
            t.hasUnsavedChanges = false;
          });
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = confirm;
        }
        localStorage.clear();
        window.originalMarkdown = '';
        window.isEditMode = false;
        return window.CustomTabs.getTabs().length;
      })()
    `);
  // Hold a real main-to-renderer protocol message at its boundary, then
  // release the exact payload main.js produced. This controls an asynchronous
  // phase without calling its handler directly or inventing a response.
  const holdRendererMessage = (channel) => {
    const realSend = wc.send;
    let held = null;
    const restore = replaceMethod(wc, "send", function (actual, ...args) {
      if (actual === channel && held === null) {
        held = args[0];
        return;
      }
      return realSend.call(this, actual, ...args);
    });
    return {
      get held() {
        return held;
      },
      release() {
        restore();
        if (held !== null) realSend.call(wc, channel, held);
      },
      restore,
    };
  };

  // Hold every generation of one renderer message. Unlike the one-shot helper
  // above, this exposes both the original updater request and the replayed
  // user request without reimplementing either protocol message.
  const holdAllRendererMessages = (channel) => {
    const realSend = wc.send;
    const held = [];
    const restore = replaceMethod(wc, "send", function (actual, ...args) {
      if (actual === channel) {
        held.push(args[0]);
        return;
      }
      return realSend.call(this, actual, ...args);
    });
    return {
      held,
      release(index) {
        if (held[index]) realSend.call(wc, channel, held[index]);
      },
      restore,
    };
  };

  try {
    write(commitFile, "# Installed commit fixture\n");
    process.on("warning", observeProcessWarning);
    electronAutoUpdater.on("before-quit-for-update", countCommit);
    updater.emit("update-downloaded", {
      version: "9.9.9-f22",
      downloadedFile: commitFile,
    });

    // An event raised inside quitAndInstall is the shortest possible installed
    // commit. Even then it must create a second, force-fresh approval; a clean
    // renderer answers both requests silently, the updater runs once, and the
    // final authorized quit is not re-run by before-quit.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "immediate";
    setLatch(false);
    rig.answer = 0;
    rig.driveQuitLifecycle = true;
    const immediateBeforeRequestId = __shutdown.state().lastRequestId;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const immediateCommitted = await waitUntil(
      () => installs === 1 && rig.quits === 1,
      10000,
    );
    const immediateState = __shutdown.state();
    check(
      "a clean immediate installed commit gets a silent fresh renderer approval and quits once",
      immediateCommitted &&
        installs === 1 &&
        commitSignals === 1 &&
        rig.quits === 1 &&
        rig.quitEvents.length === 1 &&
        rig.quitEvents[0].prevented === false &&
        rig.dialogs.length === 0 &&
        immediateState.pendingId === 0 &&
        immediateState.lastRequestId === immediateBeforeRequestId + 2,
      JSON.stringify({
        immediateCommitted,
        installs,
        commitSignals,
        quits: rig.quits,
        beforeQuitPrevented: rig.quitEvents[0] && rig.quitEvents[0].prevented,
        dialogs: rig.dialogs.length,
        immediateBeforeRequestId,
        state: immediateState,
      }),
    );

    // THE GAP. quitAndInstall() returns without quitting - BaseUpdater emits
    // its public commit on a preserved setImmediate turn - so there is a real
    // interval in which the app is still running, still holds every open
    // document, and has already been told once that shutting down is fine. The
    // permission granted for entering the updater must not still be standing in
    // that interval: a window close arriving inside it would be waved straight
    // through and would discard whatever has been typed since. Nothing else in
    // this suite exercises that interval directly - every other installed-path
    // scenario reaches the commit or an error first.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const enteredDeferredGap = await waitUntil(() => installs === 1, 10000);
    const gapState = __shutdown.state();
    const exactGapEdit = "gap edit that nobody has been asked about";
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab(${jsCommitFile}, 'gap base');
        tab.content = ${JSON.stringify(exactGapEdit)};
        tab.hasUnsavedChanges = false;
        // Set before the switch: the switch snapshots the active tab, and a
        // live copy still holding the pristine text folds this edit away.
        window.originalMarkdown = tab.content;
        window.CustomTabs.switchToTab(tab.id);
        return tab.filename;
      })()
    `);
    rig.answer = 1;
    const closeInGap = guardEvent();
    win.emit("close", closeInGap);
    const gapCloseAsked = await waitUntil(() => rig.dialogs.length === 1, 10000);
    const preservedGapEdit = await exec(
      `window.CustomTabs.getActiveTab().content`,
    );
    const afterGapClose = __shutdown.state();
    check(
      "a native close inside the installed deferred-commit gap is asked rather than silently authorized",
      enteredDeferredGap &&
        gapState.authorized === false &&
        gapState.updateInstallStarted === true &&
        closeInGap.prevented === true &&
        gapCloseAsked &&
        rig.dialogs[0].pendingReason === "window-close" &&
        /f22-installed-commit/.test(String(rig.dialogs[0].options.message)) &&
        preservedGapEdit === exactGapEdit &&
        rig.closes === 0 &&
        rig.quits === 0 &&
        commitSignals === 0 &&
        afterGapClose.authorized === false,
      JSON.stringify({
        enteredDeferredGap,
        gapState,
        prevented: closeInGap.prevented,
        gapCloseAsked,
        dialog: rig.dialogs[0],
        preservedGapEdit,
        closes: rig.closes,
        quits: rig.quits,
        commitSignals,
        afterGapClose,
      }),
    );

    // The initial approval is clean. Change the document only after its
    // continuation has entered the updater, then emit the public commit. The
    // second request has to discover this exact new value; Cancel keeps it
    // intact and leaves no authorization behind.
    __shutdown.reset();
    await waitForCondition(exec, `!window.CustomTabs.isDocumentFrozen()`, 5000);
    await clearDocuments();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab(
          ${jsCommitFile},
          window.fs.readFileSync(${jsCommitFile}, 'utf8'),
        );
        window.CustomTabs.switchToTab(tab.id);
        window.originalMarkdown = tab.originalContent;
        return { id: tab.id, content: tab.content };
      })()
    `);
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const initialApprovalEnteredUpdater = await waitUntil(
      () => installs === 1 && __shutdown.state().authorized === false,
      10000,
    );
    const exactPostApprovalEdit = "# Installed commit fixture\nPOST_APPROVAL_EXACT_EDIT\n";
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = ${JSON.stringify(exactPostApprovalEdit)};
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return tab.content;
      })()
    `);
    rig.answer = 1;
    electronAutoUpdater.emit("before-quit-for-update");
    app.emit("before-quit", guardEvent());
    const postApprovalEditAsked = await waitUntil(() => rig.dialogs.length === 1);
    const preservedPostApprovalEdit = await exec(
      `window.CustomTabs.getActiveTab().content`,
    );
    const editCommitState = __shutdown.state();
    check(
      "an installed commit detects the exact post-approval edit and Cancel preserves it without authorization",
      initialApprovalEnteredUpdater &&
        postApprovalEditAsked &&
        installs === 1 &&
        commitSignals === 1 &&
        rig.quits === 0 &&
        rig.dialogs[0].pendingReason === "update-install" &&
        /f22-installed-commit/.test(String(rig.dialogs[0].options.message)) &&
        preservedPostApprovalEdit === exactPostApprovalEdit &&
        editCommitState.authorized === false &&
        editCommitState.pendingId === 0,
      JSON.stringify({
        initialApprovalEnteredUpdater,
        postApprovalEditAsked,
        installs,
        commitSignals,
        quits: rig.quits,
        dialog: rig.dialogs[0],
        preservedPostApprovalEdit,
        state: editCommitState,
      }),
    );

    // BaseUpdater can refuse synchronously after quitAndInstall is entered.
    // This differs from its already-set preflight latch: the post-call false
    // latch proves nothing started, clears this attempt, and permits a later
    // request rather than leaving a speculative authorization behind.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "synchronous-refusal";
    setLatch(false);
    const restoreSynchronousRefusal = replaceMethod(
      updater,
      "quitAndInstall",
      () => {
        installs += 1;
        setLatch(false);
      },
    );
    try {
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const refusalReturned = await waitUntil(
        () =>
          installs === 1 &&
          __shutdown.state().updateInstallStarted === false &&
          __shutdown.state().authorized === false,
        10000,
      );
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const refusalRetried = await waitUntil(() => installs === 2, 10000);
      check(
        "an installed synchronous refusal clears its attempt and leaves a later install request possible",
        refusalReturned &&
          refusalRetried &&
          rig.quits === 0 &&
          rig.dialogs.length === 0 &&
          __shutdown.state().authorized === false &&
          __shutdown.state().updateInstallStarted === false,
        JSON.stringify({
          refusalReturned,
          refusalRetried,
          installs,
          quits: rig.quits,
          dialogs: rig.dialogs.length,
          state: __shutdown.state(),
        }),
      );
    } finally {
      restoreSynchronousRefusal();
    }

    // An asynchronous updater error occurs after the initial approval and
    // before its public commit. It is terminal for that attempt: cancel the
    // watcher so a late commit cannot resurrect it, revoke authority, and
    // leave a subsequent native close answerable.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const installedAttemptPendingCommit = await waitUntil(() => installs === 1);
    const requestBeforeLateCommit = __shutdown.state().lastRequestId;
    updater.emit("error", new Error("controlled installed updater failure"));
    const afterUpdaterError = __shutdown.state();
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab(${jsCommitFile}, 'updater error base');
        tab.content = 'updater error exact edit';
        tab.hasUnsavedChanges = false;
        // Set before the switch, for the same reason as above.
        window.originalMarkdown = tab.content;
        window.CustomTabs.switchToTab(tab.id);
        return tab.filename;
      })()
    `);
    rig.answer = 1;
    const closeAfterUpdaterError = guardEvent();
    win.emit("close", closeAfterUpdaterError);
    const closeAfterErrorAsked = await waitUntil(() => rig.dialogs.length === 1);
    check(
      "an installed updater error cancels its commit watcher and leaves the next dirty close unauthorized",
      installedAttemptPendingCommit &&
        afterUpdaterError.lastRequestId === requestBeforeLateCommit &&
        afterUpdaterError.authorized === false &&
        afterUpdaterError.updateInstallStarted === true &&
        closeAfterErrorAsked &&
        closeAfterUpdaterError.prevented === true &&
        rig.quits === 0 &&
        /f22-installed-commit/.test(String(rig.dialogs[0].options.message)),
      JSON.stringify({
        installedAttemptPendingCommit,
        requestBeforeLateCommit,
        afterUpdaterError,
        closeAfterErrorAsked,
        closes: rig.closes,
        quits: rig.quits,
        dialog: rig.dialogs[0],
      }),
    );

    // BaseUpdater queues its one lifecycle turn only after install() succeeds.
    // A false/error result therefore has no legitimate future boundary to
    // reserve. The product keeps a failed attempt for exactly one check phase
    // in case an already-queued success boundary raced its error, then removes
    // every ownership record before a retry is admitted.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const failedAttemptStarted = await waitUntil(
      () => installs === 1 && __shutdown.state().updaterInstallAttemptId > 0,
      10000,
    );
    const failedAttemptBeforeError = __shutdown.state();
    const realSetImmediate = global.setImmediate;
    let runFailedAttemptExpiry = null;
    global.setImmediate = (callback, ...args) => {
      runFailedAttemptExpiry = () => callback(...args);
      return { unref() {} };
    };
    try {
      updater.emit(
        "error",
        new Error("controlled BaseUpdater failure with no queued boundary"),
      );
    } finally {
      global.setImmediate = realSetImmediate;
    }
    const failedAttemptQuarantined = __shutdown.state();
    if (runFailedAttemptExpiry) runFailedAttemptExpiry();
    const failedAttemptRetired = __shutdown.state();
    const failedAttemptId = failedAttemptBeforeError.updaterInstallAttemptId;
    const failedAttemptRetiredCompletely =
      failedAttemptRetired.updaterInstallAttemptId === 0 &&
      failedAttemptRetired.updaterPendingCommitAttemptId === 0 &&
      failedAttemptRetired.updaterInstallAttemptExpiryAttemptId === 0 &&
      failedAttemptRetired.updaterQuitBoundaryAttemptId === 0 &&
      failedAttemptRetired.updaterLiveAttemptIds.length === 0 &&
      failedAttemptRetired.updateInstallStarted === false;

    // The retry uses BaseUpdater's actual success shape: exactly one queued
    // callback emits the anonymous boundary and immediately calls app.quit.
    // Keep the rig's app.quit non-terminal until the test drives its paired
    // before-quit event, making the selected boundary owner observable.
    commitMode = "base-updater-success";
    setLatch(false);
    baseUpdaterAttemptAtQueue = null;
    baseUpdaterLifecycleQuitCalls = 0;
    let runRetryBoundaryExpiry = null;
    let restoreRetryBoundaryImmediate = null;
    beforeBaseUpdaterBoundary = () => {
      const realSetImmediate = global.setImmediate;
      global.setImmediate = (callback, ...args) => {
        runRetryBoundaryExpiry = () => callback(...args);
        return { unref() {} };
      };
      restoreRetryBoundaryImmediate = () => {
        global.setImmediate = realSetImmediate;
      };
    };
    afterBaseUpdaterBoundary = () => {
      if (restoreRetryBoundaryImmediate) restoreRetryBoundaryImmediate();
    };
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const retryBoundaryQueued = await waitUntil(
      () =>
        installs === 2 &&
        baseUpdaterLifecycleQuitCalls === 1 &&
        baseUpdaterAttemptAtQueue &&
        __shutdown.state().updaterQuitBoundaryAttemptId ===
          baseUpdaterAttemptAtQueue.updaterInstallAttemptId,
      10000,
    );
    const retryBeforePairedQuit = __shutdown.state();
    const retryAttemptId = baseUpdaterAttemptAtQueue
      ? baseUpdaterAttemptAtQueue.updaterInstallAttemptId
      : 0;
    // A second anonymous boundary while the first still owns its paired quit
    // cannot be assigned safely. It must leave the first owner untouched.
    electronAutoUpdater.emit("before-quit-for-update");
    const retryAfterDuplicateBoundary = __shutdown.state();
    const pairedRetryQuit = guardEvent();
    app.emit("before-quit", pairedRetryQuit);
    const retryAfterPairedQuit = __shutdown.state();
    // A queued expiry callback from A can still run after B has started, but
    // it is identity-bound to A and therefore cannot clear B's slots.
    if (runFailedAttemptExpiry) runFailedAttemptExpiry();
    const retryAfterStaleAExpiry = __shutdown.state();
    beforeBaseUpdaterBoundary = null;
    afterBaseUpdaterBoundary = null;
    check(
      "a failed BaseUpdater attempt is quarantined for one check phase and then retires completely",
      failedAttemptStarted &&
        failedAttemptId > 0 &&
        failedAttemptQuarantined.updaterInstallAttemptId === failedAttemptId &&
        failedAttemptQuarantined.updaterPendingCommitAttemptId === failedAttemptId &&
        failedAttemptQuarantined.updaterInstallAttemptPoisoned === true &&
        failedAttemptQuarantined.updaterInstallAttemptExpiryAttemptId === failedAttemptId &&
        failedAttemptQuarantined.updaterLiveAttemptIds.length === 1 &&
        failedAttemptQuarantined.updaterLiveAttemptIds[0] === failedAttemptId &&
        typeof runFailedAttemptExpiry === "function" &&
        failedAttemptRetiredCompletely,
      JSON.stringify({
        failedAttemptBeforeError,
        failedAttemptQuarantined,
        failedAttemptRetired,
        failedAttemptId,
        expiryCaptured: typeof runFailedAttemptExpiry === "function",
      }),
    );
    check(
      "a retired failed attempt cannot claim a retry's first BaseUpdater boundary or its paired quit",
      retryBoundaryQueued &&
        retryAttemptId > failedAttemptId &&
        retryBeforePairedQuit.updaterQuitBoundaryAttemptId === retryAttemptId &&
        retryBeforePairedQuit.updaterLiveAttemptIds.length === 1 &&
        retryBeforePairedQuit.updaterLiveAttemptIds[0] === retryAttemptId &&
        !retryBeforePairedQuit.updaterLiveAttemptIds.includes(failedAttemptId) &&
        retryAfterDuplicateBoundary.updaterQuitBoundaryAttemptId === retryAttemptId &&
        retryAfterDuplicateBoundary.updaterLiveAttemptIds.length === 1 &&
        pairedRetryQuit.prevented === true &&
        retryAfterPairedQuit.updaterQuitBoundaryAttemptId === 0 &&
        retryAfterPairedQuit.updaterInstallAttemptId === retryAttemptId &&
        retryAfterStaleAExpiry.updaterInstallAttemptId === retryAttemptId &&
        retryAfterStaleAExpiry.updaterPendingCommitAttemptId ===
          retryAfterPairedQuit.updaterPendingCommitAttemptId &&
        retryAfterStaleAExpiry.updaterQuitBoundaryAttemptId === 0 &&
        baseUpdaterLifecycleQuitCalls === 1 &&
        typeof runRetryBoundaryExpiry === "function" &&
        updaterBoundaryListenersBeforeObserver === 1 &&
        electronAutoUpdater.listenerCount("before-quit-for-update") ===
          updaterBoundaryListenersBeforeObserver + 1 &&
        processWarnings.length === 0,
      JSON.stringify({
        failedAttemptId,
        retryAttemptId,
        retryBeforePairedQuit,
        retryAfterDuplicateBoundary,
        pairedRetryQuit,
        retryAfterPairedQuit,
        retryAfterStaleAExpiry,
        updaterBoundaryListenersBeforeObserver,
        currentBoundaryListeners: electronAutoUpdater.listenerCount(
          "before-quit-for-update",
        ),
        warnings: processWarnings.map((warning) => warning.message),
      }),
    );

    // A check failure shares the updater's error event but is not an
    // explicit-install failure. Download-tail ownership is exercised through
    // the real pending tail in the Windows launcher matrix; production
    // rejects starting a download while this attempt is live.
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitMode = "manual";
    setLatch(false);
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const unrelatedErrorAttemptStarted = await waitUntil(
      () => installs === 1 && __shutdown.state().updaterInstallAttemptId > 0,
      10000,
    );
    const beforeCheckError = __shutdown.state();
    updater.emit(
      "error",
      new Error("controlled update check failure"),
      "Cannot check for updates: controlled",
    );
    const afterCheckError = __shutdown.state();
    check(
      "a check error cannot poison a live explicit install attempt",
      unrelatedErrorAttemptStarted &&
        afterCheckError.updaterInstallAttemptId ===
          beforeCheckError.updaterInstallAttemptId &&
        afterCheckError.updaterPendingCommitAttemptId ===
          beforeCheckError.updaterPendingCommitAttemptId &&
        afterCheckError.updaterInstallAttemptPoisoned === false &&
        JSON.stringify(afterCheckError.updaterLiveAttemptIds) ===
          JSON.stringify(beforeCheckError.updaterLiveAttemptIds) &&
        afterCheckError.updaterQuitBoundaryAttemptId === 0,
      JSON.stringify({
        beforeCheckError,
        afterCheckError,
      }),
    );

    // BaseUpdater's lifecycle callback calls app.quit immediately after the
    // boundary. Suppress only that call to model a broken/missing pair, and
    // hold the resulting fresh updater question so its expiry is measured
    // before an unrelated renderer response can settle it.
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitMode = "base-updater-success";
    setLatch(false);
    baseUpdaterAttemptAtQueue = null;
    baseUpdaterPairedQuitCalls = 0;
    suppressBaseUpdaterPairedQuit = true;
    let heldBoundaryRequests = null;
    let runMissingPairExpiry = null;
    let restoreMissingPairImmediate = null;
    beforeBaseUpdaterBoundary = () => {
      heldBoundaryRequests = holdAllRendererMessages("quit-approval-request");
      const realSetImmediate = global.setImmediate;
      global.setImmediate = (callback, ...args) => {
        runMissingPairExpiry = () => callback(...args);
        return { unref() {} };
      };
      restoreMissingPairImmediate = () => {
        global.setImmediate = realSetImmediate;
      };
    };
    afterBaseUpdaterBoundary = () => {
      if (restoreMissingPairImmediate) restoreMissingPairImmediate();
    };
    try {
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const missingPairBoundaryArmed = await waitUntil(
        () =>
          baseUpdaterPairedQuitCalls === 1 &&
          baseUpdaterAttemptAtQueue &&
          __shutdown.state().updaterQuitBoundaryAttemptId ===
            baseUpdaterAttemptAtQueue.updaterInstallAttemptId,
        10000,
      );
      const missingPairBeforeExpiry = __shutdown.state();
      const absorbedClose = guardEvent();
      win.emit("close", absorbedClose);
      const userIntentAbsorbed = await waitUntil(
        () => __shutdown.state().absorbedUserIntentId > 0,
        5000,
      );
      const absorbedState = __shutdown.state();
      if (runMissingPairExpiry) runMissingPairExpiry();
      const absorbedIntentReplayed = await waitUntil(
        () =>
          __shutdown.state().updaterInstallAttemptId === 0 &&
          __shutdown.state().updaterQuitBoundaryAttemptId === 0 &&
          __shutdown.state().pendingReason === "window-close" &&
          heldBoundaryRequests &&
          heldBoundaryRequests.held.length === 2,
        5000,
      );
      const afterMissingPairExpiry = __shutdown.state();
      const unrelatedUserQuit = guardEvent();
      app.emit("before-quit", unrelatedUserQuit);
      const afterUnrelatedUserQuit = __shutdown.state();
      check(
        "a missing paired updater quit expires fail-closed, retires only its attempt, and replays the absorbed user close",
        missingPairBoundaryArmed &&
          missingPairBeforeExpiry.updaterInstallAttemptId > 0 &&
          missingPairBeforeExpiry.updaterQuitBoundaryAttemptId ===
            missingPairBeforeExpiry.updaterInstallAttemptId &&
          missingPairBeforeExpiry.updaterLiveAttemptIds.length === 1 &&
          baseUpdaterPairedQuitCalls === 1 &&
          absorbedClose.prevented === true &&
          userIntentAbsorbed &&
          absorbedState.absorbedUserIntentId > 0 &&
          typeof runMissingPairExpiry === "function" &&
          absorbedIntentReplayed &&
          afterMissingPairExpiry.updaterLiveAttemptIds.length === 0 &&
          afterMissingPairExpiry.updateInstallStarted === false &&
          afterMissingPairExpiry.absorbedUserIntentId === 0 &&
          afterMissingPairExpiry.pendingAbsorbedUserIntentId ===
            absorbedState.absorbedUserIntentId &&
          unrelatedUserQuit.prevented === true &&
          afterUnrelatedUserQuit.updaterQuitBoundaryAttemptId === 0 &&
          afterUnrelatedUserQuit.pendingReason === "window-close",
        JSON.stringify({
          missingPairBeforeExpiry,
          absorbedClose: absorbedClose.prevented,
          absorbedState,
          afterMissingPairExpiry,
          unrelatedUserQuit: unrelatedUserQuit.prevented,
          afterUnrelatedUserQuit,
          heldBoundaryRequests: heldBoundaryRequests && heldBoundaryRequests.held,
          baseUpdaterPairedQuitCalls,
        }),
      );
    } finally {
      if (restoreMissingPairImmediate) restoreMissingPairImmediate();
      if (heldBoundaryRequests) heldBoundaryRequests.restore();
      beforeBaseUpdaterBoundary = null;
      afterBaseUpdaterBoundary = null;
      suppressBaseUpdaterPairedQuit = false;
    }

    // install() can succeed and queue BaseUpdater's one lifecycle callback
    // just as its error path reports failure. The callback still emits its
    // boundary and immediately calls app.quit; both must remain bound to this
    // poisoned attempt and be blocked rather than becoming a user quit.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "base-updater-error-race";
    setLatch(false);
    rig.answer = 0;
    rig.driveQuitLifecycle = true;
    baseUpdaterAttemptAtQueue = null;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const queuedBoundaryErrorWasBlocked = await waitUntil(
      () =>
        installs === 1 &&
        baseUpdaterAttemptAtQueue &&
        rig.quitEvents.length === 1 &&
        rig.quitEvents[0].prevented === true &&
        __shutdown.state().updaterInstallAttemptId === 0 &&
        __shutdown.state().updaterQuitBoundaryAttemptId === 0,
      10000,
    );
    const liveBoundaryState = __shutdown.state();
    const poisonedAttemptId = baseUpdaterAttemptAtQueue
      ? baseUpdaterAttemptAtQueue.updaterInstallAttemptId
      : 0;
    const failedLatchCleared = updater.quitAndInstallCalled === false;
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab(${jsCommitFile}, 'poisoned boundary base');
        tab.content = 'poisoned boundary user intent';
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content + '!';
        window.CustomTabs.switchToTab(tab.id);
        return tab.filename;
      })()
    `);
    rig.answer = 1;
    const closeAfterOldBoundary = guardEvent();
    win.emit("close", closeAfterOldBoundary);
    const unrelatedIntentAsked = await waitUntil(
      () => rig.dialogs.length === 1,
      10000,
    );
    const unrelatedIntentState = __shutdown.state();
    await clearDocuments();
    rig.answer = 0;
    commitMode = "manual";
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const failedAttemptRetried = await waitUntil(
      () =>
        installs === 2 &&
        __shutdown.state().updaterInstallAttemptId > poisonedAttemptId,
      10000,
    );
    const retryAfterFailedBoundary = __shutdown.state();
    check(
      "an error racing a queued BaseUpdater boundary blocks its paired quit, retires safely, and permits retry",
      queuedBoundaryErrorWasBlocked &&
        poisonedAttemptId > 0 &&
        rig.quits === 1 &&
        rig.quitEvents.length === 1 &&
        rig.quitEvents[0].prevented === true &&
        !win.isDestroyed() &&
        failedLatchCleared &&
        closeAfterOldBoundary.prevented === true &&
        unrelatedIntentAsked &&
        rig.dialogs[0].pendingReason === "window-close" &&
        unrelatedIntentState.authorized === false &&
        failedAttemptRetried &&
        retryAfterFailedBoundary.updaterInstallAttemptId > poisonedAttemptId &&
        retryAfterFailedBoundary.updaterInstallAttemptPoisoned === false &&
        rig.closes === 0 &&
        liveBoundaryState.authorized === false &&
        liveBoundaryState.updateInstallStarted === false &&
        liveBoundaryState.updaterLiveAttemptIds.length === 0,
      JSON.stringify({
        baseUpdaterAttemptAtQueue,
        queuedBoundaryErrorWasBlocked,
        failedLatchCleared,
        closeAfterOldBoundary: closeAfterOldBoundary.prevented,
        unrelatedIntentAsked,
        unrelatedIntentState,
        failedAttemptRetried,
        retryAfterFailedBoundary,
        quits: rig.quits,
        quitEvents: rig.quitEvents,
        closes: rig.closes,
        dialogs: rig.dialogs.length,
        state: liveBoundaryState,
      }),
    );

    // A poisoned updater attempt is deliberately narrow. User-origin close
    // requests before and after it must still enter the ordinary approval path,
    // rather than inheriting the updater failure or being ignored as a retry.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    rig.driveQuitLifecycle = true;
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab(${jsCommitFile}, 'poison boundary base');
        window.CustomTabs.switchToTab(tab.id);
        window.originalMarkdown = tab.originalContent;
        return tab.id;
      })()
    `);
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const ordinaryAttemptStarted = await waitUntil(() => installs === 1, 10000);
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        window.originalMarkdown = tab.content + '\\nPOISONED_BOUNDARY_DIRTY\\n';
        return tab.filename;
      })()
    `);
    const realSetImmediateForOrdinaryPoison = global.setImmediate;
    let runOrdinaryPoisonExpiry = null;
    global.setImmediate = (callback, ...args) => {
      runOrdinaryPoisonExpiry = () => callback(...args);
      return { unref() {} };
    };
    try {
      updater.emit("error", new Error("controlled updater failure beside ordinary close"));
    } finally {
      global.setImmediate = realSetImmediateForOrdinaryPoison;
    }
    const ordinaryPoisoned = __shutdown.state();
    rig.answer = 1;
    const closeDuringPoison = guardEvent();
    win.emit("close", closeDuringPoison);
    const ordinaryDuringAsked = await waitUntil(() => rig.dialogs.length === 1, 10000);
    const afterOrdinaryDuring = __shutdown.state();
    if (runOrdinaryPoisonExpiry) runOrdinaryPoisonExpiry();
    const poisonedAttemptRetired = await waitUntil(
      () => __shutdown.state().updaterInstallAttemptId === 0,
      5000,
    );
    const closeAfterPoison = guardEvent();
    win.emit("close", closeAfterPoison);
    const ordinaryAfterAsked = await waitUntil(() => rig.dialogs.length === 2, 10000);
    const afterOrdinaryAfter = __shutdown.state();
    check(
      "user-origin closes during a quarantined updater failure and after its retirement require ordinary approval",
      ordinaryAttemptStarted &&
        ordinaryPoisoned.updaterInstallAttemptPoisoned === true &&
        closeDuringPoison.prevented === true &&
        ordinaryDuringAsked &&
        rig.dialogs[0].pendingReason === "window-close" &&
        afterOrdinaryDuring.authorized === false &&
        afterOrdinaryDuring.updaterInstallAttemptId ===
          ordinaryPoisoned.updaterInstallAttemptId &&
        typeof runOrdinaryPoisonExpiry === "function" &&
        poisonedAttemptRetired &&
        rig.quitEvents.length === 0 &&
        closeAfterPoison.prevented === true &&
        ordinaryAfterAsked &&
        rig.dialogs[1].pendingReason === "window-close" &&
        afterOrdinaryAfter.authorized === false &&
        rig.closes === 0 &&
        !win.isDestroyed(),
      JSON.stringify({
        ordinaryAttemptStarted,
        ordinaryPoisoned,
        ordinaryDuringAsked,
        afterOrdinaryDuring,
        poisonedAttemptRetired,
        ordinaryAfterAsked,
        afterOrdinaryAfter,
        dialogs: rig.dialogs.map((dialog) => dialog.pendingReason),
        quitEvents: rig.quitEvents,
        closes: rig.closes,
      }),
    );

    // The consumed poison belongs only to its attempt. A later update receives
    // a new identity, passes its own boundary, and reaches the normal fresh
    // approval. A successful installed attempt remains live until process exit
    // so a proven installer-spawn error can still retire its own latch.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    rig.driveQuitLifecycle = true;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const retryAttemptStarted = await waitUntil(
      () => installs === 1 && __shutdown.state().updaterInstallAttemptId > poisonedAttemptId,
      10000,
    );
    const retryBeforeBoundary = __shutdown.state();
    electronAutoUpdater.emit("before-quit-for-update");
    const retryBoundaryArmed = await waitUntil(
      () =>
        __shutdown.state().updaterQuitBoundaryAttemptId ===
        retryBeforeBoundary.updaterInstallAttemptId,
      5000,
    );
    app.quit();
    const retryCompleted = await waitUntil(() => rig.quits === 2, 10000);
    const retryState = __shutdown.state();
    check(
      "a successful later update retry gets a new unpoisoned attempt and proceeds through fresh approval",
      retryAttemptStarted &&
        retryBeforeBoundary.updaterInstallAttemptId > poisonedAttemptId &&
        retryBeforeBoundary.updaterInstallAttemptPoisoned === false &&
        retryBoundaryArmed &&
        retryCompleted &&
        rig.quitEvents.length === 2 &&
        rig.quitEvents[0].prevented === true &&
        rig.quitEvents[1].prevented === false &&
        retryState.updaterInstallAttemptId === retryBeforeBoundary.updaterInstallAttemptId &&
        retryState.updaterLiveAttemptIds.length === 1 &&
        retryState.updaterLiveAttemptIds[0] ===
          retryBeforeBoundary.updaterInstallAttemptId &&
        retryState.updaterQuitBoundaryAttemptId === 0 &&
        retryState.authorized === true,
      JSON.stringify({
        poisonedAttemptId,
        retryAttemptStarted,
        retryBeforeBoundary,
        retryBoundaryArmed,
        retryCompleted,
        quitEvents: rig.quitEvents,
        quits: rig.quits,
        state: retryState,
      }),
    );

    // Stop the renderer's real response before an explicit install attempt
    // exists. A shared updater error here is check/download-scoped, not an
    // attempt-specific failure: it cannot cancel the exact held question.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    const heldUpdateApproval = holdRendererMessage("quit-approval-request");
    try {
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const updateApprovalHeld = await waitUntil(
        () =>
          heldUpdateApproval.held !== null &&
          __shutdown.state().pendingReason === "update-install",
        10000,
      );
      const beforeApprovalError = __shutdown.state();
      updater.emit("error", new Error("controlled error before update approval"));
      const afterApprovalError = __shutdown.state();
      heldUpdateApproval.release();
      const heldApprovalContinued = await waitUntil(
        () => installs === 1 && __shutdown.state().updaterInstallAttemptId > 0,
        5000,
      );
      check(
        "a pre-install updater error leaves the exact held update approval untouched",
        updateApprovalHeld &&
          beforeApprovalError.pendingId > 0 &&
          beforeApprovalError.pendingReason === "update-install" &&
          afterApprovalError.pendingId === beforeApprovalError.pendingId &&
          afterApprovalError.pendingReason === beforeApprovalError.pendingReason &&
          afterApprovalError.pendingDispatchedTo ===
            beforeApprovalError.pendingDispatchedTo &&
          afterApprovalError.commitPendingId === beforeApprovalError.commitPendingId &&
          afterApprovalError.authorized === false &&
          afterApprovalError.updateInstallStarted === false &&
          afterApprovalError.updaterShutdownCancelWhy ===
            beforeApprovalError.updaterShutdownCancelWhy &&
          afterApprovalError.updaterContinuationEpoch ===
            beforeApprovalError.updaterContinuationEpoch &&
          heldApprovalContinued,
        JSON.stringify({
          updateApprovalHeld,
          beforeApprovalError,
          afterApprovalError,
          heldApprovalContinued,
          installs,
          finalState: __shutdown.state(),
        }),
      );
    } finally {
      heldUpdateApproval.restore();
    }

    // A shared updater error before an explicit install has started is also
    // unable to refuse the phase-two document commit. Its real reply proceeds;
    // the deadline it displaced is still stale afterwards.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    const realSetTimeout = global.setTimeout;
    let heldCommitDeadline = null;
    global.setTimeout = (callback, delay, ...args) => {
      if (
        delay === 5000 &&
        heldCommitDeadline === null &&
        String(callback).includes("staleShutdownCommitTimeoutCount")
      ) {
        heldCommitDeadline = () => callback(...args);
        return { unref() {} };
      }
      return realSetTimeout(callback, delay, ...args);
    };
    const heldUpdateCommit = holdRendererMessage("quit-approval-commit");
    let beforeCommitError;
    let afterCommitError;
    try {
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const updateCommitHeld = await waitUntil(
        () =>
          heldUpdateCommit.held !== null &&
          __shutdown.state().commitPendingId === heldUpdateCommit.held.id,
        10000,
      );
      beforeCommitError = __shutdown.state();
      global.setTimeout = realSetTimeout;
      updater.emit("error", new Error("controlled error during update commit"));
      afterCommitError = __shutdown.state();
      const freezeAfterError = await exec(`window.CustomTabs.__shutdownFreeze()`);
      const staleDeadlinesBefore = afterCommitError.staleCommitTimeoutCount;
      heldUpdateCommit.release();
      const heldCommitContinued = await waitUntil(
        () => installs === 1 && __shutdown.state().updaterInstallAttemptId > 0,
        5000,
      );
      if (heldCommitDeadline) heldCommitDeadline();
      const delayedDeadlineWasStale = await waitUntil(
        () =>
          __shutdown.state().staleCommitTimeoutCount === staleDeadlinesBefore + 1,
        5000,
      );
      check(
        "a pre-install updater error leaves the exact update commit active and its replaced deadline stale",
        updateCommitHeld &&
          beforeCommitError.commitPendingId > 0 &&
          beforeCommitError.pendingReason === null &&
          afterCommitError.commitPendingId === beforeCommitError.commitPendingId &&
          afterCommitError.commitSequence === beforeCommitError.commitSequence &&
          afterCommitError.pendingId === beforeCommitError.pendingId &&
          afterCommitError.commitRefusedWhy === beforeCommitError.commitRefusedWhy &&
          afterCommitError.commitRefusedCount === beforeCommitError.commitRefusedCount &&
          afterCommitError.authorized === false &&
          afterCommitError.updateInstallStarted === false &&
          freezeAfterError.frozen === false &&
          freezeAfterError.editorReadOnly === false &&
          typeof heldCommitDeadline === "function" &&
          heldCommitContinued &&
          delayedDeadlineWasStale &&
          installs === 1 &&
          rig.closes === 0 &&
          rig.quits === 0,
        JSON.stringify({
          updateCommitHeld,
          beforeCommitError,
          afterCommitError,
          freezeAfterError,
          heldCommitContinued,
          delayedDeadlineWasStale,
          installs,
          closes: rig.closes,
          quits: rig.quits,
          finalState: __shutdown.state(),
        }),
      );
    } finally {
      global.setTimeout = realSetTimeout;
      heldUpdateCommit.restore();
    }

    // Main queues the final update-driven quit with setImmediate. Inject the
    // real updater error after the renderer has confirmed that second commit,
    // before that turn can start: it must invalidate the continuation instead
    // of spawning/quitting after its authority has been withdrawn.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    let errorAfterCommit = 0;
    const failAfterConfirmedUpdateCommit = (_event, data) => {
      if (!data || data.committed !== true || installs !== 1 || errorAfterCommit) return;
      errorAfterCommit += 1;
      updater.emit("error", new Error("controlled error after update commit"));
    };
    ipcMain.on("quit-approval-committed", failAfterConfirmedUpdateCommit);
    try {
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const enteredUpdater = await waitUntil(() => installs === 1, 10000);
      electronAutoUpdater.emit("before-quit-for-update");
      app.emit("before-quit", guardEvent());
      const deferredContinuationInvalidated = await waitUntil(
        () => __shutdown.state().updaterInvalidatedContinuationCount === 1,
        10000,
      );
      const invalidatedContinuationState = __shutdown.state();
      check(
        "an updater error after commit confirmation invalidates the deferred update continuation",
        enteredUpdater &&
          errorAfterCommit === 1 &&
          deferredContinuationInvalidated &&
          installs === 1 &&
          rig.quits === 0 &&
          rig.closes === 0 &&
          invalidatedContinuationState.pendingId === 0 &&
          invalidatedContinuationState.commitPendingId === 0 &&
          invalidatedContinuationState.authorized === false &&
          invalidatedContinuationState.updateInstallStarted === false &&
          invalidatedContinuationState.updaterInstallAttemptId === 0 &&
          invalidatedContinuationState.updaterQuitBoundaryAttemptId === 0 &&
          invalidatedContinuationState.updaterShutdownCancelWhy === "updater-error",
        JSON.stringify({
          enteredUpdater,
          errorAfterCommit,
          deferredContinuationInvalidated,
          installs,
          closes: rig.closes,
          quits: rig.quits,
          state: invalidatedContinuationState,
        }),
      );
    } finally {
      ipcMain.removeListener(
        "quit-approval-committed",
        failAfterConfirmedUpdateCommit,
      );
    }

    // The error handler is scoped to updater-origin work. First hold an
    // ordinary close question, then an ordinary commit, and prove both keep
    // their exact identity across the same updater event before completing
    // through their real renderer messages.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    const heldOrdinaryApproval = holdRendererMessage("quit-approval-request");
    try {
      const ordinaryPendingClose = guardEvent();
      win.emit("close", ordinaryPendingClose);
      const ordinaryPendingHeld = await waitUntil(
        () =>
          heldOrdinaryApproval.held !== null &&
          __shutdown.state().pendingReason === "window-close",
        10000,
      );
      const beforeOrdinaryPendingError = __shutdown.state();
      updater.emit("error", new Error("controlled error beside ordinary pending"));
      const afterOrdinaryPendingError = __shutdown.state();
      heldOrdinaryApproval.release();
      const ordinaryPendingCompleted = await waitUntil(() => rig.closes === 1, 10000);
      check(
        "an updater error leaves an ordinary pending close active with its exact request identity",
        ordinaryPendingClose.prevented === true &&
          ordinaryPendingHeld &&
          afterOrdinaryPendingError.pendingId === beforeOrdinaryPendingError.pendingId &&
          afterOrdinaryPendingError.pendingReason === "window-close" &&
          afterOrdinaryPendingError.pendingDispatchedTo ===
            beforeOrdinaryPendingError.pendingDispatchedTo &&
          afterOrdinaryPendingError.commitPendingId === 0 &&
          afterOrdinaryPendingError.authorized === false &&
          ordinaryPendingCompleted &&
          rig.closes === 1,
        JSON.stringify({
          ordinaryPendingHeld,
          beforeOrdinaryPendingError,
          afterOrdinaryPendingError,
          ordinaryPendingCompleted,
          closes: rig.closes,
          state: __shutdown.state(),
        }),
      );
    } finally {
      heldOrdinaryApproval.restore();
    }

    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    const heldOrdinaryCommit = holdRendererMessage("quit-approval-commit");
    try {
      const ordinaryCommitClose = guardEvent();
      win.emit("close", ordinaryCommitClose);
      const ordinaryCommitHeld = await waitUntil(
        () =>
          heldOrdinaryCommit.held !== null &&
          __shutdown.state().commitPendingId === heldOrdinaryCommit.held.id,
        10000,
      );
      const beforeOrdinaryCommitError = __shutdown.state();
      updater.emit("error", new Error("controlled error beside ordinary commit"));
      const afterOrdinaryCommitError = __shutdown.state();
      heldOrdinaryCommit.release();
      const ordinaryCommitCompleted = await waitUntil(() => rig.closes === 1, 10000);
      check(
        "an updater error leaves an ordinary commit active with its exact commit identity",
        ordinaryCommitClose.prevented === true &&
          ordinaryCommitHeld &&
          afterOrdinaryCommitError.commitPendingId === beforeOrdinaryCommitError.commitPendingId &&
          afterOrdinaryCommitError.commitSequence === beforeOrdinaryCommitError.commitSequence &&
          afterOrdinaryCommitError.commitAuthorisedSeq ===
            beforeOrdinaryCommitError.commitAuthorisedSeq &&
          afterOrdinaryCommitError.commitRefusedCount ===
            beforeOrdinaryCommitError.commitRefusedCount &&
          afterOrdinaryCommitError.authorized === false &&
          ordinaryCommitCompleted &&
          rig.closes === 1,
        JSON.stringify({
          ordinaryCommitHeld,
          beforeOrdinaryCommitError,
          afterOrdinaryCommitError,
          ordinaryCommitCompleted,
          closes: rig.closes,
          state: __shutdown.state(),
        }),
      );
    } finally {
      heldOrdinaryCommit.restore();
    }

    // Once a continuation has crossed its setImmediate guard and called
    // app.quit(), an updater error is too late to revoke it. The error is
    // raised by the app.quit stub itself, so the call is the real, already
    // started continuation rather than a direct test invocation.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    const restoreQuitAfterStartedContinuation = replaceMethod(app, "quit", () => {
      rig.quits += 1;
      updater.emit("error", new Error("controlled error after continuation started"));
    });
    try {
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const startedUpdaterBeforeQuit = await waitUntil(() => installs === 1, 10000);
      electronAutoUpdater.emit("before-quit-for-update");
      app.emit("before-quit", guardEvent());
      const alreadyStartedContinuationCompleted = await waitUntil(
        () => rig.quits === 1,
        10000,
      );
      const afterStartedContinuationError = __shutdown.state();
      check(
        "an updater error after its continuation has started does not revoke the already-started quit",
        startedUpdaterBeforeQuit &&
          alreadyStartedContinuationCompleted &&
          installs === 1 &&
          rig.quits === 1 &&
          rig.closes === 0 &&
          afterStartedContinuationError.updaterInvalidatedContinuationCount === 0 &&
          afterStartedContinuationError.pendingId === 0 &&
          afterStartedContinuationError.commitPendingId === 0 &&
          afterStartedContinuationError.authorized === false &&
          afterStartedContinuationError.updateInstallStarted === false &&
          afterStartedContinuationError.updaterInstallAttemptId === 0 &&
          afterStartedContinuationError.updaterQuitBoundaryAttemptId === 0 &&
          afterStartedContinuationError.updaterShutdownCancelWhy === "updater-error",
        JSON.stringify({
          startedUpdaterBeforeQuit,
          alreadyStartedContinuationCompleted,
          installs,
          closes: rig.closes,
          quits: rig.quits,
          state: afterStartedContinuationError,
        }),
      );
    } finally {
      restoreQuitAfterStartedContinuation();
    }

    // A commit can arrive while an ordinary close question is still open. It
    // is stronger and force-fresh, so it must remain queued and subsequently
    // ask on its own; cancelling the first question is not permission to drop
    // (or silently coalesce) the updater's public commit.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab(${jsCommitFile}, 'pending close edit');
        tab.content = 'pending close edit';
        tab.hasUnsavedChanges = false;
        window.CustomTabs.switchToTab(tab.id);
        window.originalMarkdown = tab.content + '!';
        return tab.filename;
      })()
    `);
    // Start a clean update attempt first, leaving only its public commit
    // outstanding; then make the document dirty and hold a close dialog.
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const waitingForCommit = await waitUntil(() => installs === 1);
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = 'pending close exact edit';
        window.originalMarkdown = tab.content;
        return tab.content;
      })()
    `);
    let releaseCloseQuestion;
    rig.answer = () =>
      new Promise((resolve) => {
        releaseCloseQuestion = resolve;
      });
    const pendingClose = guardEvent();
    win.emit("close", pendingClose);
    const closeQuestionHeld = await waitUntil(() => rig.dialogs.length === 1);
    electronAutoUpdater.emit("before-quit-for-update");
    app.emit("before-quit", guardEvent());
    const committedWhileHeld = __shutdown.state();
    rig.answer = 1;
    if (releaseCloseQuestion) releaseCloseQuestion(1);
    const freshCommitQuestion = await waitUntil(
      () => rig.dialogs.length === 2 && __shutdown.state().pendingId === 0,
      10000,
    );
    check(
      "an updater commit arriving behind another question remains a required fresh question",
      waitingForCommit &&
        closeQuestionHeld &&
        pendingClose.prevented === true &&
        committedWhileHeld.queuedReason === "update-install" &&
        freshCommitQuestion &&
        rig.dialogs[0].pendingReason === "window-close" &&
        rig.dialogs[1].pendingReason === "update-install" &&
        installs === 1 &&
        rig.quits === 0 &&
        __shutdown.state().authorized === false,
      JSON.stringify({
        waitingForCommit,
        closeQuestionHeld,
        committedWhileHeld,
        freshCommitQuestion,
        dialogs: rig.dialogs.map((dialog) => dialog.pendingReason),
        installs,
        quits: rig.quits,
        state: __shutdown.state(),
      }),
    );

    // The commit boundary can find a dead renderer even though the initial
    // installed approval was clean. That new, force-fresh request must use the
    // explicit main-process question; cancelling it can never retain authority.
    await clearDocuments();
    __shutdown.reset();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "manual";
    setLatch(false);
    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const commitAwaitingDeadRenderer = await waitUntil(() => installs === 1);
    wc.forcefullyCrashRenderer();
    const rendererDead = await waitUntil(
      () => __shutdown.state().renderer === "unusable",
      10000,
    );
    rig.answer = 1;
    electronAutoUpdater.emit("before-quit-for-update");
    const deadCommitFallback = await waitUntil(
      () => rig.dialogs.length === 1 && __shutdown.state().pendingId === 0,
      10000,
    );
    const deadCommitState = __shutdown.state();
    check(
      "a dead renderer at installed commit uses the explicit fallback and Cancel leaves authorization false",
      commitAwaitingDeadRenderer &&
        rendererDead &&
        deadCommitFallback &&
        rig.quits === 0 &&
        rig.dialogs[0].pendingReason === "update-install" &&
        /cannot be checked/i.test(String(rig.dialogs[0].options.title)) &&
        deadCommitState.settleWhy === "fallback-unresponsive" &&
        deadCommitState.authorized === false,
      JSON.stringify({
        commitAwaitingDeadRenderer,
        rendererDead,
        deadCommitFallback,
        installs,
        quits: rig.quits,
        dialog: rig.dialogs[0],
        state: deadCommitState,
      }),
    );
    // The preceding dead-renderer case deliberately crashes this webContents.
    // Restore its real document before exercising further live IPC boundaries.
    if (wc.isCrashed()) {
      await win.loadFile(indexFile);
      await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
    }

    // A user close or quit that lands behind an updater approval is retained
    // outside that update's authority. This matrix drives the real renderer
    // request/reply boundary and verifies each cancellation path replays that
    // exact user intent once, with its original arrival/strength identity.
    const runAbsorbedUserReplayCase = async ({ name, failure, arrivals, expectedReason }) => {
      await clearDocuments();
      __shutdown.reset();
      rig.reset();
      installs = 0;
      commitSignals = 0;
      commitMode = failure === "decline" ? "manual" : failure;
      setLatch(false);
      await exec(`
        (() => {
          const tab = window.CustomTabs.createTab(${jsCommitFile}, 'absorbed-user base');
          window.CustomTabs.switchToTab(tab.id);
          window.originalMarkdown = tab.originalContent;
          return tab.id;
        })()
      `);
      const held = holdAllRendererMessages("quit-approval-request");
      let result;
      try {
        await exec(`window.ipcRenderer.send('install-update'); null;`);
        const updaterRequestHeld = await waitUntil(() => held.held.length === 1, 10000);
        const gestures = [];
        for (const arrival of arrivals) {
          const event = guardEvent();
          if (arrival === "close") win.emit("close", event);
          else app.emit("before-quit", event);
          gestures.push({ arrival, prevented: event.prevented });
        }
        const absorbed = __shutdown.state();
        if (failure === "decline") {
          await exec(`
            (() => {
              const tab = window.CustomTabs.getActiveTab();
              window.originalMarkdown = tab.content + "\\nABSORBED_UPDATE_DECLINED\\n";
              return true;
            })()
          `);
          rig.answer = 1;
        }
        held.release(0);
        const replayed = await waitUntil(
          () =>
            held.held.length === 2 &&
            __shutdown.state().pendingReason === expectedReason &&
            __shutdown.state().pendingAbsorbedUserIntentId === absorbed.absorbedUserIntentId,
          10000,
        );
        const replay = __shutdown.state();
        const staleBefore = replay.staleResponseCount;
        // Re-deliver the real old updater request after the user replay is
        // pending. Its cached renderer reply is an authentic stale callback.
        held.release(0);
        const staleOldCallback = await waitUntil(
          () => __shutdown.state().staleResponseCount === staleBefore + 1,
          5000,
        );
        // The replay is a NEW approval, so approve it independently of the
        // updater cancellation (the decline row intentionally used Cancel for
        // the old update question).
        rig.answer = 0;
        held.release(1);
        const userCompleted = await waitUntil(
          () =>
            expectedReason === "window-close" ? rig.closes === 1 : rig.quits === 1,
          10000,
        );
        result = {
          updaterRequestHeld,
          gestures,
          absorbed,
          replayed,
          replay,
          staleOldCallback,
          userCompleted,
          final: __shutdown.state(),
          closes: rig.closes,
          quits: rig.quits,
          held: held.held.map(({ id, reason, gen }) => ({ id, reason, gen })),
        };
      } finally {
        held.restore();
        commitMode = "manual";
      }
      check(
        name,
        result.updaterRequestHeld &&
          result.gestures.every((gesture) => gesture.prevented === true) &&
          result.absorbed.absorbedUserReason === expectedReason &&
          result.absorbed.absorbedUserIntentId > 0 &&
          result.absorbed.absorbedUserArrivalOrder === result.absorbed.absorbedUserIntentId &&
          result.replayed &&
          result.replay.pendingAbsorbedUserIntentId === result.absorbed.absorbedUserIntentId &&
          result.replay.pendingAbsorbedUserArrivalOrder === result.absorbed.absorbedUserArrivalOrder &&
          result.held.length === 2 &&
          result.held[0].reason === "update-install" &&
          result.held[1].reason === expectedReason &&
          result.held[1].id > result.held[0].id &&
          result.staleOldCallback &&
          result.userCompleted &&
          result.final.absorbedUserIntentId === 0,
        JSON.stringify(result),
      );
    };

    for (const failure of ["decline", "throw", "refusal", "error"]) {
      await runAbsorbedUserReplayCase({
        name: `an absorbed user close replays once through fresh approval when its updater ${failure}s`,
        failure,
        arrivals: ["close"],
        expectedReason: "window-close",
      });
    }
    // A successful update is the opposite terminal outcome: its final approved
    // quit consumes the absorbed user intent rather than replaying it beside a
    // shutdown that is already under way.
    __shutdown.reset();
    await waitForCondition(exec, `!window.CustomTabs.isDocumentFrozen()`, 5000);
    await clearDocuments();
    rig.reset();
    installs = 0;
    commitSignals = 0;
    commitMode = "base-updater-success";
    setLatch(false);
    rig.driveQuitLifecycle = true;
    await exec(`
      (() => {
        const tab = window.CustomTabs.createTab(${jsCommitFile}, 'absorbed success base');
        window.CustomTabs.switchToTab(tab.id);
        window.originalMarkdown = tab.originalContent;
        return tab.id;
      })()
    `);
    const heldSuccessfulUpdate = holdAllRendererMessages("quit-approval-request");
    try {
      await exec(`window.ipcRenderer.send('install-update'); null;`);
      const updateRequestHeld = await waitUntil(() => heldSuccessfulUpdate.held.length === 1, 10000);
      const absorbedClose = guardEvent();
      win.emit("close", absorbedClose);
      const beforeSuccessfulUpdate = __shutdown.state();
      heldSuccessfulUpdate.release(0);
      const updaterStarted = await waitUntil(() => installs === 1, 10000);
      const finalUpdateApprovalHeld = await waitUntil(
        () => heldSuccessfulUpdate.held.length === 2,
        10000,
      );
      heldSuccessfulUpdate.release(1);
      const successfulUpdateQuit = await waitUntil(() => rig.quits === 2, 10000);
      const afterSuccessfulUpdate = __shutdown.state();
      check(
        "a successful final update quit discards its absorbed user close instead of replaying it",
        updateRequestHeld &&
          absorbedClose.prevented === true &&
          beforeSuccessfulUpdate.absorbedUserReason === "window-close" &&
          updaterStarted &&
          finalUpdateApprovalHeld &&
          heldSuccessfulUpdate.held.length === 2 &&
          heldSuccessfulUpdate.held.every((request) => request.reason === "update-install") &&
          successfulUpdateQuit &&
          rig.closes === 0 &&
          afterSuccessfulUpdate.absorbedUserIntentId === 0 &&
          afterSuccessfulUpdate.pendingId === 0,
        JSON.stringify({
          updateRequestHeld,
          absorbedClose: absorbedClose.prevented,
          beforeSuccessfulUpdate,
          updaterStarted,
          finalUpdateApprovalHeld,
          requests: heldSuccessfulUpdate.held,
          successfulUpdateQuit,
          closes: rig.closes,
          quits: rig.quits,
          state: afterSuccessfulUpdate,
        }),
      );
    } finally {
      heldSuccessfulUpdate.restore();
    }

    for (const ordering of [
      {
        name: "an absorbed close followed by quit replays the stronger later user intent after updater cancellation",
        arrivals: ["close", "quit"],
        expectedReason: "app-quit",
      },
      {
        name: "an absorbed quit followed by close retains the earlier stronger user intent after updater cancellation",
        arrivals: ["quit", "close"],
        expectedReason: "app-quit",
      },
      {
        name: "duplicate absorbed closes retain their earliest user intent and replay it once after updater cancellation",
        arrivals: ["close", "close"],
        expectedReason: "window-close",
      },
    ]) {
      await runAbsorbedUserReplayCase({ ...ordering, failure: "refusal" });
    }

  } finally {
    restoreQuitAndInstall();
    restoreLatch();
    electronAutoUpdater.removeListener("before-quit-for-update", countCommit);
    process.removeListener("warning", observeProcessWarning);
    rig.restore();
    __shutdown.reset();
    if (wc.isDestroyed()) return;
    await win.loadFile(indexFile).catch(() => {});
    await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
  }
}

async function runWindowsInstalledLauncherScenarios(win, exec) {
  const updater = require("electron-updater").autoUpdater;
  const childProcess = require("child_process");
  const wc = win.webContents;
  const rig = shutdownRig(win);
  const installerPath = path.join(dir, "f22-nsis-installer.exe");
  const packagePath = path.join(dir, "f22-nsis-package.7z");
  const resourcesPath = path.join(dir, "f22-resources");
  const elevatePath = path.join(resourcesPath, "elevate.exe");
  const trackedFields = [
    "installerPath",
    "downloadedUpdateHelper",
    "autoRunAppAfterInstall",
    "installDirectory",
    "autoInstallOnAppQuit",
    "quitAndInstallCalled",
  ];
  const descriptors = new Map(
    trackedFields.map((name) => [name, Object.getOwnPropertyDescriptor(updater, name)]),
  );
  const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const restoreFields = () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(updater, name, descriptor);
      else delete updater[name];
    }
    if (resourcesDescriptor) Object.defineProperty(process, "resourcesPath", resourcesDescriptor);
    else delete process.resourcesPath;
  };
  const setField = (name, value) =>
    Object.defineProperty(updater, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  const setLatch = (value) => setField("quitAndInstallCalled", value);
  const children = [];
  const spawnCalls = [];
  let nextSpawn = [];
  const makeChild = () => {
    const child = new (require("events").EventEmitter)();
    child.pid = 7000 + children.length;
    child.unrefCalls = 0;
    child.unrefListenerCounts = [];
    child.unref = () => {
      child.unrefCalls += 1;
      child.unrefListenerCounts.push({
        spawn: child.listenerCount("spawn"),
        error: child.listenerCount("error"),
        close: child.listenerCount("close"),
      });
    };
    children.push(child);
    return child;
  };
  const restoreSpawn = replaceMethod(childProcess, "spawn", (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const action = nextSpawn.shift() || {};
    if (action.throw) throw action.throw;
    const child = makeChild();
    if (action.child) action.child(child);
    return child;
  });
  const reset = () => {
    __shutdown.reset();
    rig.reset();
    spawnCalls.length = 0;
    nextSpawn = [];
    setLatch(false);
    updater.emit("update-downloaded", {
      version: "9.9.9-nsis",
      downloadedFile: installerPath,
    });
  };
  const start = () => exec(`window.ipcRenderer.send('install-update'); null;`);

  try {
    write(installerPath, "f22 installer");
    write(packagePath, "f22 package");
    fs.mkdirSync(resourcesPath, { recursive: true });
    write(elevatePath, "f22 elevate");
    Object.defineProperty(process, "resourcesPath", {
      value: resourcesPath,
      configurable: true,
    });
    setField("installerPath", installerPath);
    setField("downloadedUpdateHelper", {
      downloadedFileInfo: { isAdminRightsRequired: false },
    });
    setField("autoRunAppAfterInstall", true);
    setField("installDirectory", "");
    // runShutdownScenarios temporarily exercises BaseUpdater as Linux; restore
    // the Windows production configuration before testing Folia's launcher.
    setField("autoInstallOnAppQuit", false);

    // update-downloaded occurs before downloadUpdate's promise tail. Its path
    // is visible to the UI, but cannot authorize installation or poison an
    // unrelated launcher while that tail is still outstanding.
    let settleDownload;
    const restoreDownload = replaceMethod(
      updater,
      "downloadUpdate",
      () => new Promise((resolve, reject) => { settleDownload = { resolve, reject }; }),
    );
    try {
      __shutdown.reset();
      rig.reset();
      await exec(`window.ipcRenderer.send('download-update'); null;`);
      updater.emit("update-downloaded", { version: "tail", downloadedFile: installerPath });
      const heldTail = __shutdown.state();
      await start();
      updater.emit("error", new Error("download tail error"));
      const afterTailError = __shutdown.state();
      if (settleDownload) settleDownload.reject(new Error("tail rejected"));
      const failedTail = await waitUntil(
        () => __shutdown.state().updaterDownloadInFlight === false,
        5000,
      );
      const afterFailedTail = __shutdown.state();
      await start();
      await sleep(100);
      check(
        "a pending download tail owns update errors and invalidates its advertised installer path on failure",
        heldTail.updaterDownloadInFlight === true &&
          afterTailError.updaterDownloadInFlight === true &&
          afterTailError.updaterInstallAttemptId === 0 &&
          afterTailError.updateInstallStarted === false &&
          failedTail &&
          afterFailedTail.updaterDownloadInFlight === false &&
          afterFailedTail.pendingId === 0 &&
          afterFailedTail.updaterInstallAttemptId === 0,
        JSON.stringify({ heldTail, afterTailError, afterFailedTail, spawnCalls }),
      );
    } finally {
      restoreDownload();
    }

    // The verified launcher deliberately supports only stock NSIS arguments.
    // A custom /D or web package cannot be relayed safely, so it must fail
    // before creating a child or retaining an installation latch.
    reset();
    setField("installDirectory", "C:\\Unsupported Directory");
    const directoryRequestBefore = __shutdown.state().lastRequestId;
    await start();
    const unsupportedDirectoryRejected = await waitUntil(
      () =>
        __shutdown.state().lastRequestId > directoryRequestBefore &&
        __shutdown.state().updaterInstallAttemptId === 0,
      5000,
    );
    const afterUnsupportedDirectory = __shutdown.state();
    setField("installDirectory", "");
    setField("downloadedUpdateHelper", {
      downloadedFileInfo: { isAdminRightsRequired: false },
      packageFile: packagePath,
    });
    const packageRequestBefore = __shutdown.state().lastRequestId;
    await start();
    const unsupportedPackageRejected = await waitUntil(
      () =>
        __shutdown.state().lastRequestId > packageRequestBefore &&
        __shutdown.state().updaterInstallAttemptId === 0,
      5000,
    );
    const afterUnsupportedPackage = __shutdown.state();
    setField("downloadedUpdateHelper", {
      downloadedFileInfo: { isAdminRightsRequired: false },
    });
    check(
      "unsupported Windows NSIS metadata fails closed before a launcher child exists",
      unsupportedDirectoryRejected &&
        unsupportedPackageRejected &&
        spawnCalls.length === 0 &&
        updater.quitAndInstallCalled === false &&
        afterUnsupportedDirectory.updateInstallStarted === false &&
        afterUnsupportedDirectory.updaterFreezeRetained === false &&
        afterUnsupportedPackage.updateInstallStarted === false &&
        afterUnsupportedPackage.updaterFreezeRetained === false,
      JSON.stringify({
        spawnCalls,
        afterUnsupportedDirectory,
        afterUnsupportedPackage,
      }),
    );

    // The phase-two commit has already frozen the exact document before any
    // NSIS child exists. A direct child is a hand-off only after its positive
    // spawn event, at which point it quits under that final approval.
    // The real launch plan, including the web-package and force-run arguments,
    // is inspected at the process boundary rather than duplicated internally.
    reset();
    await start();
    const directStarting = await waitUntil(() => spawnCalls.length === 1, 5000);
    const directBeforeSpawn = __shutdown.state();
    const directChild = children[children.length - 1];
    check(
      "the final Windows approval is committed and frozen before any direct launcher proof",
      directStarting &&
        directBeforeSpawn.updaterInstallAttemptFinalApprovalCommitted === true &&
        directBeforeSpawn.updaterFreezeRetained === true &&
        directBeforeSpawn.shutdownPendingContinuationCount === 1 &&
        directBeforeSpawn.authorized === false &&
        directBeforeSpawn.commitPendingId === 0 &&
        rig.dialogs.length === 0,
      JSON.stringify({ directBeforeSpawn, spawnCalls, dialogs: rig.dialogs.length }),
    );
    if (directChild) directChild.emit("spawn");
    const directQuit = await waitUntil(() => rig.quits === 1, 5000);
    const directAfterSpawn = __shutdown.state();
    await start();
    await sleep(100);
    check(
      "a direct NSIS spawn proves one exact launcher hand-off under final phase-two approval and blocks duplicate auto-install",
      directStarting &&
        spawnCalls[0].command === installerPath &&
        JSON.stringify(spawnCalls[0].args) ===
          JSON.stringify([
            "--updated",
            "--force-run",
          ]) &&
        directBeforeSpawn.updaterInstallAttemptLaunchOwner === "folia" &&
        directBeforeSpawn.updaterInstallAttemptLaunchMethod === "direct" &&
        directBeforeSpawn.updaterInstallAttemptPositiveLaunchObserved === false &&
        directBeforeSpawn.updaterInstallAttemptFinalApprovalCommitted === true &&
        directBeforeSpawn.updaterFreezeRetained === true &&
        directBeforeSpawn.shutdownPendingContinuationCount === 1 &&
        directQuit &&
        directChild &&
        directChild.unrefCalls === 1 &&
        directChild.unrefListenerCounts[0].spawn === 1 &&
        directChild.unrefListenerCounts[0].error === 1 &&
        directChild.unrefListenerCounts[0].close === 1 &&
        directAfterSpawn.updaterInstallAttemptPositiveLaunchObserved === true &&
        directAfterSpawn.updaterInstallAttemptLaunchPhase ===
          "quitting-after-installer-start" &&
        directAfterSpawn.authorized === true &&
        directAfterSpawn.lastRequestId === directBeforeSpawn.lastRequestId &&
        rig.dialogs.length === 0 &&
        directAfterSpawn.updaterAutoInstallOnAppQuit === false &&
        spawnCalls.length === 1 &&
        updater.quitAndInstallCalled === true,
      JSON.stringify({ spawnCalls, directBeforeSpawn, directAfterSpawn, quits: rig.quits }),
    );

    // Before a direct child proves start, every failure is retry-safe. Once it
    // proves start, later ambiguous child events cannot lower its duplicate
    // latch or create a second launcher.
    reset();
    nextSpawn.push({ throw: new Error("controlled direct sync throw") });
    await start();
    const afterDirectThrow = await waitUntil(
      () =>
        spawnCalls.length === 1 &&
        __shutdown.state().updaterInstallAttemptId === 0 &&
        __shutdown.state().updaterLastInstallAttempt &&
        __shutdown.state().updaterLastInstallAttempt.retrySafe === true,
      5000,
    );
    await start();
    const directErrorReady = await waitUntil(() => spawnCalls.length === 2, 5000);
    const directErrorChild = children[children.length - 1];
    if (directErrorChild) directErrorChild.emit("error", new Error("controlled pre-spawn error"));
    const afterDirectError = await waitUntil(
      () => __shutdown.state().updaterInstallAttemptId === 0,
      5000,
    );
    check(
      "direct NSIS sync and pre-spawn failures fail closed and permit retry only because no launch was proven",
      afterDirectThrow &&
        directErrorReady &&
        afterDirectError &&
        __shutdown.state().updateInstallStarted === false &&
        updater.quitAndInstallCalled === false &&
        rig.quits === 0,
      JSON.stringify({ spawnCalls, state: __shutdown.state(), quits: rig.quits }),
    );

    reset();
    await start();
    const ambiguousReady = await waitUntil(() => spawnCalls.length === 1, 5000);
    const ambiguousChild = children[children.length - 1];
    if (ambiguousChild) {
      ambiguousChild.emit("spawn");
      ambiguousChild.emit("error", new Error("post-spawn ambiguity"));
      ambiguousChild.emit("close", 1, null);
    }
    await sleep(150);
    await start();
    await sleep(100);
    check(
      "post-spawn NSIS ambiguity remains latched and cannot launch a duplicate installer",
      ambiguousReady &&
        __shutdown.state().updaterInstallAttemptPositiveLaunchObserved === true &&
        __shutdown.state().updateInstallStarted === true &&
        updater.quitAndInstallCalled === true &&
        spawnCalls.length === 1,
      JSON.stringify({ state: __shutdown.state(), spawnCalls, quits: rig.quits }),
    );

    // Access denied is the only direct failure that may use elevate.exe. The
    // helper's successful zero close is the positive ShellExecuteEx proof;
    // non-zero termination remains retry-safe.
    reset();
    await start();
    const eaccesDirectReady = await waitUntil(() => spawnCalls.length === 1, 5000);
    const eaccesDirect = children[children.length - 1];
    if (eaccesDirect) {
      const error = new Error("controlled EACCES");
      error.code = "EACCES";
      eaccesDirect.emit("error", error);
    }
    const elevatedReady = await waitUntil(() => spawnCalls.length === 2, 5000);
    const elevated = children[children.length - 1];
    if (elevated) {
      elevated.emit("spawn");
      elevated.emit("close", 0, null);
    }
    const elevatedQuit = await waitUntil(() => rig.quits === 1, 5000);
    const elevatedState = __shutdown.state();
    check(
      "EACCES retries through bundled elevate.exe and only exit zero proves the elevated installer hand-off",
      eaccesDirectReady &&
        elevatedReady &&
        spawnCalls[1].command === elevatePath &&
        spawnCalls[1].args[0] === installerPath &&
        spawnCalls[1].args.includes("--updated") &&
        spawnCalls[1].args.includes("--force-run") &&
        spawnCalls[1].args.length === 3 &&
        elevatedQuit &&
        elevatedState.updaterInstallAttemptLaunchMethod === "elevated" &&
        elevatedState.updaterInstallAttemptPositiveLaunchObserved === true &&
        elevated &&
        elevated.unrefCalls === 1 &&
        elevated.unrefListenerCounts[0].spawn === 1 &&
        elevated.unrefListenerCounts[0].error === 1 &&
        elevated.unrefListenerCounts[0].close === 1 &&
        elevatedState.updaterAutoInstallOnAppQuit === false &&
        updater.quitAndInstallCalled === true,
      JSON.stringify({ spawnCalls, elevatedState, quits: rig.quits }),
    );
  } finally {
    restoreSpawn();
    restoreFields();
    rig.restore();
    __shutdown.reset();
  }
}

async function runShutdownScenarios(win, exec, sentinel) {
  const fileQ1 = path.join(dir, "quit-alpha.md");
  const fileQ2 = path.join(dir, "quit-beta.md");
  const impostorFile = path.join(dir, "impostor.html");
  const indexFile = path.join(__dirname, "..", "src", "index.html");
  write(fileQ1, "# Quit Alpha\n\nQ_ALPHA\n");
  write(fileQ2, "# Quit Beta\n\nQ_BETA\n");
  fs.writeFileSync(
    impostorFile,
    '<!doctype html><meta charset="utf-8"><title>impostor</title><p>not a document window</p>',
    "utf8",
  );
  const jsQ1 = JSON.stringify(fileQ1);
  const jsQ2 = JSON.stringify(fileQ2);

  const rig = shutdownRig(win);
  const wc = win.webContents;
  let installs = 0;
  let installThrows = false;
  let installDefersQuit = false;
  let updaterModule = null;
  let restoreInstall = null;
  let restoreUpdaterLatch = null;
  let setUpdaterLatch = null;
  let publicUpdateCommitSignals = 0;
  const countPublicUpdateCommit = () => {
    publicUpdateCommitSignals += 1;
  };
  try {
    // TRAP: the updater module costs ~175ms to require and main.js loads it on
    // first use only (test-startup-perf.js pins that). Nothing in this
    // protocol may pull it in early - so this is checked BEFORE the suite
    // itself requires it below.
    check(
      "the shutdown protocol has not pulled the updater module in behind the lazy load",
      !Object.keys(require.cache).some((p) =>
        p.replace(/\\/g, "/").includes("node_modules/electron-updater/"),
      ),
      Object.keys(require.cache)
        .filter((p) => p.includes("electron-updater"))
        .join(", "),
    );
    updaterModule = require("electron-updater");
    // Model electron-updater's real, protected latch. Its BaseUpdater path
    // silently declines a second quitAndInstall() call when this is already
    // true, so omitting it makes a mock prove the opposite of production.
    const updaterLatchDescriptor = Object.getOwnPropertyDescriptor(
      updaterModule.autoUpdater,
      "quitAndInstallCalled",
    );
    restoreUpdaterLatch = () => {
      if (updaterLatchDescriptor) {
        Object.defineProperty(
          updaterModule.autoUpdater,
          "quitAndInstallCalled",
          updaterLatchDescriptor,
        );
      } else {
        delete updaterModule.autoUpdater.quitAndInstallCalled;
      }
    };
    // In some electron-updater versions this protected field is inherited
    // behind an accessor. Define an own value so the mock models the exact
    // boolean main.js reads rather than silently assigning a no-op.
    setUpdaterLatch = (value) =>
      Object.defineProperty(updaterModule.autoUpdater, "quitAndInstallCalled", {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    setUpdaterLatch(false);
    electronAutoUpdater.on("before-quit-for-update", countPublicUpdateCommit);
    restoreInstall = replaceMethod(
      updaterModule.autoUpdater,
      "quitAndInstall",
      () => {
        installs += 1;
        if (installThrows) throw new Error("installer spawn failed (test)");
        setUpdaterLatch(true);
        if (installDefersQuit) {
          // This is Electron's PUBLIC autoUpdater event, not an event invented
          // on electron-updater's mock. It is the product's documented commit
          // boundary between the void call and the delayed lifecycle quit.
          setUpdaterLatch(true);
          electronAutoUpdater.emit("before-quit-for-update");
          app.emit("before-quit", guardEvent());
        }
      },
    );
    // A known-clean two-tab document set. Earlier scenarios leave edits and
    // edit sessions behind, and closeTab() asks about a dirty tab through a
    // real window.confirm - which would block executeJavaScript forever - so
    // the teardown answers for itself and then puts the confirm back.
    await exec(`
      (() => {
        const realConfirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().forEach(t => { t.content = t.originalContent; t.hasUnsavedChanges = false; });
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = realConfirm;
        }
        window.isEditMode = false;
        localStorage.clear();
        return true;
      })()
    `);
    // A witness for the REQUEST half of the round trip. Without it "the window
    // closed and nothing was asked" cannot tell a renderer that answered
    // "clean" apart from a guard that never asked at all.
    await exec(`
      window.__quitRequestCount = 0;
      require('electron').ipcRenderer.on('quit-approval-request', () => { window.__quitRequestCount++; });
      null;
    `);
    // EVERY DOCUMENT STORE, THROUGH THE PATHS THE PRODUCT USES.
    //
    // A document is held in three places at once: the tab's cache
    // (`tab.content`, an accessor that maintains the dirty state), the ACTIVE
    // document's live copy (`window.originalMarkdown` in view mode, the
    // textarea in edit mode), and the on-disk baseline (`tab.originalContent`).
    // A scenario that leaves an edit in ANY of them hands it to the next one:
    // the shutdown fold pulls the live copy into the cache, so a mutation left
    // in `window.originalMarkdown` becomes a dirty tab several assertions
    // later, in a scenario that never touched it. Measured exactly that way -
    // the freeze block deliberately leaves a live-copy mutation behind, and the
    // window-all-closed cascade three assertions later then found the document
    // dirty and asked a second question.
    //
    // Nothing here reaches into private state: it writes the same fields the
    // product writes, and then asks the PRODUCT whether anything is unsaved.
    const restoreCleanDocuments = () =>
      exec(`
        (() => {
          for (const tab of window.CustomTabs.getTabs()) {
            tab.content = tab.originalContent;
            tab.hasUnsavedChanges = false;
          }
          const active = window.CustomTabs.getActiveTab();
          const baseline = active ? active.originalContent : "";
          window.originalMarkdown = baseline;
          // The editor is the live copy while the split view is up, so leaving
          // it holding an old edit is the same leak by another route.
          if (window.markdownEditor && window.CustomTabs.__inEditMode()) {
            window.markdownEditor.value = baseline;
          }
          return {
            tabs: window.CustomTabs.getTabs().length,
            editing: window.CustomTabs.__inEditMode(),
            // Asked with the product's own function - the one the shutdown
            // scan runs - so this cannot agree while the scan disagrees.
            dirty: window.CustomTabs.__dirtyTabNames(),
          };
        })()
      `);
    await exec(`
      (() => {
        window.CustomTabs.createTab(${jsQ1}, window.fs.readFileSync(${jsQ1}, 'utf8'));
        const b = window.CustomTabs.createTab(${jsQ2}, window.fs.readFileSync(${jsQ2}, 'utf8'));
        window.CustomTabs.switchToTab(b.id);
        return true;
      })()
    `);
    await sleep(500);

    // -- a clean close is still a CHECKED close, and completes -------------
    __shutdown.reset();
    rig.reset();
    const cleanClose = guardEvent();
    win.emit("close", cleanClose);
    const cleanClosed = await waitUntil(() => rig.closes > 0);
    const requestsSeen = await exec(`window.__quitRequestCount`);
    check(
      "a native close with nothing unsaved is held, checked with the renderer and then completed",
      cleanClose.prevented === true &&
        cleanClosed &&
        requestsSeen === 1 &&
        rig.closes === 1 &&
        rig.dialogs.length === 0,
      JSON.stringify({
        prevented: cleanClose.prevented,
        requestsSeen,
        closes: rig.closes,
        dialogs: rig.dialogs.length,
      }),
    );

    // The approved close re-enters the same listener. It must pass through it,
    // not start the question again.
    const secondClose = guardEvent();
    win.emit("close", secondClose);
    await sleep(150);
    check(
      "the close an approval authorised is not intercepted a second time",
      secondClose.prevented === false && rig.closes === 1,
      JSON.stringify({ prevented: secondClose.prevented, closes: rig.closes }),
    );

    // ============================================================
    // Two-phase commit: an answer is not a commit (F22)
    // ============================================================
    //
    // THE GAP THIS CLOSES. The renderer's answer describes the document at one
    // instant; main then defers the continuation to a later turn of the loop by
    // design, and the reader can type in between. Re-checking the document
    // GENERATION cannot see that - the same document with new text in it is the
    // same generation - so the approval used to be acted on with nothing having
    // looked at the document again. The commit phase re-reads it and refuses an
    // answer the document has moved past.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    const beforeLateEdit = __shutdown.state().lastRequestId;
    // A clean document, so the first question settles silently; the edit lands
    // between the answer and the commit, which is the whole point.
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    const lateEditText = "LATE EDIT MADE AFTER THE ANSWER WAS GIVEN";
    // THE INJECTION HAS TO WIN THE RACE IT IS TESTING, DETERMINISTICALLY.
    //
    // `executeJavaScript` travels a different path from `webContents.send`, so
    // an edit dispatched that way from an ORDINARY listener raced the commit and
    // usually lost - the commit arrived first, the fold found nothing moved, and
    // the test recorded a lost edit as a product failure. Measured: the commit
    // was authorised and the close completed with the edit still sitting in the
    // live copy, unfolded.
    //
    // Two changes make it exact. The listener is PREPENDED, so it runs before
    // main.js's own response handler - which is what sends the commit - and the
    // mutation travels on the SAME webContents.send channel as the commit, so
    // Electron's own ordering guarantee puts it first. The renderer applies it
    // synchronously to `window.originalMarkdown`, which is where a real
    // view-mode edit lives, so what the commit then folds is a genuine edit made
    // between the answer and the commit.
    await exec(`
      (() => {
        const ipc = require("electron").ipcRenderer;
        window.__f22LateEdits = 0;
        ipc.removeAllListeners("__f22-test-live-edit");
        ipc.on("__f22-test-live-edit", (event, text) => {
          window.originalMarkdown = text;
          window.__f22LateEdits += 1;
        });
        return true;
      })()
    `);
    let lateEditInjected = false;
    const injectLateEdit = () => {
      // Fired the instant the renderer's answer reaches main and BEFORE the
      // handler that turns it into a commit, which is exactly the window the
      // old design could not see into.
      if (lateEditInjected) return;
      lateEditInjected = true;
      try {
        win.webContents.send("__f22-test-live-edit", lateEditText);
      } catch (error) {
        // Reported by the assertion below through lateEditApplied.
      }
    };
    ipcMain.prependListener("quit-approval-response", injectLateEdit);
    let lateClose;
    try {
      lateClose = guardEvent();
      win.emit("close", lateClose);
      // The commit is refused, so the intent is raised again as a FRESH
      // question - and this time the document is dirty, so it raises a dialog.
      await waitUntil(() => rig.dialogs.length === 1, 10000);
      await sleep(250);
    } finally {
      ipcMain.removeListener("quit-approval-response", injectLateEdit);
    }
    // THE SETUP CONTROL. "The edit never arrived" and "the edit arrived and was
    // ignored" are the same failure to an assertion that only reads the end
    // state, and the first of those is a broken test rather than a broken
    // product. Counted in the renderer, by the renderer.
    const lateEditApplied = await exec(`window.__f22LateEdits`);
    check(
      "the late edit really reached the renderer between the answer and the commit",
      lateEditInjected === true && lateEditApplied === 1,
      JSON.stringify({ lateEditInjected, lateEditApplied }),
    );
    const lateState = __shutdown.state();
    const preservedLateEdit = await exec(
      `window.CustomTabs.getActiveTab().content`,
    );
    check(
      "an edit made between the answer and the commit is caught, and the close asks again",
      lateEditInjected &&
        lateClose.prevented === true &&
        lateState.commitRefusedCount >= 1 &&
        // A refused commit raises the intent again rather than acting on it, so
        // more than one request id was consumed for this one gesture.
        lateState.lastRequestId > beforeLateEdit + 1 &&
        rig.dialogs.length === 1 &&
        // Cancel: nothing closed, nothing authorised, and the edit is intact.
        rig.closes === 0 &&
        lateState.authorized === false &&
        preservedLateEdit === lateEditText,
      JSON.stringify({
        lateEditInjected,
        prevented: lateClose.prevented,
        beforeLateEdit,
        state: lateState,
        dialogs: rig.dialogs.length,
        closes: rig.closes,
        preservedLateEdit,
      }),
    );
    const freezeAfterRefusal = await exec(
      `window.CustomTabs.__shutdownFreeze()`,
    );
    check(
      "a refused commit leaves the document editable rather than frozen",
      freezeAfterRefusal &&
        freezeAfterRefusal.frozen === false &&
        freezeAfterRefusal.editorReadOnly === false,
      JSON.stringify(freezeAfterRefusal),
    );

    // The ordinary path: nothing moves, the commit confirms, and the document
    // is frozen for the instant between the confirmation and the close.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        return true;
      })()
    `);
    const committedClose = guardEvent();
    win.emit("close", committedClose);
    const committedClosed = await waitUntil(() => rig.closes === 1, 10000);
    const committedState = __shutdown.state();
    const freezeAfterCommit = await exec(
      `window.CustomTabs.__shutdownFreeze()`,
    );
    check(
      "an unmoved document commits once and freezes while the close goes through",
      committedClosed &&
        committedClose.prevented === true &&
        committedState.commitRefusedCount === 0 &&
        rig.dialogs.length === 0 &&
        freezeAfterCommit &&
        freezeAfterCommit.frozen === true &&
        freezeAfterCommit.editorReadOnly === true,
      JSON.stringify({
        committedClosed,
        prevented: committedClose.prevented,
        state: committedState,
        dialogs: rig.dialogs.length,
        freeze: freezeAfterCommit,
      }),
    );
    // THE TEXTAREA IS NOT THE ONLY WAY IN. View-mode edits arrive through
    // clicks - a checkbox, a table cell, a note - so a freeze that only made
    // the editor read-only left every one of those live while the app was on
    // its way out. `inert` removes the whole document subtree from hit-testing,
    // focus and the tab order, and a late live-copy mutation can no longer be
    // adopted into the cache either.
    const lateViewMutation = await exec(`
      (() => {
        const before = window.CustomTabs.getActiveTab().content;
        window.originalMarkdown = "MUTATION ATTEMPTED AFTER THE COMMIT";
        const ipc = require("electron").ipcRenderer;
        const handler = ipc.listeners("quit-approval-request")[0];
        // Drive the real fold, which is what a late shutdown scan would do.
        window.CustomTabs.getTabs();
        const freeze = window.CustomTabs.__shutdownFreeze();
        return {
          wrapperInert: freeze.wrapperInert,
          contentBefore: before,
          contentAfter: window.CustomTabs.getActiveTab().content,
        };
      })()
    `);
    check(
      "a committed freeze makes the whole document surface inert, not just the editor",
      freezeAfterCommit &&
        freezeAfterCommit.wrapperInert === true &&
        lateViewMutation &&
        // The live copy moved, and the cache did NOT follow it: the consent was
        // taken against the earlier revision and nothing may be adopted past it.
        lateViewMutation.contentAfter === lateViewMutation.contentBefore,
      JSON.stringify({ freeze: freezeAfterCommit, lateViewMutation }),
    );
    // Exercise the public and IPC mutation entrances while the real committed
    // freeze is still held.  This deliberately uses the product accessors and
    // listeners rather than assigning private harness state: each refusal has
    // to arrive at CustomTabs' common boundary and leave the committed revision
    // and every durable document identity untouched.
    const frozenMutationMatrix = await exec(`
      (() => {
        const ipc = require("electron").ipcRenderer;
        const active = window.CustomTabs.getActiveTab();
        const other = window.CustomTabs.getTabs().find(tab => tab.id !== active.id);
        const before = {
          tabs: window.CustomTabs.getTabs().map(tab => ({
            id: tab.id, path: tab.filePath, content: tab.content,
            original: tab.originalContent, dirty: tab.hasUnsavedChanges,
          })),
          activeId: window.CustomTabs.getActiveTabId(),
          path: window.currentFilePath,
          original: window.originalMarkdown,
          freeze: window.CustomTabs.__shutdownFreeze(),
        };
        active.content = "FROZEN_CONTENT_SETTER";
        active.originalContent = "FROZEN_ORIGINAL_SETTER";
        window.CustomTabs.updateTabContent("FROZEN_UPDATE_CONTENT", true);
        window.CustomTabs.createTab("C:\\\\frozen-create.md", "FROZEN_CREATE");
        if (other) window.CustomTabs.switchToTab(other.id);
        window.CustomTabs.closeTab(active.id);
        window.originalMarkdown = "FROZEN_RENDERER_ORIGINAL";
        window.currentFilePath = "C:\\\\frozen-path.md";
        window.setUnsavedState(true);
        for (const key of ["z", "y", "s", "r"]) {
          document.dispatchEvent(new KeyboardEvent("keydown", {
            key, ctrlKey: true, bubbles: true, cancelable: true,
          }));
        }
        // These are the real IPC listener entrances.  A refusal occurs before
        // their payload can become authority, including a nominally-successful
        // reload and save completion.
        ipc.emit("file-reload-result", {}, {
          success: true, path: before.path, content: "FROZEN_RELOAD",
          reloadRequest: { sequence: 1, path: before.path, snapshot: before.original,
            session: "frozen-test-session" },
        });
        ipc.emit("save-markdown-result", {}, { success: true, filePath: before.path });
        ipc.emit("file-opened", {}, { filePath: "C:\\\\frozen-open.md", content: "FROZEN_OPEN" });
        const after = {
          tabs: window.CustomTabs.getTabs().map(tab => ({
            id: tab.id, path: tab.filePath, content: tab.content,
            original: tab.originalContent, dirty: tab.hasUnsavedChanges,
          })),
          activeId: window.CustomTabs.getActiveTabId(),
          path: window.currentFilePath,
          original: window.originalMarkdown,
          freeze: window.CustomTabs.__shutdownFreeze(),
        };
        return { before, after };
      })()
    `);
    const frozenSources = frozenMutationMatrix &&
      frozenMutationMatrix.after.freeze.mutationAttemptsBySource;
    check(
      "the retained freeze refuses public setters, tab operations, keyboard commands, and IPC completion paths without advancing the document",
      frozenMutationMatrix &&
        JSON.stringify(frozenMutationMatrix.after.tabs) === JSON.stringify(frozenMutationMatrix.before.tabs) &&
        frozenMutationMatrix.after.activeId === frozenMutationMatrix.before.activeId &&
        frozenMutationMatrix.after.path === frozenMutationMatrix.before.path &&
        frozenMutationMatrix.after.original === frozenMutationMatrix.before.original &&
        frozenMutationMatrix.after.freeze.revision === frozenMutationMatrix.before.freeze.revision &&
        frozenMutationMatrix.after.freeze.mutationAttemptCount >
          frozenMutationMatrix.before.freeze.mutationAttemptCount &&
        frozenSources["tab:content-setter"] > 0 &&
        frozenSources["tab:original-content-setter"] > 0 &&
        frozenSources["tab:update-content"] > 0 &&
        frozenSources["tab:create"] > 0 &&
        frozenSources["ipc:reload-result"] > 0 &&
        frozenSources["ipc:save-result"] > 0,
      JSON.stringify(frozenMutationMatrix),
    );
    // Restore is a real startup path, not a synthetic tab-create call. A
    // retained freeze must decline its first create, stop the batch, and leave
    // both the open document and the persisted session exactly as they were.
    const frozenRestore = await exec(`
      (() => {
        const savedTabsBefore = JSON.stringify([
          { filePath: ${jsQ1}, scrollPosition: 11, anchor: "alpha-anchor" },
          { filePath: ${jsQ2}, scrollPosition: 22, anchor: "beta-anchor" },
        ]);
        localStorage.setItem("openTabs", savedTabsBefore);
        localStorage.setItem("activeTabPath", ${jsQ2});
        const before = {
          tabs: window.CustomTabs.getTabs().map(tab => ({
            id: tab.id,
            path: tab.filePath,
            content: tab.content,
            original: tab.originalContent,
          })),
          activeId: window.CustomTabs.getActiveTabId(),
          openTabs: localStorage.getItem("openTabs"),
          activePath: localStorage.getItem("activeTabPath"),
          freeze: window.CustomTabs.__shutdownFreeze(),
        };
        window.CustomTabs.__loadSavedTabs();
        const after = {
          tabs: window.CustomTabs.getTabs().map(tab => ({
            id: tab.id,
            path: tab.filePath,
            content: tab.content,
            original: tab.originalContent,
          })),
          activeId: window.CustomTabs.getActiveTabId(),
          openTabs: localStorage.getItem("openTabs"),
          activePath: localStorage.getItem("activeTabPath"),
          freeze: window.CustomTabs.__shutdownFreeze(),
        };
        return { before, after };
      })()
    `);
    const frozenRestorePreserved =
      frozenRestore &&
      JSON.stringify(frozenRestore.after.tabs) ===
        JSON.stringify(frozenRestore.before.tabs) &&
      frozenRestore.after.activeId === frozenRestore.before.activeId &&
      frozenRestore.after.openTabs === frozenRestore.before.openTabs &&
      frozenRestore.after.activePath === frozenRestore.before.activePath &&
      frozenRestore.after.freeze.frozen === true &&
      frozenRestore.after.freeze.mutationAttemptCount ===
        frozenRestore.before.freeze.mutationAttemptCount + 1 &&
      frozenRestore.after.freeze.mutationAttemptsBySource["tab:create"] ===
        (frozenRestore.before.freeze.mutationAttemptsBySource["tab:create"] || 0) +
          1 &&
      (frozenRestore.after.freeze.mutationAttemptsBySource["tab:switch"] || 0) ===
        (frozenRestore.before.freeze.mutationAttemptsBySource["tab:switch"] || 0);

    // A Windows installer hand-off asks a later renderer question with this
    // flag while its first, revision-bound commit remains authoritative. Drive
    // that real CustomTabs IPC listener with a current generation and observe
    // its reply through the real main-process channel; a retained request must
    // not thaw the document merely because it is newer.
    const retainedRequestId = 900000;
    const retainedGeneration = await exec(
      `window.ipcRenderer.invoke('quit-approval-generation')`,
    );
    let retainedReply = null;
    const observeRetainedReply = (_event, data) => {
      if (data && data.id === retainedRequestId) retainedReply = data;
    };
    ipcMain.on("quit-approval-response", observeRetainedReply);
    try {
      wc.send("quit-approval-request", {
        id: retainedRequestId,
        reason: "update-install",
        gen: retainedGeneration,
        retainFreeze: true,
      });
      await waitUntil(() => retainedReply !== null, 5000);
    } finally {
      ipcMain.removeListener("quit-approval-response", observeRetainedReply);
    }
    const retainedFreeze = await exec(`window.CustomTabs.__shutdownFreeze()`);
    check(
      "a retained launch request leaves the committed document frozen",
      retainedReply &&
        retainedReply.gen === retainedGeneration &&
        frozenRestorePreserved &&
        retainedFreeze &&
        retainedFreeze.frozen === true &&
        retainedFreeze.editorReadOnly === true &&
        retainedFreeze.wrapperInert === true,
      JSON.stringify({
        retainedGeneration,
        retainedReply,
        frozenRestore,
        retainedFreeze,
      }),
    );

    // NO PERMANENTLY FROZEN UI. The preceding direct live-copy mutation was
    // correctly refused while frozen, so it cannot also manufacture the dirty
    // question this case needs. First exercise the retry-safe main-process
    // thaw, wait for its real IPC delivery, then make a normal live edit and
    // decline the ensuing close.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    const resetThawed = await waitForCondition(
      exec,
      `!window.CustomTabs.isDocumentFrozen()`,
      5000,
    );
    // The direct retained probe deliberately uses a high request id so the
    // listener cannot replay a cached ordinary request. A fresh page restores
    // its per-page sequence before the next native close.
    // Do not run restoreTabs() while a shutdown fixture is being discarded:
    // its persisted entries belong to the prior document and would make this
    // sequence test depend on startup restoration. Recreate the two real
    // fixture files immediately after the new renderer is ready instead.
    await exec(`localStorage.clear(); null;`);
    wc.reload();
    const thawedPageReady = await waitUntil(
      () => __shutdown.state().renderer === "ready",
      20000,
    );
    await exec(`
      (() => {
        const a = window.CustomTabs.createTab(
          ${jsQ1},
          window.fs.readFileSync(${jsQ1}, "utf8"),
        );
        const b = window.CustomTabs.createTab(
          ${jsQ2},
          window.fs.readFileSync(${jsQ2}, "utf8"),
        );
        window.CustomTabs.switchToTab(b.id);
        return { a: a.id, b: b.id };
      })()
    `);
    const thawEdit = await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        window.originalMarkdown = tab.content + "\\nEDIT_AFTER_RETRY_SAFE_THAW\\n";
        return {
          dirty: window.CustomTabs.__dirtyTabNames(),
          editorReadOnly: window.markdownEditor && window.markdownEditor.readOnly,
        };
      })()
    `);
    const thawClose = guardEvent();
    win.emit("close", thawClose);
    const thawAsked = await waitUntil(() => rig.dialogs.length === 1, 10000);
    await sleep(200);
    const freezeAfterNewQuestion = await exec(
      `window.CustomTabs.__shutdownFreeze()`,
    );
    check(
      "a retry-safe thaw releases a committed freeze before a later dirty question",
      resetThawed &&
        thawedPageReady &&
        thawAsked &&
        thawEdit &&
        thawEdit.dirty.length > 0 &&
        thawEdit.editorReadOnly === false &&
        freezeAfterNewQuestion &&
        freezeAfterNewQuestion.editorReadOnly === false,
      JSON.stringify({
        resetThawed,
        thawedPageReady,
        thawAsked,
        thawEdit,
        freezeAfterNewQuestion,
      }),
    );
    check(
      "a retry-safe thaw restores the document surface as well as the editor",
      resetThawed &&
        thawedPageReady &&
        thawAsked &&
        freezeAfterNewQuestion &&
        freezeAfterNewQuestion.frozen === false &&
        freezeAfterNewQuestion.wrapperInert === false,
      JSON.stringify({
        resetThawed,
        thawedPageReady,
        thawAsked,
        freezeAfterNewQuestion,
      }),
    );

    // THE REAL CASCADE. On Windows the approved X does not end there: the
    // registered window-all-closed listener calls app.quit(), which raises
    // before-quit. Do not substitute a direct before-quit emit here: that
    // would leave the application listener itself unexercised. The rig drives
    // before-quit from its non-terminal app.quit stub and restores the exact
    // original descriptor in this function's finally block.
    //
    // IT NEEDS AN APPROVED CLOSE OF ITS OWN, AND A CLEAN DOCUMENT SET TO GET
    // ONE. What this measures is that the permission an approved close leaves
    // behind carries through the cascade without asking again - so there has to
    // BE such a permission. The freeze scenarios above end on a deliberately
    // dirty document that is deliberately declined, which revokes it; before
    // that block existed the cascade inherited the previous scenario's
    // approval, and when it was added the cascade quietly started measuring a
    // declined close instead. Measured: one dialog, `settleWhy:"user"`, and a
    // second question exactly as the assertion says must not happen.
    //
    // The restore writes the product's own stores - the tab caches, the live
    // copy, the editor if the split view is up - and then asks the PRODUCT
    // whether anything is unsaved. Nothing private is reset, so a real defect
    // that leaves a document dirty still shows up here as a failure.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    const beforeCascadeClean = await restoreCleanDocuments();
    check(
      "the freeze scenarios leave no edit behind in any document store",
      !!beforeCascadeClean &&
        beforeCascadeClean.tabs > 0 &&
        Array.isArray(beforeCascadeClean.dirty) &&
        beforeCascadeClean.dirty.length === 0,
      JSON.stringify(beforeCascadeClean),
    );
    const cascadeClose = guardEvent();
    win.emit("close", cascadeClose);
    const cascadeApproved = await waitUntil(() => rig.closes === 1, 10000);
    await sleep(200);
    check(
      "a clean close ahead of the cascade completes silently and leaves its permission standing",
      cascadeApproved &&
        cascadeClose.prevented === true &&
        rig.dialogs.length === 0 &&
        __shutdown.state().authorized === true,
      JSON.stringify({
        cascadeApproved,
        prevented: cascadeClose.prevented,
        dialogs: rig.dialogs.length,
        state: __shutdown.state(),
      }),
    );
    const beforeCascade = __shutdown.state().lastRequestId;
    rig.reset();
    rig.driveQuitLifecycle = true;
    app.emit("window-all-closed");
    await sleep(250);
    check(
      "an approved native close crosses the real window-all-closed cascade without a second question",
      rig.quits === 1 &&
        rig.quitEvents.length === 1 &&
        rig.quitEvents[0].prevented === false &&
        rig.dialogs.length === 0 &&
        __shutdown.state().lastRequestId === beforeCascade &&
        __shutdown.state().pendingId === 0,
      JSON.stringify({
        quits: rig.quits,
        beforeQuitPrevented: rig.quitEvents[0] && rig.quitEvents[0].prevented,
        dialogs: rig.dialogs.length,
        state: __shutdown.state(),
        beforeCascade,
      }),
    );

    // -- an edit that exists only in the renderer --------------------------
    // The reader's newest work lives in window.originalMarkdown (view-mode
    // table/checkbox/note edits) until snapshotActiveTab() folds it into the
    // tab. A scan that skipped the snapshot would call this document clean.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    // THE LIVE-ONLY EDIT IS CONSTRUCTED AT ITS OWN BOUNDARY. What this measures
    // is that a document whose ONLY unsaved text sits in the renderer's live
    // copy is still found by the scan, and that claim needs the cache to be
    // provably clean first - inherited dirt from an earlier scenario would make
    // "the cache is clean" false and the assertion would report a defect that
    // belongs several scenarios upstream.
    const liveBase = await restoreCleanDocuments();
    const live = await exec(`
      (() => {
        const t = window.CustomTabs.getActiveTab();
        window.originalMarkdown = t.content + '\\n\\nLIVE_EDIT\\n';
        return { name: t.filename, cachedClean: t.content === t.originalContent };
      })()
    `);
    const liveTabIds = await exec(
      `window.CustomTabs.getTabs().map(t => t.id).join(',')`,
    );
    check(
      "the reader's newest edit really is live-only, absent from the tab's own cache",
      live.cachedClean === true &&
        Array.isArray(liveBase.dirty) &&
        liveBase.dirty.length === 0,
      JSON.stringify({ live, liveBase }),
    );
    const dirtyClose = guardEvent();
    win.emit("close", dirtyClose);
    await waitUntil(() => rig.dialogs.length > 0);
    await sleep(200);
    const askedOptions = rig.dialogs.length ? rig.dialogs[0].options : {};
    check(
      "an unsaved edit that exists only in the renderer stops the native close",
      dirtyClose.prevented === true &&
        rig.dialogs.length === 1 &&
        rig.closes === 0 &&
        String(askedOptions.message).includes(live.name),
      JSON.stringify({
        prevented: dirtyClose.prevented,
        dialogs: rig.dialogs.length,
        closes: rig.closes,
        message: askedOptions.message,
      }),
    );
    // ESC and Enter must both keep the app alive. Nothing else in the suite
    // can see this: the rig answers by index, so a cancelId pointing at the
    // discard button would be invisible to every other assertion.
    check(
      "the discard dialog defaults to Cancel and cancels on ESC",
      askedOptions.defaultId === 1 &&
        askedOptions.cancelId === 1 &&
        Array.isArray(askedOptions.buttons) &&
        askedOptions.buttons[1] === "Cancel",
      JSON.stringify({
        defaultId: askedOptions.defaultId,
        cancelId: askedOptions.cancelId,
        buttons: askedOptions.buttons,
      }),
    );
    check(
      "cancelling a close leaves the app running with no shutdown outstanding",
      __shutdown.state().authorized === false &&
        __shutdown.state().pendingId === 0 &&
        rig.closes === 0 &&
        rig.quits === 0,
      JSON.stringify(__shutdown.state()),
    );
    // The protocol REPORTS on the documents; it must never act on them. A
    // check that closed tabs one by one to find the dirty ones would leave the
    // reader with a cancelled quit and their documents gone anyway.
    const tabsAfterCancel = await exec(
      `window.CustomTabs.getTabs().map(t => t.id).join(',')`,
    );
    check(
      "asking the question closes no tabs and changes no document",
      tabsAfterCancel === liveTabIds,
      JSON.stringify({ before: liveTabIds, after: tabsAfterCancel }),
    );

    // -- a dirty BACKGROUND tab --------------------------------------------
    // The active tab is clean again and the background tab's own
    // hasUnsavedChanges flag says false - so only a content-against-original
    // comparison across EVERY tab can find this.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    const bg = await exec(`
      (() => {
        const active = window.CustomTabs.getActiveTab();
        active.content = active.originalContent;
        window.originalMarkdown = active.originalContent;
        const other = window.CustomTabs.getTabs().find(t => t.id !== active.id);
        other.content = other.originalContent + '\\nBACKGROUND_EDIT\\n';
        other.hasUnsavedChanges = false;
        return { active: active.filename, background: other.filename };
      })()
    `);
    const bgClose = guardEvent();
    win.emit("close", bgClose);
    await waitUntil(() => rig.dialogs.length > 0);
    await sleep(200);
    check(
      "an unsaved BACKGROUND tab is found once the active tab has been snapshotted",
      rig.dialogs.length === 1 &&
        rig.closes === 0 &&
        String(rig.dialogs[0].options.message).includes(bg.background),
      JSON.stringify({
        dialogs: rig.dialogs.length,
        closes: rig.closes,
        message: rig.dialogs.length ? rig.dialogs[0].options.message : null,
        expected: bg.background,
      }),
    );

    // -- the renderer cannot work the answer out -----------------------------
    // Driven through the REAL failure, not a fabricated reply: edit mode with
    // no editor to read is a state the overlay refuses to answer for, because
    // the reader's keystrokes would be in a textarea it cannot see. It must
    // report that rather than fall back to "clean" - and it must ANSWER, since
    // silence would strand a request that has no timeout behind it.
    //
    // Muted because the overlay's console.error IS the expected behaviour
    // here; the sentinel would otherwise report the suite's own deliberate
    // failure as a defect.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    let blindClose;
    let blindAsked;
    let blindMode = null;
    await sentinel.mute("the overlay is deliberately left unable to answer");
    try {
      // EDIT MODE IS A DOM FACT, NOT A FLAG. This used to set
      // `window.isEditMode`, which was a shadow copy updated by a timer; the
      // overlay now reads `.content-wrapper.split-view`, which is what
      // renderer.js actually toggles and what a real exit from edit mode
      // actually clears. Setting the old flag left inEditMode() false, so the
      // deliberate "there is no editor" state was never entered and the
      // renderer answered normally - the assertion below then measured the
      // ordinary dialog and reported a product failure.
      blindMode = await exec(`
        (() => {
          window.__savedEditor = window.markdownEditor;
          window.markdownEditor = null;
          const wrapper = document.querySelector(".content-wrapper");
          window.__blindAddedSplit = !!wrapper && !wrapper.classList.contains("split-view");
          if (wrapper) wrapper.classList.add("split-view");
          return {
            inEditMode: window.CustomTabs.__inEditMode(),
            editorPresent: !!window.markdownEditor,
          };
        })()
      `);
      blindClose = guardEvent();
      win.emit("close", blindClose);
      blindAsked = await waitUntil(() => rig.dialogs.length > 0);
      await sleep(200);
    } finally {
      await exec(`
        (() => {
          window.markdownEditor = window.__savedEditor;
          const wrapper = document.querySelector(".content-wrapper");
          if (wrapper && window.__blindAddedSplit) wrapper.classList.remove("split-view");
          delete window.__blindAddedSplit;
          return true;
        })()
      `);
      await sentinel.unmute();
    }
    check(
      "the unreadable-editor case really left the overlay in edit mode with no editor",
      !!blindMode &&
        blindMode.inEditMode === true &&
        blindMode.editorPresent === false,
      JSON.stringify(blindMode),
    );
    check(
      "a renderer that cannot work out the answer says so, and the main process asks",
      blindAsked &&
        blindClose.prevented === true &&
        rig.closes === 0 &&
        __shutdown.state().pendingId === 0 &&
        // The RENDERER'S OWN report is what has to raise this question. The
        // app has a second, independent net - a renderer that stops responding
        // is escalated by Chromium's hang detection - and it rescues a
        // stranded request too, several seconds later. Measured: with the
        // renderer's answer removed the dialog still appeared, settled as
        // "fallback-unresponsive". Naming the route is what separates the two.
        __shutdown.state().settleWhy === "fallback-unreadable" &&
        /cannot be checked/i.test(
          rig.dialogs.length ? String(rig.dialogs[0].options.title) : "",
        ),
      JSON.stringify({
        blindAsked,
        prevented: blindClose && blindClose.prevented,
        closes: rig.closes,
        title: rig.dialogs.length ? rig.dialogs[0].options.title : null,
        state: __shutdown.state(),
      }),
    );

    // -- a renderer that has stopped answering altogether -------------------
    // The last net, and the only escape for a renderer that is ALIVE and
    // listening but wedged - a long synchronous render, which this app
    // documents as taking seconds on a large document. Driven with a real
    // busy loop rather than a stranded request, so what is measured is
    // Chromium's hang detection reaching this protocol.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    exec(`
      const until = Date.now() + 7000;
      while (Date.now() < until) {}
      null;
    `).catch(() => {});
    await sleep(300);
    const hungClose = guardEvent();
    win.emit("close", hungClose);
    // Input is what arms the hang monitor.
    for (let i = 0; i < 8; i += 1) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: 10 + i, y: 10 });
      await sleep(150);
    }
    const hungAsked = await waitUntil(() => rig.dialogs.length > 0, 20000);
    await sleep(200);
    check(
      "a renderer that has stopped answering is escalated to the main process, not waited on forever",
      hungAsked &&
        hungClose.prevented === true &&
        rig.closes === 0 &&
        __shutdown.state().settleWhy === "fallback-unresponsive" &&
        /cannot be checked/i.test(
          rig.dialogs.length ? String(rig.dialogs[0].options.title) : "",
        ),
      JSON.stringify({
        hungAsked,
        prevented: hungClose.prevented,
        closes: rig.closes,
        state: __shutdown.state(),
        title: rig.dialogs.length ? rig.dialogs[0].options.title : null,
      }),
    );
    // And the renderer that comes back is still the one that answers.
    await waitForCondition(exec, `true`, 20000);
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    const recoveredClose = guardEvent();
    win.emit("close", recoveredClose);
    const recoveredAsked = await waitUntil(() => rig.dialogs.length > 0, 12000);
    await sleep(200);
    check(
      "a renderer that recovers answers the next question itself",
      recoveredAsked && __shutdown.state().settleWhy === "user",
      JSON.stringify({ recoveredAsked, state: __shutdown.state() }),
    );

    // -- more than one dirty document --------------------------------------
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    await exec(`
      (() => {
        const active = window.CustomTabs.getActiveTab();
        window.originalMarkdown = active.originalContent + '\\nBOTH_EDIT\\n';
        return true;
      })()
    `);
    const bothClose = guardEvent();
    win.emit("close", bothClose);
    await waitUntil(() => rig.dialogs.length > 0);
    await sleep(200);
    const bothOptions = rig.dialogs.length ? rig.dialogs[0].options : {};
    check(
      "two unsaved documents are counted in the message and both named in the detail",
      String(bothOptions.message) === "2 open documents have unsaved changes." &&
        String(bothOptions.detail).includes(bg.active) &&
        String(bothOptions.detail).includes(bg.background),
      JSON.stringify({ message: bothOptions.message, detail: bothOptions.detail }),
    );

    // -- a cancelled close does not poison the next one --------------------
    const beforeRetry = __shutdown.state().lastRequestId;
    rig.answer = 0;
    const retryClose = guardEvent();
    win.emit("close", retryClose);
    await waitUntil(() => rig.closes > 0);
    check(
      "a cancelled close is followed by a fresh question that can be approved",
      __shutdown.state().lastRequestId === beforeRetry + 1 &&
        rig.dialogs.length === 2 &&
        rig.closes === 1,
      JSON.stringify({
        lastRequestId: __shutdown.state().lastRequestId,
        beforeRetry,
        dialogs: rig.dialogs.length,
        closes: rig.closes,
      }),
    );

    // -- two gestures, one question ----------------------------------------
    __shutdown.reset();
    rig.reset();
    rig.answer = 0;
    const firstOfTwo = guardEvent();
    const secondOfTwo = guardEvent();
    win.emit("close", firstOfTwo);
    win.emit("close", secondOfTwo);
    await waitUntil(() => rig.closes > 0);
    await sleep(250);
    check(
      "two close gestures while one is pending ask once and close once",
      firstOfTwo.prevented === true &&
        secondOfTwo.prevented === true &&
        rig.dialogs.length === 1 &&
        rig.closes === 1,
      JSON.stringify({
        first: firstOfTwo.prevented,
        second: secondOfTwo.prevented,
        dialogs: rig.dialogs.length,
        closes: rig.closes,
      }),
    );

    // -- Ctrl+Q shares the guard -------------------------------------------
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    win.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "q",
      modifiers: ["control"],
    });
    const ctrlQAsked = await waitUntil(() => rig.dialogs.length > 0);
    await sleep(200);
    check(
      "Ctrl+Q asks through the shared guard instead of quitting outright",
      ctrlQAsked &&
        rig.dialogs.length === 1 &&
        rig.dialogs[0].pendingReason === "ctrl-q" &&
        rig.quits === 0,
      JSON.stringify({
        dialogs: rig.dialogs.length,
        reason: rig.dialogs.length ? rig.dialogs[0].pendingReason : null,
        quits: rig.quits,
      }),
    );
    rig.answer = 0;
    win.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "q",
      modifiers: ["control"],
    });
    await waitUntil(() => rig.quits > 0);
    await sleep(150);
    check(
      "an approved Ctrl+Q quits exactly once",
      rig.quits === 1,
      JSON.stringify({ quits: rig.quits, dialogs: rig.dialogs.length }),
    );

    // -- an ordinary application quit, renderer alive ----------------------
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    const appQuit = guardEvent();
    app.emit("before-quit", appQuit);
    const quitAsked = await waitUntil(() => rig.dialogs.length > 0);
    await sleep(200);
    check(
      "an application quit is held by the same guard while documents are unsaved",
      quitAsked &&
        appQuit.prevented === true &&
        rig.dialogs[0].pendingReason === "app-quit" &&
        rig.quits === 0,
      JSON.stringify({
        prevented: appQuit.prevented,
        reason: rig.dialogs.length ? rig.dialogs[0].pendingReason : null,
        quits: rig.quits,
      }),
    );

    // -- an update install is a shutdown, and waits its turn ---------------
    __shutdown.reset();
    rig.reset();
    installs = 0;
    // Nothing has been downloaded yet, so the press cannot install anything
    // and must not put a discard-your-changes question on screen for it.
    const beforePreflight = __shutdown.state().lastRequestId;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await sleep(500);
    check(
      "an install press with nothing downloaded asks nothing and starts nothing",
      installs === 0 &&
        rig.dialogs.length === 0 &&
        __shutdown.state().lastRequestId === beforePreflight,
      JSON.stringify({
        installs,
        dialogs: rig.dialogs.length,
        lastRequestId: __shutdown.state().lastRequestId,
        beforePreflight,
      }),
    );

    // Arm a downloaded update through the real updater event, which is the
    // only thing that makes the Install button reachable in the product.
    updaterModule.autoUpdater.emit("update-downloaded", {
      version: "9.9.9",
      downloadedFile: fileQ1,
    });
    await sleep(200);

    let releaseDialog = null;
    rig.answer = () =>
      new Promise((resolve) => {
        releaseDialog = resolve;
      });
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    const installAsked = await waitUntil(() => rig.dialogs.length > 0);
    await sleep(200);
    check(
      "an update install is deferred behind the same approval, installing nothing first",
      installAsked &&
        installs === 0 &&
        rig.dialogs[0].pendingReason === "update-install" &&
        rig.quits === 0,
      JSON.stringify({
        installs,
        reason: rig.dialogs.length ? rig.dialogs[0].pendingReason : null,
        quits: rig.quits,
      }),
    );
    if (releaseDialog) releaseDialog(1);
    await sleep(300);
    check(
      "cancelling an update install installs nothing and leaves the app usable",
      installs === 0 &&
        __shutdown.state().authorized === false &&
        __shutdown.state().pendingId === 0,
      JSON.stringify({ installs, state: __shutdown.state() }),
    );

    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await waitUntil(() => installs > 0);
    const beforeRepeatedInstall = {
      dialogs: rig.dialogs.length,
      lastRequestId: __shutdown.state().lastRequestId,
    };
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await sleep(400);
    check(
      "an approved update installs exactly once, however often it is asked for",
      installs === 1,
      JSON.stringify({ installs, dialogs: rig.dialogs.length }),
    );
    check(
      "a repeated install press is refused before it opens a second approval question",
      rig.dialogs.length === beforeRepeatedInstall.dialogs &&
        __shutdown.state().lastRequestId === beforeRepeatedInstall.lastRequestId,
      JSON.stringify({
        beforeRepeatedInstall,
        dialogs: rig.dialogs.length,
        lastRequestId: __shutdown.state().lastRequestId,
      }),
    );
    // The press that lands AFTER the installer has been handed off must report
    // that it started nothing. Reporting success for a call the updater
    // library ignores is how an app that is still running ends up authorised
    // to close without asking - the F22 defect, re-entered through the Install
    // button.
    check(
      "a repeated install press leaves no standing permission to close in silence",
      installs === 1 && __shutdown.state().authorized === false,
      JSON.stringify({ installs, state: __shutdown.state() }),
    );

    // -- installed updater: public commit, delayed quit, silent refusal -----
    // quitAndInstall() returns without quitting: Electron emits its PUBLIC
    // before-quit-for-update event and the updater defers app.quit() to a
    // setImmediate. A bypass cleared at the void return would ask again
    // mid-install; one left after a silent refusal would lose later edits.
    __shutdown.reset();
    rig.reset();
    installs = 0;
    publicUpdateCommitSignals = 0;
    setUpdaterLatch(false);
    installDefersQuit = true;
    rig.driveQuitLifecycle = true;
    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await waitUntil(() => rig.quits > 0);
    await sleep(300);
    installDefersQuit = false;
    check(
      "an installed updater commit always raises one distinct fresh approval before quitting",
      installs === 1 &&
        rig.quits === 1 &&
        rig.dialogs.length === 2 &&
        publicUpdateCommitSignals === 1 &&
        rig.quitEvents.length === 1 &&
        rig.quitEvents[0].prevented === false,
      JSON.stringify({
        installs,
        quits: rig.quits,
        dialogs: rig.dialogs.length,
        publicUpdateCommitSignals,
        beforeQuitPrevented: rig.quitEvents[0] && rig.quitEvents[0].prevented,
      }),
    );

    // A real BaseUpdater has already set this latch when a previous attempt
    // owns (or has refused) the operation. It returns from quitAndInstall()
    // without a public commit event. The app stays open, so its speculative
    // authorization MUST be gone and a later dirty close MUST ask again.
    __shutdown.reset();
    rig.reset();
    installs = 0;
    setUpdaterLatch(true);
    // Approve this clean/previously-dirty update question so execution reaches
    // the updater's protected latch; Cancel would only test the dialog.
    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await sleep(350);
    const refusedState = __shutdown.state();
    rig.reset();
    await exec(`
      (() => {
        const tab = window.CustomTabs.getActiveTab();
        tab.content = tab.originalContent + '\\nSILENT_UPDATER_REFUSAL_EDIT\\n';
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.content;
        return true;
      })()
    `);
    const dirtyAfterRefusal = guardEvent();
    win.emit("close", dirtyAfterRefusal);
    const refusalAsked = await waitUntil(() => rig.dialogs.length === 1);
    await sleep(150);
    check(
      "an installed updater silent refusal withdraws authorization and the next dirty close asks",
      installs === 0 &&
        rig.quits === 0 &&
        refusedState.authorized === false &&
        refusedState.pendingId === 0 &&
        refusalAsked &&
        dirtyAfterRefusal.prevented === true &&
        rig.dialogs.length === 1,
      JSON.stringify({
        installs,
        quits: rig.quits,
        refusedState,
        refusalAsked,
        prevented: dirtyAfterRefusal.prevented,
        dialogs: rig.dialogs.length,
      }),
    );
    setUpdaterLatch(false);

    // -- a stronger intent arriving while the question is on screen --------
    __shutdown.reset();
    rig.reset();
    installs = 0;
    let releaseHeld = null;
    rig.answer = () =>
      new Promise((resolve) => {
        releaseHeld = resolve;
      });
    const heldClose = guardEvent();
    win.emit("close", heldClose);
    await waitUntil(() => rig.dialogs.length > 0);
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await sleep(400);
    check(
      "an install arriving mid-question is queued rather than swapped into the open question",
      __shutdown.state().queuedReason === "update-install" &&
        rig.dialogs.length === 1 &&
        installs === 0,
      JSON.stringify({ state: __shutdown.state(), dialogs: rig.dialogs.length, installs }),
    );
    if (releaseHeld) releaseHeld(0);
    await waitUntil(() => installs > 0);
    await sleep(200);
    check(
      "a queued update is raised as its own fresh approval rather than coalesced into a close",
      rig.closes === 0 &&
        installs === 0 &&
        rig.dialogs.length === 2 &&
        rig.dialogs[1].pendingReason === "update-install",
      JSON.stringify({ closes: rig.closes, installs, dialogs: rig.dialogs.length }),
    );

    // -- and the same intent when the answer is no -------------------------
    __shutdown.reset();
    rig.reset();
    installs = 0;
    let releaseDeclined = null;
    rig.answer = () =>
      new Promise((resolve) => {
        releaseDeclined = resolve;
      });
    const declinedClose = guardEvent();
    win.emit("close", declinedClose);
    await waitUntil(() => rig.dialogs.length > 0);
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await sleep(400);
    rig.answer = 1;
    if (releaseDeclined) releaseDeclined(1);
    const reRaised = await waitUntil(() => rig.dialogs.length > 1);
    await sleep(300);
    check(
      "declining a close re-raises the queued install as its own question rather than dropping it",
      reRaised &&
        rig.dialogs.length === 2 &&
        rig.dialogs[1].pendingReason === "update-install" &&
        installs === 0 &&
        rig.closes === 0,
      JSON.stringify({
        dialogs: rig.dialogs.map((d) => d.pendingReason),
        installs,
        closes: rig.closes,
      }),
    );

    // -- a continuation that fails takes its authorization with it ---------
    __shutdown.reset();
    rig.reset();
    installs = 0;
    installThrows = true;
    setUpdaterLatch(false);
    rig.answer = 0;
    await exec(`window.ipcRenderer.send('install-update'); null;`);
    await waitUntil(() => installs > 0);
    await sleep(300);
    installThrows = false;
    check(
      "a shutdown that fails to start withdraws the permission it was given",
      installs === 1 && __shutdown.state().authorized === false,
      JSON.stringify({ installs, state: __shutdown.state() }),
    );
    const afterFailure = guardEvent();
    win.emit("close", afterFailure);
    await waitUntil(() => rig.dialogs.length > 1);
    await sleep(200);
    check(
      "the close after a failed shutdown is asked about again rather than waved through",
      afterFailure.prevented === true && rig.dialogs.length === 2,
      JSON.stringify({ prevented: afterFailure.prevented, dialogs: rig.dialogs.length }),
    );

    // ============================================================
    // A NEW INTENT CROSSING AN IN-FLIGHT COMMIT (F22)
    // ============================================================
    //
    // THE GAP THIS CLOSES. The commit phase asks the renderer to confirm an
    // answer against the revision it was given. That round trip is real time,
    // and a second gesture can land inside it. The commit knew nothing about
    // that: it would confirm, and its continuation would run alongside a
    // question the reader had already replaced - a close going through on the
    // strength of an answer the newer intent was about to supersede.
    //
    // The commit now carries the request epoch it STARTED with, a newer intent
    // invalidates it, and the intents behind it are raised again rather than
    // dropped.
    //
    // The gesture is injected from the `quit-approval-response` listener,
    // which fires after main has already sent the commit and before the
    // renderer's reply can arrive: that is the exact window, entered
    // deterministically rather than by sleeping and hoping.
    //
    // EVERY TAB, NOT JUST THE ACTIVE ONE. The whole design of these three cases
    // rests on the close settling SILENTLY - a clean answer settles inside the
    // response handler, which is what puts a commit in flight for the crossing
    // intent to invalidate. One dirty background tab raises a dialog instead,
    // the settle then happens on a later turn, no commit is ever in flight when
    // the intent crosses, and all three cases quietly measure a different
    // protocol. Measured: a leftover live-copy edit from an earlier scenario
    // did exactly that and produced four failures that named the wrong cause.
    // `restoreCleanDocuments` is the one helper for it, shared with the
    // scenarios above so there is a single definition of "nothing unsaved".
    const makeDocumentClean = restoreCleanDocuments;

    // -- a STRONGER intent crossing the commit -----------------------------
    __shutdown.reset();
    rig.reset();
    installs = 0;
    setUpdaterLatch(false);
    rig.answer = 0;
    const crossCleanliness = await makeDocumentClean();
    check(
      "the commit-crossing cases start from a document set with nothing unsaved",
      !!crossCleanliness &&
        crossCleanliness.tabs > 0 &&
        Array.isArray(crossCleanliness.dirty) &&
        crossCleanliness.dirty.length === 0,
      JSON.stringify(crossCleanliness),
    );
    const beforeCross = __shutdown.state().lastRequestId;
    let crossedInstall = 0;
    let crossCommitInFlight = null;
    const installHandler = ipcMain.listeners("install-update")[0];
    const crossWithInstall = () => {
      if (crossedInstall) return;
      crossedInstall = 1;
      // Sampled before the crossing intent, in the same tick main sent the
      // commit on. A zero here means the case never entered the state it
      // claims to test, and the assertions below would be measuring nothing.
      crossCommitInFlight = __shutdown.state().commitPendingId;
      // Synchronous, and through the REAL handler: this is the product's own
      // Install path, not a direct requestShutdown call that would skip its
      // preflight.
      installHandler(portableInstallEvent(win));
    };
    ipcMain.on("quit-approval-response", crossWithInstall);
    let crossClose;
    try {
      crossClose = guardEvent();
      win.emit("close", crossClose);
      await waitUntil(() => installs > 0, 10000);
      await sleep(300);
    } finally {
      ipcMain.removeListener("quit-approval-response", crossWithInstall);
    }
    const crossState = __shutdown.state();
    check(
      "the install really crossed a commit that was in flight at that instant",
      crossedInstall === 1 &&
        crossCommitInFlight !== null &&
        crossCommitInFlight > 0 &&
        rig.dialogs.length === 0,
      JSON.stringify({
        crossedInstall,
        crossCommitInFlight,
        dialogs: rig.dialogs.length,
      }),
    );
    check(
      "an install arriving inside an in-flight close commit invalidates that commit",
      crossedInstall === 1 &&
        crossClose.prevented === true &&
        crossState.commitRefusedCount >= 1 &&
        crossState.commitRefusedWhy === "superseded-by-new-intent" &&
        // The close did NOT go through on the strength of the commit it had
        // already been sent.
        rig.closes === 0,
      JSON.stringify({
        crossedInstall,
        prevented: crossClose.prevented,
        state: crossState,
        closes: rig.closes,
        installs,
      }),
    );
    check(
      "the intent that crossed a commit is approved through its own request rather than the old one",
      installs === 1 &&
        // More than one id was consumed: the invalidated close was re-raised
        // and the install was asked as its own question after it.
        crossState.lastRequestId > beforeCross + 1 &&
        crossState.pendingId === 0,
      JSON.stringify({ installs, beforeCross, state: crossState }),
    );
    check(
      "the late reply to an invalidated commit is counted and does nothing",
      crossState.staleCommitCount >= 1 && crossState.commitPendingId === 0,
      JSON.stringify({ state: crossState, closes: rig.closes }),
    );

    // -- a SAME-RANK intent crossing the commit ----------------------------
    // A second X while the first one's commit is in flight. The commit is
    // invalidated exactly as above, but the re-raised close absorbs the
    // duplicate rather than closing the window twice.
    __shutdown.reset();
    rig.reset();
    installs = 0;
    rig.answer = 0;
    await makeDocumentClean();
    const beforeDoubleClose = __shutdown.state().lastRequestId;
    let secondCloseEvent = null;
    let doubleCommitInFlight = null;
    const crossWithClose = () => {
      if (secondCloseEvent) return;
      doubleCommitInFlight = __shutdown.state().commitPendingId;
      secondCloseEvent = guardEvent();
      win.emit("close", secondCloseEvent);
    };
    ipcMain.on("quit-approval-response", crossWithClose);
    let firstCloseEvent;
    try {
      firstCloseEvent = guardEvent();
      win.emit("close", firstCloseEvent);
      await waitUntil(() => rig.closes > 0, 10000);
      await sleep(300);
    } finally {
      ipcMain.removeListener("quit-approval-response", crossWithClose);
    }
    const doubleCloseState = __shutdown.state();
    check(
      "the second close really crossed a commit that was in flight at that instant",
      doubleCommitInFlight !== null &&
        doubleCommitInFlight > 0 &&
        rig.dialogs.length === 0,
      JSON.stringify({ doubleCommitInFlight, dialogs: rig.dialogs.length }),
    );
    check(
      "a second close crossing the first one's commit closes the window exactly once",
      !!secondCloseEvent &&
        firstCloseEvent.prevented === true &&
        secondCloseEvent.prevented === true &&
        rig.closes === 1 &&
        doubleCloseState.commitRefusedCount >= 1 &&
        doubleCloseState.commitRefusedWhy === "superseded-by-new-intent" &&
        installs === 0,
      JSON.stringify({
        firstPrevented: firstCloseEvent.prevented,
        secondPrevented: secondCloseEvent && secondCloseEvent.prevented,
        closes: rig.closes,
        beforeDoubleClose,
        state: doubleCloseState,
      }),
    );

    // -- the renderer wedges while its commit is outstanding ---------------
    // A renderer that is alive but not answering has no event of its own to
    // release a commit: the reply simply never comes. Chromium's hang
    // notification is the one signal for it, and it must settle the commit
    // rather than leave the app holding a frozen document and an unanswerable
    // question.
    __shutdown.reset();
    rig.reset();
    installs = 0;
    rig.answer = 1;
    await makeDocumentClean();
    let wedged = 0;
    let wedgeCommitInFlight = null;
    const wedgeApprovalRequests = [];
    const realWedgeSend = wc.send;
    const restoreWedgeSend = replaceMethod(wc, "send", function (channel, ...args) {
      if (channel === "quit-approval-request") wedgeApprovalRequests.push(args[0]);
      return realWedgeSend.call(this, channel, ...args);
    });
    const wedgeDuringCommit = () => {
      if (wedged) return;
      wedged = 1;
      wedgeCommitInFlight = __shutdown.state().commitPendingId;
      win.emit("unresponsive");
    };
    ipcMain.on("quit-approval-response", wedgeDuringCommit);
    let wedgeClose;
    try {
      wedgeClose = guardEvent();
      win.emit("close", wedgeClose);
      await waitUntil(() => rig.dialogs.length > 0, 10000);
      await sleep(300);
    } finally {
      ipcMain.removeListener("quit-approval-response", wedgeDuringCommit);
      restoreWedgeSend();
    }
    const wedgeState = __shutdown.state();
    const freezeAfterWedge = await exec(
      `window.CustomTabs.__shutdownFreeze()`,
    );
    check(
      "the wedge really arrived while a commit was in flight",
      wedged === 1 &&
        wedgeCommitInFlight !== null &&
        wedgeCommitInFlight > 0,
      JSON.stringify({ wedged, wedgeCommitInFlight }),
    );
    check(
      "an unresponsive renderer settles the commit it can no longer answer and asks in the main process",
      wedged === 1 &&
        wedgeClose.prevented === true &&
        wedgeState.commitRefusedWhy === "unresponsive-during-commit" &&
        rig.dialogs.length === 1 &&
        /cannot be checked/i.test(String(rig.dialogs[0].options.title)) &&
        // The original renderer question is the only IPC approval dispatch.
        // A fallback must not re-ask it, or it races the native prompt.
        wedgeApprovalRequests.length === 1 &&
        // Cancel: nothing closed and no standing permission was left behind.
        rig.closes === 0 &&
        wedgeState.authorized === false &&
        wedgeState.pendingId === 0,
      JSON.stringify({
        wedged,
        prevented: wedgeClose.prevented,
        state: wedgeState,
        dialogs: rig.dialogs.map((d) => d.options.title),
        rendererApprovalRequests: wedgeApprovalRequests.map((request) => request && request.id),
        closes: rig.closes,
      }),
    );
    check(
      "a commit settled by an unresponsive renderer does not leave the document frozen",
      freezeAfterWedge &&
        freezeAfterWedge.frozen === false &&
        freezeAfterWedge.editorReadOnly === false &&
        freezeAfterWedge.wrapperInert === false,
      JSON.stringify(freezeAfterWedge),
    );

    // -- who the main process believes it is talking to ---------------------
    // The sender check is the security control here, and "the suite passed" is
    // not evidence for it. This measures the frame the real renderer's answers
    // actually arrive on, so the strict main-frame test in isApprovalSender is
    // asserted against reality rather than assumed from the typings.
    __shutdown.reset();
    rig.reset();
    rig.answer = 0;
    let senderFacts = null;
    const captureSender = (event) => {
      const frame = event.senderFrame;
      const main = event.sender.mainFrame;
      senderFacts = {
        sameWebContents: event.sender.id === win.webContents.id,
        identical: frame === main,
        sameNode:
          !!frame && !!main && frame.frameTreeNodeId === main.frameTreeNodeId,
        isMainFrame: !!frame && frame.parent === null,
      };
    };
    ipcMain.on("quit-approval-response", captureSender);
    try {
      const senderClose = guardEvent();
      win.emit("close", senderClose);
      await waitUntil(() => senderFacts !== null);
      await sleep(200);
      check(
        "the renderer's answers arrive on the document window's own main frame",
        !!senderFacts &&
          senderFacts.sameWebContents === true &&
          senderFacts.identical === true &&
          senderFacts.sameNode === true &&
          senderFacts.isMainFrame === true,
        JSON.stringify(senderFacts),
      );
    } finally {
      ipcMain.removeListener("quit-approval-response", captureSender);
    }

    // -- a popup is not a document window ----------------------------------
    __shutdown.reset();
    rig.reset();
    const beforePopup = __shutdown.state().lastRequestId;
    await exec(`
      window.ipcRenderer.send('open-mermaid-popup', {
        svgContent: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#4a90d9"></rect></svg>',
        isDarkMode: false
      });
      null;
    `);
    const popupOpened = await waitUntil(
      () => BrowserWindow.getAllWindows().length > 1,
      10000,
    );
    const popup = BrowserWindow.getAllWindows().find((w) => w.id !== win.id);
    if (popup) popup.close();
    const popupGone = await waitUntil(
      () => !popup || popup.isDestroyed(),
      10000,
    );
    check(
      "closing a popup is not a shutdown: it is neither held nor asked about",
      popupOpened &&
        popupGone &&
        rig.dialogs.length === 0 &&
        __shutdown.state().lastRequestId === beforePopup &&
        __shutdown.state().pendingId === 0,
      JSON.stringify({
        popupOpened,
        popupGone,
        dialogs: rig.dialogs.length,
        lastRequestId: __shutdown.state().lastRequestId,
        beforePopup,
      }),
    );

    // -- answers to a question that was not asked of them -------------------
    // The real listener is lifted off the channel so the question stays open
    // on purpose - the same removeAllListeners/restore pattern custom-tabs.js
    // itself uses for 'file-changed-externally'. Without it the renderer
    // answers within milliseconds and there is no open question to aim a wrong
    // id, a wrong sender or an unreadable answer at.
    //
    // KEEP THIS BLOCK BRIEF. A question nothing answers is eventually rescued
    // by the renderer-hang net (measured at roughly six seconds), and that
    // would settle the very request these checks need left open. Everything
    // here runs well inside that budget; do not add waits to it.
    //
    // AND BREVITY ALONE IS NOT A GUARANTEE, because the net is driven by
    // Chromium's own hang monitor rather than by a timer this harness controls.
    // The impostor case has to build and drive a SECOND renderer while the
    // question is open, and on a loaded machine that round trip is enough for
    // the monitor to report the document renderer as hung: measured twice in a
    // row here, main.js escalated request #39 and declined it before the
    // impostor had been refused, so the sender-gate assertion and the
    // unreadable-answer assertion after it were both reading a request that no
    // longer existed. The escalation is detached for exactly this region and
    // put back immediately afterwards - the same idiom, and the same reason, as
    // the loading-renderer case in runRendererLossScenario. It is not being
    // weakened: its three assertions sit directly above this block and run
    // against a wedge this harness creates deliberately.
    const sameDocUnresponsive = win.listeners("unresponsive");
    win.removeAllListeners("unresponsive");
    try {
      __shutdown.reset();
      rig.reset();
      rig.answer = 0;
      await exec(`
        (() => {
          const ipc = require('electron').ipcRenderer;
          window.__quitHandlers = ipc.listeners('quit-approval-request').slice();
          ipc.removeAllListeners('quit-approval-request');
          window.__lastQuitRequest = null;
          ipc.on('quit-approval-request', (e, d) => { window.__lastQuitRequest = d; });
          return window.__quitHandlers.length;
        })()
      `);
      const staleClose = guardEvent();
      win.emit("close", staleClose);
      const requestSeen = await waitUntil(() =>
        exec(`!!window.__lastQuitRequest`),
      );
      const openId = __shutdown.state().pendingId;
      const openRequest = await exec(`window.__lastQuitRequest`);
      const readyBefore = __shutdown.state();
      await exec(
        `window.ipcRenderer.send('quit-approval-ready', { gen: ${openRequest.gen + 1} }); null;`,
      );
      await sleep(100);
      check(
        "a forged wrong-generation READY is ignored without changing the open request",
        __shutdown.state().pendingId === openId &&
          __shutdown.state().staleReadyCount === readyBefore.staleReadyCount + 1,
        JSON.stringify({ before: readyBefore, after: __shutdown.state(), openId }),
      );
      const responseBefore = __shutdown.state();
      await exec(
        `window.ipcRenderer.send('quit-approval-response', { id: ${openId}, gen: ${openRequest.gen + 1}, dirtyFiles: [] }); null;`,
      );
      await sleep(100);
      check(
        "a wrong-generation response is ignored while its request remains open",
        __shutdown.state().pendingId === openId &&
          __shutdown.state().renderer === "ready" &&
          __shutdown.state().invalidRevisionCount === responseBefore.invalidRevisionCount &&
          __shutdown.state().staleResponseCount === responseBefore.staleResponseCount + 1,
        JSON.stringify({ before: responseBefore, after: __shutdown.state(), openId }),
      );
      await exec(
        `window.ipcRenderer.send('quit-approval-response', { id: ${openId + 500}, gen: ${openRequest.gen}, dirtyFiles: [] }); null;`,
      );
      await sleep(400);
      check(
        "an answer carrying the wrong request id is ignored and the question stays open",
        requestSeen &&
          openId > 0 &&
          __shutdown.state().pendingId === openId &&
          __shutdown.state().renderer === "ready" &&
          __shutdown.state().invalidRevisionCount === responseBefore.invalidRevisionCount &&
          rig.closes === 0 &&
          rig.dialogs.length === 0,
        JSON.stringify({
          requestSeen,
          openId,
          state: __shutdown.state(),
          closes: rig.closes,
        }),
      );

      // The phase-two revision is mandatory. Drive malformed values from the
      // real document sender with an otherwise exact request identity, then
      // exercise both native fallback outcomes. Every row gets its own name so
      // a revert cannot hide one rejected representation behind another.
      const invalidRevisionCases = [
        { name: "missing", property: "", why: "missing" },
        { name: "null", property: ", revision: null", why: "not-a-safe-integer" },
        { name: "string", property: ", revision: 'legacy'", why: "not-a-safe-integer" },
        { name: "fractional", property: ", revision: 1.5", why: "not-a-safe-integer" },
        { name: "negative", property: ", revision: -1", why: "negative" },
        {
          name: "greater than MAX_SAFE_INTEGER",
          property: ", revision: Number.MAX_SAFE_INTEGER + 1",
          why: "not-a-safe-integer",
        },
      ];
      const holdRawApprovalRequest = async () => {
        await exec(`
          (() => {
            const ipc = require('electron').ipcRenderer;
            window.__quitHandlers = ipc.listeners('quit-approval-request').slice();
            ipc.removeAllListeners('quit-approval-request');
            window.__lastQuitRequest = null;
            ipc.on('quit-approval-request', (_event, request) => {
              window.__lastQuitRequest = request;
            });
            return window.__quitHandlers.length;
          })()
        `);
        const close = guardEvent();
        win.emit("close", close);
        const seen = await waitUntil(() => exec(`!!window.__lastQuitRequest`), 5000);
        return { close, seen, request: await exec(`window.__lastQuitRequest`) };
      };
      for (const invalid of invalidRevisionCases) {
        __shutdown.reset();
        rig.reset();
        rig.answer = 1;
        const cancelled = await holdRawApprovalRequest();
        const cancelBefore = __shutdown.state();
        await exec(
          `window.ipcRenderer.send('quit-approval-response', { id: ${cancelled.request ? cancelled.request.id : -1}, gen: ${cancelled.request ? cancelled.request.gen : -1}, dirtyFiles: []${invalid.property} }); null;`,
        );
        const cancelFallback = await waitUntil(
          () => rig.dialogs.length === 1 && __shutdown.state().pendingId === 0,
          5000,
        );
        const cancelAfter = __shutdown.state();
        const cancelDialog = rig.dialogs[0];
        const cancelCloses = rig.closes;

        // An invalid response makes this renderer unusable. Reload so the
        // confirm half is a fresh correct-id/generation request, not a
        // permissive shortcut around the already-poisoned document.
        wc.reload();
        await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
        __shutdown.reset();
        rig.reset();
        rig.answer = 0;
        const confirmed = await holdRawApprovalRequest();
        await exec(
          `window.ipcRenderer.send('quit-approval-response', { id: ${confirmed.request ? confirmed.request.id : -1}, gen: ${confirmed.request ? confirmed.request.gen : -1}, dirtyFiles: []${invalid.property} }); null;`,
        );
        const confirmFallback = await waitUntil(
          () => rig.dialogs.length === 1 && rig.closes === 1,
          5000,
        );
        const confirmAfter = __shutdown.state();
        const confirmDialog = rig.dialogs[0];
        check(
          `an otherwise-valid ${invalid.name} shutdown revision is refused through the unreadable native fallback`,
          cancelled.seen &&
            cancelled.close.prevented === true &&
            cancelFallback &&
            cancelAfter.invalidRevisionCount === cancelBefore.invalidRevisionCount + 1 &&
            cancelAfter.invalidRevisionWhy === invalid.why &&
            cancelAfter.renderer === "unusable" &&
            cancelAfter.rendererUnusableReason ===
              `invalid shutdown approval revision (${invalid.why})` &&
            cancelAfter.settleWhy === "fallback-unreadable" &&
            cancelAfter.commitPendingId === 0 &&
            cancelAfter.pendingId === 0 &&
            cancelAfter.authorized === false &&
            cancelCloses === 0 &&
            cancelDialog &&
            cancelDialog.pendingReason === "window-close" &&
            cancelDialog.options.title === "Unsaved changes cannot be checked" &&
            cancelDialog.options.message ===
              "Folia cannot confirm whether anything is unsaved." &&
            cancelDialog.options.detail ===
              "The document view could not check the open documents.\n\nClosing now may discard unsaved changes." &&
            JSON.stringify(cancelDialog.options.buttons) ===
              JSON.stringify(["Close anyway", "Cancel"]) &&
            cancelDialog.options.defaultId === 1 &&
            cancelDialog.options.cancelId === 1 &&
            confirmed.seen &&
            confirmed.close.prevented === true &&
            confirmFallback &&
            confirmAfter.invalidRevisionCount === 1 &&
            confirmAfter.invalidRevisionWhy === invalid.why &&
            confirmAfter.renderer === "unusable" &&
            confirmAfter.rendererUnusableReason ===
              `invalid shutdown approval revision (${invalid.why})` &&
            confirmAfter.settleWhy === "fallback-unreadable" &&
            confirmAfter.commitPendingId === 0 &&
            confirmAfter.pendingId === 0 &&
            confirmAfter.authorized === true &&
            confirmDialog &&
            confirmDialog.pendingReason === "window-close" &&
            confirmDialog.options.title === "Unsaved changes cannot be checked" &&
            confirmDialog.options.message ===
              "Folia cannot confirm whether anything is unsaved." &&
            confirmDialog.options.detail ===
              "The document view could not check the open documents.\n\nClosing now may discard unsaved changes." &&
            JSON.stringify(confirmDialog.options.buttons) ===
              JSON.stringify(["Close anyway", "Cancel"]) &&
            confirmDialog.options.defaultId === 1 &&
            confirmDialog.options.cancelId === 1 &&
            rig.closes === 1,
          JSON.stringify({
            invalid,
            cancel: {
              seen: cancelled.seen,
              prevented: cancelled.close.prevented,
              before: cancelBefore,
              after: cancelAfter,
              dialog: cancelDialog,
              closes: cancelCloses,
            },
            confirm: {
              seen: confirmed.seen,
              prevented: confirmed.close.prevented,
              after: confirmAfter,
              dialog: confirmDialog,
            },
            closes: rig.closes,
          }),
        );
        // The confirm half deliberately made this renderer unusable; restore
        // a new document before the next representation gets its own exact
        // request/generation pair.
        wc.reload();
        await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
      }

      // Phase two is an acknowledgement of the exact frozen document, not a
      // second chance for a renderer to invent a different revision. Hold the
      // real commit request, then inject replies from the real document
      // sender. Invalid acknowledgements must refuse and ask again; a stale
      // identity must be ignored without disturbing the commit it does not
      // own. This deliberately covers the wire representations a legacy or
      // compromised renderer can produce, rather than only the renderer's
      // current well-formed reply.
      const cleanCommittedReplyDocument = () =>
        exec(`
          (() => {
            const confirm = window.confirm;
            window.confirm = () => true;
            try {
              window.CustomTabs.getTabs().forEach(t => {
                t.content = t.originalContent;
                t.hasUnsavedChanges = false;
              });
            } finally {
              window.confirm = confirm;
            }
            const tab = window.CustomTabs.getActiveTab();
            window.originalMarkdown = tab ? tab.originalContent : "";
            return !!tab;
          })()
        `);
      const holdPhaseTwoCommit = async () => {
        let held = null;
        const realSend = wc.send;
        const restoreSend = replaceMethod(wc, "send", function (channel, payload) {
          if (channel === "quit-approval-commit" && held === null) {
            held = payload;
            return;
          }
          return realSend.call(this, channel, payload);
        });
        const close = guardEvent();
        win.emit("close", close);
        const heldReady = await waitUntil(
          () => held !== null && __shutdown.state().commitPendingId === held.id,
          10000,
        );
        restoreSend();
        return { close, held, heldReady };
      };
      const committedReplyCases = [
        {
          name: "missing revision",
          fields: "",
          invalidWhy: "missing",
          outcome: "refused",
        },
        {
          name: "null revision",
          fields: ", revision: null",
          invalidWhy: "not-a-safe-integer",
          outcome: "refused",
        },
        {
          name: "string revision",
          fields: ", revision: 'legacy'",
          invalidWhy: "not-a-safe-integer",
          outcome: "refused",
        },
        {
          name: "fractional revision",
          fields: ", revision: 1.5",
          invalidWhy: "not-a-safe-integer",
          outcome: "refused",
        },
        {
          name: "negative revision",
          fields: ", revision: -1",
          invalidWhy: "negative",
          outcome: "refused",
        },
        {
          name: "unsafe revision",
          fields: ", revision: Number.MAX_SAFE_INTEGER + 1",
          invalidWhy: "not-a-safe-integer",
          outcome: "refused",
        },
        {
          name: "mismatched revision",
          fields: (commit) => `, revision: ${commit.revision + 1}`,
          invalidWhy: "mismatch",
          outcome: "refused",
        },
        {
          name: "stale request id",
          fields: (commit) => `, id: ${commit.id + 1}, revision: ${commit.revision}`,
          outcome: "stale",
        },
        {
          name: "stale generation",
          fields: (commit) => `, gen: ${commit.gen + 1}, revision: ${commit.revision}`,
          outcome: "stale",
        },
        {
          name: "explicitly uncommitted exact revision",
          fields: (commit) => `, revision: ${commit.revision}`,
          committed: false,
          outcome: "refused",
        },
        {
          name: "exact revision",
          fields: (commit) => `, revision: ${commit.revision}`,
          outcome: "committed",
        },
      ];
      for (const replyCase of committedReplyCases) {
        __shutdown.reset();
        rig.reset();
        await cleanCommittedReplyDocument();
        const armed = await holdPhaseTwoCommit();
        const commit = armed.held;
        const fields =
          typeof replyCase.fields === "function"
            ? commit
              ? replyCase.fields(commit)
              : ""
            : replyCase.fields;
        const committed = replyCase.committed !== false;
        const beforeReply = __shutdown.state();
        const staleBefore = beforeReply.staleCommitCount;
        const refusedBefore = beforeReply.commitRefusedCount;
        let reissuedRequest = null;
        let restoreReissuedRequest = null;
        if (replyCase.outcome === "refused") {
          const realSend = wc.send;
          restoreReissuedRequest = replaceMethod(
            wc,
            "send",
            function (channel, payload) {
              if (
                channel === "quit-approval-request" &&
                reissuedRequest === null
              ) {
                reissuedRequest = payload;
                return;
              }
              return realSend.call(this, channel, payload);
            },
          );
        }
        try {
          if (commit) {
            await exec(
              `window.ipcRenderer.send('quit-approval-committed', { id: ${commit.id}, gen: ${commit.gen}, committed: ${committed}${fields} }); null;`,
            );
          }
          if (replyCase.outcome === "refused") {
            const refused = await waitUntil(
              () =>
                reissuedRequest &&
                commit &&
                reissuedRequest.id > commit.id &&
                __shutdown.state().commitPendingId === 0,
              5000,
            );
            const afterReply = __shutdown.state();
            check(
              `a phase-two ${replyCase.name} fails closed and re-asks rather than closing`,
              armed.heldReady &&
                !!commit &&
                armed.close.prevented === true &&
                refused &&
                afterReply.pendingId === reissuedRequest.id &&
                afterReply.commitPendingId === 0 &&
                afterReply.commitRefusedCount === refusedBefore + 1 &&
                afterReply.invalidRevisionCount ===
                  beforeReply.invalidRevisionCount +
                    (replyCase.invalidWhy ? 1 : 0) &&
                afterReply.invalidRevisionWhy ===
                  (replyCase.invalidWhy || beforeReply.invalidRevisionWhy) &&
                afterReply.authorized === false &&
                rig.closes === 0 &&
                rig.quits === 0,
              JSON.stringify({
                replyCase: replyCase.name,
                armed,
                beforeReply,
                afterReply,
                reissued: reissuedRequest,
                closes: rig.closes,
                quits: rig.quits,
              }),
            );
          } else if (replyCase.outcome === "stale") {
            const ignored = await waitUntil(
              () => __shutdown.state().staleCommitCount === staleBefore + 1,
              3000,
            );
            const afterReply = __shutdown.state();
            check(
              `a phase-two ${replyCase.name} is ignored without changing the live commit`,
              armed.heldReady &&
                !!commit &&
                armed.close.prevented === true &&
                ignored &&
                afterReply.commitPendingId === commit.id &&
                afterReply.commitSequence === beforeReply.commitSequence &&
                afterReply.commitRefusedCount === refusedBefore &&
                afterReply.authorized === false &&
                rig.closes === 0 &&
                rig.quits === 0,
              JSON.stringify({
                replyCase: replyCase.name,
                armed,
                beforeReply,
                afterReply,
                closes: rig.closes,
                quits: rig.quits,
              }),
            );
          } else {
            const committedClose = await waitUntil(() => rig.closes === 1, 5000);
            const afterReply = __shutdown.state();
            check(
              "a phase-two exact revision commits and closes once",
              armed.heldReady &&
                !!commit &&
                armed.close.prevented === true &&
                committedClose &&
                afterReply.commitPendingId === 0 &&
                afterReply.commitRefusedCount === refusedBefore &&
                afterReply.authorized === true &&
                rig.closes === 1 &&
                rig.quits === 0,
              JSON.stringify({
                armed,
                beforeReply,
                afterReply,
                closes: rig.closes,
                quits: rig.quits,
              }),
            );
          }
        } finally {
          if (restoreReissuedRequest) {
            restoreReissuedRequest();
          }
        }
      }

      // Valid revisions retain the two-phase protocol. Capture the genuine
      // commit event before its continuation can close the rig, then replay
      // the old response to prove it is stale rather than a second close.
      wc.reload();
      await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
      __shutdown.reset();
      rig.reset();
      const validClean = await holdRawApprovalRequest();
      const validCleanRevision = await exec(`window.CustomTabs.__shutdownFreeze().revision`);
      let cleanCommit = null;
      let closesAtCleanCommit = null;
      const cleanCommits = [];
      const captureCleanCommit = (_event, data) => {
        cleanCommits.push(data);
        cleanCommit = data;
        closesAtCleanCommit = rig.closes;
      };
      ipcMain.on("quit-approval-committed", captureCleanCommit);
      try {
        await exec(
          `window.ipcRenderer.send('quit-approval-response', { id: ${validClean.request ? validClean.request.id : -1}, gen: ${validClean.request ? validClean.request.gen : -1}, revision: ${JSON.stringify(validCleanRevision)}, dirtyFiles: [] }); null;`,
        );
        const cleanClosed = await waitUntil(() => rig.closes === 1, 5000);
        const firstCleanCommit = cleanCommit && {
          id: cleanCommit.id,
          gen: cleanCommit.gen,
          revision: cleanCommit.revision,
          committed: cleanCommit.committed,
        };
        const staleBeforeDuplicate = __shutdown.state().staleResponseCount;
        await exec(
          `window.ipcRenderer.send('quit-approval-response', { id: ${validClean.request ? validClean.request.id : -1}, gen: ${validClean.request ? validClean.request.gen : -1}, revision: ${JSON.stringify(validCleanRevision)}, dirtyFiles: [] }); null;`,
        );
        const duplicateInert = await waitUntil(
          () => __shutdown.state().staleResponseCount === staleBeforeDuplicate + 1,
          5000,
        );
        const staleCommitsBeforeExactReplay = __shutdown.state().staleCommitCount;
        const installsBeforeExactCommitReplay = installs;
        if (firstCleanCommit) {
          await exec(
            `window.ipcRenderer.send('quit-approval-committed', ${JSON.stringify({
              id: firstCleanCommit.id,
              gen: firstCleanCommit.gen,
              revision: firstCleanCommit.revision,
              committed: true,
            })}); null;`,
          );
        }
        const exactCommitReplayWasStale = await waitUntil(
          () =>
            __shutdown.state().staleCommitCount ===
            staleCommitsBeforeExactReplay + 1,
          5000,
        );
        const exactCommitReplayDelivered = await waitUntil(
          () => cleanCommits.length === 2,
          3000,
        );
        const afterExactCommitReplay = __shutdown.state();
        const closesAfterExactCommitReplay = rig.closes;
        const installsAfterExactCommitReplay = installs;
        const staleCommitsBeforeAlteredRevisionReplay =
          afterExactCommitReplay.staleCommitCount;
        if (firstCleanCommit) {
          await exec(
            `window.ipcRenderer.send('quit-approval-committed', ${JSON.stringify({
              id: firstCleanCommit.id,
              gen: firstCleanCommit.gen,
              revision: firstCleanCommit.revision + 1,
              committed: true,
            })}); null;`,
          );
        }
        const alteredRevisionReplayWasStale = await waitUntil(
          () =>
            __shutdown.state().staleCommitCount ===
            staleCommitsBeforeAlteredRevisionReplay + 1,
          5000,
        );
        const alteredRevisionReplayDelivered = await waitUntil(
          () => cleanCommits.length === 3,
          3000,
        );
        const afterAlteredRevisionReplay = __shutdown.state();
        const closesAfterAlteredRevisionReplay = rig.closes;
        const installsAfterAlteredRevisionReplay = installs;
        check(
          "an exact duplicate phase-two committed replay preserves id, generation, revision, and committed",
          exactCommitReplayDelivered &&
            cleanCommits.length >= 2 &&
            firstCleanCommit &&
            cleanCommits[1] &&
            cleanCommits[1].id === firstCleanCommit.id &&
            cleanCommits[1].gen === firstCleanCommit.gen &&
            cleanCommits[1].revision === firstCleanCommit.revision &&
            cleanCommits[1].committed === firstCleanCommit.committed,
          JSON.stringify({ firstCleanCommit, exactCommitReplay: cleanCommits[1] }),
        );
        check(
          "a same-id-generation phase-two replay with an altered revision is stale and cannot rerun its continuation",
          alteredRevisionReplayDelivered &&
            cleanCommits[2] &&
            firstCleanCommit &&
            cleanCommits[2].id === firstCleanCommit.id &&
            cleanCommits[2].gen === firstCleanCommit.gen &&
            cleanCommits[2].revision === firstCleanCommit.revision + 1 &&
            cleanCommits[2].committed === firstCleanCommit.committed &&
            alteredRevisionReplayWasStale &&
            afterAlteredRevisionReplay.staleCommitCount ===
              staleCommitsBeforeAlteredRevisionReplay + 1 &&
            afterAlteredRevisionReplay.commitPendingId === 0 &&
            closesAfterAlteredRevisionReplay === closesAfterExactCommitReplay &&
            installsAfterAlteredRevisionReplay === installsAfterExactCommitReplay,
          JSON.stringify({
            firstCleanCommit,
            alteredRevisionReplay: cleanCommits[2],
            afterExactCommitReplay,
            afterAlteredRevisionReplay,
            closesAfterExactCommitReplay,
            closesAfterAlteredRevisionReplay,
            installsAfterExactCommitReplay,
            installsAfterAlteredRevisionReplay,
          }),
        );
        wc.reload();
        const laterRequestRendererReady = await waitUntil(
          () => __shutdown.state().renderer === "ready",
          20000,
        );
        __shutdown.reset();
        rig.reset();
        const laterClose = guardEvent();
        win.emit("close", laterClose);
        const laterRequestCompleted = await waitUntil(
          () => rig.closes === 1,
          5000,
        );
        const laterRequestState = __shutdown.state();
        check(
          "a valid clean revision reaches phase-two commit and a duplicate response cannot close twice",
          validClean.seen &&
            validClean.close.prevented === true &&
            cleanClosed &&
            firstCleanCommit &&
            firstCleanCommit.id === validClean.request.id &&
            firstCleanCommit.gen === validClean.request.gen &&
            firstCleanCommit.revision === validCleanRevision &&
            firstCleanCommit.committed === true &&
            closesAtCleanCommit === 0 &&
            duplicateInert &&
            exactCommitReplayWasStale &&
            afterExactCommitReplay.commitPendingId === 0 &&
            afterExactCommitReplay.authorized === true &&
            afterExactCommitReplay.staleCommitCount ===
              staleCommitsBeforeExactReplay + 1 &&
            closesAfterExactCommitReplay === 1 &&
            installsAfterExactCommitReplay === installsBeforeExactCommitReplay &&
            laterRequestRendererReady &&
            laterClose.prevented === true &&
            laterRequestCompleted &&
            laterRequestState.lastRequestId > firstCleanCommit.id &&
            laterRequestState.commitPendingId === 0 &&
            rig.closes === 1 &&
            rig.quits === 0 &&
            installs === installsBeforeExactCommitReplay &&
            rig.dialogs.length === 0,
          JSON.stringify({
            validClean,
            validCleanRevision,
            firstCleanCommit,
            closesAtCleanCommit,
            cleanClosed,
            duplicateInert,
            staleCommitsBeforeExactReplay,
            installsBeforeExactCommitReplay,
            exactCommitReplayWasStale,
            exactCommitReplayDelivered,
            afterExactCommitReplay,
            closesAfterExactCommitReplay,
            installsAfterExactCommitReplay,
            staleCommitsBeforeAlteredRevisionReplay,
            alteredRevisionReplayWasStale,
            alteredRevisionReplayDelivered,
            afterAlteredRevisionReplay,
            closesAfterAlteredRevisionReplay,
            installsAfterAlteredRevisionReplay,
            laterRequestRendererReady,
            laterClosePrevented: laterClose.prevented,
            laterRequestCompleted,
            laterRequestState,
            closes: rig.closes,
            quits: rig.quits,
            installs,
          }),
        );
      } finally {
        ipcMain.removeListener("quit-approval-committed", captureCleanCommit);
      }

      wc.reload();
      await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
      __shutdown.reset();
      rig.reset();
      rig.answer = 0;
      const validDirty = await holdRawApprovalRequest();
      const validDirtyRevision = await exec(`window.CustomTabs.__shutdownFreeze().revision`);
      let dirtyCommit = null;
      const captureDirtyCommit = (_event, data) => { dirtyCommit = data; };
      ipcMain.on("quit-approval-committed", captureDirtyCommit);
      try {
        await exec(
          `window.ipcRenderer.send('quit-approval-response', { id: ${validDirty.request ? validDirty.request.id : -1}, gen: ${validDirty.request ? validDirty.request.gen : -1}, revision: ${JSON.stringify(validDirtyRevision)}, dirtyFiles: ['dirty.md'] }); null;`,
        );
        const dirtyClosed = await waitUntil(() => rig.closes === 1, 5000);
        check(
          "a valid dirty revision shows discard approval before its phase-two commit",
          validDirty.seen &&
            validDirty.close.prevented === true &&
            dirtyClosed &&
            rig.dialogs.length === 1 &&
            /Unsaved changes/.test(String(rig.dialogs[0].options.title)) &&
            dirtyCommit &&
            dirtyCommit.id === validDirty.request.id &&
            dirtyCommit.revision === validDirtyRevision &&
            __shutdown.state().invalidRevisionCount === 0,
          JSON.stringify({ validDirty, validDirtyRevision, dirtyCommit, dialogs: rig.dialogs, closes: rig.closes, state: __shutdown.state() }),
        );
      } finally {
        ipcMain.removeListener("quit-approval-committed", captureDirtyCommit);
      }

      // Restore a held request listener for the sender-gate assertions below.
      wc.reload();
      await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
      await exec(`
        (() => {
          const ipc = require('electron').ipcRenderer;
          window.__quitHandlers = ipc.listeners('quit-approval-request').slice();
          ipc.removeAllListeners('quit-approval-request');
          window.__lastQuitRequest = null;
          ipc.on('quit-approval-request', (_event, request) => { window.__lastQuitRequest = request; });
          return true;
        })()
      `);

      // A window that owns no documents is not allowed to answer for the one
      // that does, however well-formed its message is.
      //
      // THE WINDOW IS BUILT BEFORE THE QUESTION IS RAISED. Constructing and
      // loading a second BrowserWindow is expensive enough to push the main
      // renderer past Chromium's hang threshold, and the hang net - correctly -
      // then escalates the outstanding question to the main process and settles
      // it. Measured: the fallback granted request #38 before the impostor had
      // sent anything, so the assertion below was reading a request that no
      // longer existed and blaming the sender gate for it. Doing the expensive
      // part first, then raising a FRESH question, puts the measurement inside a
      // few hundred milliseconds of its own request.
      //
      // The escalation itself is untouched - it has its own tests - and this
      // block PROVES it did not intervene here rather than assuming it: the
      // sample requires that no dialog had appeared at that instant, and the
      // answer is set to Cancel so that even a late escalation could not close
      // the window or authorise anything.
      const impostor = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      await impostor.loadFile(impostorFile);
      // Warm the impostor's own renderer, so the send below is the only work left.
      await impostor.webContents.executeJavaScript(`null;`);
      __shutdown.reset();
      rig.reset();
      rig.answer = 1;
      const impostorClose = guardEvent();
      win.emit("close", impostorClose);
      const impostorRequestSeen = await waitUntil(
        () => __shutdown.state().pendingId > 0,
        10000,
      );
      const beforeImpostor = __shutdown.state();
      const impostorId = beforeImpostor.pendingId;
      const impostorGen = beforeImpostor.rendererGeneration;
      await impostor.webContents.executeJavaScript(`
        const ipc = require('electron').ipcRenderer;
        ipc.send('quit-approval-ready', { gen: ${impostorGen} });
        ipc.send('quit-approval-response', { id: ${impostorId}, gen: ${impostorGen}, dirtyFiles: [] });
        null;
      `);
      await sleep(250);
      const afterImpostor = __shutdown.state();
      const dialogsAtSample = rig.dialogs.length;
      impostor.destroy();
      check(
        "an answer from a window that owns no documents is refused",
        impostorRequestSeen &&
          impostorId > 0 &&
          // NO FALLBACK HAD INTERVENED, so what follows is a statement about the
          // sender gate and not about the hang net.
          dialogsAtSample === 0 &&
          // NOTHING MOVED AT ALL. isApprovalSender() returns before any counter
          // is touched, so an impostor cannot even register as a stale answer -
          // which makes every one of these an exact statement rather than a
          // tolerance.
          afterImpostor.pendingId === impostorId &&
          afterImpostor.lastRequestId === beforeImpostor.lastRequestId &&
          afterImpostor.staleResponseCount === beforeImpostor.staleResponseCount &&
          afterImpostor.staleReadyCount === beforeImpostor.staleReadyCount &&
          afterImpostor.rendererGeneration === beforeImpostor.rendererGeneration &&
          afterImpostor.settleWhy === beforeImpostor.settleWhy &&
          afterImpostor.authorized === false &&
          rig.closes === 0 &&
          rig.quits === 0,
        JSON.stringify({
          impostorRequestSeen,
          impostorId,
          dialogsAtSample,
          before: beforeImpostor,
          after: afterImpostor,
          closes: rig.closes,
          quits: rig.quits,
        }),
      );
      // Back to approving for the unreadable case below, which measures the
      // main-process question actually being answered.
      rig.answer = 0;

      // An answer the main process cannot read is not an approval either.
      await exec(
        `window.ipcRenderer.send('quit-approval-response', { id: (window.__lastQuitRequest && window.__lastQuitRequest.id) || -1, gen: (window.__lastQuitRequest && window.__lastQuitRequest.gen) || -1, dirtyFiles: [null] }); null;`,
      );
      await waitUntil(() => rig.dialogs.length > 0);
      await sleep(200);
      check(
        "an unreadable answer raises the main-process question instead of closing",
        rig.dialogs.length === 1 &&
          /cannot be checked/i.test(String(rig.dialogs[0].options.title)) &&
          rig.closes === 1,
        JSON.stringify({
          dialogs: rig.dialogs.length,
          title: rig.dialogs.length ? rig.dialogs[0].options.title : null,
          closes: rig.closes,
        }),
      );

      await exec(`
        (() => {
          const ipc = require('electron').ipcRenderer;
          ipc.removeAllListeners('quit-approval-request');
          window.__quitHandlers.forEach(fn => ipc.on('quit-approval-request', fn));
          return ipc.listeners('quit-approval-request').length;
        })()
      `);
    } finally {
      sameDocUnresponsive.forEach((listener) => win.on("unresponsive", listener));
    }

    // -- the renderer's own staleness filter -------------------------------
    __shutdown.reset();
    rig.reset();
    const responses = [];
    const countResponses = (event, data) => {
      responses.push(data);
    };
    ipcMain.on("quit-approval-response", countResponses);
    try {
      await exec(`
        (() => {
          const tab = window.CustomTabs.createTab(${jsQ1}, "cached-answer");
          tab.content = tab.originalContent;
          window.originalMarkdown = tab.originalContent;
          return true;
        })()
      `);
      const generation = await exec(`window.ipcRenderer.invoke('quit-approval-generation')`);
      win.webContents.send("quit-approval-request", {
        id: 900000,
        reason: "ctrl-q",
        gen: generation,
      });
      await waitUntil(() => responses.some((data) => data && data.id === 900000));
      await exec(`
        (() => {
          const tab = window.CustomTabs.getActiveTab();
          tab.content = tab.originalContent + "-edited-after-first-answer";
          // The live copy has to move with the cache or this edit is not one:
          // the snapshot inside a RECOMPUTE would fold the pristine text back
          // over it and answer exactly what the replay answers, leaving the
          // comparison below unable to tell a cache hit from a recompute.
          window.originalMarkdown = tab.content;
          return true;
        })()
      `);
      win.webContents.send("quit-approval-request", {
        id: 900000,
        reason: "ctrl-q",
        gen: generation,
      });
      await waitUntil(
        () => responses.filter((data) => data && data.id === 900000).length === 2,
      );
      const afterFresh = responses.filter((data) => data && data.id === 900000).length;
      win.webContents.send("quit-approval-request", { id: 899999, reason: "ctrl-q", gen: generation });
      await sleep(600);
      check(
        "the renderer answers a fresh shutdown request and ignores a stale one",
        afterFresh >= 1 &&
          responses.every((data) => data && data.id === 900000),
        JSON.stringify({ afterFresh, responseIds: responses.map((data) => data && data.id) }),
      );
      check(
        "the renderer replays its cached response for a duplicate same-id request",
        afterFresh === 2 &&
          JSON.stringify(responses[0] && responses[0].dirtyFiles) ===
            JSON.stringify(responses[1] && responses[1].dirtyFiles),
        JSON.stringify({ afterFresh, responses }),
      );
    } finally {
      ipcMain.removeListener("quit-approval-response", countResponses);
    }
    // And leave nothing open. The next block reloads this renderer again, and
    // a restored tab whose first render has not settled can answer "dirty" for
    // reasons that have nothing to do with what is being measured there. An
    // empty document set must be persisted BEFORE that reload: restoreTabs()
    // is a real renderer path and a retained freeze properly refuses creation.
    await exec(`
      (() => {
        const realConfirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().forEach(t => { t.content = t.originalContent; t.hasUnsavedChanges = false; });
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = realConfirm;
        }
        localStorage.clear();
        window.originalMarkdown = '';
        window.isEditMode = false;
        return window.CustomTabs.getTabs().length;
      })()
    `);
  } finally {
    if (restoreInstall) restoreInstall();
    electronAutoUpdater.removeListener(
      "before-quit-for-update",
      countPublicUpdateCommit,
    );
    if (restoreUpdaterLatch) restoreUpdaterLatch();
    rig.restore();
    check(
      "the shutdown rig restores the exact app.quit property descriptor",
      sameDescriptor(
        Object.getOwnPropertyDescriptor(app, "quit"),
        rig.appQuitDescriptor,
      ),
      JSON.stringify({
        before: rig.appQuitDescriptor,
        after: Object.getOwnPropertyDescriptor(app, "quit"),
      }),
    );
    __shutdown.reset();
  }
}

async function runSameDocumentShutdownScenarios(win, exec) {
  const semantic = await exec(`
    (async () => {
      const ipc = require("electron").ipcRenderer;
      const handler = ipc.listeners("quit-approval-request")[0];
      if (!handler) return { error: "shutdown listener missing" };
      const generation = await ipc.invoke("quit-approval-generation");
      const originalSend = ipc.send;
      const originalIndexOf = String.prototype.indexOf;
      const originalReplace = String.prototype.replace;
      let nextId = 50000000;
      let response = null;
      const observations = {};

      const clear = () => {
        const confirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = confirm;
        }
        window.isEditMode = false;
        window.originalMarkdown = "";
      };
      const prepare = (entries, active = 0) => {
        clear();
        entries.forEach((entry, index) => {
          const tab = window.CustomTabs.createTab(
            "semantic-" + nextId + "-" + index + ".md",
            entry.original,
            { activate: index === active },
          );
          tab.content = entry.content;
          tab.hasUnsavedChanges = entry.flag === undefined ? false : entry.flag;
          // THE ACTIVE TAB'S LIVE COPY MOVES WITH ITS CACHE. A view-mode edit
          // lives in window.originalMarkdown, and every switch and every
          // shutdown snapshot folds that copy back into the tab - so an active
          // fixture that assigns tab.content while the live copy still holds
          // the pristine text is folded straight back to pristine, and the
          // scenario measures a clean tab it believed was dirty. Background
          // tabs are never snapshotted, which is why they need no such step.
          if (index === active) {
            window.originalMarkdown = tab.content;
            window.CustomTabs.switchToTab(tab.id);
          }
        });
        const activeTab = window.CustomTabs.getActiveTab();
        window.originalMarkdown = activeTab ? activeTab.content : "";
      };
      // THE MEASUREMENT WINDOW HAS TO CONTAIN THE WORK IT CLAIMS TO MEASURE,
      // and this is where that went wrong. The dirty answer is now MAINTAINED
      // at the moment the text changes rather than recomputed on shutdown, so
      // wrapping the spies around the shutdown handler measures an empty
      // window: it reported zero scans whatever sameDocument did, which made
      // "finds a one-character edit" unfalsifiable and left R567 reporting
      // WRONG-GUARD because removing the CR-free fast path broke nothing this
      // could see. measure() puts the window around an arbitrary operation, so
      // the assignment assertions below watch the ASSIGNMENT and the shutdown
      // assertions watch the SHUTDOWN - and both mean what they say.
      const measure = (name, run) => {
        let indexOfCalls = 0;
        let replaceCalls = 0;
        let scannedBytes = 0;
        String.prototype.indexOf = function () {
          indexOfCalls += 1;
          scannedBytes += String(this).length;
          return originalIndexOf.apply(this, arguments);
        };
        String.prototype.replace = function () {
          replaceCalls += 1;
          scannedBytes += String(this).length;
          return originalReplace.apply(this, arguments);
        };
        let result;
        try {
          result = run();
        } finally {
          String.prototype.indexOf = originalIndexOf;
          String.prototype.replace = originalReplace;
        }
        observations[name] = { indexOfCalls, replaceCalls, scannedBytes, result };
        return observations[name];
      };
      // A measured mutation. Assigning tab.content is an accessor assignment,
      // and the comparison it performs is the thing under test.
      const assign = (name, tab, property, value) => {
        const measured = measure(name, () => {
          tab[property] = value;
          return window.CustomTabs.__documentState(tab);
        });
        measured.dirty = measured.result.dirty;
        measured.maintained = measured.result.maintained;
        return measured;
      };
      const ask = (name) => {
        response = null;
        const measured = measure(name, () => {
          handler({}, { id: nextId++, reason: "window-close", gen: generation });
          return null;
        });
        measured.dirty = response && response.dirtyFiles;
        observations[name] = measured;
        return measured;
      };
      ipc.send = function (channel, payload) {
        if (channel === "quit-approval-response") {
          response = payload;
          return;
        }
        return originalSend.apply(this, arguments);
      };
      try {
        // ECMAScript strings are primitives: separately constructed equal
        // strings still compare === by value. The two independent joins below
        // are the strongest possible live construction oracle; the edited
        // case proves the direct CR-free branch executes.
        //
        // MEASURED AT THE ASSIGNMENT. That is where sameDocument now runs - the
        // dirty answer is maintained, not recomputed - so a scan counted here
        // is a scan the product really performed for this edit.
        const equalLeft = Array.from({ length: 32 }, () => "equal-LF-").join("");
        const equalRight = Array.from({ length: 32 }, () => "equal-LF-").join("");
        prepare([{ original: equalLeft, content: equalLeft }]);
        const equal = assign(
          "equalDistinctConstruction",
          window.CustomTabs.getTabs()[0],
          "content",
          equalRight,
        );
        const equalAsk = ask("equalDistinctConstructionAsk");
        const oneCharacter = equalRight.slice(0, -1) + "X";
        prepare([{ original: equalLeft, content: equalLeft }]);
        const oneChar = assign(
          "oneCharacter",
          window.CustomTabs.getTabs()[0],
          "content",
          oneCharacter,
        );
        const oneCharAsk = ask("oneCharacterAsk");

        // The active tab is snapshotted on every ask. Keep the witness in a
        // background tab so a direct assignment cannot be overwritten by that
        // unrelated active-tab snapshot before isDirty() sees it.
        prepare([
          { original: "memo-active", content: "memo-active" },
          { original: "memo-final!", content: "memo-final!" },
        ]);
        const memoClean = ask("memoClean");
        const memoTab = window.CustomTabs.getTabs()[1];
        memoTab.content = "memo-final?";
        const memoDirty = ask("memoDirty");
        memoTab.content = memoTab.originalContent;
        const memoRestored = ask("memoRestored");

        // Newline normalisation, measured where it happens: assigning a CRLF
        // document an LF-equivalent value must recognise it as the same
        // document, and must do so by normalising rather than by comparing.
        prepare([
          { original: "crlf-active", content: "crlf-active" },
          { original: "A\\r\\nB\\r\\n", content: "A\\r\\nB\\r\\n" },
        ]);
        const crlfToLf = assign(
          "crlfToLf",
          window.CustomTabs.getTabs()[1],
          "content",
          "A\\r\\nB\\n",
        );
        const crlfToLfAsk = ask("crlfToLfAsk");
        const crlfMemoHit = ask("crlfMemoHit");
        const crlfMemoEdit = assign(
          "crlfMemoEdit",
          window.CustomTabs.getTabs()[1],
          "content",
          "A\\nBX\\n",
        );
        prepare([
          { original: "crlf-active", content: "crlf-active" },
          { original: "A\\nB\\n", content: "A\\nB\\n" },
        ]);
        const lfToCrlf = assign(
          "lfToCrlf",
          window.CustomTabs.getTabs()[1],
          "content",
          "A\\r\\nB\\r\\n",
        );
        prepare([
          { original: "crlf-active", content: "crlf-active" },
          { original: "A\\r\\nB\\r\\n", content: "A\\r\\nB\\r\\n" },
        ]);
        const crlfEdit = assign(
          "crlfEdit",
          window.CustomTabs.getTabs()[1],
          "content",
          "A\\nBX\\n",
        );

        prepare([{ original: "same-length", content: "same-length" }]);
        const sameLength = assign(
          "sameLength",
          window.CustomTabs.getTabs()[0],
          "content",
          "same-lengTh",
        );
        prepare([{ original: "final-byte!", content: "final-byte!" }]);
        const finalByte = assign(
          "finalByte",
          window.CustomTabs.getTabs()[0],
          "content",
          "final-byte?",
        );

        prepare([
          { original: "alternate-active", content: "alternate-active" },
          { original: "alternate", content: "alternate" },
        ]);
        const alternateClean1 = ask("alternateClean1");
        const alternateTab = window.CustomTabs.getTabs()[1];
        alternateTab.content = "alternatE";
        const alternateDirty1 = ask("alternateDirty1");
        alternateTab.content = alternateTab.originalContent;
        const alternateClean2 = ask("alternateClean2");
        alternateTab.content = "alternat?";
        const alternateDirty2 = ask("alternateDirty2");

        prepare([
          { original: "twins", content: "twins" },
          { original: "twins", content: "twins" },
        ]);
        window.CustomTabs.getTabs()[1].content = "twin?";
        const oneOfTwo = ask("oneOfTwo");

        const large = "background-large-".repeat(Math.ceil((2 * 1024 * 1024) / 17)).slice(0, 2 * 1024 * 1024);
        prepare([
          { original: "active-clean", content: "active-clean" },
          { original: large, content: large.slice(0, -1) + "X", flag: false },
        ]);
        const background = ask("largeBackground");

        // THE SHUTDOWN SCAN READS NOTHING. This is the whole point of the
        // maintained dirty answer, and it is an assertion about work NOT done,
        // so nothing observable in the reply can carry it: the same filenames
        // come back either way. Eight background tabs of 2 MB, every one of
        // them freshly edited through the real assignment path, and the close
        // that follows must touch none of their bytes. Measured before this
        // architecture: raw p95 22.49 ms (LF) and 98.19 ms (CRLF) at 25 x 2 MB
        // against a 16.7 ms budget.
        const bulkEntries = [{ original: "bulk-active", content: "bulk-active" }];
        for (let index = 0; index < 8; index += 1) {
          bulkEntries.push({ original: large, content: large });
        }
        prepare(bulkEntries);
        const bulkTabs = window.CustomTabs.getTabs();
        for (let index = 1; index < bulkTabs.length; index += 1) {
          bulkTabs[index].content =
            large.slice(0, -1) + String.fromCharCode(65 + index);
        }
        const bulkScan = ask("bulkScan");
        const bulkStates = bulkTabs.map((tab) =>
          window.CustomTabs.__documentState(tab),
        );

        prepare([{ original: "save-base", content: "save-baseX" }]);
        const beforeSave = ask("beforeSave");
        window.CustomTabs.updateTabContent("save-baseX", false);
        window.originalMarkdown = "save-baseX";
        const afterSave = ask("afterSave");
        window.CustomTabs.updateTabContent("reload-base", false);
        window.originalMarkdown = "reload-base";
        const afterReload = ask("afterReload");
        window.CustomTabs.updateTabContent("reload-baseX", true);
        window.originalMarkdown = "reload-baseX";
        const editedDuringReload = ask("editedDuringReload");

        prepare([{ original: "snapshot-base", content: "snapshot-base" }]);
        window.CustomTabs.getActiveTab().anchor = { headingText: "shutdown-anchor", occurrence: 0 };
        window.originalMarkdown = "snapshot-baseX";
        const snapshot = ask("snapshot");
        const shutdownAnchor = window.CustomTabs.getActiveTab().anchor;
        // EDIT MODE IS THE split-view CLASS, and the editor is BORROWED, not
        // discarded. Two defects lived in these four lines. The first was
        // \`window.isEditMode\`, which nothing reads - renderer.js keeps a
        // module-scoped variable and the overlay reads the DOM - so both
        // observations below were taken in VIEW mode and neither measured the
        // branch it names. The second was worse: the unreadable case nulled
        // \`window.markdownEditor\` and never put it back, so the very next
        // block dereferenced null, the injected script threw inside
        // executeJavaScript, and the harness lost every assertion after it.
        const editorWrapper = document.querySelector(".content-wrapper");
        const savedEditor = window.markdownEditor;
        editorWrapper.classList.add("split-view");
        // The legacy flag is set TOO, deliberately. These two observations are
        // about the unreadable-editor guard, not about which source of truth
        // edit mode has - and R609 reverts inEditMode() to the flag while
        // requiring the unreadable guard to keep holding. Setting both leaves
        // this fixture in edit mode under either implementation, so that record
        // measures the thing it names instead of collapsing here.
        window.isEditMode = true;
        const textareaModeEntered = window.CustomTabs.__inEditMode();
        window.markdownEditor.value = "snapshot-baseY";
        const textareaSnapshot = ask("textareaSnapshot");

        window.markdownEditor = null;
        const unreadableModeEntered = window.CustomTabs.__inEditMode();
        const unreadableEditorAbsent = !window.markdownEditor;
        const unreadable = ask("unreadable");
        // RESTORED IMMEDIATELY, AND WITNESSED. Everything below this line
        // dereferences the editor; a borrow that is not returned does not fail
        // an assertion, it deletes the rest of the suite. The flag goes back
        // too: the block below exists to prove the DOM decides, and a flag left
        // standing would make its "view mode" leg say "edit".
        window.markdownEditor = savedEditor;
        editorWrapper.classList.remove("split-view");
        window.isEditMode = false;
        const editorRestored = !!window.markdownEditor;
        const modeRestored = window.CustomTabs.__inEditMode();

        // THE MODE IS READ FROM THE DOM, NOT FROM A REMEMBERED FLAG. The shadow
        // copy this replaced was refreshed 10 ms after the edit button was
        // clicked, while leaving edit mode can await an in-flight save for five
        // seconds - so the flag said "edit" while the window was in view mode,
        // and the fold read a hidden textarea instead of the live document.
        // Driven through the real class renderer.js toggles.
        const wrapper = document.querySelector(".content-wrapper");
        prepare([{ original: "mode-base", content: "mode-base" }]);
        const modeBeforeEnter = window.CustomTabs.__inEditMode();
        wrapper.classList.add("split-view");
        const modeAfterEnter = window.CustomTabs.__inEditMode();
        window.markdownEditor.value = "mode-base-TYPED";
        const editorEdit = ask("editorEdit");
        // Leaving edit mode is the case the timer got wrong: the class goes
        // first, and a stale flag would keep the fold reading the textarea.
        wrapper.classList.remove("split-view");
        const modeAfterExit = window.CustomTabs.__inEditMode();
        window.markdownEditor.value = "mode-base-STALE-TEXTAREA";
        window.originalMarkdown = "mode-base-VIEW-EDIT";
        const viewEditAfterExit = ask("viewEditAfterExit");
        const contentAfterExit = window.CustomTabs.getActiveTab().content;

        // AN UNDONE VIEW-MODE EDIT MUST NOT SURVIVE IN THE CACHE. The active
        // document's live text lives in window.originalMarkdown, and the
        // shutdown snapshot folds it back into the tab. Folding it only when it
        // differs from the ON-DISK text means the fold is skipped exactly when
        // the reader has put the document back the way it was - so the tab goes
        // on holding the abandoned edit, reports itself dirty about text nobody
        // wants, and hands that text to the next switchToTab and to save.
        prepare([{ original: "resurrect-base", content: "resurrect-base" }]);
        window.originalMarkdown = "resurrect-base-EDITED";
        const resurrectEdited = ask("resurrectEdited");
        const cachedAfterEdit = window.CustomTabs.getActiveTab().content;
        window.originalMarkdown = "resurrect-base";
        const resurrectUndone = ask("resurrectUndone");
        const cachedAfterUndo = window.CustomTabs.getActiveTab().content;

        // The same sequence on a CRLF document, which is the reason the
        // comparison was written against the on-disk copy in the first place.
        // The undo has to restore the file's OWN bytes - not the renderer's
        // LF-normalised view of them - so the tab is clean AND unmodified.
        prepare([{ original: "A\\r\\nB\\r\\n", content: "A\\r\\nB\\r\\n" }]);
        window.originalMarkdown = "A\\nBX\\n";
        const crlfResurrectEdited = ask("crlfResurrectEdited");
        const crlfCachedAfterEdit = window.CustomTabs.getActiveTab().content;
        window.originalMarkdown = "A\\nB\\n";
        const crlfResurrectUndone = ask("crlfResurrectUndone");
        const crlfCachedAfterUndo = window.CustomTabs.getActiveTab().content;

        // THE REPLAY CACHE IS BOUNDED. Fifty cancelled shutdowns are fifty
        // answers this document was asked for, and every one of them used to be
        // retained - with its filename list - for the life of the renderer, to
        // serve a duplicate that by construction can only ever name the newest
        // id. Driven through the real handler rather than inspected, so the
        // duplicate semantics are proven at the same time: the newest id still
        // replays its exact recorded answer, and the one below it is refused as
        // stale rather than recomputed against a document that has moved on.
        prepare([{ original: "replay-base", content: "replay-base" }]);
        for (let fill = 0; fill < 50; fill += 1) {
          response = null;
          handler({}, { id: nextId++, reason: "window-close", gen: generation });
        }
        const replayCache = window.CustomTabs.__shutdownReplayCache();
        const newestId = nextId - 1;
        response = null;
        handler({}, { id: newestId, reason: "window-close", gen: generation });
        const duplicateReplay = response;
        response = null;
        handler({}, { id: newestId - 1, reason: "window-close", gen: generation });
        const staleDuplicate = response;

        clear();
        return {
          equalValues: equalLeft === equalRight,
          equal,
          equalAsk,
          oneChar,
          oneCharAsk,
          memoClean,
          memoDirty,
          memoRestored,
          crlfToLf,
          crlfToLfAsk,
          crlfMemoHit,
          crlfMemoEdit,
          lfToCrlf,
          crlfEdit,
          sameLength,
          finalByte,
          alternateClean1,
          alternateDirty1,
          alternateClean2,
          alternateDirty2,
          oneOfTwo,
          background,
          bulkScan,
          bulkStates,
          bulkTabCount: bulkEntries.length,
          largeBytes: large.length,
          beforeSave,
          afterSave,
          afterReload,
          editedDuringReload,
          snapshot,
          shutdownAnchor,
          textareaModeEntered,
          textareaSnapshot,
          unreadableModeEntered,
          unreadableEditorAbsent,
          unreadable,
          editorRestored,
          modeRestored,
          resurrectEdited,
          cachedAfterEdit,
          resurrectUndone,
          cachedAfterUndo,
          crlfResurrectEdited,
          crlfCachedAfterEdit,
          crlfResurrectUndone,
          crlfCachedAfterUndo,
          replayCache,
          newestId,
          duplicateReplay,
          staleDuplicate,
          modeBeforeEnter,
          modeAfterEnter,
          modeAfterExit,
          editorEdit,
          viewEditAfterExit,
          contentAfterExit,
        };
      } finally {
        ipc.send = originalSend;
        String.prototype.indexOf = originalIndexOf;
        String.prototype.replace = originalReplace;
        window.isEditMode = false;
      }
    })()
  `);
  const clean = (record) => Array.isArray(record && record.dirty) && record.dirty.length === 0;
  const dirty = (record) => Array.isArray(record && record.dirty) && record.dirty.length > 0;
  check(
    "sameDocument treats independently constructed equal LF content as clean, then finds a one-character edit",
    semantic.equalValues === true &&
      semantic.equal.dirty === false &&
      semantic.oneChar.dirty === true &&
      clean(semantic.equalAsk) &&
      dirty(semantic.oneCharAsk) &&
      // Equal by value: the identity check answers without reading a byte.
      semantic.equal.indexOfCalls === 0 && semantic.equal.replaceCalls === 0 &&
      // A one-character edit has to reach the CR-free direct path, which is
      // two indexOf scans and no normalisation.
      semantic.oneChar.indexOfCalls >= 2 && semantic.oneChar.replaceCalls === 0,
    JSON.stringify({
      equalValues: semantic.equalValues,
      equal: semantic.equal,
      equalAsk: semantic.equalAsk,
      oneChar: semantic.oneChar,
      oneCharAsk: semantic.oneCharAsk,
    }),
  );
  check(
    "the maintained dirty state follows direct assignments and returns clean after the original value is restored",
    clean(semantic.memoClean) && dirty(semantic.memoDirty) && clean(semantic.memoRestored) &&
      semantic.crlfMemoEdit.dirty === true &&
      // The shutdown scan reads no bytes in ANY of the three states: the
      // answers were settled by the assignments that produced them.
      semantic.memoDirty.indexOfCalls === 0 && semantic.memoDirty.replaceCalls === 0 &&
      semantic.memoRestored.indexOfCalls === 0 && semantic.memoRestored.replaceCalls === 0,
    JSON.stringify({
      memoClean: semantic.memoClean,
      memoDirty: semantic.memoDirty,
      memoRestored: semantic.memoRestored,
      crlfMemoEdit: semantic.crlfMemoEdit,
    }),
  );
  check(
    "sameDocument normalizes CRLF and LF in both directions but preserves a real edit",
    semantic.crlfToLf.dirty === false &&
      semantic.lfToCrlf.dirty === false &&
      semantic.crlfEdit.dirty === true &&
      clean(semantic.crlfToLfAsk) && clean(semantic.crlfMemoHit) &&
      semantic.crlfToLf.replaceCalls >= 2 &&
      semantic.lfToCrlf.replaceCalls >= 2 &&
      // The settled answer is re-read, not recomputed.
      semantic.crlfMemoHit.replaceCalls === 0 && semantic.crlfMemoHit.indexOfCalls === 0,
    JSON.stringify({
      crlfToLf: semantic.crlfToLf,
      crlfToLfAsk: semantic.crlfToLfAsk,
      crlfMemoHit: semantic.crlfMemoHit,
      lfToCrlf: semantic.lfToCrlf,
      crlfEdit: semantic.crlfEdit,
    }),
  );
  check(
    "the maintained state follows clean-dirty-clean-dirty alternation and isolates equal-valued tabs",
    clean(semantic.alternateClean1) && dirty(semantic.alternateDirty1) &&
      clean(semantic.alternateClean2) && dirty(semantic.alternateDirty2) &&
      dirty(semantic.oneOfTwo) && semantic.oneOfTwo.dirty.length === 1,
    JSON.stringify(semantic),
  );
  check(
    "sameDocument detects same-length and final-byte edits through the direct path",
    semantic.sameLength.dirty === true && semantic.finalByte.dirty === true &&
      semantic.sameLength.indexOfCalls >= 2 && semantic.finalByte.indexOfCalls >= 2 &&
      semantic.sameLength.replaceCalls === 0 && semantic.finalByte.replaceCalls === 0,
    JSON.stringify({ sameLength: semantic.sameLength, finalByte: semantic.finalByte }),
  );
  check(
    "a 2MB dirty background tab is found while its active tab is clean despite a false dirty flag",
    dirty(semantic.background) && semantic.background.dirty.length === 1 &&
      semantic.background.dirty[0].includes("semantic-") &&
    semantic.background.indexOfCalls === 0 && semantic.background.replaceCalls === 0,
    JSON.stringify(semantic.background),
  );
  check(
    "the shutdown scan reads no document bytes for tabs whose text has not moved since it was set",
    dirty(semantic.bulkScan) &&
      semantic.bulkScan.dirty.length === semantic.bulkTabCount - 1 &&
      semantic.largeBytes === 2 * 1024 * 1024 &&
      semantic.bulkScan.indexOfCalls === 0 &&
      semantic.bulkScan.replaceCalls === 0 &&
      semantic.bulkScan.scannedBytes === 0 &&
      Array.isArray(semantic.bulkStates) &&
      semantic.bulkStates.every((state) => state && state.maintained === true) &&
      semantic.bulkStates[0].dirty === false &&
      semantic.bulkStates.slice(1).every((state) => state.dirty === true),
    JSON.stringify({
      dirtyCount: semantic.bulkScan && semantic.bulkScan.dirty && semantic.bulkScan.dirty.length,
      expected: semantic.bulkTabCount - 1,
      largeBytes: semantic.largeBytes,
      indexOfCalls: semantic.bulkScan && semantic.bulkScan.indexOfCalls,
      replaceCalls: semantic.bulkScan && semantic.bulkScan.replaceCalls,
      scannedBytes: semantic.bulkScan && semantic.bulkScan.scannedBytes,
      states: semantic.bulkStates,
    }),
  );
  check(
    "dirty save and reload become clean while a reload-time edit remains dirty",
    dirty(semantic.beforeSave) && clean(semantic.afterSave) && clean(semantic.afterReload) &&
      dirty(semantic.editedDuringReload),
    JSON.stringify(semantic),
  );
  check(
    "the active view state is snapshotted before the all-tab scan",
    dirty(semantic.snapshot) && dirty(semantic.textareaSnapshot),
    JSON.stringify({ snapshot: semantic.snapshot, textarea: semantic.textareaSnapshot }),
  );
  // THE SETUP CONTROL FOR THE TWO EDIT-MODE OBSERVATIONS ABOVE AND EVERY
  // OBSERVATION BELOW. Both cases used to be entered with a flag nothing reads,
  // so they measured view mode while claiming to measure the editor; and the
  // unreadable case borrowed `window.markdownEditor` and never returned it, so
  // the next block dereferenced null, the injected script threw, and the
  // harness reported one failure in place of the twenty assertions that never
  // ran. Neither can happen silently again.
  check(
    "the editor-mode fixtures really enter edit mode and give the editor back",
    semantic.textareaModeEntered === true &&
      semantic.unreadableModeEntered === true &&
      semantic.unreadableEditorAbsent === true &&
      semantic.editorRestored === true &&
      semantic.modeRestored === false,
    JSON.stringify({
      textareaModeEntered: semantic.textareaModeEntered,
      unreadableModeEntered: semantic.unreadableModeEntered,
      unreadableEditorAbsent: semantic.unreadableEditorAbsent,
      editorRestored: semantic.editorRestored,
      modeRestored: semantic.modeRestored,
    }),
  );
  check(
    "a shutdown snapshot folds content without replacing its saved reading anchor",
    semantic.shutdownAnchor && semantic.shutdownAnchor.headingText === "shutdown-anchor",
    JSON.stringify(semantic.shutdownAnchor),
  );
  check(
    "an unreadable active editor preserves dirtyFiles:null rather than approving",
    semantic.unreadable && semantic.unreadable.dirty === null,
    JSON.stringify(semantic.unreadable),
  );
  check(
    "an undone view-mode edit leaves the cached document clean rather than resurrecting the edit",
    dirty(semantic.resurrectEdited) &&
      semantic.cachedAfterEdit === "resurrect-base-EDITED" &&
      clean(semantic.resurrectUndone) &&
      semantic.cachedAfterUndo === "resurrect-base",
    JSON.stringify({
      edited: semantic.resurrectEdited,
      cachedAfterEdit: semantic.cachedAfterEdit,
      undone: semantic.resurrectUndone,
      cachedAfterUndo: semantic.cachedAfterUndo,
    }),
  );
  check(
    "an undone CRLF view-mode edit restores the file's own line endings and reports clean",
    dirty(semantic.crlfResurrectEdited) &&
      semantic.crlfCachedAfterEdit === "A\nBX\n" &&
      clean(semantic.crlfResurrectUndone) &&
      semantic.crlfCachedAfterUndo === "A\r\nB\r\n",
    JSON.stringify({
      edited: semantic.crlfResurrectEdited,
      cachedAfterEdit: semantic.crlfCachedAfterEdit,
      undone: semantic.crlfResurrectUndone,
      cachedAfterUndo: semantic.crlfCachedAfterUndo,
    }),
  );
  check(
    "fifty cancelled shutdowns retain one replayable answer, and only the newest id replays",
    semantic.replayCache &&
      semantic.replayCache.retained === 1 &&
      semantic.replayCache.id === semantic.newestId &&
      semantic.replayCache.highestRequestId === semantic.newestId &&
      semantic.duplicateReplay &&
      semantic.duplicateReplay.id === semantic.newestId &&
      Array.isArray(semantic.duplicateReplay.dirtyFiles) &&
      semantic.staleDuplicate === null,
    JSON.stringify({
      replayCache: semantic.replayCache,
      newestId: semantic.newestId,
      duplicateReplay: semantic.duplicateReplay,
      staleDuplicate: semantic.staleDuplicate,
    }),
  );
  check(
    "edit mode is read from the live DOM, so a view-mode edit after a delayed exit is not missed",
    semantic.modeBeforeEnter === false &&
      semantic.modeAfterEnter === true &&
      semantic.modeAfterExit === false &&
      // In edit mode the textarea is the live document and its edit is found.
      dirty(semantic.editorEdit) &&
      // After the exit the textarea is stale scenery: the fold must read the
      // view-mode live copy, and the tab must end up holding THAT text.
      dirty(semantic.viewEditAfterExit) &&
      semantic.contentAfterExit === "mode-base-VIEW-EDIT",
    JSON.stringify({
      modeBeforeEnter: semantic.modeBeforeEnter,
      modeAfterEnter: semantic.modeAfterEnter,
      modeAfterExit: semantic.modeAfterExit,
      editorEdit: semantic.editorEdit,
      viewEditAfterExit: semantic.viewEditAfterExit,
      contentAfterExit: semantic.contentAfterExit,
    }),
  );
  // Direct listener calls advance its stale-request watermark. Reload before
  // later lifecycle scenarios so they retain their independent positive path.
  win.webContents.reload();
  await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
}

async function runCommitDeadlineAndContinuationScenarios(win, exec) {
  const wc = win.webContents;
  const rig = shutdownRig(win);
  const indexFile = path.join(__dirname, "..", "src", "index.html");
  // A genuine renderer crash can leave Chromium's asynchronous unresponsive
  // notification queued across the replacement load. These cases own the
  // commit deadline, so isolate that unrelated fallback route.
  const unresponsiveHandlers = win.listeners("unresponsive");
  win.removeAllListeners("unresponsive");
  const cleanDocument = () =>
    exec(`
      (() => {
        const confirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().forEach(t => {
            t.content = t.originalContent;
            t.hasUnsavedChanges = false;
          });
        } finally {
          window.confirm = confirm;
        }
        const tab = window.CustomTabs.getActiveTab();
        window.originalMarkdown = tab ? tab.originalContent : "";
        return !!tab;
      })()
    `);
  const waitForHeldCommit = async () => {
    let held = null;
    const realSend = wc.send;
    const restoreSend = replaceMethod(wc, "send", function (channel, payload) {
      if (channel === "quit-approval-commit" && held === null) {
        held = payload;
        return;
      }
      return realSend.call(this, channel, payload);
    });
    const close = guardEvent();
    win.emit("close", close);
    const heldReady = await waitUntil(
      () => held !== null && __shutdown.state().commitPendingId === held.id,
      10000,
    );
    restoreSend();
    return { close, held, heldReady };
  };
  const armSyntheticDeadline = async () => {
    const realSetTimeout = global.setTimeout;
    let deadlineCallback = null;
    global.setTimeout = (callback, delay, ...args) => {
      if (
        delay === 5000 &&
        deadlineCallback === null &&
        String(callback).includes("staleShutdownCommitTimeoutCount")
      ) {
        deadlineCallback = () => callback(...args);
        return { unref() {} };
      }
      return realSetTimeout(callback, delay, ...args);
    };
    try {
      const armed = await waitForHeldCommit();
      return { ...armed, deadlineCallback };
    } finally {
      global.setTimeout = realSetTimeout;
    }
  };

  try {
    // A renderer answer has committed the exact revision, but its
    // setImmediate continuation has not run yet. Losing that renderer in the
    // synchronous tail of the reply must invalidate the queued authorization,
    // thaw, and ask again through the fallback.
    __shutdown.reset();
    rig.reset();
    await cleanDocument();
    let confirmedReply = null;
    let holdFallback;
    rig.answer = () =>
      new Promise((resolve) => {
        holdFallback = resolve;
      });
    const loseAfterCommit = (_event, data) => {
      if (!data || data.committed !== true || confirmedReply) return;
      confirmedReply = data;
      wc.emit("render-process-gone", {}, { reason: "controlled post-commit loss" });
    };
    ipcMain.on("quit-approval-committed", loseAfterCommit);
    const lossClose = guardEvent();
    try {
      win.emit("close", lossClose);
      await waitUntil(
        () =>
          rig.dialogs.length === 1 &&
          __shutdown.state().rendererInvalidatedContinuationCount === 1,
        10000,
      );
    } finally {
      ipcMain.removeListener("quit-approval-committed", loseAfterCommit);
    }
    const lossState = __shutdown.state();
    const thawedAfterLoss = await exec(`window.CustomTabs.__shutdownFreeze()`);
    check(
      "a renderer-confirmed commit lost before its deferred continuation re-requests fail-closed and thaws",
      !!confirmedReply &&
        lossClose.prevented === true &&
        lossState.renderer === "unusable" &&
        lossState.rendererInvalidatedContinuationCount === 1 &&
        lossState.authorized === false &&
        rig.closes === 0 &&
        rig.quits === 0 &&
        rig.dialogs.length === 1 &&
        rig.dialogs[0].pendingReason === "window-close" &&
        /cannot be checked/i.test(String(rig.dialogs[0].options.title)) &&
        thawedAfterLoss.frozen === false &&
        thawedAfterLoss.editorReadOnly === false,
      JSON.stringify({
        confirmedReply,
        prevented: lossClose.prevented,
        state: lossState,
        thawedAfterLoss,
        dialogs: rig.dialogs,
        closes: rig.closes,
        quits: rig.quits,
      }),
    );
    if (holdFallback) holdFallback(1);

    // Once the continuation is actually running, renderer loss is too late to
    // revoke it. The close is the witness: it is invoked exactly once while
    // the loss notification is delivered from inside that continuation.
    await win.loadFile(indexFile);
    await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
    __shutdown.reset();
    rig.reset();
    await cleanDocument();
    const rigClose = Object.getOwnPropertyDescriptor(win, "close");
    let lossDuringRunningContinuation = 0;
    Object.defineProperty(win, "close", {
      value: () => {
        rig.closes += 1;
        lossDuringRunningContinuation += 1;
        wc.emit("render-process-gone", {}, { reason: "controlled running-continuation loss" });
      },
      configurable: true,
      writable: true,
    });
    const runningClose = guardEvent();
    try {
      win.emit("close", runningClose);
      await waitUntil(() => rig.closes === 1, 10000);
    } finally {
      if (rigClose) Object.defineProperty(win, "close", rigClose);
      else delete win.close;
    }
    const runningState = __shutdown.state();
    check(
      "renderer loss after a clean shutdown continuation has started does not revoke that shutdown",
      runningClose.prevented === true &&
        lossDuringRunningContinuation === 1 &&
        rig.closes === 1 &&
        rig.dialogs.length === 0 &&
        runningState.rendererInvalidatedContinuationCount === 0 &&
        runningState.pendingId === 0,
      JSON.stringify({
        prevented: runningClose.prevented,
        lossDuringRunningContinuation,
        closes: rig.closes,
        dialogs: rig.dialogs,
        state: runningState,
      }),
    );

    // The real five-second deadline. Suppress the first phase-two IPC reply,
    // then require the timeout to name the exact attempt it froze, thaw it,
    // and move a fresh request to the fallback. A late reply to the expired
    // id must be counted and must not settle that fresh request.
    await win.loadFile(indexFile);
    await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
    __shutdown.reset();
    rig.reset();
    await cleanDocument();
    let releaseTimeoutFallback;
    rig.answer = () =>
      new Promise((resolve) => {
        releaseTimeoutFallback = resolve;
      });
    const timeoutApprovalRequests = [];
    const realTimeoutSend = wc.send;
    const restoreTimeoutSend = replaceMethod(wc, "send", function (channel, ...args) {
      if (channel === "quit-approval-request") timeoutApprovalRequests.push(args[0]);
      return realTimeoutSend.call(this, channel, ...args);
    });
    const timeoutAttempt = await waitForHeldCommit();
    const timeoutBefore = __shutdown.state();
    const timeoutArmed =
      timeoutAttempt.heldReady &&
      timeoutAttempt.held &&
      timeoutBefore.commitPendingId === timeoutAttempt.held.id &&
      timeoutBefore.commitSequence > 0 &&
      timeoutBefore.commitAuthorisedSeq === timeoutBefore.lastRequestId &&
      timeoutAttempt.held.gen === timeoutBefore.rendererGeneration;
    const timeoutFallback = await waitUntil(
      () =>
        rig.dialogs.length === 1 &&
        __shutdown.state().commitTimeoutCount === 1 &&
        __shutdown.state().commitRefusedWhy === "commit-timeout",
      8000,
    );
    const timeoutState = __shutdown.state();
    const thawedAfterTimeout = await exec(`window.CustomTabs.__shutdownFreeze()`);
    const staleRepliesBefore = timeoutState.staleCommitCount;
    if (timeoutAttempt.held) {
      await exec(`
        window.ipcRenderer.send("quit-approval-committed", {
          id: ${timeoutAttempt.held.id},
          gen: ${timeoutAttempt.held.gen},
          revision: ${timeoutAttempt.held.revision},
          committed: true,
        });
        null;
      `);
    }
    const lateReplyRejected = await waitUntil(
      () => __shutdown.state().staleCommitCount === staleRepliesBefore + 1,
      3000,
    );
    const afterLateReply = __shutdown.state();
    check(
      "the five-second commit deadline guards exact identity, generation, and sequence; thaws, falls back, and rejects its late reply",
      timeoutArmed &&
        timeoutFallback &&
        timeoutAttempt.close.prevented === true &&
        timeoutState.pendingId > timeoutAttempt.held.id &&
        timeoutState.commitPendingId === 0 &&
        timeoutState.commitTimeoutCount === 1 &&
        timeoutState.commitRefusedCount === 1 &&
        timeoutState.authorized === false &&
        // The timed-out request falls back to the native prompt; it must not
        // send a second renderer question that can produce a duplicate prompt.
        timeoutApprovalRequests.length === 1 &&
        thawedAfterTimeout.frozen === false &&
        thawedAfterTimeout.editorReadOnly === false &&
        lateReplyRejected &&
        afterLateReply.pendingId === timeoutState.pendingId &&
        afterLateReply.authorized === false &&
        rig.closes === 0,
      JSON.stringify({
        timeoutAttempt,
        timeoutBefore,
        timeoutArmed,
        timeoutFallback,
        timeoutState,
        thawedAfterTimeout,
        staleRepliesBefore,
        lateReplyRejected,
        afterLateReply,
        dialogs: rig.dialogs,
        rendererApprovalRequests: timeoutApprovalRequests.map((request) => request && request.id),
      }),
    );
    if (releaseTimeoutFallback) releaseTimeoutFallback(1);
    restoreTimeoutSend();

    await runF22CommitSendThrowScenario(win, exec);

    // clearTimeout cannot retract a callback already dequeued by the event
    // loop. Drive the captured callbacks after three real invalidations; each
    // must count stale and leave the later request/continuation untouched.
    __shutdown.reset();
    rig.reset();
    await cleanDocument();
    const replied = await armSyntheticDeadline();
    if (replied.held) {
      await exec(`
        window.ipcRenderer.send("quit-approval-committed", {
          id: ${replied.held.id}, gen: ${replied.held.gen},
          revision: ${replied.held.revision}, committed: true,
        }); null;
      `);
    }
    const replyFinished = await waitUntil(() => rig.closes === 1, 5000);
    const staleAfterReplyBefore = __shutdown.state().staleCommitTimeoutCount;
    if (replied.deadlineCallback) replied.deadlineCallback();
    const staleAfterReply = await waitUntil(
      () => __shutdown.state().staleCommitTimeoutCount === staleAfterReplyBefore + 1,
      3000,
    );

    __shutdown.reset();
    rig.reset();
    await cleanDocument();
    const navigated = await armSyntheticDeadline();
    const navigationStartId = __shutdown.state().lastRequestId;
    wc.reload();
    const navigationReplaced = await waitUntil(
      () =>
        __shutdown.state().renderer === "ready" &&
        __shutdown.state().lastRequestId > navigationStartId,
      20000,
    );
    const staleAfterNavigationBefore = __shutdown.state().staleCommitTimeoutCount;
    if (navigated.deadlineCallback) navigated.deadlineCallback();
    const staleAfterNavigation = await waitUntil(
      () =>
        __shutdown.state().staleCommitTimeoutCount ===
        staleAfterNavigationBefore + 1,
      3000,
    );

    __shutdown.reset();
    rig.reset();
    await cleanDocument();
    const superseded = await armSyntheticDeadline();
    const supersededStartId = __shutdown.state().lastRequestId;
    const newerClose = guardEvent();
    win.emit("close", newerClose);
    const newIntentReplaced = await waitUntil(
      () => __shutdown.state().lastRequestId > supersededStartId,
      5000,
    );
    const staleAfterIntentBefore = __shutdown.state().staleCommitTimeoutCount;
    if (superseded.deadlineCallback) superseded.deadlineCallback();
    const staleAfterIntent = await waitUntil(
      () =>
        __shutdown.state().staleCommitTimeoutCount === staleAfterIntentBefore + 1,
      3000,
    );
    const staleTimerState = __shutdown.state();
    check(
      "stale commit deadlines after reply, navigation, and a newer intent cannot affect later shutdown work",
      replied.heldReady &&
        typeof replied.deadlineCallback === "function" &&
        replyFinished &&
        staleAfterReply &&
        navigated.heldReady &&
        typeof navigated.deadlineCallback === "function" &&
        navigationReplaced &&
        staleAfterNavigation &&
        superseded.heldReady &&
        typeof superseded.deadlineCallback === "function" &&
        newerClose.prevented === true &&
        newIntentReplaced &&
        staleAfterIntent &&
        staleTimerState.commitTimeoutCount === 0 &&
        staleTimerState.authorized === false,
      JSON.stringify({
        replied: { held: replied.held, replyFinished, staleAfterReply },
        navigated: { held: navigated.held, navigationReplaced, staleAfterNavigation },
        superseded: {
          held: superseded.held,
          prevented: newerClose.prevented,
          newIntentReplaced,
          staleAfterIntent,
        },
        state: staleTimerState,
      }),
    );
  } finally {
    for (const listener of unresponsiveHandlers) win.on("unresponsive", listener);
    rig.restore();
    __shutdown.reset();
    if (!wc.isDestroyed()) {
      await win.loadFile(indexFile).catch(() => {});
      await waitUntil(() => __shutdown.state().renderer === "ready", 20000);
    }
  }
}

async function runRendererLossScenario(win) {
  const rig = shutdownRig(win);
  const bareFile = path.join(dir, "impostor.html");
  try {
    // -- the renderer dies while its commit is outstanding ------------------
    // A REVISION-BEARING APPROVAL COMMITS OR FAILS CLOSED. This used to fall
    // through and run the continuation when the renderer had gone since it
    // answered, which is precisely the case where the answer is least
    // trustworthy: the document that produced it is unreachable, so nothing
    // can confirm it still describes anything.
    //
    // THE DEATH IS INJECTED AT THE COMMIT SEND, NOT AT THE ANSWER, and that is
    // the whole point of this block. Crashing from a `quit-approval-response`
    // listener only runs AFTER main has already handed the commit to the IPC
    // channel, and forcefullyCrashRenderer() merely ASKS the browser process to
    // kill the render process - so the renderer can, and measurably does,
    // answer the commit before the kill lands. That run logged
    // "Shutdown commit #61 confirmed at revision 1" immediately followed by
    // "renderer process gone: crashed", closed the window and kept its
    // authorization: a real confirmed commit, and therefore a scenario that
    // never entered the state it is named for. Intercepting the send removes
    // the race rather than narrowing it - the commit is never delivered, so no
    // reply is possible, and the renderer is killed with the attempt
    // outstanding. Everything the product does before and after that one
    // message is the real path, and the message itself is asserted below.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    await win.webContents.executeJavaScript(`
      (() => {
        const realConfirm = window.confirm;
        window.confirm = () => true;
        try {
          window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
        } finally {
          window.confirm = realConfirm;
        }
        const tab = window.CustomTabs.createTab(${JSON.stringify(
          path.join(dir, "quit-alpha.md"),
        )}, "commit-crash-baseline");
        tab.content = tab.originalContent;
        tab.hasUnsavedChanges = false;
        window.originalMarkdown = tab.originalContent;
        window.isEditMode = false;
        return true;
      })()
    `);
    let crashedDuringCommit = 0;
    let interceptedCommit = null;
    let commitPendingAtCrash = null;
    const realSend = win.webContents.send;
    const restoreCommitSend = replaceMethod(
      win.webContents,
      "send",
      function (channel, ...args) {
        if (channel === "quit-approval-commit" && !crashedDuringCommit) {
          crashedDuringCommit = 1;
          // Recorded so the scenario proves the product really reached the
          // commit phase with a revision in hand, rather than inferring it
          // from the refusal that follows.
          interceptedCommit = args[0];
          // SAMPLED FROM THE STATE MACHINE, INSIDE THE SEND, BEFORE THE KILL.
          // The attempt is registered before the message goes out, so this is
          // the direct evidence that a commit was OUTSTANDING at the instant
          // the renderer died - the one precondition the whole block rests on,
          // and the one the previous version of this scenario never
          // established. A zero here means the case measured nothing.
          commitPendingAtCrash = __shutdown.state().commitPendingId;
          win.webContents.forcefullyCrashRenderer();
          return;
        }
        return realSend.call(this, channel, ...args);
      },
    );
    let commitCrashClose;
    try {
      commitCrashClose = guardEvent();
      win.emit("close", commitCrashClose);
      await waitUntil(() => rig.dialogs.length > 0, 20000);
      await sleep(300);
    } finally {
      restoreCommitSend();
    }
    const commitCrashState = __shutdown.state();
    check(
      "a renderer that dies mid-commit fails the commit closed instead of running it",
      crashedDuringCommit === 1 &&
        // The setup control. Without it a product that stopped committing at
        // all - no send, no revision, no attempt registered - would satisfy
        // every clause below by never entering the commit phase, and this
        // would read as a pass.
        commitPendingAtCrash > 0 &&
        !!interceptedCommit &&
        Number.isSafeInteger(interceptedCommit.revision) &&
        Number.isSafeInteger(interceptedCommit.id) &&
        commitPendingAtCrash === interceptedCommit.id &&
        commitCrashClose.prevented === true &&
        commitCrashState.renderer === "unusable" &&
        commitCrashState.commitRefusedCount >= 1 &&
        commitCrashState.commitRefusedWhy === "renderer-unusable" &&
        // Cancel on the fallback: nothing closed, nothing authorised.
        rig.closes === 0 &&
        rig.quits === 0 &&
        commitCrashState.authorized === false &&
        commitCrashState.pendingId === 0,
      JSON.stringify({
        crashedDuringCommit,
        commitPendingAtCrash,
        interceptedCommit,
        prevented: commitCrashClose.prevented,
        state: commitCrashState,
        closes: rig.closes,
        quits: rig.quits,
      }),
    );
    check(
      "a commit the renderer could not answer is re-asked in the main process rather than stranded",
      rig.dialogs.length === 1 &&
        rig.dialogs[0].pendingReason === "window-close" &&
        /cannot be checked/i.test(String(rig.dialogs[0].options.title)) &&
        commitCrashState.settleWhy === "fallback-unresponsive",
      JSON.stringify({
        dialogs: rig.dialogs.map((d) => ({
          reason: d.pendingReason,
          title: d.options.title,
        })),
        state: commitCrashState,
      }),
    );
    // Put a live renderer back: the blocks below crash one of their own, and a
    // renderer that is already dead cannot be crashed again.
    win.webContents.reload();
    await waitUntil(() => __shutdown.state().renderer === "ready", 20000);

    __shutdown.reset();
    // THE DIALOG LEDGER IS PER BLOCK. The commit-crash case above now really
    // does reach the main-process fallback, so it leaves one dialog recorded;
    // the two assertions below count dialogs absolutely ("exactly two", and
    // "dialogs[0] is the one this block raised"), and inheriting an earlier
    // block's entry makes both of them measure the wrong run of questions.
    rig.reset();
    win.webContents.forcefullyCrashRenderer();
    const lost = await waitUntil(
      () => __shutdown.state().renderer === "unusable",
      10000,
    );

    rig.answer = 1;
    const cancelledQuit = guardEvent();
    app.emit("before-quit", cancelledQuit);
    const askedInMain = await waitUntil(() => rig.dialogs.length > 0, 10000);
    await sleep(200);
    check(
      "a lost renderer is asked about in the main process rather than approved silently",
      lost &&
        askedInMain &&
        cancelledQuit.prevented === true &&
        rig.quits === 0 &&
        /cannot be checked/i.test(
          rig.dialogs.length ? String(rig.dialogs[0].options.title) : "",
        ),
      JSON.stringify({
        lost,
        askedInMain,
        prevented: cancelledQuit.prevented,
        quits: rig.quits,
        title: rig.dialogs.length ? rig.dialogs[0].options.title : null,
      }),
    );

    rig.answer = 0;
    const approvedQuit = guardEvent();
    app.emit("before-quit", approvedQuit);
    await waitUntil(() => rig.quits > 0, 10000);
    await sleep(200);
    check(
      "approving the main-process fallback quits exactly once",
      rig.quits === 1 && rig.dialogs.length === 2,
      JSON.stringify({ quits: rig.quits, dialogs: rig.dialogs.length }),
    );

    // -- a close raised while a renderer is coming up ----------------------
    // Held, not answered and not auto-approved: this is the branch that keeps
    // a startup-time X from being decided without the documents being
    // consulted, and the readiness handshake is what releases it.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    // The preceding real renderer crash can leave Chromium's asynchronous
    // hang notification queued after the replacement load begins. This
    // scenario measures the loading/READY handshake, not the independently
    // covered unresponsive fallback, so keep that stale notification from
    // deciding the deliberately held request.
    const unresponsiveHandlers = win.listeners("unresponsive");
    win.removeAllListeners("unresponsive");
    try {
      win.webContents.reload();
      const loading = await waitUntil(
        () => __shutdown.state().renderer === "loading",
        20000,
      );
      const heldClose = guardEvent();
      win.emit("close", heldClose);
      await sleep(150);
      const heldState = __shutdown.state();
      const closedWhileLoading = rig.closes;
      const askedWhileLoading = rig.dialogs.length;
      const answered = await waitUntil(() => rig.closes > 0, 20000);
      check(
        "a close raised while the renderer is loading is held, then answered by the renderer that arrives",
        loading &&
          heldClose.prevented === true &&
          heldState.pendingId > 0 &&
          closedWhileLoading === 0 &&
          askedWhileLoading === 0 &&
          answered &&
          rig.dialogs.length === 0,
        JSON.stringify({
          loading,
          heldState,
          closedWhileLoading,
          askedWhileLoading,
          answered,
          dialogs: rig.dialogs.map((d) => d.options.title),
          finalState: __shutdown.state(),
        }),
      );
    } finally {
      unresponsiveHandlers.forEach((listener) => win.on("unresponsive", listener));
    }

    // -- a navigation the main process DENIES -------------------------------
    // Measured in this repo (test-render-security.js, the N11 block): a
    // main-frame navigation that will-navigate cancels still fires
    // did-start-navigation. A readiness state keyed off the START of a
    // navigation would therefore be disarmed by a navigation that never
    // happens, with nothing afterwards to re-arm it - and from that moment the
    // window could not be closed at all. Document content can provoke this.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    await win.webContents.executeJavaScript(
      `location.href = 'http://probe.invalid/denied'; null;`,
    );
    await sleep(800);
    const afterDenied = __shutdown.state().renderer;
    const deniedClose = guardEvent();
    win.emit("close", deniedClose);
    const closedAfterDenied = await waitUntil(() => rig.closes > 0, 8000);
    check(
      "a navigation the main process denies leaves the window closable",
      afterDenied === "ready" &&
        closedAfterDenied &&
        rig.dialogs.length === 0 &&
        deniedClose.prevented === true,
      JSON.stringify({
        afterDenied,
        closedAfterDenied,
        dialogs: rig.dialogs.length,
        prevented: deniedClose.prevented,
      }),
    );

    // -- a page that loads without the tab overlay -------------------------
    // The likelier production failure than a crash: something throws in
    // custom-tabs.js before it can announce itself. Nothing will ever answer,
    // so the close must reach the main-process question rather than wait for
    // an event that is not coming.
    __shutdown.reset();
    rig.reset();
    rig.answer = 1;
    await win.loadFile(bareFile);
    const bare = await waitUntil(
      () => __shutdown.state().renderer === "unusable",
      20000,
    );
    const bareClose = guardEvent();
    win.emit("close", bareClose);
    const bareAsked = await waitUntil(() => rig.dialogs.length > 0, 10000);
    await sleep(200);
    check(
      "a page that loads without the tab overlay falls through to the main-process question",
      bare &&
        bareAsked &&
        bareClose.prevented === true &&
        rig.closes === 0 &&
        /cannot be checked/i.test(String(rig.dialogs[0].options.title)),
      JSON.stringify({
        bare,
        bareAsked,
        closes: rig.closes,
        title: rig.dialogs.length ? rig.dialogs[0].options.title : null,
      }),
    );

    // Put the real document window back, both so a failure screenshot is
    // possible and because "the handshake re-arms" is what keeps a replaced
    // renderer from being unreachable forever.
    __shutdown.reset();
    await win.loadFile(path.join(__dirname, "..", "src", "index.html"));
    const rearmed = await waitUntil(
      () => __shutdown.state().renderer === "ready",
      20000,
    );
    check(
      "a replaced renderer announces itself again and becomes answerable",
      rearmed,
      JSON.stringify(__shutdown.state()),
    );
  } finally {
    rig.restore();
    __shutdown.reset();
  }
}

app.whenReady().then(async () => {
  // A native modal (confirm/alert) blocks executeJavaScript forever, which
  // turns a bug into a hung run with no output. Fail loudly instead.
  //
  // 420s for the FULL suite. The healthy run is about 180s; the budget has to
  // cover a REVERT run too, and a revert that removes the close guard turns a
  // dozen "wait for the dialog" polls into their full timeouts at once. At
  // 300s that run hit this watchdog before scenario 14 and reported
  // WRONG-GUARD for three assertions that had simply never executed -
  // measured, and the reason the number is this far above the healthy run.
  //
  // A COMPANION IS NOT THE FULL SUITE and must not borrow its budget. Each one
  // runs a single block of this file, and its watchdog has to expire INSIDE
  // the parent's kill timer (COMPANION_BUDGET_MS) so that a wedged companion
  // still emits its own `=== TIMED OUT ... ===` footer; the parent shooting it
  // instead produces no footer, and the revert audit then has to treat every
  // name under it as unreached rather than as a result.
  //
  // THE PARENT'S BUDGET IS THE WHOLE SUM, INCLUDING THE GRACES. A watchdog that
  // counted only the companions' kill timers can expire while the parent is
  // still inside the kill grace, the drain grace or the ownership-scoped
  // removal that follows them - so the app.exit() below would preempt the very
  // cleanup this seam was rebuilt to guarantee, and the run would leak exactly
  // the tree it had just decided to remove. Every millisecond the parent can
  // legitimately spend per companion is named in companionWallClockMs(), and a
  // tail allowance covers the failure screenshot and the temp sweep that run
  // after the last assertion.
  const watchdogMs = focusedF22Harness || focusedCommitHarness
    ? 90000
    : portableHarness
      ? COMPANION_WATCHDOG_MS.portable
      : teardownCase
      ? COMPANION_WATCHDOG_MS.teardown
      : finalizerSelfcheck
        ? COMPANION_WATCHDOG_MS.teardown
      : 420000 +
        companionWallClockMs(COMPANION_BUDGET_MS.portable) +
        // The finalizer selfcheck is also a real Electron subprocess. It has
        // its own, slightly smaller budget but the same kill/drain tail, so
        // it must be counted independently of the four teardown companions.
        companionWallClockMs(COMPANION_BUDGET_MS.teardown) +
        5 * companionWallClockMs(COMPANION_BUDGET_MS.teardown) +
        SUITE_TAIL_MS;
  const watchdog = setTimeout(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      `FAIL  harness timed out after ${Math.round(watchdogMs / 1000)}s  -> a blocking dialog is most likely open`,
    );
    console.log(
      `\n=== TIMED OUT after ${results.length - failed}/${results.length} checks ===`,
    );
    app.exit(1);
  }, watchdogMs);
  watchdog.unref?.();

  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.log("FAIL  no BrowserWindow was created");
    app.exit(1);
    return;
  }

  verifyHarnessFaultBoundaries();

  // THE FINALIZER SELFCHECK ENDS HERE, DELIBERATELY. Its whole purpose is to
  // reach the tail below with a preserved companion tree, so it must not run
  // any scenario and must not remove anything: its parent reads the disk and
  // the transcript once this process is confirmed gone. See
  // runFinalizerPreservationSubprocess().
  if (finalizerSelfcheck) {
    // Announced before anything can go wrong, so the owner can clean up even on
    // a path where the diagnostic below is never printed.
    console.log("finalizer selfcheck root: " + dir);
    const preservedDir = path.join(dir, "companion-preserved");
    fs.mkdirSync(preservedDir, { recursive: true });
    fs.writeFileSync(
      path.join(preservedDir, "evidence.txt"),
      "this tree must survive the finalizer",
      "utf8",
    );
    PRESERVED_COMPANION_DIRS.push(preservedDir);
    // THE POSITIVE CONTROL FOR THE SWEEP ITSELF. A registered directory that is
    // NOT preserved: the exit sweep has to take this one, which is what makes
    // "the root survived" a decision rather than a sweep that never ran.
    const decoyDir = tempDir("mdv-e2e-decoy-");
    fs.writeFileSync(
      path.join(decoyDir, "sweep-me.txt"),
      "this tree must not survive the finalizer",
      "utf8",
    );
    console.log("finalizer selfcheck decoy: " + decoyDir);
    check(
      "the finalizer selfcheck armed a registered root, a preserved tree and an unpreserved decoy",
      // The root has to be this process's OWN mkdtemp root, registered for the
      // sweep - otherwise the de-registration the parent asserts on removes an
      // entry that was never there and proves nothing.
      ownsScratchDir === true &&
        REGISTERED_TEMP_DIRS.has(dir) &&
        REGISTERED_TEMP_DIRS.has(decoyDir) &&
        fs.existsSync(path.join(preservedDir, "evidence.txt")) &&
        fs.existsSync(path.join(decoyDir, "sweep-me.txt")) &&
        PRESERVED_COMPANION_DIRS.length === 1,
      JSON.stringify({
        ownsScratchDir,
        rootRegistered: REGISTERED_TEMP_DIRS.has(dir),
        decoyRegistered: REGISTERED_TEMP_DIRS.has(decoyDir),
        preservedDir,
        decoyDir,
        preserved: PRESERVED_COMPANION_DIRS,
      }),
    );
  }

  await win.webContents.executeJavaScript(`
    window.__e2eErrors = [];
    window.addEventListener('error', e => window.__e2eErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection', e => window.__e2eErrors.push(String(e.reason)));
    null;
  `);

  try {
    if (finalizerSelfcheck) {
      // Nothing. The tail is the subject.
    } else if (portableHarness) {
      checkCompanionProfileIsolation("portable updater");
      await runPortableUpdateScenarios(win);
    } else if (teardownCase) {
      checkCompanionProfileIsolation(`${teardownCase} teardown`);
      await runTeardownScenario(win, teardownCase);
    } else if (focusedF22Harness) {
      await runF22SaveAndReloadScenarios(win, (code) =>
        win.webContents.executeJavaScript(code, true));
    } else if (focusedCommitHarness) {
      await runF22CommitSendThrowScenario(win, (code) =>
        win.webContents.executeJavaScript(code, true));
    } else if (companionSelfcheck) {
      await runCompanionSettlementScenarios();
    } else {
      await run(win);
      // THE NEGATIVE TWIN OF THE PORTABLE BRANCH ASSERTION, in the process that
      // took the OTHER branch. `autoInstallOnAppQuit = !isPortable` is the only
      // production state that distinguishes them, and asserting it in one
      // process alone cannot tell a decision from a constant. This process has
      // no PORTABLE_EXECUTABLE_DIR, so main.js resolved isPortable false and
      // the same field must read true.
      const parentUpdater = require("electron-updater").autoUpdater;
      check(
        "a non-portable process takes the installed updater branch, which is what makes the portable one a decision",
        !process.env.PORTABLE_EXECUTABLE_DIR &&
          !!parentUpdater.requestHeaders &&
          parentUpdater.requestHeaders["x-user-staging-id"] === "" &&
          parentUpdater.autoInstallOnAppQuit === true &&
          parentUpdater.autoDownload === false,
        JSON.stringify({
          portableEnv: process.env.PORTABLE_EXECUTABLE_DIR || null,
          configured: !!parentUpdater.requestHeaders,
          autoInstallOnAppQuit: parentUpdater.autoInstallOnAppQuit,
          autoDownload: parentUpdater.autoDownload,
        }),
      );
      await runCompanionSettlementScenarios();
      await runCompanionScratchScenarios();
      const finalizerGone = await runFinalizerPreservationSubprocess();
      // PROPAGATED, NOT DISCARDED. Every child, including the finalizer
      // selfcheck, must be confirmed gone before another Electron starts. A
      // live child also forbids the sweep below; dropping either outcome here
      // would quietly undo the preservation decision one frame after it.
      if (!finalizerGone) {
        skipPortableAndTeardownCompanions("finalizer selfcheck");
      } else {
        const portableGone = await runPortableCompanion();
        if (portableGone) await runTeardownCompanion();
        else skipTeardownCompanions("portable updater");
      }
    }
  } catch (error) {
    let rendererErrors = "";
    try {
      rendererErrors = await win.webContents.executeJavaScript(
        "JSON.stringify(window.__e2eErrors || [])",
        true,
      );
    } catch {}
    console.log(
      "FAIL  harness threw  -> " +
        (error && error.stack ? error.stack : error) +
        (rendererErrors ? "\nrenderer errors: " + rendererErrors : ""),
    );
    results.push({ name: "harness", ok: false });
  }

  // A COMPANION LEAVES ITS SCRATCH TREE STANDING. It does not own it - see
  // companionScratchDir() - and deleting it here would destroy the only
  // evidence its parent has that the removal it performs afterwards actually
  // removed something.
  //
  // AND A PRESERVED TREE FORBIDS SWEEPING ITS ANCESTOR. Every companion tree
  // lives INSIDE `dir`, so releasing `dir` - or letting the registered exit
  // sweep take it - is a recursive delete of exactly the evidence a preserved
  // companion was kept for, and it would be aimed at a directory a live
  // Electron may still be writing into. The directory is handed to the reader
  // instead: de-registered so the exit sweep cannot reach it either, and named
  // on stdout with its reason, which is the only form of "recovery" available
  // once no in-process owner can safely act on it.
  let rootReleased = true;
  if (PRESERVED_COMPANION_DIRS.length > 0) {
    // BOTH HALVES, captured either side of the delete. "It is not registered"
    // on its own is satisfied by a root that never was, which is precisely how
    // this evidence was previously vacuous.
    const registeredBefore = REGISTERED_TEMP_DIRS.has(dir);
    REGISTERED_TEMP_DIRS.delete(dir);
    console.log(
      "preserved for diagnosis (not swept): " +
        JSON.stringify({
          root: dir,
          companions: PRESERVED_COMPANION_DIRS,
          registeredBefore,
          // Read back AFTER the delete, so this line is evidence rather than
          // an intention. runFinalizerPreservationSubprocess() asserts on it
          // from outside this process, which is the only place the outcome of
          // an app.exit() path can be observed.
          registered: REGISTERED_TEMP_DIRS.has(dir),
          reason:
            "a companion could not be confirmed terminated; its tree and this run's root are left on disk",
        }),
    );
  } else if (ownsScratchDir) {
    try {
      rootReleased = releaseTempDir(dir);
    } catch (e) {
      rootReleased = false;
    }
  }
  // Sweep before the footer, rather than relying only on app.exit's wrapper.
  // A failed sweep after a green footer is green evidence for a run that left
  // state behind. The wrapper remains the backstop for earlier exits.
  const sweepFailures = sweepTempDirs();
  check(
    "the suite's registered temp-directory cleanup completed before its definitive footer",
    rootReleased === true &&
      sweepFailures.length === 0 &&
      REGISTERED_TEMP_DIRS.size === 0,
    JSON.stringify({
      rootReleased,
      sweepFailures,
      remaining: [...REGISTERED_TEMP_DIRS],
      preserved: PRESERVED_COMPANION_DIRS,
    }),
  );
  const failed = results.filter((r) => !r.ok).length;
  // Screenshot as a debugging artifact, never a baseline - see
  // test-visual-utils.js. Captured on failure so the failing screen can be
  // inspected without re-running the suite by hand.
  if (failed > 0) {
    const shot = await captureScreenshot(win, "tab-refresh-FAILED");
    if (shot) console.log("failure screenshot: " + shot);
  }
  console.log(
    `\n=== ${results.length - failed}/${results.length} passed` +
      (unavailableEvidence ? `; ${unavailableEvidence} unavailable` : "") +
      " ===",
  );
  // Keep the tail inside the full-suite budget. A failed screenshot or cleanup
  // must not turn a bounded failure into a silent hang after its last check.
  clearTimeout(watchdog);
  // Exit 2 is neither a behavioral pass nor failure: it states that this
  // regression proof cannot run until its required production contract lands.
  app.exit(failed === 0 ? (unavailableEvidence ? 2 : 0) : 1);
});

const REDIRECT_RULE_IDS = [1, 2];
const TEMP_RULE_ID_START = 1000;
const GOOGLE_CHECK_URL = "https://www.google.com/generate_204";
const GOOGLE_CHECK_TIMEOUT_MS = 8000;
const pendingTargetUrls = new Map();

const DOMAIN_KEYWORD_REGEX =
  "^(https?://(?:[^/@?#]*@)?[^/@?#]*(?:claude|anthropic)[^/@?#]*(?:[/?#].*)?)$";
const DOMAIN_SUFFIX_REGEX =
  "^(https?://(?:[^/@?#]*@)?(?:[^/@?#]*\\.)*clau\\.de(?::[0-9]+)?(?:[/?#].*)?)$";

function isProtectedUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return (
    hostname.includes("claude") ||
    hostname.includes("anthropic") ||
    hostname === "clau.de" ||
    hostname.endsWith(".clau.de")
  );
}

async function updateRedirectRules() {
  const redirect = {
    type: "redirect",
    redirect: {
      regexSubstitution: `chrome-extension://${chrome.runtime.id}/check.html#\\1`
    }
  };

  const rules = [
    {
      id: 1,
      priority: 1,
      action: redirect,
      condition: {
        regexFilter: DOMAIN_KEYWORD_REGEX,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame"]
      }
    },
    {
      id: 2,
      priority: 1,
      action: redirect,
      condition: {
        regexFilter: DOMAIN_SUFFIX_REGEX,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame"]
      }
    }
  ];

  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const alreadyInstalled = rules.every((expected) => {
    const current = currentRules.find((rule) => rule.id === expected.id);
    return (
      current?.action?.type === "redirect" &&
      current?.action?.redirect?.regexSubstitution ===
        expected.action.redirect.regexSubstitution &&
      current?.condition?.regexFilter === expected.condition.regexFilter &&
      current?.condition?.isUrlFilterCaseSensitive === false &&
      current?.condition?.resourceTypes?.includes("main_frame")
    );
  });

  if (!alreadyInstalled) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: REDIRECT_RULE_IDS,
      addRules: rules
    });
  }
}

let redirectRulesPromise;

function ensureRedirectRules() {
  if (!redirectRulesPromise) {
    redirectRulesPromise = updateRedirectRules().catch((error) => {
      redirectRulesPromise = undefined;
      throw error;
    });
  }
  return redirectRulesPromise;
}

async function probeGoogle() {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    GOOGLE_CHECK_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${GOOGLE_CHECK_URL}?t=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });

    // generate_204 should return exactly 204. A captive portal, redirect, or
    // unexpected response is treated as a failed proxy check (fail closed).
    if (response.status !== 204 || new URL(response.url).hostname !== "www.google.com") {
      return {
        ok: false,
        message: "Google 返回了非预期响应。请检查 Shadowrocket 是否已开启并连接。"
      };
    }

    return { ok: true };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return {
      ok: false,
      message: timedOut
        ? "连接 Google 超时。请先开启并连接 Shadowrocket，然后重试。"
        : "当前无法连接 Google。请先开启并连接 Shadowrocket，然后重试。"
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function removeTemporaryRulesForTab(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ruleIds = rules
    .filter((rule) => rule.id >= TEMP_RULE_ID_START && rule.condition?.tabIds?.includes(tabId))
    .map((rule) => rule.id);

  if (ruleIds.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds
    });
  }
}

async function addOneTimeNavigationAllowance(tabId, targetUrl) {
  const target = new URL(targetUrl);
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const usedIds = new Set(rules.map((rule) => rule.id));

  let ruleId = TEMP_RULE_ID_START;
  while (usedIds.has(ruleId)) {
    ruleId += 1;
  }

  // The allowance is limited to this tab, this host (including its
  // subdomains), and top-level navigations. It is removed on commit/error.
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id: ruleId,
        priority: 100,
        action: { type: "allow" },
        condition: {
          tabIds: [tabId],
          requestDomains: [target.hostname],
          resourceTypes: ["main_frame"]
        }
      }
    ]
  });

  return ruleId;
}

async function checkAndOpenTarget(targetUrlFromPage, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || sender.frameId !== 0) {
    return { ok: false, message: "无法识别当前标签页，请重新打开目标网站。" };
  }

  // Prefer the original navigation URL captured by webNavigation. This also
  // preserves URL fragments if the network request URL omits them.
  const pendingUrl = pendingTargetUrls.get(tabId);
  const targetUrl = isProtectedUrl(pendingUrl) ? pendingUrl : targetUrlFromPage;

  if (!isProtectedUrl(targetUrl)) {
    return { ok: false, message: "目标网址不在内置保护规则中。" };
  }

  await ensureRedirectRules();

  const probe = await probeGoogle();
  if (!probe.ok) {
    return probe;
  }

  await removeTemporaryRulesForTab(tabId);
  await addOneTimeNavigationAllowance(tabId, targetUrl);
  pendingTargetUrls.delete(tabId);

  try {
    await chrome.tabs.update(tabId, { url: targetUrl });
    return { ok: true };
  } catch (error) {
    await removeTemporaryRulesForTab(tabId);
    return {
      ok: false,
      message: "检测通过，但无法重新打开目标网页。请返回后重试。"
    };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRedirectRules().catch((error) => {
    console.error("Claude Proxy Guard initialization failed:", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureRedirectRules().catch((error) => {
    console.error("Claude Proxy Guard startup failed:", error);
  });
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  const checkPage = chrome.runtime.getURL("check.html");
  if (details.url.startsWith(checkPage)) return;

  if (isProtectedUrl(details.url)) {
    pendingTargetUrls.set(details.tabId, details.url);
  } else {
    pendingTargetUrls.delete(details.tabId);
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;

  const checkPage = chrome.runtime.getURL("check.html");
  if (!details.url.startsWith(checkPage)) {
    pendingTargetUrls.delete(details.tabId);
  }

  removeTemporaryRulesForTab(details.tabId).catch((error) => {
    console.warn("Could not clear one-time navigation allowance:", error);
  });
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;

  removeTemporaryRulesForTab(details.tabId).catch((error) => {
    console.warn("Could not clear failed navigation allowance:", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTargetUrls.delete(tabId);
  removeTemporaryRulesForTab(tabId).catch((error) => {
    console.warn("Could not clear closed-tab allowance:", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CHECK_AND_OPEN") return undefined;

  const ownCheckPage = chrome.runtime.getURL("check.html");
  if (sender.frameId !== 0 || !sender.url?.startsWith(ownCheckPage)) {
    sendResponse({ ok: false, message: "请求来源无效。" });
    return undefined;
  }

  checkAndOpenTarget(message.url, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("Proxy check failed:", error);
      sendResponse({
        ok: false,
        message: "检测过程中发生错误。请确认代理已连接后重试。"
      });
    });

  return true;
});

// Dynamic rules persist across service-worker restarts. Verify them whenever
// the worker starts, while keeping active one-time allowances intact.
ensureRedirectRules().catch((error) => {
  console.error("Claude Proxy Guard could not install rules:", error);
});

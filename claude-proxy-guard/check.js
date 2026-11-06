const title = document.getElementById("title");
const description = document.getElementById("description");
const targetLabel = document.getElementById("target");
const status = document.getElementById("status");
const statusText = document.getElementById("status-text");
const retryButton = document.getElementById("retry");

let targetUrl = "";
let checking = false;

function showFailure(message) {
  checking = false;
  title.textContent = "请先开启代理";
  description.textContent =
    "当前无法确认 Google 可访问。为避免目标网站通过直连访问，请先开启并连接 Shadowrocket。";
  status.className = "status error";
  status.querySelector(".spinner")?.remove();
  statusText.textContent = message;
  retryButton.hidden = false;
  retryButton.disabled = false;
}

async function runCheck() {
  if (checking || !targetUrl) return;
  checking = true;
  retryButton.hidden = true;
  retryButton.disabled = true;
  title.textContent = "正在检查代理连接";
  description.textContent = "正在尝试访问 Google。检查通过后才会打开目标网站。";
  status.className = "status";
  if (!status.querySelector(".spinner")) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    status.prepend(spinner);
  }
  statusText.textContent = "正在检测 Google 连接…";

  try {
    const result = await chrome.runtime.sendMessage({
      type: "CHECK_AND_OPEN",
      url: targetUrl
    });

    if (!result?.ok) {
      showFailure(result?.message || "Google 连接检测失败。请开启代理后重试。");
      return;
    }

    title.textContent = "检测通过";
    description.textContent = "代理连接正常，正在打开目标网站…";
    status.className = "status success";
    statusText.textContent = "Google 可访问，正在继续。";
  } catch (error) {
    showFailure("扩展暂时无法完成检测。请刷新此页面后重试。");
  }
}

retryButton.addEventListener("click", runCheck);

try {
  targetUrl = location.hash.slice(1);
  const parsed = new URL(targetUrl);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported protocol");
  targetLabel.textContent = parsed.hostname;
} catch {
  targetUrl = "";
  title.textContent = "无法识别目标网址";
  description.textContent = "请重新输入目标网址。";
  status.className = "status error";
  status.querySelector(".spinner")?.remove();
  statusText.textContent = "目标网址格式无效。";
}

if (targetUrl) runCheck();

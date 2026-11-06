# Claude Proxy Guard

一个轻量的 Chrome Manifest V3 扩展：打开 Claude / Anthropic 相关网站前，先检测 Google 是否可访问；检测失败时不向目标网站发起导航请求，而是显示代理提示页。

## 内置规则

按 Shadowrocket 的规则语义实现：

- `DOMAIN-KEYWORD,claude`
- `DOMAIN-KEYWORD,anthropic`
- `DOMAIN-SUFFIX,clau.de`

其中 `DOMAIN-KEYWORD` 只匹配域名（hostname），不匹配 URL 路径或查询参数；`DOMAIN-SUFFIX` 匹配 `clau.de` 本身及其所有子域名。

## 工作方式

1. Chrome 的 Declarative Net Request 在目标网站请求发出前拦截匹配的**顶层页面导航**。
2. 浏览器先跳转到扩展内置的本地检测页，原始目标 URL 放在页面 fragment 中，不会因此请求目标网站。
3. 扩展后台通过 Chrome 当前网络/系统代理配置请求 `https://www.google.com/generate_204`。
4. 只有收到来自 `www.google.com` 的 HTTP `204` 才视为检测通过。超时、网络错误、重定向或其他状态码都会失败关闭，并留在提示页。
5. 检测通过后，只给当前标签页、当前目标域名添加一次性的顶层导航放行规则；导航提交或失败后立即移除。

## 安装

1. 在 Chrome 地址栏打开 `chrome://extensions`。
2. 打开右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录 `claude-proxy-guard`。

## 权限说明

- `declarativeNetRequest`：在目标页面请求发出前拦截并重定向导航。
- `webNavigation`：在导航提交或失败后清理一次性放行规则。
- `<all_urls>`：因为 `DOMAIN-KEYWORD` 可以匹配任意域名，扩展需要对任意目标域名设置导航拦截规则。扩展只根据请求 URL 的域名匹配规则，不读取网页内容。
- `https://www.google.com/*`：执行 Google 连通性检测。

## 使用边界

这是一个**打开网页前的检测保护**，不是系统级 VPN Kill Switch。它会在每次匹配的顶层页面导航前检测 Google，但不会在网页打开后持续监控 Shadowrocket。如果代理在网页打开后才被关闭，后续请求不保证仍被拦截。请在访问受保护网站期间保持 Shadowrocket 连接；如果需要代理断开后也绝不允许直连，应同时启用代理客户端自身的 Kill Switch / 防火墙功能。

检测逻辑假设：代理不可用时 Google 无法访问，代理正常时 `generate_204` 返回 HTTP 204。如果网络环境改变了这一条件，可在 `background.js` 中调整检测地址或期望状态码。

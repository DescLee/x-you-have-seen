# Seen · X 浏览历史

**语言 / Languages:** [简体中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Seen 是一个面向桌面浏览器的 Chrome / Edge Manifest V3 扩展。它会在你正常浏览 X（原 Twitter）时间线时，判断哪些帖子真正进入了视口并停留了足够时间，把这些内容保存在本机；之后可以在 X 页面右侧直接搜索、筛选和找回，也可以打开独立历史页进行管理。

Seen 解决的是一个很具体的问题：X 的时间线更新很快，收藏、点赞和浏览记录并不能准确回答“我刚才看过的那条帖子在哪里”。Seen 不依赖 X API，不要求登录额外账号，也不会把浏览内容上传到服务器。

## 功能

### 自动记录真正看过的帖子

- 只有帖子至少有 50% 的可见区域，并持续停留达到设定时长，才会被记录。
- 默认停留阈值为 1 秒，也可以在设置中选择 0.8 / 1 / 1.5 / 2 秒。
- 页面失去焦点、切到后台、暂停记录，或进入私信、Grok、设置等页面时不会采集。
- 支持普通帖子、长帖、引用帖子、图片、视频 / GIF 和 X 文章。
- X 的虚拟列表、正文展开、媒体延迟加载和 React 节点复用不会覆盖已经保存的较完整内容。

### 在 X 页面内找回

右下角的历史入口与 X 的浮动按钮保持同列。点击后，历史面板会停靠在右侧栏，不打开新页面，也不会遮挡中间时间线的主要浏览区域。

- 搜索正文、作者名、用户名、引用内容和文章标题 / 摘要。
- 支持“全部内容、纯文字、图片、视频 / GIF、文章”筛选。
- 支持自定义浏览时间范围，以及“今天、最近 7 天、最近 30 天”快捷范围。
- 日期范围使用草稿式交互：点击“确定”才应用，取消、点击外部或按 Esc 会恢复原值。
- 搜索结果稳定分页，支持“加载更多”。
- 作者名可以打开对应 X 主页，底部链接可以打开原帖。
- X 文章使用封面、标题和摘要卡片展示；已保存的图片按原帖比例以网格预览。
- 发布时间和浏览时间保留相对时间，鼠标悬停可查看完整年月日时分。
- 历史面板打开时会接收后台变更通知，并以低频状态检查作为兜底；浏览中产生的新记录会自动出现在右侧列表。没有变化时不会重复重绘列表。

### 独立历史页

扩展的侧边栏 / 独立标签页提供完整管理能力：

- 关键词、作者、内容类型、浏览日期和新旧排序组合查询。
- 长帖和引用内容可以展开查看。
- 默认不主动加载历史页中的图片预览，可在偏好中开启。
- 单条删除、批量删除、清空历史并暂停记录。
- JSON 备份导出和校验导入；导入会去重，不包含内部搜索索引。
- 支持浅色、深色和跟随系统主题。
- 支持快捷键 `Alt+Shift+H`（macOS 也使用 `Alt+Shift+H`）打开历史页。

## 技术栈

- **TypeScript**：内容脚本、Service Worker、历史页和 Worker 的类型安全实现。
- **Chrome Extension Manifest V3**：`content_scripts`、`background.service_worker`、`sidePanel`、`options_ui`、命令快捷键。
- **Dexie 4 + IndexedDB**：本地持久化帖子正文、媒体、文章卡片、浏览时间和访问次数。
- **esbuild**：把 TypeScript 构建为 `dist/` 中可直接加载的扩展文件。
- **Node.js Test Runner + tsx + fake-indexeddb**：在 Node 环境覆盖核心采集、合并、搜索、分页、导入导出和安全边界。
- **Web APIs**：`IntersectionObserver` 判断可见性，`MutationObserver` 追踪 X 的 SPA/虚拟列表变化，`requestIdleCallback` 合并扫描，Web Worker 执行完整历史页搜索。

## 实现方式

### 1. 内容采集链路

1. 内容脚本只匹配 `x.com` / `twitter.com` 页面。
2. 扫描 `article[data-testid="tweet"]`，提取帖子 ID、作者、发布时间、正文、引用内容、媒体 URL 和文章卡片。
3. 使用 `IntersectionObserver` 观察帖子是否达到可见阈值；可见后启动停留计时。
4. 停留时间达到阈值后生成带 `eventId` 的采集事件，先放入内存队列。
5. 队列按批次发送给后台 Service Worker；短时间内重复看到同一帖子不会重复增加访问次数。
6. 后台串行写入 IndexedDB，并按保留期限和容量上限清理旧记录。

### 2. 搜索和数据模型

- 帖子正文、作者、引用文本、文章标题和摘要会生成规范化搜索文本与字符 n-gram 索引。
- 无关键词时优先使用 `[lastViewedAt+id]` 索引按浏览时间排序；有关键词或作者筛选时使用 n-gram / 作者索引缩小范围。
- 分页游标同时包含 `lastViewedAt` 和帖子 ID，在时间相同的情况下仍保持稳定、无重复、无遗漏。
- 同一帖子在 30 分钟内再次浏览只累加停留时长；间隔达到 30 分钟才计为新的一次访问。

### 3. X 页面内历史面板

- 面板使用普通 Light DOM，保留 Chromium 辅助功能树和浏览器自动化兼容性。
- 通过 CSS 选择器作用域隔离 X 的全局样式，避免链接下划线、字体和颜色被页面覆盖。
- 打开后根据 X 右侧栏搜索区域计算停靠位置，窗口缩放和 SPA 路由切换时重新同步。
- 面板只在打开时启动 3 秒一次的轻量状态检查；记录数量或最新浏览时间发生变化时才重新执行搜索并更新列表。
- 后台的 `history-changed` 通知用于即时刷新，状态检查用于处理跨标签页或通知丢失场景。

### 4. 安全与隐私边界

- 数据只写入当前浏览器配置文件中的 IndexedDB。
- 扩展没有远程 API、埋点、账号系统或上传接口。
- 只接受 `https://pbs.twimg.com` 的媒体地址；导入文件会校验帖子 ID、时间、作者和 URL。
- HTML 文本统一转义后再渲染，避免帖子正文或导入文件注入脚本。
- 清空历史和卸载扩展会删除本地数据；需要保留时请先导出 JSON 备份。

## 安装

### 从源码构建

环境要求：Node.js 18+，Chrome 116+ 或对应版本的 Edge。

```bash
git clone https://github.com/DescLee/x-you-have-seen.git
cd x-you-have-seen
npm install
npm run build
```

然后：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 打开右上角“开发者模式”。
3. 点击“加载未打包的扩展程序”，选择本项目的 `dist/` 目录。
4. 打开或刷新 X 页面，确认右下角出现历史入口。
5. 点击扩展图标可以打开侧边栏；在 X 页面点击右下角历史按钮可以打开内嵌面板。

Chrome 的站点访问设置需要允许扩展访问 `x.com` / `twitter.com`。扩展更新后，如果当前 X 标签页没有立即出现入口，请在扩展管理页点击“重新加载”，再刷新 X 标签页。

### 使用已打包版本

运行：

```bash
npm run package
```

脚本会执行检查并生成：

- `release/seen-0.1.0.zip`
- `release/seen-0.1.0.zip.sha256`

解压 ZIP 后，在扩展管理页加载解压目录即可。

## 开发与验证

```bash
npm run typecheck   # TypeScript 类型检查
npm test            # 运行核心测试
npm run build       # 构建 dist/
npm run check       # 类型检查 + 测试 + 构建
npm run package     # 检查后生成 ZIP 和 SHA-256
```

当前核心测试覆盖：

- 可见比例和停留时长判断。
- 重复帖子合并、30 分钟访问次数规则和并发写入。
- 中文、英文、emoji、子串、多关键词、作者、媒体和日期组合搜索。
- 文章封面 / 标题 / 摘要保存及文章内容搜索。
- 稳定分页、导入导出、容量与保留期限清理。
- 恶意 URL、脚本注入、非法导入和受限页面过滤。

浏览器回归脚本位于：

- `scripts/qa-capture.js`
- `scripts/qa-ui.js`
- `scripts/qa-inline.js`
- `scripts/qa-performance.js`
- `scripts/qa-collector-load.js`

这些脚本需要先用 Playwright CLI 启动名为 `seen` 的扩展测试会话。

## 项目结构

```text
src/
  background.ts      Service Worker：写入、搜索、导入导出、通知
  content.ts         X 页面采集器和内嵌历史面板
  db.ts              Dexie 数据库、合并、搜索和清理
  extract.ts         X 帖子 DOM 提取与安全判断
  model.ts           数据模型、规范化、校验和搜索类型
  ui.ts              独立历史页与设置页逻辑
  search-worker.ts   独立历史页搜索 Worker
  backup-worker.ts   备份导出 Worker
public/
  history.html       独立历史页 HTML
  ui.css             独立历史页样式
  manifest.json      MV3 扩展清单
scripts/
  build.mjs          esbuild 构建脚本
  package.mjs        ZIP / SHA-256 打包脚本
  qa-*.js            浏览器回归与性能脚本
tests/
  core.test.ts       核心逻辑测试
 dist/                构建产物，加载扩展时选择此目录
 release/             打包 ZIP 和校验文件
```

## 已知边界

- 当前产品面向桌面浏览器中的 X 网页，移动端 X 页面不在支持范围内。
- X 的 DOM 结构可能随产品更新变化；如果帖子提取突然失效，需要调整 `src/extract.ts` 中的选择器。
- 图片和文章封面依赖 X 当前仍可访问的 `pbs.twimg.com` 地址；原图失效时，正文和元数据仍会保留。
- 浏览历史按本机浏览器配置文件保存，不会在不同设备之间自动同步。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。Copyright 2026 DescLee。

可依据该许可证使用、修改及分发本项目，包括商业用途。分发时须保留适用的版权与许可声明、提供许可证副本，并标注对文件的修改；具体条款请参阅 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。第三方依赖仍适用各自的许可证。

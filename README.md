<div align="center">

# ⚡ Pulse 中文版 — 代理检测工具

**面向 Windows 的免费开源代理采集、批量检测与本地管理工具。**

支持 HTTP、HTTPS、SOCKS4、SOCKS5。既可以导入自己的代理，也可以从多个公开来源自动获取候选节点；检测结果实时显示，可用代理可保存到本地代理池。

[![Release](https://img.shields.io/github/v/release/822233/pulse-proxy-checker?include_prereleases&sort=semver)](../../releases)
[![Stars](https://img.shields.io/github/stars/822233/pulse-proxy-checker)](../../stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](../../releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20%2B%20Rust-orange)](https://tauri.app)

![Pulse 代理检测结果](docs/screenshots/pulse-results.png)

</div>

---

## 项目简介

**Pulse 中文版**是一款免费、开源的 Windows 桌面代理采集与检测工具。它把代理列表获取、连通性检测、出口 IP 信息解析和本地代理池管理整合在一个轻量界面中。你可以导入自己的代理，也可以自动获取公开代理候选列表，再批量检测可用性。

程序支持 **HTTP、HTTPS、SOCKS4、SOCKS5** 四种代理协议。对于检测成功的代理，程序会进一步获取出口 IP，并通过本地 GeoIP 数据库解析国家/地区、ISP 和 ASN，同时计算质量评分与风险等级。

检测过程主要在本机完成，不需要配置第三方评分 API，也没有第三方评分 API 的调用额度限制。

程序基于 Tauri、Rust、Node.js 和 Vite 构建。目前提供 Windows 免安装 ZIP 版本，无需安装程序；解压后运行 `Pulse.exe` 即可。

## 功能特性

- **三种工作模式**
  - 粘贴检测：导入自己的代理列表并批量检测。
  - 免费代理：从公开代理列表获取候选代理并自动检测。
  - 已保存代理：按协议保存可用代理，随时重新检测和清理。
- **四种代理协议**：HTTP、HTTPS、SOCKS4、SOCKS5。
- **实时检测进度**：逐条显示检测结果、成功数量、失败数量和进度；检测完成后可按实测延迟查看较快节点。
- **代理信息解析**：出口 IP、国家/地区、ISP、ASN。
- **质量与风险评估**：显示质量百分比和低、中、高风险等级。
- **多条件筛选**：按风险等级、国家/地区、最大延迟和最低质量筛选。
- **本地代理池**：按协议保存代理，自动去重，支持重新检测和删除失效节点。
- **复制与导出**：复制筛选后的可用代理，或导出为 TXT 文件。
- **离线 GeoIP 查询**：使用内置 DB-IP Lite 数据库在本地查询地理信息。
- **简体中文界面**：主要窗口、操作按钮、状态提示和项目文档均使用简体中文。

## 使用说明

### 1. 粘贴并检测代理

在「粘贴检测」页面选择代理协议，然后粘贴代理列表。支持以下格式：

```text
IP:端口
IP:端口:用户名:密码
IP:端口@用户名:密码
http://IP:端口
https://IP:端口
socks4://IP:端口
socks5://IP:端口
协议://用户名:密码@IP:端口
```

如果代理行没有指定协议，程序会使用页面上当前选择的协议。

### 2. 从公开来源获取代理

进入「免费代理」页面，选择协议并点击「自动获取并检测」。程序会从配置的公开代理列表来源获取候选节点，然后检测其连通性。

公开代理的质量、稳定性和安全性无法保证。请勿使用来源不明的公共代理传输密码、支付信息或其他敏感数据。

### 3. 管理已保存代理

在「已保存代理」页面切换 HTTP、HTTPS、SOCKS4、SOCKS5 分类，可以重新检测代理池、删除失效代理、复制或导出可用代理。

### 4. 导出并导入 Shadowrocket

检测完成后，可以使用「复制」或「导出」获取代理 URI 列表。导出文件为 TXT，每行一个代理 URI。导入 Shadowrocket 时，请确认节点协议与实际代理服务端协议一致。

> 注意：普通 HTTP 代理支持 CONNECT，不代表它就是使用 TLS 加密连接的 HTTPS 代理。程序中的协议分类取决于代理地址/检测方式，不能仅凭代理端口判断协议。

## 检测原理

Pulse 使用 Tauri 作为桌面外壳，Rust 负责原生桌面功能，Node.js 检测引擎负责代理检测，Vite 提供前端界面。

对每个代理，检测引擎会：

1. 通过代理连接轻量级 IP 查询端点，确认代理是否真正转发流量。
2. 获取代理出口 IP，并使用本地 DB-IP Lite 数据库查询国家/地区、ISP 和 ASN。
3. 根据延迟、匿名性和数据中心特征计算质量评分与风险等级。

实际检测结果取决于代理服务器状态、网络环境和目标测试端点。检测成功不代表代理长期稳定，也不代表代理可信或安全。

## 下载

前往 [GitHub Releases](../../releases) 下载 **Windows 免安装版**：

- 文件：`Pulse-Windows-Portable.zip`
- 使用方法：下载 ZIP → 解压到任意目录 → 运行 `Pulse.exe`
- 压缩包包含主程序 `Pulse.exe` 和检测引擎 `assets/PulseEngine.exe`，请保持两者的相对目录结构。
- 当前发布的是免安装 ZIP，不提供 Windows 安装程序；暂未发布 macOS 构建包。

## 从源码构建

以下命令按仓库当前脚本整理；检测引擎目前没有声明 `npm test`，Rust 侧提供 `cargo test` 单元测试。

环境要求：

- Node.js 18 或更高版本
- Rust stable
- 对应操作系统的 Tauri v2 构建依赖

安装检测引擎依赖并检查入口脚本语法（当前 host/package.json 未定义 `npm test`）：

```bash
cd host
npm install
node --check src/host.js
node --check src/cli.js
```

构建前端：

```bash
cd ../ui
npm install
npm run build
```

构建桌面应用：

```bash
cd ../src-tauri
cargo test
cargo tauri build
```

如需生成独立检测引擎资源，请按项目原有打包流程执行：

```bash
cd host
npm run pkg
```

## 项目结构

```text
├─ host/                    Node.js 代理检测引擎及 GeoIP 数据
├─ src-tauri/               Rust / Tauri 桌面程序
├─ ui/                      Vite 前端界面
└─ .github/workflows/       GitHub Actions 构建工作流
```

## 代理列表来源

「免费代理」功能在运行时从多个公开项目或服务获取候选代理，再由 Pulse 在本机进行连通性检测。当前配置的来源包括：

| 来源 | 支持协议 | 许可或说明 |
|---|---|---|
| TheSpeedX | HTTP、SOCKS4、SOCKS5 | 上游公开列表 |
| monosans | HTTP、SOCKS4、SOCKS5 | MIT |
| Proxifly | HTTP、SOCKS5 | GPLv3 |
| ProxyScrape | HTTP、SOCKS4、SOCKS5 | 免费服务条款以官方说明为准 |
| maximilianfeix/free-proxy-list | HTTP | 上游验证并按速度排序；MIT |
| litportnet/free-proxy-list | HTTP、SOCKS5 | 定时更新；MIT（数据许可另见上游说明） |

公开代理的在线率、速度和稳定性会随时间变化。列表来源的更新频率或上游验证结果不代表代理在你的网络环境中一定可用。Pulse 会重新进行本机检测，不将上述来源的代理列表作为本项目自有数据打包发布。请遵守各来源的使用条款。

## 隐私说明

代理检测在本机执行。网络请求主要包括：获取公开代理列表、连接用户提交或选择的代理，以及通过轻量级 IP 查询端点读取代理出口 IP。

请注意：使用公共代理意味着代理运营者可能观察或记录经过其服务器的流量。不要通过不可信代理传输敏感信息。

## GeoIP 数据与第三方声明

国家/地区、ISP 和 ASN 查询使用 **[DB-IP Lite](https://db-ip.com/db/lite.php)** 数据库（位于 `host/data/*.mmdb`），数据可按月更新。

DB-IP Lite 数据采用 **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** 许可。使用和再分发时必须保留署名。本程序在界面中显示所需的来源声明：

> IP Geolocation by DB-IP — https://db-ip.com

完整第三方声明请查看 [NOTICE.md](NOTICE.md)。

## 开源许可与致谢

Pulse 源代码采用 **MIT License**。你可以使用、修改和分发代码，但必须保留原有版权声明和许可文本。

本中文版本基于上游项目 [lewispour/pulse-proxy-checker](https://github.com/lewispour/pulse-proxy-checker) 修改。感谢原作者及所有代理列表来源项目的贡献者。

第三方 GeoIP 数据不属于 MIT 代码许可范围，须单独遵守 CC BY 4.0 署名要求。

## 贡献与反馈

欢迎提交 Issue 和 Pull Request，包括中文翻译修正、问题反馈、代理来源改进和功能建议。

---

**Pulse 中文版** — 让代理采集、批量检测和本地代理池管理更简单。

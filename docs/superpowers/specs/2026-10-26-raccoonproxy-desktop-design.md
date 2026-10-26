# RaccoonProxy Desktop 设计规格

日期:2026-10-26
状态:已确认(用户已就关键决策拍板)

## 目标

把现有的纯 Node 反代服务(`server.js`,OpenAI 兼容 API)封装成一个 **Windows 桌面客户端**:开箱即用、有品牌(logo/界面/UI)、可打包、发布到 GitHub 公开仓库并附带 Release 安装产物。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 仓库可见性 | **公开**,上传前剥离一切内置凭证 |
| 技术栈 | **Electron + electron-builder**(server.js 以子进程原样内嵌,零重写) |
| 命名 | 应用名 **RaccoonProxy**,仓库名 `raccoon-proxy-desktop` |
| 品牌约束 | **软件中不得出现任何"小浣熊"相关文字**(UI、README、接口响应均中性化;上游地址仅作为代码常量存在) |

## 架构

```
RaccoonProxy.exe (Electron)
├── 主进程 electron-main.js
│   ├── 窗口/托盘管理(关窗最小化到托盘,代理持续运行)
│   ├── child_process.fork(proxy/server.js) —— 启停受设置控制
│   ├── 设置持久化(userData/settings.json,明文 JSON,不含 .token)
│   └── IPC:getSettings/saveSettings/proxyControl/logs/status
├── preload.js(contextBridge 暴露最小 API)
└── renderer/ —— open-design 生成的界面(vanilla HTML/CSS/JS,无构建步骤)
```

- **代理进程**:`server.js` 的桌面版拷贝,改动点:①删除内置手机号/密码默认值;②`TOKEN_FILE` 由环境变量 `XHX_TOKEN_FILE` 指定(指向 userData);③`/v1/models` 的 `owned_by` 改为 `raccoon-proxy`;④品牌字样从注释中清除。其余逻辑(登录加密、iam/confirm、502 重试、401 重登、SSE 透传)原样保留。
- **凭证流**:设置页填写手机号/密码 → 主进程经环境变量注入子进程 → 子进程内存中使用;磁盘只落 userData 下的 settings.json 与 .token。

## 界面(3 页)

1. **仪表盘**:服务运行状态与开关、监听地址、Base URL / API Key 一键复制、上游 token 有效期(轮询 `/health`)、实时请求日志(子进程 stdout 透传)、模型列表 chips。
2. **设置**:手机号/区号/密码、端口、本地 API Key(可选)、启动时自动开启服务;保存后自动重启代理子进程。
3. **Playground**:选模型 + 输入消息,直接调本地 `/v1/chat/completions`(SSE 流式渲染),用于自检。

视觉:open-design 生成,浣熊吉祥物 logo,浅色/深色主题,中文文案,品牌只出现 "RaccoonProxy"。

## 错误处理

- 子进程崩溃:主进程捕获 exit,UI 显示"已停止 + 错误摘要",提供重启按钮。
- 登录失败(账号未配置/密码错):日志面板透出上游错误信息,设置页红点提示。
- 端口占用:监听失败时子进程以非零码退出,日志透出 `EADDRINUSE`。

## 测试与验收

- `node proxy/server.js` 以环境变量注入真实账号(仅本地测试,不入库),`/health` 返回 ok、chat completion 流式返回正文。
- 打包产物安装后,应用可启动、代理可开、Playground 可对话。
- 仓库中 `grep` 不到手机号/密码/.token 内容。

## 发布

1. `git init` + 首次 commit(已过泄漏检查)。
2. GitHub API 建公开仓库 `BlackTor-tor/raccoon-proxy-desktop`,推送代码(token 仅一次性用于 push URL,不落盘)。
3. 创建 Release `v1.0.0`,上传 NSIS 安装包与 portable exe。

## 范围外(YAGNI)

多账号管理、请求统计图表、自启动到系统服务、macOS/Linux 打包(后续按需加)、GUI 内修改模型列表。

<p align="center"><img src="assets/icon.png" width="96" alt="RaccoonProxy 图标"></p>

# RaccoonProxy

本地 OpenAI 兼容 API 网关桌面客户端(Windows)。

内置网关服务进程,把上游大模型以 **OpenAI 兼容 API** 的形式暴露在本地端口——装好即用,无需命令行。任何支持 OpenAI API 的工具(Cursor、Continue、ChatBox、openai SDK……)填一个本地地址即可接入。

## 功能

- **一键启停**:仪表盘开关网关服务,关窗最小化到托盘,服务持续运行
- **OpenAI 兼容**:`/v1/chat/completions`(支持 SSE 流式)、`/v1/models`、`/health`
- **动态模型目录**:模型列表实时来自上游目录(自动刷新,含 GLM-5-3、Kimi-K3、DeepSeek-V4.1-Flash、SenseNova-6.8 等),真实路由到不同模型
- **上游状态监测**:仪表盘实时显示上游/账号状态(每分钟探测、5 分钟全量刷新),token 失效自动重登,登录失败/上游不可达即时提示
- **自动登录**:账号只填一次,token 自动缓存与续期(30 天有效),失效自动重登
- **实时日志**:请求状态、耗时、上游错误实时可见
  - **Playground**:内置对话测试,流式输出,装完即可自检;**思考程度**可选(默认/关闭/低/中/高),模型的思考过程实时折叠展示;回答流式逐字渲染,等待/思考/生成全程有实时状态提示;**历史对话**子菜单自动保存最近 50 段对话(本地存储),可一键恢复、删除(支持撤销)
- **本地鉴权(可选)**:给本地端口加一道 Bearer API Key
- **每日签到(官方积分)**:服务启动自动领取官方每日登录奖励积分(与官方客户端一致,当日已领则自动跳过),仪表盘实时显示可用积分与明细,可手动补签;接口 `GET /api/points`、`POST /api/checkin`
- **软件更新**:设置页一键检查并下载最新版(网络不佳自动重试 3 次,仍失败可一键跳转 Releases 手动下载);**按客户端形态下载对应产物**——安装版下载 Setup 安装包,便携版下载便携版 exe 到同目录(退出后运行新文件完成升级);启动后自动检查新版本,发现更新弹窗提醒是否更新,可勾选「不再提醒这个版本」(仅对该版本静默,手动检查不受影响)

## 快速开始

1. 从 [Releases](../../releases) 下载安装包(`RaccoonProxy-Setup-x.x.x.exe`)或便携版(`RaccoonProxy-x.x.x-portable.exe`)
2. 打开 RaccoonProxy,在「设置」页填写上游账号的手机号与密码,保存
3. 仪表盘点亮服务开关
4. 在你的工具里这样接入:

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{"model":"SenseChat-5","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8317/v1", api_key="any-key")
resp = client.chat.completions.create(
    model="SenseChat-5",
    messages=[{"role": "user", "content": "用一句话介绍长城"}],
)
print(resp.choices[0].message.content)
```

> API Key 默认不校验(任意值可用);若在设置里配置了本地 API Key,则必须携带该值。
>
> `GET /v1/models` 返回上游实时模型目录;`GET /health` 返回上游状态(`upstream.state`:ok / login_failed / unreachable / no_account)与 token 有效期,可作为监控探针。

## 从源码运行

```bash
npm install
npm start        # 开发运行
npm run dist     # 打包 NSIS 安装包 + 便携版(输出在 dist/)
```

也可以脱离 Electron 单独跑网关进程:

```bash
XHX_PHONE=... XHX_PASSWORD=... node proxy/server.js   # 默认 http://127.0.0.1:8317
```

环境变量:`PORT` / `HOST` / `XHX_PHONE` / `XHX_PASSWORD` / `XHX_NATION_CODE` / `PROXY_API_KEY` / `XHX_TOKEN_FILE` / `XHX_CHECKIN_FILE`(签到状态文件)/ `XHX_CLIENT_PLATFORM`(签到上报的客户端平台标识,默认 `desktop-windows`)。

## 目录结构

- `electron-main.js` — Electron 主进程:窗口/托盘/子进程管理/设置持久化/IPC
- `preload.js` — contextBridge,向渲染进程暴露最小 API
- `renderer/` — 界面:`index.html`(结构)+ `styles.css`(Token 化样式)+ `app.js`(逻辑)
- `proxy/server.js` — 网关服务进程(纯 Node 标准库,零依赖)
- `assets/` — 图标与品牌资源

## 说明

- 账号凭证只保存在本机用户数据目录,不经过任何第三方
- 免费账号受上游每日积分限流
- 本项目仅供个人学习与自己账号的合法使用

## License

MIT

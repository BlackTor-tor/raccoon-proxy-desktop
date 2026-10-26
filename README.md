# RaccoonProxy

本地 OpenAI 兼容 API 网关桌面客户端(Windows)。

内置网关服务进程,把上游大模型以 **OpenAI 兼容 API** 的形式暴露在本地端口——装好即用,无需命令行。任何支持 OpenAI API 的工具(Cursor、Continue、ChatBox、openai SDK……)填一个本地地址即可接入。

## 功能

- **一键启停**:仪表盘开关网关服务,关窗最小化到托盘,服务持续运行
- **OpenAI 兼容**:`/v1/chat/completions`(支持 SSE 流式)、`/v1/models`、`/health`
- **自动登录**:账号只填一次,token 自动缓存与续期(30 天有效),失效自动重登
- **实时日志**:请求状态、耗时、上游错误实时可见
- **Playground**:内置对话测试,流式输出,装完即可自检
- **本地鉴权(可选)**:给本地端口加一道 Bearer API Key
- **模型**:SenseChat-5 / SenseChat-5-Vision / sensenova-u1-pro / sensenova-u1.5-lite

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

环境变量:`PORT` / `HOST` / `XHX_PHONE` / `XHX_PASSWORD` / `XHX_NATION_CODE` / `PROXY_API_KEY` / `XHX_TOKEN_FILE`。

## 目录结构

- `electron-main.js` — Electron 主进程:窗口/托盘/子进程管理/设置持久化/IPC
- `preload.js` — contextBridge,向渲染进程暴露最小 API
- `renderer/` — 界面(仪表盘 / 设置 / Playground)
- `proxy/server.js` — 网关服务进程(纯 Node 标准库,零依赖)
- `assets/` — 图标与品牌资源

## 说明

- 账号凭证只保存在本机用户数据目录,不经过任何第三方
- 免费账号受上游每日积分限流
- 本项目仅供个人学习与自己账号的合法使用

## License

MIT

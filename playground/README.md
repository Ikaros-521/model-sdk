# 本地模型测试台

独立于 AI Employee OS 的简易浏览器测试程序。无需数据库、登录或另外安装前端框架。

## 启动

在 SDK 包目录执行：

```bash
npm ci --workspaces=false
npm run build
npm run playground
```

打开 <http://127.0.0.1:4318>。Windows 可从仓库根目录运行：

```powershell
cd packages/model-sdk
npm run playground
```

端口被占用时，通过进程环境变量 `MODEL_SDK_PLAYGROUND_PORT` 指定其他端口。服务只监听127.0.0.1，不能用于公网部署。Ctrl+C 停止服务。安装SDK的tarball后，也可在安装包目录执行 `node playground/server.mjs`。

## 使用

1. 选择内置平台，或选择自定义端点及对应协议。支持 Completions、Responses、Anthropic Messages 和 Google 原生协议，也提供 DeepSeek 官方 Messages 模式。
2. 输入 API key，选择/手填模型 ID。点击模型旁的 ↻ 读取模型目录；内置平台目录来自SDK本地元数据，网络模型发现是否可用取决于平台。
3. 输入消息并点击“发送测试”，或按 Ctrl/⌘+Enter。默认流式输出，可关闭切换为完整响应。
4. 可以继续发送以验证多轮上下文及原始 reasoning/replay；变更连接、密钥、系统指令或推理配置后，下次请求自动开始新的上下文。
5. 查看耗时、输入（含缓存读写）/输出/总Tokens，展开诊断查看事件和完整结果。点击“停止”取消本地请求，不能保证远端停止计算或计费。

“阿里云百炼 · DashScope”使用常规中国区 `https://dashscope.aliyuncs.com/compatible-mode/v1` 端点（OpenAI 兼容协议）；“阿里云百炼 · Anthropic 协议”使用 DashScope 的 Anthropic 兼容代理端点（Claude Code 兼容），同一百炼 API key，两种入口按需选择。内置模型 ID 只是当前主流建议快照、非权威清单：输入 API key 后点击模型旁 ↻ 会请求平台的模型列表接口，返回你账户可见的模型并可直接选用；百炼的 Anthropic 代理路由不提供列表接口，↻ 返回本地建议。目录之外的模型 ID 可直接手动输入：测试台沿用该平台目录首条的协议、端点与兼容开关，把它注册成一次性的路由占位后再发请求，因此“能调用”不代表该 ID 的真实上下文长度、图片或推理能力已被校验。每个请求都新建 provider，↻ 的发现结果不会保留到下一次发送，需要复用目录外 ID 时直接手填或再次 ↻。`Qwen Token Plan` 套餐入口与常规百炼是不同配置，不能混用套餐密钥或按同一计费入口理解。其他地区或协议请使用对应的自定义端点；目录建议与发现结果都不代表真实账户已逐一验证。

失败诊断只回传稳定错误码与 `Model request failed (CODE)` 形式的摘要，不返回上游正文或堆栈。错误码优先取自真实 HTTP status，不受网关正文措辞影响：`AUTH` 为 401/403，`QUOTA` 为 402 或明确的额度/余额文案，`ENDPOINT_NOT_FOUND` 为 404，`TIMEOUT` 含 408，`INVALID_REQUEST` 为 400/413/422，`RATE_LIMIT` 为 429，`SERVER` 为 5xx，`TRANSPORT` 是连接中断；status 为 400 且正文说明上下文超限时仍保留 `CONTEXT_WINDOW_EXCEEDED`，不被状态码粗化。常用码含义：`MODEL_NOT_FOUND` 是 SDK 本地目录未收录该 ID、请求尚未发出（改用自定义端点或手输目录外 ID 即可）；`ENDPOINT_NOT_FOUND` 只在上游真的回复 404 时出现，通常是 API 根地址路径不对（少 `/v1`、代理应用 ID 写错）；`INVALID_REQUEST` 配 400 时多为请求体被拒，OpenRouter 对无法路由的模型 ID 会返回 400 却把正文写成 “Not found / No endpoints found…”，这时该改的是模型 ID（含 `:free` 之类后缀）而不是地址。`ENDPOINT_NOT_FOUND` 与 `MODEL_NOT_FOUND` 分属上游应答与本地拦截，排查方向不同，不要混为一谈。

高级选项包含系统指令和推理强度。工具调用仅展示，不执行，也不会把未执行的调用继续带入下一轮。前端当前主要测试文本和推理，不提供图片上传或工具执行UI。后台另提供 `/api/embed` 测试接口，返回向量维度与摘要；embedding的完整使用也可参考SDK示例。

## 密钥与安全

- 页面不使用 localStorage、sessionStorage、cookie 或文件保存密钥。刷新后需要重新输入；服务不持久化配置或密钥，不记录请求正文。
- 选择的模型端点将收到你的密钥和测试内容，调用可能产生费用。只对你信任的端点使用凭据。浏览器扩展及本机其他程序仍属于你的本机信任边界。
- 服务检查Host/Origin和自定义请求头，无跨域授权；仅精确静态路径可读取文件，API正文上限256KiB，错误响应不返回原始上游正文或stack。请求带 `authorization`、`x-api-key` 等凭据类请求头时会被拒绝，响应只回被拒的**头名**、绝不回其值；`cookie` 不在此列——浏览器按主机而非端口共享 cookie，把它们算作环境凭据会让本机任何跑过 Web 服务的端口都打不开测试台，而服务只从请求正文取模型密钥，cookie 无法到达模型端点。
- 这是本机开发工具，不是带用户鉴权的多用户服务；不要反向代理公开，不要把真实密钥写入代码或提交。

## 验证

`test/playground.test.ts` 使用本地HTTP模型fixture验证静态路径、安全、目录、普通/流式单次调用、原生Responses签名多轮、取消/超时、脱敏、发现、目录外模型 ID 的内置平台发送与embedding。所有自动化验证零真实外部模型调用。真实平台可用性请在页面输入你自己的配置验证。

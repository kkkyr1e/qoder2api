# Qoder2API

[![CI](https://github.com/kkkyr1e/qoder2api/actions/workflows/ci.yml/badge.svg)](https://github.com/kkkyr1e/qoder2api/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

> Beta：这是非官方社区项目，与 Qoder、Alibaba 或 Anthropic 无隶属关系。请仅使用自己的账号与额度，并遵守相关服务条款。

新用户、朋友分发和 Agent 代配置请优先阅读：[`AGENT_QUICKSTART.md`](./AGENT_QUICKSTART.md)。

把 Qoder 账号能力桥接成本机 Anthropic Messages API 和 OpenAI Chat Completions API，供 Claude Code CLI、Claude Code VS Code 扩展及其他 Agent 使用。

项目是 TypeScript/Node.js 实现，不依赖本机安装 Qoder IDE 或 Qoder CLI；只需要 Qoder PAT。

## 当前能力

- Anthropic `POST /v1/messages`：流式、非流式、多轮消息和 Claude Code 工具调用。
- OpenAI `POST /v1/chat/completions`：流式、非流式和 `tool_calls`。
- 从 Qoder 账号实时读取模型目录、thinking effort 和上下文窗口。
- 请求级模型、effort、context window 透传；Claude 多出的 effort 默认映射到 Qoder 最近的有效档位，设置 `QODER_STRICT_EFFORT=1` 可改为严格 400。
- Qoder job token 失效后自动换取新会话并重试尚未输出内容的请求。
- 上游最多 2 并发，502/503/504/429 自动退避重试。
- 下游 SSE 心跳、客户端断开取消、长推理超时错误语义。
- 10 MB 请求限制、近似 token 计数、标准错误响应和健康检查。

## 安装与启动

推荐给新用户的方式：

```bash
git clone https://github.com/kkkyr1e/qoder2api.git
cd qoder2api
npm install
cp .env.example .env
# 编辑 .env，把 QODER_PAT 换成自己的 PAT
npm run quickstart
```

另开终端检查：

```bash
npm run doctor
npm run models
```

把桥接配置安全合并到 Claude Code（会先备份原 `settings.json`）：

```bash
# Performance + medium，并允许 /model 切换
npm run install:claude

# 或固定默认入口为 Ultimate + max + 1M
npm run install:claude:ultimate
```

重启 Claude Code 或 Reload VS Code 后输入 `/model`。不要使用 `--bare` 验证模型发现，因为 bare 模式会跳过网关模型启动发现。

也可以不用 `.env`，直接传环境变量：

```bash
npm run build

# macOS / Linux
QODER_PAT="pt-..." npm start

# Windows PowerShell
$env:QODER_PAT = "pt-..."
npm start
```

默认监听 `127.0.0.1:8963`。PAT 可在 <https://qoder.com/account/integrations> 创建。

不要把 PAT 写入仓库或启动脚本。长期运行建议通过系统环境变量、服务管理器的 secret 配置或凭据管理器注入。

## Claude Code CLI 与 VS Code 扩展

CLI 和 VS Code 扩展共享 `~/.claude/settings.json`。Windows 路径为 `%USERPROFILE%\.claude\settings.json`：

仓库提供两个可以直接复制或通过 `--settings` 使用的配置：

- `claude-settings.example.json`：Performance + medium，允许在 `/model` 中切换全部 Qoder 模型。
- `claude-settings.ultimate-max-1m.json`：固定默认入口为 Ultimate + max + 1M。

```json
{
  "model": "sonnet",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8963",
    "ANTHROPIC_API_KEY": "local-bridge-key",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-qoder-ultimate[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-qoder-performance",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-qoder-efficient",
    "CLAUDE_CODE_EFFORT_LEVEL": "medium",
    "API_TIMEOUT_MS": "3600000"
  }
}
```

如果设置了服务端 `QODER_BRIDGE_API_KEY`，这里的 `ANTHROPIC_API_KEY` 必须使用相同值；未设置时代理只依靠 `127.0.0.1` 限制访问。

VS Code 扩展修改配置后需要 Reload Window 或重开 Claude 会话。图形侧边栏和 CLI 使用同一 Claude Code 引擎，因此模型、effort、工具和权限行为一致。

快速验证：

```bash
claude -p "只回复 OK" --settings ./claude-settings.example.json
```

Claude Code 2.1.129+ 会在普通启动时读取 `/v1/models`。开启示例中的 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 后，输入 `/model` 即可看到标记为 “From gateway” 的 Qoder 模型，无需再次修改配置文件。用 `/effort low|medium|high|xhigh|max` 或模型选择器底部的左右键调整 effort；桥接会按 Qoder 实时目录校验。

## 模型与 effort

服务启动时使用 PAT 请求 Qoder 的账号模型目录：

```text
GET https://center.qoder.sh/algo/api/v2/model/list?Encode=1
```

这与 Qoder CLI `--list-models` / SDK `getAvailableModels()` 使用的是同一类服务端目录。它包含账号当前可用模型、`thinking_config`、effort、默认上下文窗口等，因此不要求用户安装 Qoder IDE 或 CLI。

查看当前目录：

```bash
curl http://127.0.0.1:8963/v1/models
curl -X POST http://127.0.0.1:8963/v1/models/refresh
```

Claude Code 网关发现使用 `claude-qoder-<模型 key>`，例如：

```bash
claude --model claude-qoder-ultimate
claude --model claude-qoder-qmodel_38max
claude --model claude-qoder-dmodel
```

实际支持项以 `/v1/models` 为准。模型目录暂时不可用时服务会使用内置目录，并在响应的 `source` 字段中标记为 `fallback`。

对于不提供命名 effort 的普通模型和 Claude Code 辅助模型调用，桥接保留 Qoder 服务端默认行为；不会伪造一个不存在的 effort。只提供 thinking 开关但不提供档位的模型同理。

### 上下文窗口

Qoder 服务端目录有自己的原始默认值；为了让 Claude Code 的 `/context` 与模型真实上限一致，桥接会把所有支持 1M 的网关模型默认发布为 `[1m]`。当前常见值：

| 模型 | Qoder 原始默认 | Claude 网关默认 | 可选 |
|---|---:|---:|---|
| Ultimate | 200K | 1M | 200K / 400K / 1M |
| Performance | 272K | 1M | 272K / 400K / 1M |
| Qwen3.8-Max | 200K | 1M | 200K / 400K / 1M |
| Efficient / Lite | 180K | 180K | 180K |

Claude 模型 ID 使用 `[1m]` 时，Claude Code 会发出 1M context beta；桥接会将其转换为 Qoder 的 `parameters.context_length=1000000`。因此 `claude-settings.ultimate-max-1m.json` 中的 `opus -> claude-qoder-ultimate[1m]` 会让客户端和 Qoder 两端都使用 1M。

Claude Code 网关发现当前只消费模型 `id` 和 `display_name`，不会读取 Qoder 的逐模型 effort 列表。因此原生 `/effort` UI 仍可能显示五档。桥接会在模型名中显示真实档位，并将 CC 不支持的档位映射到最近、相同距离时偏强的有效档位。例如 Qwen3.8-Max：`high -> xhigh`、`max -> xhigh`。响应头 `X-Qoder-Requested-Effort` 与 `X-Qoder-Effort` 分别显示请求值和实际值。设置 `QODER_STRICT_EFFORT=1` 可恢复严格 400。

如果要在服务端强制所有客户端使用 Ultimate + max + 1M，可在 `.env` 额外加入：

```dotenv
QODER_ANTHROPIC_MODEL=ultimate
QODER_REASONING_EFFORT=max
QODER_CONTEXT_WINDOW=1000000
```

强制后 `/model` 仍能显示模型，但所有 Anthropic 请求都会被服务端覆盖为 Ultimate；如果希望选择器真实切换，不要设置这三个强制变量。

原生 Claude family 名称的默认映射：

| Claude family | Qoder |
|---|---|
| Opus | `ultimate` |
| Sonnet | `performance` |
| Haiku | `efficient` |

可用 `QODER_ANTHROPIC_MODEL` 强制覆盖所有 Anthropic 请求；一般更推荐让请求中的 `model` 逐请求生效。

effort 读取顺序：

1. `QODER_REASONING_EFFORT`
2. 请求的 `reasoning_effort` / `output_config.effort`
3. Anthropic `thinking.budget_tokens` 映射
4. Qoder 模型目录中的默认 effort

最终写入 Qoder 请求的：

```text
parameters.reasoning_effort
parameters.enable_thinking
parameters.reasoning_budget_tokens
model_config.is_reasoning
```

响应头会回显 `X-Qoder-Model`、`X-Qoder-Effort` 和 `X-Qoder-Context-Window`，用于确认桥接层实际选择。

## 工具调用语义

通过 Claude Code 使用时，执行的是 Claude Code 当前注册的工具，不是 Qoder IDE 的内置工具：

1. Claude Code 把 Read、Edit、Bash、MCP 等工具 schema 发给桥接。
2. 桥接转换为 Qoder 上游接受的 OpenAI `tools` 格式。
3. 模型返回 `tool_calls`。
4. 桥接转换为 Anthropic `tool_use`。
5. Claude Code 在本机按自己的权限、hooks、sandbox 和 MCP 配置执行。
6. 工具结果再经桥接发给模型。

因此权限控制仍属于 Claude Code；Qoder IDE 的工具权限和插件不会自动参与。桥接支持一次响应中的多个并行工具调用，并会保持每个 `tool_use_id` 的关联。

## 长推理和超时

默认值：

| 配置 | 默认值 |
|---|---:|
| 下游 SSE ping | 15 秒 |
| 上游无数据空闲超时 | 15 分钟 |
| 单请求总超时 | 60 分钟 |
| Claude Code `API_TIMEOUT_MS` 建议值 | 60 分钟 |

空闲或总超时现在会返回错误事件，不再伪装成正常 `message_stop`。Claude Code 断开连接时桥接会主动取消上游 HTTP 请求，避免继续无效消耗额度。

可通过以下环境变量调整：

- `QODER_SSE_PING_INTERVAL_MS`
- `QODER_SSE_IDLE_TIMEOUT_MS`
- `QODER_SSE_REQUEST_TIMEOUT_MS`

上游服务是否在收到 TCP 取消后立即终止后台推理由 Qoder 服务端决定，桥接只能保证及时关闭本地上游连接。

## API 与运维

| 路径 | 说明 |
|---|---|
| `GET /health` | 会话代次、目录来源、过期时间、并发状态 |
| `GET /v1/models` | 当前账号模型与参数能力 |
| `POST /v1/models/refresh` | 立即刷新模型目录 |
| `POST /v1/session/refresh` | 手动重建 Qoder 会话 |
| `POST /v1/messages/count_tokens` | 保守近似计数，不是 Anthropic 官方 tokenizer |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /v1/chat/completions` | OpenAI Chat Completions API |

环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `QODER_PAT` | 是 | Qoder PAT |
| `QODER_PORT` | 否 | 默认 `8963` |
| `QODER_BRIDGE_API_KEY` | 否 | 本地 API 鉴权值 |
| `QODER_ANTHROPIC_MODEL` | 否 | 强制 Anthropic 模型 |
| `QODER_REASONING_EFFORT` | 否 | 强制 effort |
| `QODER_CONTEXT_WINDOW` | 否 | 强制目录支持的上下文窗口 |
| `QODER_LOG_PROMPTS` | 否 | `1` 时记录 prompt 预览；默认不记录 |
| `QODER_STRICT_EFFORT` | 否 | `1` 时拒绝模型不支持的 effort；默认映射到最近有效档位 |

## 开发验证

```bash
npm run build
npm test
```

模型目录和 effort 会随 Qoder 服务端变化；不要把 README 中的示例当作永久能力列表，以运行中的 `/v1/models` 为准。

## 当前限制

- `count_tokens` 是保守估算，不是 Anthropic 官方 tokenizer；
- Claude Code 的 Gateway Model Discovery 只消费模型 ID/显示名，原生 effort UI 不能按 Qoder 模型隐藏无效档位；桥接会在模型名和响应头中展示实际能力与映射结果；
- 暂未实现 OpenAI Responses API，因此 Codex CLI/IDE 还不能直接接入；Pi 等 Chat Completions 兼容 Agent 可以接入；
- Qoder 服务端是否在客户端断开后立即停止后台推理由 Qoder 决定。

## License

[Apache License 2.0](./LICENSE)

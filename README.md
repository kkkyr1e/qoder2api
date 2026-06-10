# Qoder2API

把 Qoder 反代理成 Anthropic Messages API，让 Claude Code 通过本地代理使用 Qoder 后端。

## 快速开始

### 1. 获取 Qoder PAT

打开 Qoder 插件（VS Code / JetBrains）→ 设置 → 复制你的 Personal Access Token。

网址：https://qoder.com/account/integrations，创建个人访问令牌

格式类似：`pt-xxxxxxxx_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### 2. 安装 & 启动

```bash
git clone <本仓库>
cd qoder2api
npm install
npm run build

# 启动（PAT 二选一传入）
QODER_PAT="你的PAT" npm start
# 或
node dist/index.js "你的PAT"
```

看到以下输出说明启动成功：

```
[bridge] listening http://127.0.0.1:8963
[bridge]   Anthropic: /v1/messages (for Claude Code)
```

### 3. 配置 Claude Code

在 `~/.claude/settings.json`（或 `%USERPROFILE%\.claude\settings.json`）的 `env` 里加两项：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8963",
    "ANTHROPIC_AUTH_TOKEN": "any-non-empty-value"
  }
}
```

> `ANTHROPIC_AUTH_TOKEN` 填任意非空字符串即可，代理不校验。
> 如果你之前有 `ANTHROPIC_API_KEY`，**删掉它**——两者同时存在会导致 401。

重启 Claude Code，完成。

### 4. 验证

```bash
# 快速验证（不改持久化配置）
claude -p "你好" --bare --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8963","ANTHROPIC_AUTH_TOKEN":"x"}}'
```

## Windows 后台运行

### 手动启动/停止

```bash
# Git Bash
bash qoder-service.sh start    # 启动（后台运行，关终端不会断）
bash qoder-service.sh status   # 查看状态
bash qoder-service.sh stop     # 停止
bash qoder-service.sh restart  # 重启
```

### 开机自启

```cmd
qoder-service.bat install
```

会把启动脚本复制到 Windows 启动目录，下次登录自动运行。卸载用 `qoder-service.bat uninstall`。

> **注意**：首次使用需编辑 `qoder-service.sh` 和 `start-qoder-service.vbs` 里的 `QODER_PAT` 和路径。

## 配置说明

| 项 | 值 | 说明 |
|---|---|---|
| 模型 | `ultimate` | 对应 Qoder 最强模型，所有请求强制使用 |
| 上下文窗口 | 1,000,000 tokens | 1M context |
| 思考模式 | `is_reasoning: true` | 开启 |
| 推理强度 | `reasoning_effort: max` | 最高 |
| 监听地址 | `127.0.0.1:8963` | 仅本机，`QODER_PORT` 可改 |

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `QODER_PAT` | 是 | Qoder Personal Access Token |
| `QODER_PORT` | 否 | 监听端口，默认 `8963` |

## 常见问题

**Q: Claude Code 报 `Invalid API key`**
A: 确保 settings.json 里用的是 `ANTHROPIC_AUTH_TOKEN`（不是 `ANTHROPIC_API_KEY`），值随便填。

**Q: Claude Code 报 `401 x-api-key和Authorization不可以同时存在`**
A: `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` 同时存在了。删掉 `ANTHROPIC_API_KEY`。

**Q: 长对话或复杂推理时连接断开**
A: 已内置 5 分钟空闲超时 + 30 秒心跳 ping。如果仍断，检查网络代理/VPN 是否有自己的超时。

**Q: 日志里出现 `[stream] idle timeout, closing`**
A: 上游 Qoder 在 5 分钟内没有返回任何数据。通常是网络问题或 Qoder 服务端超时。

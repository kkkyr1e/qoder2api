# Qoder2API Agent 快速启动与配置手册

本文档供用户本人或代操作的 Coding Agent 使用。目标是在新电脑或新项目中快速完成：

1. 获取 Qoder PAT；
2. 启动 Qoder2API；
3. 配置 Claude Code CLI 与 VS Code 侧边栏；
4. 在 `/model` 中选择账号实时可用的 Qoder 模型；
5. 切换 effort 与 1M context；
6. 更换 PAT、刷新登录会话、模型权限和可用额度。

> 给 Agent 的一句话任务：阅读本文件，先确认当前 Shell 和工作目录，再按步骤执行；不得输出、提交或记录完整 PAT。

## 0. Agent 最短执行流程

用户只需把下面这句话交给 Agent：

```text
请完整阅读 AGENT_QUICKSTART.md，按“Agent 最短执行流程”完成安装与验证。需要 PAT 时暂停让我填写；不要输出、记录或提交 PAT。默认安装可在 /model 切换的配置，除非我明确要求 Ultimate + max + 1M。
```

Agent 按以下顺序执行：

```bash
# 1. 进入仓库根目录，必须能看到 package.json
cd /path/to/qoder2api

# 2. 安装并创建本地环境文件
npm install
cp .env.example .env

# 3. 暂停，让用户把自己的 Qoder PAT 填入 .env
# QODER_PAT=YOUR_QODER_PAT_HERE

# 4. 编译和测试
npm run build
npm test

# 5. 启动桥接；这是长驻进程，应放在独立终端或后台任务
npm run start:env
```

另一个终端继续：

```bash
cd /path/to/qoder2api

# 6. 安装 Claude 全局配置并保留原设置备份
npm run install:claude

# 如果用户明确要求固定默认 Ultimate + max + 1M，改用：
# npm run install:claude:ultimate

# 7. 验证服务和实时模型目录
npm run doctor
npm run models

# 8. 普通启动 Claude Code。不要使用 --bare
claude
```

Claude Code 启动后执行：

```text
/model
```

成功标准：

```text
doctor: status=ok
catalogSource=remote
catalogModels>0
/model 中出现 From gateway 的 Qoder 模型
普通文本请求成功
Read 工具调用成功
```

VS Code 用户还需要执行 `Developer: Reload Window`，并创建全新 Claude 会话。

如果任一步失败，再阅读本文后续对应章节；不要跳过错误继续配置。

## 1. 前置要求

- Windows、macOS 或 Linux；
- Node.js 20 或更高版本；
- npm；
- 一个可正常登录的 Qoder 账号；
- Qoder Personal Access Token；
- 如需使用 Claude Code：Claude Code CLI 2.1.129 或更高版本；
- 如需 VS Code 侧边栏：安装 Anthropic Claude Code 扩展。

检查版本：

```bash
node --version
npm --version
claude --version
```

本项目不要求安装 Qoder IDE 或 Qoder CLI。模型目录和权限通过 PAT 从 Qoder 服务端实时读取。

## 2. 创建 Qoder PAT

1. 打开 <https://qoder.com/account/integrations>；
2. 登录准备使用额度的 Qoder 账号；
3. 创建 Personal Access Token；
4. 复制以 `pt-` 开头的 token；
5. 不要把 token 发到聊天、截图、Git、日志或 README。

如果 PAT 已经出现在公开仓库、聊天记录或截图中，应立即在 Qoder 控制台吊销并重新生成。

## 3. 首次安装

进入 Qoder2API 仓库根目录。该目录必须包含 `package.json`：

```bash
cd /path/to/qoder
npm install
cp .env.example .env
```

Windows Git Bash 示例：

```bash
cd /c/Users/<用户名>/Desktop/qoder
cp .env.example .env
```

Windows PowerShell 示例：

```powershell
Set-Location C:\Users\<用户名>\Desktop\qoder
Copy-Item .env.example .env
```

打开 `.env`，至少修改：

```dotenv
QODER_PAT=YOUR_QODER_PAT_HERE
QODER_PORT=8963
QODER_BRIDGE_API_KEY=local-bridge-key
```

`QODER_PAT` 是 Qoder 凭据；`QODER_BRIDGE_API_KEY` 只是本机 Agent 访问桥接时使用的本地密码，两者不是同一个东西。

## 4. 启动服务

在仓库根目录执行：

```bash
npm run quickstart
```

该命令会编译并在前台启动服务。终端需要保持打开。

另开终端检查：

```bash
cd /path/to/qoder
npm run doctor
npm run models
```

正常状态应包含：

```text
status            ok
catalogSource     remote
catalogModels     大于 0
```

也可以直接检查：

```bash
curl -s http://127.0.0.1:8963/health
```

## 5. 配置 Claude Code CLI 与 VS Code

### 5.1 可在 `/model` 自由切换

在 Qoder2API 仓库根目录执行一次：

```bash
npm run install:claude
```

安装器会：

- 备份原来的 `~/.claude/settings.json`；
- 保留原有 hooks、permissions 和 MCP；
- 配置本地 Qoder2API；
- 开启 Claude Code Gateway Model Discovery；
- 移除会阻止 Qoder 模型出现的旧 `availableModels` allowlist；
- 默认使用 Qoder Performance + medium。

然后完全退出旧 Claude Code 会话，普通启动：

```bash
claude
```

不要使用 `--bare`，因为 bare 模式会跳过网关模型启动发现。

进入后执行：

```text
/model
```

应看到标记为 `From gateway` 的 Qoder 模型。

### 5.2 默认 Ultimate + max + 1M

在仓库根目录执行：

```bash
npm run install:claude:ultimate
```

重启 Claude Code 后，新会话默认使用：

```text
Model:   Qoder Ultimate
Effort:  max
Context: 1,000,000
```

这是默认入口，不是服务端强制；仍可以用 `/model` 临时选择其他模型。

### 5.3 VS Code 侧边栏重新加载

安装配置后：

1. 关闭所有旧 Claude Code 会话；
2. 在 VS Code 按 `Ctrl+Shift+P`；
3. 执行 `Developer: Reload Window`；
4. 新建 Claude Code 会话，不要 Resume 修改配置前的旧会话；
5. 执行 `/model`。

若侧边栏仍提示登录或 API key，可在 VS Code 设置中搜索 `Claude Code: Disable Login Prompt` 并启用。

## 6. 选择模型、effort 和 context

### 模型

在 Claude Code 中：

```text
/model
```

命令行也可直接指定：

```bash
claude --model claude-qoder-ultimate
claude --model claude-qoder-qmodel_38max
claude --model claude-qoder-dmodel
```

### Effort

在 Claude Code 中：

```text
/effort
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
```

每个模型支持的 effort 不同。查看实时列表：

```bash
npm run models
```

不支持的 effort 会返回 400，并列出该模型支持的档位。

### Context

Qoder 目录保留原始默认值；Claude 网关会将真实支持 1M 的模型默认发布为 `[1m]`，使 Claude `/context` 与 Qoder 实际请求都采用 1M：

| 模型 | Qoder 原始默认 | Claude 网关默认 | 可选 |
|---|---:|---:|---|
| Ultimate | 200K | 1M | 200K / 400K / 1M |
| Performance | 272K | 1M | 272K / 400K / 1M |
| Qwen3.8-Max | 200K | 1M | 200K / 400K / 1M |
| Efficient / Lite | 180K | 180K | 180K |

Claude 模型 ID 的 `[1m]` 会被桥接转换为 Qoder：

```text
parameters.context_length=1000000
```

Claude Code 的网关 `/model` 协议目前不读取逐模型 effort metadata，所以 `/effort` 可能仍显示通用五档。模型显示名会包含 Qoder 真实档位；桥接默认把额外档位映射到最近、同距离时偏强的有效值，例如 Qwen3.8-Max 的 `high/max -> xhigh`。设置 `QODER_STRICT_EFFORT=1` 可改为严格报错。

## 7. 查看实时模型列表

人类友好格式：

```bash
npm run models
```

原始 API：

```bash
curl -s http://127.0.0.1:8963/v1/models
```

Claude Code `/model` 列表来自同一个接口。只有 ID 以 `claude-` 开头的模型会被 Claude Code 网关发现，因此本项目对外使用 `claude-qoder-*` ID。

## 8. 重新加载新的模型权限或额度

下面几种“刷新”含义不同，Agent 必须先判断是哪一种。

### 8.1 Qoder 后台刚开放了新模型或模型参数

无需重启桥接，执行：

```bash
curl -s -X POST \
  -H 'x-api-key: local-bridge-key' \
  http://127.0.0.1:8963/v1/models/refresh
```

然后检查：

```bash
npm run models
```

让 Claude Code 重新加载 `/model`：

```bash
rm -f ~/.claude/cache/gateway-models.json
```

完全退出 Claude Code，再普通运行：

```bash
claude
```

VS Code 侧边栏还需要执行 `Developer: Reload Window`。

### 8.2 同一个 PAT 的登录会话过期或异常

桥接会自动重建失效会话。也可以手动执行：

```bash
curl -s -X POST \
  -H 'x-api-key: local-bridge-key' \
  http://127.0.0.1:8963/v1/session/refresh
```

检查 `session_generation` 是否增加：

```bash
curl -s http://127.0.0.1:8963/health
```

### 8.3 更换了 Qoder 账号或新 PAT

1. 停止当前 Qoder2API；
2. 修改 `.env` 中的 `QODER_PAT`；
3. 重新运行：

```bash
npm run quickstart
```

仅调用 `/v1/session/refresh` 不会重新读取磁盘上的 `.env`；更换 PAT 后必须重启进程。

重启后依次执行：

```bash
npm run doctor
npm run models
rm -f ~/.claude/cache/gateway-models.json
```

然后重启 Claude Code 或 Reload VS Code。

### 8.4 Qoder 套餐、额度或白名单刚发生变化

套餐变化通常在重新认证后生效。推荐顺序：

1. 确认 Qoder 账号页面已经显示新套餐/额度；
2. `POST /v1/session/refresh`；
3. `POST /v1/models/refresh`；
4. `npm run models`；
5. 清理 Claude gateway model cache；
6. 重启 Claude Code/Reload VS Code。

若仍未变化，生成一个新 PAT，写入 `.env` 并重启 Qoder2API。

> 模型目录刷新只更新模型权限和参数，不会凭空增加 Qoder Credits。Credits、限额和重置时间由 Qoder 账号及服务端决定。

## 9. 常见故障

### `npm error ENOENT ... package.json`

当前目录不是 Qoder2API 根目录。先执行：

```bash
cd /path/to/qoder
```

确认：

```bash
ls package.json
```

### `API Error: 400 无效的api key`

常见原因：

- Claude Code/VS Code 仍在使用修改配置前的旧进程；
- `ANTHROPIC_BASE_URL` 仍指向旧网关；
- `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY` 冲突；
- 客户端 key 与 `QODER_BRIDGE_API_KEY` 不一致。

执行：

```bash
cd /path/to/qoder
npm run install:claude
```

然后彻底重启 Claude Code 或 Reload VS Code。

### `/model` 没有 Qoder 模型

检查：

```bash
npm run models
rm -f ~/.claude/cache/gateway-models.json
```

确认配置中存在：

```json
"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
```

不要使用 `claude --bare`。

### Qoder 仍在运行，但 Agent 提前返回

推荐客户端配置：

```json
"API_TIMEOUT_MS": "3600000"
```

桥接默认每 15 秒发送 ping、15 分钟上游 idle timeout、60 分钟总 timeout。超时会返回错误，不会伪装成正常结束。

## 10. 安全要求

- `.env` 已被 Git 忽略，不要强制提交；
- 不要在命令行参数中直接传 PAT，避免进入 shell history；
- 不要打印完整 `~/.claude/settings.json`，其中可能有其他 API key；
- 分享项目时只分享 `.env.example`，不要分享 `.env`；
- 每个朋友应使用自己的 Qoder PAT；
- 如果桥接不只监听本机，必须设置高强度 `QODER_BRIDGE_API_KEY` 并额外增加网络访问控制。

## 11. Agent 执行检查清单

Agent 完成配置后应报告以下结果，不得报告完整 token：

```text
[ ] 当前工作目录包含 package.json
[ ] Node.js >= 20
[ ] .env 存在且 QODER_PAT 非占位值
[ ] npm run build 成功
[ ] npm run doctor: status=ok
[ ] catalogSource=remote
[ ] catalogModels > 0
[ ] npm run models 能列出模型
[ ] Claude settings 已备份并合并
[ ] Claude 普通启动（非 --bare）
[ ] /model 能看到 From gateway 的 Qoder 模型
[ ] 简单文本请求成功
[ ] Read 工具调用成功
```

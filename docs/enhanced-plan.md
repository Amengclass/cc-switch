# CC Switch 增强版 — 远程主机统一控制面

> **定位**:在 farion1231/cc-switch 基础上 **Fork**,保持上游完整(不裁剪),新增 **SSH 远程主机管理**。
> **目标**:「**一处配置、多机生效**」的统一控制平面(定义 Provider 于一处,应用到本机 + 任意远程主机),**不是**单纯的文件同步工具。
>
> 与原版的差异:
> - 原版 Web 版(端口 17666)是「在服务器上开网页,改服务器自己的配置」;
> - 增强版是「**本机 GUI 直连任意远程主机,直接读写远端 `~/.claude/settings.json`**」。
>
> **同步策略**:不裁剪上游,远程能力作为独立新增层叠加。上游同步 = 纯 `git merge`,零冲突。

---

## 范围总览

**保留(上游完整,不做裁剪):**
- 全部既有功能:多 CLI 供应商切换、MCP、Prompts、Skills、会话管理、WebDAV/S3 云同步、深链等

**新增(本项目的核心):** SSH 远程主机管理 —— 连接 → 读远端配置 → 切换 Provider → 原子写回 → 清理冲突环境变量 → 明确提示生效方式;并延伸出远程会话管理、Docker 容器目标。新增部分只读写远端 `~/.claude/`,不碰上游既有逻辑。

---

## 已完成 ✅

### 远程主机连接与管理
- 远程主机 CRUD(名称、host、port、用户名、密码认证),配置存 SQLite
- 测试连接(russh,超时控制)
- 密码用 Windows DPAPI 加密保存(`~/.cc-switch/remote_passwords.json`)
- 读取远端 `~/.claude/settings.json` 并在 GUI 展示当前 Provider / 模型 / env 现状

### 远程切换 Provider
- 对远端执行供应商切换:env 块合并 → 原子写回(远端临时文件 + rename)
- 切换失败回滚(保留远端原文件 `.bak`)
- 切换后明确提示生效方式(本机/远程、claude 运行中/未运行)

### 目标选择器(本机 / 服务器 / 容器)
- 头部连体胶囊式选择器,选服务器后供应商当前高亮 + 切换走远端
- 编辑当前供应商保存后原子写回远端
- 容器目标支持(Docker exec,方案 B):`docker ps` 列表 + 容器下拉
- 下拉可滚动(`max-h-[50vh]` + 细滚动条)
- 聚焦样式与全局 `*:focus-visible` 蓝框一致

### 远程功能面板
- **远程会话**:浏览/查看消息/删除远端 `~/.claude/projects/*.jsonl`(复用本机解析,FileOps)
- **远程 MCP**:读/写/增/删远端 `~/.claude.json` 的 `mcpServers`(原子写回)
- **远程 Prompts**:`~/.cc-switch/prompts.json` 存多提示词列表 + 启用那条原子写入 `~/.claude/CLAUDE.md`,与本地 SQLite 完全对称。列表/添加/编辑/删除/启用切换全功能,乐观更新 + toast 提示
- **远程 Skills**:远端 `~/.cc-switch/skills/` SSOT + `skills.json` + symlink/copy 同步,与本地完全对称。列出/删除/导入已有/ZIP 安装/切换应用全功能,跟随 `skill_sync_method` 和 `skill_storage_location` 设置

### Docker 容器支持
- exec 通道(`connection::exec_command`) + 容器列表(`docker ps` 解析)
- `DockerExecFileOps`(容器内文件操作,原子写 = base64 + 临时文件 + mv)
  - **写入方案**：`docker exec -i <容器> sh -c 'base64 -d > <tmp> && mv <tmp> <path>'`，数据通过 SSH channel stdin 管道分块（64KB/块）流式传入，不嵌入命令字符串，无文件大小限制。`connection::exec_command_with_stdin` 封装：`channel_open_session` → `exec` → `data()` 分块写入 → `eof()` → 读输出
- `RemoteTarget` 枚举(宿主机 SFTP / 容器 exec)
- settings/mcp/prompt/skills/sessions/env_clean 全部切为 `<F: FileOps>` 泛型,容器自动获得全部功能
- 前端 `remoteContainerId` 贯穿各面板,按目标分流

### Skills ZIP 安装机制

> 本机 / 远端宿主机 / 远端容器 共用同一套 ZIP 解压 + 扫描逻辑（`extract_local_zip` + `scan_skills_in_dir`），区别仅在第 4 步「搬进 SSOT」的传输方式。

**本机流程：**
1. **本机解压**：`extract_local_zip` → 临时目录（支持 zip 炸弹预算、symlink 解析、`..` 路径防护）
2. **扫描**：`scan_skills_in_dir` → 递归找含 `SKILL.md` 的子目录
3. **去重**：查 SQLite → 取安装名
4. **搬进 SSOT**：`std::fs::copy_dir_recursive(skill_dir, ssot_dir)` — 本地磁盘递归复制，毫秒级
5. **注册**：SQLite INSERT + 计算 content_hash
6. **同步**：创建 symlink 或 copy 到应用目录

**远端宿主机流程：**
- 步骤 1~3 同上
- 步骤 4 `upload_dir_to_remote`：先 `collect_dirs_recursive` 收集子目录 → 远端 `mkdir -p`；再 `collect_files_recursive` 收集所有文件(含二进制) → 每个文件 `std::fs::read` → SFTP `create` + `write` + `flush`
- 步骤 5~6：写远端 `skills.json` + 创建 symlink

**远端容器流程：**
- 步骤 1~3 同上
- 步骤 4 `upload_dir_to_container`：先 `docker exec mkdir -p` 建目录；再每个文件 base64 编码 → `docker exec -i` + stdin 管道(`channel.data()` 64KB/块)传入 → `base64 -d > .ccswitch.tmp && mv .ccswitch.tmp path`（原子写）
- 步骤 5~6：写远端 `skills.json` + 创建 symlink（一次 exec_with_stdin 合并）

| | 本机 | 宿主机 | 容器 |
|---|---|---|---|
| 解压 | `std::fs` | ← 同左 | ← 同左 |
| 搬进 SSOT | `copy_dir_recursive` | SFTP 逐文件 | docker exec + stdin 管道 |
| 原子写 | 本地 mv 原子 | SFTP create 新文件 | tmp + mv 原子 |
| 注册 | SQLite | skills.json SFTP 写 | skills.json stdin 管道 |

### FileOps 抽象
- `FileOps` trait(存在/读头尾行/读目录/删除/软链接等)
- 三个实现:`LocalFileOps`(std::fs)、`RemoteSftpFileOps`(SFTP)、`DockerExecFileOps`(docker exec)
- 所有远端模块(settings/mcp/prompt/skills/sessions/env_clean)只写一次,通过泛型适配本机/远端/容器

### 冲突环境变量清理
- 扫描远端 shell 配置:`~/.bashrc`、`~/.zshrc`、`~/.profile`、`~/.zshenv`、`/etc/environment`
- 识别与目标 Provider 冲突的 `ANTHROPIC_*` 导出(见附录)
- 一键清理:注释或删除 + `.bak` 备份 + 展示 diff + 二次确认

### Claude Code 安装检测
- 通过 SSH `command -v claude` 检测远端安装状态
- 面板徽标 + 测试连接展示

### UI 修复与打磨
- **Sonner toast 修复**:portaling 到 document.body + `pointerEvents:auto`,解决模态抽屉打开时 toast X 点不了的问题(根因:Radix 模态 Dialog 设置 `body { pointer-events: none }`)
- **Sonner 关闭按钮位置**:修正到右上角(覆盖 sonner 默认左上角定位)
- **目标选择器可滚动**:主机/容器下拉框 `max-h-[50vh]` + 可见细滚动条
- **目标选择器聚焦样式**:与全局 `*:focus-visible` 保持一致,不下拉特殊处理

### 图像拦截钩子(纯文本模型保护)
- 三道闸,防止纯文本模型(deepseek/glm 经火山引擎)因上下文含有图片块触发 `400 Model only support text input`
  - **PreToolUse `Read`**:拦截图片/PDF 文件读取
  - **PreToolUse `*screenshot*`**:拦截 MCP 截图工具,根本不让截图发生
  - **PostToolUse `mcp__*`**:兜底扫描所有 MCP 工具返回结果,含 base64 图片标记则 `decision: block` 隐藏
- 残余局限:用户直接拖拽/粘贴进 prompt 的图片不经过任何工具,拦不住;遇到 400 请 `/compact` 或 `/clear`

### 构建与基础设施
- 构建脚本 `C:\build\build-exe.ps1`(规避火绒 `sysdiag` 文件锁 LNK1105)
- 推送到 GitHub fork `https://github.com/Amengclass/cc-switch`

---

## 待完成 ⏳

### 功能增强

| 事项 | 说明 |
|---|---|
| 广播模式 | 选中 N 台主机 + 本机,一键应用同一 Provider(真正的「一处配置、多机生效」) |
| 密钥认证 | 支持私钥文件 `~/.ssh/id_*` / ssh-agent;数据模型已预留 `auth_method` 字段 |
| `~/.ssh/config` 兼容 | 解析别名、ProxyJump/跳板机配置 |
| 远端「发现」安装 Skills | skills.sh 市场搜索 → 安装到远端。**约束：远端不能连外网。**方案：cc-switch 本地下载 → 上传到远端 SSOT → `ln -s` |
| 远端「从备份恢复」Skills | 本地备份 → 恢复到远端 SSOT |
| 远程切换应用到全部模型槽位 | 支持现有「应用到全部」预设行为 |
| 团队共享与审计 | 切换记录、操作日志、只读成员视图 |

### 基座裁剪

| 事项 | 说明 |
|---|---|
| 移除 Codex / Gemini / Claude Desktop 模块 | 相关路由、UI 入口、依赖;需确认是否仍要做 |

### 构建与发布

| 事项 | 说明 |
|---|---|
| 打包测试 | 独立 exe 测试(Win/macOS),README 更新 |

---

## 里程碑记录(M0 起)

| 状态 | 里程碑 | 内容 | 验收 |
|---|---|---|---|
| ✅ | M0 | fork + 构建环境搭建 + 基线可编译可运行 | `pnpm install` + `cargo build` 通过,应用能启动 |
| ✅ | M1 | 新增 `remote/` 模块骨架 + 依赖就绪 | russh/keyring 依赖编译通过,空命令可注册 |
| ✅ | M2 | 远程主机基础(CRUD/连接/读远端 settings.json) | hosts 表 + 前端页面 + 密码走钥匙串 |
| ✅ | M3 | 远程切换 + 原子写回 + 生效提示 | env 块替换 + .bak + EffectReport 提示 |
| ✅ | M4 | 冲突环境变量清理 | 扫描 ANTHROPIC_* → 注释 + .bak |
| ✅ | M5 | 远程会话管理 | SFTP 列 ~/.claude/projects/*.jsonl |
| ✅ | 目标选择器 | 本机/服务器选择器 | 头部选择器;选服务器后供应商当前高亮+切换走远端;编辑当前供应商保存后原子写回远端 |
| ✅ | 编辑同步修复 | 编辑供应商同步远端 | 判定改为 `provider.id === currentProviderId`(DB is_current,SSOT),不靠 base_url 猜测 |
| ✅ | exec 通道 | 远端执行命令 | `connection::exec_command`;用于检测安装状态、Docker exec 等 |
| ✅ | 安装检测 | Claude Code 安装检测 | `command -v claude` + 哨兵判断;面板徽标 |
| ✅ | 远程会话 | 远程会话前端闭环 | 目标选服务器 → 浏览/查看/删除远端 jsonl(FileOps) |
| ✅ | 远程 MCP | 远程 MCP 编辑 | 读写远端 `~/.claude.json` mcpServers(原子写回) |
| ✅ | 远程 Prompts | 远程 Prompts 基础管理 | 编辑远端 `~/.claude/CLAUDE.md`（单文件） |
| ✅ | 远程 Prompts SSOT | 远端 Prompts 对称管理 | 远端 `~/.cc-switch/prompts.json` + 启用项原子写入 `~/.claude/CLAUDE.md`,列表/添加/编辑/删除/启用切换全功能,乐观更新 + toast |
| ✅ | 远程 Skills | 远程 Skills 基础管理 | 列出/删除远端 `~/.claude/skills/` 目录 |
| ✅ | 远程 Skills SSOT | 远端 Skills SSOT 重构 | 远端 SSOT + skills.json + symlink/copy,导入已有/ZIP/删除/切换全功能,跟随设置 |
| ✅ | 容器 stdin 管道 | 容器文件写入 stdin 管道 | docker exec -i + channel.data(),无文件大小限制 |
| ✅ | 容器批量扫描 | 导入已有容器批量扫描 | 一个 shell 脚本一次 exec 收集所有源目录技能 |
| ✅ | toggle 合并 | 容器 toggle 合并 exec | 读 JSON → 修改 → 写 JSON + 操作链接合并为一次 exec_with_stdin |
| ✅ | Docker 容器 | Docker 容器目标(方案 B) | FileOps + RemoteTarget + 全部面板泛型 + ZIP/导入支持容器 |
| ✅ | 推送 | 推送到 GitHub fork | `https://github.com/Amengclass/cc-switch` |
| 🔄 | M6 | 打包测试(密钥认证延后) | 独立 exe + 前端运行 |

---

## 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Tauri 2.x + Rust**(跟随 fork) | 已定,沿用原栈 |
| 前端 | **React**(跟随 fork) | 已定,沿用原栈 |
| 存储 | **SQLite**(沿用 `~/.cc-switch/cc-switch.db`) | 兼容既有生态(如 Raycast 扩展读同一 db);新增 `hosts`、`host_switches` 表 |
| SSH 库 | **`russh` + `russh-sftp`**(纯 Rust async) | 原 `ssh2` 在 Windows 需 vendored-openssl(编译要 Perl+NASM,风险高);russh 纯 Rust 无 C 工具链依赖,契合既有 tokio 异步栈 |
| 远程文件 | **`russh-sftp`** | settings.json / shell profile / sessions JSONL 的读写 |
| 原子写回 | 远端**临时文件 + rename** | 与本机 `settings.json` 写入策略一致,中断不留半文件 |
| 凭据加密 | **Windows DPAPI**(`CryptProtectData`) | 原 `keyring` 在非域 Windows 上 `CRED_PERSIST_ENTERPRISE` 只存登录会话、换进程即丢;DPAPI 绑定用户账户、跨进程/重启稳定。密文 base64 存 `~/.cc-switch/remote_passwords.json` |
| env 扫描 | 手写正则 + SFTP 读取 | 无需额外依赖,覆盖 bash/zsh 两类 profile |

**关键取舍说明:**
- **`russh` 而非 `ssh2`**:`ssh2` 在 Windows 上静态编译 OpenSSL 需要 Perl + NASM,构建链风险高;`russh` 纯 Rust,无 C 工具链,与 tokio 栈契合,单机与后续广播并发都适用。
- **密码优先,密钥二期**:贴合「主机名+密码」的最朴素心智;数据模型上已留 `auth_method` 字段,密钥不返工。
- **不 shell 调 `ssh`**:为支持「密码认证 + 程序内读写 + 精确的错误回传」,走 `russh` 而不是调用系统 ssh/sshpass。

---

## 目录结构

> 标注说明:`【保留】` = 上游原有,未改动;`【新】` = 本项目新增;`(删除 ...)` = 计划裁剪。

```
cc-switch/                     # fork 自 farion1231/cc-switch
├── src/                       # React 前端(裁剪后仅 Claude Code)
│   ├── components/
│   ├── pages/
│   │   ├── Providers/         # 【保留】供应商切换(本机)
│   │   ├── Mcp/               # 【保留】MCP 管理(仅 Claude)
│   │   ├── Prompts/           # 【保留】CLAUDE.md 管理
│   │   ├── Skills/            # 【保留】Skills 管理
│   │   ├── Sessions/          # 【保留】本机会话管理
│   │   └── RemoteHosts/       # 【新】远程主机:列表/详情/连接态
│
└── src-tauri/                 # Rust 后端
    ├── src/
    │   ├── commands/
    │   │   ├── provider/      # 【保留】本地切换逻辑
    │   │   ├── mcp/ prompts/ skills/ sessions/   # 【保留】(裁剪非 Claude)
    │   │   └── remote/        # 【新】远程命令薄封装(调 remote/ 模块)
    │   ├── remote/            # 【新】SSH 远程核心
    │   │   ├── mod.rs
    │   │   ├── connection.rs  # 连接池/认证(密码、密钥预留)、超时、重试
    │   │   ├── sftp_io.rs     # SFTP 读写封装(下载/上传/临时文件+rename/备份)
    │   │   ├── settings.rs    # 远端 settings.json 解析/合并/原子写回
    │   │   ├── env_clean.rs   # 【新】shell profile 冲突 env 扫描/清理
    │   │   ├── sessions.rs    # 【新】远端会话 JSONL 浏览/删除/resume
    │   │   └── effect.rs      # 【新】切换生效方式判定与提示文案
    │   ├── fsops.rs           # 【新】FileOps trait(存在/读头尾行/读目录/删除/软链接) + LocalFileOps / RemoteSftpFileOps / DockerExecFileOps 三实现
    │   ├── db/                # SQLite:migrations 新增 hosts / host_switches
    │   └── ...
    └── tauri.conf.json
```

---

## 构建方法(Windows 开发机)

> **必须用 `C:\build\build-exe.ps1`,不要直接 `cargo build --release`。**
> 踩坑实录:`cargo build --release`(未设 `/DEBUG:NONE`)全量编译,多次撞火绒 `sysdiag` 文件锁(LNK1105 / 错误码 1224),重试 5 次仍失败;改用脚本第 1 次即成功。

**流程**
1. 前端有改动 → 先 `pnpm build:renderer`(dist 由 `--features tauri/custom-protocol` 嵌入 exe)
2. **必须先杀进程**：`Stop-Process -Name cc-switch -Force`，否则 exe 被锁报 os error 5，cargo 重试 12 次全部 LNK1105
3. 删旧产物：`Remove-Item ...\cc-switch.exe -Force` + `Remove-Item ...\build.log -Force`
4. 跑 `C:\build\build-exe.ps1`(脚本内部 `Set-Location` 到 `src-tauri`)
5. 启动：`Start-Process -FilePath ...\cc-switch.exe`

> **一键构建命令**（含停进程+清理+编译+启动）：
> ```powershell
> Stop-Process -Name cc-switch -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Remove-Item "C:\Users\Ameng\Desktop\claude_woker\cc-switch\src-tauri\target\debug\cc-switch.exe" -Force -ErrorAction SilentlyContinue; Remove-Item "C:\Users\Ameng\Desktop\claude_woker\cc-switch\src-tauri\build.log" -Force -ErrorAction SilentlyContinue; Set-Location C:\Users\Ameng\Desktop\claude_woker\cc-switch; pnpm build:renderer; C:\build\build-exe.ps1
> ```

**脚本关键点(规避火绒 sysdiag LNK1105)**

| 项 | 值 |
|---|---|
| 构建目标 | debug(不带 `--release`) |
| 链接调试符号 | `RUSTFLAGS=-C link-arg=/DEBUG:NONE` |
| 符号生成 | `CARGO_PROFILE_DEV_DEBUG=0` |
| 并行度 | `CARGO_BUILD_JOBS=2` |
| 重试 | 最多 12 次;`build.log` 出现 `error[`(真实编译错误)才停,仅 LNK1105 则继续 |
| 产物 | `src-tauri\target\debug\cc-switch.exe`(约 67 MB) |

---

## 附录

### 冲突环境变量名单(ANTHROPIC_*)

```
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL
ANTHROPIC_MODEL
ANTHROPIC_SMALL_FAST_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_CUSTOM_HEADERS
ANTHROPIC_PROXY_URL
```

扫描命中规则:`export ANTHROPIC_<上述名单>=...` 或 `set -x ANTHROPIC_...`;命中即提示冲突并纳入清理候选。

### 切换生效方式提示

| 场景 | 提示内容 |
|---|---|
| 本机 · claude 未运行 | 「已写入 `~/.claude/settings.json`,下次启动 `claude` 生效」 |
| 本机 · claude 运行中 | 「热重载已生效;若未开启热重载,重启当前会话生效」 |
| 远程 · claude 未运行 | 「已写入远端 `~/.claude/settings.json`,SSH 登录后运行 `claude` 即生效」 |
| 远程 · claude 运行中 | 「新会话立即生效;已运行会话按热重载生效」 |
| 任一 · 清理过冲突 env | 「已清理冲突变量,请 `source ~/.bashrc` 或重新登录终端;原值已备份至 `settings.bak`」 |

### 风险与对策

| 风险 | 对策 |
|---|---|
| fork 后上游同步成本 | 按需 merge,阶段性质检;关键修复手动 cherry-pick |
| 远端 SFTP 原子 rename 在部分 SFTP-only 服务器覆盖行为不一致 | 先在目标机型验证;失败回滚到 .bak |
| env 清理误删用户配置 | 强制 .bak + diff 预览 + 二次确认,删除而非覆盖 |
| 远端写权限不足(`~/.claude` 不可写) | 切换前预检可写,不可写则报明确错误 |
| 密码明文风险 | DPAPI 加密;提供「每次询问」选项 |
| 热重载对远端是否真生效不确定 | 提示文案不承诺「实时生效」,只描述确定行为,并给出验证命令 |
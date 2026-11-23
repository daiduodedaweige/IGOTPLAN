# I GOT PLAN

个人任务、积分和奖励看板。网页与数据接口由同一个 Node.js 进程提供，数据默认保存在项目的 `data/state.json`，浏览器本地存储用于迁移旧记录和恢复未保存内容。

点击页面右上角的太阳或月亮按钮可切换浅色、深色主题。主题选择保存在当前浏览器，刷新页面后继续使用；首次访问默认使用浅色主题。

“新建任务”和“新建奖励”默认折叠，点击标题按钮展开表单，再次点击可收起。手动收起保留当前填写内容，提交创建后自动清空表单并收起。

新建任务的备注已替换为 TodoList：输入子任务后点击“添加子任务”或按回车逐条追加；提交主任务时，输入框中尚未追加的内容也会一并保存。任务卡片支持继续添加、勾选和删除子任务，显示完成数量；子任务勾选不改变主任务积分。每个任务最多 100 项子任务，每项最多 80 字。已有任务的备注继续显示。

有子任务时，必须全部勾选才能点击“完成”或“再次完成”；未全部勾选时按钮禁用并提示剩余数量。没有子任务的任务仍可直接完成，已完成的单次任务仍可点击“恢复”。

“我的任务”中的每项任务默认折叠，点击标题或右侧箭头可独立展开、收起。折叠时显示日期、类型、积分及完成进度；展开后可操作子任务、修改任务名和积分、完成或删除任务。当前页面内的勾选、保存和列表更新会保留各任务的展开状态。

完成任务后，标题旁显示红色“已完成”印章，折叠状态下也能看到；点击完成时播放一次盖章动画。长期任务的印章同时显示完成次数，单次任务恢复后移除印章。深浅主题均适配，系统开启减少动态效果时停用盖章动画。

此版本将数据格式升级为版本 2，并兼容读取旧版本的记录和备份。更新后需重启 Node.js 服务，再刷新所有页面，以启用子任务保存；网页与旧后端版本不匹配时会停止载入并显示重启提示。

“导出数据”和“导入文件”位于保存状态右侧的“数据管理”菜单中；点击空白处或按 Esc 可关闭菜单。“重新加载”仅在加载失败或保存冲突时显示，恢复正常后自动隐藏。保存失败时仍可使用“重试保存”，检测到旧数据或未保存副本时显示对应的迁移、恢复入口。导入文件前仍需确认替换完整看板。

## 启动与访问

需要 Node.js 24 或以上。运行所需的网页资源已在 `assets/` 中，后端使用 Node.js 内置模块，无需安装新的依赖。

在项目所在的服务器上执行，将路径替换为实际项目目录：

```bash
cd /absolute/path/to/IGOTPLAN
npm start
```

在个人电脑另开终端，将 `your-user@your-server` 替换为实际的 SSH 用户和服务器地址，保持隧道连接：

```bash
ssh -N -L 8000:127.0.0.1:8000 your-user@your-server
```

打开 <http://localhost:8000>。若本地 8000 被占用，可改为 `-L 18000:127.0.0.1:8000`，再访问 <http://localhost:18000>。更换本地端口不会改变服务端数据，但该端口下浏览器的旧记录和恢复副本仍受浏览器来源隔离。

不要通过 `file://` 或 `python -m http.server` 启动新版本；页面需要 Node.js 提供的 `/api/state`。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8000` | 后端端口 |
| `DATA_DIR` | 项目下的 `data` | 数据目录；相对路径始终相对于项目目录 |
| `BACKUP_KEEP` | `30` | 自动保留的历史版本数量 |
| `API_URL` | `http://127.0.0.1:8000` | 独立备份工具读取数据的地址 |
| `BACKUP_DEST` | 无 | 定时备份的独立存储目录 |

例如 `PORT=18000 DATA_DIR=/绝对路径/igotplan-data npm start`。不要将数据目录放在 `assets/`、项目根目录、项目的上级目录或 `/tmp`。若项目放在 NFS 上，默认的数据目录也位于 NFS；本项目采用单进程 JSON 存储。此版本按个人 SSH 访问设计，公网或多人使用需另行配置认证、HTTPS 和网络入口。

## 保存与旧数据迁移

- 页面加载服务器成功后才能编辑；状态栏显示加载、保存、成功、失败或冲突。
- 保存失败时保留页面内容，并尽力保存每个标签页各自的本地恢复副本。可以“重试保存”或“导出数据”。关闭页面时浏览器会提示有未保存修改。
- 多页面发生版本冲突时，保留本地内容并停止覆盖。先导出，再重新加载服务器记录，核对后处理。
- 初次使用且服务器未初始化时，若当前浏览器存在旧记录，会显示“导入浏览器旧数据”。导入前展示数量和积分概要，确认后保存，原浏览器记录保留。
- 服务器已有数据时，不会自动迁移浏览器记录。可使用“导出浏览器旧数据”，核对后再通过“导入文件”替换。
- 未保存副本会在下次打开同一来源时提供恢复入口。若其版本已落后于服务器，恢复后只供查看和导出，不会自动覆盖服务器。
- “保留服务器数据”会在确认后删除列出的本地未保存副本；如需保留，应先恢复并导出。
- 导入文件前请导出当前记录。支持新版本导出文件、v2 原始状态对象和 v1 任务数组；导入会替换完整看板。

若旧数据在其他浏览器或访问地址下，新页面无法直接读取。可在旧入口仍能访问时使用旧页面导出，或在其开发者工具控制台运行以下代码，将输出复制成 JSON 文件，再在新网页导入：

```javascript
localStorage.getItem("daily-plan-board:v2") || localStorage.getItem("daily-plan-board:v1")
```

## 文件保护与恢复

只有一个后端进程可以写入同一数据目录。保存依次执行版本检查、旧版本备份、临时文件写入和文件同步、重命名替换。数据目录权限为 `0700`，文件为 `0600`；HTTP 只开放页面和静态资源，不开放数据、备份、日志和源码配置。

已有数据损坏、被移走或无法读取时，接口返回错误并停止自动写入。不要直接删除文件来“修复”。先保留原文件，停止服务并使用有效备份恢复。

普通退出会释放 `.writer-lock`。同一主机上的旧进程已不存在时，下次启动会自动归档旧锁并重新取得锁；`.stale-lock-*` 是小型锁记录，不是数据备份。其他主机的锁、权限不明的进程或不完整的锁不自动删除。确需手工处理时，先核对 `.writer-lock/owner.json` 中的主机和 PID，确认没有写入进程后再归档该锁目录。不要在有进程竞争启动时清理 `.stale-lock-*`。

### 备份

每次覆盖前将上一版本保存在 `data/backups/revision-*.json`，默认保留 30 份。该目录和正式数据在同一存储上，不能作为唯一备份。

服务运行时，可通过接口取得一致快照并写入独立存储：

```bash
npm run backup -- /绝对路径/独立存储/igotplan-backups
```

独立快照保留最近 30 份。不要把目标放在静态资源目录；应选择与原数据故障域不同的位置。尚未初始化的服务器会跳过备份。自定义后端端口时，设置对应的 `API_URL`。

### 恢复

先停止服务（前台运行按 `Ctrl+C`；systemd 运行使用下面的停止命令）。然后执行：

```bash
npm run restore -- /绝对路径/备份文件.json
npm start
```

服务正在运行时，恢复工具会因写入锁而拒绝操作。工具校验备份，保留当前原文件（包括损坏内容）为 `data/backups/before-restore-*.json`，再写入恢复内容并提高版本号，避免旧标签页覆盖恢复结果。`before-restore` 文件不自动清理，确认恢复成功后自行归档。恢复后刷新网页，核对任务、奖励和积分。

## 常驻运行

调试时可用 `tmux new -s igotplan` 后执行 `npm start`，按 `Ctrl+B`、`D` 分离，通过 `tmux attach -t igotplan` 返回。tmux 不提供开机自启和进程异常恢复。

长期使用可在服务器的实际登录会话中配置用户级 systemd。复制服务示例后，先编辑安装的 `igotplan.service`：将 `/absolute/path/to/IGOTPLAN` 替换为实际项目目录，将 `/absolute/path/to/node` 替换为 `command -v node` 输出的绝对路径。Node.js 升级或项目移动后也要更新这些路径。

```bash
mkdir -p ~/.config/systemd/user
cp deploy/igotplan.service.example ~/.config/systemd/user/igotplan.service
${EDITOR:-vi} ~/.config/systemd/user/igotplan.service
systemctl --user daemon-reload
systemctl --user enable --now igotplan.service
loginctl enable-linger "$USER"
```

如果配置 linger 需要主机管理员权限，由管理员在主机上设置。验证 `loginctl show-user "$USER" -p Linger` 返回 `Linger=yes`，并实际验证退出 SSH 后服务仍可访问、异常退出后能重启，以及主机重启后能启动。

```bash
systemctl --user status igotplan.service
systemctl --user restart igotplan.service
systemctl --user stop igotplan.service
journalctl --user -u igotplan.service -n 100 --no-pager
```

日志使用 journal，由主机的 journald 保留策略控制；需要调整日志大小及时间上限时由主机管理员统一配置。应用日志只记录错误类别、运行信息和版本，不输出完整任务内容。

### 每日独立备份

先选择独立存储位置，再创建 `~/.config/igotplan/backup.env`（权限 `0600`）：

```text
BACKUP_DEST=/绝对路径/独立存储/igotplan-backups
```

复制备份服务示例后，同样编辑安装的服务文件，将项目和 Node.js 路径替换为实际值。如修改后端端口，同步修改其中的 `API_URL`。先手动验证一次，再启用定时器：

```bash
cp deploy/igotplan-backup.service.example ~/.config/systemd/user/igotplan-backup.service
cp deploy/igotplan-backup.timer.example ~/.config/systemd/user/igotplan-backup.timer
${EDITOR:-vi} ~/.config/systemd/user/igotplan-backup.service
systemctl --user daemon-reload
systemctl --user start igotplan-backup.service
systemctl --user enable --now igotplan-backup.timer
systemctl --user list-timers igotplan-backup.timer
journalctl --user -u igotplan-backup.service -n 30 --no-pager
```

默认每天 03:00 后延迟最多五分钟运行，错过的任务会在定时器恢复时补执行。

### 更新代码

停止服务，更新源文件并执行 `npm test`，保留 `DATA_DIR` 中所有文件及独立备份，然后启动服务。不要同时启动 tmux 和 systemd 两套实例。需要增加域名直连时，再实施反向代理、HTTPS、登录认证和相应主机名校验配置。

## 更换为白猫 Tororo

从 [Live2D 官方 Tororo / Hijiki 页面](https://www.live2d.com/zh-CHS/learn/sample/tororo-hijiki/)下载包含 `runtime` 目录的模型 ZIP，放到本项目目录。白猫是 Tororo，黑猫是 Hijiki。保留压缩包的原始内容，导入工具会选择白猫。

```bash
python3 scripts/import_tororo.py /完整路径/模型压缩包.zip --check-only
python3 scripts/import_tororo.py /完整路径/模型压缩包.zip
```

当前已使用白猫 Tororo，资源位于 `assets/live2d/Tororo/`。鼠标移动时白猫会转头、转动眼睛，点击画布播放互动动作，动作结束后自动回到待机。人物按画布尺寸自动缩放，并适配高分辨率屏幕。

导入工具检查资源是否完整、MOC3 格式是否受当前 Core 支持，再复制所需文件、映射待机与点击动作组，并修改 `script.js` 的 `LIVE2D_MODEL`。已有 `assets/live2d/Tororo/` 时拒绝覆盖；重新导入前需先将该目录移出项目保留。模型来源与使用条件记录在 `assets/live2d/Tororo/SOURCE.md`，原始模型说明保存在同目录的 `ReadMe.txt`。

## 仓库与本地文件

源码、测试、`package-lock.json`、页面直接加载的 `assets/` 资源及其来源和许可说明应保留在仓库中。`.github/images/overview.png` 用于项目介绍，也随代码提交。

个人任务与备份位于 `data/`，日志位于 `logs/`；这两个目录以及 `node_modules/`、本地 AI 工具记录和缓存、原始模型压缩包 `tororo_hijiki_ja.zip`、旧截图 `image.png` 均由 `.gitignore` 排除。更新代码时保留本地数据，并按前文方式另行备份；新克隆的仓库不包含这些本地文件。

环境配置使用本地 `.env` 或 `.env.*` 文件时不要提交，通用模板可命名为 `.env.example`。应用通过进程环境变量读取配置，不会自动加载这些文件。`deploy/` 中的 `*.example` 是可提交的通用部署模板；实际配置的 `*.service`、`*.timer` 和 `*.env` 文件只在本地保留。

## 验证

```bash
npm test
```

自动化测试仅使用临时数据目录，不访问实际的 `data/state.json`。

前端交互测试使用开发依赖 jsdom，首次运行测试前执行 `npm ci`。生产后端不依赖 jsdom，若只需启动服务，无需安装开发依赖。

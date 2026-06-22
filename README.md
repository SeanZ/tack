# tack

**管理高并发 AI 开发会话的本地工具。一条纪律:会话可以丢,任务不能丢。**

一个高并发的早晨:论坛冒出一个 crash,群里来一条数据排查,手上还压着两个需求的方案。你在两个仓库里开了七八个 AI 编码会话,有的在调研,有的在写交接文档,有的在跑数据。到了下午想接着上午某个会话往下推,翻遍一堆 session 文件却认不出哪个是哪个;交给另一个 agent 去实施的活,状态全散在脑子里。

问题不在 agent 不够强,而在这些**会话本身是易失的**,你缺一层把它们收成任务的东西。`tack` 只做这一件事:把易失的会话收束到持久的任务上。它是一个本地 CLI,数据是一个 jsonl 文件加几个 markdown,没有数据库,没有后台服务。

## 它解决三件事

1. **捕获涌入** —— 想到一件事一句话记下,不打断手头。先进暂存(inbox),有空再决定做不做。
2. **会话关联** —— 每个 AI 会话自动绑到它服务的任务。事后想接着干,一条命令列出这个任务的所有会话和进度。
3. **跨仓聚合** —— 所有任务一处看全貌。三天前的任务翻出来,从打开到能继续,两分钟内。

## 设计哲学

- **会话可以丢,任务不能丢。** AI 编码会话开得快关得快、上下文随窗口滚动而丢;你真正在推进的是任务,任务跨越多个会话、多个仓库、有时多个 agent。tack 把绑定这一层补上。
- **CLI 管确定性,AI 管自然语言。** 命令负责精确、可脚本化的操作;配套 skill 让常驻 AI 助手听懂"加一条 backlog""把当前会话归档",替你调命令。各司其职。
- **看板只读。** 写操作集中在 CLI 和 AI,看板专注于看,边界清晰不易出错。
- **价值在沉淀的私有上下文。** 通用的 agent 能力人人都能用,把自己的上下文持续沉淀下来,才是别人拿不走的部分。

几个刻意的取舍:

| 取舍 | 为什么这么选 |
|---|---|
| jsonl + markdown,不上数据库 | 个人任务量级下文件足够;可 grep、可 diff、可手改,零迁移成本 |
| CLI 优先,不做 web 优先 | 捕获速度决定工具用不用得起来,终端比切浏览器快十几秒 |
| 工具与数据分离 | 代码可分享,数据(`~/.tack`)私有且独立版本管理,互不牵连 |
| 不做成通用平台 | 它是个人上下文层,价值在沉淀的私有上下文,不在功能多少 |

## 安装

需要 [Bun](https://bun.com);CC 钩子需要 `jq`。

```bash
bun install

# 在 PATH 上建 wrapper（指向本 checkout）
mkdir -p ~/.local/bin
printf '#!/bin/bash\nexec bun %s/bin/tack.ts "$@"\n' "$PWD" > ~/.local/bin/tack
chmod +x ~/.local/bin/tack

# 初始化 ~/.tack（配置 + git 化的数据目录）
tack init

# 可选：装 CC 会话钩子（resume 注入任务 brief / 结束生成 digest）
tack setup cc

# 可选：装配套 skill，让 AI 助手能用自然语言驱动 tack
# 软链而非拷贝，repo 即真源，改一处全生效（多个 agent 共享同一份）
ln -s "$PWD/skills/tack" ~/.claude/skills/tack
```

确认 `~/.local/bin` 在 PATH 上(`which tack` 能找到)。

### 给 AI agent 的安装说明

如果你是替用户安装的 AI agent,按下面的步骤端到端跑完即可,每步都幂等:

1. **确认 Bun 已装**:`bun --version`;没有就让用户先装 Bun,不要自动装。
2. **定位 checkout**:进入本仓库目录(设为 `$PWD`)。
3. **装依赖**:`bun install`。
4. **建 wrapper**:把 `~/.local/bin/tack` 写成 `#!/bin/bash` + `exec bun <仓库绝对路径>/bin/tack.ts "$@"`,`chmod +x`。若 `~/.local/bin` 不在 PATH,提示用户加入 rc,不要自动改 rc。
5. **初始化**:`tack init`(创建 `~/.tack/config.json` + git 化的 `~/.tack/data`)。
6. **填配置(可选)**:如果用户有常用 repo,把别名写进 `~/.tack/config.json` 的 `repos`(参考 `config.example.json`)。这是本机私有配置,不要进任何 git。
7. **装钩子(可选)**:`tack setup cc`(会备份并改 `~/.claude/settings.json`,幂等)。
8. **装 skill(可选)**:`ln -s "$PWD/skills/tack" ~/.claude/skills/tack`(软链而非拷贝,repo 即真源,改一处全生效),让自然语言入口生效。
9. **数据备份(建议)**:`~/.tack/data` 已是 git 仓,引导用户加一个**个人 private 远端**并 push,这样换机器也不丢数据。
10. **验证**:`tack init` 后跑 `tack add "hello" && tack ls`,看到任务即成功;随后 `tack mv <id> archived` 清理。

## 目录模型

```
工具仓（代码，可分享）              ~/.tack（你的数据，私有）
├── bin/tack.ts   CLI 入口          ├── config.json   data_dir / repos / 默认值
├── web/          看板              └── data/         ← 独立 git 仓
├── hooks/        CC 钩子               ├── tasks.jsonl   一行一个 task
├── skills/tack/  通用 skill            └── tasks/<id>/digests/   会话摘要
└── config.example.json
```

路径解析:资产相对 checkout 解析;数据按 `TACK_DATA_DIR` → `config.json:data_dir` → `~/.tack/data` 解析。设 `TACK_HOME` / `TACK_DATA_DIR` 可跑隔离实例(测试用)。

## 用法

不想背命令,就跟装了 `tack` skill 的 AI 助手说话:"加一条 backlog""今天有啥在推进""把当前会话归档"。下面是底层命令速查:

```bash
tack add "<title>" [--tag a,b] [--repo r] [--target <agent>] [--box b]
tack ls [box] [--tag t] [--repo r] [--all] [--json]
tack show <id> [--json]
tack mv <id> <box>              # inbox / processing / backlog / archived
tack tag <id> [tags...]         # 无参列出；untag 删
tack note <id> "<text>"         # 记进展（在会话中会自动关联当前会话）
tack set <id> key=val ...       # repo= target= state= ref= handoff_path= title=
tack which <uuid>               # 某会话属于哪个任务
tack scan [--repo r]            # 还没关联到任务的 CC 会话
tack web [--port 7420]          # 本地看板（前台运行，Ctrl+C 停）
tack setup cc                   # 安装 CC 会话钩子
tack config [key] [value]       # 读写配置
```

`tack task <verb> ...` 是 `tack <verb> ...` 的别名,两种写法等价。

## 会话怎么自动绑到任务

两条路径,都不需要你主动关闭会话:

- **主路径(边干边记)**:在 CC 会话里 `tack note <id> "..."` 记一条进展时,tack 读 `CLAUDE_CODE_SESSION_ID` 把**当前会话**自动绑到该任务。绑过之后,resume 这个会话时 SessionStart 钩子会把任务当前 brief 反喂给它,一上来就懂上下文。
- **备路径(事后收编)**:有些会话是随手裸开的,`tack scan` 能扫出未关联的会话,按内容判断该归到哪个任务或新建。

会话摘要(digest)在三个时机自动生成,固化进可备份的数据仓:`tack show` 时缺则惰性现算、归档(`mv archived`)时收尾固化、会话正常结束时 best-effort 兜底。CC 的 transcript 关闭后不删,所以绑过的会话永远可反查、可重新摘要。

## 本地看板

`tack web` 起一个本地网页:看任务在各状态/各仓库/各主线的分布,点开任意任务看它的全部进度记录和关联会话。看板只读,所有增删改仍走 CLI 或 AI。

## CC 钩子

`tack setup cc` 往 `~/.claude/settings.json` 装两个钩子:

- **SessionStart** —— resume 一个已关联任务的会话时,注入该任务 brief。
- **SessionEnd** —— 对已关联会话生成 best-effort 摘要。

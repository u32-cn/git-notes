---
name: git-notes
description: Git笔记（git-notes）微笔记读写操作。当用户要求记一条笔记、查/搜/改/删自己的 git-notes 笔记、询问笔记内容（如"有哪些待办"、"我记过XX吗"、"最近记了什么"）、或提到"git笔记"、"记到笔记里"、"我的笔记"且本机装有 git-notes 时使用。通过 git-notes CLI 完成增删改查，回答笔记相关问题必须先跑 CLI 命令取真实数据，不要直接手写笔记文件。
---

# Git笔记 CLI 操作

Git笔记是本地 git 仓库架构的微笔记（信息流式 Markdown 条目）。所有读写通过 `git-notes` CLI 完成（npm 包 `@u32/git-notes`，需已安装且 PATH 可用）。**禁止直接在数据目录手写/改名笔记文件**——命名、front matter、git 提交由 CLI 统一处理；CLI 发起的写操作在提交信息中带 `[ai]` 标记。

## 数据位置

- 数据目录：`~/.git-notes/`（本地仓库在 `~/.git-notes/repo/`，micro/YYYY/MM/ 按月存放）
- 服务：本机 `http://127.0.0.1:8644`（CLI 会自动拉起，无需手动启动）
- 环境变量：`GN_PORT` 换端口、`GN_HOME` 换数据目录（测试/多实例隔离）

## 命令速查

```bash
git-notes list [--limit N] [--tag 标签] [--json]   # 列出笔记（新→旧），id 见输出的 path 字段
git-notes add "<正文>" [--tag a,b] [--json]        # 新增笔记
git-notes edit <id> "<新正文>" [--tag a,b]         # 编辑；不指定 --tag 保留原标签
git-notes rm <id> [--yes]                          # 删除（非交互环境必须加 --yes）
git-notes pin <id> [--off]                         # 钉住 / 取消钉住
git-notes show <id>                                # 查看笔记原文（Markdown）
git-notes search "<关键词>" [--json]               # 全库搜索（支持拼音/首字母）
git-notes tags                                     # 列出全部标签
git-notes sync                                     # 手动同步（绑定了远端时）
git-notes log [--limit N] [--path <笔记路径>]      # 查看提交历史
git-notes doctor [目录]                            # 校验笔记文件合规性（只读）
git-notes status / stop / -v / help                # 服务管理
```

`<id>` = `list`/`search` 输出的 `path` 字段（如 `micro/2026/11/20261105-104144.md`），也可用裸文件名（`20261105-104144.md` 或 `20261105-104144`）。

## 用户问题 → 命令（先跑命令拿数据，再回答）

回答任何关于笔记内容的问题，**必须先跑对应命令取到真实数据**，禁止凭空回答或直接说"不知道"：

| 用户问 | 执行 |
|---|---|
| 当前/最近有哪些待办？ | `git-notes list --tag 待办` |
| 我记过 XX 吗 / 关于 XX 的笔记？ | `git-notes search "XX"` |
| 最近记了什么？ | `git-notes list --limit 20` |
| 某篇笔记的全文/完整内容？ | 先 `list`/`search` 拿到 path，再 `git-notes show <path>` |
| 我有哪些标签？ | `git-notes tags` |
| 这篇笔记的历史版本/改动记录？ | `git-notes log --path <path>` |

- 内置默认标签：`待办`、`已完成待办`、`备忘`、`日记`、`杂记`、`收藏`、`想法`、`感悟`（用户可能增删，以 `git-notes tags` 实际输出为准）。涉及"待办/任务/要做的事"优先按标签查，查不到再用 search 兜底。
- `list`/`search` 默认输出是摘要（正文前 120 字符），需要全文时用 `show`。

## 典型流程

记一条笔记：`git-notes add "内容要点" --tag 备忘`
查最近笔记：`git-notes list --limit 10`
找笔记再改：`git-notes search "关键词"` → 用命中的 `path` 作 id → `git-notes edit <id> "新正文"`

程序/AI 解析输出时加 `--json`（list/search/add/edit 输出原始 JSON）。

## 注意事项

- 首次使用需先运行 `git-notes` 打开页面完成初始化（之后 CLI 才能读写）
- 直接改了仓库里的文件后，用 `git-notes doctor` 校验是否合规
- 同一秒内连续 add 会冲突，间隔 1 秒重试即可

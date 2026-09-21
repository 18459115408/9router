# 上游同步 Runbook（个人项目模式）

> 本仓库是**个人使用项目**：基于 decolua/9router fork，做了减法（移除 combo、proxy-pools、capacity/vision adapter、9Remote 推广等）和加法（百度网盘同步、重复凭证检测等）。
> 编写时间：2026-09-21

---

## 0. 远程与分支约定

| 名字 | 指向 | 用途 |
|---|---|---|
| `origin` | 自己的仓库 `18459115408/9router` | 个人线的备份，日常 push 目标 |
| `upstream` | 上游 `decolua/9router` | 只读，用来拉取修复 |

- 个人线只有一条：`master`。
- 上游更新用 **merge** 合入，不要 rebase——删了上游功能，rebase 会反复冲突，merge 只在同一处代码被改动时才冲突一次。

---

## 1. 日常同步（每周一次，或按需）

```bash
git fetch upstream
git checkout master
git merge upstream/master
```

- 无冲突：`git push origin master`，完成。
- 有冲突：按 §2 处理后再推送。

---

## 2. 冲突处理策略

冲突只会在一个地方出现：**上游改到了你删掉/改过的代码**。

| 冲突类型 | 处理方式 |
|---|---|
| 你删掉的功能（combo、proxy-pools、capacity/vision、9Remote 推广、compact 等） | **一律保留删除**。整个文件被删就 `git rm`；上游只是小改就 `git checkout --ours <file>` 再人工核对 |
| 上游新增的同类推广文件（新的 9Remote 菜单项、combo 新页面等） | 再次删掉，保持个人版干净 |
| 无关的修复（provider 适配、流式处理、bug 修复） | 照常接受，这是同步的主要收益 |

冲突量大时，先看看上游这批提交在干什么再动手：

```bash
git log --oneline HEAD..upstream/master
```

---

## 3. 查看个人改动全貌

```bash
git diff upstream/master...master --stat   # 相对上游改了哪些文件
git log --oneline upstream/master..master  # 个人提交列表
```

---

## 4. 回滚

| 场景 | 命令 |
|---|---|
| 合并后、推送前想撤销 | `git reset --hard ORIG_HEAD` |
| 推送后想撤销 | `git reset --hard <合并前的sha>`，再 `git push -f origin master`（个人仓库，force push 无妨） |
| 任何操作失误 | `git reflog` 兜底 |

---

## 5. 上游动态与节奏

- 上游几乎每天都有合并和发版，修复集中在 provider 适配和流式处理。
- 建议节奏：每周合并一次；听说上游修了你在用的 provider 的 bug 时立刻合。
- 合并前可以先看上游最近提交：`git log --oneline upstream/master -20`。

---

## 6. 恢复已删除的快照分支

本地快照分支（`feat/baidu-netdisk-sync` 等 5 条）已删除，但 `origin` 上仍有备份，需要时随时恢复：

```bash
git checkout -b feat/baidu-netdisk-sync origin/feat/baidu-netdisk-sync
```

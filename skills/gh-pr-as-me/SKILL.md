---
name: gh-pr-as-me
description: 在这台机器上用 Dzh97（本人）的身份提/关/查 GitHub PR。gh 默认账号是别人（colna），且不按目录切身份，所以提 PR 要手动带本人 token。当需要在 dingzhihao 项目下用自己身份提 PR、或忘记怎么切 GitHub 身份时使用。
metadata:
  requires:
    bins: ["gh", "git"]
---

# gh-pr-as-me — 用本人(Dzh97)身份提 PR

## 背景（为什么需要这个）

这台 Mac 上 GitHub 身份是**分离**的：

| 操作 | dingzhihao 目录下 | 机制 | 需不需要手动 |
|---|---|---|---|
| **git commit** author | `dzh97 <dzh97@qq.com>` | `~/.gitconfig` 的 `includeIf gitdir:.../dingzhihao/` → `dingzhihao/.gitconfig` | ✅ 自动 |
| **git push** 凭证 | dzh97 的 token | `dingzhihao/.gitconfig` 里 `credential.helper=store --file=.git-credentials` | ✅ 自动 |
| **gh 提 PR** | ❌ 默认走 **colna** | gh 只有一个全局 active 账号，**不按目录切** | ⚠️ 要手动 |

所以：**commit 和 push 已经自动是你**，但 `gh pr create` 默认会用 colna 提。要用你的身份提 PR，必须手动注入你的 token。

## 怎么用本人身份提 PR

用封装脚本(自动从 `.git-credentials` 取你的 token 注入 `GH_TOKEN`，token 不硬编码)：

```bash
# 提 PR
/Users/a0000/Dev/dingzhihao/skills/gh-pr-as-me/scripts/gh-as-me.sh \
  pr create --base release/test --head <你的分支> \
  --title "..." --body "..."

# 关 PR
.../gh-as-me.sh pr close <PR号>

# 查 PR 作者(确认是你)
.../gh-as-me.sh pr view <PR号> --json number,author,state
```

脚本本质就一行：`GH_TOKEN=<你的token> gh "$@"`。token 现场从 `/Users/a0000/Dev/dingzhihao/.git-credentials`（格式 `https://dzh97:<token>@github.com`）提取。

等价手写：
```bash
TK=$(sed -nE 's#^https://dzh97:([^@]+)@github\.com.*#\1#p' /Users/a0000/Dev/dingzhihao/.git-credentials | head -1)
GH_TOKEN="$TK" gh pr create --base release/test --head <分支> --title "..." --body "..."
```

## 完整流程（从改代码到提 PR）

```bash
cd /Users/a0000/Dev/dingzhihao/dora-service
git fetch origin
git checkout -B <新分支> origin/<基线分支>      # 例：origin/release/test
# ...改代码...
git add <文件>
git commit --no-verify -m "..."                 # author 自动是 dzh97；--no-verify 跳过需要 Java 的 pre-commit
git push -u origin <新分支>                      # push 凭证自动是 dzh97
.../scripts/gh-as-me.sh pr create --base <目标分支> --head <新分支> --title "..." --body "..."
```

要点：
- `--no-verify`：本机没装 Java，pre-commit 的 SpotBugs 检查会失败，纯逻辑改动可跳过（CI 会跑）。
- 选基线/目标分支前先确认实现版本对得上（不同 release 分支实现可能分叉，别拉出跨百文件的巨型 diff）。
- 默认**不加** AI 署名(Co-Authored-By / Generated with)，保持纯本人身份。

## token / 账号说明

- 你的 token 目前只有 `repo` 权限：**够提 PR/push**，但 `gh auth login` / `gh auth switch` 会因缺 `read:org` 失败——所以只能走 `GH_TOKEN` 这条路。
- 想让 `gh auth switch` 能用，重新生成 token 时勾 `repo` + `read:org`，再 `gh auth login --with-token`。
- 若换了 token，同步更新 `/Users/a0000/Dev/dingzhihao/.git-credentials` 里的那一行。

## 可选：让 gh 也“进目录自动用你”

装 `direnv` 即可免去每次带 token：
```bash
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc          # 重开终端生效
printf 'export GH_TOKEN=%s\n' "$(sed -nE 's#^https://dzh97:([^@]+)@github\.com.*#\1#p' /Users/a0000/Dev/dingzhihao/.git-credentials | head -1)" > /Users/a0000/Dev/dingzhihao/.envrc
cd /Users/a0000/Dev/dingzhihao && direnv allow
```
之后在 dingzhihao 目录里直接 `gh pr create` 就是你的身份（离开目录自动恢复 colna）。注意 `.envrc` 含明文 token，别提交（加进 `.gitignore`）。

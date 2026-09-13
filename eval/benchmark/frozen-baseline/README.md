# 本次评测的精确源码基线

本目录提供 2026-09-13 ColdX 试跑使用的 policy 副本和 142 文件公开清单。它用于在一个**新的独立 checkout** 中恢复评测输入；本研究提交没有用它覆盖产品的 `plugin/policy.mjs`。

被测源码基于 ColdX [`7d5b6b80a106f770f1127a7294c77cb196e6bace`](https://github.com/DCM-dc/ColdX/tree/7d5b6b80a106f770f1127a7294c77cb196e6bace)。逐文件与该提交的 Git blob 对比后确认：130 个文件字节相同，11 个文件仅有 LF/CRLF 差异，唯一内容变化是 `plugin/policy.mjs`。因此仅检出 Git 提交无法得到所有被测源码的相同哈希。

## 文件与哈希

| 文件或证据 | SHA-256 |
| --- | --- |
| 原始 source manifest，公开副本的上游来源 | `a4813fc1b6e37bec2b2318f3e990a35ec0cada7cbd33778e5e7022e42acff700` |
| [source-manifest.public.json](source-manifest.public.json) | `eba17f154a2b255b1dc4eed3a2f525a5c0f934817f3380ecf93482f8a2bbd10e` |
| [plugin-policy.mjs](plugin-policy.mjs)，评测实际 policy 副本 | `c0bbc521d0ed1ace478b9d2d0f64f46c009a48de4299981fbe345de6cf1170c3` |

公开清单保留每个源码文件的相对路径、字节数和原 SHA-256，并增加基础 Git blob 的 SHA-256 与恢复方式。它剔除机器位置等非复现必需字段，因此公开 JSON 自身的哈希与原始 manifest 不同；二者不能混称同一文件。

11 个换行差异文件记录从 1 开始的 CRLF 行号。其余内容逐字节等于基础提交的 LF blob；没有把任意空白或语义变化当作换行展开。policy 保留被测版本的原始字节，已检查常见凭据和个人路径模式并人工阅读，未发现账户信息或原始对话。目录不包含运行配置、依赖缓存、会话、任务补丁或凭据。

## 在新 checkout 中恢复

先保存本目录的路径，再克隆一个独立源码目录并检出基础提交。使用已有开发目录会覆盖列出的源码，因此不应在那里执行恢复。

```sh
BASELINE="$PWD/eval/benchmark/frozen-baseline"
SOURCE="$PWD/coldx-benchmark-source"
git clone --no-checkout https://github.com/DCM-dc/ColdX.git "$SOURCE"
git -C "$SOURCE" checkout --detach 7d5b6b80a106f770f1127a7294c77cb196e6bace

python3 - "$SOURCE" "$BASELINE" <<'PY'
from pathlib import Path
import hashlib, json, subprocess, sys

source = Path(sys.argv[1]).resolve()
baseline = Path(sys.argv[2]).resolve()
manifest_bytes = (baseline / "source-manifest.public.json").read_bytes()
assert hashlib.sha256(manifest_bytes).hexdigest() == "eba17f154a2b255b1dc4eed3a2f525a5c0f934817f3380ecf93482f8a2bbd10e"
manifest = json.loads(manifest_bytes)
commit = manifest["base_git_commit"]
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip() == commit
assert not subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True), "Use a fresh, clean checkout"

prepared = []
for entry in manifest["files"]:
    path = entry["path"]
    target = (source / path).resolve()
    assert target.is_relative_to(source) and not (source / path).is_symlink()
    raw = subprocess.check_output(["git", "cat-file", "blob", f"{commit}:{path}"], cwd=source)
    assert hashlib.sha256(raw).hexdigest() == entry["base_git_blob_sha256"]
    if entry["restore"] == "policy-snapshot":
        raw = (baseline / "plugin-policy.mjs").read_bytes()
    elif entry["restore"] == "git-blob-with-recorded-crlf-lines":
        lines = set(entry["crlf_line_numbers_1_based"])
        assert b"\r\n" not in raw
        raw = b"".join(
            line[:-1] + b"\r\n" if number in lines and line.endswith(b"\n") else line
            for number, line in enumerate(raw.splitlines(keepends=True), 1)
        )
    else:
        assert entry["restore"] == "git-blob"
    assert len(raw) == entry["bytes"] and hashlib.sha256(raw).hexdigest() == entry["sha256"]
    prepared.append((target, raw, entry))

# Validate all inputs before replacing the declared files in the fresh checkout.
for target, raw, entry in prepared:
    target.write_bytes(raw)
    assert hashlib.sha256(target.read_bytes()).hexdigest() == entry["sha256"]
print(f"Verified and restored {len(prepared)} frozen source files")
PY
```

恢复后 `plugin/policy.mjs` 是这里的评测副本，而不是基础提交的原版。再使用 Node `24.16.0`、pnpm `11.19.0`，执行 `pnpm install --frozen-lockfile` 与 `pnpm build`；不要沿用个人 ColdX home、配置、模型凭据或会话。基线不改变产品目录以外的用户文件。

公开源码清单验证的是构建输入。本次实际 Linux 运行分发还包括依赖、Node、harness 和 Chromium 私有库，其总摘要为 `6544a8ee873fb315f7bc2d84e37d34039164ee442babee392ec4961d7ea6d640`。新机器必须保存自己的构建结果和验收证据；恢复源码哈希本身不证明构建产物或模型效果相同。

资源、网络、浏览器依赖、官方任务 pin 和评分限制见[公开试跑协议](../../../docs/research/benchmarks/2026-09-13/protocol.md)，入口用法见[评测工具说明](../README.md)。

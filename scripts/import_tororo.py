#!/usr/bin/env python3
"""Import the official Tororo runtime from a local Live2D sample ZIP."""

import argparse
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import subprocess
import tempfile
import zipfile


SOURCE = "https://www.live2d.com/zh-CHS/learn/sample/tororo-hijiki/"
ROOT = Path(__file__).resolve().parents[1]


def runtime_version(root):
    code = """
const fs = require('node:fs');
const vm = require('node:vm');
const filename = process.argv[1];
const context = { console, require, process, Buffer, setTimeout, clearTimeout,
  __dirname: require('node:path').dirname(filename), __filename: filename,
  module: { exports: {} }, exports: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { timeout: 5000 });
console.log(context.Live2DCubismCore.Version.csmGetLatestMocVersion());
"""
    result = subprocess.run(
        ["node", "-e", code, str(root / "assets/live2d/core/live2dcubismcore.min.js")],
        check=True, capture_output=True, text=True, timeout=10,
    )
    return int(result.stdout.strip().splitlines()[-1])


def referenced_files(refs):
    for key in ("Moc", "Physics", "Pose", "UserData", "DisplayInfo"):
        if refs.get(key):
            yield refs[key]
    yield from refs.get("Textures", [])
    for entry in refs.get("Expressions", []):
        yield entry["File"]
    for group in refs.get("Motions", {}).values():
        for entry in group:
            yield entry["File"]
            if entry.get("Sound"):
                yield entry["Sound"]


def install(archive_path, root=ROOT, check_only=False):
    destination = root / "assets/live2d/Tororo"
    if destination.exists() and not check_only:
        raise ValueError(f"目标目录已存在，请先保留或移走：{destination}")

    with zipfile.ZipFile(archive_path) as archive:
        candidates = []
        for name in archive.namelist():
            if name.startswith("__MACOSX/") or not name.lower().endswith(".model3.json"):
                continue
            settings = json.loads(archive.read(name).decode("utf-8-sig"))
            moc = settings.get("FileReferences", {}).get("Moc", "")
            if "tororo" in (PurePosixPath(name).name + " " + moc).lower():
                candidates.append((name, settings))
        if len(candidates) != 1:
            raise ValueError(
                f"压缩包内找到 {len(candidates)} 个 Tororo .model3.json；"
                "请使用官方包含 runtime 目录的白猫模型压缩包。"
            )
        name, settings = candidates[0]
        refs = settings["FileReferences"]
        if not refs.get("Moc") or not refs.get("Textures"):
            raise ValueError("白猫模型缺少 Moc 或 Textures 配置。")
        parent = PurePosixPath(name).parent
        files = {}
        for reference in referenced_files(refs):
            path = PurePosixPath(reference)
            if path.is_absolute() or ".." in path.parts or ":" in reference or "\\" in reference:
                raise ValueError(f"模型引用必须是 runtime 目录内的相对路径：{reference}")
            files[str(path)] = archive.read(str(parent / path))
        if "ReadMe.txt" in archive.namelist():
            files["ReadMe.txt"] = archive.read("ReadMe.txt")

    moc = files[str(PurePosixPath(refs["Moc"]))]
    if len(moc) < 8 or moc[:4] != b"MOC3":
        raise ValueError("模型不是有效的 Cubism 3/4 MOC3 文件。")
    version = struct.unpack_from("<I", moc, 4)[0]
    supported = runtime_version(root)
    if version > supported:
        raise ValueError(f"模型格式版本 {version} 超过当前 Core 支持的 {supported}，未替换人物。")

    motions = refs.setdefault("Motions", {})
    available = [group for group, entries in motions.items() if entries]
    idle = next((group for group in available if "idle" in group.lower()), None)
    idle = idle or next(iter(available), None)
    tap = next((group for group in available if "tap" in group.lower()), None)
    tap = tap or next((group for group in available if group != idle), idle)
    if idle:
        motions["Idle"] = list(motions[idle])
        motions["TapBody"] = list(motions[tap])

    script_path = root / "script.js"
    original = script_path.read_text(encoding="utf-8")
    if "Tororo: {" not in original or "layout.autoFit" not in original:
        raise ValueError("script.js 尚未包含 Tororo 自动适配布局，请先更新页面代码。")
    replacement = 'const LIVE2D_MODEL = {\n  name: "Tororo",\n  path: "assets/live2d/Tororo/Tororo.model3.json",\n};'
    updated, count = re.subn(r"const LIVE2D_MODEL = \{[^}]*\};", replacement, original)
    if count != 1:
        raise ValueError("无法唯一定位 script.js 中的 LIVE2D_MODEL，未替换人物。")

    print(f"白猫配置：{name}；MOC3 版本：{version}；Core 支持：{supported}")
    print(f"待机动作组：{idle or '无'}；点击动作组：{tap or '无'}")
    if check_only:
        print(f"校验通过，共 {len(files)} 个资源文件；未修改页面。")
        return

    with tempfile.TemporaryDirectory(prefix=".tororo-import-", dir=root) as temporary:
        staged = Path(temporary) / "Tororo"
        staged.mkdir()
        for reference, content in files.items():
            target = staged / reference
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (staged / "Tororo.model3.json").write_text(
            json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (staged / "SOURCE.md").write_text(
            f"# Tororo 白猫模型\n\n来源：{SOURCE}\n\n"
            "模型版权属于 Live2D Inc.，使用条件见官方页面。\n\n"
            "https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html\n\n"
            "https://www.live2d.com/en/learn/sample/model-terms/\n\n"
            "原模型文件及其资源路径保持原样；入口配置增加 Idle、TapBody 动作组别名。\n",
            encoding="utf-8",
        )
        staged_script = Path(temporary) / "script.js"
        staged_script.write_text(updated, encoding="utf-8")
        staged_script.chmod(script_path.stat().st_mode & 0o777)
        if script_path.read_text(encoding="utf-8") != original:
            raise ValueError("导入期间 script.js 已发生变化，请重新执行导入。")
        staged.rename(destination)
        try:
            staged_script.replace(script_path)
        except OSError:
            shutil.rmtree(destination)
            raise
    print(f"已切换为白猫 Tororo：{destination}。刷新网页即可加载。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="官方 Tororo/Hijiki 模型 ZIP 文件")
    parser.add_argument("--check-only", action="store_true", help="只校验模型，不修改页面")
    args = parser.parse_args()
    try:
        install(args.archive, check_only=args.check_only)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        parser.exit(1, f"导入失败：{error}\n")


if __name__ == "__main__":
    main()

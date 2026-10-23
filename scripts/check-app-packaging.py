#!/usr/bin/env python3
"""Exercise make-app.sh with a tiny compiler fixture; never build, install or launch the app.

Uses macOS ditto to check the actual archive. Signing is stubbed: release signing and a full
relocated-app smoke test must still run on the integrated release build.
"""
from pathlib import Path
import os
import plistlib
import shutil
import subprocess
import tempfile
import zipfile


def check():
    source = Path(__file__).resolve().parent / "make-app.sh"
    with tempfile.TemporaryDirectory(prefix="botling-package-") as folder:
        root = Path(folder)
        (root / "scripts").mkdir()
        shutil.copy2(source, root / "scripts/make-app.sh")
        (root / "VERSION").write_text("0.0.0-test\n")
        tools = root / "tools"
        tools.mkdir()
        binary = root / "compiled"
        binary.mkdir()
        (binary / "botling").write_text("#!/bin/sh\nexit 0\n")
        (binary / "botling").chmod(0o755)
        for target, resource in [("ClaudeCodeBot", "web/chat.html"),
                                 ("ClaudeCodeBotCore", "CharacterArt/avatars-static/claude/idle.png")]:
            file = binary / f"botling_{target}.bundle" / resource
            file.parent.mkdir(parents=True)
            file.write_text("fixture\n")
        (tools / "swift").write_text('''#!/bin/sh
case " $* " in
  *" --show-bin-path "*) printf '%s\\n' "$BOTLING_TEST_BIN" ;;
  *) printf '%s\\n' "$*" >> "$BOTLING_TEST_BUILD_LOG" ;;
esac
''')
        (tools / "codesign").write_text('#!/bin/sh\nexit 0\n')
        for tool in tools.iterdir():
            tool.chmod(0o755)
        env = dict(os.environ, PATH=f"{tools}:/usr/bin:/bin:/usr/sbin:/sbin",
                   BOTLING_TEST_BIN=str(binary), BOTLING_TEST_BUILD_LOG=str(root / "build.log"), SINGLE_ARCH="1")
        subprocess.run(["bash", str(root / "scripts/make-app.sh")], env=env, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        app = root / "dist/Botling.app"
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        assert info["CFBundleName"] == info["CFBundleDisplayName"] == "Botling"
        assert info["CFBundleIdentifier"] == "io.github.william1010121.ClaudeCodeBot", "Existing installs must accept this build"
        assert info["CFBundleExecutable"] == "botling"
        assert os.access(app / "Contents/MacOS" / info["CFBundleExecutable"], os.X_OK)
        assert info["CFBundleShortVersionString"] == "0.0.0-test"
        assert "--jobs 2" in (root / "build.log").read_text()
        with zipfile.ZipFile(root / "dist/botling-0.0.0-test-macOS.zip") as archive:
            files = set(archive.namelist())
            for file in ["Contents/MacOS/botling",
                         "Contents/Resources/botling_ClaudeCodeBot.bundle/web/chat.html",
                         "Contents/Resources/botling_ClaudeCodeBotCore.bundle/CharacterArt/avatars-static/claude/idle.png"]:
                assert f"Botling.app/{file}" in files, file
        print("PASS: Botling.app, botling executable/zip, legacy bundle ID, both resource bundles, jobs=2")


if __name__ == "__main__":
    check()

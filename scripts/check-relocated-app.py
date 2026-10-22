#!/usr/bin/env python3
"""Check an already relocated .app with its compiled SwiftPM fallback paths unavailable.

Usage: python3 scripts/check-relocated-app.py /path/ClaudeCodeBot.app /path/evidence
Requires an available macOS WindowServer. Only isolated, offscreen snapshot runs are used.
The caller must first move/remove the original build directory; this script never changes it.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile


def check(app, output):
    app, output = Path(app).resolve(), Path(output).resolve()
    binary = app / "Contents/MacOS/ClaudeCodeBot"
    strings = subprocess.check_output(["/usr/bin/strings", str(binary)], text=True)
    fallbacks = sorted({line for line in strings.splitlines()
                        if line.startswith("/") and "/.build/" in line
                        and line.endswith(".bundle")})
    if not fallbacks or any(Path(path).exists() for path in fallbacks):
        raise RuntimeError(f"Build fallbacks must be identifiable and unavailable: {fallbacks}")
    output.mkdir(parents=True, exist_ok=True)
    results = {"app": str(app), "unavailable_build_fallbacks": fallbacks, "snapshots": []}
    for name, key, size in [("avatars", "CCB_CHIBI_SNAPSHOT", (1100, 640)),
                            ("window", "CCB_WINDOW_SNAPSHOT", (1280, 820)),
                            ("chat", "CCB_SNAPSHOT", None)]:
        png = output / f"{name}.png"
        png.unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(prefix="ccb-relocated-home-") as home:
            env = {key: value for key, value in os.environ.items() if not key.startswith("CCB_")}
            env.update(HOME=home, CFFIXED_USER_HOME=home, CCB_SNAPSHOT_SAMPLE="heads")
            env[key] = str(png)
            run = subprocess.run([str(binary)], cwd=home, env=env, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
        (output / f"{name}.log").write_text(run.stdout)
        if run.returncode != 0:
            raise RuntimeError(f"{name} exited {run.returncode}; see {name}.log")
        data = png.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError(f"Invalid PNG: {png}")
        dimensions = struct.unpack(">II", data[16:24])
        # Retina output can contain two pixels per point.
        if size and dimensions not in (size, tuple(n * 2 for n in size)):
            raise RuntimeError(f"Unexpected {name} dimensions: {dimensions}")
        results["snapshots"].append({"name": name, "exit_code": run.returncode,
                                     "pixels": dimensions, "bytes": len(data)})
    if any(Path(path).exists() for path in fallbacks):
        raise RuntimeError("A build fallback reappeared during validation")
    (output / "relocated-check.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    check(*sys.argv[1:])

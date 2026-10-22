#!/bin/bash
# Builds ClaudeCodeBot.app (universal: Apple silicon + Intel) and a zip of it in dist/.
#   scripts/make-app.sh 1.1.0     (without a version, the one in VERSION)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(tr -d '[:space:]' < VERSION)}"
# Which commit this build is, and whether it had uncommitted changes: the developer-mode install
# card compares it with the running build to show what changes.
COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
DIRTY=0
if [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then DIRTY=1; fi
ARCHS=(--arch arm64 --arch x86_64)
if [[ "${SINGLE_ARCH:-}" == "1" ]]; then ARCHS=(); fi

swift build -c release ${ARCHS[@]+"${ARCHS[@]}"}
BIN="$(swift build -c release ${ARCHS[@]+"${ARCHS[@]}"} --show-bin-path)"

APP="dist/ClaudeCodeBot.app"
rm -rf dist
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/ClaudeCodeBot" "$APP/Contents/MacOS/ClaudeCodeBot"
# The web chat, built-in plugins and plugin host live in SwiftPM's resource bundle.
cp -R "$BIN/ClaudeCodeBot_ClaudeCodeBot.bundle" "$APP/Contents/Resources/"
cp -R "$BIN/ClaudeCodeBot_ClaudeCodeBotCore.bundle" "$APP/Contents/Resources/"
if [[ -f Assets/AppIcon.icns ]]; then cp Assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"; fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ClaudeCodeBot</string>
  <key>CFBundleDisplayName</key><string>ClaudeCodeBot</string>
  <key>CFBundleIdentifier</key><string>io.github.william1010121.ClaudeCodeBot</string>
  <key>CFBundleExecutable</key><string>ClaudeCodeBot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CCBGitCommit</key><string>${COMMIT}</string>
  <key>CCBGitDirty</key><string>${DIRTY}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

# Ad-hoc signature: not notarized, so the first launch needs right-click → Open.
codesign --force --deep --sign - "$APP"
ditto -c -k --keepParent "$APP" "dist/ClaudeCodeBot-${VERSION}-macOS.zip"
echo "Built $APP and dist/ClaudeCodeBot-${VERSION}-macOS.zip"

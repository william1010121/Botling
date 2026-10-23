#!/usr/bin/env python3
"""Execute the unchanged production prompt generator with minimal profile types; no package build."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parents[2] / 'Sources/ClaudeCodeBotCore/Prompts.swift'
fixtures = '''import Foundation
enum ResultPublishing { case artifactUnlessSensitive, localOnly, artifactAlways }
enum AppLanguage { case english; var promptName: String { "English" } }
enum BotEngine: String, CaseIterable { case claude, codex; var displayName: String { rawValue.capitalized } }
enum MemorySection: CaseIterable { case currentStatus,inProgress,waitingOnYou,decided; var heading:String { switch self { case .currentStatus:"Current status"; case .inProgress:"In progress"; case .waitingOnYou:"Waiting on you"; case .decided:"Decided" } }; var rule:String? { switch self {case .currentStatus:"3 sentences max";case .decided:"date each";default:nil} } }
struct HeadsSettings {var handoffs=false;var hasTwo=false;var limits=Limits();struct Limits {var handoffs=1;var review=1;var discussion=1} }
enum Workspace {static let projectSearchDepth=3}
enum DesignFlow {static let steps="with the Artifact tool, run quickstart with intent \\"design\\" and publish from the Design type it names"}
struct BotProfile {enum Role {case main,manager};var name="ClaudeCodeBot";var role:Role = .manager;var workingDirectory:URL;var instructions:String?=nil;var job:String?=nil;var memoryPath:String {workingDirectory.appending(path:".bot/memory.md").path};var archiveURL:URL {workingDirectory.appending(path:".bot/archive")};var artifactsURL:URL {workingDirectory.appending(path:".bot/artifacts")};var routinesPath:String {workingDirectory.appending(path:".bot/routines.cron").path}}
'''
# Swift's embedded escaped quote is literal source, not an interpolation into shell code.
fixtures = fixtures.replace('\\\\"', '\\"')
tail = '''
let root=URL(filePath:CommandLine.arguments[1])
let p=BotPrompts(profile:BotProfile(workingDirectory:root),engine:.codex)
try p.system.write(to:root.appending(path:"developer-instructions.txt"),atomically:true,encoding:.utf8)
try p.codexWorkerSystem.write(to:root.appending(path:"worker-instructions.txt"),atomically:true,encoding:.utf8)
'''
body = source.read_bytes()
(root/'Prompts.swift').write_bytes(body)
(root/'generate.swift').write_text(fixtures + body.decode() + tail)
(root/'source.json').write_text(json.dumps({'path': str(source), 'sha256': hashlib.sha256(body).hexdigest()}, indent=2))
subprocess.run(['swift', '-module-cache-path', str(root/'module-cache'), str(root/'generate.swift'), str(root)], check=True)

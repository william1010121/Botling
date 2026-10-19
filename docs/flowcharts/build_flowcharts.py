"""Build the PRD flowcharts. Run: python3 build_flowcharts.py (needs matplotlib).

Writes <name>.png and <name>.pdf next to this script (docs/flowcharts/).
"""
import os
from flowdiag import Diagram

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Color meaning, shared by all diagrams:
#   blue   = visible to you on screen
#   gray   = runs in the background, not visible to you
#   orange = needs your decision
DASH = "#555555"


def architecture():
    d = Diagram()
    d.text(-170, 48, "You", bold=True)
    d.text(-170, 186, "App UI", bold=True)
    d.text(-170, 350, "Woken on demand", bold=True)
    d.text(-170, 516, "Doing the work", bold=True)

    d.node("you", 460, 20, 160, 56, "You")
    d.node("ui_main", 120, 150, 340, 72, "Main bot chat\nfirst row in the sidebar", "blue")
    d.node("ui_proj", 620, 150, 340, 72, "Project chats\none row per folder", "blue")
    d.node("main", 120, 310, 340, 80, "Main bot\nclaude process, woken on demand", "gray")
    d.node("mgr", 620, 310, 340, 80, "Project manager\none per folder, woken on demand", "gray")
    d.node("team", 120, 480, 340, 72, "Temporary team\nspun up on the spot, closed when done", "gray")
    d.node("worker", 620, 480, 340, 72, "Worker\nsent out by the manager", "gray")

    d.edge(("you", "bottom", 0.3), ("ui_main", "top"), route="vhv")
    d.edge(("you", "bottom", 0.7), ("ui_proj", "top"), route="vhv")
    for ui, p in [("ui_main", "main"), ("ui_proj", "mgr")]:
        d.edge((ui, "bottom", 0.3), (p, "top", 0.3), label="stdin")
        d.edge((p, "top", 0.7), (ui, "bottom", 0.7), label="reports", color=DASH, dashed=True)
    d.edge(("main", "right", 0.35), ("mgr", "left", 0.35), label="delegate via inbox")
    d.edge(("mgr", "left", 0.7), ("main", "right", 0.7), label="read memory.md", color=DASH, dashed=True)
    d.edge(("main", "bottom"), ("team", "top"), label="spins up")
    d.edge(("mgr", "bottom", 0.3), ("worker", "top", 0.3), label="assigns")
    d.edge(("mgr", "bottom", 0.7), ("worker", "top", 0.7), label="hook corrections")

    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Runs in the background, not visible")
    d.render("flow-1-architecture")


def wish():
    d = Diagram()
    d.node("wish", 360, 20, 340, 64, "You make a wish to the main bot", "blue")
    d.node("judge", 360, 130, 340, 72, "Main bot decides:\nwho takes it? ask you first?", "gray")
    d.node("ask", 40, 270, 300, 96, "Ask you first\nambiguous, cross-project,\nor irreversible", "orange")
    d.node("mgr", 380, 270, 300, 96, "Hand to the project manager\na matching folder exists", "gray")
    d.node("team", 720, 270, 300, 96, "Spin up a temporary team\nbelongs to no project", "gray")
    d.node("reply", 40, 410, 300, 72, "You reply\nclick OK, or rephrase", "blue")
    d.node("work", 380, 410, 640, 72, "Work happens in the background (you don't see the process)", "gray")
    d.node("done", 360, 550, 340, 80, "Done: main bot replies in one line\n+ a result chip (opens a page)", "blue")
    d.node("stuck", 730, 550, 330, 80, "Stuck: needs your choice\noption buttons + manager's advice", "orange")

    d.edge(("wish", "bottom"), ("judge", "top"))
    d.edge(("judge", "bottom", 0.2), ("ask", "top"), route="vhv")
    d.edge(("judge", "bottom", 0.5), ("mgr", "top"))
    d.edge(("judge", "bottom", 0.8), ("team", "top"), route="vhv")
    d.edge(("ask", "bottom"), ("reply", "top"))
    d.edge(("reply", "left"), ("judge", "left"), via=[(0, 446), (0, 166)], label="re-decide", color=DASH, dashed=True)
    d.edge(("mgr", "bottom"), ("work", "top", (530 - 380) / 640))
    d.edge(("team", "bottom"), ("work", "top", (870 - 380) / 640))
    d.edge(("work", "bottom", (530 - 380) / 640), ("done", "top"))
    d.edge(("work", "bottom", (895 - 380) / 640), ("stuck", "top"))
    d.edge(("stuck", "right"), ("work", "right"), via=[(1110, 590), (1110, 446)], label="continues\nafter you pick",
           color=DASH, dashed=True)

    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Runs in the background")
    d.legend_item("orange", "Needs your decision")
    d.render("flow-2-wish", margin=70)


def report():
    d = Diagram()
    d.text(-130, 56, "When", bold=True)
    d.text(-130, 206, "Who compiles it", bold=True)
    d.text(-130, 356, "Where it shows", bold=True)

    d.node("t_routine", 80, 20, 300, 72, "Routine\nfixed time, e.g. daily at 8:15")
    d.node("t_event", 540, 20, 300, 72, "Only when something happens\ndone, stuck, needs your choice")
    d.node("t_ask", 1000, 20, 300, 72, "Only when I ask\nyou ask in the chat")
    d.node("p_routine", 80, 170, 300, 72, "Main bot collects each\nmanager's latest status", "gray")
    d.node("p_event", 540, 170, 300, 72, "That project's manager\nwrites a report", "gray")
    d.node("p_ask", 1000, 170, 300, 72, "Main bot checks status first;\nasks managers only if stale", "gray")
    d.node("o_routine", 80, 320, 300, 72, "Main bot chat\none summary", "blue")
    d.node("o_event", 540, 320, 300, 72, "That project's row\nnew message + unread dot", "blue")
    d.node("o_ask", 1000, 320, 300, 72, "Answered in place\nshort reply + chip", "blue")

    for k in ["routine", "event", "ask"]:
        d.edge(("t_" + k, "bottom"), ("p_" + k, "top"))
        d.edge(("p_" + k, "bottom"), ("o_" + k, "top"))
    d.edge(("p_event", "left", 0.8), ("o_routine", "right"), via=[(460, 227.6), (460, 356)],
           label="needs a choice:\nalso noted here", color=DASH, dashed=True)

    d.text(80, 440, "Workers and temporary teams never contact you directly; only the main bot and project managers speak.",
           fontsize=17, color="#555555")
    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Runs in the background")
    d.render("flow-3-report")


def lifecycle():
    d = Diagram()
    d.node("sleep", 0, 20, 340, 80, "Asleep\navatar in the sidebar closes its eyes", "blue")
    d.node("msg", 410, 20, 340, 80, "A message arrives\nfrom you, the main bot, or a Routine")
    d.node("wake", 820, 20, 340, 80, "Wake: start a new session\nread memory.md + inbox.md", "gray")
    d.node("work", 1230, 20, 340, 80, "Working\nmid-task corrections via stdin", "gray")
    d.node("idle", 1230, 200, 340, 80, "Idle for 50 minutes\nbefore the 1-hour cache expires", "gray")
    d.node("tidy", 820, 200, 340, 80, "Tidy up: update memory.md\ncompress if over the limit", "gray")
    d.node("exit", 410, 200, 340, 80, "Process exits", "gray")

    d.edge(("sleep", "right"), ("msg", "left"))
    d.edge(("msg", "right"), ("wake", "left"))
    d.edge(("wake", "right"), ("work", "left"))
    d.edge(("work", "bottom"), ("idle", "top"))
    d.edge(("idle", "left"), ("tidy", "right"))
    d.edge(("tidy", "left"), ("exit", "right"))
    d.edge(("exit", "left"), ("sleep", "bottom"), route="hv")

    d.text(0, 330, "Any new call while working restarts the 50-minute timer (every call refreshes the cache).",
           fontsize=17, color="#555555")
    d.text(0, 365, "A sleeping manager isn't woken: the main bot reads its memory.md and answers you directly.",
           fontsize=17, color="#555555")
    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Runs in the background")
    d.render("flow-4-lifecycle")


def plugins_architecture():
    d = Diagram()
    d.text(0, 48, "You", bold=True)
    d.text(0, 196, "ClaudeCodeBot", bold=True)
    d.text(0, 366, "Plugin library", bold=True)
    d.text(0, 536, "Plugin users", bold=True)

    d.node("you", 540, 20, 200, 56, "You")
    d.node("app", 290, 160, 700, 72, "ClaudeCodeBot app: scans, validates, hot-reloads plugins; renders components", "blue")
    d.node("lib", 290, 320, 700, 92, "~/.claudecodebot/plugins (git + marketplace)\nccb-core, github, notion, ...", "gray")
    d.node("maint", 1070, 320, 300, 92, "Maintainer\nedits, validates, commits", "gray")
    d.node("bots", 290, 500, 700, 72, "Main bot, managers, temporary teams: --plugin-dir at launch", "gray")

    d.edge(("you", "bottom"), ("app", "top", (640 - 290) / 700))
    d.edge(("app", "bottom", 0.3), ("lib", "top", 0.3), label="reads")
    d.edge(("lib", "top", 0.7), ("app", "bottom", 0.7), label="files changed", color=DASH, dashed=True)
    d.edge(("maint", "left"), ("lib", "right"), label="edits")
    d.edge(("lib", "bottom"), ("bots", "top"), label="loads")
    d.edge(("app", "right"), ("maint", "top"), route="hv", label="delegates")

    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Background")
    d.render("flow-5-plugins")


def plugin_update():
    d = Diagram()
    d.node("ask", 280, 20, 440, 72, "Request: flag beside a component,\nsaid in chat, or raised by a bot", "blue")
    d.node("inbox", 280, 150, 440, 64, "Written to the Maintainer's inbox", "gray")
    d.node("external", 800, 150, 320, 64, "External plugin: ask you first", "orange")
    d.node("edit", 280, 270, 440, 64, "Maintainer edits the plugin", "gray")
    d.node("check", 280, 390, 440, 72, "claude plugin validate --strict\n+ the plugin's own tests", "gray")
    d.node("fix", 800, 390, 320, 72, "Failed: keep the previous version;\nthe manager fixes it again", "orange")
    d.node("commit", 280, 520, 440, 64, "Passed: git commit, bump version", "gray")
    d.node("reload", 280, 640, 440, 100,
           "ClaudeCodeBot detects the change:\ncomponents re-render, commands refresh,\nidle bots hand off and restart",
           "blue")

    d.edge(("ask", "bottom"), ("inbox", "top"))
    d.edge(("ask", "right"), ("external", "top"), route="hv", label="installing an external one")
    d.edge(("external", "bottom"), ("edit", "right"), route="vh", label="you approve")
    d.edge(("inbox", "bottom"), ("edit", "top"))
    d.edge(("edit", "bottom"), ("check", "top"))
    d.edge(("check", "right"), ("fix", "left"))
    d.edge(("fix", "top"), ("edit", "right", 0.75), route="vh", color=DASH, dashed=True)
    d.edge(("check", "bottom"), ("commit", "top"))
    d.edge(("commit", "bottom"), ("reload", "top"))

    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Background")
    d.legend_item("orange", "Needs you, or a redo")
    d.render("flow-6-plugin-update", margin=40)


def architecture_v2():
    d = Diagram()
    d.text(0, 48, "You", bold=True)
    d.text(0, 196, "ClaudeCodeBot\napp (Swift)", bold=True)
    d.text(0, 366, "Three runtimes", bold=True)
    d.text(0, 516, "Plugin library", bold=True)

    d.node("you", 560, 20, 200, 56, "You")
    d.node("shell", 240, 150, 840, 92,
           "Swift shell: sidebars, bot lifecycle, permissions, settings\nloads plugins, watches files, hot-reloads", "blue")
    d.node("web", 180, 320, 300, 92, "Chat surface (web)\nmessages, composer, components", "blue")
    d.node("host", 510, 320, 300, 92, "Plugin host (Node)\nplugins' program logic", "gray")
    d.node("claude", 840, 320, 300, 92, "Bots' claude processes\n--plugin-dir", "gray")
    d.node("lib", 240, 480, 840, 72, "~/.claudecodebot/plugins (git): one folder per plugin", "gray")
    d.node("maint", 1160, 480, 300, 72, "Maintainer\nwrites, tests, commits plugins", "gray")

    d.edge(("you", "bottom"), ("shell", "top", (660 - 240) / 840))
    d.edge(("shell", "bottom", (330 - 240) / 840), ("web", "top"), label="web part")
    d.edge(("shell", "bottom", (660 - 240) / 840), ("host", "top"), label="program part")
    d.edge(("shell", "bottom", (990 - 240) / 840), ("claude", "top"), label="Claude part")
    d.edge(("maint", "left"), ("lib", "right"), label="edits")
    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Background")
    d.render("flow-7-architecture-v2")


def port_existing():
    d = Diagram()
    d.node("ask", 280, 20, 480, 72, "You: “Make laas-copy a ClaudeCodeBot plugin”", "blue")
    d.node("allow", 280, 140, 480, 72, "ClaudeCodeBot asks: let the Maintainer\nread this folder?", "orange")
    d.node("read", 280, 260, 480, 72, "Maintainer reads the source project,\nfinds the reusable core (web-laas-engine)", "gray")
    d.node("write", 280, 380, 480, 72, "Write the plugin: package.json, web part,\nsettings, tests", "gray")
    d.node("check", 280, 500, 480, 72, "ClaudeCodeBot --check-plugin: format, build,\ntests, one offline load", "gray")
    d.node("fix", 840, 500, 260, 72, "Failed: the manager\nfixes it again", "orange")
    d.node("live", 280, 620, 480, 92, "commit → ClaudeCodeBot hot-reloads\ntype ;a in the composer to get \\alpha", "blue")

    d.edge(("ask", "bottom"), ("allow", "top"))
    d.edge(("allow", "bottom"), ("read", "top"), label="approved")
    d.edge(("read", "bottom"), ("write", "top"))
    d.edge(("write", "bottom"), ("check", "top"))
    d.edge(("check", "right"), ("fix", "left"))
    d.edge(("fix", "top"), ("write", "right"), route="vh", color=DASH, dashed=True)
    d.edge(("check", "bottom"), ("live", "top"), label="passed")
    d.legend_item("blue", "Visible to you")
    d.legend_item("gray", "Background")
    d.legend_item("orange", "Needs you, or a redo")
    d.render("flow-8-port-plugin", margin=40)


if __name__ == "__main__":
    architecture()
    wish()
    report()
    lifecycle()
    plugins_architecture()
    plugin_update()
    architecture_v2()
    port_existing()

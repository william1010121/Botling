------------------------------ MODULE Approval ------------------------------
(* A plugin frame's ask to run a bot's command (plugin-extraction.md W4, plugin-platform.md §5.4 G2):     *)
(* desktop/src/renderer/plugin-frame-host.ts, ApprovalSheet.tsx `useApprovalSheet`, core/plugins/index.ts *)
(* `approvalAsk` / `approve`. A frame (untrusted) asks with a command and a folder; the core refuses a     *)
(* folder that is not the bot's and answers "allowed" for a command already allowed there; otherwise the   *)
(* app page's own sheet opens, one at a time (an ask while one is open is answered "not allowed"). The     *)
(* sheet's Allow stays off for a moment after it opens, so a click already on its way (the user meant      *)
(* something else; a frame can make the sheet appear under the pointer) lands on nothing. Only the user's  *)
(* Allow on what they read sends `plugins.approve`, with the core's command; a frame has no action that    *)
(* allows. Each ask is answered once.                                                                      *)
(* Bug = "swap": a second ask replaces the open sheet (no one-at-a-time guard): OnlyIntended fails.        *)
(* Bug = "noarm": Allow is live at once: the stray click allows, OnlyIntended fails.                      *)
EXTENDS FiniteSets

CONSTANTS Slots,  \* the frame's asks (each answered once)
          Cmds,   \* commands a frame may name
          Bug     \* "none", "swap" or "noarm"

None == "none"
Folders == {"own", "other"}
States == {"idle", "sent", "toSheet", "onSheet", "answered"}
Answers == {None, "allowed", "notAllowed", "refused"}

VARIABLES
  st, cmd, fold,  \* each ask: where it is, the command and folder the frame gave
  answer,         \* what the frame heard (once)
  sheet,          \* the ask the open sheet shows (None: closed)
  armed,          \* its Allow is live
  stray,          \* a click that was on its way when the sheet opened
  seen,           \* the command the user read on the armed sheet (None: not read yet)
  approved,       \* the commands allowed in the bot's folder (approved-commands.json)
  intended        \* the commands the user meant to allow (pressed Allow having read them)

vars == <<st, cmd, fold, answer, sheet, armed, stray, seen, approved, intended>>

TypeOK ==
  /\ st \in [Slots -> States] /\ cmd \in [Slots -> Cmds \cup {None}] /\ fold \in [Slots -> Folders \cup {None}]
  /\ answer \in [Slots -> Answers] /\ sheet \in Slots \cup {None} /\ armed \in BOOLEAN /\ stray \in BOOLEAN
  /\ seen \in Cmds \cup {None} /\ approved \subseteq Cmds /\ intended \subseteq Cmds

Init ==
  /\ st = [a \in Slots |-> "idle"] /\ cmd = [a \in Slots |-> None] /\ fold = [a \in Slots |-> None]
  /\ answer = [a \in Slots |-> None] /\ sheet = None /\ armed = FALSE /\ stray = FALSE /\ seen = None
  /\ approved = {} /\ intended = {}

Answer(a, v) == /\ st' = [st EXCEPT ![a] = "answered"] /\ answer' = [answer EXCEPT ![a] = v]
Close == /\ sheet' = None /\ armed' = FALSE /\ stray' = FALSE /\ seen' = None

\* The frame asks (ccb.requestApproval): any command, any folder.
Ask(a, c, f) ==
  /\ st[a] = "idle"
  /\ st' = [st EXCEPT ![a] = "sent"] /\ cmd' = [cmd EXCEPT ![a] = c] /\ fold' = [fold EXCEPT ![a] = f]
  /\ UNCHANGED <<answer, sheet, armed, stray, seen, approved, intended>>

\* The core (plugins.approvalAsk): not the bot's folder, refused; allowed already, said so; else the sheet.
CoreAsk(a) ==
  /\ st[a] = "sent"
  /\ IF fold[a] # "own" THEN Answer(a, "refused")
     ELSE IF cmd[a] \in approved THEN Answer(a, "allowed")
     ELSE /\ st' = [st EXCEPT ![a] = "toSheet"] /\ UNCHANGED answer
  /\ UNCHANGED <<cmd, fold, sheet, armed, stray, seen, approved, intended>>

\* The app page opens its sheet for what the core said: one at a time. A click may be on its way.
Open(a) ==
  /\ st[a] = "toSheet"
  /\ IF sheet = None
     THEN /\ st' = [st EXCEPT ![a] = "onSheet"] /\ sheet' = a /\ armed' = FALSE /\ stray' \in BOOLEAN /\ seen' = None /\ UNCHANGED answer
     ELSE IF Bug = "swap"
     THEN \* The sheet now shows the new ask; the one it showed is never answered by it.
          /\ st' = [st EXCEPT ![a] = "onSheet", ![sheet] = "answered"] /\ answer' = [answer EXCEPT ![sheet] = "notAllowed"]
          /\ sheet' = a /\ UNCHANGED <<armed, stray, seen>>
     ELSE /\ Answer(a, "notAllowed") /\ UNCHANGED <<sheet, armed, stray, seen>>
  /\ UNCHANGED <<cmd, fold, approved, intended>>

\* A click already on its way lands within the arming moment (that is what the moment is for).
StrayClick ==
  /\ sheet # None /\ stray
  /\ IF armed \/ Bug = "noarm"
     THEN /\ approved' = approved \cup {cmd[sheet]} /\ Answer(sheet, "allowed") /\ Close
     ELSE /\ stray' = FALSE /\ UNCHANGED <<st, answer, sheet, armed, seen, approved>>
  /\ UNCHANGED <<cmd, fold, intended>>

\* The moment passes: Allow is live, and the user reads the sheet.
Arm ==
  /\ sheet # None /\ ~armed /\ ~stray
  /\ armed' = TRUE /\ seen' = cmd[sheet]
  /\ UNCHANGED <<st, cmd, fold, answer, sheet, stray, approved, intended>>

\* The user presses Allow on what they read: plugins.approve with the core's command for the shown ask.
Allow ==
  /\ sheet # None /\ armed /\ seen # None
  /\ intended' = intended \cup {seen}
  /\ approved' = approved \cup {cmd[sheet]}
  /\ Answer(sheet, "allowed") /\ Close
  /\ UNCHANGED <<cmd, fold>>

Cancel ==
  /\ sheet # None
  /\ Answer(sheet, "notAllowed") /\ Close
  /\ UNCHANGED <<cmd, fold, approved, intended>>

Next ==
  \/ \E a \in Slots, c \in Cmds, f \in Folders : Ask(a, c, f)
  \/ \E a \in Slots : CoreAsk(a) \/ Open(a)
  \/ StrayClick \/ Arm \/ Allow \/ Cancel

\* The app's own steps happen; a sheet does not stay open for ever (the user answers it, one way or the other).
Spec == Init /\ [][Next]_vars /\ \A a \in Slots : WF_vars(CoreAsk(a)) /\ WF_vars(Open(a))
        /\ WF_vars(StrayClick) /\ WF_vars(Arm) /\ WF_vars(Allow \/ Cancel)

\* Only what the user read and allowed is allowed: no frame step, stray click or swapped sheet allows.
OnlyIntended == approved \subseteq intended
\* A frame hears "allowed" only for its own command in the bot's folder, once that is allowed.
AnswerTruthful == \A a \in Slots : answer[a] = "allowed" => fold[a] = "own" /\ cmd[a] \in approved
\* The sheet shows only what the core passed: the bot's own folder.
SheetIsCores == sheet # None => fold[sheet] = "own" /\ st[sheet] = "onSheet"
\* An answer is given once and kept.
AnsweredOnce == \A a \in Slots : (st[a] = "answered") <=> (answer[a] # None)

\* Every ask is answered.
EveryAskAnswered == \A a \in Slots : st[a] = "sent" ~> st[a] = "answered"
=============================================================================

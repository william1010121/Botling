------------------------------- MODULE TurnsAgy -------------------------------
(* Turns.tla with an Antigravity head (TurnsAgy.cfg): your line joins the turn under way only as an insert on its  *)
(* next tool result, nothing is paused, and its workers' reports start only when the app lets them                 *)
(* (canStartReport). Bug = "reportgate" (TurnsAgy_bug.cfg): a report waited for an empty queue while a line in the *)
(* queue waited, held, for that report (HoldEnds violated).                                                       *)
EXTENDS Turns
=============================================================================

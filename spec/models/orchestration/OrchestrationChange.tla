-------------------------- MODULE OrchestrationChange --------------------------
(* Orchestration.tla with a plugin change and no restart (OrchestrationChange.cfg). With no cap (2026-11-17) two      *)
(* workers can be at work at once, so Orchestration.cfg (a restart, no change) and this cfg split what one cfg       *)
(* checked before to stay CI-sized; Orchestration_full.cfg has both. The same properties.                           *)
EXTENDS Orchestration
=============================================================================

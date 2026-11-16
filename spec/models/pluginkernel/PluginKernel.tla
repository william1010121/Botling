---------------------------- MODULE PluginKernel ----------------------------
(* The plugin kernel's lifecycle, dependencies and teardown (P1-P6): Web/src/plugin-kernel/ (kernel.ts, services.ts).
   Design: .bot/artifacts/architecture-v3/protocol-v1.md D52-D57, plan-change-plugin-kernel.md; brief:
   tla-brief-plugin-kernel.md section 1. The kernel (in the shell and in each server's plugin host) loads plugin
   instances, keeps every registration with its undo, connects services and slots between plugins, and unloads in
   dependency order. spec/reference/pluginkernel.ts is this machine in TypeScript; spec/tests/pluginkernel.spec.test.ts
   replays the real kernel's event log through it (desktop/spec-adapters/pluginkernel-adapter.ts).

   Three plugins: p1 provides service s1 and owns slot k1; p2 provides s2, owns slot k2 and contributes to k1; p3
   requires s1 and s2 and contributes to k1 and k2. q depends on p when q requires a service p provides or
   contributes to a slot p owns. A load request comes with the plugins it depends on (the plugin manager resolves
   them); a plugin starts loading only when its providers are loading or active and none is leaving, and the owners
   of the slots it contributes to are active and not leaving; it becomes active when they are all active. While
   loading or active it registers (a slot contribution, a service, a listener), at once or asynchronously (an async
   registration that settles after the plugin was asked to unload is undone at once by the kernel). An unload
   request first asks the plugin's dependents to unload (CascadeUnload); the plugin begins
   to unload when no dependent is loading, active or unloading, then runs its undos last-in first-out; an undo that
   throws is contained (removed, the rest go on). A hot swap is an unload and a load of the new code under the same
   name and provides. A cycle in Requires is refused at load in the shipped kernel (here: the topology is acyclic).

   Changes to the brief, found here:
     K1  The brief lets a provider begin to unload when no dependent is loading or active. A dependent that is still
         unloading then keeps its contribution in the provider's slot after the provider is absent (NoOrphan fails,
         Bug "unloadingdep"). The provider must wait until its dependents are absent.
     K2  The brief gates a load only on the plugin's providers (Requires). A plugin that only contributes to another's
         slot could then start loading while the slot's owner unloads, and its contribution would race the owner's
         teardown (TeardownOrder fails, Bug "loadintounloading"). A load must also wait while any plugin it depends
         on (provider or slot owner) is unloading or asked to unload.

   Changes to match the shipped kernel (M7-11c, found by the conformance test):
     K3  A dependent asked to unload stays wanted (services.ts: "the dependents stay wanted"): it loads again once
         what it depends on is back, after a swap or a later load of the provider; before, only after a swap.
     K4  An instance asked to unload accepts no new registration (kernel.ts: the instance is "unloading" from the
         request on, while it waits for its dependents): Register and RegisterAsyncStart need Open(p), and an async
         registration that settles after the request is undone at once. ClosedUnload covers the request too.
     K5  A plugin starts loading and becomes active only while the owner of every slot it contributes to is active
         (services.ts checkCanLoad, checkCanActivate; K2 only kept it from loading while the owner was leaving), and a
         load request brings those owners too (Kernel.dependencyGraph). New invariant OwnerActive, while loading as well as active (the
         M7-11a review's follow-up, for declarations installed before the load; installing an owner late is not
         modelled).

   PluginKernel.cfg is the CI size (one registration per plugin). PluginKernel_case_full.cfg (two, so undo order
   matters) runs by hand: `spec/tools/tlc.sh PluginKernel.tla -config PluginKernel_case_full.cfg`.

   Bug = "noundo":          FinishUnload does not empty regs (NoResidue fails).
   Bug = "lateasync":       an async registration that settles after unload began is kept (2.x Web/host disposer
                            pushed after unload) (ClosedUnload / NoResidue fail).
   Bug = "providerfirst":   BeginUnload without the dependents check (TeardownOrder fails).
   Bug = "acceptunloading": Register is enabled while unloading (ClosedUnload fails).
   Bug = "failstops":       a failed undo stops the rest; the plugin goes absent with what is left (NoResidue fails).
   Bug = "cycle":           p1 requires s2 and p2 requires s1, and the kernel does not refuse the cycle (LoadEnds
                            fails).
   Bug = "contribnoowner":  a slot contribution registers while the slot's owner is absent, and K5 is off too (under
                            K5 a live contributor's owner is never absent, so the check in CanReg is a second guard)
                            (NoOrphan fails).
   Bug = "unloadingdep":    K1 reversed: a provider begins to unload while a dependent is still unloading
                            (NoOrphan fails).
   Bug = "loadintounloading": K2 reversed: StartLoad checks only providers, not the owners of slots the plugin
                            contributes to (TeardownOrder fails).
   Bug = "ownerloading":    K5 reversed (the passed model before M7-11c): a contributor loads while its slot's owner is
                            absent or loading, and only waits while the owner is leaving (OwnerActive fails). *)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  P1, P2, P3, S1, S2, K1, K2,
  MaxSwap, MaxFail, MaxRegs,
  Bug

ASSUME Bug \in {"none", "noundo", "lateasync", "providerfirst", "acceptunloading", "failstops", "cycle",
                "contribnoowner", "unloadingdep", "loadintounloading", "ownerloading"}

Plugins == {P1, P2, P3}
Provides == (P1 :> {S1}) @@ (P2 :> {S2}) @@ (P3 :> {})
Requires == (P1 :> (IF Bug = "cycle" THEN {S2} ELSE {})) @@ (P2 :> (IF Bug = "cycle" THEN {S1} ELSE {}))
            @@ (P3 :> {S1, S2})
SlotOwner == (K1 :> P1) @@ (K2 :> P2)
Contributes == (P1 :> {}) @@ (P2 :> {K1}) @@ (P3 :> {K1, K2})

Providers(p) == {q \in Plugins : Requires[p] \cap Provides[q] # {}}
\* The owners of the slots p contributes to, and everything p depends on (two levels: the topology has depth 2).
Owners(p) == {SlotOwner[k] : k \in Contributes[p]} \ {p}
Deps(p) == Providers(p) \cup Owners(p)
AllDeps(p) == Deps(p) \cup UNION {Deps(q) : q \in Deps(p)}
Dependents(p) == {q \in Plugins : Requires[q] \cap Provides[p] # {} \/ \E k \in Contributes[q] : SlotOwner[k] = p}
\* What p may register.
Regs(p) == {[kind |-> "service", t |-> s] : s \in Provides[p]} \cup {[kind |-> "slot", t |-> k] : k \in Contributes[p]}
           \cup {[kind |-> "listener", t |-> "none"]}
AllRegs == UNION {Regs(p) : p \in Plugins}
Live == {"loading", "active"}
None == "none"

VARIABLES
  state,    \* [Plugins -> {"absent", "loading", "active", "unloading"}]
  regs,     \* [Plugins -> Seq(Reg)]: registrations in order
  pending,  \* [Plugins -> 0..MaxRegs]: async registrations started and not settled
  undoing,  \* [Plugins -> Seq(Reg)]: the undo stack while unloading
  want,     \* [Plugins -> {"none", "load", "unload"}]
  again,    \* [Plugins -> BOOLEAN]: load again after the unload (a hot swap, or a dependent asked to unload)
  nFail, nSwap

vars == <<state, regs, pending, undoing, want, again, nFail, nSwap>>

Range(f) == {f[i] : i \in DOMAIN f}

TypeOK ==
  /\ state \in [Plugins -> {"absent", "loading", "active", "unloading"}]
  /\ \A p \in Plugins : regs[p] \in Seq(AllRegs) /\ Len(regs[p]) <= MaxRegs + 1 /\ undoing[p] \in Seq(AllRegs)
  /\ pending \in [Plugins -> 0..MaxRegs] /\ want \in [Plugins -> {"none", "load", "unload"}]
  /\ again \in [Plugins -> BOOLEAN] /\ nFail \in 0..MaxFail /\ nSwap \in 0..MaxSwap

Init ==
  /\ state = [p \in Plugins |-> "absent"] /\ regs = [p \in Plugins |-> <<>>] /\ pending = [p \in Plugins |-> 0]
  /\ undoing = [p \in Plugins |-> <<>>] /\ want = [p \in Plugins |-> None] /\ again = [p \in Plugins |-> FALSE]
  /\ nFail = 0 /\ nSwap = 0

-----------------------------------------------------------------------------
(* Requests (the user, the plugin manager, a bot's write of new code) *)

\* Load p with the plugins it depends on (transitively: providers and slot owners).
RequestLoad(p) ==
  LET Need == {p} \cup AllDeps(p) IN
  /\ state[p] = "absent" /\ want[p] = None
  /\ want' = [q \in Plugins |-> IF q \in Need /\ state[q] = "absent" /\ want[q] = None THEN "load" ELSE want[q]]
  /\ UNCHANGED <<state, regs, pending, undoing, again, nFail, nSwap>>
RequestUnload(p) ==
  /\ state[p] \in Live /\ want[p] = None /\ want' = [want EXCEPT ![p] = "unload"]
  /\ UNCHANGED <<state, regs, pending, undoing, again, nFail, nSwap>>
\* A hot swap: unload, then load the new code (same name, same provides).
Swap(p) ==
  /\ state[p] = "active" /\ want[p] = None /\ nSwap < MaxSwap /\ nSwap' = nSwap + 1
  /\ want' = [want EXCEPT ![p] = "unload"] /\ again' = [again EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<state, regs, pending, undoing, nFail>>

-----------------------------------------------------------------------------
(* The kernel *)

\* p takes registrations: loading or active and not asked to unload (K4).
Open(p) == state[p] \in Live /\ want[p] # "unload"

StartLoad(p) ==
  /\ want[p] = "load" /\ state[p] = "absent"
  /\ \A q \in Providers(p) : state[q] \in Live /\ want[q] # "unload"
  /\ Bug = "loadintounloading" \/
     \A q \in Owners(p) : /\ state[q] = "active" \/ Bug \in {"ownerloading", "contribnoowner"}
                         /\ state[q] # "unloading" /\ want[q] # "unload"
  /\ state' = [state EXCEPT ![p] = "loading"]
  /\ UNCHANGED <<regs, pending, undoing, want, again, nFail, nSwap>>

Activate(p) ==
  /\ state[p] = "loading"
  /\ \A q \in IF Bug \in {"ownerloading", "contribnoowner"} THEN Providers(p) ELSE Deps(p) : state[q] = "active"
  /\ state' = [state EXCEPT ![p] = "active"]
  /\ want' = [want EXCEPT ![p] = IF @ = "load" THEN None ELSE @]
  /\ UNCHANGED <<regs, pending, undoing, again, nFail, nSwap>>

\* A registration p may make now: a slot contribution needs the slot's owner present.
CanReg(p, r) == r \in Regs(p) /\ (r.kind = "slot" => (state[SlotOwner[r.t]] # "absent" \/ Bug = "contribnoowner"))

Register(p, r) ==
  /\ Open(p) \/ (Bug = "acceptunloading" /\ state[p] = "unloading")
  /\ Len(regs[p]) + pending[p] < MaxRegs /\ CanReg(p, r)
  /\ regs' = [regs EXCEPT ![p] = Append(@, r)]
  /\ UNCHANGED <<state, pending, undoing, want, again, nFail, nSwap>>
RegisterAsyncStart(p) ==
  /\ Open(p) /\ Len(regs[p]) + pending[p] < MaxRegs /\ pending' = [pending EXCEPT ![p] = @ + 1]
  /\ UNCHANGED <<state, regs, undoing, want, again, nFail, nSwap>>
\* It settles: kept if p is still open (and may still make it), else undone at once (Bug: kept).
RegisterAsyncSettle(p, r) ==
  /\ pending[p] > 0 /\ r \in Regs(p) /\ pending' = [pending EXCEPT ![p] = @ - 1]
  /\ regs' = IF (Open(p) /\ CanReg(p, r)) \/ Bug = "lateasync" THEN [regs EXCEPT ![p] = Append(@, r)]
             ELSE regs
  /\ UNCHANGED <<state, undoing, want, again, nFail, nSwap>>

\* An unload of p first asks its live dependents to unload; they stay wanted and load again when they may (K3).
CascadeUnload(p, q) ==
  /\ want[p] = "unload" /\ q \in Dependents(p) /\ q # p /\ state[q] \in Live /\ want[q] # "unload"
  /\ want' = [want EXCEPT ![q] = "unload"] /\ again' = [again EXCEPT ![q] = TRUE]
  /\ UNCHANGED <<state, regs, pending, undoing, nFail, nSwap>>
\* A dependent that only wanted to load gives way too (it waits for the provider to come back).
DepBusy(p) == {q \in Dependents(p) \ {p} :
                 state[q] \in Live \/ (state[q] = "unloading" /\ Bug # "unloadingdep")}
BeginUnload(p) ==
  /\ want[p] = "unload" /\ state[p] \in Live
  /\ Bug = "providerfirst" \/ DepBusy(p) = {}
  /\ state' = [state EXCEPT ![p] = "unloading"] /\ undoing' = [undoing EXCEPT ![p] = regs[p]]
  /\ UNCHANGED <<regs, pending, want, again, nFail, nSwap>>

\* Pop the last registration and undo it; an undo that throws is contained (Bug "failstops": the rest are skipped).
RunUndo(p, fail) ==
  /\ state[p] = "unloading" /\ undoing[p] # <<>>
  /\ fail => nFail < MaxFail
  /\ nFail' = IF fail THEN nFail + 1 ELSE nFail
  /\ undoing' = [undoing EXCEPT ![p] = IF fail /\ Bug = "failstops" THEN <<>> ELSE SubSeq(@, 1, Len(@) - 1)]
  /\ regs' = [regs EXCEPT ![p] = IF fail /\ Bug = "failstops" THEN @ ELSE SubSeq(@, 1, Len(@) - 1)]
  /\ UNCHANGED <<state, pending, want, again, nSwap>>

FinishUnload(p) ==
  /\ state[p] = "unloading" /\ (undoing[p] = <<>> \/ Bug = "noundo") /\ pending[p] = 0
  /\ state' = [state EXCEPT ![p] = "absent"] /\ undoing' = [undoing EXCEPT ![p] = <<>>]
  /\ regs' = IF Bug = "failstops" \/ Bug = "noundo" THEN regs ELSE [regs EXCEPT ![p] = <<>>]
  /\ want' = [want EXCEPT ![p] = IF again[p] THEN "load" ELSE None] /\ again' = [again EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<pending, nFail, nSwap>>

-----------------------------------------------------------------------------

Next ==
  \E p \in Plugins :
    \/ RequestLoad(p) \/ RequestUnload(p) \/ Swap(p)
    \/ StartLoad(p) \/ Activate(p) \/ RegisterAsyncStart(p) \/ BeginUnload(p) \/ FinishUnload(p)
    \/ \E r \in Regs(p) : Register(p, r) \/ RegisterAsyncSettle(p, r)
    \/ \E q \in Plugins : CascadeUnload(p, q)
    \/ \E fail \in BOOLEAN : RunUndo(p, fail)

(* The kernel does its part; requests and registrations by plugins owe nothing. StartLoad is strongly fair: under K2
   a plugin that only contributes to p1's slot may load only while p1 is not leaving, and a user who unloads and
   loads p1 again and again would otherwise starve it (the kernel starts a waiting load whenever it may). *)
Fairness ==
  \A p \in Plugins :
    /\ SF_vars(StartLoad(p)) /\ WF_vars(Activate(p)) /\ WF_vars(BeginUnload(p)) /\ WF_vars(FinishUnload(p))
    /\ WF_vars(\E fail \in BOOLEAN : RunUndo(p, fail)) /\ WF_vars(\E r \in Regs(p) : RegisterAsyncSettle(p, r))
    /\ \A q \in Plugins : WF_vars(CascadeUnload(p, q))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

\* P1: an absent plugin holds no registration and nothing that could still register.
NoResidue == \A p \in Plugins : state[p] = "absent" => regs[p] = <<>> /\ pending[p] = 0
\* P2: every slot contribution has its owner and the slot's owner present.
NoOrphan == \A p \in Plugins : \A r \in Range(regs[p]) :
              r.kind = "slot" => state[p] # "absent" /\ state[SlotOwner[r.t]] # "absent"
\* P3: an active plugin's required services each have an active provider.
DependencyGuard == \A p \in Plugins : state[p] = "active" => \A q \in Providers(p) : state[q] = "active"
\* K5: a loading or active plugin's slot owners are active (it loads only while they are, and they leave only after it,
\* so no contribution waits for its slot).
OwnerActive == \A p \in Plugins : state[p] \in Live => \A q \in Owners(p) : state[q] = "active"
\* P4: a provider runs undos only while no dependent is loading or active (and the stack is popped from the top, so
\* what is left registered is exactly what is left to undo).
TeardownOrder == \A p \in Plugins : state[p] = "unloading" /\ Bug # "failstops" =>
                   /\ \A q \in Dependents(p) \ {p} : state[q] \notin Live
                   /\ SubSeq(regs[p], 1, Len(undoing[p])) = undoing[p]
\* P5: nothing registers once a plugin is asked to unload (K4), while it unloads, or while it is absent.
ClosedUnload == [][\A p \in Plugins : state[p] \in {"unloading", "absent"} \/ want[p] = "unload" =>
                                        Len(regs'[p]) <= Len(regs[p])]_vars

(* Liveness (P6) *)

\* A requested unload ends absent.
UnloadEnds == \A p \in Plugins : want[p] = "unload" ~> state[p] = "absent"
\* A requested load ends active while what it depends on, and theirs, stay requested or present (none asked to leave).
Avail(p) == \A q \in AllDeps(p) : want[q] # "unload" /\ (state[q] \in Live \/ want[q] = "load")
LoadEnds == \A p \in Plugins : (want[p] = "load" /\ [](want[p] = "load" => Avail(p))) ~> state[p] \in Live
=============================================================================

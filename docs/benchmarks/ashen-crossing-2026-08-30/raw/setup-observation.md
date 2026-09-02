# HoneyBee fresh-project setup observation

Two attempts to register the new `controlled-multi` project through HoneyBee 0.6.0 failed after roughly 125 seconds each with `workspace-storage.install-failed`. The setup path invoked the workspace-storage host installer with replacement semantics and requested Windows elevation; elevation was not completed. The existing `UnityWorkspaceStorage` service was already running as LocalSystem.

To measure the remaining Run/Apply workflow without changing product code, the experiment reused profile `1199116a-535b-4db8-8649-25997c124474` as a staging path. Its original `Assets/FrontierSiege` tree was moved to the experiment's raw backup, each condition was staged in turn, and the original tree was restored at the end. Restoration checks were `frontierRestored=true` and `ashenAbsent=true`.

This is an end-to-end HoneyBee setup failure and is disclosed in the report. The roughly 250 seconds are not folded into the precise implementation timing because the failed setup attempts did not produce timestamped run artifacts.

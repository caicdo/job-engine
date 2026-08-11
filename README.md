# JobEngine

A reusable "shift-based job" engine for Roblox RP/life-sim games. It handles the part that's the
same in every one of these games regardless of theme — start/end a shift, track elapsed time,
pay passive income on a timer, detect and warn on AFK, apply time-based boost tiers, gate a job
behind a gamepass, and hand off to per-job custom logic through a small plugin interface — so
you only have to write the part that's actually specific to your game.

Extracted and generalized from a production RP game's job system (originally four jobs: police,
riot police, coffee farmer, street vendor). Every integration point that used to reach into that
game's other systems — its quest system, its persistence layer, its currency function, a
"can't be a cop while wanted" rule — has been replaced with an injectable option or a `Signal`,
so **this module has no dependency on any other system in your game.**

Written in [TypeScript](https://roblox-ts.com/) (compiled to Luau via roblox-ts) — see
[Installation](#installation) for the build step.

## Scope

This repo covers the **server-side engine**: `JobEngine` + `ShiftSession`, plus the Behavior
plugin interface and a fully worked example. It intentionally does not include client-side UI
(a job-selection menu, a shift HUD) — those are thin, game-specific, and better built directly
against the `RemoteEvent`s this engine already fires (see [Client integration](#client-integration)
below) than shipped as one-size-fits-all components.

## Features

- Start/end shift lifecycle with a hard "can't hold two jobs at once" rule
- Passive income every 30s while not AFK, configurable per job
- AFK detection with an early warning, then an automatic shift-end
- Time-based boost tiers (e.g. 1.25x after 5 minutes, 1.5x after 15) applied to payout at shift end
- Optional gamepass gate per job via `MarketplaceService`
- Per-job Team auto-creation and assignment, restored to a configurable default team on shift end
- A `Behavior` plugin interface (`OnStart`/`OnActionReward`/`OnAFKStateChanged`/`OnEnd`/`Destroy`)
  for job-specific logic, loaded dynamically by job ID — add a job without touching the engine
- `Signal`-based `ShiftStarted`/`ShiftEnded`/`ActionRewarded` events for other systems (quests,
  XP, analytics) to subscribe to, instead of the engine calling into them directly
- Every other integration point — payout, start-time validation, tutorial gating, where to look
  for `ProximityPrompt`s — passed in through one options table

## Installation

This is a [roblox-ts](https://roblox-ts.com/) project synced into Roblox with [Rojo](https://rojo.space/).

Prerequisites: Node.js 18+, npm, and Rojo 7+ (pinned in [rokit.toml](rokit.toml) — run
`rokit install` if you use [Rokit](https://github.com/rojo-rbx/rokit)).

```bash
npm install        # installs roblox-ts + Roblox API type definitions
npm run build       # compiles src/**/*.ts -> out/**/*.luau
rojo build -o JobEngine.rbxlx   # or `rojo serve` while Studio has the Rojo plugin connected
```

`npm run watch` recompiles on save instead of a one-shot build — pair it with `rojo serve` for
live sync into Studio. `default.project.json`'s `$path`s point at `out/`, not `src/` — that's
where the compiler writes; point your own Rojo project at `out/shared` (→ `ReplicatedStorage.Shared`)
and `out/server` (→ `ServerScriptService.Server`) if you're integrating this into a larger place
file rather than building it standalone. The example doesn't require any scene setup — it prints
to the output, since `LocationsRoot` gracefully no-ops when `workspace.JobLocations` doesn't exist.

## Quick start

```ts
import { JobEngine } from "server/JobEngine";
import Jobs from "shared/Config/Jobs";

const engine = new JobEngine({
	Jobs: Jobs,
	Payout: (player, amount) => {
		(player.WaitForChild("leaderstats").WaitForChild("Money") as NumberValue).Value += amount;
	},
	DefaultTeam: "Citizens",
	BehaviorsFolder: script.Parent!.FindFirstChild("Behaviors"),
	ValidateStart: (player, jobId) => {
		if (jobId === "Guard" && player.GetAttribute("Wanted")) {
			return { ok: false, reason: "You can't work as a Guard while wanted." };
		}
		return { ok: true };
	},
	LocationsRoot: game.GetService("Workspace").FindFirstChild("JobLocations"),
});

engine.ShiftStarted.Connect((player, jobId) => {
	QuestSystem.AddValue(player, "Jobs started", 1);
});

engine.ShiftEnded.Connect((player, jobId, payout, reason) => {
	Analytics.LogShiftEnd(player, jobId, payout, reason);
});

game.GetService("Players").PlayerRemoving.Connect((player) => {
	engine.OnPlayerRemoving(player);
});
```

See [`src/server/Example.server.ts`](src/server/Example.server.ts) for the complete runnable
version, [`src/shared/Config/Jobs.ts`](src/shared/Config/Jobs.ts) for the job config shape, and
[`src/server/Behaviors/Guard.ts`](src/server/Behaviors/Guard.ts) for a worked Behavior example
(including why per-shift state has to be keyed by `session`, not stored on the object).

## Options reference

| Option | Required | Purpose |
|---|---|---|
| `Jobs` | ✅ | `Record<string, JobConfig>` — see `shared/Types.ts` |
| `Payout` | ✅ | `(player, amount) => void` — how a shift's earnings are actually given |
| `BoostsUnlocked` | | `(player, jobId) => boolean` — gate boost tiers behind a purchase, level, etc. |
| `DefaultTeam` | | Team every player is restored to when a shift ends |
| `ValidateStart` | | `(player, jobId, config) => { ok, reason? }` — block a shift start with a custom rule |
| `BehaviorsFolder` | | Folder of per-job `Behavior` modules, looked up by job ID |
| `LocationsRoot` | | Root whose children (named by job ID) get their `ProximityPrompt`s auto-wired |
| `ShouldShowTutorial` / `OnTutorialShown` | | Gate + persist a "first time doing this job" flag |
| `RemoteFolder` / `RemoteFolderName` | | Where the engine's `RemoteEvent`s are created (default `ReplicatedStorage.Events.JobSystem`) |

## Client integration

`JobEngine` creates these `RemoteEvent`s under `ReplicatedStorage.Events.JobSystem` (or wherever
`RemoteFolder`/`RemoteFolderName` point):

| Remote | Direction | Payload |
|---|---|---|
| `ShiftStarted` | server → client | `{jobId, jobName, minutePay, boostsUnlocked, showTutorial, startTimestamp}` |
| `ShiftUpdated` | server → client | `{cachedMoney, elapsedSeconds}` |
| `ShiftEnded` | server → client | `{payout, reason, jobId, elapsedSeconds, salaryMoney, actionMoney, boost}` |
| `AFKWarning` | server → client | none |
| `JobError` | server → client | error message string |
| `PromptGamepass` | server → client | `gamepassId, jobDisplayName` |
| `ActivityPing` | client → server | none — call periodically (e.g. on input) to reset the AFK timer |
| `FinishShift` | client → server | none — ends the player's active shift |

A shift-selection menu and a shift HUD are both just listeners on these remotes; wire them
however fits your game's existing UI framework.

## License

MIT — see [LICENSE](LICENSE).

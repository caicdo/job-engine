import { JobConfig, RemoteEvents, ShiftEndReason } from "shared/Types";
import { Signal } from "shared/Signal";
import { Behavior, SessionOptions, ShiftSession } from "server/ShiftSession";

const ReplicatedStorage = game.GetService("ReplicatedStorage");
const MarketplaceService = game.GetService("MarketplaceService");
const Teams = game.GetService("Teams");

export interface ValidateStartResult {
	ok: boolean;
	reason?: string;
}

export interface EngineOptions {
	Jobs: Record<string, JobConfig>;
	Payout: (player: Player, amount: number) => void;

	// Defaults to true for every job.
	BoostsUnlocked?: (player: Player, jobId: string) => boolean;

	DefaultTeam?: string;
	ValidateStart?: (player: Player, jobId: string, config: JobConfig) => ValidateStartResult;
	BehaviorsFolder?: Instance;

	// Direct children are matched by name to a jobId; any ProximityPrompt under one auto-starts
	// that job on Triggered.
	LocationsRoot?: Instance;

	ShouldShowTutorial?: (player: Player, jobId: string) => boolean;
	OnTutorialShown?: (player: Player, jobId: string) => void;

	// Defaults to ReplicatedStorage.Events.JobSystem.
	RemoteFolder?: Instance;
	RemoteFolderName?: string;
}

function loadBehavior(folder: Instance | undefined, jobId: string): Behavior | undefined {
	if (!folder) return undefined;
	const module = folder.FindFirstChild(jobId);
	if (!module || !module.IsA("ModuleScript")) return undefined;
	const [ok, result] = pcall(() => require(module) as unknown as Behavior);
	if (!ok) {
		warn(`[JobEngine] Failed to load behavior for '${jobId}': ${result}`);
		return undefined;
	}
	return result;
}

export class JobEngine {
	public readonly ShiftStarted = new Signal<[player: Player, jobId: string]>();
	public readonly ShiftEnded = new Signal<[player: Player, jobId: string, payout: number, reason: ShiftEndReason]>();
	public readonly ActionRewarded = new Signal<[player: Player, jobId: string, rewardId: string, amount: number]>();

	private events!: RemoteEvents;
	private readonly activeShifts = new Map<Player, ShiftSession>();
	private readonly lastPingTime = new Map<number, number>();
	private readonly jobTeamMap = new Map<string, string>();

	constructor(private readonly options: EngineOptions) {
		this.setupRemotes();
		this.setupTeams();
		if (options.LocationsRoot) {
			this.setupLocationPrompts(options.LocationsRoot);
		}
	}

	private setupRemotes(): void {
		const options = this.options;
		const root = options.RemoteFolder ?? ReplicatedStorage.WaitForChild("Events");
		const folderName = options.RemoteFolderName ?? "JobSystem";

		let remoteFolder = root.FindFirstChild(folderName);
		if (!remoteFolder) {
			remoteFolder = new Instance("Folder");
			remoteFolder.Name = folderName;
			remoteFolder.Parent = root;
		}

		const remoteNames = [
			"ShiftStarted",
			"ShiftUpdated",
			"ShiftEnded",
			"FinishShift",
			"ActivityPing",
			"PromptGamepass",
			"JobError",
			"AFKWarning",
		] as const;

		const created = {} as RemoteEvents;
		for (const name of remoteNames) {
			let re = remoteFolder.FindFirstChild(name);
			if (!re) {
				re = new Instance("RemoteEvent");
				re.Name = name;
				re.Parent = remoteFolder;
			}
			created[name] = re as RemoteEvent;
		}
		this.events = created;

		this.events.FinishShift.OnServerEvent.Connect((plr) => {
			this.EndShift(plr, "manual");
		});

		// Rate limit is enforced server-side, independent of any client debounce, so a modified
		// client can't spam this to defeat AFK detection.
		this.events.ActivityPing.OnServerEvent.Connect((plr) => {
			const now = os.clock();
			const userId = plr.UserId;
			const last = this.lastPingTime.get(userId);
			if (last !== undefined && now - last < 8) return;
			this.lastPingTime.set(userId, now);

			const session = this.activeShifts.get(plr);
			if (session) {
				session.ResetAFK();
			}
		});
	}

	private setupTeams(): void {
		for (const [jobId, config] of pairs(this.options.Jobs)) {
			const teamName = config.Team ?? jobId;
			this.jobTeamMap.set(jobId, teamName);
			if (Teams.FindFirstChild(teamName) === undefined) {
				const team = new Instance("Team");
				team.Name = teamName;
				team.AutoAssignable = false;
				team.TeamColor = BrickColor.White();
				team.Parent = Teams;
			}
		}
	}

	private setupLocationPrompts(locationsRoot: Instance): void {
		for (const child of locationsRoot.GetChildren()) {
			const jobId = child.Name;
			if (!this.options.Jobs[jobId]) continue;
			for (const desc of child.GetDescendants()) {
				if (desc.IsA("ProximityPrompt")) {
					desc.Triggered.Connect((plr) => {
						this.StartShift(plr, jobId);
					});
				}
			}
		}
	}

	public ActionReward(plr: Player, rewardId: string): void {
		const session = this.activeShifts.get(plr);
		if (!session) return;

		// Only accept reward IDs that exist in this job's config.
		const config = this.options.Jobs[session.Job];
		const rewards = config?.ActionRewards;
		const amount = rewards?.[rewardId];
		if (amount === undefined) {
			warn(`[JobEngine] Unknown rewardId '${rewardId}' for job '${session.Job}'`);
			return;
		}

		session.ActionReward(rewardId);
		this.ActionRewarded.Fire(plr, session.Job, rewardId, amount);
	}

	public StartShift(plr: Player, jobId: string): void {
		const options = this.options;
		const config = options.Jobs[jobId];
		if (!config) {
			warn(`[JobEngine] Unknown jobId: ${jobId}`);
			return;
		}

		const currentSession = this.activeShifts.get(plr);
		if (currentSession) {
			if (currentSession.Job === jobId) {
				this.events.JobError.FireClient(plr, `You're already working as a ${config.DisplayName}`);
			} else {
				this.events.JobError.FireClient(plr, `You need to leave your job to work as a ${config.DisplayName}`);
			}
			return;
		}

		if (options.ValidateStart) {
			const result = options.ValidateStart(plr, jobId, config);
			if (!result.ok) {
				this.events.JobError.FireClient(plr, result.reason ?? `You can't start working as a ${config.DisplayName}`);
				return;
			}
		}

		if (config.RequiresGamepassId !== undefined) {
			const [ok, owned] = pcall(() =>
				MarketplaceService.UserOwnsGamePassAsync(User.fromId(plr.UserId), config.RequiresGamepassId!),
			);
			if (!ok || !owned) {
				this.events.PromptGamepass.FireClient(plr, config.RequiresGamepassId, config.DisplayName);
				return;
			}
		}

		let showTutorial = false;
		if (options.ShouldShowTutorial) {
			showTutorial = options.ShouldShowTutorial(plr, jobId);
			if (showTutorial && options.OnTutorialShown) {
				options.OnTutorialShown(plr, jobId);
			}
		}

		const behavior = loadBehavior(options.BehaviorsFolder, jobId);
		const boostsUnlocked = options.BoostsUnlocked === undefined || options.BoostsUnlocked(plr, jobId);

		const sessionOptions: SessionOptions = {
			BoostsUnlocked: boostsUnlocked,
			Payout: options.Payout,
			DefaultTeam: options.DefaultTeam,
			ShowTutorial: showTutorial,
		};

		const session: ShiftSession = new ShiftSession(plr, jobId, config, sessionOptions, behavior, this.events, () => {
			// Only clear if this session is still the active one, so a replaced session's
			// callback can't wipe out its successor.
			if (this.activeShifts.get(plr) === session) {
				this.activeShifts.delete(plr);
			}
		});

		this.activeShifts.set(plr, session);
		session.Start();
		this.ShiftStarted.Fire(plr, jobId);

		const teamName = this.jobTeamMap.get(jobId);
		if (teamName) {
			const team = Teams.FindFirstChild(teamName);
			if (team) {
				plr.Team = team as Team;
			}
		}
	}

	public EndShift(plr: Player, reason?: ShiftEndReason): void {
		const session = this.activeShifts.get(plr);
		if (!session) return;
		const jobId = session.Job;
		const finalReason = reason ?? "manual";
		const payout = session.End(finalReason);
		this.ShiftEnded.Fire(plr, jobId, payout, finalReason);
	}

	public GetSession(plr: Player): ShiftSession | undefined {
		return this.activeShifts.get(plr);
	}

	public OnPlayerRemoving(plr: Player): void {
		this.lastPingTime.delete(plr.UserId);
		this.EndShift(plr, "disconnect");
	}
}

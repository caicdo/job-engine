import { JobConfig, RemoteEvents, ShiftEndReason } from "shared/Types";

export { JobConfig, ShiftEndReason } from "shared/Types";

const Teams = game.GetService("Teams");

// require() caches modules, so the same Behavior object is shared across every concurrent shift
// of a job — keep it stateless and key any per-shift bookkeeping off the `session` argument.
export interface Behavior {
	OnStart?(session: ShiftSession): void;
	OnActionReward?(session: ShiftSession, rewardId: string, amount: number): void;
	OnAFKStateChanged?(session: ShiftSession, isAFK: boolean): void;
	OnEnd?(session: ShiftSession, reason: ShiftEndReason, payout: number): void;
	Destroy?(): void;
}

export interface SessionOptions {
	BoostsUnlocked: boolean;
	Payout: (player: Player, amount: number) => void;
	DefaultTeam?: string;
	ShowTutorial?: boolean;
}

export class ShiftSession {
	public readonly Player: Player;
	public readonly Job: string;
	public StartTime: number;
	public LastActionTime: number;
	public CachedMoney = 0;
	public SalaryMoney = 0;
	public IsAFK = false;

	private ended = false;
	private lastBoost = 1;
	private afkWarned = false;
	private connections = new Array<RBXScriptConnection>();
	private threads = new Array<thread>();

	// Does NOT start loops — call .Start() after creation.
	constructor(
		player: Player,
		jobId: string,
		private readonly config: JobConfig,
		private readonly options: SessionOptions,
		private readonly behavior: Behavior | undefined,
		private readonly events: RemoteEvents,
		private readonly onDestroy?: () => void,
	) {
		this.Player = player;
		this.Job = jobId;
		this.StartTime = os.clock();
		this.LastActionTime = os.clock();
	}

	private calculateBoost(): number {
		if (!this.options.BoostsUnlocked) return 1;
		const boosts = this.config.Boosts;
		if (!boosts || boosts.size() === 0) return 1;
		const elapsed = os.clock() - this.StartTime;
		let boost = 1;
		for (let i = boosts.size() - 1; i >= 0; i--) {
			const tier = boosts[i];
			if (elapsed >= tier.Time) {
				boost = tier.Multiplier;
				break;
			}
		}
		return boost;
	}

	private fireUpdated(): void {
		const elapsed = os.clock() - this.StartTime;
		this.events.ShiftUpdated.FireClient(this.Player, {
			cachedMoney: this.CachedMoney,
			elapsedSeconds: math.floor(elapsed),
		});
	}

	public ResetAFK(): void {
		this.LastActionTime = os.clock();
	}

	public ActionReward(rewardId: string): void {
		const amount = this.config.ActionRewards[rewardId];
		if (amount === undefined) return;

		this.CachedMoney += amount;
		this.LastActionTime = os.clock();
		this.fireUpdated();

		this.behavior?.OnActionReward?.(this, rewardId, amount);
	}

	// The boost multiplier isn't applied here — it's computed once from CachedMoney at End().
	public AddCachedMoney(amount: number): void {
		this.CachedMoney += amount;
		this.fireUpdated();
	}

	public Start(): void {
		this.events.ShiftStarted.FireClient(this.Player, {
			jobId: this.Job,
			jobName: this.config.DisplayName,
			minutePay: this.config.FixedIncomePerMinute,
			boostsUnlocked: this.options.BoostsUnlocked,
			showTutorial: this.options.ShowTutorial ?? false,
			// os.time() (wall clock) for client display; all internal duration math uses os.clock().
			startTimestamp: os.time(),
		});

		this.behavior?.OnStart?.(this);

		const wireDeath = (char: Model) => {
			if (this.ended) return;
			const hum = char.FindFirstChildOfClass("Humanoid");
			if (hum) {
				const conn = hum.Died.Connect(() => this.End("died"));
				this.connections.push(conn);
			}
		};

		const char = this.Player.Character;
		if (char) {
			wireDeath(char);
		} else {
			const conn = this.Player.CharacterAdded.Connect((newChar) => wireDeath(newChar));
			this.connections.push(conn);
		}

		const incomeThread = task.spawn(() => {
			while (!this.ended) {
				task.wait(30);
				if (this.ended) break;
				if (!this.IsAFK) {
					const amount = this.config.FixedIncomePerMinute / 2;
					this.CachedMoney += amount;
					this.SalaryMoney += amount;
					this.fireUpdated();
				}
			}
		});
		this.threads.push(incomeThread);

		const afkThread = task.spawn(() => {
			while (!this.ended) {
				task.wait(5);
				if (this.ended) break;

				const idle = os.clock() - this.LastActionTime;
				const threshold = this.config.AFKThreshold ?? 75;
				const warnThreshold = this.config.AFKWarningThreshold ?? 45;

				if (idle > threshold) {
					this.End("afk");
					break;
				}

				if (idle > warnThreshold && !this.afkWarned) {
					this.afkWarned = true;
					this.events.AFKWarning.FireClient(this.Player);
				}

				if (idle > 30 && !this.IsAFK) {
					this.IsAFK = true;
					this.fireUpdated();
					this.behavior?.OnAFKStateChanged?.(this, true);
				} else if (idle <= 30 && this.IsAFK) {
					this.IsAFK = false;
					this.afkWarned = false;
					this.fireUpdated();
					this.behavior?.OnAFKStateChanged?.(this, false);
				}

				if (this.options.BoostsUnlocked) {
					const newBoost = this.calculateBoost();
					if (newBoost !== this.lastBoost) {
						this.lastBoost = newBoost;
						this.fireUpdated();
					}
				}
			}
		});
		this.threads.push(afkThread);
	}

	// Returns 0 if the session was already ended (idempotent — safe to call from multiple sources).
	public End(reason: ShiftEndReason): number {
		if (this.ended) return 0;
		this.ended = true;

		const boost = this.calculateBoost();
		const elapsedSeconds = math.floor(os.clock() - this.StartTime);
		const baseMoney = this.CachedMoney;
		const salaryMoney = this.SalaryMoney;
		const actionMoney = baseMoney - salaryMoney;
		let payout = baseMoney * boost;
		if (reason === "died") {
			payout *= 0.8;
		}
		payout = math.floor(payout);

		if (payout > 0) {
			const [ok, err] = pcall(() => this.options.Payout(this.Player, payout));
			if (!ok) {
				warn(`[ShiftSession] Payout failed for ${this.Player}: ${err}`);
			}
		}

		this.events.ShiftEnded.FireClient(this.Player, {
			payout: payout,
			reason: reason,
			jobId: this.Job,
			elapsedSeconds: elapsedSeconds,
			salaryMoney: salaryMoney,
			actionMoney: actionMoney,
			boost: boost,
		});

		this.behavior?.OnEnd?.(this, reason, payout);

		// Skipped on disconnect — the player may already be gone.
		const defaultTeam = this.options.DefaultTeam;
		if (reason !== "disconnect" && defaultTeam !== undefined) {
			pcall(() => {
				const team = Teams.FindFirstChild(defaultTeam);
				if (team) {
					this.Player.Team = team as Team;
				}
			});
		}

		this.Destroy();

		return payout;
	}

	// Safe to call from within a thread owned by this session — it won't cancel itself.
	public Destroy(): void {
		for (const conn of this.connections) {
			if (conn.Connected) conn.Disconnect();
		}

		const currentThread = coroutine.running();
		for (const thread of this.threads) {
			if (thread !== currentThread) {
				task.cancel(thread);
			}
		}

		this.connections = [];
		this.threads = [];

		this.behavior?.Destroy?.();

		this.onDestroy?.();
	}
}

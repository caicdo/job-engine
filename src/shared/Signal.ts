export type Callback<T extends unknown[]> = (...args: T) => void;

export class Signal<T extends unknown[] = []> {
	private listeners = new Array<Callback<T>>();

	public Connect(callback: Callback<T>): () => void {
		this.listeners.push(callback);
		let connected = true;
		return () => {
			if (!connected) return;
			connected = false;
			const index = this.listeners.indexOf(callback);
			if (index !== -1) {
				this.listeners.remove(index);
			}
		};
	}

	public Fire(...args: T): void {
		for (const callback of this.listeners) {
			// pcall so one bad listener can't stop the rest from running.
			const [ok, err] = pcall(() => callback(...args));
			if (!ok) {
				warn(`[Signal] listener error: ${err}`);
			}
		}
	}
}

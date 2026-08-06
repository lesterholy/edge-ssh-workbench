export type TransferLease = {
	signal: AbortSignal;
	release: () => void;
};

type PendingTransfer = {
	id: string;
	clientSessionId: string;
	controller: AbortController;
	resolve: (lease: TransferLease) => void;
	reject: (error: Error) => void;
};

export class TransferGate {
	private active?: PendingTransfer;
	private readonly queue: PendingTransfer[] = [];

	acquire(clientSessionId: string): Promise<TransferLease> {
		return new Promise((resolve, reject) => {
			const pending: PendingTransfer = {
				id: crypto.randomUUID(),
				clientSessionId,
				controller: new AbortController(),
				resolve,
				reject,
			};
			this.queue.push(pending);
			this.drain();
		});
	}

	cancelSession(clientSessionId: string): void {
		if (this.active?.clientSessionId === clientSessionId) {
			const active = this.active;
			this.active = undefined;
			active.controller.abort(new Error("SSH session closed"));
		}
		for (let index = this.queue.length - 1; index >= 0; index -= 1) {
			const pending = this.queue[index];
			if (pending?.clientSessionId !== clientSessionId) continue;
			this.queue.splice(index, 1);
			pending.controller.abort(new Error("SSH session closed"));
			pending.reject(new Error("SSH session closed"));
		}
		this.drain();
	}

	cancelAll(): void {
		if (this.active) {
			const active = this.active;
			this.active = undefined;
			active.controller.abort(new Error("All SSH sessions closed"));
		}
		for (const pending of this.queue.splice(0)) {
			pending.controller.abort(new Error("All SSH sessions closed"));
			pending.reject(new Error("All SSH sessions closed"));
		}
	}

	get activeClientSessionId(): string | undefined {
		return this.active?.clientSessionId;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	private drain(): void {
		if (this.active) return;
		const pending = this.queue.shift();
		if (!pending) return;
		this.active = pending;
		let released = false;
		pending.resolve({
			signal: pending.controller.signal,
			release: () => {
				if (released) return;
				released = true;
				if (this.active?.id === pending.id) this.active = undefined;
				this.drain();
			},
		});
	}
}

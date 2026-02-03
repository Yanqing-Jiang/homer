// Request cancellation manager for race condition prevention
// Uses Svelte 5 runes for reactive state

/**
 * Creates a request versioning system to prevent race conditions
 * Useful when multiple concurrent requests might return out of order
 */
export function createRequestManager() {
	let version = $state(0);

	return {
		/**
		 * Get a new request version token
		 * Call this at the start of each request
		 */
		getVersion(): number {
			return ++version;
		},

		/**
		 * Check if a request version is still the latest
		 * Call this before applying results
		 */
		isLatest(requestVersion: number): boolean {
			return requestVersion === version;
		},

		/**
		 * Get current version without incrementing
		 */
		get current(): number {
			return version;
		},

		/**
		 * Reset version counter
		 */
		reset(): void {
			version = 0;
		}
	};
}

/**
 * Creates an abort controller manager for request cancellation
 * Useful for cleanup and preventing stale responses
 */
export function createAbortManager() {
	let controller: AbortController | null = $state(null);

	return {
		/**
		 * Get a new abort signal for a request
		 * Automatically aborts any previous pending request
		 */
		getSignal(): AbortSignal {
			// Abort any existing request
			if (controller) {
				controller.abort();
			}
			controller = new AbortController();
			return controller.signal;
		},

		/**
		 * Abort the current request if any
		 */
		abort(): void {
			if (controller) {
				controller.abort();
				controller = null;
			}
		},

		/**
		 * Check if there's an active request
		 */
		get isActive(): boolean {
			return controller !== null && !controller.signal.aborted;
		},

		/**
		 * Clear the controller without aborting
		 */
		clear(): void {
			controller = null;
		}
	};
}

export interface RequestState<T> {
	data: T | null;
	loading: boolean;
	error: Error | null;
}

/**
 * Creates a complete request state manager combining version control and loading state
 */
export function createRequestState<T>(initialData: T | null = null) {
	let data = $state<T | null>(initialData);
	let loading = $state(false);
	let error = $state<Error | null>(null);
	let version = $state(0);

	return {
		get data(): T | null {
			return data;
		},
		set data(value: T | null) {
			data = value;
		},
		get loading(): boolean {
			return loading;
		},
		get error(): Error | null {
			return error;
		},

		/**
		 * Start a new request
		 * Returns version token and sets loading state
		 */
		start(): number {
			loading = true;
			error = null;
			return ++version;
		},

		/**
		 * Complete a request successfully
		 * Only applies if version matches
		 */
		success(requestVersion: number, result: T): boolean {
			if (requestVersion !== version) return false;
			data = result;
			loading = false;
			error = null;
			return true;
		},

		/**
		 * Mark request as failed
		 * Only applies if version matches
		 */
		fail(requestVersion: number, err: Error): boolean {
			if (requestVersion !== version) return false;
			error = err;
			loading = false;
			return true;
		},

		/**
		 * Reset state to initial
		 */
		reset(): void {
			data = initialData;
			loading = false;
			error = null;
			version = 0;
		}
	};
}

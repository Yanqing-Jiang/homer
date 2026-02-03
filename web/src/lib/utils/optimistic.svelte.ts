// Optimistic update manager with automatic rollback

/**
 * Creates an optimistic update manager for a piece of state
 * Automatically handles rollback on failure
 */
export function createOptimisticManager<T>() {
	let previousValue: T | undefined = $state(undefined);
	let hasPending = $state(false);

	return {
		/**
		 * Start an optimistic update
		 * Stores the previous value for potential rollback
		 */
		start(currentValue: T): void {
			previousValue = structuredClone(currentValue);
			hasPending = true;
		},

		/**
		 * Commit the optimistic update (success)
		 * Clears the stored previous value
		 */
		commit(): void {
			previousValue = undefined;
			hasPending = false;
		},

		/**
		 * Rollback to the previous value (failure)
		 * Returns the previous value or undefined if none
		 */
		rollback(): T | undefined {
			const value = previousValue;
			previousValue = undefined;
			hasPending = false;
			return value;
		},

		/**
		 * Check if there's a pending optimistic update
		 */
		get isPending(): boolean {
			return hasPending;
		},

		/**
		 * Get the stored previous value
		 */
		get storedValue(): T | undefined {
			return previousValue;
		}
	};
}

/**
 * Helper to execute an optimistic update with automatic rollback
 *
 * @param getCurrentValue Function that returns the current value
 * @param setOptimisticValue Function to apply the optimistic value
 * @param asyncOperation The async operation to perform
 * @param setRollbackValue Function to apply rollback value on failure
 */
export async function withOptimisticUpdate<T, R>(options: {
	getCurrentValue: () => T;
	setOptimisticValue: (value: T) => void;
	asyncOperation: () => Promise<R>;
	onSuccess?: (result: R) => void;
	onError?: (error: Error, previousValue: T) => void;
}): Promise<R | undefined> {
	const { getCurrentValue, setOptimisticValue, asyncOperation, onSuccess, onError } = options;

	// Store the current value for potential rollback
	const previousValue = structuredClone(getCurrentValue());

	try {
		const result = await asyncOperation();
		onSuccess?.(result);
		return result;
	} catch (e) {
		const error = e instanceof Error ? e : new Error(String(e));

		// Rollback to previous value
		setOptimisticValue(previousValue);

		onError?.(error, previousValue);
		return undefined;
	}
}

/**
 * Creates a stateful optimistic update helper with tracking
 */
export function useOptimisticState<T>(initialValue: T) {
	let value = $state(initialValue);
	let previousValue: T | undefined = $state(undefined);
	let isPending = $state(false);
	let error = $state<Error | null>(null);

	return {
		get value(): T {
			return value;
		},
		set value(newValue: T) {
			value = newValue;
		},

		get isPending(): boolean {
			return isPending;
		},

		get error(): Error | null {
			return error;
		},

		/**
		 * Apply an optimistic update and execute async operation
		 */
		async update<R>(
			optimisticValue: T,
			operation: () => Promise<R>
		): Promise<R | undefined> {
			// Store current value and apply optimistic
			previousValue = structuredClone(value);
			value = optimisticValue;
			isPending = true;
			error = null;

			try {
				const result = await operation();
				previousValue = undefined;
				isPending = false;
				return result;
			} catch (e) {
				// Rollback
				if (previousValue !== undefined) {
					value = previousValue;
					previousValue = undefined;
				}
				error = e instanceof Error ? e : new Error(String(e));
				isPending = false;
				throw e;
			}
		},

		/**
		 * Reset to initial value
		 */
		reset(): void {
			value = initialValue;
			previousValue = undefined;
			isPending = false;
			error = null;
		}
	};
}

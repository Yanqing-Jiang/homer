// Centralized error handling with retry support

import { toast } from '$lib/stores/toasts.svelte';

export interface ErrorHandlerOptions {
	/** Show toast notification on error (default: true) */
	showToast?: boolean;
	/** Custom error message prefix */
	messagePrefix?: string;
	/** Log error to console (default: true) */
	logError?: boolean;
	/** Number of retry attempts (default: 0) */
	retries?: number;
	/** Delay between retries in ms (default: 1000) */
	retryDelay?: number;
	/** Custom error handler */
	onError?: (error: Error) => void;
}

/**
 * Wraps an async function with error handling, optional retries, and toast notifications
 */
export async function withErrorHandler<T>(
	fn: () => Promise<T>,
	options: ErrorHandlerOptions = {}
): Promise<T | undefined> {
	const {
		showToast = true,
		messagePrefix = 'Error',
		logError = true,
		retries = 0,
		retryDelay = 1000,
		onError
	} = options;

	let lastError: Error | undefined;
	let attempts = 0;

	while (attempts <= retries) {
		try {
			return await fn();
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
			attempts++;

			if (attempts <= retries) {
				// Wait before retry
				await new Promise(resolve => setTimeout(resolve, retryDelay));
			}
		}
	}

	// All retries exhausted
	if (lastError) {
		if (logError) {
			console.error(`${messagePrefix}:`, lastError);
		}

		if (showToast) {
			toast.error(`${messagePrefix}: ${lastError.message}`);
		}

		if (onError) {
			onError(lastError);
		}
	}

	return undefined;
}

/**
 * Creates a reusable error handler for a specific context
 */
export function createErrorHandler(defaultOptions: ErrorHandlerOptions) {
	return function<T>(fn: () => Promise<T>, overrideOptions?: Partial<ErrorHandlerOptions>): Promise<T | undefined> {
		return withErrorHandler(fn, { ...defaultOptions, ...overrideOptions });
	};
}

/**
 * Format error message from various error types
 */
export function formatErrorMessage(error: unknown, fallback = 'Unknown error'): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	if (error && typeof error === 'object' && 'message' in error) {
		return String(error.message);
	}
	return fallback;
}

/**
 * Check if error is a network error
 */
export function isNetworkError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.message.includes('fetch') ||
			error.message.includes('network') ||
			error.message.includes('ECONNREFUSED') ||
			error.name === 'TypeError';
	}
	return false;
}

/**
 * Check if error is an auth error
 */
export function isAuthError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.message.includes('401') ||
			error.message.includes('Unauthorized') ||
			error.message.includes('expired') ||
			error.message.includes('auth');
	}
	return false;
}

// Toast notification state management using Svelte 5 runes

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
	id: string;
	type: ToastType;
	message: string;
	duration: number;
	dismissible: boolean;
}

interface ToastOptions {
	duration?: number;
	dismissible?: boolean;
}

// State using runes
let toasts = $state<Toast[]>([]);
let idCounter = 0;

function generateId(): string {
	return `toast-${++idCounter}-${Date.now()}`;
}

export function getToasts(): Toast[] {
	return toasts;
}

export function addToast(
	type: ToastType,
	message: string,
	options: ToastOptions = {}
): string {
	const { duration = 5000, dismissible = true } = options;

	const id = generateId();
	const toast: Toast = {
		id,
		type,
		message,
		duration,
		dismissible
	};

	toasts = [...toasts, toast];

	// Auto-dismiss after duration
	if (duration > 0) {
		setTimeout(() => {
			removeToast(id);
		}, duration);
	}

	return id;
}

export function removeToast(id: string): void {
	toasts = toasts.filter(t => t.id !== id);
}

export function clearAllToasts(): void {
	toasts = [];
}

// Convenience functions
export function success(message: string, options?: ToastOptions): string {
	return addToast('success', message, options);
}

export function error(message: string, options?: ToastOptions): string {
	// Errors stay longer by default
	return addToast('error', message, { duration: 8000, ...options });
}

export function warning(message: string, options?: ToastOptions): string {
	return addToast('warning', message, options);
}

export function info(message: string, options?: ToastOptions): string {
	return addToast('info', message, options);
}

// Export toast store as an object for easy imports
export const toast = {
	success,
	error,
	warning,
	info,
	remove: removeToast,
	clear: clearAllToasts
};

import { user, loading } from '$lib/supabase';
import { isAuthorizedUser } from '$lib/auth';
import type { User } from '@supabase/supabase-js';

/**
 * Svelte 5 compatible auth hook.
 * Bridges legacy writable stores to reactive $state using $effect.
 */
export function useAuth() {
	let currentUser = $state<User | null>(null);
	let isLoading = $state(true);

	$effect(() => {
		const unsubUser = user.subscribe((u) => {
			currentUser = u;
		});
		const unsubLoad = loading.subscribe((l) => {
			isLoading = l;
		});
		return () => {
			unsubUser();
			unsubLoad();
		};
	});

	return {
		get user() {
			return currentUser;
		},
		get loading() {
			return isLoading;
		},
		get isAuthorized() {
			return !isLoading && currentUser !== null && isAuthorizedUser(currentUser.email);
		}
	};
}

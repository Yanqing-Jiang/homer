import { createClient } from '@supabase/supabase-js';
import { writable } from 'svelte/store';
import type { User, Session } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Auth stores
export const user = writable<User | null>(null);
export const session = writable<Session | null>(null);
export const loading = writable(true);

// Initialize auth state
supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
	session.set(currentSession);
	user.set(currentSession?.user ?? null);
	loading.set(false);
});

// Listen for auth changes
supabase.auth.onAuthStateChange((_event, currentSession) => {
	session.set(currentSession);
	user.set(currentSession?.user ?? null);
	loading.set(false);
});

// Auth functions
export async function signInWithGoogle() {
	const { error } = await supabase.auth.signInWithOAuth({
		provider: 'google',
		options: {
			redirectTo: window.location.origin
		}
	});
	if (error) throw error;
}

export async function signOut() {
	const { error } = await supabase.auth.signOut();
	if (error) throw error;
}

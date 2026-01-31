// Super user access control
export const ALLOWED_EMAIL = 'jiangyanqing90@gmail.com';

export function isAuthorizedUser(email: string | undefined): boolean {
	if (!email) return false;
	return email.toLowerCase().trim() === ALLOWED_EMAIL.toLowerCase();
}

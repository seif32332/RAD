// Client helper: send the user to the login page after a 401, keeping the current page as
// `next` so the login screen brings them back here (the login page validates the path).
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

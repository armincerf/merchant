// Simple auth store using localStorage
const API_URL_KEY = 'merchant_api_url';
const API_KEY_KEY = 'merchant_api_key';
const THEME_KEY = 'merchant_theme';

export type AuthState = {
  apiUrl: string;
  apiKey: string;
  isAuthenticated: boolean;
};

export function getAuth(): AuthState {
  const apiUrl = localStorage.getItem(API_URL_KEY) || '';
  const apiKey = localStorage.getItem(API_KEY_KEY) || '';
  return {
    apiUrl,
    apiKey,
    isAuthenticated: Boolean(apiUrl && apiKey),
  };
}

export function setAuth(apiUrl: string, apiKey: string) {
  localStorage.setItem(API_URL_KEY, apiUrl);
  localStorage.setItem(API_KEY_KEY, apiKey);
}

export function clearAuth() {
  localStorage.removeItem(API_URL_KEY);
  localStorage.removeItem(API_KEY_KEY);
}

export function getTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(theme: 'light' | 'dark') {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

// Initialize theme on load
if (typeof window !== 'undefined') {
  setTheme(getTheme());
}




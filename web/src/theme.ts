export type Theme = "light" | "dark";

const KEY = "codeslice:theme";

export function loadTheme(): Theme {
  return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
}

export function saveTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

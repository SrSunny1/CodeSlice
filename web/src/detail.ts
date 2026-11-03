export type Detail = "brief" | "deep";

const KEY = "codeslice:detail";

export function loadDetail(): Detail {
  return localStorage.getItem(KEY) === "brief" ? "brief" : "deep";
}

export function saveDetail(d: Detail): void {
  localStorage.setItem(KEY, d);
}

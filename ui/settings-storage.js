export const SETTINGS_KEY = "llmtracker.settings";

export function loadSettings(storage = localStorage) {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveSettings(settings, storage = localStorage) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

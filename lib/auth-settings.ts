export type TokenKind = "env" | "refresh" | "access";

export type TokenSettings = {
  tokenKind: TokenKind;
  tokenValue: string;
};

export const DEFAULT_TOKEN_SETTINGS: TokenSettings = {
  tokenKind: "env",
  tokenValue: "",
};

const STORAGE_KEY = "shiphero-picklist-token-settings-v1";

function normalizeTokenKind(value: unknown): TokenKind {
  return value === "refresh" || value === "access" ? value : "env";
}

export function normalizeTokenSettings(settings: Partial<TokenSettings>): TokenSettings {
  const tokenKind = normalizeTokenKind(settings.tokenKind);
  return {
    tokenKind,
    tokenValue: tokenKind === "env" ? "" : settings.tokenValue?.trim() ?? "",
  };
}

export function loadTokenSettings(): TokenSettings {
  if (typeof window === "undefined") return DEFAULT_TOKEN_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TOKEN_SETTINGS;
    return normalizeTokenSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_TOKEN_SETTINGS;
  }
}

export function saveTokenSettings(settings: TokenSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeTokenSettings(settings)));
}

export function buildAuthPayload(settings: TokenSettings) {
  const clean = normalizeTokenSettings(settings);
  if (clean.tokenKind === "env") return null;
  if (!clean.tokenValue) return null;
  return clean.tokenKind === "refresh"
    ? { refreshToken: clean.tokenValue }
    : { accessToken: clean.tokenValue };
}

export function tokenSourceLabel(settings: TokenSettings) {
  if (settings.tokenKind === "refresh") return "Browser refresh token";
  if (settings.tokenKind === "access") return "Browser access token";
  return "Saved server token";
}

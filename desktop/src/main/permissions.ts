// Which web permissions the app's session grants (main.ts `hardenSession`). Everything is refused but
// fullscreen for the app's own pages: the app page (app://botling) and its chat frame (botling-chat://chat),
// so a video in a chat message can go fullscreen from its controls. Card frames (botling-card://), plugin
// pages and anything remote stay refused.
export type PermissionAsk = { permission: string; owned: boolean; requestingUrl: string };

const FULLSCREEN_ORIGINS = ["app://botling", "botling-chat://chat"];

function appOrigin(url: string): boolean {
  return FULLSCREEN_ORIGINS.some(origin => url === origin || url.startsWith(`${origin}/`));
}

export function permissionAllowed(ask: PermissionAsk): boolean {
  return ask.permission === "fullscreen" && ask.owned && appOrigin(ask.requestingUrl);
}

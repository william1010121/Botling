import { post } from "./bridge";
import type { ArtifactCardView } from "./types";

const artifactIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg>`;

/**
 * A claude.ai Artifact a reply links to: its title, the host and Open. No live preview: the page
 * needs the user's claude.ai sign-in, which only their browser has; Open goes there.
 */
export function artifactCard(card: ArtifactCardView): HTMLElement {
  const element = document.createElement("div");
  element.className = "artifact-card";
  const names = document.createElement("div");
  names.className = "artifact-names";
  const title = document.createElement("div");
  title.className = "artifact-title";
  title.textContent = card.title;
  const host = document.createElement("div");
  host.className = "artifact-host";
  host.textContent = `${card.host} · Artifact`;
  names.append(title, host);
  const open = document.createElement("button");
  open.className = "artifact-open";
  open.innerHTML = `${artifactIcon}<span>Open</span>`;
  open.setAttribute("aria-label", `Open ${card.title} in the browser`);
  open.addEventListener("click", () => post({ type: "openURL", url: card.url, label: card.title }));
  element.append(names, open);
  return element;
}

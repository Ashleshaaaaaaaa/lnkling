// Avatars are drawn in code (no image files). Indices are validated on the server.
export const AVATAR_COLORS = ['#ff7a45', '#ffd23f', '#5bd18b', '#4cc9f0', '#b7a6ff', '#ff8fb1', '#f4a261', '#90be6d', '#43aa8b', '#e76f51', '#9d8df1', '#cfd8dc'];
export const COUNTS = { color: AVATAR_COLORS.length, eyes: 6, mouth: 6 };

const EYES = [
  '<circle cx="35" cy="42" r="5.5" fill="#1b1b1b"/><circle cx="65" cy="42" r="5.5" fill="#1b1b1b"/>',
  '<circle cx="35" cy="42" r="10" fill="#fff"/><circle cx="65" cy="42" r="10" fill="#fff"/><circle cx="37" cy="43" r="5" fill="#1b1b1b"/><circle cx="63" cy="43" r="5" fill="#1b1b1b"/>',
  '<path d="M26 46 Q35 34 44 46 M56 46 Q65 34 74 46" stroke="#1b1b1b" stroke-width="5" fill="none" stroke-linecap="round"/>',
  '<path d="M26 43 H44 M56 43 H74" stroke="#1b1b1b" stroke-width="5" stroke-linecap="round"/>',
  '<path d="M29 36 L41 48 M41 36 L29 48 M59 36 L71 48 M71 36 L59 48" stroke="#1b1b1b" stroke-width="4.5" stroke-linecap="round"/>',
  '<circle cx="35" cy="42" r="12" fill="#fff" stroke="#1b1b1b" stroke-width="3"/><circle cx="65" cy="42" r="12" fill="#fff" stroke="#1b1b1b" stroke-width="3"/><circle cx="35" cy="42" r="4" fill="#1b1b1b"/><circle cx="65" cy="42" r="4" fill="#1b1b1b"/>'
];
const MOUTHS = [
  '<path d="M32 64 Q50 82 68 64" stroke="#1b1b1b" stroke-width="5" fill="none" stroke-linecap="round"/>',
  '<path d="M30 62 Q50 90 70 62 Z" fill="#7a1f1f" stroke="#1b1b1b" stroke-width="4" stroke-linejoin="round"/>',
  '<path d="M34 70 H66" stroke="#1b1b1b" stroke-width="5" stroke-linecap="round"/>',
  '<path d="M32 64 Q50 80 68 64" stroke="#1b1b1b" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M44 72 Q50 88 58 72 Z" fill="#ff6b8b"/>',
  '<ellipse cx="50" cy="71" rx="8" ry="9" fill="#7a1f1f" stroke="#1b1b1b" stroke-width="4"/>',
  '<path d="M34 68 Q52 74 68 60" stroke="#1b1b1b" stroke-width="5" fill="none" stroke-linecap="round"/>'
];

export function avatarSVG(a) {
  const c = AVATAR_COLORS[(a && a.color) | 0] || AVATAR_COLORS[0];
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">` +
    `<circle cx="50" cy="52" r="44" fill="${c}" stroke="#0d242c" stroke-width="5"/>` +
    (EYES[(a && a.eyes) | 0] || EYES[0]) + (MOUTHS[(a && a.mouth) | 0] || MOUTHS[0]) + `</svg>`;
}

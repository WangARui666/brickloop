// Defaults live here; the desktop supplies the same values through its --bl-* tokens.
export const reviewColors = { added: '#3FB950', removed: '#F0616D', changed: '#F5B83D', movedFrom: '#8AA4C8' } as const;
export const viewportColors = {
  'viewport-top': '#2B303B',
  'viewport-bottom': '#17191F',
  'grid-stud': '#262A33',
  'grid-major': '#323844',
  accent: '#FF8A3D',
  'accent-hover': '#FF9E5E',
  'axis-x': '#E5534B',
  'axis-y': '#3DD68C',
  'axis-z': '#4D8DFF',
  'bg-panel': '#181B21',
  border: '#2A2F39',
  'light-sky': '#FFFFFF',
  'light-ground': '#727E96',
  'light-key': '#FFF4E4',
  'light-fill': '#B7CEFF',
} as const;

export function themeColor(container: HTMLElement, token: keyof typeof viewportColors): string {
  return getComputedStyle(container).getPropertyValue(`--bl-${token}`).trim() || viewportColors[token];
}

import type { CSSProperties } from 'react';
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

// Shared by CSS variables and Ant Design, following docs/design/ui-guidelines.md.
const colors = {
  'bg-app': '#121418',
  'bg-panel': '#181B21',
  'bg-surface': '#1F232B',
  'bg-raised': '#272C36',
  'bg-active': '#2F3542',
  'image-canvas': '#C9CDD3',
  border: '#2A2F39',
  'border-strong': '#3A4150',
  'text-primary': '#E7E9EE',
  'text-secondary': '#A3ABBA',
  'text-tertiary': '#6E7686',
  accent: '#FF8A3D',
  'accent-hover': '#FF9E5E',
  'accent-pressed': '#E8742A',
  'accent-soft': 'rgba(255,138,61,0.14)',
  focus: 'rgba(255,138,61,0.45)',
  success: '#3DD68C',
  warning: '#F5B83D',
  danger: '#F0616D',
  info: '#5AA9FF',
  'text-on-accent': '#1A1206',
  'viewport-top': '#2B303B',
  'viewport-bottom': '#17191F',
  'grid-stud': '#262A33',
  'grid-major': '#323844',
  'axis-x': '#E5534B',
  'axis-y': '#3DD68C',
  'axis-z': '#4D8DFF',
  'light-sky': '#FFFFFF',
  'light-ground': '#727E96',
  'light-key': '#FFF4E4',
  'light-fill': '#B7CEFF',
};

export const fontFamily =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif';
export const shellVariables = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [`--bl-${key}`, value]),
) as CSSProperties;

export const desktopTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: colors.accent,
    colorLink: colors.accent,
    colorLinkHover: colors['accent-hover'],
    colorBgBase: colors['bg-app'],
    colorBgContainer: colors['bg-surface'],
    colorBgElevated: colors['bg-raised'],
    colorBorder: colors['border-strong'],
    colorBorderSecondary: colors.border,
    colorText: colors['text-primary'],
    colorTextSecondary: colors['text-secondary'],
    colorTextTertiary: colors['text-tertiary'],
    colorTextDisabled: colors['text-tertiary'],
    colorTextPlaceholder: colors['text-tertiary'],
    colorTextLightSolid: colors['text-on-accent'],
    colorSuccess: colors.success,
    colorWarning: colors.warning,
    colorError: colors.danger,
    colorInfo: colors.info,
    borderRadius: 6,
    fontSize: 13,
    controlHeight: 28,
    fontFamily,
  },
  components: {
    Progress: { defaultColor: colors.accent, remainingColor: colors['bg-active'] },
    Modal: { titleFontSize: 15, borderRadiusLG: 8, motion: false },
    Segmented: {
      itemSelectedBg: colors['bg-active'],
      trackBg: colors['bg-app'],
      itemColor: colors['text-secondary'],
      itemSelectedColor: colors['text-primary'],
    },
    Menu: {
      itemBg: colors['bg-panel'],
      subMenuItemBg: colors['bg-raised'],
      itemHeight: 28,
      itemColor: colors['text-primary'],
      itemHoverBg: colors['bg-raised'],
      horizontalItemSelectedColor: colors.accent,
      horizontalLineHeight: '30px',
    },
    Tabs: { inkBarColor: 'transparent', itemSelectedColor: colors['text-primary'], horizontalItemGutter: 4 },
    Tree: { titleHeight: 24, indentSize: 16, nodeSelectedBg: colors['accent-soft'], nodeHoverBg: colors['bg-raised'] },
    Tooltip: {
      colorBgSpotlight: colors['bg-raised'],
      colorTextLightSolid: colors['text-primary'],
      borderRadius: 8,
      fontSize: 12,
    },
  },
};

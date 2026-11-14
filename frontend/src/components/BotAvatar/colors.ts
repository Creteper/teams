// Colour table for BotAvatar.
// The id list and hex values follow the public Grok Bot avatar palette as
// documented by the MIT-licensed grok-bot-sdk (github.com/RongleCat/grok-bot-sdk,
// avatar.mjs). The avatar body is painted with the flat `base` value.

export const AVATAR_COLORS = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const DEFAULT_COLOR: AvatarColor = 'black';

export interface ColorSwatch {
  /** flat body colour */
  base: string;
  /** lighter variant (UI accents) */
  light: string;
  /** darker variant (UI accents); for black this is the inverted ink */
  dark: string;
}

export const AVATAR_COLOR_HEX: Readonly<Record<AvatarColor, ColorSwatch>> = {
  black: { base: '#000000', light: '#000000', dark: '#FFFFFF' },
  brown: { base: '#936439', light: '#A27952', dark: '#855C36' },
  red: { base: '#FF263C', light: '#FF3E51', dark: '#E02135' },
  orange: { base: '#FF6700', light: '#FF781C', dark: '#FF6700' },
  yellow: { base: '#FF9800', light: '#FFAF38', dark: '#FF9800' },
  green: { base: '#00C972', light: '#00C972', dark: '#009957' },
  cyan: { base: '#00BCA6', light: '#1CC3B0', dark: '#00A592' },
  blue: { base: '#1084FE', light: '#2A92FE', dark: '#0E74E0' },
  violet: { base: '#9159FE', light: '#A97EFE', dark: '#804EE0' },
  magenta: { base: '#FF309B', light: '#FF5EB1', dark: '#E02A88' },
  gray: { base: '#777777', light: '#959595', dark: '#777777' },
};

export const COLOR_ALIASES: Readonly<Record<string, AvatarColor>> = {
  grey: 'gray',
  purple: 'violet',
  pink: 'magenta',
  teal: 'cyan',
};

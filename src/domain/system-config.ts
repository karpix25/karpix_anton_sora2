export interface SystemConfig {
  forceGrokImagine: boolean;
  grokMode: 'fun' | 'normal' | 'spicy';
  grokResolution: '480p' | '720p';
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  forceGrokImagine: false,
  grokMode: 'normal',
  grokResolution: '480p',
};

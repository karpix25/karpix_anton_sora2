export interface SystemConfig {
  forceGrokImagine: boolean;
  grokMode: 'fun' | 'normal' | 'spicy';
  grokResolution: '480p' | '720p';
  grokDuration: number;
  useReferenceDuration: boolean;
  grokStyle: 'cinematic' | 'vlog';
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  forceGrokImagine: false,
  grokMode: 'normal',
  grokResolution: '720p',
  grokDuration: 10,
  useReferenceDuration: false,
  grokStyle: 'vlog',
};

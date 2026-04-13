export type ReferenceLibraryStatus =
  | 'received'
  | 'parsing'
  | 'analyzing'
  | 'analyzed'
  | 'failed';

export type ReferenceTextOverlayAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface ReferenceTextOverlay {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  anchor: ReferenceTextOverlayAnchor;
  xPercent: number;
  yPercent: number;
  fontSizePercent: number;
  textColor: string;
  box: boolean;
  boxColor: string;
  boxOpacity: number;
}

export interface ReferenceLibraryItem {
  id: string;
  projectId: string;
  sourceUrl: string;
  directVideoUrl: string;
  thumbnailUrl: string;
  audioFilePath: string;
  audioStoredAt: string;
  durationSeconds: number;
  textOverlays: ReferenceTextOverlay[];
  status: ReferenceLibraryStatus;
  analysis: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceLibraryInput {
  projectId: string;
  sourceUrl: string;
  directVideoUrl?: string;
  thumbnailUrl?: string;
  audioFilePath?: string;
  audioStoredAt?: string;
  durationSeconds?: number;
  textOverlays?: ReferenceTextOverlay[];
  status?: ReferenceLibraryStatus;
  analysis?: string;
  errorMessage?: string;
}

export interface ReferenceLibraryUpdate {
  directVideoUrl?: string;
  thumbnailUrl?: string;
  audioFilePath?: string;
  audioStoredAt?: string;
  durationSeconds?: number;
  textOverlays?: ReferenceTextOverlay[];
  status?: ReferenceLibraryStatus;
  analysis?: string;
  errorMessage?: string;
}

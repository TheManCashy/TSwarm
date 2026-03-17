export type CanvasTransform = {
  x: number;
  y: number;
  scale: number;
};

export type WindowType = 'terminal' | 'file';

export type FileKind = 'text' | 'image' | 'pdf' | 'video' | 'unknown';

export type SketchTool = 'pan' | 'freehand' | 'rect' | 'ellipse' | 'arrow';

export type SketchItem = {
  id: string;
  type: Exclude<SketchTool, 'pan'>;
  points: Array<{ x: number; y: number }>;
};

export type WindowItem = {
  id: string;
  title: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  type: WindowType;
  sessionId?: string;
  path?: string;
  fileKind?: FileKind;
  fileMime?: string;
  terminalKind?: 'codex' | 'claude' | 'gemini' | 'shell';
  resumeSessionId?: string;
};

export type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
};

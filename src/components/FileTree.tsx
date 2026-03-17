import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry, SketchTool } from '../types';

export type TreeNode = {
  entry: FileEntry;
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
};

type Props = {
  rootPath: string;
  onRootPathChange: (path: string) => void;
  onOpenPath?: (path: string) => void;
  onRootChange?: (path: string) => void;
  sessions?: { id: string; name: string; active: boolean }[];
  onSelectSession?: (id: string) => void;
  onRenameSession?: (id: string, name: string) => void;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  sketchTool?: SketchTool;
  onSketchToolChange?: (tool: SketchTool) => void;
  onClearSketches?: () => void;
};

function buildNodes(entries: FileEntry[]): TreeNode[] {
  return entries.map((entry) => ({ entry }));
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi']);
const PDF_EXTS = new Set(['pdf']);
const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'swift',
  'json', 'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'sh', 'zsh', 'bash', 'ini',
]);
const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'log']);

const getExt = (name: string) => {
  const idx = name.lastIndexOf('.');
  if (idx === -1) return '';
  return name.slice(idx + 1).toLowerCase();
};

const FolderIcon = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d={open
        ? 'M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z'
        : 'M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'}
      fill="currentColor"
    />
  </svg>
);

const FileIcon = ({ kind }: { kind: string }) => {
  switch (kind) {
    case 'image':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 4h9l3 3v13H6V4z" fill="currentColor" />
          <path d="M8 15l3-3 2 2 3-3 3 4H8z" fill="#0b0d12" opacity="0.6" />
          <circle cx="10" cy="10" r="1.5" fill="#0b0d12" opacity="0.6" />
        </svg>
      );
    case 'video':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 4h9l3 3v13H6V4z" fill="currentColor" />
          <path d="M10 10l5 3-5 3v-6z" fill="#0b0d12" opacity="0.6" />
        </svg>
      );
    case 'pdf':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 4h9l3 3v13H6V4z" fill="currentColor" />
          <path d="M9 15h6" stroke="#0b0d12" strokeWidth="1.5" opacity="0.6" />
          <path d="M9 12h6" stroke="#0b0d12" strokeWidth="1.5" opacity="0.6" />
        </svg>
      );
    case 'code':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 4h9l3 3v13H6V4z" fill="currentColor" />
          <path d="M10 10l-2 2 2 2" stroke="#0b0d12" strokeWidth="1.4" fill="none" opacity="0.7" />
          <path d="M14 10l2 2-2 2" stroke="#0b0d12" strokeWidth="1.4" fill="none" opacity="0.7" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 4h9l3 3v13H6V4z" fill="currentColor" />
        </svg>
      );
  }
};

const getFileKind = (name: string) => {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (CODE_EXTS.has(ext)) return 'code';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'file';
};

export function FileTree({
  rootPath,
  onRootPathChange,
  onOpenPath,
  onRootChange,
  sessions = [],
  onSelectSession,
  onRenameSession,
  sidebarOpen = true,
  onToggleSidebar,
  sketchTool,
  onSketchToolChange,
  onClearSketches,
}: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    const loadRoot = async () => {
      if (!rootPath) {
        setNodes([]);
        return;
      }
      const entries = await invoke<FileEntry[]>('list_dir', { path: rootPath });
      setNodes(buildNodes(entries));
    };

    loadRoot().catch(() => {
      // ignore load errors for now
    });
  }, [rootPath]);

  const onToggle = async (node: TreeNode) => {
    setSelectedPath(node.entry.path);
    if (!node.entry.is_dir) {
      onOpenPath?.(node.entry.path);
      return;
    }

    if (node.expanded) {
      node.expanded = false;
      setNodes([...nodes]);
      return;
    }

    node.expanded = true;
    node.loading = true;
    setNodes([...nodes]);

    try {
      const entries = await invoke<FileEntry[]>('list_dir', { path: node.entry.path });
      node.children = buildNodes(entries);
    } catch {
      node.children = [];
    } finally {
      node.loading = false;
      setNodes([...nodes]);
    }
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const isSelected = selectedPath === node.entry.path;
    const fileKind = node.entry.is_dir ? 'folder' : getFileKind(node.entry.name);
    const count = node.entry.is_dir && node.expanded && node.children ? node.children.length : null;
    return (
      <div key={node.entry.path}>
        <div
          className={`tree-row ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          onClick={() => onToggle(node)}
        >
          <span className="tree-caret">{node.entry.is_dir ? (node.expanded ? '▾' : '▸') : ''}</span>
          <span className={`tree-icon ${fileKind}`}>
            {node.entry.is_dir ? <FolderIcon open={!!node.expanded} /> : <FileIcon kind={fileKind} />}
          </span>
          <span className="tree-name">{node.entry.name}</span>
          {typeof count === 'number' && <span className="tree-count">{count}</span>}
        </div>
        {node.expanded && node.loading && <div className="tree-loading">loading…</div>}
        {node.expanded && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const treeContent = useMemo(() => nodes.map((node) => renderNode(node, 1)), [nodes]);

  const handleRootSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rootPath) return;
    try {
      const entries = await invoke<FileEntry[]>('list_dir', { path: rootPath });
      setNodes(buildNodes(entries));
      onRootChange?.(rootPath);
    } catch {
      // ignore
    }
  };

  return (
    <div className="sidebar">
      <form className="sidebar-header" onSubmit={handleRootSubmit}>
        <div className="sidebar-title">Repository</div>
        <input
          className="sidebar-input"
          value={rootPath}
          onChange={(event) => onRootPathChange(event.target.value)}
          placeholder="/path/to/project"
        />
      </form>
      <div className="sidebar-tree">
        <div
          className="tree-row root-row"
          onClick={() => onToggleSidebar?.()}
        >
          <button className="sidebar-toggle" type="button" title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
          <span className="tree-icon folder">
            <FolderIcon open />
          </span>
          <span className="tree-name">Repository</span>
        </div>
        {treeContent}
      </div>
      <div className="sidebar-sessions">
        <div className="sidebar-title">Sessions</div>
        <div className="session-list">
          {sessions.length === 0 && <div className="session-empty">No sessions</div>}
          {sessions.map((session, idx) => (
            <div
              key={session.id}
              className={`session-row ${session.active ? 'active' : ''}`}
              onClick={() => onSelectSession?.(session.id)}
              onDoubleClick={() => {
                const next = window.prompt('Rename session', session.name);
                if (next && next.trim()) onRenameSession?.(session.id, next.trim());
              }}
              title="Click to focus, double-click to rename"
            >
              <span className="session-index">{idx + 1}.</span>
              <span className="session-name">{session.name}</span>
            </div>
          ))}
        </div>
        {sketchTool && onSketchToolChange && onClearSketches && (
          <div className="sidebar-sketch">
            <div className="sidebar-title">Sketch Tools</div>
            <div className="sidebar-sketch-tools" role="toolbar" aria-label="Sketch tools">
              <button aria-label="Pan canvas" className={`icon-btn ${sketchTool === 'pan' ? 'active' : ''}`} onClick={() => onSketchToolChange('pan')} title="Pan canvas" type="button">✋</button>
              <button aria-label="Freehand sketch" className={`icon-btn ${sketchTool === 'freehand' ? 'active' : ''}`} onClick={() => onSketchToolChange('freehand')} title="Freehand" type="button">✎</button>
              <button aria-label="Draw rectangle" className={`icon-btn ${sketchTool === 'rect' ? 'active' : ''}`} onClick={() => onSketchToolChange('rect')} title="Rectangle" type="button">▭</button>
              <button aria-label="Draw ellipse" className={`icon-btn ${sketchTool === 'ellipse' ? 'active' : ''}`} onClick={() => onSketchToolChange('ellipse')} title="Ellipse" type="button">◯</button>
              <button aria-label="Draw arrow" className={`icon-btn ${sketchTool === 'arrow' ? 'active' : ''}`} onClick={() => onSketchToolChange('arrow')} title="Arrow" type="button">➜</button>
              <button aria-label="Clear sketches" className="icon-btn" onClick={onClearSketches} title="Clear sketches" type="button">⌫</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

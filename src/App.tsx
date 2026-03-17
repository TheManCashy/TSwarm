import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileTree } from './components/FileTree';
import { FileWindow } from './components/FileWindow';
import { TerminalWindow } from './components/TerminalWindow';
import type { CanvasTransform, FileKind, WindowItem } from './types';
import { getTerminalOutput } from './terminalBridge';
import './App.css';

const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
  'css', 'html', 'xml', 'yml', 'yaml', 'toml', 'sh', 'zsh', 'bash', 'env', 'ini', 'log',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi']);
const PDF_EXTS = new Set(['pdf']);

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

const getFileName = (path: string) => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

const inferFileKind = (path: string): { kind: FileKind; mime?: string } => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (PDF_EXTS.has(ext)) return { kind: 'pdf', mime: MIME_BY_EXT[ext] };
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', mime: MIME_BY_EXT[ext] };
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', mime: MIME_BY_EXT[ext] };
  if (TEXT_EXTS.has(ext)) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'unknown' };
};

export default function App() {
  const [transform, setTransform] = useState<CanvasTransform>({ x: 80, y: 80, scale: 1 });
  const [windows, setWindows] = useState<WindowItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string>('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [savedProjects, setSavedProjects] = useState<Array<{ path: string; name: string; lastUsed: number }>>([]);
  const [showProjectPicker, setShowProjectPicker] = useState(true);
  const [pickerPath, setPickerPath] = useState('');
  const [pickerError, setPickerError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const zRef = useRef(10);
  const spawnedRef = useRef(false);
  const windowsRef = useRef<WindowItem[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const rootPathRef = useRef<string>('');
  const saveTimerRef = useRef<number | null>(null);
  const restoringRef = useRef(false);
  const codexAssignedRef = useRef(new Set<string>());
  const claudeAssignedRef = useRef(new Set<string>());
  const pendingResumeRef = useRef(
    new Map<string, { kind: 'claude' | 'gemini'; startedAt: number; baseline: Set<string> }>()
  );

  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as any).__addLog = (m: string) => {
        invoke('log_frontend', { message: m }).catch(() => {});
      };
      (window as any).__addLog('App mounted');
    } else {
      (window as any).__addLog = () => {};
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!panRef.current.active) return;
      const dx = event.clientX - panRef.current.startX;
      const dy = event.clientY - panRef.current.startY;
      setTransform((prev) => ({
        ...prev,
        x: panRef.current.originX + dx,
        y: panRef.current.originY + dy,
      }));
    };

    const onPointerUp = () => {
      panRef.current.active = false;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    rootPathRef.current = rootPath;
  }, [rootPath]);

  useEffect(() => {
    const loadProjects = async () => {
      const list = await invoke<Array<{ path: string; name: string; last_used: number }>>('list_saved_projects');
      const mapped = list.map((item) => ({
        path: item.path,
        name: item.name,
        lastUsed: item.last_used || 0,
      }));
      setSavedProjects(mapped);
      if (!rootPath && mapped.length > 0) {
        setRootPath(mapped[0].path);
        setShowProjectPicker(false);
      }
    };
    loadProjects().catch(() => {});
  }, []);

  useEffect(() => {
    if (rootPath) {
      setShowProjectPicker(false);
      setPickerPath(rootPath);
      setPickerError(null);
    }
  }, [rootPath]);

  const isBackgroundTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return true;
    return !target.closest('.terminal-window');
  };

  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!isBackgroundTarget(event.target)) return;
    panRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return;
    if (!isBackgroundTarget(event.target)) {
      return;
    }
    event.preventDefault();
    const isPinch = event.ctrlKey || event.metaKey;
    if (isPinch) {
      const rect = canvasRef.current.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.002);

      setTransform((prev) => {
        const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
        const ratio = nextScale / prev.scale;
        return {
          scale: nextScale,
          x: mx - (mx - prev.x) * ratio,
          y: my - (my - prev.y) * ratio,
        };
      });
      return;
    }

    setTransform((prev) => ({
      ...prev,
      x: prev.x - event.deltaX,
      y: prev.y - event.deltaY,
    }));
  };

  const screenToWorld = (clientX: number, clientY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (clientX - rect.left - transform.x) / transform.scale;
    const y = (clientY - rect.top - transform.y) / transform.scale;
    return { x, y };
  };

  const spawnTerminal = async (x: number, y: number, nameOverride?: string) => {
    (window as any).__addLog?.('spawning terminal...');
    const session = await invoke<{ id: string }>('create_session', {
      shell: null,
      cwd: rootPathRef.current || null,
    });

    const id = session.id;
    const name = nameOverride || `term-${windowsRef.current.length + 1}`;
    zRef.current += 1;
    const newWindow: WindowItem = {
      id,
      x,
      y,
      z: zRef.current,
      title: 'Terminal',
      name,
      sessionId: session.id,
      width: 520,
      height: 320,
      type: 'terminal',
    };

    setWindows((prev) => [...prev, newWindow]);
    setActiveId(id);
  };

  useEffect(() => {
    if (spawnedRef.current || !rootPath) return;
    spawnedRef.current = true;
    spawnTerminal(160, 160).catch((err) => {
      console.error('spawn terminal failed', err);
    });
  }, [rootPath]);

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isBackgroundTarget(event.target)) return;
    const { x, y } = screenToWorld(event.clientX, event.clientY);
    spawnTerminal(x, y).catch((err) => {
      console.error('spawn terminal failed', err);
    });
  };

  const updateWindow = (id: string, patch: Partial<WindowItem>) => {
    setWindows((prev) => prev.map((win) => (win.id === id ? { ...win, ...patch } : win)));
  };

  const handleFocus = (id: string) => {
    zRef.current += 1;
    updateWindow(id, { z: zRef.current });
    setActiveId(id);
  };

  const handleClose = (id: string) => {
    const win = windowsRef.current.find((w) => w.id === id);
    if (win?.type === 'terminal' && win.sessionId) {
      invoke('close_session', { id: win.sessionId }).catch((err) => {
        console.error('close session failed', err);
      });
    }
    setWindows((prev) => prev.filter((win) => win.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const handleNewTerminal = () => {
    const base = windows.length * 24;
    spawnTerminal(120 + base, 120 + base).catch((err) => {
      console.error('spawn terminal failed', err);
    });
  };

  const handleRename = (id: string, name: string) => {
    updateWindow(id, { name });
  };

  const getCanvasCenter = () => {
    if (!canvasRef.current) return { x: 160, y: 160 };
    const rect = canvasRef.current.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const openFileWindow = (path: string) => {
    const existing = windowsRef.current.find((w) => w.type === 'file' && w.path === path);
    if (existing) {
      handleFocus(existing.id);
      return;
    }
    const { kind, mime } = inferFileKind(path);
    const { x, y } = getCanvasCenter();
    const id = crypto.randomUUID();
    zRef.current += 1;
    const offset = windowsRef.current.length * 18;
    const newWindow: WindowItem = {
      id,
      x: x + offset,
      y: y + offset,
      z: zRef.current,
      title: 'File',
      name: getFileName(path),
      width: 520,
      height: 360,
      type: 'file',
      path,
      fileKind: kind,
      fileMime: mime,
    };
    setWindows((prev) => [...prev, newWindow]);
    setActiveId(id);
  };

  const spawnFileWindowFromState = (path: string, state: Partial<WindowItem>) => {
    const { kind, mime } = inferFileKind(path);
    const id = state.id || crypto.randomUUID();
    zRef.current = Math.max(zRef.current + 1, state.z ?? zRef.current);
    const newWindow: WindowItem = {
      id,
      x: state.x ?? 160,
      y: state.y ?? 160,
      z: state.z ?? zRef.current,
      title: 'File',
      name: state.name || getFileName(path),
      width: state.width ?? 520,
      height: state.height ?? 360,
      type: 'file',
      path,
      fileKind: kind,
      fileMime: mime,
    };
    return newWindow;
  };

  const buildResumeCommand = (kind: WindowItem['terminalKind'], resumeId: string) => {
    if (kind === 'claude') return `claude --resume ${resumeId}`;
    if (kind === 'gemini') return `gemini --resume ${resumeId}`;
    return `codex resume ${resumeId}`;
  };

  const startCliInTerminal = async (
    sessionId: string,
    kind?: WindowItem['terminalKind'],
    resumeId?: string
  ) => {
    if (!kind) return;
    const command = resumeId ? buildResumeCommand(kind, resumeId) :
      (kind === 'claude' ? 'claude' : kind === 'gemini' ? 'gemini' : 'codex');
    await invoke('write_session', { id: sessionId, data: `${command}\r` }).catch(() => {});
  };

  const handleCommand = (winId: string, command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (trimmed === 'codex' || trimmed.startsWith('codex ')) {
      updateWindow(winId, { terminalKind: 'codex' });
    } else if (trimmed === 'claude' || trimmed.startsWith('claude ')) {
      updateWindow(winId, { terminalKind: 'claude' });
      pendingResumeRef.current.set(winId, { kind: 'claude', startedAt: Date.now(), baseline: new Set() });
    } else if (trimmed === 'gemini' || trimmed.startsWith('gemini ')) {
      updateWindow(winId, { terminalKind: 'gemini' });
      pendingResumeRef.current.set(winId, { kind: 'gemini', startedAt: Date.now(), baseline: new Set() });
    } else if (trimmed.startsWith('/resume') || trimmed.startsWith('/fork') || trimmed.startsWith('/new')) {
      const win = windowsRef.current.find((w) => w.id === winId) as WindowItem | undefined;
      if (win?.terminalKind === 'codex') {
      }
    }
  };

  const buildState = () => {
    return {
      version: 1,
      projectPath: rootPath,
      lastUsed: Date.now(),
      transform,
      activeId,
      windows: windows.map((win) => {
        if (win.type === 'terminal') {
          return {
            id: win.id,
            type: 'terminal',
            name: win.name,
            x: win.x,
            y: win.y,
            width: win.width,
            height: win.height,
            z: win.z,
            terminalKind: win.terminalKind,
            resumeSessionId: win.resumeSessionId,
          };
        }
        return {
          id: win.id,
          type: 'file',
          name: win.name,
          path: win.path,
          x: win.x,
          y: win.y,
          width: win.width,
          height: win.height,
          z: win.z,
        };
      }),
    };
  };

  const saveState = () => {
    if (!rootPath || restoringRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const payload = JSON.stringify(buildState());
      invoke('save_canvas_state', { projectPath: rootPath, state: payload }).catch((err) => {
        console.warn('save state failed', err);
      });
    }, 500);
  };

  useEffect(() => {
    saveState();
  }, [windows, transform, activeId, rootPath]);

  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    const load = async () => {
      restoringRef.current = true;
      try {
        const raw = await invoke<string | null>('load_canvas_state', { projectPath: rootPath });
        if (!raw || cancelled) {
          restoringRef.current = false;
          return;
        }
        const state = JSON.parse(raw);
        if (!state || !Array.isArray(state.windows)) {
          restoringRef.current = false;
          return;
        }
        spawnedRef.current = true;
        const restored: WindowItem[] = [];
        for (const w of state.windows) {
          if (w.type === 'terminal') {
            const session = await invoke<{ id: string }>('create_session', {
              shell: null,
              cwd: rootPathRef.current || null,
            });
            const id = w.id || crypto.randomUUID();
            restored.push({
              id,
              x: w.x ?? 160,
              y: w.y ?? 160,
              z: w.z ?? zRef.current,
              title: 'Terminal',
              name: w.name || 'Terminal',
              sessionId: session.id,
              width: w.width ?? 520,
              height: w.height ?? 320,
              type: 'terminal',
              terminalKind: w.terminalKind,
              resumeSessionId: w.resumeSessionId,
            });

            if (w.terminalKind) {
              startCliInTerminal(session.id, w.terminalKind, w.resumeSessionId);
            }
          } else if (w.type === 'file' && w.path) {
            restored.push(spawnFileWindowFromState(w.path, { ...w, id: w.id || crypto.randomUUID() }));
          }
        }
        if (!cancelled) {
          setTransform(state.transform || { x: 80, y: 80, scale: 1 });
          setWindows(restored);
          setActiveId(state.activeId || (restored[0]?.id ?? null));
          const assigned = new Set(
            restored
              .filter((w) => w.type === 'terminal' && w.terminalKind === 'codex' && w.resumeSessionId)
              .map((w) => w.resumeSessionId as string)
          );
          codexAssignedRef.current = assigned;
          const claudeAssigned = new Set(
            restored
              .filter((w) => w.type === 'terminal' && w.terminalKind === 'claude' && w.resumeSessionId)
              .map((w) => w.resumeSessionId as string)
          );
          claudeAssignedRef.current = claudeAssigned;
        }
      } catch (err) {
        console.warn('load state failed', err);
      } finally {
        restoringRef.current = false;
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const candidates = windowsRef.current.filter(
        (w) => w.type === 'terminal' && !w.terminalKind
      ) as (WindowItem & { type: 'terminal'; sessionId: string })[];
      if (candidates.length === 0) return;
      for (const win of candidates) {
        if (pendingResumeRef.current.has(win.id)) {
          continue;
        }
        const output = getTerminalOutput(win.sessionId, 120).text;
        const codexReady =
          /OpenAI Codex|gpt-.*codex|Tip:|model:/i.test(output) || output.includes('Use /fork');
        if (codexReady) {
          updateWindow(win.id, { terminalKind: 'codex' });
        } else if (/claude code|claude/i.test(output)) {
          updateWindow(win.id, { terminalKind: 'claude' });
        } else if (/gemini/i.test(output)) {
          updateWindow(win.id, { terminalKind: 'gemini' });
        }
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const codexWindows = windowsRef.current.filter(
        (w) => w.type === 'terminal' && w.terminalKind === 'codex'
      ) as (WindowItem & { type: 'terminal'; sessionId: string })[];
      if (codexWindows.length === 0) return;
      const sessions = await invoke<Array<{ session_id: string; updated_at: number; cwd: string }>>(
        'get_codex_threads_after',
        { cwd: rootPathRef.current || '', minTsMs: 0, limit: 50 }
      ).catch(() => []);
      if (sessions.length === 0) return;
      const sessionIds = new Set(sessions.map((s) => s.session_id));
      const activeId = activeIdRef.current;
      const orderedWins = [...codexWindows].sort((a, b) => {
        if (a.id === activeId) return -1;
        if (b.id === activeId) return 1;
        return a.id.localeCompare(b.id);
      });
      const assigned = new Set<string>();
      const nextAvailable = () => sessions.find((s) => !assigned.has(s.session_id));
      for (const win of orderedWins) {
        const currentId = win.resumeSessionId;
        if (currentId && sessionIds.has(currentId) && !assigned.has(currentId)) {
          assigned.add(currentId);
          continue;
        }
        const next = nextAvailable();
        if (!next) continue;
        const prevId = win.resumeSessionId;
        if (prevId && prevId !== next.session_id) {
          codexAssignedRef.current.delete(prevId);
        }
        assigned.add(next.session_id);
        codexAssignedRef.current.add(next.session_id);
        updateWindow(win.id, { resumeSessionId: next.session_id });
      }
      codexAssignedRef.current = assigned;
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const claudeWindows = windowsRef.current.filter(
        (w) => w.type === 'terminal' && w.terminalKind === 'claude'
      ) as (WindowItem & { type: 'terminal'; sessionId: string })[];
      if (claudeWindows.length === 0) return;
      const sessions = await invoke<Array<{ session_id: string; updated_at: number }>>(
        'get_claude_sessions',
        { projectPath: rootPathRef.current || '', limit: 50 }
      ).catch(() => []);
      if (sessions.length === 0) return;
      const sessionIds = new Set(sessions.map((s) => s.session_id));
      const activeId = activeIdRef.current;
      const orderedWins = [...claudeWindows].sort((a, b) => {
        if (a.id === activeId) return -1;
        if (b.id === activeId) return 1;
        return a.id.localeCompare(b.id);
      });
      const assigned = new Set<string>();
      const nextAvailable = () => sessions.find((s) => !assigned.has(s.session_id));
      for (const win of orderedWins) {
        const currentId = win.resumeSessionId;
        if (currentId && sessionIds.has(currentId) && !assigned.has(currentId)) {
          assigned.add(currentId);
          continue;
        }
        const next = nextAvailable();
        if (!next) continue;
        const prevId = win.resumeSessionId;
        if (prevId && prevId !== next.session_id) {
          claudeAssignedRef.current.delete(prevId);
        }
        assigned.add(next.session_id);
        claudeAssignedRef.current.add(next.session_id);
        updateWindow(win.id, { resumeSessionId: next.session_id });
      }
      claudeAssignedRef.current = assigned;
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (pendingResumeRef.current.size === 0) return;
      for (const [winId, pending] of Array.from(pendingResumeRef.current.entries())) {
        if (pending.kind === 'claude') {
          pendingResumeRef.current.delete(winId);
        } else if (pending.kind === 'gemini') {
          const latest = await invoke<string | null>('get_gemini_latest_session_after', {
            projectPath: rootPathRef.current || '',
            minTsMs: pending.startedAt,
          }).catch(() => null);
          if (latest) {
            updateWindow(winId, { resumeSessionId: latest });
            pendingResumeRef.current.delete(winId);
          }
        }
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  const canvasStyle = useMemo(() => {
    return {
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
    } as React.CSSProperties;
  }, [transform]);

  return (
    <div className={`app ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <FileTree
        rootPath={rootPath}
        onRootPathChange={setRootPath}
        onRootChange={setRootPath}
        onOpenPath={openFileWindow}
        sessions={windows
          .filter((win) => win.type === 'terminal')
          .map((win) => ({ id: win.id, name: win.name, active: activeId === win.id }))}
        onSelectSession={handleFocus}
        onRenameSession={handleRename}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
      />

      {showProjectPicker && (
        <div className="project-picker">
          <div className="project-card">
            <div className="project-title">Open Project</div>
            <div className="project-subtitle">Pick a saved folder or open a new one.</div>
            {savedProjects.length > 0 && (
              <div className="project-list">
                {savedProjects.map((project) => (
                  <button
                    key={project.path}
                    className="project-item"
                    type="button"
                    onClick={() => {
                      setRootPath(project.path);
                      setPickerError(null);
                    }}
                  >
                    <span className="project-name">{project.name}</span>
                    <span className="project-path">{project.path}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="project-input-row">
              <input
                className="project-input"
                placeholder="/path/to/project"
                value={pickerPath}
                onChange={(event) => setPickerPath(event.target.value)}
              />
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  if (!pickerPath) return;
                  try {
                    await invoke('list_dir', { path: pickerPath });
                    setRootPath(pickerPath);
                    setPickerError(null);
                  } catch {
                    setPickerError('Folder not found');
                  }
                }}
              >
                Open
              </button>
            </div>
            {pickerError && <div className="project-error">{pickerError}</div>}
            <div className="project-actions">
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  const home = await invoke<string>('default_root');
                  setRootPath(home);
                  setPickerError(null);
                }}
              >
                Use Home Folder
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="topbar" data-tauri-drag-region>
        <div className="topbar-left">
          <div className="topbar-spacer" />
        </div>
        <div className="topbar-center">
          <button className="btn primary" onClick={handleNewTerminal} data-tauri-drag-region="false">
            + Terminal
          </button>
        </div>
        <div className="topbar-right" />
      </div>

      <div className="zoom-float">
        <button
          className="zoom-btn"
          onClick={() => setTransform((prev) => ({ ...prev, scale: Math.max(MIN_SCALE, prev.scale - 0.1) }))}
          title="Zoom out"
        >
          –
        </button>
        <div className="zoom-readout">{Math.round(transform.scale * 100)}%</div>
        <button
          className="zoom-btn"
          onClick={() => setTransform((prev) => ({ ...prev, scale: Math.min(MAX_SCALE, prev.scale + 0.1) }))}
          title="Zoom in"
        >
          +
        </button>
      </div>

      {!sidebarOpen && (
        <button
          className="sidebar-handle"
          onClick={() => setSidebarOpen(true)}
          title="Show sidebar"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      )}

      <div
        className="canvas"
        ref={canvasRef}
        onPointerDown={beginPan}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
      >
        <div className="canvas-grid" style={canvasStyle}>
          {windows.map((win) => {
            if (win.type === 'terminal') {
              return (
                <TerminalWindow
                  key={win.id}
                  win={win as WindowItem & { type: 'terminal'; sessionId: string }}
                  scale={transform.scale}
                  active={activeId === win.id}
                  onMove={(id, x, y) => updateWindow(id, { x, y })}
                  onResize={(id, width, height) => updateWindow(id, { width, height })}
                  onFocus={handleFocus}
                  onClose={handleClose}
                  onRename={handleRename}
                  onCommand={handleCommand}
                />
              );
            }

            return (
              <FileWindow
                key={win.id}
                win={win as WindowItem & { type: 'file'; path: string }}
                scale={transform.scale}
                active={activeId === win.id}
                onMove={(id, x, y) => updateWindow(id, { x, y })}
                onResize={(id, width, height) => updateWindow(id, { width, height })}
                onFocus={handleFocus}
                onClose={handleClose}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

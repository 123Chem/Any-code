import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { api, Project, Session } from '@/lib/api';
import { useTranslation } from 'react-i18next';

interface ProjectContextType {
  projects: Project[];
  selectedProject: Project | null;
  sessions: Session[];
  loading: boolean;
  error: string | null;
  loadProjects: () => Promise<void>;
  selectProject: (project: Project) => Promise<void>;
  refreshSessions: () => Promise<void>;
  deleteProject: (project: Project) => Promise<void>;
  clearSelection: () => void;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectRequest = useRef(0);
  const sessionRequest = useRef(0);
  const selectedProjectRef = useRef<Project | null>(null);

  const loadProjects = useCallback(async () => {
    const request = ++projectRequest.current;
    try {
      setLoading(true);
      setError(null);
      const list = await api.listProjects();
      
      // 1. 获取 Codex 会话列表（全局获取，开销小）
      let codexSessions: any[] = [];
      try {
        codexSessions = await api.listCodexSessions();
      } catch (e) {
        console.warn("Failed to load codex sessions for sorting:", e);
      }

      // 2. 计算每个项目的"最后活跃时间"
      // 默认使用创建时间，如果发现更有更新的 Codex 会话，则更新
      const projectLastActive = new Map<string, number>();
      
      // 辅助函数：标准化路径（去除末尾斜杠，转小写，统一斜杠）
      const normalize = (p: string) => p ? p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() : '';

      // 初始化：使用项目创建时间
      list.forEach(p => {
        const normPath = normalize(p.path);
        projectLastActive.set(normPath, p.created_at);
      });

      // 更新：检查 Codex 会话
      codexSessions.forEach(session => {
        if (!session.projectPath) return;
        const normPath = normalize(session.projectPath);
        
        // 获取会话的最新时间（优先使用最后消息时间，否则使用创建时间）
        // 注意：Codex 会话的时间戳可能是 ISO 字符串或 Unix 时间戳，需要统一
        let sessionTime = 0;
        
        if (session.lastMessageTimestamp) {
          sessionTime = new Date(session.lastMessageTimestamp).getTime() / 1000;
        } else if (session.createdAt) {
          sessionTime = typeof session.createdAt === 'string' 
            ? new Date(session.createdAt).getTime() / 1000 
            : session.createdAt;
        }

        const current = projectLastActive.get(normPath) || 0;
        if (sessionTime > current) {
          projectLastActive.set(normPath, sessionTime);
        }
      });

      // 3. 排序：按最后活跃时间降序（最新的在前）
      const sortedList = list.sort((a, b) => {
        const timeA = projectLastActive.get(normalize(a.path)) || a.created_at;
        const timeB = projectLastActive.get(normalize(b.path)) || b.created_at;
        return timeB - timeA;
      });

      if (request === projectRequest.current) setProjects(sortedList);
    } catch (err) {
      console.error("Failed to load projects:", err);
      if (request === projectRequest.current) setError(t('common.loadingProjects'));
    } finally {
      if (request === projectRequest.current) setLoading(false);
    }
  }, [t]);

  const loadSessionsForProject = useCallback(async (project: Project): Promise<Session[]> => {
    const [claudeCodex, gemini] = await Promise.allSettled([
      api.getProjectSessions(project.id, project.path),
      project.path ? api.listGeminiSessions(project.path) : Promise.resolve([]),
    ]);
    if (claudeCodex.status === 'rejected') throw claudeCodex.reason;
    const geminiSessions: Session[] = gemini.status === 'fulfilled' ? gemini.value.map(info => ({
      id: info.sessionId, project_id: project.id, project_path: project.path,
      created_at: new Date(info.startTime).getTime() / 1000, first_message: info.firstMessage,
      message_timestamp: info.startTime, last_message_timestamp: info.startTime, engine: 'gemini' as const,
    })) : [];
    if (gemini.status === 'rejected') console.warn('[ProjectContext] Failed to load Gemini sessions:', gemini.reason);
    return [...claudeCodex.value, ...geminiSessions];
  }, []);

  const selectProject = useCallback(async (project: Project) => {
    const request = ++sessionRequest.current;
    selectedProjectRef.current = project;
    setSelectedProject(project);
    setSessions([]);
    try {
      setLoading(true);
      setError(null);

      const allSessions = await loadSessionsForProject(project);
      if (request !== sessionRequest.current) return;
      setSessions(allSessions);
      if (project.path) api.preindexProject(project.path).catch(console.error);
    } catch (err) {
      if (request === sessionRequest.current) {
        console.error("Failed to load sessions:", err);
        setError(String(err));
      }
    } finally {
      if (request === sessionRequest.current) setLoading(false);
    }
  }, [loadSessionsForProject]);

  const refreshSessions = useCallback(async () => {
    const selected = selectedProjectRef.current;
    if (selected) {
      const request = ++sessionRequest.current;
      try {
        const allSessions = await loadSessionsForProject(selected);
        if (request === sessionRequest.current && selectedProjectRef.current?.id === selected.id) {
          setSessions(allSessions);
        }
      } catch (err) {
        console.error("Failed to refresh sessions:", err);
      }
    }
  }, [loadSessionsForProject]);

  const deleteProject = useCallback(async (project: Project) => {
    try {
      setLoading(true);
      await api.deleteProject(project.id);
      await loadProjects();
      if (selectedProjectRef.current?.id === project.id) {
        ++sessionRequest.current;
        selectedProjectRef.current = null;
        setSelectedProject(null);
        setSessions([]);
      }
    } catch (err) {
      console.error("Failed to delete project:", err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [loadProjects]);

  const clearSelection = useCallback(() => {
    ++sessionRequest.current;
    selectedProjectRef.current = null;
    setSelectedProject(null);
    setSessions([]);
    setLoading(false);
  }, []);

  // Load projects on mount
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <ProjectContext.Provider value={{
      projects,
      selectedProject,
      sessions,
      loading,
      error,
      loadProjects,
      selectProject,
      refreshSessions,
      deleteProject,
      clearSelection
    }}>
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
};

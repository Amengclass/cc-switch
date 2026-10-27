import { invoke } from "@tauri-apps/api/core";

export interface DailyMemoryFileInfo {
  filename: string;
  date: string;
  sizeBytes: number;
  modifiedAt: number;
  preview: string;
}

export interface DailyMemorySearchResult {
  filename: string;
  date: string;
  sizeBytes: number;
  modifiedAt: number;
  snippet: string;
  matchCount: number;
}

/** 远端目标（本补丁层）：非空时工作区读写走远端。 */
export interface WorkspaceRemoteTarget {
  remoteTargetId?: string;
  remoteContainerId?: string;
}

/**
 * 按目标返回工作区 API：本机走 workspaceApi，远端走 remote_* 命令。
 * 组件只依赖返回值的形状，不关心背后是哪台机器。
 */
export function workspaceApiFor(target?: WorkspaceRemoteTarget) {
  const hostId = target?.remoteTargetId;
  if (!hostId) return workspaceApi;
  const container = target.remoteContainerId ?? null;
  return {
    async readFile(filename: string): Promise<string | null> {
      return invoke<string | null>("read_remote_workspace_file", {
        hostId,
        filename,
        container,
      });
    },
    async writeFile(filename: string, content: string): Promise<void> {
      return invoke<void>("write_remote_workspace_file", {
        hostId,
        filename,
        content,
        container,
      });
    },
    async listDailyMemoryFiles(): Promise<DailyMemoryFileInfo[]> {
      return invoke<DailyMemoryFileInfo[]>("list_remote_daily_memory_files", {
        hostId,
        container,
      });
    },
    async readDailyMemoryFile(filename: string): Promise<string | null> {
      return invoke<string | null>("read_remote_daily_memory_file", {
        hostId,
        filename,
        container,
      });
    },
    async writeDailyMemoryFile(
      filename: string,
      content: string,
    ): Promise<void> {
      return invoke<void>("write_remote_daily_memory_file", {
        hostId,
        filename,
        content,
        container,
      });
    },
    async deleteDailyMemoryFile(filename: string): Promise<void> {
      return invoke<void>("delete_remote_daily_memory_file", {
        hostId,
        filename,
        container,
      });
    },
    async searchDailyMemoryFiles(
      query: string,
    ): Promise<DailyMemorySearchResult[]> {
      return invoke<DailyMemorySearchResult[]>(
        "search_remote_daily_memory_files",
        { hostId, query, container },
      );
    },
    /** 远端没有本机文件管理器：入口在 UI 上隐藏，这里保持 no-op。 */
    async openDirectory(): Promise<void> {
      return;
    },
  };
}

export type WorkspaceApi = ReturnType<typeof workspaceApiFor>;

export const workspaceApi = {
  async readFile(filename: string): Promise<string | null> {
    return invoke<string | null>("read_workspace_file", { filename });
  },

  async writeFile(filename: string, content: string): Promise<void> {
    return invoke<void>("write_workspace_file", { filename, content });
  },

  async listDailyMemoryFiles(): Promise<DailyMemoryFileInfo[]> {
    return invoke<DailyMemoryFileInfo[]>("list_daily_memory_files");
  },

  async readDailyMemoryFile(filename: string): Promise<string | null> {
    return invoke<string | null>("read_daily_memory_file", { filename });
  },

  async writeDailyMemoryFile(filename: string, content: string): Promise<void> {
    return invoke<void>("write_daily_memory_file", { filename, content });
  },

  async deleteDailyMemoryFile(filename: string): Promise<void> {
    return invoke<void>("delete_daily_memory_file", { filename });
  },

  async searchDailyMemoryFiles(
    query: string,
  ): Promise<DailyMemorySearchResult[]> {
    return invoke<DailyMemorySearchResult[]>("search_daily_memory_files", {
      query,
    });
  },

  async openDirectory(subdir: "workspace" | "memory"): Promise<void> {
    await invoke("open_workspace_directory", { subdir });
  },
};

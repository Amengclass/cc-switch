import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  skillsApi,
  type SkillBackupEntry,
  type DiscoverableSkill,
  type ImportSkillSelection,
  type InstalledSkill,
  type SkillUpdateInfo,
  type SkillsShSearchResult,
} from "@/lib/api/skills";
import type { AppId } from "@/lib/api/types";
import {
  deleteRemoteSkill,
  installRemoteSkillFromDir,
  installRemoteSkillFromDiscoverable,
  installRemoteSkillsFromZip,
  listRemoteSkills,
  toggleRemoteSkillApp,
} from "@/lib/api/remote";
import { mergeImportedSkills } from "@/hooks/useSkills.helpers";

/** 把远端技能目录项适配成 InstalledSkill。 */
function remoteToInstalled(entry: {
  id?: string;
  name: string;
  directory: string;
  path?: string;
  description?: string;
  apps?: { claude?: boolean; codex?: boolean; gemini?: boolean; grokbuild?: boolean; opencode?: boolean; openclaw?: boolean; hermes?: boolean };
  installedAt?: number;
  updatedAt?: number;
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  readmeUrl?: string;
  contentHash?: string;
}): InstalledSkill {
  return {
    id: entry.id || entry.name,
    name: entry.name,
    description: entry.description,
    directory: entry.directory,
    apps: {
      claude: entry.apps?.claude ?? true,
      codex: entry.apps?.codex ?? false,
      gemini: entry.apps?.gemini ?? false,
      grokbuild: entry.apps?.grokbuild ?? false,
      opencode: entry.apps?.opencode ?? false,
      openclaw: entry.apps?.openclaw ?? false,
      hermes: entry.apps?.hermes ?? false,
    },
    installedAt: entry.installedAt ?? 0,
    updatedAt: entry.updatedAt ?? 0,
    repoOwner: entry.repoOwner,
    repoName: entry.repoName,
    repoBranch: entry.repoBranch,
    readmeUrl: entry.readmeUrl,
    contentHash: entry.contentHash,
  };
}

/**
 * 查询所有已安装的 Skills
 * 使用 staleTime: Infinity 和 placeholderData: keepPreviousData
 * 实现首次进入使用缓存，只有刷新时才重新获取
 */
export function useInstalledSkills(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  return useQuery({
    queryKey: remoteTargetId
      ? [
          "skills",
          "installed",
          "remote",
          remoteTargetId,
          remoteContainerId ?? "__host__",
        ]
      : ["skills", "installed"],
    queryFn: async () => {
      if (remoteTargetId) {
        const entries = await listRemoteSkills(remoteTargetId, remoteContainerId);
        return entries.map(remoteToInstalled);
      }
      return skillsApi.getInstalled();
    },
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

export function useSkillBackups() {
  return useQuery({
    queryKey: ["skills", "backups"],
    queryFn: () => skillsApi.getBackups(),
    enabled: false,
  });
}

export function useDeleteSkillBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => skillsApi.deleteBackup(backupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills", "backups"] });
    },
  });
}

/**
 * 发现可安装的 Skills（从仓库获取）
 * 使用 staleTime: Infinity 和 placeholderData: keepPreviousData
 * 实现首次进入使用缓存，只有刷新时才重新获取
 */
export function useDiscoverableSkills() {
  return useQuery({
    queryKey: ["skills", "discoverable"],
    queryFn: () => skillsApi.discoverAvailable(),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

/**
 * 安装 Skill
 * 成功后直接更新缓存，不触发重新加载/刷新
 */
export function useInstallSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      skill,
      currentApp,
    }: {
      skill: DiscoverableSkill;
      currentApp: AppId;
    }) => skillsApi.installUnified(skill, currentApp),
    onSuccess: (installedSkill, _vars, _ctx) => {
      const { skill } = _vars;
      // 直接更新 installed 缓存
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed"],
        (oldData) => {
          if (!oldData) return [installedSkill];
          return [...oldData, installedSkill];
        },
      );

      // 更新 discoverable 缓存中对应技能的 installed 状态
      const installName =
        skill.directory.split(/[/\\]/).pop()?.toLowerCase() ||
        skill.directory.toLowerCase();
      const skillKey = `${installName}:${skill.repoOwner.toLowerCase()}:${skill.repoName.toLowerCase()}`;

      queryClient.setQueryData<DiscoverableSkill[]>(
        ["skills", "discoverable"],
        (oldData) => {
          if (!oldData) return oldData;
          return oldData.map((s) => {
            if (s.key === skillKey) {
              return { ...s, installed: true };
            }
            return s;
          });
        },
      );
    },
  });
}

/**
 * 远端：从「发现技能」列表把一个技能安装到远端目标。
 *
 * 发现列表仍来自本机仓库；安装时本机下载仓库 zip → 上传远端 SSOT →
 * 写 skills.json + 建链接。语义与本机 install 对齐。
 */
export function useInstallRemoteSkillFromDiscoverable(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  const installedKey = remoteTargetId
    ? [
        "skills",
        "installed",
        "remote",
        remoteTargetId,
        remoteContainerId ?? "__host__",
      ]
    : ["skills", "installed"];
  return useMutation({
    mutationFn: ({ skill }: { skill: DiscoverableSkill }) => {
      if (!remoteTargetId) {
        return Promise.reject(new Error("未选择远端目标"));
      }
      return installRemoteSkillFromDiscoverable(
        remoteTargetId,
        skill,
        remoteContainerId,
      ).then((r) => remoteToInstalled({ ...r, path: "" }));
    },
    onSuccess: (installedSkill) => {
      queryClient.setQueryData<InstalledSkill[]>(installedKey, (oldData) => {
        if (!oldData) return [installedSkill];
        return [...oldData, installedSkill];
      });
    },
  });
}

/**
 * 卸载 Skill
 * 成功后直接更新缓存，不触发重新加载/刷新
 */
export function useUninstallSkill(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  const installedKey = remoteTargetId
    ? [
        "skills",
        "installed",
        "remote",
        remoteTargetId,
        remoteContainerId ?? "__host__",
      ]
    : ["skills", "installed"];
  return useMutation({
    mutationFn: async ({ id, skillKey }: { id: string; skillKey: string }) => {
      if (remoteTargetId) {
        await deleteRemoteSkill(remoteTargetId, id, remoteContainerId);
        return { backupPath: undefined, skillKey };
      }
      const result = await skillsApi.uninstallUnified(id);
      return { ...result, skillKey };
    },
    onSuccess: ({ skillKey }, _vars) => {
      // 直接更新 installed 缓存，移除该 skill
      queryClient.setQueryData<InstalledSkill[]>(installedKey, (oldData) => {
        if (!oldData) return oldData;
        return oldData.filter((s) => s.id !== _vars.id);
      });

      // 远端无 discoverable 概念，仅在本地模式更新 discoverable 缓存
      if (!remoteTargetId) {
        queryClient.setQueryData<DiscoverableSkill[]>(
          ["skills", "discoverable"],
          (oldData) => {
            if (!oldData) return oldData;
            return oldData.map((s) => {
              if (s.key === skillKey) {
                return { ...s, installed: false };
              }
              return s;
            });
          },
        );
      }
    },
  });
}

export function useRestoreSkillBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      backupId,
      currentApp,
    }: {
      backupId: string;
      currentApp: AppId;
    }) => skillsApi.restoreBackup(backupId, currentApp),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills", "installed"] });
      queryClient.invalidateQueries({ queryKey: ["skills", "backups"] });
    },
  });
}

/**
 * 切换 Skill 在特定应用的启用状态
 */
export function useToggleSkillApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      app,
      enabled,
    }: {
      id: string;
      app: AppId;
      enabled: boolean;
    }) => skillsApi.toggleApp(id, app, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills", "installed"] });
    },
  });
}

/** 切换远端技能在某应用的启用状态（更新 skills.json + symlink）。 */
export function useToggleRemoteSkillApp(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  const installedKey = remoteTargetId
    ? [
        "skills",
        "installed",
        "remote",
        remoteTargetId,
        remoteContainerId ?? "__host__",
      ]
    : ["skills", "installed"];
  return useMutation({
    mutationFn: ({
      id,
      app,
      enabled,
    }: {
      id: string;
      app: AppId;
      enabled: boolean;
    }) => {
      if (!remoteTargetId) return Promise.resolve(false);
      return toggleRemoteSkillApp(
        remoteTargetId,
        id,
        app,
        enabled,
        remoteContainerId,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: installedKey });
    },
  });
}

/**
 * 扫描未管理的 Skills
 *
 * - 传 { enabled: true }（Skill 面板挂载时）会在进入页面时自动静默扫描一次，
 *   30s 内复用结果，避免来回切页时重复磁盘 IO。
 * - 默认 enabled: false：仅订阅共享缓存（如顶栏「导入」按钮的绿点提示），
 *   不主动触发扫描。两者共用同一 queryKey，面板扫描完成后绿点会自动亮起。
 */
export function useScanUnmanagedSkills(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["skills", "unmanaged"],
    queryFn: () => skillsApi.scanUnmanaged(),
    enabled: options?.enabled ?? false,
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });
}

/**
 * 从应用目录导入 Skills。
 * 远端模式：逐个上传选中的本地技能目录到远端 ~/.claude/skills/。
 * 本机模式：调用本机 importFromApps API。
 */
export function useImportSkillsFromApps(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  const installedKey = remoteTargetId
    ? [
        "skills",
        "installed",
        "remote",
        remoteTargetId,
        remoteContainerId ?? "__host__",
      ]
    : ["skills", "installed"];
  return useMutation({
    mutationFn: async (imports: ImportSkillSelection[]) => {
      if (remoteTargetId) {
        const installed: InstalledSkill[] = [];
        const errors: string[] = [];
        for (const imp of imports) {
          const fullPath = imp.path || imp.directory;
          try {
            const name = await installRemoteSkillFromDir(
              remoteTargetId,
              fullPath,
              remoteContainerId,
            );
            installed.push(
              remoteToInstalled({ name, directory: name, path: fullPath }),
            );
          } catch (e) {
            const errMsg = String(e);
            errors.push(`${imp.directory}: ${errMsg}`);
            console.warn("[remote-import] 跳过", imp.directory, errMsg);
          }
        }
        if (errors.length > 0 && installed.length === 0) {
          throw new Error(errors.join("; "));
        }
        return installed;
      }
      return skillsApi.importFromApps(imports);
    },
    onSuccess: (importedSkills) => {
      queryClient.setQueryData<InstalledSkill[]>(
        installedKey,
        (oldData) => mergeImportedSkills(oldData, importedSkills),
      );
      // 远端导入后重新拉取，获得 SKILL.md 解析出的 displayName / description
      if (remoteTargetId) {
        queryClient.invalidateQueries({ queryKey: installedKey });
      }
      // 刷新 unmanaged 列表（已被导入的应该移除）
      queryClient.invalidateQueries({ queryKey: ["skills", "unmanaged"] });
    },
  });
}

/**
 * 获取仓库列表
 */
export function useSkillRepos() {
  return useQuery({
    queryKey: ["skills", "repos"],
    queryFn: () => skillsApi.getRepos(),
  });
}

/**
 * 添加仓库
 */
export function useAddSkillRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: skillsApi.addRepo,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills", "repos"] });
      queryClient.invalidateQueries({ queryKey: ["skills", "discoverable"] });
    },
  });
}

/**
 * 删除仓库
 */
export function useRemoveSkillRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ owner, name }: { owner: string; name: string }) =>
      skillsApi.removeRepo(owner, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills", "repos"] });
      queryClient.invalidateQueries({ queryKey: ["skills", "discoverable"] });
    },
  });
}

/**
 * 从 ZIP 文件安装 Skills
 * 成功后直接更新缓存，不触发重新加载/刷新
 */
export function useInstallSkillsFromZip(
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      filePath,
      currentApp,
    }: {
      filePath: string;
      currentApp: AppId;
    }) => {
      if (remoteTargetId) {
        const records = await installRemoteSkillsFromZip(
          remoteTargetId,
          filePath,
          remoteContainerId,
        );
        // 返回完整数据（含 description），与本机行为一致
        return records.map((r) => remoteToInstalled({ ...r, path: "" }));
      }
      return skillsApi.installFromZip(filePath, currentApp);
    },
    onSuccess: (installedSkills) => {
      const key = remoteTargetId
        ? ["skills", "installed", "remote", remoteTargetId, remoteContainerId ?? "__host__"]
        : ["skills", "installed"];
      // 即时更新 UI（本地 + 远端统一策略，数据已完整含 description）
      queryClient.setQueryData<InstalledSkill[]>(key, (oldData) => {
        if (!oldData) return installedSkills;
        return [...oldData, ...installedSkills];
      });
    },
  });
}

// ========== 更新检测 ==========

/**
 * 检查 Skills 更新（手动触发）
 */
export function useCheckSkillUpdates() {
  return useQuery({
    queryKey: ["skills", "updates"],
    queryFn: () => skillsApi.checkUpdates(),
    enabled: false,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * 更新单个 Skill
 */
export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => skillsApi.updateSkill(id),
    onSuccess: (updatedSkill) => {
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed"],
        (oldData) => {
          if (!oldData) return [updatedSkill];
          return oldData.map((s) =>
            s.id === updatedSkill.id ? updatedSkill : s,
          );
        },
      );
      queryClient.setQueryData<SkillUpdateInfo[]>(
        ["skills", "updates"],
        (oldData) => {
          if (!oldData) return oldData;
          return oldData.filter((u) => u.id !== updatedSkill.id);
        },
      );
    },
  });
}

// ========== skills.sh 搜索 ==========

/**
 * 搜索 skills.sh 公共目录
 * 使用 300ms staleTime 和 keepPreviousData 实现平滑搜索体验
 */
export function useSearchSkillsSh(
  query: string,
  limit: number,
  offset: number,
) {
  return useQuery({
    queryKey: ["skills", "skillssh", query, limit, offset],
    queryFn: () => skillsApi.searchSkillsSh(query, limit, offset),
    enabled: query.length >= 2,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

// ========== 辅助类型 ==========

export type {
  InstalledSkill,
  DiscoverableSkill,
  ImportSkillSelection,
  SkillBackupEntry,
  SkillUpdateInfo,
  SkillsShSearchResult,
  AppId,
};

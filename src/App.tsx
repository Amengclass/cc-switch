import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Settings,
  ArrowLeft,
  Minus,
  Maximize2,
  Minimize2,
  X,
  Book,
  Brain,
  Wrench,
  History,
  BarChart2,
  Download,
  FolderArchive,
  Search,
  FolderOpen,
  KeyRound,
  Shield,
  Cpu,
  LayoutDashboard,
  Server,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Provider, VisibleApps } from "@/types";
import type { EnvConflict } from "@/types/env";
import { proxyKeys, useProvidersQuery, useSettingsQuery } from "@/lib/query";
import {
  providersApi,
  settingsApi,
  type AppId,
  type ProviderSwitchEvent,
} from "@/lib/api";
import { checkAllEnvConflicts, checkEnvConflicts } from "@/lib/api/env";
import { useProviderActions } from "@/hooks/useProviderActions";
import { openclawKeys, useOpenClawHealth } from "@/hooks/useOpenClaw";
import { hermesKeys, useOpenHermesWebUI } from "@/hooks/useHermes";
import { hermesApi } from "@/lib/api/hermes";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useLastValidValue } from "@/hooks/useLastValidValue";
import { useScanUnmanagedSkills } from "@/hooks/useSkills";
import { extractErrorMessage } from "@/utils/errorUtils";
import { isTextEditableTarget } from "@/utils/domUtils";
import { deepClone } from "@/utils/deepClone";
import { cn } from "@/lib/utils";
import {
  isWindows,
  isLinux,
  DRAG_REGION_ATTR,
  DRAG_REGION_STYLE,
} from "@/lib/platform";
import { AppSwitcher } from "@/components/AppSwitcher";
import { TargetBreadcrumb } from "@/components/remote/TargetBreadcrumb";
import { InstallCommandPopover } from "@/components/remote/InstallCommandPopover";
import { APP_INSTALL_CMDS } from "@/config/appConfig";
import {
  checkLocalCliInstalled,
  checkRemoteCliInstalled,
  getRemoteCurrentProvider,
  listDockerContainers,
  listRemoteHosts,
  probeHostsOnline,
  setRemoteOpenClawDefaultModel,
  removeRemoteProviderFromLive,
  addRemoteProvider,
  updateRemoteProvider,
  deleteRemoteProvider,
  type RemoteProvidersView,
} from "@/lib/api/remote";
import {
  useRemoteProvidersQuery,
  useSwitchRemoteProviderMutation,
} from "@/lib/query/remoteMutations";
import type { RemoteHost } from "@/types/remote";
import { ProfileSwitcher } from "@/components/profiles/ProfileSwitcher";
import { ProviderList } from "@/components/providers/ProviderList";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import { EditProviderDialog } from "@/components/providers/EditProviderDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { UpdateBadge } from "@/components/UpdateBadge";
import { EnvWarningBanner } from "@/components/env/EnvWarningBanner";
import { ProxyToggle } from "@/components/proxy/ProxyToggle";
import { ClaudeDesktopRouteToggle } from "@/components/proxy/ClaudeDesktopRouteToggle";
import { FailoverToggle } from "@/components/proxy/FailoverToggle";
import UsageScriptModal from "@/components/UsageScriptModal";
import UnifiedMcpPanel from "@/components/mcp/UnifiedMcpPanel";
import PromptPanel from "@/components/prompts/PromptPanel";
import {
  SkillsPage,
  getSkillsPageHeaderActions,
  type SkillsPageSource,
} from "@/components/skills/SkillsPage";
import UnifiedSkillsPanel, {
  type SkillsCheckUpdatesState,
} from "@/components/skills/UnifiedSkillsPanel";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { AgentsPanel } from "@/components/agents/AgentsPanel";
import { UniversalProviderPanel } from "@/components/universal";
import { RemoteHostsPanel } from "@/components/remote/RemoteHostsPanel";
import { McpIcon } from "@/components/BrandIcons";
import { Button } from "@/components/ui/button";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import {
  useDisableCurrentOmo,
  useDisableCurrentOmoSlim,
} from "@/lib/query/omo";
import WorkspaceFilesPanel from "@/components/workspace/WorkspaceFilesPanel";
import EnvPanel from "@/components/openclaw/EnvPanel";
import ToolsPanel from "@/components/openclaw/ToolsPanel";
import AgentsDefaultsPanel from "@/components/openclaw/AgentsDefaultsPanel";
import OpenClawHealthBanner from "@/components/openclaw/OpenClawHealthBanner";
import HermesMemoryPanel from "@/components/hermes/HermesMemoryPanel";

type View =
  | "providers"
  | "settings"
  | "prompts"
  | "skills"
  | "skillsDiscovery"
  | "mcp"
  | "agents"
  | "universal"
  | "sessions"
  | "workspace"
  | "remote"
  | "openclawEnv"
  | "openclawTools"
  | "openclawAgents"
  | "hermesMemory";

interface SyncStatusUpdatedPayload {
  source?: string;
  status?: string;
  error?: string;
}

const DEFAULT_DRAG_BAR_HEIGHT = isWindows() || isLinux() ? 0 : 28; // px
const HEADER_HEIGHT = 64; // px

const STORAGE_KEY = "cc-switch-last-app";
const VALID_APPS: AppId[] = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
];

const getInitialApp = (): AppId => {
  const saved = localStorage.getItem(STORAGE_KEY) as AppId | null;
  if (saved && VALID_APPS.includes(saved)) {
    return saved;
  }
  return "claude";
};

const VIEW_STORAGE_KEY = "cc-switch-last-view";
const VALID_VIEWS: View[] = [
  "providers",
  "settings",
  "prompts",
  "skills",
  "skillsDiscovery",
  "mcp",
  "agents",
  "universal",
  "sessions",
  "workspace",
  "remote",
  "openclawEnv",
  "openclawTools",
  "openclawAgents",
  "hermesMemory",
];

const getInitialView = (): View => {
  const saved = localStorage.getItem(VIEW_STORAGE_KEY) as View | null;
  if (saved && VALID_VIEWS.includes(saved)) {
    return saved;
  }
  return "providers";
};

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [activeApp, setActiveApp] = useState<AppId>(getInitialApp);
  const sharedFeatureApp: AppId =
    activeApp === "claude-desktop" ? "claude" : activeApp;
  const [currentView, setCurrentView] = useState<View>(getInitialView);
  const [skillsDiscoverySource, setSkillsDiscoverySource] =
    useState<SkillsPageSource>("repos");
  const [settingsDefaultTab, setSettingsDefaultTab] = useState("general");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [mcpManagementBusy, setMcpManagementBusy] = useState(false);
  const [skillsManagementBusy, setSkillsManagementBusy] = useState(false);
  const [skillsNavigationBusy, setSkillsNavigationBusy] = useState(false);
  const [promptManagementBusy, setPromptManagementBusy] = useState(false);
  const [promptNavigationBusy, setPromptNavigationBusy] = useState(false);
  const [skillsCheckUpdatesState, setSkillsCheckUpdatesState] =
    useState<SkillsCheckUpdatesState>({
      isChecking: false,
      hasSkills: false,
    });

  // ===== 目标选择器（本机 / 远程服务器）=====
  const [servers, setServers] = useState<RemoteHost[]>([]);
  const [remoteTargetId, setRemoteTargetId] = useState<string>(
    () => localStorage.getItem("cc-switch-remote-target") ?? "",
  );
  const [remoteCurrentProviderId, setRemoteCurrentProviderId] = useState<
    string | null
  >(null);
  const [remoteInstalled, setRemoteInstalled] = useState<boolean | null>(null);
  const [localInstalled, setLocalInstalled] = useState<boolean | null>(null);
  // 目标细化到 Docker 容器：选中服务器后可再选容器，所有远程操作作用于容器内。
  const [containers, setContainers] = useState<string[]>([]);
  const [remoteContainerId, setRemoteContainerId] = useState<string>(
    () => localStorage.getItem("cc-switch-remote-container") ?? "",
  );
  // 主机在线状态（host_id → 是否在线）：目标选择器下拉打开时批量实时探测。
  // 不缓存：状态必须真实反映"此刻"（缓存会让用户看到假在线却连不进去）。
  const [hostsOnline, setHostsOnline] = useState<Record<string, boolean>>({});
  // 当前目标是否被探明离线（软信号：探活结果；重试可清除重新探测）
  const targetKnownOffline = remoteTargetId
    ? hostsOnline[remoteTargetId] === false
    : false;
  // 重试：清除当前目标的离线标记 → 查询重新启用 → 真正重新探测/连接
  const retryRemoteTarget = useCallback(() => {
    if (!remoteTargetId) return;
    setHostsOnline((prev) => {
      if (prev[remoteTargetId] !== false) return prev;
      const next = { ...prev };
      delete next[remoteTargetId];
      return next;
    });
  }, [remoteTargetId]);
  const probeHosts = useCallback(async () => {
    if (servers.length === 0) return;
    // 每次打开下拉都重新实时检测：先清空旧状态（全部转圈）
    setHostsOnline({});
    // 每台单独探测、就绪即更新：在线机器先返回先变绿，
    // 离线机器最后（5 秒超时）才变灰——不互相拖累（后端批量接口是等最慢的才一起返回）
    await Promise.allSettled(
      servers.map(async (s) => {
        try {
          const ok = await probeHostsOnline([s.id]);
          setHostsOnline((prev) => ({ ...prev, ...ok }));
        } catch {
          // 单台探测失败不影响其他台
        }
      }),
    );
  }, [servers]);
  // 设置开关：远端非 additive 面板是否每次自动读入当前 live 配置（default 卡）
  const [autoImportDefault, setAutoImportDefault] = useState<boolean>(() =>
    localStorage.getItem("cc-switch-remote-auto-import-default") !== "0",
  );

  // 开关切换后使远端面板查询失效（refetch 用新值），并持久化
  const handleAutoImportDefaultChange = useCallback((next: boolean) => {
    setAutoImportDefault(next);
    localStorage.setItem(
      "cc-switch-remote-auto-import-default",
      next ? "1" : "0",
    );
    queryClient.invalidateQueries({ queryKey: ["remoteProviders"] });
  }, [queryClient]);

  useEffect(() => {
    localStorage.setItem("cc-switch-remote-target", remoteTargetId);
  }, [remoteTargetId]);

  useEffect(() => {
    localStorage.setItem("cc-switch-remote-container", remoteContainerId);
  }, [remoteContainerId]);

  // 每次切换视图时刷新服务器列表（远程页面增删后回到主界面能同步）；
  // 若当前选中的目标已被删除，自动重置回「本机」。
  useEffect(() => {
    checkLocalCliInstalled(sharedFeatureApp)
      .then(setLocalInstalled)
      .catch(() => setLocalInstalled(null));
  }, [sharedFeatureApp]);

  useEffect(() => {
    listRemoteHosts()
      .then((list) => {
        setServers(list);
        setRemoteTargetId((prev) =>
          prev && !list.some((s) => s.id === prev) ? "" : prev,
        );
      })
      .catch(() => {});
    // 注：切回主界面时刷新远端当前供应商 + 安装状态的工作，由下方依赖
    // `[remoteTargetId, remoteContainerId]` 的 effect 统一负责（它拿到最新容器）。
    // 这里不重复刷新，避免两个 effect 用不同 container 并行覆盖 setRemoteInstalled。
  }, [currentView]);

  // 选中服务器时：读取远端当前生效的供应商（按 base_url 匹配本地供应商）
  // 并检测远端 Claude Code 安装状态（用于主面板横幅徽标）。
  useEffect(() => {
    if (!remoteTargetId) {
      setRemoteCurrentProviderId(null);
      setRemoteInstalled(null);
      setContainers([]);
      setRemoteContainerId("");
      return;
    }
    // 目标选择器已探明该主机离线：跳过连接型调用（不发起建连），直接置空
    if (targetKnownOffline) {
      setRemoteCurrentProviderId(null);
      setRemoteInstalled(null);
      setContainers([]);
      return;
    }
    let active = true;
    const container = remoteContainerId || undefined;
    getRemoteCurrentProvider(remoteTargetId, sharedFeatureApp, container)
      .then((id) => {
        if (active) setRemoteCurrentProviderId(id);
      })
      .catch(() => {
        if (active) setRemoteCurrentProviderId(null);
      });
    checkRemoteCliInstalled(remoteTargetId, sharedFeatureApp, container)
      .then((s) => {
        if (active) setRemoteInstalled(s);
      })
      .catch(() => {
        if (active) setRemoteInstalled(null);
      });
    return () => {
      active = false;
    };
  }, [
    remoteTargetId,
    remoteContainerId,
    currentView,
    sharedFeatureApp,
    targetKnownOffline,
  ]);

  // 容器列表只与主机相关（与 app/容器无关）：独立 effect，仅换主机时重拉，
  // 切 app / 切容器不白跑（D 修复）。
  useEffect(() => {
    if (!remoteTargetId || targetKnownOffline) {
      setContainers([]);
      setRemoteContainerId("");
      return;
    }
    let active = true;
    listDockerContainers(remoteTargetId)
      .then((list) => {
        if (active) {
          setContainers(list);
          // 若已选容器不在当前主机列表中，清空
          setRemoteContainerId((prev) =>
            prev && !list.includes(prev) ? "" : prev,
          );
        }
      })
      .catch(() => {
        if (active) setContainers([]);
      });
    return () => {
      active = false;
    };
  }, [remoteTargetId, targetKnownOffline]);

  const activeRemoteHost = servers.find((s) => s.id === remoteTargetId) ?? null;
  // 当前目标（本机/服务器）的 Claude Code 安装状态
  const currentInstalled = remoteTargetId ? remoteInstalled : localInstalled;

  // 刷新当前 app 的 CLI 安装状态：本机与当前远端目标共用同一策略。
  // 依赖必须含 remoteContainerId：否则切容器后 useCallback 缓存旧闭包，
  // 点刷新会用上一次的 container 检测，导致宿主机/容器状态串扰。
  const refreshInstallStatus = useCallback(() => {
    checkLocalCliInstalled(sharedFeatureApp)
      .then(setLocalInstalled)
      .catch(() => setLocalInstalled(null));
    if (remoteTargetId) {
      const container = remoteContainerId || undefined;
      checkRemoteCliInstalled(remoteTargetId, sharedFeatureApp, container)
        .then(setRemoteInstalled)
        .catch(() => setRemoteInstalled(null));
      getRemoteCurrentProvider(remoteTargetId, sharedFeatureApp, container)
        .then(setRemoteCurrentProviderId)
        .catch(() => setRemoteCurrentProviderId(null));
      listDockerContainers(remoteTargetId)
        .then(setContainers)
        .catch(() => setContainers([]));
    }
  }, [remoteTargetId, remoteContainerId, sharedFeatureApp]);

  // 窗口重新聚焦时自动刷新（如装完 Claude Code 切回应用即更新）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onFocusChanged(
          ({ payload: focused }) => {
            if (focused) refreshInstallStatus();
          },
        );
      } catch (e) {
        console.error("[App] Failed to listen window focus", e);
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [refreshInstallStatus]);

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, currentView);
  }, [currentView]);

  const { data: settingsData } = useSettingsQuery();
  const useAppWindowControls =
    isLinux() && (settingsData?.useAppWindowControls ?? false);
  const dragBarHeight = useAppWindowControls ? 32 : DEFAULT_DRAG_BAR_HEIGHT;
  const contentTopOffset = dragBarHeight + HEADER_HEIGHT;
  const visibleApps: VisibleApps = settingsData?.visibleApps ?? {
    claude: true,
    "claude-desktop": true,
    codex: true,
    gemini: true,
    grokbuild: true,
    opencode: true,
    openclaw: true,
    hermes: true,
  };

  const getFirstVisibleApp = (): AppId => {
    if (visibleApps.claude) return "claude";
    if (visibleApps["claude-desktop"]) return "claude-desktop";
    if (visibleApps.codex) return "codex";
    if (visibleApps.gemini) return "gemini";
    if (visibleApps.grokbuild) return "grokbuild";
    if (visibleApps.opencode) return "opencode";
    if (visibleApps.openclaw) return "openclaw";
    if (visibleApps.hermes) return "hermes";
    return "claude"; // fallback
  };

  useEffect(() => {
    if (!visibleApps[activeApp]) {
      setActiveApp(getFirstVisibleApp());
    }
  }, [visibleApps, activeApp]);

  // Fallback from sessions view when switching to an app without session support
  useEffect(() => {
    if (
      currentView === "sessions" &&
      sharedFeatureApp !== "claude" &&
      sharedFeatureApp !== "codex" &&
      sharedFeatureApp !== "grokbuild" &&
      sharedFeatureApp !== "opencode" &&
      sharedFeatureApp !== "openclaw" &&
      sharedFeatureApp !== "gemini" &&
      sharedFeatureApp !== "hermes"
    ) {
      setCurrentView("providers");
    }
  }, [sharedFeatureApp, currentView]);

  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [usageProvider, setUsageProvider] = useState<Provider | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    provider: Provider;
    action: "remove" | "delete";
  } | null>(null);
  const [envConflicts, setEnvConflicts] = useState<EnvConflict[]>([]);
  const [showEnvBanner, setShowEnvBanner] = useState(false);

  const effectiveEditingProvider = useLastValidValue(editingProvider);
  const effectiveUsageProvider = useLastValidValue(usageProvider);

  useUsageCacheBridge();

  const promptPanelRef = useRef<any>(null);
  const mcpPanelRef = useRef<any>(null);
  const skillsPageRef = useRef<any>(null);
  const unifiedSkillsPanelRef = useRef<any>(null);
  // 订阅未管理 Skill 的共享缓存（实际扫描由 UnifiedSkillsPanel 进入页面时触发）。
  // 这里 enabled 默认 false，仅用于「导入」按钮的绿点提示，不主动发起扫描。
  const { data: unmanagedSkills } = useScanUnmanagedSkills();
  const hasUnmanagedSkills = (unmanagedSkills?.length ?? 0) > 0;
  const addActionButtonClass =
    "bg-orange-500 hover:bg-orange-600 dark:bg-orange-500 dark:hover:bg-orange-600 text-white shadow-lg shadow-orange-500/30 dark:shadow-orange-500/40 rounded-full w-8 h-8";

  const {
    isRunning: isProxyRunning,
    takeoverStatus,
    status: proxyStatus,
  } = useProxyStatus();
  const isCurrentAppTakeoverActive = takeoverStatus?.[activeApp] || false;
  const activeProviderId = useMemo(() => {
    const target = proxyStatus?.active_targets?.find(
      (t) => t.app_type === activeApp,
    );
    return target?.provider_id;
  }, [proxyStatus?.active_targets, activeApp]);

  const { data, isLoading: localIsLoading, refetch } = useProvidersQuery(activeApp, {
    isProxyRunning,
  });
  // per-target 独立：远端目标下，供应商面板数据源是该目标机器自己的 SSOT
  // （本机 DB 不参与）；本机目标保持现有模型完全不变。
  const remoteProvidersQuery = useRemoteProvidersQuery(
    remoteTargetId || undefined,
    remoteContainerId || undefined,
    sharedFeatureApp,
    autoImportDefault,
    // 目标选择器已探明当前主机离线 → 不再发起连接（秒显示离线）
    targetKnownOffline || undefined,
  );
  const providers = useMemo(
    () =>
      remoteTargetId
        ? (remoteProvidersQuery.data?.providers ?? {})
        : (data?.providers ?? {}),
    [remoteTargetId, remoteProvidersQuery.data, data],
  );
  const isLoading = remoteTargetId
    ? remoteProvidersQuery.isLoading
    : localIsLoading;
  const currentProviderId = data?.currentProviderId ?? "";
  // 选中服务器时，当前供应商高亮取自该远端目标（SSOT current / 切换记录 / live 兜底）
  const effectiveCurrentProviderId = remoteTargetId
    ? (remoteProvidersQuery.data?.currentProviderId ??
      remoteCurrentProviderId ??
      "")
    : currentProviderId;
  const isOpenClawView =
    activeApp === "openclaw" &&
    (currentView === "providers" ||
      currentView === "workspace" ||
      currentView === "sessions" ||
      currentView === "openclawEnv" ||
      currentView === "openclawTools" ||
      currentView === "openclawAgents");
  const { data: openclawHealthWarnings = [] } =
    useOpenClawHealth(isOpenClawView);
  // 所有应用(含 openclaw)均支持 Skills 管理;openclaw 走独立按钮组,default 分支恒显示
  const hasSkillsSupport = true;
  const hasSessionSupport =
    sharedFeatureApp === "claude" ||
    sharedFeatureApp === "codex" ||
    sharedFeatureApp === "grokbuild" ||
    sharedFeatureApp === "opencode" ||
    sharedFeatureApp === "openclaw" ||
    sharedFeatureApp === "gemini" ||
    sharedFeatureApp === "hermes";

  const {
    addProvider,
    updateProvider,
    switchProvider,
    deleteProvider,
    saveUsageScript,
    setAsDefaultModel,
  } = useProviderActions(
    activeApp,
    isProxyRunning,
    isProxyRunning && isCurrentAppTakeoverActive,
  );

  // 远程切换 mutation：与本机 useSwitchProviderMutation 同构（onSuccess 回写高亮 +
  // invalidateQueries + 集中 toast；isPending 供按钮禁用防连点）。
  const remoteSwitchMutation = useSwitchRemoteProviderMutation(
    setRemoteCurrentProviderId,
  );

  // 供应商切换：选中服务器目标时走远端原子写回，否则走本地
  const handleProviderSwitch = async (provider: Provider) => {
    if (remoteTargetId) {
      // 一次 IPC：后端 EffectReport.currentProviderId 直接带回当前供应商 id，
      // 高亮/刷新/toast 都由 mutation onSuccess 完成
      await remoteSwitchMutation.mutateAsync({
        hostId: remoteTargetId,
        providerId: provider.id,
        app: sharedFeatureApp,
        container: remoteContainerId || undefined,
      });
      return;
    }
    await switchProvider(provider);
  };

  // 远端 OpenClaw「设为默认」：写该目标机器的 models.defaultModel（对齐本机 setAsDefaultModel）
  const handleRemoteSetAsDefault = useCallback(
    async (provider: Provider) => {
      const config = provider.settingsConfig as { models?: { id?: string }[] };
      const models = config?.models ?? [];
      if (models.length === 0) {
        toast.error(
          t("notifications.openclawNoModels", {
            defaultValue: "该供应商没有配置模型",
          }),
        );
        return;
      }
      const model = {
        primary: `${provider.id}/${models[0].id}`,
        fallbacks: models.slice(1).map((m) => `${provider.id}/${m.id}`),
      };
      try {
        await setRemoteOpenClawDefaultModel(
          remoteTargetId,
          remoteContainerId || undefined,
          model,
        );
        void remoteProvidersQuery.refetch();
        toast.success(
          t("notifications.openclawDefaultModelSet", {
            defaultValue: "已设为默认模型",
          }),
          { closeButton: true },
        );
      } catch (error) {
        toast.error(
          extractErrorMessage(error) ||
            t("notifications.openclawDefaultModelSetFailed", {
              defaultValue: "设置默认模型失败",
            }),
        );
      }
    },
    [remoteTargetId, remoteContainerId, remoteProvidersQuery, t],
  );

  const disableOmoMutation = useDisableCurrentOmo();
  const handleDisableOmo = () => {
    disableOmoMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("omo.disabled", { defaultValue: "OMO 已停用" }));
      },
      onError: (error: Error) => {
        toast.error(
          t("omo.disableFailed", {
            defaultValue: "停用 OMO 失败: {{error}}",
            error: extractErrorMessage(error),
          }),
        );
      },
    });
  };

  const disableOmoSlimMutation = useDisableCurrentOmoSlim();
  const handleDisableOmoSlim = () => {
    disableOmoSlimMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("omo.disabled", { defaultValue: "OMO 已停用" }));
      },
      onError: (error: Error) => {
        toast.error(
          t("omo.disableFailed", {
            defaultValue: "停用 OMO 失败: {{error}}",
            error: extractErrorMessage(error),
          }),
        );
      },
    });
  };

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;

    const setupListener = async () => {
      try {
        const off = await providersApi.onSwitched(
          async (event: ProviderSwitchEvent) => {
            if (event.appType === activeApp) {
              await refetch();
            }
          },
        );
        if (!active) {
          off();
          return;
        }
        unsubscribe = off;
      } catch (error) {
        console.error("[App] Failed to subscribe provider switch event", error);
      }
    };

    void setupListener();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [activeApp, refetch]);

  useTauriEvent("universal-provider-synced", async () => {
    await queryClient.invalidateQueries({ queryKey: ["providers"] });
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to update tray menu", error);
    }
  });

  // 应用项目后刷新相关缓存（providers 由既有 provider-switched 监听承接；
  // proxy 状态由后端直接改 DB，不走 mutation，必须显式刷新）
  useTauriEvent("profile-applied", async () => {
    await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    await queryClient.invalidateQueries({ queryKey: ["mcp", "all"] });
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    await queryClient.invalidateQueries({
      queryKey: proxyKeys.takeoverStatus,
    });
    await queryClient.invalidateQueries({ queryKey: proxyKeys.status });
    await queryClient.invalidateQueries({
      queryKey: ["providers", "claude-desktop"],
    });
  });

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "webdav-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.webdavSync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "s3-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.s3Sync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<{ appType: string; providerName: string }>(
    "proxy-official-warning",
    (payload) => {
      toast.warning(
        t("notifications.proxyOfficialWarning", {
          name: payload.providerName,
          defaultValue: `当前供应商 ${payload.providerName} 是官方供应商，建议切换到第三方供应商后再使用代理接管`,
        }),
        { duration: 8000 },
      );
    },
  );

  useEffect(() => {
    let active = true;
    let unlistenResize: (() => void) | undefined;

    const setupWindowStateSync = async () => {
      try {
        const currentWindow = getCurrentWindow();
        const syncWindowMaximizedState = async () => {
          const maximized = await currentWindow.isMaximized();
          if (active) {
            setIsWindowMaximized(maximized);
          }
        };

        await syncWindowMaximizedState();
        unlistenResize = await currentWindow.onResized(() => {
          void syncWindowMaximizedState();
        });
      } catch (error) {
        console.error("[App] Failed to sync window maximized state", error);
      }
    };

    void setupWindowStateSync();
    return () => {
      active = false;
      unlistenResize?.();
    };
  }, []);

  useEffect(() => {
    // settingsData 未加载时跳过，避免用 fallback false 覆盖 Rust 侧已设好的装饰状态
    if (!settingsData) return;

    const syncWindowDecorations = async () => {
      try {
        await getCurrentWindow().setDecorations(!useAppWindowControls);
      } catch (error) {
        console.error("[App] Failed to update window decorations", error);
      }
    };

    void syncWindowDecorations();
  }, [useAppWindowControls, settingsData]);

  useEffect(() => {
    const checkEnvOnStartup = async () => {
      try {
        const allConflicts = await checkAllEnvConflicts();
        const flatConflicts = Object.values(allConflicts).flat();

        if (flatConflicts.length > 0) {
          setEnvConflicts(flatConflicts);
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on startup:",
          error,
        );
      }
    };

    checkEnvOnStartup();
  }, []);

  useEffect(() => {
    const checkMigration = async () => {
      try {
        const migrated = await invoke<boolean>("get_migration_result");
        if (migrated) {
          toast.success(
            t("migration.success", { defaultValue: "配置迁移成功" }),
            { closeButton: true },
          );
        }
      } catch (error) {
        console.error("[App] Failed to check migration result:", error);
      }
    };

    checkMigration();
  }, [t]);

  useEffect(() => {
    const checkSkillsMigration = async () => {
      try {
        const result = await invoke<{ count: number; error?: string } | null>(
          "get_skills_migration_result",
        );
        if (result?.error) {
          toast.error(t("migration.skillsFailed"), {
            description: t("migration.skillsFailedDescription"),
            closeButton: true,
          });
          console.error("[App] Skills SSOT migration failed:", result.error);
          return;
        }
        if (result && result.count > 0) {
          toast.success(t("migration.skillsSuccess", { count: result.count }), {
            closeButton: true,
          });
          await queryClient.invalidateQueries({ queryKey: ["skills"] });
        }
      } catch (error) {
        console.error("[App] Failed to check skills migration result:", error);
      }
    };

    checkSkillsMigration();
  }, [t, queryClient]);

  useEffect(() => {
    const checkEnvOnSwitch = async () => {
      try {
        const conflicts = await checkEnvConflicts(activeApp);

        if (conflicts.length > 0) {
          setEnvConflicts((prev) => {
            const existingKeys = new Set(
              prev.map((c) => `${c.varName}:${c.sourcePath}`),
            );
            const newConflicts = conflicts.filter(
              (c) => !existingKeys.has(`${c.varName}:${c.sourcePath}`),
            );
            return [...prev, ...newConflicts];
          });
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on app switch:",
          error,
        );
      }
    };

    checkEnvOnSwitch();
  }, [activeApp]);

  const currentViewRef = useRef(currentView);
  const managementBusy =
    mcpManagementBusy || skillsNavigationBusy || promptNavigationBusy;
  const managementBusyRef = useRef(false);
  managementBusyRef.current = managementBusy;

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        if (managementBusyRef.current) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        setCurrentView("settings");
        return;
      }

      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (document.body.style.overflow === "hidden") return;

      const view = currentViewRef.current;
      if (view === "providers") return;
      if (managementBusyRef.current) return;

      if (isTextEditableTarget(event.target)) return;

      event.preventDefault();
      setCurrentView(view === "skillsDiscovery" ? "skills" : "providers");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // 悬浮球右键菜单「设置」：打开主窗口后切到设置页（与 Ctrl+, 同一入口）
  useTauriEvent("open-settings", () => {
    if (managementBusyRef.current) return;
    setCurrentView("settings");
  });

  const [launchDashboardOpen, setLaunchDashboardOpen] = useState(false);
  const openHermesWebUI = useOpenHermesWebUI(() =>
    setLaunchDashboardOpen(true),
  );

  const handleOpenWebsite = async (url: string) => {
    try {
      await settingsApi.openExternal(url);
    } catch (error) {
      const detail =
        extractErrorMessage(error) ||
        t("notifications.openLinkFailed", {
          defaultValue: "链接打开失败",
        });
      toast.error(detail);
    }
  };

  // 服务端返回权威最新视图 → 直接写入缓存（免第二次 SSH refetch；
  // 语义与本机 invalidate 一致：操作成功后缓存 = 最新状态）
  const setRemoteProvidersCache = (view: RemoteProvidersView) => {
    queryClient.setQueryData<RemoteProvidersView>(
      [
        "remoteProviders",
        remoteTargetId,
        remoteContainerId || "__host__",
        sharedFeatureApp,
      ],
      view,
    );
  };

  // 远端目标下添加供应商：直接写该目标自己的 SSOT（本机 DB 不参与）。
  // id 生成对齐本机 useAddProviderMutation：additive 用 providerKey，其余 UUID。
  const handleAddRemoteProvider = async (
    provider: Omit<Provider, "id"> & { providerKey?: string },
  ) => {
    try {
      let id: string;
      if (
        sharedFeatureApp === "opencode" ||
        sharedFeatureApp === "openclaw" ||
        sharedFeatureApp === "hermes"
      ) {
        if (!provider.providerKey) {
          throw new Error(`Provider key is required for ${sharedFeatureApp}`);
        }
        id = provider.providerKey;
      } else {
        id = crypto.randomUUID();
      }
      const newProvider: Provider = {
        ...(provider as Omit<Provider, "id">),
        id,
        createdAt: Date.now(),
      } as Provider;
      const view = await addRemoteProvider(
        remoteTargetId!,
        sharedFeatureApp,
        newProvider,
        true,
        remoteContainerId || undefined,
      );
      setRemoteProvidersCache(view);
      toast.success(
        t("remote.addDone", {
          defaultValue: "已添加到远端 {{target}}",
          target: activeRemoteHost?.name ?? remoteTargetId,
        }),
        { closeButton: true },
      );
    } catch (error) {
      console.error("[App] Failed to add remote provider:", error);
      toast.error(extractErrorMessage(error), { closeButton: true });
      throw error;
    }
  };

  const handleEditProvider = async ({
    provider,
    originalId,
  }: {
    provider: Provider;
    originalId?: string;
  }) => {
    if (remoteTargetId) {
      // per-target 独立：远端目标的供应商编辑直接写该目标自己的 SSOT
      // （后端按「是否在生效位置」决定是否重写远端 live，对齐本机 update 语义）；
      // 本机 DB 不参与。
      try {
        const view = await updateRemoteProvider(
          remoteTargetId,
          sharedFeatureApp,
          provider,
          originalId,
          remoteContainerId || undefined,
        );
        setRemoteProvidersCache(view);
        toast.success(
          t("remote.editSynced", {
            defaultValue: "已同步更新后的配置到远端 {{target}}",
            target: activeRemoteHost?.name ?? remoteTargetId,
          }),
          { closeButton: true },
        );
      } catch (error) {
        console.error("Failed to update remote provider:", error);
        toast.error(
          t("remote.editSyncError", {
            defaultValue: "供应商更新失败",
          }),
          { description: extractErrorMessage(error) },
        );
      }
      setEditingProvider(null);
      return;
    }

    await updateProvider(provider, originalId);
    setEditingProvider(null);
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    const { provider, action } = confirmAction;

    if (remoteTargetId) {
      // 远程目标（per-target 独立）：remove 走远端 live 移除（SSOT 标记同步）；
      // delete 删该远端目标自己的 SSOT（additive 且已写入 live 时同时移除 live）。
      // 本机 DB 不参与。
      try {
        if (action === "remove") {
          const view = await removeRemoteProviderFromLive(
            remoteTargetId,
            sharedFeatureApp,
            provider.id,
            remoteContainerId || undefined,
          );
          // 后端带回最新视图，直接写入缓存（按钮「移除」→「添加」立即翻转）
          setRemoteProvidersCache(view);
          toast.success(
            t("notifications.removeFromConfigSuccess", {
              defaultValue: "已从远端配置移除",
            }),
            { closeButton: true },
          );
        } else {
          const view = await deleteRemoteProvider(
            remoteTargetId,
            sharedFeatureApp,
            provider.id,
            remoteContainerId || undefined,
          );
          setRemoteProvidersCache(view);
          toast.success(
            t("notifications.providerDeleted", {
              defaultValue: "供应商删除成功",
            }),
            { closeButton: true },
          );
        }
      } catch (error) {
        console.error("Failed to handle remote provider action:", error);
        toast.error(extractErrorMessage(error), { closeButton: true });
      }
      setConfirmAction(null);
      return;
    }

    if (action === "remove") {
      // Remove from live config only (for additive mode apps like OpenCode/OpenClaw)
      // Does NOT delete from database - provider remains in the list
      await providersApi.removeFromLiveConfig(provider.id, activeApp);
      // Invalidate queries to refresh the isInConfig state
      if (activeApp === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["opencodeLiveProviderIds"],
        });
      } else if (activeApp === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.liveProviderIds,
        });
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      } else if (activeApp === "hermes") {
        await queryClient.invalidateQueries({
          queryKey: hermesKeys.liveProviderIds,
        });
      }
      toast.success(
        t("notifications.removeFromConfigSuccess", {
          defaultValue: "已从配置移除",
        }),
        { closeButton: true },
      );
    } else {
      await deleteProvider(provider.id);
    }
    setConfirmAction(null);
  };

  const generateUniqueProviderCopyKey = (
    originalKey: string,
    existingKeys: string[],
  ): string => {
    const baseKey = `${originalKey}-copy`;

    if (!existingKeys.includes(baseKey)) {
      return baseKey;
    }

    let counter = 2;
    while (existingKeys.includes(`${baseKey}-${counter}`)) {
      counter++;
    }
    return `${baseKey}-${counter}`;
  };

  const handleDuplicateProvider = async (provider: Provider) => {
    const newSortIndex =
      provider.sortIndex !== undefined ? provider.sortIndex + 1 : undefined;

    // 远端目标：复制到该目标自己的 SSOT（本机 DB 不参与）
    if (remoteTargetId) {
      const copyKey = generateUniqueProviderCopyKey(
        provider.id,
        Object.keys(providers),
      );
      const duplicated: Provider = {
        ...provider,
        id: copyKey,
        name: `${provider.name} copy`,
        sortIndex: newSortIndex,
        createdAt: Date.now(),
      } as Provider;
      try {
        const view = await addRemoteProvider(
          remoteTargetId,
          sharedFeatureApp,
          duplicated,
          true,
          remoteContainerId || undefined,
        );
        setRemoteProvidersCache(view);
        toast.success(
          t("notifications.providerDuplicated", {
            defaultValue: "供应商复制成功",
          }),
          { closeButton: true },
        );
      } catch (error) {
        console.error("[App] Failed to duplicate remote provider:", error);
        toast.error(extractErrorMessage(error), { closeButton: true });
      }
      return;
    }

    const duplicatedProvider: Omit<Provider, "id" | "createdAt"> & {
      providerKey?: string;
      addToLive?: boolean;
    } = {
      name: `${provider.name} copy`,
      settingsConfig: deepClone(provider.settingsConfig),
      websiteUrl: provider.websiteUrl,
      category: provider.category,
      sortIndex: newSortIndex, // 复制原 sortIndex + 1
      meta: provider.meta ? deepClone(provider.meta) : undefined,
      icon: provider.icon,
      iconColor: provider.iconColor,
    };

    if (
      activeApp === "opencode" ||
      activeApp === "openclaw" ||
      activeApp === "hermes"
    ) {
      let liveProviderIds: string[] = [];
      try {
        liveProviderIds =
          activeApp === "opencode"
            ? await queryClient.ensureQueryData({
                queryKey: ["opencodeLiveProviderIds"],
                queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
              })
            : activeApp === "openclaw"
              ? await queryClient.ensureQueryData({
                  queryKey: openclawKeys.liveProviderIds,
                  queryFn: () => providersApi.getOpenClawLiveProviderIds(),
                })
              : await queryClient.ensureQueryData({
                  queryKey: hermesKeys.liveProviderIds,
                  queryFn: () => providersApi.getHermesLiveProviderIds(),
                });
      } catch (error) {
        console.error(
          "[App] Failed to load live provider IDs for duplication",
          error,
        );
        const errorMessage = extractErrorMessage(error);
        toast.error(
          t("provider.duplicateLiveIdsLoadFailed", {
            defaultValue: "读取配置中的供应商标识失败，请先修复配置后再试",
          }) + (errorMessage ? `: ${errorMessage}` : ""),
        );
        return;
      }
      const existingKeys = Array.from(
        new Set([...Object.keys(providers), ...liveProviderIds]),
      );
      duplicatedProvider.providerKey = generateUniqueProviderCopyKey(
        provider.id,
        existingKeys,
      );
      duplicatedProvider.addToLive = false;
    }

    if (provider.sortIndex !== undefined) {
      const updates = Object.values(providers)
        .filter(
          (p) =>
            p.sortIndex !== undefined &&
            p.sortIndex >= newSortIndex! &&
            p.id !== provider.id,
        )
        .map((p) => ({
          id: p.id,
          sortIndex: p.sortIndex! + 1,
        }));

      if (updates.length > 0) {
        try {
          await providersApi.updateSortOrder(updates, activeApp);
        } catch (error) {
          console.error("[App] Failed to update sort order", error);
          toast.error(
            t("provider.sortUpdateFailed", {
              defaultValue: "排序更新失败",
            }),
          );
          return; // 如果排序更新失败，不继续添加
        }
      }
    }

    await addProvider(duplicatedProvider);
  };

  const handleOpenTerminal = async (provider: Provider) => {
    try {
      const selectedDir = await settingsApi.pickDirectory();
      if (!selectedDir) {
        return;
      }

      await providersApi.openTerminal(provider.id, activeApp, {
        cwd: selectedDir,
      });
      toast.success(
        t("provider.terminalOpened", {
          defaultValue: "终端已打开",
        }),
      );
    } catch (error) {
      console.error("[App] Failed to open terminal", error);
      const errorMessage = extractErrorMessage(error);
      toast.error(
        t("provider.terminalOpenFailed", {
          defaultValue: "打开终端失败",
        }) + (errorMessage ? `: ${errorMessage}` : ""),
      );
    }
  };

  const handleImportSuccess = async () => {
    try {
      await queryClient.invalidateQueries({
        queryKey: ["providers"],
        refetchType: "all",
      });
      await queryClient.refetchQueries({
        queryKey: ["providers"],
        type: "all",
      });
    } catch (error) {
      console.error("[App] Failed to refresh providers after import", error);
      await refetch();
    }
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to refresh tray menu", error);
    }
  };

  const notifyWindowControlError = (error: unknown) => {
    toast.error(
      t("notifications.windowControlFailed", {
        defaultValue: "窗口控制失败：{{error}}",
        error: extractErrorMessage(error),
      }),
    );
  };

  const handleWindowMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (error) {
      console.error("[App] Failed to minimize window", error);
      notifyWindowControlError(error);
    }
  };

  const handleWindowToggleMaximize = async () => {
    try {
      const currentWindow = getCurrentWindow();
      await currentWindow.toggleMaximize();
      setIsWindowMaximized(await currentWindow.isMaximized());
    } catch (error) {
      console.error("[App] Failed to toggle maximize", error);
      notifyWindowControlError(error);
    }
  };

  const handleWindowClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (error) {
      console.error("[App] Failed to close window", error);
      notifyWindowControlError(error);
    }
  };

  const handleOpenSkillsDiscovery = () => {
    setSkillsDiscoverySource("repos");
    setCurrentView("skillsDiscovery");
  };

  const renderContent = () => {
    const content = (() => {
      switch (currentView) {
        case "settings":
          return (
            <SettingsPage
              open={true}
              onOpenChange={() => setCurrentView("providers")}
              onImportSuccess={handleImportSuccess}
              defaultTab={settingsDefaultTab}
              autoImportDefault={autoImportDefault}
              onAutoImportDefaultChange={handleAutoImportDefaultChange}
            />
          );
        case "prompts":
          return (
            <PromptPanel
              ref={promptPanelRef}
              open={true}
              onOpenChange={() => setCurrentView("providers")}
              appId={sharedFeatureApp}
              remoteTargetId={remoteTargetId || undefined}
              remoteContainerId={remoteContainerId || undefined}
              onInteractionBlockedChange={setPromptManagementBusy}
              onNavigationBlockedChange={setPromptNavigationBusy}
            />
          );
        case "hermesMemory":
          return <HermesMemoryPanel />;
        case "skills":
          return (
            <UnifiedSkillsPanel
              ref={unifiedSkillsPanelRef}
              onOpenDiscovery={handleOpenSkillsDiscovery}
              currentApp={sharedFeatureApp}
              remoteTargetId={remoteTargetId || undefined}
              remoteContainerId={remoteContainerId || undefined}
              onInteractionBlockedChange={setSkillsManagementBusy}
              onNavigationBlockedChange={setSkillsNavigationBusy}
              onCheckUpdatesStateChange={setSkillsCheckUpdatesState}
            />
          );
        case "skillsDiscovery":
          return (
            <SkillsPage
              ref={skillsPageRef}
              initialApp={sharedFeatureApp}
              onSourceChange={setSkillsDiscoverySource}
              remoteTargetId={remoteTargetId || undefined}
              remoteContainerId={remoteContainerId || undefined}
            />
          );
        case "mcp":
          return (
            <UnifiedMcpPanel
              ref={mcpPanelRef}
              onOpenChange={() => setCurrentView("providers")}
              remoteTargetId={remoteTargetId || undefined}
              remoteContainerId={remoteContainerId || undefined}
              onInteractionBlockedChange={setMcpManagementBusy}
            />
          );
        case "agents":
          return (
            <AgentsPanel onOpenChange={() => setCurrentView("providers")} />
          );
        case "universal":
          return (
            <div className="px-6 pt-4">
              <UniversalProviderPanel />
            </div>
          );
        case "remote":
          return <RemoteHostsPanel app={sharedFeatureApp} />;

        case "sessions":
          return (
            <SessionManagerPage
              key={`${sharedFeatureApp}-${remoteTargetId}-${remoteContainerId}`}
              appId={sharedFeatureApp}
              remoteTargetId={remoteTargetId}
              remoteContainerId={remoteContainerId || undefined}
            />
          );
        case "workspace":
          return <WorkspaceFilesPanel />;
        case "openclawEnv":
          return <EnvPanel />;
        case "openclawTools":
          return <ToolsPanel />;
        case "openclawAgents":
          return <AgentsDefaultsPanel />;
        default:
          return (
            <div className="px-6 flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto overflow-x-hidden pb-12 px-1">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeApp}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="space-y-4"
                  >
                    <ProviderList
                      providers={providers}
                      currentProviderId={effectiveCurrentProviderId}
                      appId={activeApp}
                      isLoading={isLoading}
                      isProxyRunning={isProxyRunning}
                      isProxyTakeover={
                        isProxyRunning && isCurrentAppTakeoverActive
                      }
                      isSwitching={
                        remoteTargetId
                          ? remoteSwitchMutation.isPending
                          : undefined
                      }
                      remoteTargetId={remoteTargetId}
                      remoteContainerId={remoteContainerId}
                      remoteLiveIds={
                        remoteTargetId
                          ? remoteProvidersQuery.data?.liveIds
                          : undefined
                      }
                      remoteLoadingLabel={
                        remoteTargetId ? (
                          <>
                            {t("remote.readingConfigPrefix", {
                              defaultValue: "正在读取 ",
                            })}
                            <span className="font-medium text-primary">
                              {t(`apps.${sharedFeatureApp}`)}
                            </span>
                            {t("remote.readingConfigSuffix", {
                              defaultValue: " 配置…",
                            })}
                          </>
                        ) : undefined
                      }
                      remoteError={
                        remoteTargetId
                          ? targetKnownOffline
                            ? t("remote.hostOffline", {
                                defaultValue:
                                  "主机当前离线（探活未通过），点重试可重新探测",
                              })
                            : remoteProvidersQuery.error
                              ? extractErrorMessage(remoteProvidersQuery.error)
                              : undefined
                          : undefined
                      }
                      onRetryRemote={
                        remoteTargetId
                          ? () => {
                              // 清除离线标记 → 查询重新启用 → 真正重新探测/连接
                              retryRemoteTarget();
                              void remoteProvidersQuery.refetch();
                            }
                          : undefined
                      }
                      remoteRefreshing={
                        remoteTargetId
                          ? remoteProvidersQuery.isFetching &&
                            !remoteProvidersQuery.isLoading
                          : false
                      }
                      activeProviderId={activeProviderId}
                      onSwitch={handleProviderSwitch}
                      onEdit={(provider) => {
                        setEditingProvider(provider);
                      }}
                      onDelete={(provider) =>
                        setConfirmAction({ provider, action: "delete" })
                      }
                      onRemoveFromConfig={
                        activeApp === "opencode" ||
                        activeApp === "openclaw" ||
                        activeApp === "hermes"
                          ? (provider) =>
                              setConfirmAction({ provider, action: "remove" })
                          : undefined
                      }
                      onDisableOmo={
                        activeApp === "opencode" ? handleDisableOmo : undefined
                      }
                      onDisableOmoSlim={
                        activeApp === "opencode"
                          ? handleDisableOmoSlim
                          : undefined
                      }
                      onDuplicate={handleDuplicateProvider}
                      onConfigureUsage={setUsageProvider}
                      onOpenWebsite={handleOpenWebsite}
                      onOpenTerminal={
                        activeApp === "claude" ? handleOpenTerminal : undefined
                      }
                      onCreate={() => setIsAddOpen(true)}
                      onSetAsDefault={
                        remoteTargetId
                          ? activeApp === "hermes"
                            ? handleProviderSwitch
                            : activeApp === "openclaw"
                              ? handleRemoteSetAsDefault
                              : undefined
                          : activeApp === "openclaw"
                            ? setAsDefaultModel
                            : activeApp === "hermes"
                              ? switchProvider
                              : undefined
                      }
                    />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          );
      }
    })();

    return (
      <AnimatePresence mode="wait">
        <motion.div
          key={currentView}
          className="flex-1 min-h-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    );
  };

  return (
    <div
      className="flex flex-col h-screen overflow-hidden bg-background text-foreground selection:bg-primary/30 pb-4"
      style={{ overflowX: "hidden", paddingTop: contentTopOffset }}
    >
      {(dragBarHeight > 0 || useAppWindowControls) && (
        <div
          className="fixed top-0 left-0 right-0 z-[70] flex items-center justify-end px-2"
          data-tauri-drag-region
          style={{ WebkitAppRegion: "drag", height: dragBarHeight } as any}
        >
          {useAppWindowControls && (
            <div
              className="flex items-center gap-1"
              style={{ WebkitAppRegion: "no-drag" } as any}
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowMinimize()}
                title={t("header.windowMinimize")}
                className="h-7 w-7"
              >
                <Minus className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowToggleMaximize()}
                title={
                  isWindowMaximized
                    ? t("header.windowRestore")
                    : t("header.windowMaximize")
                }
                className="h-7 w-7"
              >
                {isWindowMaximized ? (
                  <Minimize2 className="w-4 h-4" />
                ) : (
                  <Maximize2 className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowClose()}
                title={t("header.windowClose")}
                className="h-7 w-7 hover:bg-red-500/15 hover:text-red-500"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      )}
      {showEnvBanner && envConflicts.length > 0 && (
        <EnvWarningBanner
          conflicts={envConflicts}
          onDismiss={() => {
            setShowEnvBanner(false);
            sessionStorage.setItem("env_banner_dismissed", "true");
          }}
          onDeleted={async () => {
            try {
              const allConflicts = await checkAllEnvConflicts();
              const flatConflicts = Object.values(allConflicts).flat();
              setEnvConflicts(flatConflicts);
              if (flatConflicts.length === 0) {
                setShowEnvBanner(false);
              }
            } catch (error) {
              console.error(
                "[App] Failed to re-check conflicts after deletion:",
                error,
              );
            }
          }}
        />
      )}

      <header
        className="fixed z-50 w-full transition-all duration-300 bg-background/80 backdrop-blur-md"
        {...DRAG_REGION_ATTR}
        style={
          {
            ...DRAG_REGION_STYLE,
            top: dragBarHeight,
            height: HEADER_HEIGHT,
          } as any
        }
      >
        <div
          className="flex h-full items-center justify-between gap-2 px-6"
          {...DRAG_REGION_ATTR}
          style={{ ...DRAG_REGION_STYLE } as any}
        >
          <div
            className="flex items-center gap-1"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            {currentView !== "providers" ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={managementBusy}
                  onClick={() =>
                    setCurrentView(
                      currentView === "skillsDiscovery"
                        ? "skills"
                        : "providers",
                    )
                  }
                  className={cn(
                    "mr-2 rounded-lg",
                    managementBusy && "disabled:opacity-100",
                  )}
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <h1 className="text-lg font-semibold">
                  {currentView === "settings" && t("settings.title")}
                  {currentView === "prompts" &&
                    t("prompts.title", {
                      appName: t(`apps.${sharedFeatureApp}`),
                    })}
                  {currentView === "skills" && t("skills.title")}
                  {currentView === "skillsDiscovery" && t("skills.title")}
                  {currentView === "mcp" && t("mcp.unifiedPanel.title")}
                  {currentView === "agents" && t("agents.title")}
                  {currentView === "universal" &&
                    t("universalProvider.title", {
                      defaultValue: "统一供应商",
                    })}
                  {currentView === "sessions" && t("sessionManager.title")}
                  {currentView === "workspace" && t("workspace.title")}
                  {currentView === "remote" &&
                    t("remote.title", { defaultValue: "远程主机" })}
                  {currentView === "openclawEnv" && t("openclaw.env.title")}
                  {currentView === "openclawTools" && t("openclaw.tools.title")}
                  {currentView === "openclawAgents" &&
                    t("openclaw.agents.title")}
                  {currentView === "hermesMemory" && t("hermes.memory.title")}
                </h1>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="relative inline-flex items-center">
                  <a
                    href="https://ccswitch.io"
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      "text-xl font-semibold transition-colors",
                      isProxyRunning && isCurrentAppTakeoverActive
                        ? "text-emerald-500 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
                        : "text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300",
                    )}
                  >
                    CC Switch
                  </a>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSettingsDefaultTab("general");
                    setCurrentView("settings");
                  }}
                  title={t("common.settings")}
                  className="hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <Settings className="w-4 h-4" />
                </Button>
                <UpdateBadge
                  onClick={() => {
                    setSettingsDefaultTab("about");
                    setCurrentView("settings");
                  }}
                />
                {isCurrentAppTakeoverActive && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setSettingsDefaultTab("usage");
                      setCurrentView("settings");
                    }}
                    title={t("usage.title", {
                      defaultValue: "使用统计",
                    })}
                    className="hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <BarChart2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-1 min-w-0 items-center justify-end gap-1.5">
            {currentView === "providers" &&
              activeApp !== "opencode" &&
              activeApp !== "openclaw" &&
              activeApp !== "hermes" && (
                <div
                  className="flex shrink-0 items-center gap-1.5"
                  style={{ WebkitAppRegion: "no-drag" } as any}
                >
                  {activeApp === "claude-desktop" ? (
                    <ClaudeDesktopRouteToggle />
                  ) : (
                    settingsData?.enableLocalProxy && (
                      <ProxyToggle activeApp={activeApp} />
                    )
                  )}
                  {activeApp !== "claude-desktop" &&
                    settingsData?.enableFailoverToggle && (
                      <FailoverToggle activeApp={activeApp} />
                    )}
                </div>
              )}
            {currentView === "providers" &&
              (settingsData?.showProfileSwitcher ?? true) && (
                <div
                  className="flex shrink-0 items-center"
                  style={{ WebkitAppRegion: "no-drag" } as any}
                >
                  <ProfileSwitcher activeApp={activeApp} />
                </div>
              )}
            {/* 弹性中段：空间不足时由 AppSwitcher 自行收纳溢出应用；
                justify-end + overflow-hidden 只裁剪 resize 瞬间的过渡帧 */}
            <div className="flex flex-1 min-w-0 items-center justify-end overflow-hidden py-4">
              {currentView === "providers" && (
                <AppSwitcher
                  activeApp={activeApp}
                  onSwitch={setActiveApp}
                  visibleApps={visibleApps}
                />
              )}
            </div>
            {/* 固定右端：主操作（添加供应商等）shrink-0，任何配置下不被挤出 */}
            <div className="flex shrink-0 items-center py-4">
              <div
                className="flex shrink-0 items-center gap-1.5"
                style={{ WebkitAppRegion: "no-drag" } as any}
              >
                {currentView === "prompts" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={promptManagementBusy}
                    onClick={() => promptPanelRef.current?.openAdd()}
                    className="hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    {t("prompts.add")}
                  </Button>
                )}
                {currentView === "mcp" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={mcpManagementBusy}
                      onClick={() => mcpPanelRef.current?.openImport()}
                      className="hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      {t("mcp.importExisting")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={mcpManagementBusy}
                      onClick={() => mcpPanelRef.current?.openAdd()}
                      className="hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      {t("mcp.addMcp")}
                    </Button>
                  </>
                )}
                {currentView === "skills" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={
                        skillsManagementBusy ||
                        skillsCheckUpdatesState.isChecking ||
                        !skillsCheckUpdatesState.hasSkills
                      }
                      onClick={() =>
                        unifiedSkillsPanelRef.current?.checkUpdates()
                      }
                      className={cn(
                        "hover:bg-black/5 dark:hover:bg-white/5",
                        skillsManagementBusy && "disabled:opacity-100",
                      )}
                    >
                      {skillsCheckUpdatesState.isChecking ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4 mr-2" />
                      )}
                      {skillsCheckUpdatesState.isChecking
                        ? t("skills.checkingUpdates")
                        : t("skills.checkUpdates")}
                    </Button>
                    {!remoteTargetId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          unifiedSkillsPanelRef.current?.openRestoreFromBackup()
                        }
                        className="hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        <History className="w-4 h-4 mr-2" />
                        {t("skills.restoreFromBackup.button")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={skillsManagementBusy}
                      onClick={() =>
                        unifiedSkillsPanelRef.current?.openInstallFromZip()
                      }
                      className="hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5"
                    >
                      <FolderArchive className="w-4 h-4 mr-2" />
                      {t("skills.installFromZip.button")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={skillsManagementBusy}
                      onClick={() =>
                        unifiedSkillsPanelRef.current?.openImport()
                      }
                      className="relative hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5"
                      title={
                        hasUnmanagedSkills
                          ? t("skills.unmanagedAvailable")
                          : undefined
                      }
                    >
                      <Download className="w-4 h-4 mr-2" />
                      {t("skills.import")}
                      {hasUnmanagedSkills && (
                        <span
                          className="absolute top-1 right-1 h-2 w-2 rounded-full bg-green-500"
                          aria-hidden="true"
                        />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={skillsManagementBusy}
                      onClick={() =>
                        unifiedSkillsPanelRef.current?.openDiscovery()
                      }
                      className="hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5"
                    >
                      <Search className="w-4 h-4 mr-2" />
                      {t("skills.discover")}
                    </Button>
                  </>
                )}
                {currentView === "skillsDiscovery" && (
                  <>
                    {getSkillsPageHeaderActions(skillsDiscoverySource).map(
                      ({ key, labelKey, Icon, execute }) => (
                        <Button
                          key={key}
                          variant="ghost"
                          size="sm"
                          onClick={() => execute(skillsPageRef.current)}
                          className="hover:bg-black/5 dark:hover:bg-white/5"
                        >
                          <Icon className="w-4 h-4 mr-2" />
                          {t(labelKey)}
                        </Button>
                      ),
                    )}
                  </>
                )}
                {currentView === "providers" && (
                  <>
                    <div className="flex items-center gap-1 p-1 bg-muted rounded-xl">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={
                            activeApp === "openclaw"
                              ? "openclaw"
                              : activeApp === "hermes"
                                ? "hermes"
                                : activeApp === "grokbuild"
                                  ? "grokbuild"
                                  : "default"
                          }
                          className="flex items-center gap-1"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          {activeApp === "hermes" ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("skills")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("skills.manage")}
                              >
                                <Wrench className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("hermesMemory")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("hermes.memory.title")}
                              >
                                <Brain className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void openHermesWebUI()}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("hermes.webui.open")}
                              >
                                <LayoutDashboard className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("mcp")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("mcp.title")}
                              >
                                <McpIcon size={16} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("remote")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("remote.title", {
                                  defaultValue: "远程主机",
                                })}
                              >
                                <Server className="flex-shrink-0 w-4 h-4" />
                              </Button>
                            </>
                          ) : activeApp === "openclaw" ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("skills")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("skills.manage")}
                              >
                                <Wrench className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("workspace")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("workspace.manage")}
                              >
                                <FolderOpen className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("openclawEnv")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("openclaw.env.title")}
                              >
                                <KeyRound className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("openclawTools")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("openclaw.tools.title")}
                              >
                                <Shield className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("openclawAgents")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("openclaw.agents.title")}
                              >
                                <Cpu className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("sessions")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("sessionManager.title")}
                              >
                                <History className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("mcp")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("mcp.title")}
                              >
                                <McpIcon size={16} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("remote")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("remote.title", {
                                  defaultValue: "远程主机",
                                })}
                              >
                                <Server className="flex-shrink-0 w-4 h-4" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("skills")}
                                className={cn(
                                  "text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5",
                                  "transition-all duration-200 ease-in-out overflow-hidden",
                                  hasSkillsSupport
                                    ? "opacity-100 w-8 scale-100 px-2"
                                    : "opacity-0 w-0 scale-75 pointer-events-none px-0 -ml-1",
                                )}
                                title={t("skills.manage")}
                              >
                                <Wrench className="flex-shrink-0 w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("prompts")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("prompts.manage")}
                              >
                                <Book className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("sessions")}
                                className={cn(
                                  "text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5",
                                  "transition-all duration-200 ease-in-out overflow-hidden",
                                  hasSessionSupport
                                    ? "opacity-100 w-8 scale-100 px-2"
                                    : "opacity-0 w-0 scale-75 pointer-events-none px-0 -ml-1",
                                )}
                                title={t("sessionManager.title")}
                              >
                                <History className="flex-shrink-0 w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("mcp")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("mcp.title")}
                              >
                                <McpIcon size={16} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("remote")}
                                className="text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 w-8 px-2"
                                title={t("remote.title", {
                                  defaultValue: "远程主机",
                                })}
                              >
                                <Server className="flex-shrink-0 w-4 h-4" />
                              </Button>
                            </>
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    <Button
                      onClick={() => setIsAddOpen(true)}
                      size="icon"
                      className={`ml-2 ${addActionButtonClass}`}
                    >
                      <Plus className="w-5 h-5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 flex flex-col overflow-y-auto animate-fade-in">
        {isOpenClawView && openclawHealthWarnings.length > 0 && (
          <OpenClawHealthBanner warnings={openclawHealthWarnings} />
        )}
        {/* 设置页不需要目标选择器/远端状态栏（设置里无切换场景） */}
        {currentView !== "settings" && (
          <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/30 px-6 py-2 text-sm backdrop-blur-sm">
            <TargetBreadcrumb
              remoteTargetId={remoteTargetId}
              remoteContainerId={remoteContainerId}
              setRemoteTargetId={setRemoteTargetId}
              setRemoteContainerId={setRemoteContainerId}
              servers={servers}
              containers={containers}
              hostsOnline={hostsOnline}
              onProbeHosts={probeHosts}
            />
          {currentInstalled === true || currentInstalled === null ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                currentInstalled === true
                  ? "bg-emerald-500/15 text-emerald-600"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {currentInstalled === true
                ? `${t(`apps.${sharedFeatureApp}`)} ${t(
                    "remote.cliInstalledBadge",
                    { defaultValue: "已安装" },
                  )}`
                : t("remote.cliDetectFailed", {
                    defaultValue: "安装状态检测中/未知",
                  })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5">
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">
                {`⚠ ${t(`apps.${sharedFeatureApp}`)} ${t(
                  "remote.cliNotInstalledBadge",
                  { defaultValue: "未安装" },
                )}`}
              </span>
              <span className="select-none text-amber-600/60 text-lg leading-none">
                ·
              </span>
              <InstallCommandPopover
                command={
                  (remoteTargetId
                    ? APP_INSTALL_CMDS[sharedFeatureApp]?.remote
                    : APP_INSTALL_CMDS[sharedFeatureApp]?.local) ?? ""
                }
              />
            </span>
          )}
          {remoteTargetId && (
            <span className="text-xs text-muted-foreground">
              {t("remote.targetActiveHint", {
                defaultValue:
                  "供应商 / MCP / Prompts / Skills / 会话 作用于该主机",
              })}
            </span>
          )}
          <button
            onClick={refreshInstallStatus}
            title={t("remote.refreshStatus", {
              defaultValue: "刷新安装状态",
            })}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("remote.refreshStatus", { defaultValue: "刷新" })}
          </button>
          </div>
        )}
        <div className="flex-1 min-h-0 flex flex-col pt-2">
          {renderContent()}
        </div>
      </main>

      <AddProviderDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        appId={activeApp}
        onSubmit={remoteTargetId ? handleAddRemoteProvider : addProvider}
        remoteExistingKeys={
          remoteTargetId
            ? [
                ...Object.keys(remoteProvidersQuery.data?.providers ?? {}),
                ...(remoteProvidersQuery.data?.liveIds ?? []),
              ]
            : undefined
        }
      />

      <EditProviderDialog
        open={Boolean(editingProvider)}
        provider={effectiveEditingProvider}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProvider(null);
          }
        }}
        onSubmit={handleEditProvider}
        appId={activeApp}
        isProxyTakeover={isCurrentAppTakeoverActive}
        remoteLiveIds={
          remoteTargetId ? remoteProvidersQuery.data?.liveIds : undefined
        }
        remoteExistingKeys={
          remoteTargetId
            ? [
                ...Object.keys(remoteProvidersQuery.data?.providers ?? {}),
                ...(remoteProvidersQuery.data?.liveIds ?? []),
              ]
            : undefined
        }
      />

      {effectiveUsageProvider && (
        <UsageScriptModal
          key={effectiveUsageProvider.id}
          provider={effectiveUsageProvider}
          appId={activeApp}
          isOpen={Boolean(usageProvider)}
          onClose={() => setUsageProvider(null)}
          onSave={(script) => {
            if (usageProvider) {
              void saveUsageScript(usageProvider, script);
            }
          }}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmAction)}
        title={
          confirmAction?.action === "remove"
            ? t("confirm.removeProvider")
            : t("confirm.deleteProvider")
        }
        message={
          confirmAction
            ? confirmAction.action === "remove"
              ? t("confirm.removeProviderMessage", {
                  name: confirmAction.provider.name,
                })
              : t("confirm.deleteProviderMessage", {
                  name: confirmAction.provider.name,
                })
            : ""
        }
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        isOpen={launchDashboardOpen}
        title={t("hermes.webui.launchConfirmTitle")}
        message={t("hermes.webui.launchConfirmMessage")}
        confirmText={t("hermes.webui.launchConfirmAction")}
        variant="info"
        onConfirm={() => {
          setLaunchDashboardOpen(false);
          void (async () => {
            try {
              await hermesApi.launchDashboard();
              toast.success(t("hermes.webui.launching"));
            } catch (error) {
              toast.error(t("hermes.webui.launchFailed"), {
                description: extractErrorMessage(error) || undefined,
              });
            }
          })();
        }}
        onCancel={() => setLaunchDashboardOpen(false)}
      />

      <DeepLinkImportDialog />
      <FirstRunNoticeDialog />
    </div>
  );
}

export default App;

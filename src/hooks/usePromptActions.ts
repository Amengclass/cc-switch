import { readLocalCache, writeLocalCache } from "@/lib/localCache";
import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { promptsApi, type Prompt, type AppId } from "@/lib/api";
import { listRemotePrompts, saveRemotePrompts } from "@/lib/api/remote";

const EMPTY_PROMPTS: Record<string, Prompt> = {};

interface PromptActionsOptions {
  /** false：成功时不弹通用 toast（提示词页自己写带后果和撤销的 toast）；失败照样提示 */
  notify?: boolean;
}

// 本补丁层：远端目标（SSH 主机 / Docker 容器）下，Prompts 数据源切到该目标自己的
// 提示词文件（~/.claude/CLAUDE.md 等）。v3.20.4 在 PromptPanel 里用 isRemote 分支
// 自管远端状态；v4.0.4 的 PromptPanel 结构变了，这里把远端分支收进 hook，
// 面板不用改。RemotePrompt 与 Prompt 结构完全一致，无需映射。
export function usePromptActions(
  appId: AppId,
  { notify = true }: PromptActionsOptions = {},
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const { t } = useTranslation();
  const [prompts, setPrompts] = useState<Record<string, Prompt>>({});
  const [promptsAppId, setPromptsAppId] = useState<AppId | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentFileContent, setCurrentFileContent] = useState<string | null>(
    null,
  );
  const [currentFileAppId, setCurrentFileAppId] = useState<AppId | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const reloadGenerationRef = useRef(0);
  const currentAppIdRef = useRef(appId);
  const promptsAppIdRef = useRef<AppId | null>(null);
  // 最近一次从后端读到的列表（写操作之后调用方要拿新列表比对，比如启用时多出来的「原始提示词」）
  const latestLoadedRef = useRef<{
    appId: AppId;
    prompts: Record<string, Prompt>;
  } | null>(null);
  currentAppIdRef.current = appId;

  const visiblePrompts = promptsAppId === appId ? prompts : EMPTY_PROMPTS;
  const visibleCurrentFileContent =
    currentFileAppId === appId ? currentFileContent : null;

  const updatePromptsForApp = useCallback(
    (
      targetAppId: AppId,
      updater: (current: Record<string, Prompt>) => Record<string, Prompt>,
    ) => {
      if (currentAppIdRef.current !== targetAppId) return;

      const previousAppId = promptsAppIdRef.current;
      setPrompts((current) =>
        updater(previousAppId === targetAppId ? current : EMPTY_PROMPTS),
      );
      promptsAppIdRef.current = targetAppId;
      setPromptsAppId(targetAppId);
    },
    [],
  );

  useEffect(
    () => () => {
      reloadGenerationRef.current += 1;
    },
    [],
  );

  const reload = useCallback(async (): Promise<boolean> => {
    const requestAppId = appId;
    if (currentAppIdRef.current !== requestAppId) return false;

    const requestGeneration = ++reloadGenerationRef.current;
    const isCurrentRequest = () =>
      reloadGenerationRef.current === requestGeneration &&
      currentAppIdRef.current === requestAppId;

    // 先显示上次的列表（本地缓存），后台读到最新的再替换；没有缓存才显示「加载中」
    const cacheKey = `prompts.${requestAppId}.v1`;
    const cached = readLocalCache<Record<string, Prompt>>(cacheKey);
    if (cached && promptsAppIdRef.current !== requestAppId) {
      updatePromptsForApp(requestAppId, () => cached);
    }
    setLoading(!cached);
    try {
      const data = remoteTargetId
        ? (await listRemotePrompts(
            remoteTargetId,
            remoteContainerId || undefined,
            requestAppId,
          )).reduce((acc, p) => {
            acc[p.id] = p;
            return acc;
          }, {} as Record<string, Prompt>)
        : await promptsApi.getPrompts(requestAppId);
      if (!isCurrentRequest()) return false;
      latestLoadedRef.current = { appId: requestAppId, prompts: data };
      updatePromptsForApp(requestAppId, () => data);
      writeLocalCache(cacheKey, data);

      try {
        const content = await promptsApi.getCurrentFileContent(requestAppId);
        if (!isCurrentRequest()) return false;
        setCurrentFileContent(content);
        setCurrentFileAppId(requestAppId);
      } catch {
        if (isCurrentRequest()) {
          setCurrentFileContent(null);
          setCurrentFileAppId(requestAppId);
        }
      }
      return true;
    } catch {
      if (isCurrentRequest()) {
        toast.error(t("prompts.loadFailed"));
      }
      return false;
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [appId, t, updatePromptsForApp]);

  // 远端写：整表读改写（后端 save_remote_prompts 按数组整写）。
  const remoteWrite = useCallback(
    async (updater: (current: Record<string, Prompt>) => Record<string, Prompt>) => {
      if (!remoteTargetId) return;
      const current = visiblePrompts;
      const next = updater(current);
      await saveRemotePrompts(
        remoteTargetId,
        Object.values(next),
        remoteContainerId || undefined,
        appId,
      );
    },
    [appId, remoteTargetId, remoteContainerId, visiblePrompts],
  );

  const savePrompt = useCallback(
    async (id: string, prompt: Prompt) => {
      try {
        if (remoteTargetId) {
          await remoteWrite((current) => ({ ...current, [id]: prompt }));
        } else {
          await promptsApi.upsertPrompt(appId, id, prompt);
        }
        updatePromptsForApp(appId, (current) => ({
          ...current,
          [id]: prompt,
        }));
        const refreshed =
          currentAppIdRef.current === appId ? await reload() : false;
        if (notify) {
          toast.success(t("prompts.saveSuccess"), {
            closeButton: true,
            description:
              appId === "pi" && prompt.enabled
                ? t("pi.prompts.reloadNotice")
                : undefined,
          });
        }
        return refreshed;
      } catch (error) {
        toast.error(t("prompts.saveFailed"));
        throw error;
      }
    },
    [appId, notify, reload, t, updatePromptsForApp, remoteTargetId, remoteWrite],
  );

  const deletePrompt = useCallback(
    async (id: string) => {
      try {
        if (remoteTargetId) {
          await remoteWrite((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
        } else {
          await promptsApi.deletePrompt(appId, id);
        }
        updatePromptsForApp(appId, (current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        const refreshed =
          currentAppIdRef.current === appId ? await reload() : false;
        if (notify) {
          toast.success(t("prompts.deleteSuccess"), { closeButton: true });
        }
        return refreshed;
      } catch (error) {
        toast.error(t("prompts.deleteFailed"));
        throw error;
      }
    },
    [appId, notify, reload, t, updatePromptsForApp, remoteTargetId, remoteWrite],
  );

  const enablePrompt = useCallback(
    async (id: string) => {
      try {
        if (remoteTargetId) {
          await remoteWrite((current) =>
            Object.fromEntries(
              Object.entries(current).map(([key, prompt]) => [
                key,
                { ...prompt, enabled: key === id },
              ]),
            ),
          );
        } else {
          await promptsApi.enablePrompt(appId, id);
        }
        updatePromptsForApp(appId, (current) =>
          Object.fromEntries(
            Object.entries(current).map(([key, prompt]) => [
              key,
              { ...prompt, enabled: key === id },
            ]),
          ),
        );
        const refreshed =
          currentAppIdRef.current === appId ? await reload() : false;
        if (notify) {
          toast.success(t("prompts.enableSuccess"), { closeButton: true });
        }
        return refreshed;
      } catch (error) {
        toast.error(t("prompts.enableFailed"));
        throw error;
      }
    },
    [appId, notify, reload, t, updatePromptsForApp, remoteTargetId, remoteWrite],
  );

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      if (appId === "pi") {
        setTogglingId(id);
        try {
          if (enabled) {
            await promptsApi.enablePrompt(appId, id);
          } else {
            const prompt = visiblePrompts[id];
            if (!prompt) {
              throw new Error(`Prompt ${id} does not exist`);
            }
            await promptsApi.upsertPrompt(appId, id, {
              ...prompt,
              enabled: false,
            });
          }
          const refreshed =
            currentAppIdRef.current === appId ? await reload() : false;
          if (notify) {
            toast.success(
              t(
                enabled
                  ? "pi.prompts.usePromptSuccess"
                  : "pi.prompts.stopUsingSuccess",
              ),
              {
                closeButton: true,
                description: t("pi.prompts.reloadNotice"),
              },
            );
          }
          return refreshed;
        } catch (error) {
          toast.error(
            enabled ? t("prompts.enableFailed") : t("prompts.disableFailed"),
          );
          throw error;
        } finally {
          setTogglingId(null);
        }
      }

      const previousPrompts = visiblePrompts;
      const mutationGeneration = reloadGenerationRef.current;

      if (enabled) {
        const updatedPrompts = Object.keys(visiblePrompts).reduce(
          (acc, key) => {
            acc[key] = {
              ...visiblePrompts[key],
              enabled: key === id,
            };
            return acc;
          },
          {} as Record<string, Prompt>,
        );
        updatePromptsForApp(appId, () => updatedPrompts);
      } else {
        updatePromptsForApp(appId, (current) => ({
          ...current,
          [id]: {
            ...current[id],
            enabled: false,
          },
        }));
      }

      try {
        if (enabled) {
          if (remoteTargetId) {
            await remoteWrite((current) =>
              Object.fromEntries(
                Object.entries(current).map(([key, prompt]) => [
                  key,
                  { ...prompt, enabled: key === id },
                ]),
              ),
            );
          } else {
            await promptsApi.enablePrompt(appId, id);
          }
          if (notify) {
            toast.success(t("prompts.enableSuccess"), { closeButton: true });
          }
        } else {
          if (remoteTargetId) {
            await remoteWrite((current) => ({
              ...current,
              [id]: { ...current[id], enabled: false },
            }));
          } else {
            await promptsApi.upsertPrompt(appId, id, {
              ...visiblePrompts[id],
              enabled: false,
            });
          }
          if (notify) {
            toast.success(t("prompts.disableSuccess"), { closeButton: true });
          }
        }
        return currentAppIdRef.current === appId ? await reload() : false;
      } catch (error) {
        if (
          currentAppIdRef.current === appId &&
          reloadGenerationRef.current === mutationGeneration
        ) {
          updatePromptsForApp(appId, () => previousPrompts);
        }
        toast.error(
          enabled ? t("prompts.enableFailed") : t("prompts.disableFailed"),
        );
        throw error;
      }
    },
    [appId, notify, reload, t, updatePromptsForApp, visiblePrompts, remoteTargetId, remoteWrite],
  );

  const importFromFile = useCallback(async () => {
    try {
      const id = await promptsApi.importFromFile(appId);
      if (currentAppIdRef.current === appId) {
        await reload();
      }
      if (notify) {
        toast.success(t("prompts.importSuccess"), { closeButton: true });
      }
      return id;
    } catch (error) {
      toast.error(t("prompts.importFailed"));
      throw error;
    }
  }, [appId, notify, reload, t]);

  /** 最近一次读到的当前应用列表；还没读过或读的是别的应用时返回 null。 */
  const getLatestPrompts = useCallback((): Record<string, Prompt> | null => {
    const latest = latestLoadedRef.current;
    return latest && latest.appId === currentAppIdRef.current
      ? latest.prompts
      : null;
  }, []);

  /** 复制一个提示词到指定 app（远端目标：写该目标对应 app 的提示词文件）。 */
  const copyToApp = useCallback(
    async (source: Prompt, targetApp: AppId) => {
      const id = `prompt-${Date.now()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const copy: Prompt = {
        id,
        name: source.name,
        description: source.description,
        content: source.content,
        enabled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (remoteTargetId) {
        // 远端：整表读改写（targetApp 的提示词文件）
        const current = await listRemotePrompts(
          remoteTargetId,
          remoteContainerId || undefined,
          targetApp,
        );
        await saveRemotePrompts(
          remoteTargetId,
          [...current, copy],
          remoteContainerId || undefined,
          targetApp,
        );
      } else {
        await promptsApi.upsertPrompt(targetApp, id, copy);
      }
      return copy;
    },
    [remoteTargetId, remoteContainerId],
  );

  /** 从指定 app 删除提示词（远端目标：写该目标对应 app 的提示词文件）。 */
  const deleteFromApp = useCallback(
    async (targetApp: AppId, id: string) => {
      if (remoteTargetId) {
        const current = await listRemotePrompts(
          remoteTargetId,
          remoteContainerId || undefined,
          targetApp,
        );
        await saveRemotePrompts(
          remoteTargetId,
          current.filter((p) => p.id !== id),
          remoteContainerId || undefined,
          targetApp,
        );
      } else {
        await promptsApi.deletePrompt(targetApp, id);
      }
    },
    [remoteTargetId, remoteContainerId],
  );

  return {
    prompts: visiblePrompts,
    loading,
    currentFileContent: visibleCurrentFileContent,
    togglingId,
    reload,
    savePrompt,
    deletePrompt,
    enablePrompt,
    toggleEnabled,
    importFromFile,
    getLatestPrompts,
    copyToApp,
    deleteFromApp,
  };
}

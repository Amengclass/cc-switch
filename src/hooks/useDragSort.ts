import { useCallback, useMemo } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { useTranslation } from "react-i18next";
import type { Provider } from "@/types";
import { providersApi, type AppId } from "@/lib/api";
import { updateRemoteProviderSortOrder } from "@/lib/api/remote";
import { isProxyAppId } from "@/config/appConfig";

export function useDragSort(
  providers: Record<string, Provider>,
  appId: AppId,
  /** 远端目标（本补丁层）：非空时排序写远端 SSOT，不写本机 DB */
  remoteTargetId?: string,
  remoteContainerId?: string,
) {
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();

  const sortedProviders = useMemo(() => {
    const locale =
      i18n.language === "zh"
        ? "zh-CN"
        : i18n.language === "zh-TW"
          ? "zh-TW"
          : "en-US";
    return Object.values(providers).sort((a, b) => {
      if (a.sortIndex !== undefined && b.sortIndex !== undefined) {
        return a.sortIndex - b.sortIndex;
      }
      if (a.sortIndex !== undefined) return -1;
      if (b.sortIndex !== undefined) return 1;

      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      if (timeA && timeB && timeA !== timeB) {
        return timeA - timeB;
      }

      return a.name.localeCompare(b.name, locale);
    });
  }, [providers, i18n.language]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }

      const oldIndex = sortedProviders.findIndex(
        (provider) => provider.id === active.id,
      );
      const newIndex = sortedProviders.findIndex(
        (provider) => provider.id === over.id,
      );

      if (oldIndex === -1 || newIndex === -1) {
        return;
      }

      const reordered = arrayMove(sortedProviders, oldIndex, newIndex);
      const updates = reordered.map((provider, index) => ({
        id: provider.id,
        sortIndex: index,
      }));

      // 远端目标：乐观更新——拖动落点立即把缓存里的 sortIndex 重排，UI 零延迟反映
      // 新顺序；失败回滚。远端写是 SSH 往返（0.5~2s）+ refetch 又一次往返，不乐观更新
      // 会「拖完等一会才动」。本机是本地写、毫秒级，不需要。
      const remoteSortKey = [
        "remoteProviders",
        remoteTargetId,
        remoteContainerId || "__host__",
        appId,
      ] as const;
      const prevRemoteSortData = remoteTargetId
        ? queryClient.getQueryData(remoteSortKey)
        : undefined;
      if (remoteTargetId) {
        const indexById = new Map(updates.map((u) => [u.id, u.sortIndex]));
        queryClient.setQueryData(
          remoteSortKey,
          (old: { providers?: Record<string, Provider> } | undefined) => {
            if (!old?.providers) return old;
            const nextProviders: Record<string, Provider> = {};
            for (const [id, p] of Object.entries(old.providers)) {
              nextProviders[id] = {
                ...p,
                sortIndex: indexById.get(id) ?? p.sortIndex,
              };
            }
            return { ...old, providers: nextProviders };
          },
        );
      }

      try {
        if (remoteTargetId) {
          // 远端目标：排序写远端 SSOT；写成功后 invalidate 校准（乐观值已是新顺序，
          // keepPreviousData 保证 refetch 不闪回旧顺序）。
          await updateRemoteProviderSortOrder(
            remoteTargetId,
            appId,
            updates,
            remoteContainerId || undefined,
          );
          await queryClient.invalidateQueries({
            queryKey: [
              "remoteProviders",
              remoteTargetId,
              remoteContainerId || "__host__",
              appId,
            ],
          });
        } else {
          await providersApi.updateSortOrder(updates, appId);
          await queryClient.invalidateQueries({
            queryKey: ["providers", appId],
          });

          // Routing apps derive failover order from sort_index.
          if (isProxyAppId(appId)) {
            await queryClient.invalidateQueries({
              queryKey: ["failoverQueue", appId],
            });
          }

          // 更新托盘菜单以反映新的排序（失败不影响主操作）
          try {
            await providersApi.updateTrayMenu();
          } catch (trayError) {
            console.error("Failed to update tray menu after sort", trayError);
            // 托盘菜单更新失败不影响排序成功
          }
        }

        toast.success(
          t("provider.sortUpdated", {
            defaultValue: "排序已更新",
          }),
          { closeButton: true },
        );
      } catch (error) {
        console.error("Failed to update provider sort order", error);
        // 远端乐观更新回滚：写失败则恢复到拖动前的顺序
        if (remoteTargetId && prevRemoteSortData !== undefined) {
          queryClient.setQueryData(remoteSortKey, prevRemoteSortData);
        }
        toast.error(
          t("provider.sortUpdateFailed", {
            defaultValue: "排序更新失败",
          }),
        );
      }
    },
    [sortedProviders, appId, queryClient, t, remoteTargetId, remoteContainerId],
  );

  return {
    sortedProviders,
    sensors,
    handleDragEnd,
  };
}

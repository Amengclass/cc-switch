import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { type AppId } from "@/lib/api";
import { usePromptActions } from "@/hooks/usePromptActions";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import PromptListItem from "./PromptListItem";
import PromptFormPanel from "./PromptFormPanel";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "@/components/ui/button";
import MarkdownEditor from "@/components/MarkdownEditor";
import { readRemotePrompt, writeRemotePrompt } from "@/lib/api/remote";

interface PromptPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
  /** 选中远端目标时，Prompts 直接编辑该主机 ~/.claude/CLAUDE.md */
  remoteTargetId?: string;
  /** 目标细化到 Docker 容器时，编辑容器内 ~/.claude/CLAUDE.md */
  remoteContainerId?: string;
}

export interface PromptPanelHandle {
  openAdd: () => void;
}

const PromptPanel = React.forwardRef<PromptPanelHandle, PromptPanelProps>(
  ({ open, appId, remoteTargetId, remoteContainerId }, ref) => {
    const { t } = useTranslation();

    // 选中远端/容器目标时：远端 ~/.claude/CLAUDE.md 是单个文件，直接整文件编辑，
    // 不走本地 DB 的「多提示词 + 启用」结构。
    if (remoteTargetId && appId === "claude") {
      return (
        <RemotePromptEditor
          key={`${remoteTargetId}-${remoteContainerId ?? ""}`}
          hostId={remoteTargetId}
          containerId={remoteContainerId}
        />
      );
    }
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{
      isOpen: boolean;
      titleKey: string;
      messageKey: string;
      messageParams?: Record<string, unknown>;
      onConfirm: () => void;
    } | null>(null);

    const {
      prompts,
      loading,
      reload,
      savePrompt,
      deletePrompt,
      toggleEnabled,
    } = usePromptActions(appId);

    useEffect(() => {
      if (open) reload();
    }, [open, reload]);

    // Listen for prompt import events from deep link
    useEffect(() => {
      const handlePromptImported = (event: Event) => {
        const customEvent = event as CustomEvent;
        // Reload if the import is for this app
        if (customEvent.detail?.app === appId) {
          reload();
        }
      };

      window.addEventListener("prompt-imported", handlePromptImported);
      return () => {
        window.removeEventListener("prompt-imported", handlePromptImported);
      };
    }, [appId, reload]);

    // 应用项目 Profile 会切换激活的 prompt（prompts 非 react-query，需主动 reload）
    useTauriEvent("profile-applied", reload);

    const handleAdd = () => {
      setEditingId(null);
      setIsFormOpen(true);
    };

    React.useImperativeHandle(ref, () => ({
      openAdd: handleAdd,
    }));

    const handleEdit = (id: string) => {
      setEditingId(id);
      setIsFormOpen(true);
    };

    const handleDelete = (id: string) => {
      const prompt = prompts[id];
      setConfirmDialog({
        isOpen: true,
        titleKey: "prompts.confirm.deleteTitle",
        messageKey: "prompts.confirm.deleteMessage",
        messageParams: { name: prompt?.name },
        onConfirm: async () => {
          try {
            await deletePrompt(id);
            setConfirmDialog(null);
          } catch (e) {
            // Error handled by hook
          }
        },
      });
    };

    const promptEntries = useMemo(() => Object.entries(prompts), [prompts]);

    const enabledPrompt = promptEntries.find(([_, p]) => p.enabled);

    return (
      <div className="flex flex-col flex-1 min-h-0 px-6">
        <div className="flex-shrink-0 py-4 glass rounded-xl border border-white/10 mb-4 px-6">
          <div className="text-sm text-muted-foreground">
            {t("prompts.count", { count: promptEntries.length })} ·{" "}
            {enabledPrompt
              ? t("prompts.enabledName", { name: enabledPrompt[1].name })
              : t("prompts.noneEnabled")}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pb-16">
          {loading ? (
            <div className="text-center py-12 text-muted-foreground">
              {t("prompts.loading")}
            </div>
          ) : promptEntries.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 bg-muted rounded-full flex items-center justify-center">
                <FileText size={24} className="text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium text-foreground mb-2">
                {t("prompts.empty")}
              </h3>
              <p className="text-muted-foreground text-sm">
                {t("prompts.emptyDescription")}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {promptEntries.map(([id, prompt]) => (
                <PromptListItem
                  key={id}
                  id={id}
                  prompt={prompt}
                  onToggle={toggleEnabled}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>

        {isFormOpen && (
          <PromptFormPanel
            appId={appId}
            editingId={editingId || undefined}
            initialData={editingId ? prompts[editingId] : undefined}
            onSave={savePrompt}
            onClose={() => setIsFormOpen(false)}
          />
        )}

        {confirmDialog && (
          <ConfirmDialog
            isOpen={confirmDialog.isOpen}
            title={t(confirmDialog.titleKey)}
            message={t(confirmDialog.messageKey, confirmDialog.messageParams)}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}
      </div>
    );
  },
);

PromptPanel.displayName = "PromptPanel";

/** 远端单文件 CLAUDE.md 编辑器：读取 → 编辑 → 原子写回。 */
function RemotePromptEditor({
  hostId,
  containerId,
}: {
  hostId: string;
  containerId?: string;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    setIsDarkMode(document.documentElement.classList.contains("dark"));
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    readRemotePrompt(hostId, containerId)
      .then((text) => {
        if (active) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          toast.error(
            t("remote.promptLoadError", { defaultValue: "读取远端 CLAUDE.md 失败" }),
          );
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [hostId, containerId, t]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await writeRemotePrompt(hostId, content, containerId);
      toast.success(
        t("remote.promptSaved", { defaultValue: "已保存到远端 CLAUDE.md" }),
        { closeButton: true },
      );
    } catch (error) {
      toast.error(
        t("remote.promptSaveError", { defaultValue: "保存远端 CLAUDE.md 失败" }),
        { description: String(error) },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 px-6 pt-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-muted-foreground">
          {t("remote.promptRemoteHint", {
            defaultValue: "编辑远端 ~/.claude/CLAUDE.md（整文件覆盖写回）",
          })}
        </p>
        <Button onClick={() => void handleSave()} disabled={loading || saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          <Save className="mr-1 h-4 w-4" />
          {t("common.save")}
        </Button>
      </div>
      <div className="flex-1 overflow-hidden rounded-xl border">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {t("prompts.loading")}
          </div>
        ) : (
          <MarkdownEditor
            value={content}
            onChange={setContent}
            darkMode={isDarkMode}
          />
        )}
      </div>
    </div>
  );
}

export default PromptPanel;

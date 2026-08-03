import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Server,
  Plus,
  Pencil,
  Trash2,
  PlugZap,
  FileText,
  Loader2,
  ExternalLink,
  ShieldAlert,
  Eye,
  EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  checkRemoteClaudeInstalled,
  cleanRemoteEnvConflicts,
  deleteRemoteHost,
  listRemoteHosts,
  readRemoteSettings,
  saveRemoteHost,
  scanRemoteEnvConflicts,
  testRemoteConnection,
} from "@/lib/api/remote";
import type { RemoteEnvConflict, RemoteHost } from "@/types/remote";

interface HostFormState {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  savePassword: boolean;
}

const EMPTY_FORM: HostFormState = {
  name: "",
  host: "",
  port: "22",
  username: "root",
  password: "",
  savePassword: true,
};

function formToDraft(f: HostFormState) {
  return {
    name: f.name.trim(),
    host: f.host.trim(),
    port: Math.max(1, Number(f.port) || 22),
    username: f.username.trim() || "root",
    authMethod: "password" as const,
    savePassword: f.savePassword,
    password: f.password,
  };
}

export function RemoteHostsPanel() {
  const { t } = useTranslation();

  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<
    Record<string, boolean | null>
  >({});
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RemoteHost | null>(null);
  const [form, setForm] = useState<HostFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [viewSettings, setViewSettings] = useState<{
    host: RemoteHost;
    content: string;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    host: RemoteHost | null;
  }>({ open: false, host: null });
  // 密码明文显示开关
  const [showPassword, setShowPassword] = useState(false);
  // 环境变量清理
  const [envDialog, setEnvDialog] = useState<{
    open: boolean;
    host: RemoteHost | null;
  }>({ open: false, host: null });
  const [envConflicts, setEnvConflicts] = useState<RemoteEnvConflict[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [envCleaning, setEnvCleaning] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await listRemoteHosts();
      setHosts(data);
      // 后台检测每台主机的 Claude Code 安装状态（带超时，失败/超时置 null）
      data.forEach((h) => {
        checkRemoteClaudeInstalled(h.id)
          .then((s) => setClaudeStatus((prev) => ({ ...prev, [h.id]: s })))
          .catch(() => setClaudeStatus((prev) => ({ ...prev, [h.id]: null })));
      });
    } catch (error) {
      console.error("Failed to load remote hosts:", error);
      toast.error(t("remote.loadError", { defaultValue: "加载远程主机失败" }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const openEdit = (host: RemoteHost) => {
    setEditing(host);
    setForm({
      name: host.name,
      host: host.host,
      port: String(host.port),
      username: host.username,
      password: "",
      savePassword: host.savePassword,
    });
    setFormOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.host.trim()) {
      toast.error(
        t("remote.formRequired", { defaultValue: "名称和主机地址不能为空" }),
      );
      return;
    }
    if (!editing && !form.password.trim()) {
      toast.error(
        t("remote.passwordRequired", {
          defaultValue: "新增主机需要填写密码",
        }),
      );
      return;
    }
    const draft = formToDraft(form);
    const now = Date.now();
    const host: RemoteHost = {
      id: editing?.id ?? crypto.randomUUID(),
      name: draft.name,
      host: draft.host,
      port: draft.port,
      username: draft.username,
      authMethod: draft.authMethod,
      savePassword: draft.savePassword,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
    };
    setSaving(true);
    try {
      await saveRemoteHost(host, form.password || undefined);
      toast.success(
        editing
          ? t("remote.updated", { defaultValue: "远程主机已更新" })
          : t("remote.added", { defaultValue: "远程主机已添加" }),
      );
      setFormOpen(false);
      load();
    } catch (error) {
      console.error("Failed to save remote host:", error);
      toast.error(
        t("remote.saveError", { defaultValue: "保存远程主机失败" }),
        { description: String(error) },
      );
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (host: RemoteHost) => {
    setTestingId(host.id);
    try {
      const info = await testRemoteConnection(host.id);
      setClaudeStatus((prev) => ({
        ...prev,
        [host.id]: info.claudeCodeInstalled,
      }));
      const claudeStatusText = info.claudeCodeInstalled
        ? t("remote.claudeInstalled", {
            defaultValue: "已检测到 Claude Code",
          })
        : info.claudeCodeInstalled === false
          ? t("remote.claudeNotInstalled", {
              defaultValue: "未检测到 Claude Code（配置会预置，安装后生效）",
            })
          : t("remote.claudeDetectFailed", {
              defaultValue: "Claude Code 安装状态检测失败",
            });
      toast.success(
        t("remote.connected", {
          defaultValue: `连接成功 ${host.name}（远端目录 ${info.home}）`,
          name: host.name,
          home: info.home,
        }),
        {
          description: [
            info.settingsExists
              ? t("remote.settingsExists", {
                  defaultValue: "检测到远端 settings.json",
                })
              : t("remote.settingsMissing", {
                  defaultValue: "远端尚未创建 settings.json",
                }),
            claudeStatusText,
          ].join(" · "),
        },
      );
    } catch (error) {
      console.error("Failed to test connection:", error);
      toast.error(
        t("remote.connectionFailed", { defaultValue: "连接失败" }),
        { description: String(error) },
      );
    } finally {
      setTestingId(null);
    }
  };

  const handleReadSettings = async (host: RemoteHost) => {
    setReadingId(host.id);
    try {
      const settings = await readRemoteSettings(host.id);
      setViewSettings({ host, content: JSON.stringify(settings, null, 2) });
    } catch (error) {
      console.error("Failed to read remote settings:", error);
      toast.error(
        t("remote.readSettingsError", {
          defaultValue: "读取远端配置失败",
        }),
        { description: String(error) },
      );
    } finally {
      setReadingId(null);
    }
  };

  const handleDelete = async () => {
    const host = deleteConfirm.host;
    if (!host) return;
    try {
      await deleteRemoteHost(host.id);
      toast.success(
        t("remote.deleted", { defaultValue: "远程主机已删除" }),
      );
      load();
    } catch (error) {
      console.error("Failed to delete remote host:", error);
      toast.error(
        t("remote.deleteError", { defaultValue: "删除远程主机失败" }),
      );
    } finally {
      setDeleteConfirm({ open: false, host: null });
    }
  };

  // 打开环境变量扫描
  const openEnvDialog = async (host: RemoteHost) => {
    setEnvDialog({ open: true, host });
    setEnvConflicts([]);
    setEnvLoading(true);
    try {
      const conflicts = await scanRemoteEnvConflicts(host.id);
      setEnvConflicts(conflicts);
    } catch (error) {
      console.error("Failed to scan env conflicts:", error);
      toast.error(
        t("remote.scanEnvError", { defaultValue: "扫描冲突环境变量失败" }),
        { description: String(error) },
      );
    } finally {
      setEnvLoading(false);
    }
  };

  // 清理冲突环境变量
  const handleCleanEnv = async () => {
    const host = envDialog.host;
    if (!host) return;
    setEnvCleaning(true);
    try {
      const result = await cleanRemoteEnvConflicts(host.id);
      toast.success(
        t("remote.envCleaned", {
          defaultValue: "已清理 {{count}} 处冲突环境变量",
          count: result.cleaned,
        }),
      );
      setEnvDialog({ open: false, host: null });
    } catch (error) {
      console.error("Failed to clean env conflicts:", error);
      toast.error(
        t("remote.cleanEnvError", { defaultValue: "清理冲突环境变量失败" }),
        { description: String(error) },
      );
    } finally {
      setEnvCleaning(false);
    }
  };

  const description = useMemo(
    () => t("remote.description", {
      defaultValue:
        "通过 SSH 直连 Linux 服务器，直接读写远端 ~/.claude/settings.json，实现「一处配置、多机生效」。",
    }),
    [t],
  );

  return (
    <div className="space-y-4 px-6 pt-4">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <Server className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">
          {t("remote.title", { defaultValue: "远程主机" })}
        </h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {hosts.length}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{description}</p>

      {/* 主机列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : hosts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center">
          <Server className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {t("remote.empty", { defaultValue: "还没有远程主机" })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t("remote.emptyHint", {
              defaultValue: "点击「添加远程主机」，连接你的 GPU 服务器 / 云主机",
            })}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {hosts.map((host) => (
            <div
              key={host.id}
              className="rounded-xl border bg-card p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{host.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {host.username}@{host.host}:{host.port}
                  </p>
                </div>
                <Server className="h-4 w-4 shrink-0 text-muted-foreground/60" />
              </div>

              {claudeStatus[host.id] === false && (
                <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">
                  <ShieldAlert className="h-3 w-3" />
                  {t("remote.claudeNotInstalledBadge", {
                    defaultValue: "Claude Code 未安装",
                  })}
                </div>
              )}
              {claudeStatus[host.id] === true && (
                <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600">
                  {t("remote.claudeInstalledBadge", {
                    defaultValue: "Claude Code 已安装",
                  })}
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTest(host)}
                  disabled={testingId === host.id}
                >
                  {testingId === host.id ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t("remote.test", { defaultValue: "测试连接" })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleReadSettings(host)}
                  disabled={readingId === host.id}
                >
                  {readingId === host.id ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t("remote.readSettings", { defaultValue: "读取配置" })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openEnvDialog(host)}
                >
                  <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                  {t("remote.env", { defaultValue: "环境变量" })}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-7 w-7"
                  onClick={() => openEdit(host)}
                  title={t("common.edit", { defaultValue: "编辑" })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => setDeleteConfirm({ open: true, host })}
                  title={t("common.delete", { defaultValue: "删除" })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 添加按钮 */}
      <Button onClick={openAdd} className="gap-1.5">
        <Plus className="h-4 w-4" />
        {t("remote.add", { defaultValue: "添加远程主机" })}
      </Button>

      {/* 添加/编辑表单弹窗 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("remote.editTitle", { defaultValue: "编辑远程主机" })
                : t("remote.addTitle", { defaultValue: "添加远程主机" })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="host-name">
                {t("remote.nameLabel", { defaultValue: "名称" })}
              </Label>
              <Input
                id="host-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("remote.namePlaceholder", {
                  defaultValue: "例如：GPU 训练机 / 生产服务器",
                })}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="host-address">
                  {t("remote.hostLabel", { defaultValue: "主机地址" })}
                </Label>
                <Input
                  id="host-address"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="192.168.1.10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="host-port">
                  {t("remote.portLabel", { defaultValue: "端口" })}
                </Label>
                <Input
                  id="host-port"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="host-user">
                {t("remote.usernameLabel", { defaultValue: "用户名" })}
              </Label>
              <Input
                id="host-user"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="root"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="host-pass">
                {t("remote.passwordLabel", { defaultValue: "密码" })}
              </Label>
              <div className="relative">
                <Input
                  id="host-pass"
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                  placeholder={
                    editing
                      ? t("remote.passwordKeepHint", {
                          defaultValue: "留空则保留已保存的密码",
                        })
                      : ""
                  }
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  title={
                    showPassword
                      ? t("remote.hidePassword", {
                          defaultValue: "隐藏密码",
                        })
                      : t("remote.showPassword", {
                          defaultValue: "显示密码",
                        })
                  }
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm">
                  {t("remote.savePassword", {
                    defaultValue: "保存密码到系统钥匙串",
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("remote.savePasswordHint", {
                    defaultValue:
                      "密码经系统钥匙串加密保存，用于一键连接 / 切换",
                  })}
                </p>
              </div>
              <Switch
                checked={form.savePassword}
                onCheckedChange={(v) => setForm({ ...form, savePassword: v })}
              />
            </div>

            <Alert>
              <AlertDescription className="text-xs text-muted-foreground">
                {t("remote.formHint", {
                  defaultValue:
                    "M1 阶段仅支持密码认证；密钥认证将在后续版本加入。",
                })}
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFormOpen(false)}
              disabled={saving}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("common.save", { defaultValue: "保存" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 远端配置查看 */}
      <Dialog
        open={Boolean(viewSettings)}
        onOpenChange={(open) => !open && setViewSettings(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4" />
              {viewSettings
                ? `${viewSettings.host.name} · ~/.claude/settings.json`
                : ""}
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-[55vh] rounded-lg border bg-muted/40 p-3">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
              {viewSettings?.content}
            </pre>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewSettings(null)}>
              {t("common.close", { defaultValue: "关闭" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 环境变量清理 */}
      <Dialog
        open={envDialog.open}
        onOpenChange={(open) =>
          !open && setEnvDialog({ open: false, host: null })
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("remote.envTitle", { defaultValue: "冲突环境变量" })}
            </DialogTitle>
          </DialogHeader>
          {envLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : envConflicts.length === 0 ? (
            <Alert>
              <AlertDescription>
                {t("remote.envClean", {
                  defaultValue: "未发现冲突的 ANTHROPIC_* 环境变量",
                })}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("remote.envConflictCount", {
                  defaultValue: "发现 {{count}} 处冲突",
                  count: envConflicts.length,
                })}
              </p>
              <ScrollArea className="max-h-[45vh] rounded-lg border p-2">
                <div className="space-y-1">
                  {envConflicts.map((c, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs"
                    >
                      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <div className="min-w-0">
                        <p className="font-mono font-medium">{c.varName}</p>
                        <p className="truncate text-muted-foreground">
                          {c.sourcePath}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEnvDialog({ open: false, host: null })}
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
            <Button
              disabled={envLoading || envConflicts.length === 0 || envCleaning}
              onClick={() => void handleCleanEnv()}
            >
              {envCleaning && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("remote.cleanEnv", { defaultValue: "清理冲突变量" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        isOpen={deleteConfirm.open}
        title={t("remote.deleteConfirmTitle", {
          defaultValue: "删除远程主机",
        })}
        message={t("remote.deleteConfirmMessage", {
          defaultValue: `确定要删除 "${deleteConfirm.host?.name}" 吗？系统钥匙串中的密码也会一并清除。`,
          name: deleteConfirm.host?.name ?? "",
        })}
        confirmText={t("common.delete", { defaultValue: "删除" })}
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm({ open: false, host: null })}
      />
    </div>
  );
}

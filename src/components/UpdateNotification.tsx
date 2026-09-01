import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle } from "lucide-react";
import { toast } from "sonner";
import { useUpdate } from "@/contexts/UpdateContext";

interface UpdateNotificationProps {
  onViewDetails: () => void;
}

/** 启动时检测到新版本，弹一次 toast 通知 */
export function UpdateNotification({ onViewDetails }: UpdateNotificationProps) {
  const { t } = useTranslation();
  const { hasUpdate, updateInfo } = useUpdate();
  const dismissedKey = "ccswitch:update:toastEverShown";

  useEffect(() => {
    if (!hasUpdate || !updateInfo) return;
    // 已经弹过则跳过
    if (localStorage.getItem(dismissedKey)) return;

    const timer = setTimeout(() => {
      toast.info(
        t("update.notification", { defaultValue: "原生 CC-Switch 有新版本" }) +
          ` v${updateInfo.availableVersion}`,
        {
          icon: <ArrowUpCircle className="h-4 w-4" />,
          duration: Infinity,
          action: {
            label: t("update.viewDetails", { defaultValue: "查看详情" }),
            onClick: onViewDetails,
          },
          onDismiss: () => {
            localStorage.setItem(dismissedKey, "1");
          },
        },
      );
    }, 2000);

    return () => clearTimeout(timer);
  }, [hasUpdate, updateInfo, onViewDetails, t]);

  return null;
}

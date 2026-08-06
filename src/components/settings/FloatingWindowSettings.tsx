import { useTranslation } from "react-i18next";
import type { SettingsFormState } from "@/hooks/useSettings";
import { AppWindow, CircleDot, Lock } from "lucide-react";
import { ToggleRow } from "@/components/ui/toggle-row";
import { AnimatePresence, motion } from "framer-motion";

interface FloatingWindowSettingsProps {
  settings: SettingsFormState;
  onChange: (updates: Partial<SettingsFormState>) => void;
}

/**
 * 悬浮窗（加速球）设置：独立区块，与主窗口的「窗口行为」分离。
 */
export function FloatingWindowSettings({
  settings,
  onChange,
}: FloatingWindowSettingsProps) {
  const { t } = useTranslation();

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border/40">
        <AppWindow className="h-4 w-4 text-rose-500" />
        <h3 className="text-sm font-medium">{t("settings.floatingWindow")}</h3>
      </div>

      <div className="space-y-3">
        <ToggleRow
          icon={<CircleDot className="h-4 w-4 text-rose-500" />}
          title={t("settings.enableFloatingWindow")}
          description={t("settings.enableFloatingWindowDescription")}
          checked={!!settings.enableFloatingWindow}
          onCheckedChange={(value) => onChange({ enableFloatingWindow: value })}
        />

        <AnimatePresence initial={false}>
          {settings.enableFloatingWindow && (
            <motion.div
              key="floating-extra"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.3 }}
            >
              <ToggleRow
                icon={<Lock className="h-4 w-4 text-rose-500" />}
                title="固定当前位置"
                description="固定后悬浮球不可拖动、不自动吸附（单击仍可打开主窗口）"
                checked={!!settings.floatingLocked}
                onCheckedChange={(value) => onChange({ floatingLocked: value })}
              />
              <div className="flex items-center justify-between gap-3 py-2 pl-4">
                <div className="space-y-1">
                  <div className="text-sm font-medium leading-none">
                    {t("settings.floatingSnapSpeed")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("settings.floatingSnapSpeedDescription")}
                  </div>
                </div>
                <select
                  value={settings.floatingSnapSpeedMs ?? 160}
                  onChange={(e) =>
                    onChange({ floatingSnapSpeedMs: Number(e.target.value) })
                  }
                  className="h-8 rounded-md border border-border/40 bg-background px-2 text-sm text-foreground outline-none"
                >
                  <option value={0}>
                    {t("settings.floatingSnapSpeedOff")}
                  </option>
                  <option value={80}>
                    {t("settings.floatingSnapSpeedFast")}
                  </option>
                  <option value={160}>
                    {t("settings.floatingSnapSpeedMedium")}
                  </option>
                  <option value={300}>
                    {t("settings.floatingSnapSpeedSlow")}
                  </option>
                </select>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

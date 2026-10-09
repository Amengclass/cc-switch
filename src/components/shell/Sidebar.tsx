import { useContext, useRef, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import {
  ArrowLeft,
  BookOpen,
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  Database,
  Folder,
  Globe,
  History,
  Info,
  KeyRound,
  Layers,
  LayoutGrid,
  Route,
  Server,
  Settings,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import { APP_IDS } from "@/config/appConfig";
import type { GlobalPage, SettingsSection, View } from "@/lib/navigation";
import { isAppPage } from "@/lib/navigation";
import { RemoteTargetContext } from "@/components/remote/RemoteTargetContext";
import { SkillsIcon } from "@/components/BrandIcons";
import { useUpdate } from "@/contexts/UpdateContext";
import { sidebarWidth, useSidebarCollapsed } from "@/hooks/useSidebarCollapsed";
import { useSidebarStatus, type AppNavStatus } from "@/hooks/useSidebarStatus";
import { fmtUsd } from "@/components/usage/format";
import { HoverTip } from "@/components/ui/hover-tip";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import ccswitchLogo from "@/assets/icons/logo.svg";
import { APP_DISPLAY_NAME, AppGlyph } from "./AppGlyph";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

type IconComponent = ComponentType<{ className?: string }>;

interface SidebarProps {
  activeApp: AppId;
  view: View;
  visibleApps: VisibleApps;
  settingsSection: SettingsSection;
  onSelectApp: (app: AppId) => void;
  onSelectPage: (page: GlobalPage | "settings") => void;
  onSelectSettingsSection: (section: SettingsSection) => void;
  onExitSettings: () => void;
  /** 打开了「启动时检查应用更新」并且查到了新版本 */
  appsUpdateAvailable?: boolean;
}

type DirectoryProps = SidebarProps & { collapsed: boolean };

/**
 * 主导航（v7）：顶条 44 → 应用列表（唯一滚动的区域）→ 全局 6 项（贴底）→ 底栏「应用 · 设置」。
 * 进入设置后整条侧栏换成设置目录。收起时是 72px 的图标轨；
 * 展开 / 收起时宽度一步到位，边缘的滑动由盖板的 transform 动画画出（见 useSidebarCollapsed），文字不换行、被裁掉而不是挤成两行。
 * 收起时各行只剩图标，名字由 HoverTip 从右侧报；展开时文字可见，不再挂提示。
 */
export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);
  const { collapsed, toggle } = useSidebarCollapsed(navRef);
  const { view } = props;
  const inSettings = view === "settings";

  return (
    <nav
      ref={navRef}
      aria-label={t("nav.mainLabel")}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden whitespace-nowrap border-e border-border bg-sidebar text-body text-fg-1",
      )}
      style={{ width: sidebarWidth(collapsed) }}
    >
      <a
        href="#main-content"
        className="absolute -start-[999px] top-2 z-10 rounded-control bg-surface px-2 py-1 text-caption shadow-v7-sm focus:start-2"
      >
        {t("nav.skipToContent")}
      </a>
      <SidebarTopBar collapsed={collapsed} onToggle={toggle} />
      {/* 远端目标选择器（本补丁层新增）：由 App 经 context 注入。
          放侧栏而不是主区，是因为 Windows 上窗口是自绘标题栏
          （decorations:false），主区页头必须贴顶，否则窗口按钮被顶下去；
          侧栏与主区左右并排，零主区占用，且每页常驻。 */}
      <RemoteTargetRow collapsed={collapsed} />
      {inSettings ? (
        <SettingsDirectory {...props} collapsed={collapsed} />
      ) : (
        <MainDirectory {...props} collapsed={collapsed} />
      )}
    </nav>
  );
}

/**
 * 侧栏里的「远端目标选择器」行（本补丁层新增）。
 *
 * - 渲染什么由 App 决定（经 `RemoteTargetContext` 注入）；远端功能关闭时值为
 *   `null`，这里整段不渲染 —— 侧栏与官方完全一致。
 * - 展开态：整行放 App 给的选择器（本机 / 服务器 / 容器 连体胶囊）。
 * - 收起态（72px 图标轨）：放不下胶囊，退化成一个图标按钮，点击展开侧栏再操作。
 * - 选择器下方画一条与官方一致的分隔线（元素与类同 MainDirectory 里的官方分隔线），
 *   收起 / 展开两种缩进也照官方；远端功能关闭时整行 return null，不会留残余线。
 */
function RemoteTargetRow({ collapsed }: { collapsed: boolean }) {
  const selector = useContext(RemoteTargetContext);
  if (!selector) return null;

  // 与官方分隔线**完全同款**：同一元素、同一套类、同一缩进（见 MainDirectory）。
  // 之前为「看得见」擅自换成 border-strong，那是我自创的、和官方不一致 —— 改回
  // 官方原样的 bg-border，靠留白（选择器行 pb-2 + 本行 mt-0.5）把它和轨道分开。
  const divider = (
    <div
      className={cn(
        "h-px shrink-0 bg-border",
        collapsed ? "mx-[18px] my-1.5" : "mx-4 mb-1.5 mt-0.5",
      )}
    />
  );

  // 收起态（72px 图标轨）不渲染选择器行：
  //  - 轨道放不下「本机 / 服务器 / 容器」两段选择器；
  //  - 若退化成一个图标，会和下面「远程主机」导航项撞成两个一样的图标；
  //  - 收起时切目标走「远程主机」页即可，展开侧栏就恢复选择器。
  if (collapsed) return null;

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center px-4 pb-2 pt-1">
        {selector}
      </div>
      {divider}
    </>
  );
}

function SidebarTopBar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const tipSide = collapsed ? "right" : "left";
  const label = collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar");
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  const toggleButton = (
    <HoverTip content={label} side={tipSide} disableHoverableContent>
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        style={NO_DRAG}
        className="flex h-7 w-7 items-center justify-center rounded-control text-fg-2 transition-[background-color,color,scale] hover:bg-subtle hover:text-fg-1 active:scale-[0.96]"
      >
        <Icon className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </HoverTip>
  );

  // macOS 展开：顶条只放红绿灯；下面一行贴近红绿灯放 logo + 名字，收起箭头放在这一行最右边
  if (!collapsed && isMac()) {
    return (
      <>
        <div
          className="h-11 shrink-0"
          {...DRAG_REGION_ATTR}
          style={DRAG_REGION_STYLE as React.CSSProperties}
        />
        {/* 品牌区与导航之间不画分隔线：靠侧栏底色和留白分开，免得和右侧页头下边框近似平行却差 11px */}
        <div
          className="-mt-[18px] mb-2 flex h-9 shrink-0 items-center gap-2 pe-2 ps-4"
          {...DRAG_REGION_ATTR}
          style={DRAG_REGION_STYLE as React.CSSProperties}
        >
          <img
            src={ccswitchLogo}
            alt=""
            draggable={false}
            className="pointer-events-none h-5 w-5 shrink-0"
          />
          <span className="pointer-events-none me-auto min-w-0 truncate text-strong font-semibold text-fg-1">
            CC Switch
          </span>
          {toggleButton}
        </div>
      </>
    );
  }

  // macOS 的红绿灯占着顶条左边约 70px：图标轨只有 72 宽，按钮挪到顶条下面一行
  if (collapsed && isMac()) {
    return (
      <>
        <div
          className="h-11 shrink-0"
          {...DRAG_REGION_ATTR}
          style={DRAG_REGION_STYLE as React.CSSProperties}
        />
        {/* 往上贴近红绿灯，和展开时品牌行同高（中心 y≈44） */}
        <div className="-mt-4 flex h-8 shrink-0 items-center justify-center">
          {toggleButton}
        </div>
      </>
    );
  }

  return (
    <div
      className={cn(
        "flex h-11 shrink-0 items-center gap-0.5 px-2",
        collapsed ? "justify-center" : "justify-end",
      )}
      {...DRAG_REGION_ATTR}
      style={DRAG_REGION_STYLE as React.CSSProperties}
    >
      {!collapsed && !isMac() && (
        // 左上角品牌（Windows / Linux）：图标 + 名字。macOS 左上角留给红绿灯，不放。
        // 图片不接收指针事件，拖它也是在拖窗口
        <span className="pointer-events-none me-auto flex min-w-0 items-center gap-2 ps-1.5">
          <img
            src={ccswitchLogo}
            alt=""
            draggable={false}
            className="h-[22px] w-[22px] shrink-0"
          />
          <span className="truncate text-strong font-semibold text-fg-1">
            CC Switch
          </span>
        </span>
      )}
      {toggleButton}
    </div>
  );
}

// ─── 主目录 ────────────────────────────────────────────────────────────────

function MainDirectory({
  collapsed,
  activeApp,
  view,
  visibleApps,
  onSelectApp,
  onSelectPage,
  appsUpdateAvailable = false,
}: DirectoryProps) {
  const { t } = useTranslation();
  const { hasUpdate } = useUpdate();
  const { appStatus, todayCost, authNeedsAttention } = useSidebarStatus();
  const apps = APP_IDS.filter((app) => visibleApps[app]);
  const onAppPage = isAppPage(view);

  const todayLabel =
    todayCost > 0
      ? t("nav.todayCost", { cost: fmtUsd(todayCost, 2) })
      : undefined;

  const globals: {
    page: GlobalPage;
    label: string;
    icon: IconComponent;
    trailing?: string;
    alert?: string;
  }[] = [
    // 远程主机管理（本补丁层新增；官方没有远端概念），放全局组第一项：
    // 它是「作用域的管理页」（管哪些机器），和顶部目标选择器是同一件事的两面，
    // 不是 MCP/Skills 那种「内容页」，所以不跟内容页混排、也不该沉到末尾。
    // 远端功能关闭时 App 侧会拦掉该页。
    // 图标用 Terminal（SSH 连到远端 shell 的语义），不用 Globe ——
    // Globe 已被「设置 → 网络」占用，两处撞图标。
    { page: "remote", label: t("nav.remote"), icon: Terminal },
    { page: "mcp", label: "MCP", icon: Server },
    { page: "skills", label: "Skills", icon: SkillsIcon },
    { page: "prompts", label: t("nav.prompts"), icon: BookOpen },
    { page: "sessions", label: t("nav.sessions"), icon: History },
    {
      page: "auth",
      label: t("nav.auth"),
      icon: KeyRound,
      alert: authNeedsAttention ? t("nav.authNeedsReauth") : undefined,
    },
    {
      page: "usage",
      label: t("nav.usage"),
      icon: ChartColumn,
      trailing: todayLabel,
    },
  ];

  const isGlobalSelected = (page: GlobalPage) =>
    view === page || (page === "skills" && view === "skillsDiscovery");

  return (
    <>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2 pt-0.5",
          // 图标轨只有 72 宽，放不下滚动条
          collapsed && "no-scrollbar",
        )}
      >
        <div
          role="group"
          aria-label={t("nav.appsGroup")}
          className="flex shrink-0 flex-col"
        >
          {apps.map((app) => (
            <AppNavItem
              key={app}
              app={app}
              collapsed={collapsed}
              selected={onAppPage && activeApp === app}
              status={appStatus(app)}
              onSelect={() => onSelectApp(app)}
            />
          ))}
        </div>
      </div>

      <div
        className={cn(
          "h-px shrink-0 bg-border",
          collapsed ? "mx-[18px] my-1.5" : "mx-4 mb-1.5 mt-0.5",
        )}
      />

      <div className="flex shrink-0 flex-col">
        {globals.map((item) => (
          <NavItem
            key={item.page}
            collapsed={collapsed}
            selected={isGlobalSelected(item.page)}
            icon={item.icon}
            label={item.label}
            trailing={item.trailing}
            alert={item.alert}
            onClick={() => onSelectPage(item.page)}
          />
        ))}
      </div>

      {/* 和上面那条分隔线同样缩进、上下各留 6px，选中的最后一项不会贴着线 */}
      <div
        className={cn(
          "my-1.5 h-px shrink-0 bg-border",
          collapsed ? "mx-[18px]" : "mx-4",
        )}
      />

      <div
        className={cn(
          "flex shrink-0 pb-2",
          // 收起时竖排，和上面全局项一样无间隙
          collapsed ? "flex-col" : "gap-1 px-2",
        )}
      >
        <NavItem
          collapsed={collapsed}
          compact={!collapsed}
          selected={view === "apps"}
          icon={LayoutGrid}
          label={t("nav.apps")}
          title={
            appsUpdateAvailable ? t("nav.appsHasUpdate") : t("nav.appsTitle")
          }
          dot={appsUpdateAvailable}
          onClick={() => onSelectPage("apps")}
        />
        <NavItem
          collapsed={collapsed}
          compact={!collapsed}
          selected={false}
          icon={Settings}
          label={t("nav.settings")}
          title={hasUpdate ? t("nav.settingsHasUpdate") : t("nav.settings")}
          dot={hasUpdate}
          onClick={() => onSelectPage("settings")}
        />
      </div>
    </>
  );
}

function modeTag(
  status: AppNavStatus,
  t: (key: string) => string,
): { label: string; className: string } | null {
  if (status.mapping) {
    return {
      label: t("nav.mode.mapping"),
      className: "bg-route-soft text-route-text",
    };
  }
  if (status.mode === "route") {
    return {
      label: t("nav.mode.route"),
      className: "bg-route-soft text-route-text",
    };
  }
  if (status.mode === "stack") {
    return {
      label: t("nav.mode.stack"),
      className: "bg-stack-soft text-stack-text",
    };
  }
  return null;
}

function AppNavItem({
  app,
  collapsed,
  selected,
  status,
  onSelect,
}: {
  app: AppId;
  collapsed: boolean;
  selected: boolean;
  status: AppNavStatus;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const name = APP_DISPLAY_NAME[app];
  const tag = modeTag(status, t);
  const modeName = status.mapping
    ? t("nav.mode.mappingFull")
    : status.mode === "route"
      ? t("nav.mode.route")
      : status.mode === "stack"
        ? t("nav.mode.stack")
        : null;
  const tip = status.alert
    ? `${name} · ${t("nav.needsAttention")}`
    : modeName
      ? `${name} · ${modeName}`
      : name;
  const badgeBg = selected ? "bg-selected" : "bg-sidebar";

  if (collapsed) {
    const marker = status.alert
      ? { className: "bg-danger text-action-fg", icon: AlertGlyph }
      : status.mode === "stack"
        ? { className: "bg-stack-solid text-stack-on", icon: Layers }
        : status.mode === "route" || status.mapping
          ? { className: "bg-route-solid text-route-on", icon: Route }
          : null;
    return (
      <HoverTip content={tip} side="right" disableHoverableContent>
        <button
          type="button"
          onClick={onSelect}
          aria-label={tip}
          aria-current={selected ? "page" : undefined}
          className={cn(
            "mx-auto flex h-8 w-12 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-subtle",
            selected && "bg-selected hover:bg-selected",
          )}
        >
          <span className="relative flex">
            <AppGlyph app={app} size={20} badgeClassName={badgeBg} />
            {marker && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -end-[7px] -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2",
                  selected ? "border-selected" : "border-sidebar",
                  marker.className,
                )}
              >
                <marker.icon className="h-2 w-2" strokeWidth={3} />
              </span>
            )}
          </span>
        </button>
      </HoverTip>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "mx-2 flex h-7 w-[184px] shrink-0 items-center gap-2 rounded-control px-2 text-start transition-colors hover:bg-subtle",
        selected && "bg-selected font-medium hover:bg-selected",
      )}
    >
      <AppGlyph app={app} size={16} badgeClassName={badgeBg} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {status.alert ? (
        <span
          role="img"
          aria-label={t("nav.needsAttention")}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
        />
      ) : (
        // 选中的应用不再显示模式标签：页头下面的模式行已经写明
        tag &&
        !selected && (
          <span
            className={cn(
              "h-[18px] whitespace-nowrap rounded-full px-1.5 text-badge leading-[18px]",
              tag.className,
            )}
          >
            {tag.label}
          </span>
        )
      )}
    </button>
  );
}

function AlertGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.5}
      strokeLinecap="round"
      className={className}
    >
      <path d="M12 4v10" />
      <path d="M12 20h.01" />
    </svg>
  );
}

function NavItem({
  collapsed,
  compact = false,
  selected,
  icon: Icon,
  label,
  title,
  trailing,
  alert,
  dot = false,
  endDot = false,
  onClick,
}: {
  collapsed: boolean;
  /** 底栏两格并排：宽度由父级平分 */
  compact?: boolean;
  selected: boolean;
  icon: IconComponent;
  label: string;
  title?: string;
  trailing?: string;
  /** 红点：需要处理，内容是给读屏的说明 */
  alert?: string;
  /** 中性圆点：有更新 */
  dot?: boolean;
  /** 圆点放在行尾（设置目录里的「关于」），而不是图标角上 */
  endDot?: boolean;
  onClick: () => void;
}) {
  const ring = selected ? "border-selected" : "border-sidebar";
  const accessibleName = [label, trailing, alert].filter(Boolean).join(" · ");
  const glyph = (size: number) => (
    <span aria-hidden="true" className="relative flex shrink-0 text-fg-2">
      <Icon className={size === 20 ? "h-5 w-5" : "h-[18px] w-[18px]"} />
      {dot && (collapsed || !endDot) && (
        <span
          className={cn(
            "absolute -end-1 -top-[3px] h-2.5 w-2.5 rounded-full border-2 bg-fg-1",
            ring,
          )}
        />
      )}
      {collapsed && alert && (
        <span
          className={cn(
            "absolute -end-[7px] -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 bg-danger text-action-fg",
            ring,
          )}
        >
          <AlertGlyph className="h-2 w-2" />
        </span>
      )}
    </span>
  );

  if (collapsed) {
    return (
      <HoverTip
        content={title ?? accessibleName}
        side="right"
        disableHoverableContent
      >
        <button
          type="button"
          onClick={onClick}
          aria-label={title ?? accessibleName}
          aria-current={selected ? "page" : undefined}
          className={cn(
            "mx-auto flex h-8 w-12 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-subtle",
            selected && "bg-selected hover:bg-selected",
          )}
        >
          {glyph(20)}
        </button>
      </HoverTip>
    );
  }

  // 展开时名字可见；只有 title 比名字多说了点什么（如「有可用更新」）才挂提示
  return (
    <HoverTip
      content={title !== label ? title : undefined}
      side={compact ? "top" : "right"}
      disableHoverableContent
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-start transition-colors hover:bg-subtle",
          compact ? "min-w-0 flex-1" : "mx-2 w-[184px]",
          selected && "bg-selected font-medium hover:bg-selected",
        )}
      >
        {glyph(18)}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing && (
          <span className="shrink-0 text-caption tabular-nums text-fg-3">
            {trailing}
          </span>
        )}
        {alert && (
          <span
            role="img"
            aria-label={alert}
            title={alert}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
          />
        )}
        {dot && endDot && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-1"
          />
        )}
      </button>
    </HoverTip>
  );
}

// ─── 设置目录 ──────────────────────────────────────────────────────────────

const SETTINGS_ITEMS: { section: SettingsSection; icon: IconComponent }[] = [
  { section: "general", icon: SlidersHorizontal },
  { section: "appConfig", icon: Folder },
  { section: "routing", icon: Route },
  { section: "network", icon: Globe },
  { section: "data", icon: Database },
  { section: "about", icon: Info },
];

function SettingsDirectory({
  collapsed,
  settingsSection,
  onSelectSettingsSection,
  onExitSettings,
}: DirectoryProps) {
  const { t } = useTranslation();
  const { hasUpdate } = useUpdate();
  const { data: version } = useQuery({
    queryKey: ["app-version"],
    queryFn: () => getVersion(),
    staleTime: Infinity,
  });

  return (
    <>
      {collapsed ? (
        <NavItem
          collapsed
          selected={false}
          icon={ArrowLeft}
          label={t("nav.back")}
          onClick={onExitSettings}
        />
      ) : (
        <button
          type="button"
          onClick={onExitSettings}
          className="mx-2 flex h-7 w-[184px] shrink-0 items-center gap-2 rounded-control px-2 text-start text-fg-2 transition-colors hover:bg-subtle hover:text-fg-1"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          {t("nav.back")}
        </button>
      )}
      {!collapsed && (
        <div className="mt-3 px-4 pb-1 text-badge text-fg-3">
          {t("nav.settings")}
        </div>
      )}
      <div
        role="group"
        aria-label={t("nav.settings")}
        className={cn("flex min-h-0 flex-1 flex-col", collapsed && "mt-2")}
      >
        {SETTINGS_ITEMS.map(({ section, icon }) => (
          <NavItem
            key={section}
            collapsed={collapsed}
            selected={settingsSection === section}
            icon={icon}
            label={t(`settings.sections.${section}`)}
            dot={section === "about" && hasUpdate}
            endDot
            title={
              section === "about" && hasUpdate
                ? t("nav.settingsHasUpdate")
                : undefined
            }
            onClick={() => onSelectSettingsSection(section)}
          />
        ))}
      </div>
      {!collapsed && version && (
        <div className="shrink-0 px-4 pb-4 text-caption text-fg-3">
          CC Switch v{version}
        </div>
      )}
    </>
  );
}

export type { SidebarProps };

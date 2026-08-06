//! 悬浮窗（加速球）模块
//!
//! 提供桌面常驻的透明小圆球 + 悬停展开的用量面板：
//! - 小球窗口 `floating-ball`（64×64），置顶、无边框、透明、跳过任务栏，可原生拖动
//! - 面板窗口 `floating-panel`（300×320），悬停小球时在旁展开，列出各 app 当前
//!   供应商 / 模型 / 用量
//!
//! 数据全部通过 `AppState`（db + usage_cache）聚合，不依赖主窗口的 React 状态，
//! 因此轻量模式销毁主窗口后悬浮窗依然独立工作。

use tauri::{Emitter, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::app_config::AppType;
use crate::error::AppError;
use crate::settings::FloatingWindowPosition;
use crate::store::AppState;

pub const BALL_LABEL: &str = "floating-ball";
pub const PANEL_LABEL: &str = "floating-panel";
const BALL_SIZE: f64 = 64.0;
const PANEL_WIDTH: f64 = 300.0;
const PANEL_HEIGHT: f64 = 320.0;
/// 面板与小球之间的间距（逻辑像素）
const PANEL_GAP: f64 = 8.0;
/// 小球→面板跨窗移动时的隐藏宽限期
const HOVER_GRACE_MS: u64 = 300;

/// 悬停状态：小球 / 面板任一处于悬停时面板保持显示
struct FloatingHoverState {
    ball: bool,
    panel: bool,
}

static HOVER_STATE: std::sync::Mutex<FloatingHoverState> =
    std::sync::Mutex::new(FloatingHoverState {
        ball: false,
        panel: false,
    });

/// 球位置落盘防抖门控（镜像 tray::schedule_tray_refresh 的做法）
static POSITION_SAVE_SCHEDULED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// ============================================================
// 拖动（Rust 端全局光标轮询，绕开 WebView 事件）
//
// 原生 startDragging / data-tauri-drag-region 在这个透明置顶窗口上不可靠，
// 前端 pointermove 在按住拖动时也收不到事件。这里改用系统 API：
// - 按下左键（前端 pointerdown 或 Rust WindowEvent::MouseInput）→ 记录起点
// - Rust 循环轮询 GetCursorPos 全局光标 → set_position 移动窗口
// - 松开左键（GetAsyncKeyState 检测 或 前端 pointerup）→ 停止 + 边缘吸附 + 保存
// ============================================================

static FLOATING_DRAGGING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// (起点光标 x, 起点光标 y, 起点窗口 x, 起点窗口 y) —— 均为物理像素
static FLOATING_DRAG_START: std::sync::Mutex<Option<(i32, i32, f64, f64)>> =
    std::sync::Mutex::new(None);
/// 本次拖动是否实际移动了窗口（用于区分单击/拖动）
static FLOATING_DRAG_MOVED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// 取消正在进行的吸附动画（用户再次按下时置 true）
static SNAP_ANIMATION_CANCEL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

const DRAG_POLL_MS: u64 = 8;
/// 边缘吸附阈值（逻辑像素）
const SNAP_THRESHOLD: f64 = 40.0;
/// 判定单击：窗口有任何位移即视为拖动，完全没动才是单击
const CLICK_MOVE_THRESHOLD_PX: f64 = 0.0;
/// 吸附动画默认时长（毫秒）；0 = 立即
const DEFAULT_SNAP_SPEED_MS: u32 = 160;

#[cfg(target_os = "windows")]
fn global_cursor_physical() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut pt) != 0 {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn global_cursor_physical() -> Option<(i32, i32)> {
    None
}

#[cfg(target_os = "windows")]
fn is_left_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON,
    };
    unsafe { GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000 != 0 }
}

#[cfg(not(target_os = "windows"))]
fn is_left_button_down() -> bool {
    false
}

/// 开始拖动：记录起点并启动全局光标轮询循环移动窗口（幂等）
#[tauri::command]
pub async fn floating_drag_begin(app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    // 左键按下进入拖动：先收起面板，避免移动时面板一直展开
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.hide();
    }
    // 取消可能正在进行的吸附动画（用户又按下了）
    SNAP_ANIMATION_CANCEL.store(true, Ordering::Release);

    if FLOATING_DRAGGING.load(Ordering::Acquire) {
        return Ok(());
    }
    let Some(ball) = app.get_webview_window(BALL_LABEL) else {
        return Ok(());
    };
    let Some((cx, cy)) = global_cursor_physical() else {
        return Ok(());
    };
    let pos = ball.outer_position().map_err(|e| e.to_string())?;
    *FLOATING_DRAG_START.lock().unwrap_or_else(|p| p.into_inner()) =
        Some((cx, cy, pos.x as f64, pos.y as f64));
    FLOATING_DRAGGING.store(true, Ordering::Release);
    FLOATING_DRAG_MOVED.store(false, Ordering::Release);
    log::info!("[Floating] 开始拖动");

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if !FLOATING_DRAGGING.load(Ordering::Acquire) {
                break;
            }
            // 左键已松开（可能没收到前端 pointerup）：自行结束
            if !is_left_button_down() {
                FLOATING_DRAGGING.store(false, Ordering::Release);
                finish_drag(&app2);
                break;
            }
            let moved = {
                let guard = FLOATING_DRAG_START.lock().unwrap_or_else(|p| p.into_inner());
                *guard
            };
            if let Some((scx, scy, swx, swy)) = moved {
                if let Some((cx, cy)) = global_cursor_physical() {
                    let nx = swx + (cx - scx) as f64;
                    let ny = swy + (cy - scy) as f64;
                    if (nx - swx).abs() + (ny - swy).abs() > CLICK_MOVE_THRESHOLD_PX {
                        FLOATING_DRAG_MOVED.store(true, Ordering::Release);
                    }
                    if let Some(ball) = app2.get_webview_window(BALL_LABEL) {
                        let _ = ball.set_position(tauri::PhysicalPosition::new(
                            nx.round() as i32,
                            ny.round() as i32,
                        ));
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(DRAG_POLL_MS)).await;
        }
    });
    Ok(())
}

/// 结束拖动（前端 pointerup 通知；轮询循环也会在左键松开时自行结束）
#[tauri::command]
pub async fn floating_drag_end(app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if FLOATING_DRAGGING.swap(false, Ordering::AcqRel) {
        finish_drag(&app);
    }
    Ok(())
}

/// 拖动结束统一收尾：窗口基本没动视为单击（打开主窗口），随后做边缘吸附
fn finish_drag(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    if !FLOATING_DRAG_MOVED.load(Ordering::Acquire) {
        log::info!("[Floating] 单击悬浮球，打开主窗口");
        open_main_window_impl(app);
    }
    snap_and_save_ball_position(app);
}

/// 计算边缘吸附后的目标位置（物理像素，全局坐标）。
/// 全部用物理像素（窗口位置 / 显示器尺寸 / 阈值统一），避免 scale 不一致导致右/下不吸附。
fn compute_snap_target(ball: &WebviewWindow) -> Option<(f64, f64)> {
    let scale = ball.scale_factor().ok()?;
    let pos = ball.outer_position().ok()?;
    let mut px = pos.x as f64;
    let mut py = pos.y as f64;
    let ball_px = BALL_SIZE * scale;
    let thresh_px = SNAP_THRESHOLD * scale;

    if let Some(monitor) = ball.current_monitor().ok().flatten() {
        let mpos = monitor.position();
        let msize = monitor.size();
        let left = mpos.x as f64;
        let top = mpos.y as f64;
        let right = left + msize.width as f64;
        let bottom = top + msize.height as f64;

        if px - left <= thresh_px {
            px = left;
        } else if right - (px + ball_px) <= thresh_px {
            px = right - ball_px;
        }
        if py - top <= thresh_px {
            py = top;
        } else if bottom - (py + ball_px) <= thresh_px {
            py = bottom - ball_px;
        }
        px = px.max(left).min(right - ball_px);
        py = py.max(top).min(bottom - ball_px);
        log::info!(
            "[Floating] 吸附计算: pos=({px:.0},{py:.0}) monitor=({left:.0},{top:.0},{right:.0},{bottom:.0}) scale={scale}"
        );
    }
    Some((px, py))
}

/// 松手吸附：按设置的动画速度平滑吸附到边缘。
/// 速度为 0（关闭）= 不自动吸附，只保存当前位置。
fn snap_and_save_ball_position(app: &tauri::AppHandle) {
    let Some(ball) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    let speed_ms = crate::settings::get_settings()
        .floating_snap_speed_ms
        .unwrap_or(DEFAULT_SNAP_SPEED_MS);
    if speed_ms == 0 {
        // 关闭吸附：不吸附，仅保存当前位置
        if let Ok(pos) = ball.outer_position() {
            save_ball_logical_position(app, pos.x as f64, pos.y as f64);
        }
        return;
    }
    let Some((tx, ty)) = compute_snap_target(&ball) else {
        return;
    };
    animate_ball_snap(app, (tx, ty), speed_ms as u64);
}

/// 保存球位置（物理像素 → 逻辑坐标，供启动时 apply_saved_ball_position 恢复）
fn save_ball_logical_position(app: &tauri::AppHandle, px: f64, py: f64) {
    let Some(ball) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    let Ok(scale) = ball.scale_factor() else {
        return;
    };
    let lx = (px / scale).round();
    let ly = (py / scale).round();
    let _ =
        crate::settings::set_floating_window_position(Some(FloatingWindowPosition { x: lx, y: ly }));
    log::info!("[Floating] 拖动结束，保存位置: ({lx:.0}, {ly:.0})");
}

/// 平滑吸附动画：ease-out 从当前位置插值到目标，结束后保存位置。
/// 用户再次按下（SNAP_ANIMATION_CANCEL）时中止，交给新的拖动。
fn animate_ball_snap(app: &tauri::AppHandle, target: (f64, f64), duration_ms: u64) {
    use std::sync::atomic::Ordering;
    let Some(ball) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    let Ok(start) = ball.outer_position() else {
        return;
    };
    let (sx, sy) = (start.x as f64, start.y as f64);
    let (tx, ty) = target;
    SNAP_ANIMATION_CANCEL.store(false, Ordering::Release);
    let steps = 24u32;
    let interval_ms = (duration_ms / steps as u64).max(1);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for i in 1..=steps {
            if SNAP_ANIMATION_CANCEL.load(Ordering::Acquire) {
                return;
            }
            let t = i as f64 / steps as f64;
            let e = 1.0 - (1.0 - t) * (1.0 - t); // ease-out
            let x = sx + (tx - sx) * e;
            let y = sy + (ty - sy) * e;
            if let Some(ball) = app.get_webview_window(BALL_LABEL) {
                let _ = ball.set_position(tauri::PhysicalPosition::new(
                    x.round() as i32,
                    y.round() as i32,
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
        }
        // 动画结束：精确落在目标并保存
        if let Some(ball) = app.get_webview_window(BALL_LABEL) {
            let _ = ball.set_position(tauri::PhysicalPosition::new(
                tx.round() as i32,
                ty.round() as i32,
            ));
        }
        save_ball_logical_position(&app, tx, ty);
    });
}

// ============================================================
// 窗口创建/销毁
// ============================================================

fn build_floating_window(
    app: &tauri::AppHandle,
    label: &str,
    width: f64,
    height: f64,
) -> Result<WebviewWindow, AppError> {
    let window = WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App("floating.html".into()),
    )
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        // 固定尺寸：禁止用户拖边缘调整大小（避免出现边缘调整光标/误操作）
        .resizable(false)
        .inner_size(width, height)
        .visible(false)
        .build()
        .map_err(|e| AppError::Message(format!("创建悬浮窗 {label} 失败: {e}")))?;
    Ok(window)
}

/// 确保悬浮球 / 面板窗口存在并显示（幂等）。启用开关打开或启动时调用。
pub(crate) fn ensure_floating_window(app: &tauri::AppHandle) {
    let ball_exists = app.get_webview_window(BALL_LABEL).is_some();
    let panel_exists = app.get_webview_window(PANEL_LABEL).is_some();

    // 创建小球窗口（含坐标初始化）
    if !ball_exists {
        let Ok(ball) = build_floating_window(app, BALL_LABEL, BALL_SIZE, BALL_SIZE) else {
            return;
        };
        apply_saved_ball_position(&ball);
        // 不 set_focus：悬浮球常驻桌面，抢焦点会打断用户正在输入/操作的应用
        let _ = ball.show();
        log::info!("[Floating] 悬浮球窗口已创建");
    }

    // 创建面板窗口（保持隐藏，悬停时才显示）
    if !panel_exists {
        if let Ok(panel) = build_floating_window(app, PANEL_LABEL, PANEL_WIDTH, PANEL_HEIGHT) {
            let _ = panel.set_position(tauri::LogicalPosition::new(-20000.0, -20000.0));
            log::info!("[Floating] 面板窗口已创建");
        }
    }
}

/// 应用保存的球位置；无保存位置或位置非法时使用主显示器右下角默认位。
/// 创建后立刻覆盖 window-state 插件可能恢复的旧/坏坐标。
fn apply_saved_ball_position(ball: &WebviewWindow) {
    let saved = crate::settings::get_settings()
        .floating_window_position
        .map(|p| (p.x, p.y))
        .filter(|(x, y)| x.is_finite() && y.is_finite() && *x > -1000.0 && *y > -1000.0);

    let pos = match saved {
        Some((x, y)) => tauri::LogicalPosition::new(x, y),
        None => default_ball_position(ball),
    };
    let _ = ball.set_position(pos);
}

/// 主显示器右下角默认位置（逻辑坐标）
fn default_ball_position(ball: &WebviewWindow) -> tauri::LogicalPosition<f64> {
    let Some(monitor) = ball.primary_monitor().ok().flatten() else {
        return tauri::LogicalPosition::new(200.0, 200.0);
    };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale;
    tauri::LogicalPosition::new(
        (w - BALL_SIZE - 24.0).max(0.0),
        (h - BALL_SIZE - 48.0).max(0.0),
    )
}

/// 销毁悬浮球与面板窗口（开关关闭时）
pub(crate) fn destroy_floating_window(app: &tauri::AppHandle) {
    if let Some(ball) = app.get_webview_window(BALL_LABEL) {
        let _ = ball.destroy();
    }
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.destroy();
    }
    *HOVER_STATE.lock().unwrap_or_else(|p| p.into_inner()) = FloatingHoverState {
        ball: false,
        panel: false,
    };
    log::info!("[Floating] 悬浮窗已销毁");
}

/// 根据设置开关应用悬浮窗状态（save_settings 联动）
pub(crate) fn apply_floating_window_setting(app: &tauri::AppHandle, enabled: bool) {
    if enabled {
        ensure_floating_window(app);
    } else {
        destroy_floating_window(app);
    }
}

/// 小球窗口拖动后的位置落盘（防抖）
pub(crate) fn schedule_position_save(x: f64, y: f64) {
    use std::sync::atomic::Ordering;
    if POSITION_SAVE_SCHEDULED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
        POSITION_SAVE_SCHEDULED.store(false, Ordering::Release);
        if let Err(e) = crate::settings::set_floating_window_position(Some(FloatingWindowPosition {
            x,
            y,
        })) {
            log::warn!("[Floating] 保存球位置失败: {e}");
        } else {
            log::debug!("[Floating] 球位置已保存: ({x:.0}, {y:.0})");
        }
    });
}

/// 退出前立即把球位置落盘（防抖任务可能尚未执行）
pub(crate) fn save_ball_position_now(app: &tauri::AppHandle) {
    let Some((x, y)) = current_ball_position(app) else {
        return;
    };
    if let Err(e) = crate::settings::set_floating_window_position(Some(FloatingWindowPosition { x, y }))
    {
        log::warn!("[Floating] 退出前保存球位置失败: {e}");
    }
}

/// 读取当前球位置（逻辑坐标），用于面板定位。
/// `outer_position` 返回物理像素，必须除以 scale_factor 转成逻辑像素，
/// 否则高 DPI 下 `set_position(LogicalPosition)` 会偏移。
fn current_ball_position(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let ball = app.get_webview_window(BALL_LABEL)?;
    let scale = ball.scale_factor().ok()?;
    let pos = ball.outer_position().ok()?;
    Some((pos.x as f64 / scale, pos.y as f64 / scale))
}

// ============================================================
// 数据聚合
// ============================================================

/// 悬浮窗面板每行条目
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingEntry {
    pub app_type: String,
    pub app_label: &'static str,
    pub provider_name: String,
    /// 是否已设置供应商（未设置时 provider_name 为「未设置」），
    /// 前端据此决定是否给供应商/模型名应用高亮色
    pub has_provider: bool,
    pub model: Option<String>,
    pub usage_summary: Option<String>,
    /// 最高利用率（0-100），供小球状态色
    pub worst_pct: Option<f64>,
    /// 完整用量数据（与主窗口 UsageFooter 展示同一份 UsageCache 结果），
    /// 面板据此渲染「剩余：47.22 CNY」这类余额型详情
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Vec<crate::provider::UsageData>>,
    /// 用量查询时间戳（毫秒），供面板显示「刚刚 / x分钟前」（与主窗口一致）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queried_at: Option<i64>,
}

const UNKNOWN_PROVIDER: &str = "未设置";

fn app_label(app_type: &AppType) -> &'static str {
    match app_type {
        AppType::Claude => "Claude Code",
        AppType::ClaudeDesktop => "Claude Desktop",
        AppType::Codex => "Codex",
        AppType::Gemini => "Gemini",
        AppType::GrokBuild => "Grok Build",
        AppType::OpenCode => "OpenCode",
        AppType::OpenClaw => "OpenClaw",
        AppType::Hermes => "Hermes",
    }
}

/// 尽力解析各 app 当前模型的显示名。
/// OpenClaw 的模型是 app 级配置（agents.defaults.model.primary），其余 app 从
/// provider 的 settings_config 读取各自的模型键。
fn resolve_model(app_type: &AppType, provider: &crate::provider::Provider) -> Option<String> {
    let settings = &provider.settings_config;
    let str_at = |keys: &[&str]| {
        let env = settings.get("env");
        keys.iter().find_map(|k| {
            env.and_then(|e| e.get(*k))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
        })
    };

    match app_type {
        AppType::OpenClaw => crate::openclaw_config::get_agents_defaults()
            .ok()
            .flatten()
            .and_then(|d| d.model.map(|m| m.primary))
            .filter(|s| !s.is_empty()),
        AppType::Claude | AppType::ClaudeDesktop => {
            str_at(&["ANTHROPIC_MODEL"]).map(String::from)
        }
        AppType::Gemini => str_at(&["GEMINI_MODEL"]).map(String::from),
        AppType::Codex => settings
            .get("config")
            .and_then(|v| v.as_str())
            .and_then(crate::codex_config::extract_codex_model)
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// 计算当前 provider 的最高利用率（复用托盘的分组标签逻辑）
fn worst_utilization_pct(
    app_state: &AppState,
    app_type: &AppType,
    provider: &crate::provider::Provider,
    provider_id: &str,
) -> Option<f64> {
    let is_official_provider = provider.category.as_deref() == Some("official");
    let can_use_script = provider.has_usage_script_enabled()
        && (!is_official_provider
            || crate::tray::provider_uses_official_subscription(provider));

    if can_use_script {
        if let Some(Some(result)) = app_state.usage_cache.with_script(
            app_type,
            provider_id,
            |result| -> Option<f64> {
                let data = result.data.as_ref()?;
                let entries: Vec<(&str, f64)> = data
                    .iter()
                    .filter_map(|d| Some((d.plan_name.as_deref()?, crate::tray::tier_pct(d)?)))
                    .collect();
                let parts = crate::tray::labeled_tier_parts(&entries);
                if !parts.is_empty() {
                    return parts.into_iter().map(|(_, u)| u).fold(None, |acc, u| {
                        Some(acc.map_or(u, |a: f64| a.max(u)))
                    });
                }
                entries
                    .first()
                    .map(|(_, u)| *u)
            },
        ) {
            return Some(result);
        }
        if crate::tray::provider_uses_official_subscription(provider) {
            if let Some(Some(quota)) =
                app_state.usage_cache.with_subscription(app_type, |quota| -> Option<f64> {
                    let entries: Vec<(&str, f64)> = quota
                        .tiers
                        .iter()
                        .map(|tier| (tier.name.as_str(), tier.utilization))
                        .collect();
                    let parts = crate::tray::labeled_tier_parts(&entries);
                    parts
                        .into_iter()
                        .map(|(_, u)| u)
                        .fold(None, |acc, u| Some(acc.map_or(u, |a: f64| a.max(u))))
                })
            {
                return Some(quota);
            }
        }
    }
    None
}

/// 取当前 provider 的完整用量数据，供面板展示与主窗口同一份内容。
/// 与 `format_usage_suffix` 同一优先级：脚本缓存优先（`UsageCache.script`
/// 存的就是 queryProviderUsage 的完整 UsageResult），官方订阅兜底时把
/// `quota.tiers` 展平成 UsageData（镜像 provider.rs 的订阅分支）。
fn floating_usage_data(
    app_state: &AppState,
    app_type: &AppType,
    provider: &crate::provider::Provider,
    provider_id: &str,
) -> Option<Vec<crate::provider::UsageData>> {
    let is_official_provider = provider.category.as_deref() == Some("official");
    let can_use_script = provider.has_usage_script_enabled()
        && (!is_official_provider
            || crate::tray::provider_uses_official_subscription(provider));
    if !can_use_script {
        return None;
    }

    if let Some(Some(data)) = app_state
        .usage_cache
        .with_script(app_type, provider_id, |r| r.data.clone())
    {
        if !data.is_empty() {
            return Some(data);
        }
    }

    if crate::tray::provider_uses_official_subscription(provider) {
        if let Some(data) = app_state.usage_cache.with_subscription(
            app_type,
            |q| -> Option<Vec<crate::provider::UsageData>> {
                if !q.success {
                    return None;
                }
                let items: Vec<crate::provider::UsageData> = q
                    .tiers
                    .iter()
                    .map(|tier| crate::provider::UsageData {
                        plan_name: Some(tier.name.clone()),
                        remaining: Some(100.0 - tier.utilization),
                        total: Some(100.0),
                        used: Some(tier.utilization),
                        unit: Some("%".to_string()),
                        is_valid: Some(true),
                        invalid_message: None,
                        extra: tier.resets_at.clone(),
                    })
                    .collect();
                (!items.is_empty()).then_some(items)
            },
        ) {
            return data;
        }
    }

    None
}

/// 取当前 provider 用量查询的时间戳（毫秒），与 `floating_usage_data` 同一前提。
/// 脚本缓存优先；官方订阅兜底读 SubscriptionQuota.queried_at。
fn floating_queried_at(
    app_state: &AppState,
    app_type: &AppType,
    provider: &crate::provider::Provider,
    provider_id: &str,
) -> Option<i64> {
    let is_official_provider = provider.category.as_deref() == Some("official");
    let can_use_script = provider.has_usage_script_enabled()
        && (!is_official_provider
            || crate::tray::provider_uses_official_subscription(provider));
    if !can_use_script {
        return None;
    }

    if let Some(ts) = app_state
        .usage_cache
        .script_queried_at(app_type, provider_id)
    {
        return Some(ts);
    }

    if crate::tray::provider_uses_official_subscription(provider) {
        if let Some(Some(ts)) = app_state
            .usage_cache
            .with_subscription(app_type, |q| q.queried_at)
        {
            return Some(ts);
        }
    }
    None
}

/// 拉取悬浮窗面板数据：每个可见 app 一行（当前供应商 / 模型 / 用量）
#[tauri::command]
pub async fn get_floating_window_data(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<FloatingEntry>, String> {
    let visible_apps = crate::settings::get_settings()
        .visible_apps
        .unwrap_or_default();

    let mut entries = Vec::new();
    for app_type in AppType::all() {
        if !visible_apps.is_visible(&app_type) {
            continue;
        }
        let app_type_str = app_type.as_str();

        let current_id =
            crate::settings::get_effective_current_provider(&state.db, &app_type).unwrap_or(None);

        let (provider_name, model, usage_summary, worst_pct, usage, queried_at, has_provider) =
            match current_id {
                Some(provider_id) => {
                    let provider = state
                        .db
                        .get_provider_by_id(&provider_id, app_type_str)
                        .ok()
                        .flatten();
                    match provider {
                        Some(provider) => {
                            let model = resolve_model(&app_type, &provider);
                            let usage_summary = crate::tray::format_usage_suffix(
                                &state,
                                &app_type,
                                &provider,
                                &provider_id,
                            );
                            let worst_pct =
                                worst_utilization_pct(&state, &app_type, &provider, &provider_id);
                            let usage =
                                floating_usage_data(&state, &app_type, &provider, &provider_id);
                            let queried_at =
                                floating_queried_at(&state, &app_type, &provider, &provider_id);
                            (
                                provider.name.clone(),
                                model,
                                usage_summary,
                                worst_pct,
                                usage,
                                queried_at,
                                true,
                            )
                        }
                        None => {
                            (UNKNOWN_PROVIDER.to_string(), None, None, None, None, None, false)
                        }
                    }
                }
                None => (UNKNOWN_PROVIDER.to_string(), None, None, None, None, None, false),
            };

        entries.push(FloatingEntry {
            app_type: app_type_str.to_string(),
            app_label: app_label(&app_type),
            provider_name,
            has_provider,
            model,
            usage_summary,
            worst_pct,
            usage,
            queried_at,
        });
    }

    log::info!(
        "[Floating] 面板拉取数据: {}",
        entries
            .iter()
            .map(|e| format!("{}={}", e.app_label, e.provider_name))
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(entries)
}

// ============================================================
// 面板显示/隐藏与悬停协调
// ============================================================

/// 计算面板位置：默认在球右侧；贴近右/下边缘时翻转
fn panel_position_for_ball(app: &tauri::AppHandle, ball_pos: (f64, f64)) -> (f64, f64) {
    let monitor = app
        .get_webview_window(BALL_LABEL)
        .and_then(|w| w.current_monitor().ok().flatten());
    let (screen_w, screen_h) = match monitor {
        Some(m) => {
            let size = m.size();
            let scale = m.scale_factor();
            (size.width as f64 / scale, size.height as f64 / scale)
        }
        None => (1920.0, 1080.0),
    };

    let (bx, by) = ball_pos;
    let mut px = bx + BALL_SIZE + PANEL_GAP;
    let mut py = by;

    // 右侧放不下 → 放到左侧
    if px + PANEL_WIDTH > screen_w {
        px = (bx - PANEL_GAP - PANEL_WIDTH).max(0.0);
    }
    // 底部放不下 → 上移
    if py + PANEL_HEIGHT > screen_h {
        py = (screen_h - PANEL_HEIGHT).max(0.0);
    }
    (px.max(0.0), py.max(0.0))
}

/// 悬停小球：定位并显示面板，通知面板拉取数据
#[tauri::command]
pub async fn show_floating_panel(app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    // 拖动中不展开面板（左键按住时鼠标进出小球会重复触发 mouseenter）
    if FLOATING_DRAGGING.load(Ordering::Acquire) {
        return Ok(());
    }
    let Some(ball_pos) = current_ball_position(&app) else {
        return Ok(());
    };
    let Some(panel) = app.get_webview_window(PANEL_LABEL) else {
        return Ok(());
    };

    let (px, py) = panel_position_for_ball(&app, ball_pos);
    let _ = panel.set_position(tauri::LogicalPosition::new(px, py));
    // 不 set_focus：面板纯展示，不抢焦点；Windows 下无焦点窗口仍可接收鼠标事件
    let _ = panel.show();

    let _ = app.emit("floating-data-refresh", ());

    // 面板绝不主动查询 API：用量查询只由主窗口（useUsageQuery / 手动刷新）
    // 和托盘悬停发起，结果写入 UsageCache 后经 usage-cache-updated 事件 +
    // 面板 3s 轮询同步到这里。这里只发事件让面板重新读缓存。
    log::debug!("[Floating] 面板已显示");
    Ok(())
}

/// 隐藏面板
#[tauri::command]
pub async fn hide_floating_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.hide();
    }
    Ok(())
}

/// 更新悬停状态。任一端离开后启动宽限期，宽限期内双方都不悬停才真正隐藏，
/// 避免小球→面板跨窗移动时面板闪没。
#[tauri::command]
pub async fn floating_set_hover(
    app: tauri::AppHandle,
    source: String,
    active: bool,
) -> Result<(), String> {
    {
        let mut state = HOVER_STATE.lock().unwrap_or_else(|p| p.into_inner());
        match source.as_str() {
            "ball" => state.ball = active,
            "panel" => state.panel = active,
            _ => return Ok(()),
        }
    }

    // 只要有任何一端悬停，就取消可能挂起的隐藏
    let hovering = {
        let state = HOVER_STATE.lock().unwrap_or_else(|p| p.into_inner());
        state.ball || state.panel
    };
    if hovering {
        return Ok(());
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(HOVER_GRACE_MS)).await;
        let still_hovering = {
            let state = HOVER_STATE.lock().unwrap_or_else(|p| p.into_inner());
            state.ball || state.panel
        };
        if !still_hovering {
            let _ = hide_floating_panel(app).await;
        }
    });
    Ok(())
}

// ============================================================
// 面板交互
// ============================================================

/// 打开主窗口（命令与单击判定复用）
fn open_main_window_impl(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else if crate::lightweight::is_lightweight_mode() {
        if let Err(e) = crate::lightweight::exit_lightweight_mode(app) {
            log::warn!("[Floating] 退出轻量模式失败: {e}");
        }
    }
}

/// 打开主界面
#[tauri::command]
pub async fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    open_main_window_impl(&app);
    Ok(())
}

/// 关闭悬浮窗：销毁窗口并把设置开关写回关闭
#[tauri::command]
pub async fn disable_floating_window(app: tauri::AppHandle) -> Result<(), String> {
    destroy_floating_window(&app);

    let mut settings = crate::settings::get_settings();
    settings.enable_floating_window = false;
    crate::settings::update_settings(settings).map_err(|e| e.to_string())?;
    log::info!("[Floating] 悬浮窗已关闭");
    Ok(())
}

/// 保存球位置（前端拖动结束后调用；fallback 到 Rust 端 Moved 事件）
#[tauri::command]
pub async fn set_floating_ball_position(
    x: f64,
    y: f64,
) -> Result<(), String> {
    crate::settings::set_floating_window_position(Some(FloatingWindowPosition { x, y }))
        .map_err(|e| e.to_string())
}

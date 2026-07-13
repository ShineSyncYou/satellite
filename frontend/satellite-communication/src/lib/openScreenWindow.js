/**
 * openScreenWindow.js
 *
 * 管理主屏和副屏窗口的打开
 * 支持分屏显示：左侧 3D 主屏、右侧指标副屏
 */

const DEFAULT_WINDOW_FEATURES = Object.freeze({
  width: 1400,
  height: 900,
  top: 60,
  left: 80,
});

/**
 * 构建 window.open() 所需的 windowFeatures 字符串
 * 支持自定义窗口尺寸和位置，带有最小值限制
 */
function buildWindowFeatures(features = {}) {
  const merged = {
    ...DEFAULT_WINDOW_FEATURES,
    ...features,
  };

  return [
    `width=${Math.max(640, Number(merged.width) || DEFAULT_WINDOW_FEATURES.width)}`,
    `height=${Math.max(480, Number(merged.height) || DEFAULT_WINDOW_FEATURES.height)}`,
    `top=${Math.max(0, Number(merged.top) || DEFAULT_WINDOW_FEATURES.top)}`,
    `left=${Math.max(0, Number(merged.left) || DEFAULT_WINDOW_FEATURES.left)}`,
    "resizable=yes",
    "scrollbars=yes",
    "toolbar=no",
    "menubar=no",
    "location=no",
    "status=no",
  ].join(",");
}

/**
 * 打开独立窗口的通用方法
 *
 * @param {string} url - 要打开的页面 URL
 * @param {string} name - 窗口名称（用于复用现有窗口）
 * @param {Object} features - 窗口尺寸和位置配置
 * @returns {Window|null} 打开的窗口对象，失败时返回 null
 */
function openDedicatedWindow(url, name, features) {
  const opened = window.open(url, name, buildWindowFeatures(features));
  if (!opened) {
    return null;
  }
  try {
    opened.focus();
  } catch {
    // 某些浏览器安全策略下可能禁止 focus()，此时忽略
  }
  return opened;
}

function withScenarioQuery(url, scenarioKey) {
  if (!scenarioKey) {
    return url;
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}scenario=${encodeURIComponent(scenarioKey)}`;
}

/**
 * 打开指标副屏窗口
 * 自动布局到屏幕右侧，宽度约占可用屏幕的 48%
 *
 * @returns {Window|null} 副屏窗口对象
 */
export function openMetricsScreenWindow(scenarioKey = "") {
  const screenWidth = window.screen?.availWidth || 1920;
  const screenHeight = window.screen?.availHeight || 1080;
  const width = Math.round(screenWidth * 0.48);
  const height = Math.round(screenHeight * 0.9);
  const left = Math.max(0, screenWidth - width - 24);
  const top = 32;
  return openDedicatedWindow(withScenarioQuery("/metrics.html", scenarioKey), "satsim_metrics_screen", {
    width,
    height,
    left,
    top,
  });
}

/**
 * 打开 3D 主屏窗口
 * 自动布局到屏幕左侧，宽度约占可用屏幕的 66%
 *
 * @returns {Window|null} 主屏窗口对象
 */
export function openMainScreenWindow(scenarioKey = "") {
  const screenWidth = window.screen?.availWidth || 1920;
  const screenHeight = window.screen?.availHeight || 1080;
  const width = Math.round(screenWidth * 0.66);
  const height = Math.round(screenHeight * 0.92);
  const left = 12;
  const top = 24;
  return openDedicatedWindow(withScenarioQuery("/#/run", scenarioKey), "satsim_main_screen", {
    width,
    height,
    left,
    top,
  });
}

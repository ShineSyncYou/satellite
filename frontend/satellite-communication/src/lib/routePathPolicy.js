/**
 * 飞机、地面站等终端只能作为路由起点或终点，不能承担转发。
 * 该兼容层也会清理旧 bundle 中已经生成的终端中继路径。
 */
export function normalizeTerminalOnlyRoute(route, nodeTypeMap) {
  const source = String(route?.source || "");
  const target = String(route?.target || "");
  const path = Array.isArray(route?.path)
    ? route.path.map((nodeId) => String(nodeId))
    : [];
  const endpointsMatch = path.length >= 2
    && path[0] === source
    && path[path.length - 1] === target;
  const hasTerminalRelay = path
    .slice(1, -1)
    .some((nodeId) => nodeTypeMap.get(nodeId) !== "satellite");
  const connected = Boolean(route?.connected)
    && endpointsMatch
    && !hasTerminalRelay;

  return {
    connected,
    path: connected ? path : [],
  };
}

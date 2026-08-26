export const GROUND_STATION_PRESET_OPTIONS = Object.freeze([
  {
    key: "miyun",
    name: "北京密云卫星接收站",
    region: "北京密云",
    lat: 40.451,
    lon: 116.86,
    coordinateNote: "公开站址坐标",
  },
  {
    key: "kashgar",
    name: "新疆喀什卫星接收站",
    region: "新疆喀什",
    lat: 39.505,
    lon: 75.929,
    coordinateNote: "公开站址坐标",
  },
  {
    key: "sanya",
    name: "海南三亚卫星接收站",
    region: "海南三亚",
    lat: 18.313,
    lon: 109.31,
    coordinateNote: "公开站址坐标",
  },
  {
    key: "lijiang",
    name: "云南丽江卫星接收站",
    region: "云南丽江",
    lat: 26.770278,
    lon: 100.067778,
    coordinateNote: "公开项目坐标",
  },
  {
    key: "mohe",
    name: "黑龙江漠河卫星接收站",
    region: "黑龙江漠河",
    lat: 52.97,
    lon: 122.5,
    coordinateNote: "根据公开位置描述设置的参考坐标",
  },
]);

const GROUND_STATION_PRESET_BY_KEY = new Map(
  GROUND_STATION_PRESET_OPTIONS.map((preset) => [preset.key, preset]),
);

export function getGroundStationPresetByKey(key) {
  return GROUND_STATION_PRESET_BY_KEY.get(String(key || "")) || null;
}

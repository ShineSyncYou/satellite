export const AIRPORT_OPTIONS = Object.freeze([
  { code: "TFU", name: "成都天府", city: "成都", lat: 30.319, lon: 104.445 },
  { code: "CTU", name: "成都双流", city: "成都", lat: 30.5785, lon: 103.9471 },
  { code: "PVG", name: "上海浦东", city: "上海", lat: 31.1443, lon: 121.8083 },
  { code: "SHA", name: "上海虹桥", city: "上海", lat: 31.1979, lon: 121.3363 },
  { code: "PEK", name: "北京首都", city: "北京", lat: 40.0799, lon: 116.6031 },
  { code: "PKX", name: "北京大兴", city: "北京", lat: 39.5098, lon: 116.4105 },
  { code: "CAN", name: "广州白云", city: "广州", lat: 23.3924, lon: 113.2988 },
  { code: "SZX", name: "深圳宝安", city: "深圳", lat: 22.6393, lon: 113.8107 },
  { code: "XIY", name: "西安咸阳", city: "西安", lat: 34.4471, lon: 108.7516 },
  { code: "CKG", name: "重庆江北", city: "重庆", lat: 29.7192, lon: 106.6417 },
  { code: "KMG", name: "昆明长水", city: "昆明", lat: 25.1019, lon: 102.9292 },
  { code: "HGH", name: "杭州萧山", city: "杭州", lat: 30.2295, lon: 120.4344 },
  { code: "NKG", name: "南京禄口", city: "南京", lat: 31.742, lon: 118.862 },
  { code: "WUH", name: "武汉天河", city: "武汉", lat: 30.7838, lon: 114.2081 },
  { code: "CGO", name: "郑州新郑", city: "郑州", lat: 34.5197, lon: 113.8409 },
  { code: "CSX", name: "长沙黄花", city: "长沙", lat: 28.1892, lon: 113.2196 },
  { code: "XMN", name: "厦门高崎", city: "厦门", lat: 24.544, lon: 118.1277 },
  { code: "TAO", name: "青岛胶东", city: "青岛", lat: 36.3619, lon: 120.0885 },
  { code: "URC", name: "乌鲁木齐地窝堡", city: "乌鲁木齐", lat: 43.9071, lon: 87.4742 },
  { code: "LXA", name: "拉萨贡嘎", city: "拉萨", lat: 29.2978, lon: 90.9119 },
]);

const AIRPORT_BY_CODE = new Map(AIRPORT_OPTIONS.map((airport) => [airport.code, airport]));

export function getAirportByCode(code) {
  return AIRPORT_BY_CODE.get(String(code || "").toUpperCase()) || null;
}

export function formatAirportLabel(airport) {
  if (!airport) {
    return "--";
  }
  return `${airport.city} · ${airport.name} (${airport.code})`;
}

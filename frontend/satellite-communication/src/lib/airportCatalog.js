const DOMESTIC_AIRPORT_OPTIONS = Object.freeze([
  { code: "TFU", name: "成都天府", city: "成都", country: "中国", lat: 30.319, lon: 104.445 },
  { code: "CTU", name: "成都双流", city: "成都", country: "中国", lat: 30.5785, lon: 103.9471 },
  { code: "PVG", name: "上海浦东", city: "上海", country: "中国", lat: 31.1443, lon: 121.8083 },
  { code: "SHA", name: "上海虹桥", city: "上海", country: "中国", lat: 31.1979, lon: 121.3363 },
  { code: "PEK", name: "北京首都", city: "北京", country: "中国", lat: 40.0799, lon: 116.6031 },
  { code: "PKX", name: "北京大兴", city: "北京", country: "中国", lat: 39.5098, lon: 116.4105 },
  { code: "CAN", name: "广州白云", city: "广州", country: "中国", lat: 23.3924, lon: 113.2988 },
  { code: "SZX", name: "深圳宝安", city: "深圳", country: "中国", lat: 22.6393, lon: 113.8107 },
  { code: "XIY", name: "西安咸阳", city: "西安", country: "中国", lat: 34.4471, lon: 108.7516 },
  { code: "CKG", name: "重庆江北", city: "重庆", country: "中国", lat: 29.7192, lon: 106.6417 },
  { code: "KMG", name: "昆明长水", city: "昆明", country: "中国", lat: 25.1019, lon: 102.9292 },
  { code: "HGH", name: "杭州萧山", city: "杭州", country: "中国", lat: 30.2295, lon: 120.4344 },
  { code: "NKG", name: "南京禄口", city: "南京", country: "中国", lat: 31.742, lon: 118.862 },
  { code: "WUH", name: "武汉天河", city: "武汉", country: "中国", lat: 30.7838, lon: 114.2081 },
  { code: "CGO", name: "郑州新郑", city: "郑州", country: "中国", lat: 34.5197, lon: 113.8409 },
  { code: "CSX", name: "长沙黄花", city: "长沙", country: "中国", lat: 28.1892, lon: 113.2196 },
  { code: "XMN", name: "厦门高崎", city: "厦门", country: "中国", lat: 24.544, lon: 118.1277 },
  { code: "TAO", name: "青岛胶东", city: "青岛", country: "中国", lat: 36.3619, lon: 120.0885 },
  { code: "URC", name: "乌鲁木齐地窝堡", city: "乌鲁木齐", country: "中国", lat: 43.9071, lon: 87.4742 },
  { code: "LXA", name: "拉萨贡嘎", city: "拉萨", country: "中国", lat: 29.2978, lon: 90.9119 },
]);

const INTERNATIONAL_AIRPORT_OPTIONS = Object.freeze([
  { code: "FRA", name: "法兰克福机场", city: "法兰克福", country: "德国", lat: 50.0379, lon: 8.5622 },
  { code: "CDG", name: "巴黎戴高乐机场", city: "巴黎", country: "法国", lat: 49.0097, lon: 2.5479 },
  { code: "IST", name: "伊斯坦布尔机场", city: "伊斯坦布尔", country: "土耳其", lat: 41.2753, lon: 28.7519 },
  { code: "DXB", name: "迪拜国际机场", city: "迪拜", country: "阿联酋", lat: 25.2532, lon: 55.3657 },
  { code: "LAX", name: "洛杉矶国际机场", city: "洛杉矶", country: "美国", lat: 33.9416, lon: -118.4085 },
  { code: "SFO", name: "旧金山国际机场", city: "旧金山", country: "美国", lat: 37.6213, lon: -122.379 },
  { code: "JFK", name: "约翰·F·肯尼迪国际机场", city: "纽约", country: "美国", lat: 40.6413, lon: -73.7781 },
  { code: "SYD", name: "悉尼金斯福德·史密斯机场", city: "悉尼", country: "澳大利亚", lat: -33.9399, lon: 151.1753 },
  { code: "SIN", name: "樟宜机场", city: "新加坡", country: "新加坡", lat: 1.3644, lon: 103.9915 },
  { code: "HND", name: "东京羽田机场", city: "东京", country: "日本", lat: 35.5494, lon: 139.7798 },
  { code: "GRU", name: "圣保罗瓜鲁柳斯国际机场", city: "圣保罗", country: "巴西", lat: -23.4356, lon: -46.4731 },
  { code: "JNB", name: "约翰内斯堡奥利弗·坦博国际机场", city: "约翰内斯堡", country: "南非", lat: -26.1337, lon: 28.242 },
]);

export const AIRPORT_GROUPS = Object.freeze([
  { label: "国内机场", airports: DOMESTIC_AIRPORT_OPTIONS },
  { label: "国际机场", airports: INTERNATIONAL_AIRPORT_OPTIONS },
]);

export const AIRPORT_OPTIONS = Object.freeze(AIRPORT_GROUPS.flatMap((group) => group.airports));

const AIRPORT_BY_CODE = new Map(AIRPORT_OPTIONS.map((airport) => [airport.code, airport]));

export function getAirportByCode(code) {
  return AIRPORT_BY_CODE.get(String(code || "").toUpperCase()) || null;
}

export function formatAirportLabel(airport) {
  if (!airport) {
    return "--";
  }
  const cityText = airport.country && airport.country !== "中国"
    ? `${airport.city}（${airport.country}）`
    : airport.city;
  return `${cityText} · ${airport.name} (${airport.code})`;
}

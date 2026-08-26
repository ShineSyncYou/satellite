<template>
  <div>
    <div class="wizard-map-shell" :style="containerStyle">
      <div ref="containerRef" class="wizard-map-canvas"></div>
      <div class="wizard-map-toolbar">
        <button class="wizard-map-toolbar__button" type="button" @click="resetToChinaView">
          中国视图
        </button>
        <button class="wizard-map-toolbar__button" type="button" @click="resetToGlobalView">
          全球视图
        </button>
        <button
          class="wizard-map-toolbar__button"
          type="button"
          :disabled="!hasLocatableMarker"
          @click="focusCurrentMarker"
        >
          定位当前站点
        </button>
      </div>
    </div>
    <p v-if="hint" style="margin: 8px 0 0; color: rgba(205, 221, 238, 0.8); font-size: 13px;">
      {{ hint }}
    </p>
  </div>
</template>

<script setup>
import * as Cesium from "cesium";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  hint: {
    type: String,
    default: "",
  },
  height: {
    type: Number,
    default: 420,
  },
  markers: {
    type: Array,
    default: () => [],
  },
  polylines: {
    type: Array,
    default: () => [],
  },
  zoomStepRatio: {
    type: Number,
    default: 0.12,
  },
});

const emit = defineEmits(["map-click"]);

const containerRef = ref(null);
const containerStyle = computed(() => ({
  width: "100%",
  height: `${props.height}px`,
  borderRadius: "18px",
  overflow: "hidden",
  background: "rgba(3, 16, 28, 0.75)",
  border: "1px solid rgba(93, 131, 166, 0.28)",
  position: "relative",
}));

let viewer = null;
let clickHandler = null;
let wheelCleanup = null;

const CHINA_VIEW_RECTANGLE = Cesium.Rectangle.fromDegrees(58, 2, 150, 64);
const GLOBAL_VIEW_RECTANGLE = Cesium.Rectangle.fromDegrees(-180, -80, 180, 80);
const hasLocatableMarker = computed(() => props.markers.some((marker) => (
  Number.isFinite(Number(marker?.lat))
  && Number.isFinite(Number(marker?.lon))
  && Number(marker.lat) >= -90
  && Number(marker.lat) <= 90
  && Number(marker.lon) >= -180
  && Number(marker.lon) <= 180
)));

async function addImagery(targetViewer) {
  targetViewer.imageryLayers.removeAll(true);

  try {
    const imageryLayer = new Cesium.UrlTemplateImageryProvider({
      url: "https://webst0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x={x}&y={y}&z={z}",
      subdomains: ["1", "2", "3", "4"],
      maximumLevel: 18,
    });
    const annotationLayer = new Cesium.UrlTemplateImageryProvider({
      url: "https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}&scl=1&ltype=4",
      subdomains: ["1", "2", "3", "4"],
      maximumLevel: 8,
    });
    targetViewer.imageryLayers.addImageryProvider(imageryLayer);
    targetViewer.imageryLayers.addImageryProvider(annotationLayer);
  } catch (error) {
    const fallbackLayer = await Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    );
    targetViewer.imageryLayers.addImageryProvider(fallbackLayer);
    console.warn("任务地图加载高德底图失败，已回退到 NaturalEarthII。", error);
  }
  targetViewer.scene.requestRender();
}

function resetToChinaView() {
  if (!viewer || viewer.isDestroyed()) {
    return;
  }

  // 初始仍展示中国区域，用户可通过工具栏切换至全球视图。
  viewer.camera.flyTo({
    destination: CHINA_VIEW_RECTANGLE,
    duration: 0.45,
  });
}

function resetToGlobalView() {
  if (!viewer || viewer.isDestroyed()) {
    return;
  }

  viewer.camera.flyTo({
    destination: GLOBAL_VIEW_RECTANGLE,
    duration: 0.45,
  });
}

function focusCurrentMarker() {
  if (!viewer || viewer.isDestroyed()) {
    return;
  }

  const marker = props.markers.find((item) => (
    Number.isFinite(Number(item?.lat))
    && Number.isFinite(Number(item?.lon))
    && Number(item.lat) >= -90
    && Number(item.lat) <= 90
    && Number(item.lon) >= -180
    && Number(item.lon) <= 180
  ));
  if (!marker) {
    return;
  }

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(Number(marker.lon), Number(marker.lat), 2500000),
    duration: 0.45,
  });
}

function bindWheelZoom(targetViewer) {
  const canvas = targetViewer.scene.canvas;

  const handleWheel = (event) => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    event.preventDefault();

    const currentHeight = viewer.camera.positionCartographic?.height || 4000000;
    const zoomAmount = Math.max(currentHeight * Number(props.zoomStepRatio || 0.12), 30000);

    if (event.deltaY > 0) {
      viewer.camera.zoomOut(zoomAmount);
    } else {
      viewer.camera.zoomIn(zoomAmount);
    }

    viewer.scene.requestRender();
  };

  canvas.addEventListener("wheel", handleWheel, { passive: false });
  wheelCleanup = () => {
    canvas.removeEventListener("wheel", handleWheel);
  };
}

function configureScene(targetViewer) {
  const { scene } = targetViewer;

  scene.mode = Cesium.SceneMode.SCENE2D;
  scene.morphTo2D(0);
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#081521");
  scene.backgroundColor = Cesium.Color.fromCssColorString("#06101a");
  scene.fog.enabled = false;

  // 地图只保留平移和缩放，禁用旋转/倾斜，让点选更接近普通平面地图。
  const controller = scene.screenSpaceCameraController;
  controller.enableRotate = false;
  controller.enableTilt = false;
  controller.enableLook = false;
  controller.enableCollisionDetection = false;
  controller.enableZoom = false;
  controller.minimumZoomDistance = 700000;
  controller.maximumZoomDistance = 50000000;
}

function syncGraphics() {
  if (!viewer || viewer.isDestroyed()) {
    return;
  }

  viewer.entities.removeAll();

  for (const marker of props.markers) {
    viewer.entities.add({
      id: marker.id,
      position: Cesium.Cartesian3.fromDegrees(marker.lon, marker.lat, 0),
      point: {
        pixelSize: Number(marker.pixelSize || 10),
        color: Cesium.Color.fromCssColorString(marker.color || "#5eead4"),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
      },
      label: marker.label
        ? {
            text: marker.label,
            font: "14px Segoe UI",
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -18),
          }
        : undefined,
    });
  }

  for (const polyline of props.polylines) {
    viewer.entities.add({
      id: polyline.id,
      polyline: {
        positions: polyline.positions,
        width: Number(polyline.width || 3),
        material: Cesium.Color.fromCssColorString(polyline.color || "#72f0ff"),
        clampToGround: true,
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
  }

  viewer.scene.requestRender();
}

function handleLeftClick(event) {
  if (!viewer || viewer.isDestroyed()) {
    return;
  }
  const cartesian = viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid)
    || viewer.scene.globe.pick(viewer.camera.getPickRay(event.position), viewer.scene);
  if (!cartesian) {
    return;
  }
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  const lat = Cesium.Math.toDegrees(cartographic.latitude);
  const rawLon = Cesium.Math.toDegrees(cartographic.longitude);
  const lon = ((((rawLon + 180) % 360) + 360) % 360) - 180;

  emit("map-click", {
    lat,
    lon,
  });
}

function initViewer() {
  if (!containerRef.value || viewer) {
    return;
  }

  viewer = new Cesium.Viewer(containerRef.value, {
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    shouldAnimate: false,
    sceneMode: Cesium.SceneMode.SCENE2D,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    imageryProvider: false,
    skyBox: false,
    skyAtmosphere: false,
    sun: false,
    moon: false,
    requestRenderMode: true,
  });

  viewer.cesiumWidget.creditContainer.style.display = "none";
  configureScene(viewer);

  addImagery(viewer);
  resetToChinaView();
  bindWheelZoom(viewer);

  clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction(handleLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  syncGraphics();
}

function destroyViewer() {
  if (wheelCleanup) {
    wheelCleanup();
    wheelCleanup = null;
  }
  if (clickHandler) {
    clickHandler.destroy();
    clickHandler = null;
  }
  if (viewer && !viewer.isDestroyed()) {
    viewer.destroy();
  }
  viewer = null;
}

watch(
  () => [props.markers, props.polylines],
  () => {
    syncGraphics();
  },
  { deep: true },
);

onMounted(() => {
  initViewer();
});

onBeforeUnmount(() => {
  destroyViewer();
});
</script>

<style scoped>
.wizard-map-shell {
  position: relative;
}

.wizard-map-canvas {
  width: 100%;
  height: 100%;
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='3.2' fill='%2324b3ff' stroke='%23d9efff' stroke-width='1.2'/%3E%3C/svg%3E") 8 8, pointer;
}

.wizard-map-toolbar {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.wizard-map-toolbar__button {
  border: 1px solid rgba(116, 193, 255, 0.34);
  background: rgba(7, 20, 33, 0.82);
  color: #d9efff;
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  backdrop-filter: blur(10px);
  transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

.wizard-map-toolbar__button:hover {
  background: rgba(13, 34, 54, 0.92);
  border-color: rgba(116, 193, 255, 0.58);
  transform: translateY(-1px);
}

.wizard-map-toolbar__button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
}
</style>

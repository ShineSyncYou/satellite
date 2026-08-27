import * as Cesium from "cesium";
import { WORLD_MAP_CITIES } from "./worldCapitalCatalog.js";

// 中国居中动画落点受椭球和俯仰角影响会略高于 6300 km，预留 50 km 防止边界闪烁。
export const CAPITAL_LABEL_MAX_CAMERA_HEIGHT_M = 6_350_000;
export const CAPITAL_LABEL_FIXED_SIZE_CAMERA_HEIGHT_M = 3_000_000;

const CAPITAL_POSITION_HEIGHT_M = 1_500;
const CAPITAL_LABEL_NEAR_SCALE = 1.12;
const UPDATE_INTERVAL_MS = 100;
const LABEL_FONT = '14px "Microsoft YaHei", "PingFang SC", sans-serif';
const LABEL_BOX_HEIGHT_PX = 29;
const LABEL_BOX_GAP_PX = 5;
const LABEL_HORIZONTAL_PADDING_PX = 8;

function createCapitalMarkerCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 24;
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.beginPath();
  context.arc(12, 12, 8, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = "#ff5261";
  context.stroke();

  context.beginPath();
  context.arc(12, 12, 2.6, 0, Math.PI * 2);
  context.fillStyle = "#ff5261";
  context.fill();
  return canvas;
}

function boxesOverlap(left, right) {
  return left.left < right.right + LABEL_BOX_GAP_PX
    && left.right + LABEL_BOX_GAP_PX > right.left
    && left.top < right.bottom + LABEL_BOX_GAP_PX
    && left.bottom + LABEL_BOX_GAP_PX > right.top;
}

function estimateLabelWidth(text) {
  return Math.max(30, Array.from(text).length * 14 + LABEL_HORIZONTAL_PADDING_PX * 2);
}

function getCapitalLabelScale(cameraHeight) {
  if (cameraHeight <= CAPITAL_LABEL_FIXED_SIZE_CAMERA_HEIGHT_M) {
    return CAPITAL_LABEL_NEAR_SCALE;
  }
  const zoomProgress = Cesium.Math.clamp(
    (CAPITAL_LABEL_MAX_CAMERA_HEIGHT_M - cameraHeight)
      / (CAPITAL_LABEL_MAX_CAMERA_HEIGHT_M - CAPITAL_LABEL_FIXED_SIZE_CAMERA_HEIGHT_M),
    0,
    1,
  );
  return Cesium.Math.lerp(1, CAPITAL_LABEL_NEAR_SCALE, zoomProgress);
}

/**
 * 在主 Cesium Viewer 上挂载国外首都标注。
 * @param {Cesium.Viewer} viewer
 * @returns {() => void} 清理函数
 */
export function attachWorldCapitalLabels(viewer) {
  if (!viewer || viewer.isDestroyed() || typeof document === "undefined") {
    return () => {};
  }

  const { scene } = viewer;
  const labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
  const billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  const markerImage = createCapitalMarkerCanvas();

  const items = WORLD_MAP_CITIES.map((city) => {
    const position = Cesium.Cartesian3.fromDegrees(
      city.lon,
      city.lat,
      CAPITAL_POSITION_HEIGHT_M,
    );
    const billboard = billboards.add({
      id: `${city.id}-marker`,
      position,
      image: markerImage,
      width: 10,
      height: 10,
      scale: 1,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      pixelOffset: new Cesium.Cartesian2(0, 2),
      show: false,
    });
    const label = labels.add({
      id: city.id,
      position,
      text: city.name,
      font: LABEL_FONT,
      scale: 1,
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.92),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: false,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -7),
      show: false,
    });

    return {
      city,
      position,
      label,
      billboard,
      estimatedWidth: estimateLabelWidth(city.name),
    };
  });

  let disposed = false;
  let lastUpdateAt = Number.NEGATIVE_INFINITY;

  const hideAll = () => {
    for (const item of items) {
      item.label.show = false;
      item.billboard.show = false;
    }
  };

  const updateVisibility = () => {
    if (disposed || viewer.isDestroyed()) {
      return;
    }

    const cameraHeight = Number(viewer.camera.positionCartographic?.height);
    if (!Number.isFinite(cameraHeight) || cameraHeight > CAPITAL_LABEL_MAX_CAMERA_HEIGHT_M) {
      hideAll();
      return;
    }

    const canvasWidth = scene.canvas.clientWidth || scene.canvas.width;
    const canvasHeight = scene.canvas.clientHeight || scene.canvas.height;
    const centerX = canvasWidth / 2;
    const centerY = canvasHeight / 2;
    const labelScale = getCapitalLabelScale(cameraHeight);
    const ellipsoidOccluder = scene.mode === Cesium.SceneMode.SCENE3D
      ? new Cesium.EllipsoidalOccluder(scene.globe.ellipsoid, viewer.camera.positionWC)
      : null;
    const candidates = [];

    hideAll();
    for (const item of items) {
      item.label.scale = labelScale;
      item.billboard.scale = labelScale;
      if (ellipsoidOccluder && !ellipsoidOccluder.isPointVisible(item.position)) {
        continue;
      }

      const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(scene, item.position);
      if (!windowPosition
        || windowPosition.x < -item.estimatedWidth
        || windowPosition.x > canvasWidth + item.estimatedWidth
        || windowPosition.y < -LABEL_BOX_HEIGHT_PX
        || windowPosition.y > canvasHeight + LABEL_BOX_HEIGHT_PX) {
        continue;
      }

      const halfWidth = item.estimatedWidth * labelScale / 2;
      candidates.push({
        item,
        centerDistanceSquared: ((windowPosition.x - centerX) ** 2) + ((windowPosition.y - centerY) ** 2),
        box: {
          left: windowPosition.x - halfWidth,
          right: windowPosition.x + halfWidth,
          top: windowPosition.y - LABEL_BOX_HEIGHT_PX * labelScale,
          bottom: windowPosition.y + 7 * labelScale,
        },
      });
    }

    candidates.sort((left, right) => (
      Number(left.item.city.kind !== "capital") - Number(right.item.city.kind !== "capital")
      || left.centerDistanceSquared - right.centerDistanceSquared
      || left.item.city.id.localeCompare(right.item.city.id)
    ));

    const occupiedBoxes = [];
    for (const candidate of candidates) {
      if (occupiedBoxes.some((box) => boxesOverlap(candidate.box, box))) {
        continue;
      }
      candidate.item.label.show = true;
      candidate.item.billboard.show = true;
      occupiedBoxes.push(candidate.box);
    }
  };

  const onPostRender = () => {
    const now = performance.now();
    if (now - lastUpdateAt < UPDATE_INTERVAL_MS) {
      return;
    }
    lastUpdateAt = now;
    updateVisibility();
  };

  scene.postRender.addEventListener(onPostRender);
  updateVisibility();

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    scene.postRender.removeEventListener(onPostRender);
    if (!viewer.isDestroyed()) {
      scene.primitives.remove(labels);
      scene.primitives.remove(billboards);
      scene.requestRender();
    }
  };
}

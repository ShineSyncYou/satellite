<template>
  <ProductScaffold>
    <section class="welcome-stage">
      <div class="welcome-stage__backdrop"></div>
      <div id="landingBgGlobe" class="welcome-stage__globe" aria-hidden="true"></div>

      <div class="welcome-stage__hero">
        <div class="welcome-stage__badge">MISSION CONTROL SYSTEM</div>

        <h1 class="welcome-stage__title">
          欢迎进入<br />
          卫星通信仿真<br />
          <span>可视化平台</span>
        </h1>

        <p class="welcome-stage__subtitle">
          面向空天地一体通信场景的仿真与展示平台，支持导入现有场景或从 TLE 新建仿真任务。
        </p>
      </div>

      <div class="welcome-stage__cards">
        <article class="welcome-card">
          <div class="welcome-card__icon">
            <AppIcon name="create" />
          </div>
          <h2>新建仿真任务</h2>
          <p>从 TLE 上传、轨迹规划、地面站选择到参数配置，逐步创建一套新的卫星通信仿真任务。</p>
          <button class="v2-button" @click="$router.push({ name: 'wizard-tle' })">开始新建</button>
        </article>

        <article class="welcome-card">
          <div class="welcome-card__icon">
            <AppIcon name="import" />
          </div>
          <h2>导入现有场景</h2>
          <p>上传场景文件后，直接进入主屏和参数副屏进行演示与预览。</p>
          <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'import' })">导入场景</button>
        </article>
      </div>

    </section>
  </ProductScaffold>
</template>

<script setup>
import * as Cesium from "cesium";
import { onBeforeUnmount, onMounted } from "vue";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import AppIcon from "../components/icons/AppIcon.vue";
import "../Widgets/widgets.css";

let landingViewer = null;
let removeLandingRotate = null;
let landingRotateFrame = 0;

async function addLandingImagery(viewer) {
  viewer.imageryLayers.removeAll(true);
  const provider = await Cesium.TileMapServiceImageryProvider.fromUrl(
    Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
  );
  viewer.imageryLayers.addImageryProvider(provider);
}

async function initLandingGlobe() {
  if (landingViewer && !landingViewer.isDestroyed()) {
    return;
  }

  landingViewer = new Cesium.Viewer("landingBgGlobe", {
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
    shouldAnimate: true,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    imageryProvider: false,
    skyBox: false,
    skyAtmosphere: false,
    sun: false,
    moon: false,
    scene3DOnly: true,
    requestRenderMode: true,
  });

  landingViewer.cesiumWidget.creditContainer.style.display = "none";
  landingViewer.scene.backgroundColor = Cesium.Color.TRANSPARENT;
  landingViewer.scene.globe.enableLighting = false;
  landingViewer.scene.fog.enabled = false;
  landingViewer.scene.globe.showGroundAtmosphere = true;
  landingViewer.scene.globe.dynamicAtmosphereLighting = false;
  landingViewer.scene.globe.dynamicAtmosphereLightingFromSun = false;
  landingViewer.scene.globe.atmosphereLightIntensity = 2.8;
  landingViewer.scene.globe.atmosphereBrightnessShift = 0.08;
  landingViewer.scene.globe.atmosphereHueShift = -0.02;
  landingViewer.scene.globe.atmosphereSaturationShift = 0.12;
  landingViewer.scene.globe.baseColor = new Cesium.Color(0.09, 0.17, 0.28, 1);
  landingViewer.scene.highDynamicRange = true;
  landingViewer.scene.screenSpaceCameraController.enableInputs = false;
  landingViewer.scene.screenSpaceCameraController.enableZoom = false;
  landingViewer.scene.screenSpaceCameraController.enableTilt = false;
  landingViewer.scene.screenSpaceCameraController.enableRotate = false;
  landingViewer.scene.screenSpaceCameraController.enableTranslate = false;
  landingViewer.scene.screenSpaceCameraController.enableLook = false;

  await addLandingImagery(landingViewer);
  landingViewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(104.0, 18.0, 20500000),
    orientation: {
      heading: Cesium.Math.toRadians(12),
      pitch: Cesium.Math.toRadians(-88),
      roll: 0,
    },
    duration: 0,
  });

  let cameraLongitude = 104.0;
  const cameraLatitude = 18.0;
  const cameraHeight = 20500000;
  const heading = Cesium.Math.toRadians(12);
  const pitch = Cesium.Math.toRadians(-88);
  const orbitDegreesPerSecond = 2.0;
  const frameIntervalMs = 1000 / 24;
  let lastFrameTime = performance.now();
  let lastRenderTime = lastFrameTime;
  const rotateLandingGlobe = (now) => {
    if (!landingViewer || landingViewer.isDestroyed()) {
      return;
    }

    const elapsedMs = now - lastRenderTime;
    if (elapsedMs < frameIntervalMs) {
      landingRotateFrame = requestAnimationFrame(rotateLandingGlobe);
      return;
    }

    const deltaSeconds = Math.min((now - lastFrameTime) / 1000, 0.12);
    lastFrameTime = now;
    lastRenderTime = now;
    cameraLongitude = (cameraLongitude + orbitDegreesPerSecond * deltaSeconds) % 360;
    landingViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(cameraLongitude, cameraLatitude, cameraHeight),
      orientation: {
        heading,
        pitch,
        roll: 0,
      },
    });
    landingViewer.scene.requestRender();
    landingRotateFrame = requestAnimationFrame(rotateLandingGlobe);
  };

  landingRotateFrame = requestAnimationFrame(rotateLandingGlobe);
  removeLandingRotate = () => {
    cancelAnimationFrame(landingRotateFrame);
    landingRotateFrame = 0;
  };
}

function destroyLandingGlobe() {
  if (removeLandingRotate) {
    removeLandingRotate();
    removeLandingRotate = null;
  }
  if (landingViewer && !landingViewer.isDestroyed()) {
    landingViewer.destroy();
  }
  landingViewer = null;
}

onMounted(async () => {
  await initLandingGlobe();
});

onBeforeUnmount(() => {
  destroyLandingGlobe();
});
</script>

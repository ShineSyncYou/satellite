<template>
  <ProductScaffold>
    <section class="page-section narrow">
      <div class="page-section__head">
        <div>
          <h1 class="page-title">导入现有场景</h1>
        </div>
      </div>

      <div class="form-grid">
        <label class="v2-field">
          <span>场景标题</span>
          <input v-model="title" type="text" placeholder="例如：中国区域 Busy 演示" />
        </label>
      </div>

      <div class="form-grid two-up">
        <label class="upload-card">
          <span class="upload-card__label">render.czml</span>
          <input type="file" accept=".czml,.json" @change="onPickRender" />
          <strong>{{ renderFileName || "选择 render.czml 文件" }}</strong>
          <small>要求为合法 CZML 数组。</small>
        </label>

        <label class="upload-card">
          <span class="upload-card__label">bundle.json</span>
          <input type="file" accept=".json" @change="onPickBundle" />
          <strong>{{ bundleFileName || "选择 bundle.json 文件" }}</strong>
          <small>要求至少包含 metadata 与 node_tracks。</small>
        </label>
      </div>

      <div v-if="errorText" class="state-banner error">{{ errorText }}</div>

      <div class="page-actions">
        <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'library' })">返回配置库</button>
        <button class="v2-button" :disabled="submitting" @click="submitImport">{{ submitting ? "导入中..." : "导入并进入主屏" }}</button>
      </div>
    </section>
  </ProductScaffold>
</template>

<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import { refreshServerScenarioRecords } from "../lib/runtimeScenarioCatalog";
import { importServerScenario } from "../lib/simulationAdapter";

const router = useRouter();
const title = ref("");
const renderFileName = ref("");
const bundleFileName = ref("");
const renderPayload = ref(null);
const bundlePayload = ref(null);
const submitting = ref(false);
const errorText = ref("");

async function parseJsonFile(file) {
  const text = await file.text();
  return JSON.parse(text);
}

async function onPickRender(event) {
  try {
    errorText.value = "";
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = await parseJsonFile(file);
    if (!Array.isArray(parsed)) throw new Error("render.czml 必须是 JSON 数组。");
    renderPayload.value = parsed;
    renderFileName.value = file.name;
    if (!title.value) title.value = file.name.replace(/\.render\.czml$/i, "").replace(/\.czml$/i, "");
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
  }
}

async function onPickBundle(event) {
  try {
    errorText.value = "";
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = await parseJsonFile(file);
    if (!parsed?.metadata || !Array.isArray(parsed?.node_tracks)) {
      throw new Error("bundle.json 结构不合法，缺少 metadata 或 node_tracks。");
    }
    bundlePayload.value = parsed;
    bundleFileName.value = file.name;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
  }
}

async function submitImport() {
  try {
    errorText.value = "";
    if (!renderPayload.value || !bundlePayload.value) {
      throw new Error("请先选择 render.czml 和 bundle.json。");
    }
    submitting.value = true;
    const record = await importServerScenario({
      title: title.value.trim(),
      czmlPayload: renderPayload.value,
      bundlePayload: bundlePayload.value,
      sourceName: renderFileName.value,
    });
    await refreshServerScenarioRecords().catch(() => []);
    router.push({ name: "run", query: { scenario: record.id } });
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.upload-card strong {
  display: block;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.45;
}

.page-actions {
  align-items: stretch;
}

.page-actions .v2-button {
  display: inline-flex;
  align-items: center;
  min-width: 160px;
  justify-content: center;
  text-align: center;
}

@media (max-width: 720px) {
  .page-actions .v2-button {
    width: 100%;
  }
}
</style>

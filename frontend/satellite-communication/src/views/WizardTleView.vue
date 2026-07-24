<template>
  <ProductScaffold>
    <section class="page-section narrow wizard-page-section">
      <div class="page-section__head">
        <div>
          <p class="page-eyebrow">轨道数据导入</p>
          <h1 class="page-title">步骤 1 · TLE 导入</h1>
          <p class="page-subtitle">上传 `.tle/.txt` 文件或直接粘贴 TLE 内容，低轨名称使用 PREFIX_轨道面_槽位，高轨名称使用 PREFIX_GEO_编号。</p>
        </div>
      </div>

      <div class="wizard-stepper">
        <span class="active">01 TLE 导入</span>
        <span>02 飞机轨迹规划</span>
        <span>03 地面站选择</span>
        <span>04 仿真参数</span>
      </div>

      <label class="upload-card tle-file-picker">
        <input name="tleFile" type="file" accept=".tle,.txt" @change="onFilePick" />
        <span class="tle-file-picker__button">选择 TLE 文件</span>
        <span class="tle-file-picker__content">
          <span class="upload-card__label">TLE 文件</span>
          <strong>{{ fileName || "尚未选择文件" }}</strong>
          <small>支持 `.txt`、`.tle` 或原始 Two-Line Element 文本。</small>
        </span>
      </label>

      <label class="v2-field">
        <span>TLE 文本</span>
        <textarea
          v-model="tleText"
          class="wizard-tle-textarea"
          name="tleText"
          rows="10"
          placeholder="在这里粘贴 TLE 内容"
        ></textarea>
      </label>

      <label class="v2-field">
        <span>任务标题</span>
        <input v-model="title" name="taskTitle" type="text" placeholder="例如：中国区域链路演示" />
      </label>

      <div class="v2-helper-card stack-gap">
        <h3>TLE 校验结果</h3>
        <p>{{ validation.message }}</p>
        <p>识别卫星数量：{{ validation.satelliteCount }}</p>
        <p v-if="validation.sampleNames?.length">名称样例：{{ validation.sampleNames.join("、") }}</p>
      </div>

      <div v-if="errorText" class="state-banner error">{{ errorText }}</div>

      <div class="page-actions">
        <button class="v2-button v2-button--ghost" @click="$router.push({ name: 'landing' })">取消</button>
        <button class="v2-button" @click="goNext">进入下一步</button>
      </div>
    </section>
  </ProductScaffold>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import ProductScaffold from "../components/layout/ProductScaffold.vue";
import { validateAutoWalkerTle } from "../lib/wizardScenarioBuilder";
import { getWizardDraft, updateWizardDraft } from "../lib/wizardDraft";

const router = useRouter();
const draft = getWizardDraft();
const tleText = ref(draft.tleText || "");
const fileName = ref(draft.tleFileName || "");
const title = ref(draft.title || "");
const errorText = ref("");

const validation = computed(() => validateAutoWalkerTle(tleText.value));

watch(
  [tleText, fileName, title, validation],
  ([nextTleText, nextFileName, nextTitle, nextValidation]) => {
    updateWizardDraft({
      tleText: nextTleText,
      tleFileName: nextFileName,
      title: nextTitle,
      satMappingStrategy: "auto-walker-name",
      tleValidation: nextValidation,
    });
  },
  { immediate: true },
);

async function onFilePick(event) {
  errorText.value = "";
  const file = event.target.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  tleText.value = await file.text();
  title.value = file.name.replace(/\.(tle|txt)$/i, "");
}

function goNext() {
  errorText.value = "";
  if (!tleText.value.trim()) {
    errorText.value = "请先导入 TLE 文件或粘贴 TLE 文本。";
    return;
  }
  if (!validation.value.isValid) {
    errorText.value = validation.value.message;
    return;
  }
  if (!title.value.trim()) {
    errorText.value = "请填写任务标题。";
    return;
  }

  updateWizardDraft({
    title: title.value.trim(),
    tleText: tleText.value,
    tleFileName: fileName.value,
    satMappingStrategy: "auto-walker-name",
    tleValidation: validation.value,
  });
  router.push({ name: "wizard-trajectory" });
}
</script>

<style scoped>
.wizard-page-section {
  max-width: 1820px;
}

.wizard-tle-textarea {
  resize: none;
}

.tle-file-picker {
  position: relative;
  display: flex;
  min-height: 108px;
  align-items: center;
  gap: 18px;
  padding: 18px 20px;
  border: 1px solid rgba(137, 206, 255, 0.2);
  border-radius: 16px;
  background: linear-gradient(110deg, rgba(15, 39, 60, 0.74), rgba(7, 21, 36, 0.7));
  box-shadow: none;
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.tle-file-picker:hover,
.tle-file-picker:focus-within {
  border-color: rgba(73, 185, 255, 0.58);
  background: linear-gradient(110deg, rgba(18, 49, 74, 0.84), rgba(7, 24, 40, 0.8));
}

.tle-file-picker input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.tle-file-picker__button {
  display: inline-flex;
  min-width: 126px;
  min-height: 42px;
  align-items: center;
  justify-content: center;
  padding: 0 15px;
  border: 1px solid rgba(137, 206, 255, 0.3);
  border-radius: 10px;
  background: rgba(36, 179, 255, 0.12);
  color: #c3e9ff;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}

.tle-file-picker__content {
  display: grid;
  min-width: 0;
  gap: 6px;
}

.tle-file-picker__content strong {
  overflow-wrap: anywhere;
}

.tle-file-picker__content small {
  color: var(--v2-text-muted);
}

@media (max-width: 640px) {
  .tle-file-picker {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
</style>

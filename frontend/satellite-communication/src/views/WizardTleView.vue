<template>
  <ProductScaffold>
    <section class="page-section narrow wizard-page-section">
      <div class="page-section__head">
        <div>
          <p class="page-eyebrow">轨道数据导入</p>
          <h1 class="page-title">步骤 1 · TLE 导入</h1>
          <p class="page-subtitle">上传 `.tle/.txt` 文件或直接粘贴 TLE 内容，首版仅接受满足 Walker/GW2 命名规则的星座名称。</p>
        </div>
      </div>

      <div class="wizard-stepper">
        <span class="active">01 TLE 导入</span>
        <span>02 飞机轨迹规划</span>
        <span>03 地面站选择</span>
        <span>04 仿真参数</span>
      </div>

      <label class="upload-card upload-card--large">
        <span class="upload-card__label">TLE 文件</span>
        <input name="tleFile" type="file" accept=".tle,.txt" @change="onFilePick" />
        <strong>{{ fileName || "选择 TLE 文件" }}</strong>
        <small>支持 `.txt`、`.tle` 或原始 Two-Line Element 文本。</small>
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
</style>

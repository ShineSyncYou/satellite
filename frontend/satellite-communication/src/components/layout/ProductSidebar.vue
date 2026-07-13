<template>
  <aside class="v2-sidebar" :class="{ 'v2-sidebar--collapsed': collapsed }">
    <div class="v2-sidebar__top">
      <div class="v2-sidebar__section">
        <div class="v2-sidebar__eyebrow">任务控制中心</div>
        <div class="v2-sidebar__status">平台导航与快捷入口</div>
      </div>

      <div class="v2-sidebar__menu">
        <button
          v-for="item in items"
          :key="item.label"
          class="v2-sidebar__item"
          :class="{ active: item.active }"
          :title="collapsed ? item.label : ''"
          @click="item.onClick"
        >
          <span class="v2-sidebar__item-icon">
            <AppIcon :name="item.icon" />
          </span>
          <span class="v2-sidebar__item-label">{{ item.label }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "../icons/AppIcon.vue";

defineProps({
  collapsed: {
    type: Boolean,
    default: false,
  },
});

const route = useRoute();
const router = useRouter();

const items = computed(() => [
  { icon: "home", label: "欢迎首页", active: route.path === "/", onClick: () => router.push({ name: "landing" }) },
  { icon: "library", label: "场景配置库", active: route.path === "/library", onClick: () => router.push({ name: "library" }) },
  { icon: "import", label: "导入现有场景", active: route.path === "/import", onClick: () => router.push({ name: "import" }) },
  { icon: "create", label: "新建仿真任务", active: route.path.startsWith("/wizard"), onClick: () => router.push({ name: "wizard-tle" }) },
]);
</script>

<template>
  <div
    class="v2-shell"
    :class="{
      'v2-shell--collapsed': !sidebarHovering,
      'v2-shell--hovering': sidebarHovering,
      'v2-shell--landing': route.name === 'landing',
    }"
  >
    <ProductHeader>
      <template #actions>
        <slot name="header-actions" />
      </template>
    </ProductHeader>

    <div class="v2-shell__body">
      <ProductSidebar
        :collapsed="!sidebarHovering"
        @mouseenter="onSidebarEnter"
        @mouseleave="onSidebarLeave"
      />
      <main class="v2-shell__content">
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useRoute } from "vue-router";
import ProductHeader from "./ProductHeader.vue";
import ProductSidebar from "./ProductSidebar.vue";

const route = useRoute();
const sidebarHovering = ref(false);

function onSidebarEnter() {
  sidebarHovering.value = true;
}

function onSidebarLeave() {
  sidebarHovering.value = false;
}
</script>

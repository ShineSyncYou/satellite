<template>
  <svg
    v-if="name === 'import'"
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path d="M12 3v10" />
    <path d="M8.5 9.5 12 13l3.5-3.5" />
    <path d="M5 14.5v4h14v-4" />
  </svg>

  <svg
    v-else-if="name === 'create'"
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path d="M4.5 7.5a2 2 0 0 1 2-2H10l1.5 1.8H17.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
    <path d="M12 10v5" />
    <path d="M9.5 12.5H14.5" />
  </svg>

  <svg
    v-else-if="name === 'library'"
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <rect x="5" y="5" width="11" height="11" rx="1.5" />
    <rect x="8" y="8" width="11" height="11" rx="1.5" />
  </svg>

  <svg
    v-else
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path d="M4.5 11.5 12 5l7.5 6.5" />
    <path d="M6.5 10.5v8h11v-8" />
  </svg>
</template>

<script setup>
defineProps({
  name: {
    type: String,
    default: "home",
  },
});
</script>


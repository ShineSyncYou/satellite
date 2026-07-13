<template>
  <header class="v2-header">
    <div class="v2-header__brand" @click="$router.push({ name: 'landing' })">
      <div class="v2-header__logo" aria-hidden="true">
        <img class="v2-header__logo-image" src="/pictures/comac_logo.png" alt="" />
      </div>
      <div class="v2-header__brand-copy">
        <div class="v2-header__title">空天地一体卫星通信仿真平台</div>
        <div class="v2-header__subtitle">场景导入、任务编排与可视化展示</div>
      </div>
    </div>
    <div class="v2-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

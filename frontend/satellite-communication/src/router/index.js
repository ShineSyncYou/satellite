import { createRouter, createWebHashHistory } from "vue-router";

import LandingView from "../views/LandingView.vue";
import LibraryView from "../views/LibraryView.vue";
import AdminLoginView from "../views/AdminLoginView.vue";
import ImportScenarioView from "../views/ImportScenarioView.vue";
import WizardTleView from "../views/WizardTleView.vue";
import WizardTrajectoryView from "../views/WizardTrajectoryView.vue";
import WizardGroundStationsView from "../views/WizardGroundStationsView.vue";
import WizardParametersView from "../views/WizardParametersView.vue";
import GenerationStatusView from "../views/GenerationStatusView.vue";
import OperationsView from "../views/OperationsView.vue";

const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior(_to, _from, savedPosition) {
    if (savedPosition) {
      return savedPosition;
    }
    return { left: 0, top: 0 };
  },
  routes: [
    { path: "/", name: "landing", component: LandingView },
    { path: "/library", name: "library", component: LibraryView },
    { path: "/admin/login", name: "admin-login", component: AdminLoginView },
    { path: "/import", name: "import", component: ImportScenarioView },
    { path: "/wizard/tle", name: "wizard-tle", component: WizardTleView },
    { path: "/wizard/trajectory", name: "wizard-trajectory", component: WizardTrajectoryView },
    { path: "/wizard/ground-stations", name: "wizard-ground-stations", component: WizardGroundStationsView },
    { path: "/wizard/parameters", name: "wizard-parameters", component: WizardParametersView },
    { path: "/wizard/status/:id", name: "wizard-status", component: GenerationStatusView, props: true },
    { path: "/run", name: "run", component: OperationsView },
  ],
});

export default router;
